import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { InferenceReconciliationReceipt } from "../../inference-gateway/src/contracts";
import type { SpecModelReconciliationReceipt } from "../../spec-model-broker/src/contracts";
import { normalizeModelRoles } from "../../../lib/agent/providers";
import { validateProviderBaseUrl } from "../../../lib/security/network";
import { AdminStore, emptyUsageSummary, recordAdminAudit, type AdminCatalogState } from "./admin.store";
import {
  ServiceProblem,
  assertAllowedFields,
  isAgentKind,
  optionalString,
  requiredString,
  type AuditRecord,
  type AgentKind,
  type AgentVersionRecord,
  type CredentialVersionRecord,
  type InstallationRecord,
  type ProfileRevisionRecord,
  type ProfileScope,
  type ProviderRevisionRecord,
  type RequestActor,
} from "./contracts";
import { SecretVault } from "./secret-vault";
import { ProviderProbe, PROVIDER_REQUIRED_CHECKS } from "./provider-probe";
import { credentialResultView, credentialView } from "./admin-public";
import {
  AgentSupplyChain,
  AgentSupplyChainPolicyFailure,
  type AgentInstallationBuildReceipt,
  type AgentInstallationRolloutReceipt,
  type AgentSupplyChainHealth,
  type AgentSupplyChainTerminalFailureReceipt,
  type AgentVersionCandidateReceipt,
  type AgentVersionValidationReceipt,
} from "./agent-supply-chain";
import { InferenceRequestReconciler } from "./inference-reconciliation";
import { SpecModelBrokerReconciliationClient, SpecModelGenerationReconciler } from "./spec-model-reconciliation";

const PROFILE_DRAFT_FIELDS = Object.freeze([
  "agent", "installationId", "credentialVersionId", "scope", "scopeId", "baseUrl", "authentication",
  "primaryModel", "planningModel", "smallFastModel", "subagentModel",
  "inputUsdPerMillionTokens", "outputUsdPerMillionTokens",
  "dataRegion", "retentionPolicy", "trainingPolicy",
  "maxBudgetUsd", "maxTurns", "timeoutSeconds", "fallbackProfileRevisionId",
]);

export class AdminService {
  constructor(
    private readonly store: AdminStore,
    private readonly vault: SecretVault,
    private readonly providerProbe: ProviderProbe,
    private readonly supplyChain: AgentSupplyChain,
    private readonly inferenceReconciler: InferenceRequestReconciler,
    private readonly specModelReconciler: SpecModelGenerationReconciler = new SpecModelBrokerReconciliationClient(),
  ) {}

  async agents(actor: RequestActor): Promise<Readonly<Record<string, unknown>>> {
    return this.store.read((state) => {
      const catalog = (["claude-code", "codex-cli"] as const).map((agent) => ({
        id: agent,
        name: agent === "claude-code" ? "Claude Code" : "Codex CLI",
        vendor: agent === "claude-code" ? "Anthropic" : "OpenAI",
        officialSource:
          agent === "claude-code"
            ? "https://code.claude.com/docs/en/installation"
            : "https://github.com/openai/codex",
        capabilities: ["plan", "code", "repair", "review"],
        supportedWorkers: ["linux/amd64", "linux/arm64"],
        installedOn: ["development-worker"],
        forbiddenOn: ["e2e-runner", "steam-publisher"],
        platformDefault: agent === "claude-code",
        versions: [...state.versions.values()].filter((value) => value.agent === agent),
        installations: [...state.installations.values()].filter((value) => value.agent === agent),
      }));
      const profiles = [...state.profiles.values()].filter((profile) => profileVisibleTo(profile, actor));
      const visibleProfileIds = new Set(profiles.map((profile) => profile.id));
      const visibleProviderIds = new Set(profiles.map((profile) => profile.providerRevisionId));
      const credentials = [...state.credentials.values()]
        .filter((credential) => credentialVisibleTo(credential, actor))
        .map(credentialView);
      const defaults = Object.fromEntries([...state.defaults.entries()].filter(([scope, profileId]) =>
        scope === "platform" || visibleProfileIds.has(profileId)));
      const platformProfile = state.profiles.get(state.defaults.get("platform") ?? "");
      return Object.freeze({
        catalog,
        platformDefault: state.defaults.get("platform") ?? "built-in:claude-code",
        effectivePlatformDefaultAgent: platformProfile?.agent ?? "claude-code",
        selectionPrecedence: ["project", "tenant", "platform", "built-in:claude-code"],
        pinnedVersionsOnly: true,
        profiles: Object.freeze(profiles),
        providers: Object.freeze([...state.providers.values()].filter((provider) => visibleProviderIds.has(provider.id))),
        credentials: Object.freeze(credentials),
        defaults: Object.freeze(defaults),
      });
    });
  }

  async discoverVersions(body: Record<string, unknown>, actor: RequestActor): Promise<Readonly<Record<string, unknown>>> {
    assertAllowedFields(body, ["agent", "version"]);
    const agentInput = body.agent ?? "claude-code";
    if (!isAgentKind(agentInput)) throw new ServiceProblem(400, "INVALID_AGENT", "Unsupported Agent kind");
    const requestedVersion = optionalString(body, "version") ?? null;
    if (requestedVersion) assertExactVersion(requestedVersion);
    const candidates = await this.supplyChain.discover({ ...supplyChainOperation(actor), agent: agentInput, requestedVersion });
    return this.mutate(actor, (state) => {
      const records = candidates.map((candidate) => {
        const id = `${candidate.agent}@${candidate.version}`;
        const existing = state.versions.get(id);
        if (existing) {
          if (existing.sourceDigest !== candidate.sourceDigest || existing.catalogReceiptDigest !== candidate.catalogReceiptDigest) {
            throw new ServiceProblem(409, "AGENT_CATALOG_DRIFT", "Official Agent catalog receipt changed for an existing exact version");
          }
          return existing;
        }
        const record: AgentVersionRecord = {
          id,
          agent: candidate.agent,
          version: candidate.version,
          state: "DISCOVERED",
          source: candidate.source,
          sourceDigest: candidate.sourceDigest,
          releaseNotesUrl: candidate.releaseNotesUrl,
          integrity: `sha256:${"0".repeat(64)}`,
          signatureVerified: false,
          sbomRef: `pending://${id}`,
          scan: "PENDING",
          catalogReceiptId: candidate.catalogReceiptId,
          catalogReceiptDigest: candidate.catalogReceiptDigest,
          validationReceiptId: null,
          validationReceiptDigest: null,
          supplyChainEvidenceDigest: null,
          validatedAt: null,
          discoveredAt: candidate.discoveredAt,
        };
        state.versions.set(id, record);
        this.audit(state, "AGENT_VERSION_DISCOVERED", id, actor, {
          source: candidate.source,
          catalogReceiptId: candidate.catalogReceiptId,
          catalogReceiptDigest: candidate.catalogReceiptDigest,
          activationChanged: false,
        });
        return record;
      });
      return { candidates: records, activationChanged: false };
    });
  }

  async setVersionState(
    action: "approve" | "block",
    body: Record<string, unknown>,
    actor: RequestActor,
  ): Promise<Readonly<Record<string, unknown>>> {
    const id = requiredString(body, "id", 160);
    if (action === "block") {
      assertAllowedFields(body, ["id"]);
      return this.mutate(actor, (state) => {
        const record = state.versions.get(id);
        if (!record) throw new ServiceProblem(404, "AGENT_VERSION_NOT_FOUND", "Agent version was not discovered");
        if (record.state === "DEPRECATED") {
          throw new ServiceProblem(409, "INVALID_VERSION_TRANSITION", "A deprecated version cannot be blocked in place");
        }
        const previousState = record.state;
        record.state = "BLOCKED";
        this.audit(state, "AGENT_VERSION_BLOCKED", record.id, actor, {
          previousState, state: record.state, automaticActivation: false,
        });
        return { version: record, automaticActivation: false };
      });
    }
    if ([
      "integrity", "signatureVerified", "scan", "sbomRef", "sourceDigest", "validationReceipt",
      "validationReceiptId", "validationReceiptDigest", "supplyChainEvidenceDigest", "validatedAt", "imageDigest",
    ].some((field) => body[field] !== undefined)) {
      throw new ServiceProblem(400, "CALLER_ATTESTATION_FORBIDDEN", "Supply-chain evidence must come from the isolated Broker");
    }
    assertAllowedFields(body, ["id"]);
    const candidate = await this.store.mutate((state) => {
      const record = state.versions.get(id);
      if (!record) throw new ServiceProblem(404, "AGENT_VERSION_NOT_FOUND", "Agent version was not discovered");
      if (record.state !== "DISCOVERED" && record.state !== "VALIDATING") {
        throw new ServiceProblem(409, "INVALID_VERSION_TRANSITION", "Only a discovered or validating version can be approved");
      }
      const previousState = record.state;
      record.state = "VALIDATING";
      this.audit(state, "AGENT_VERSION_VALIDATION_STARTED", record.id, actor, {
        previousState,
        state: record.state,
        catalogReceiptId: record.catalogReceiptId,
        automaticActivation: false,
      });
      return versionCandidate(record);
    });
    let validation: AgentVersionValidationReceipt;
    try {
      validation = await this.supplyChain.validateVersion({ ...supplyChainOperation(actor), candidate });
    } catch (error) {
      await this.store.mutate((state) => {
        const record = state.versions.get(id);
        if (record?.state === "VALIDATING") {
          const terminal = error instanceof AgentSupplyChainPolicyFailure && error.receipt.disposition === "REJECTED";
          record.state = terminal ? "REJECTED" : "DISCOVERED";
          record.scan = terminal ? "FAIL" : "PENDING";
          this.audit(state, record.state === "REJECTED" ? "AGENT_VERSION_REJECTED" : "AGENT_VERSION_VALIDATION_DEFERRED", id, actor, {
            catalogReceiptId: record.catalogReceiptId,
            automaticActivation: false,
            ...(terminal ? failureAudit(error.receipt) : {}),
          });
        }
      });
      throw error;
    }
    return this.mutate(actor, (state) => {
      const record = state.versions.get(id);
      if (!record || record.state !== "VALIDATING" || record.sourceDigest !== validation.sourceDigest
        || record.agent !== validation.agent || record.version !== validation.version) {
        throw new ServiceProblem(409, "AGENT_VERSION_VALIDATION_RACE", "Agent version changed before validation could commit");
      }
      Object.assign(record, {
        state: "APPROVED",
        signatureVerified: true,
        scan: "PASS",
        integrity: validation.integrity,
        sbomRef: validation.sbomRef,
        validationReceiptId: validation.validationReceiptId,
        validationReceiptDigest: validation.validationReceiptDigest,
        supplyChainEvidenceDigest: validation.supplyChainEvidenceDigest,
        validatedAt: validation.validatedAt,
      });
      this.audit(state, "AGENT_VERSION_APPROVED", record.id, actor, {
        previousState: "VALIDATING",
        state: record.state,
        validationReceiptId: validation.validationReceiptId,
        validationReceiptDigest: validation.validationReceiptDigest,
        supplyChainEvidenceDigest: validation.supplyChainEvidenceDigest,
        automaticActivation: false,
      });
      return { version: record, automaticActivation: false };
    });
  }

  async createInstallation(body: Record<string, unknown>, actor: RequestActor): Promise<InstallationRecord> {
    const agent = body.agent;
    if (!isAgentKind(agent)) throw new ServiceProblem(400, "INVALID_AGENT", "Unsupported Agent kind");
    const version = requiredString(body, "version", 100);
    assertExactVersion(version);
    if ([
      "imageDigest", "workerImageId", "buildReceipt", "buildReceiptId", "buildReceiptDigest",
      "supplyChainEvidenceDigest", "selfUpdateDisabled", "stages",
    ].some((field) => body[field] !== undefined)) {
      throw new ServiceProblem(400, "CALLER_IMAGE_IDENTITY_FORBIDDEN", "Worker image identity must come from the isolated Broker");
    }
    assertAllowedFields(body, ["agent", "version", "workerPool", "adapterVersion"]);
    const workerPool = requiredString(body, "workerPool", 120);
    if (!/^dev(?:elopment)?[-_a-z0-9]*$/i.test(workerPool)) {
      throw new ServiceProblem(400, "UNSAFE_WORKER_POOL", "Autonomous Agents may only be installed on development Worker pools");
    }
    const adapterVersion = requiredString(body, "adapterVersion", 100);
    assertExactVersion(adapterVersion);
    const operation = supplyChainOperation(actor);
    const id = `${agent}-installation-${operation.operationKey.slice(0, 24)}`;
    const snapshot = await this.store.mutate((state) => {
      const versionRecord = state.versions.get(`${agent}@${version}`);
      if (!versionRecord || versionRecord.state !== "APPROVED") {
        throw new ServiceProblem(409, "VERSION_NOT_APPROVED", "Installation requires an approved exact Agent version");
      }
      const rollback = mostRecentlyActivatedInstallation(state, agent, workerPool);
      const existing = state.installations.get(id);
      const rollbackInstallationId = existing?.rollbackInstallationId ?? rollback?.id ?? null;
      if (existing) {
        if (existing.agentVersionId !== versionRecord.id || existing.workerPool !== workerPool
          || existing.adapterVersion !== adapterVersion) {
          throw new ServiceProblem(409, "INSTALLATION_BUILD_DRIFT", "Installation reservation conflicts with the immutable request");
        }
        if (existing.state === "READY" && existing.imageDigest && existing.buildReceiptDigest) {
          return { completed: structuredClone(existing), candidate: null, validation: null, rollbackInstallationId };
        }
        if (existing.state !== "BUILDING" && existing.state !== "QUARANTINED") {
          throw new ServiceProblem(409, "INSTALLATION_BUILD_NOT_RETRYABLE", "Installation build cannot be resumed");
        }
      } else {
        state.installations.set(id, {
          id,
          agent,
          agentVersionId: versionRecord.id,
          workerPool,
          imageDigest: null,
          workerImageId: null,
          adapterVersion,
          buildReceiptId: null,
          buildReceiptDigest: null,
          rollbackInstallationId,
          health: "UNHEALTHY",
          state: "BUILDING",
          rolloutPercent: 0,
          previousRolloutPercent: 0,
          selfUpdateDisabled: true,
          createdAt: new Date().toISOString(),
          activatedAt: null,
          drainingAt: null,
          retiredAt: null,
        });
        this.audit(state, "AGENT_INSTALLATION_BUILDING", id, actor, {
          agent, version, workerPool, adapterVersion, rollbackInstallationId,
        });
      }
      return {
        completed: null,
        candidate: versionCandidate(versionRecord),
        validation: versionValidation(versionRecord),
        rollbackInstallationId,
      };
    });
    if (snapshot.completed) return this.mutate(actor, () => snapshot.completed!);
    let built: AgentInstallationBuildReceipt;
    try {
      built = await this.supplyChain.buildInstallation({
        ...operation,
        installationId: id,
        candidate: snapshot.candidate!,
        validation: snapshot.validation!,
        workerPool,
        adapterVersion,
        rollbackInstallationId: snapshot.rollbackInstallationId,
      });
    } catch (error) {
      await this.store.mutate((state) => {
        const installation = state.installations.get(id);
        if (!installation || installation.state !== "BUILDING" && installation.state !== "QUARANTINED") return;
        if (error instanceof AgentSupplyChainPolicyFailure && error.receipt.disposition === "QUARANTINED") {
          const alreadyRecorded = installation.failure?.failureReceiptDigest === error.receipt.failureReceiptDigest;
          quarantineInstallation(installation, error.receipt);
          const rollbackProfiles = restoreProfilesToRollback(state, installation, {
            operationDigest: error.receipt.failureReceiptDigest,
            occurredAt: error.receipt.failedAt,
          });
          if (!alreadyRecorded) {
            this.audit(state, "AGENT_INSTALLATION_QUARANTINED", id, actor, {
              ...failureAudit(error.receipt),
              rolloutStoppedAtPercent: 0,
              rollbackInstallationId: installation.rollbackInstallationId,
              rollbackProfileRevisionIds: rollbackProfiles,
              runningTasksUnaffected: true,
            });
          }
        } else {
          this.audit(state, "AGENT_INSTALLATION_BUILD_DEFERRED", id, actor, {
            state: installation.state,
            retryable: true,
          });
        }
      });
      throw error;
    }
    return this.mutate(actor, (state) => {
      const versionRecord = state.versions.get(`${agent}@${version}`);
      if (!versionRecord || versionRecord.state !== "APPROVED") {
        throw new ServiceProblem(409, "VERSION_NOT_APPROVED", "Installation requires an approved exact Agent version");
      }
      const installation = state.installations.get(id);
      if (!installation || installation.state !== "BUILDING") {
        throw new ServiceProblem(409, "INSTALLATION_BUILD_RACE", "Installation reservation changed before build receipt could commit");
      }
      installation.imageDigest = built.imageDigest;
      installation.workerImageId = built.workerImageId;
      installation.buildReceiptId = built.buildReceiptId;
      installation.buildReceiptDigest = built.buildReceiptDigest;
      installation.health = built.health;
      installation.state = "READY";
      delete installation.failure;
      this.audit(state, "AGENT_INSTALLATION_READY", id, actor, {
        agent,
        version,
        workerPool,
        imageDigest: installation.imageDigest,
        workerImageId: installation.workerImageId,
        buildReceiptId: installation.buildReceiptId,
        buildReceiptDigest: installation.buildReceiptDigest,
        supplyChainGates: "signature,sbom,vulnerability,malware,adapter-smoke,sandbox-smoke",
      });
      return installation;
    });
  }

  async rollout(
    installationId: string,
    action: "advance" | "rollback",
    actor: RequestActor,
  ): Promise<Readonly<Record<string, unknown>>> {
    const snapshot = await this.store.read((state) => {
      const installation = state.installations.get(installationId);
      if (!installation) throw new ServiceProblem(404, "INSTALLATION_NOT_FOUND", "Agent installation does not exist");
      if (!["READY", "CANARY", "ACTIVE"].includes(installation.state) || !installation.imageDigest) {
        throw new ServiceProblem(409, "INSTALLATION_NOT_ROLLOUT_ELIGIBLE", "Installation cannot accept new tasks");
      }
      const toPercent: InstallationRecord["rolloutPercent"] = action === "rollback" ? 0
        : installation.rolloutPercent < 5 ? 5 : installation.rolloutPercent < 25 ? 25 : 100;
      if (toPercent === installation.rolloutPercent) {
        throw new ServiceProblem(409, "ROLLOUT_ALREADY_AT_TARGET", "Installation rollout is already at the requested target");
      }
      return structuredClone({ installation, toPercent });
    });
    let receipt: AgentInstallationRolloutReceipt;
    try {
      receipt = await this.supplyChain.rollout({
        ...supplyChainOperation(actor),
        installationId,
        imageDigest: snapshot.installation.imageDigest!,
        action: action === "advance" ? "ADVANCE" : "ROLLBACK",
        fromPercent: snapshot.installation.rolloutPercent,
        toPercent: snapshot.toPercent,
      });
    } catch (error) {
      await this.store.mutate((state) => {
        const installation = state.installations.get(installationId);
        if (!installation || installation.imageDigest !== snapshot.installation.imageDigest
          || installation.rolloutPercent !== snapshot.installation.rolloutPercent
          || installation.state !== snapshot.installation.state) return;
        if (error instanceof AgentSupplyChainPolicyFailure && error.receipt.disposition === "QUARANTINED") {
          const stoppedAt = installation.rolloutPercent;
          quarantineInstallation(installation, error.receipt);
          const rollbackProfiles = restoreProfilesToRollback(state, installation, {
            operationDigest: error.receipt.failureReceiptDigest,
            occurredAt: error.receipt.failedAt,
          });
          this.audit(state, "AGENT_INSTALLATION_QUARANTINED", installationId, actor, {
            ...failureAudit(error.receipt),
            rolloutStoppedAtPercent: stoppedAt,
            rollbackInstallationId: installation.rollbackInstallationId,
            rollbackProfileRevisionIds: rollbackProfiles,
            runningTasksUnaffected: true,
          });
        } else {
          this.audit(state, "AGENT_ROLLOUT_DEFERRED", installationId, actor, {
            rolloutPercent: installation.rolloutPercent,
            retryable: true,
          });
        }
      });
      throw error;
    }
    return this.mutate(actor, (state) => {
      const installation = state.installations.get(installationId);
      if (!installation || installation.imageDigest !== snapshot.installation.imageDigest
        || installation.rolloutPercent !== snapshot.installation.rolloutPercent
        || installation.state !== snapshot.installation.state) {
        throw new ServiceProblem(409, "ROLLOUT_CONFIGURATION_RACE", "Installation changed before rollout receipt could commit");
      }
      installation.previousRolloutPercent = installation.rolloutPercent;
      installation.rolloutPercent = receipt.toPercent;
      installation.state = receipt.state;
      installation.health = receipt.health;
      if (receipt.toPercent === 100) installation.activatedAt = receipt.completedAt;
      const rollbackProfiles = action === "rollback"
        ? restoreProfilesToRollback(state, installation, {
          operationDigest: receipt.rolloutReceiptDigest,
          occurredAt: receipt.completedAt,
        })
        : Object.freeze([] as string[]);
      this.audit(state, `AGENT_ROLLOUT_${action.toUpperCase()}`, installationId, actor, {
        previousRolloutPercent: installation.previousRolloutPercent,
        rolloutPercent: installation.rolloutPercent,
        rolloutReceiptId: receipt.rolloutReceiptId,
        rolloutReceiptDigest: receipt.rolloutReceiptDigest,
        activatedAt: installation.activatedAt,
        rollbackProfileRevisionIds: rollbackProfiles,
        runningTasksUnaffected: true,
      });
      return {
        installation,
        rollbackProfileRevisionIds: rollbackProfiles,
        newTasksOnly: true,
        activeRunsKeepPinnedImage: true,
        incompatibleSessionsNeverResumeAcrossVersions: true,
      };
    });
  }

  async transitionInstallation(
    installationId: string,
    action: "drain" | "retire",
    actor: RequestActor,
  ): Promise<Readonly<Record<string, unknown>>> {
    const snapshot = await this.store.read((state) => {
      const installation = state.installations.get(installationId);
      if (!installation || !installation.imageDigest) {
        throw new ServiceProblem(404, "INSTALLATION_NOT_FOUND", "Agent installation does not exist");
      }
      if (action === "drain") {
        if (installation.state !== "ACTIVE" || installation.rolloutPercent !== 100) {
          throw new ServiceProblem(409, "INSTALLATION_NOT_DRAINABLE", "Only a fully active installation can begin draining");
        }
      } else {
        if (installation.state !== "DRAINING" || installation.rolloutPercent !== 0 || !installation.drainingAt) {
          throw new ServiceProblem(409, "INSTALLATION_NOT_RETIRABLE", "Installation must finish draining before retirement");
        }
        const defaultScopes = [...state.defaults.entries()].filter(([, profileId]) =>
          profileReferencesInstallation(state, profileId, installationId)).map(([scope]) => scope);
        if (defaultScopes.length > 0) {
          throw new ServiceProblem(409, "INSTALLATION_DEFAULT_STILL_REFERENCED", "Move every effective default away from this installation before retirement", {
            defaultScopes: Object.freeze(defaultScopes),
          });
        }
      }
      return structuredClone(installation);
    });
    if (action === "retire") {
      let activeRuns: number;
      try {
        activeRuns = await this.store.countNonTerminalRuns(installationId);
      } catch {
        throw new ServiceProblem(503, "INSTALLATION_RUN_GUARD_UNAVAILABLE", "Cannot prove that every pinned Agent run is terminal");
      }
      if (activeRuns > 0) {
        throw new ServiceProblem(409, "INSTALLATION_RUNS_STILL_ACTIVE", "Installation still has pinned non-terminal Agent runs", { activeRuns });
      }
    }

    let receipt: AgentInstallationRolloutReceipt;
    try {
      receipt = await this.supplyChain.rollout({
        ...supplyChainOperation(actor),
        installationId,
        imageDigest: snapshot.imageDigest!,
        action: action === "drain" ? "DRAIN" : "RETIRE",
        fromPercent: snapshot.rolloutPercent,
        toPercent: 0,
      });
    } catch (error) {
      await this.store.mutate((state) => {
        const current = state.installations.get(installationId);
        if (!current || current.state !== snapshot.state || current.rolloutPercent !== snapshot.rolloutPercent) return;
        this.audit(state, `AGENT_INSTALLATION_${action.toUpperCase()}_DEFERRED`, installationId, actor, {
          state: current.state,
          rolloutPercent: current.rolloutPercent,
          retryable: !(error instanceof AgentSupplyChainPolicyFailure),
        });
      });
      throw error;
    }

    return this.mutate(actor, (state) => {
      const installation = state.installations.get(installationId);
      if (!installation || installation.imageDigest !== snapshot.imageDigest
        || installation.rolloutPercent !== snapshot.rolloutPercent || installation.state !== snapshot.state) {
        throw new ServiceProblem(409, "INSTALLATION_LIFECYCLE_RACE", "Installation changed before lifecycle receipt could commit");
      }
      const previousState = installation.state;
      installation.previousRolloutPercent = installation.rolloutPercent;
      installation.rolloutPercent = receipt.toPercent;
      installation.state = receipt.state;
      installation.health = receipt.health;
      let rollbackProfiles: readonly string[] = Object.freeze([]);
      if (action === "drain") {
        installation.drainingAt = receipt.completedAt;
        rollbackProfiles = restoreProfilesToRollback(state, installation, {
          operationDigest: receipt.rolloutReceiptDigest,
          occurredAt: receipt.completedAt,
        });
      } else {
        installation.retiredAt = receipt.completedAt;
      }
      this.audit(state, action === "drain" ? "AGENT_INSTALLATION_DRAINING" : "AGENT_INSTALLATION_RETIRED", installationId, actor, {
        previousState,
        state: installation.state,
        rolloutReceiptId: receipt.rolloutReceiptId,
        rolloutReceiptDigest: receipt.rolloutReceiptDigest,
        rollbackProfileRevisionIds: rollbackProfiles,
        ...(action === "drain" ? { activeRunsKeepPinnedImage: true } : { nonTerminalRuns: 0 }),
      });
      return Object.freeze({
        installation,
        rollbackProfileRevisionIds: rollbackProfiles,
        newTasksOnly: true,
        activeRunsKeepPinnedImage: action === "drain",
      });
    });
  }

  async createCredential(body: Record<string, unknown>, actor: RequestActor): Promise<CredentialVersionRecord> {
    assertAllowedFields(body, ["label", "apiKey"]);
    const label = requiredString(body, "label", 120);
    const apiKey = requiredString(body, "apiKey", 8192);
    const familyId = `credential-${randomUUID()}`;
    const credentialScope = scopeForCredentialActor(actor);
    let credential: CredentialVersionRecord;
    try {
      credential = await this.ingestCredential(
        familyId,
        1,
        label,
        credentialScope.scope,
        credentialScope.scopeId,
        apiKey,
      );
    } finally {
      body.apiKey = "";
    }
    try {
      return await this.mutate(actor, (state) => {
        state.credentials.set(credential.id, credential);
        this.audit(state, "CREDENTIAL_CREATED", credential.id, actor, { label, version: 1 });
        return credential;
      }, credentialView);
    } catch (error) {
      await this.vault.revoke(credential.secretRef).catch(() => undefined);
      throw error;
    }
  }

  async rotateCredential(
    credentialId: string,
    body: Record<string, unknown>,
    actor: RequestActor,
  ): Promise<Readonly<Record<string, unknown>>> {
    assertAllowedFields(body, ["apiKey"]);
    const operationKey = credentialRotationOperationKey(actor, credentialId);
    const rotation = await this.store.read((state) => {
      const value = state.credentials.get(credentialId);
      if (!value) return undefined;
      const recovery = recoverCredentialRotation(state, value, operationKey);
      const otherActiveVersions = [...state.credentials.values()].filter((candidate) =>
        candidate.familyId === value.familyId && candidate.id !== value.id && candidate.state === "ACTIVE");
      if (!recovery && otherActiveVersions.length > 0) {
        throw new ServiceProblem(
          409,
          "CREDENTIAL_ROTATION_RECOVERY_REQUIRED",
          "Another staged credential version must be recovered or cleaned up before a new rotation can start",
        );
      }
      const nextVersion = recovery?.replacement.version ?? Math.max(0, ...[...state.credentials.values()]
        .filter((candidate) => candidate.familyId === value.familyId)
        .map((candidate) => candidate.version)) + 1;
      return { current: structuredClone(value), nextVersion, recovery };
    });
    if (!rotation) throw new ServiceProblem(404, "CREDENTIAL_NOT_FOUND", "Credential version does not exist");
    const { current } = rotation;
    if (current.state !== "ACTIVE") throw new ServiceProblem(409, "CREDENTIAL_NOT_ACTIVE", "Only an active credential can be rotated");
    assertCredentialActor(current, actor);
    const apiKey = requiredString(body, "apiKey", 8192);
    let ingested: CredentialVersionRecord;
    try {
      ingested = await this.ingestCredential(
        current.familyId,
        rotation.nextVersion,
        current.label,
        current.scope,
        current.scopeId,
        apiKey,
      );
    } finally {
      body.apiKey = "";
    }
    const replacement = rotation.recovery?.replacement ?? ingested;
    if (rotation.recovery && (ingested.id !== replacement.id
      || ingested.secretRef !== replacement.secretRef
      || ingested.maskedFingerprint !== replacement.maskedFingerprint)) {
      throw new ServiceProblem(409, "CREDENTIAL_ROTATION_RECOVERY_CONFLICT", "Staged credential metadata no longer matches its immutable Vault write");
    }
    if (replacement.maskedFingerprint === current.maskedFingerprint) {
      await this.vault.revoke(replacement.secretRef);
      throw new ServiceProblem(409, "CREDENTIAL_REUSED", "Replacement credential must contain new secret material");
    }
    let stage: CredentialRotationStage | undefined = rotation.recovery?.stage;
    try {
      if (stage) {
        await this.store.mutate((state) => {
          const recovery = recoverCredentialRotation(state, current, operationKey);
          if (!recovery || recovery.replacement.id !== replacement.id) rotationRace();
          this.audit(state, "CREDENTIAL_ROTATION_VALIDATION_RESUMED", current.id, actor, {
            operationKey,
            replacementVersionId: replacement.id,
            successorProfileRevisionIds: recovery.stage.profiles.map((item) => item.successorProfileId),
          });
        });
      } else {
        stage = await this.store.mutate((state) => {
          const result = stageCredentialRotation(state, current, replacement, operationKey);
          this.audit(state, "CREDENTIAL_ROTATION_VALIDATION_STARTED", current.id, actor, {
            operationKey,
            replacementVersionId: replacement.id,
            successorProfileRevisionIds: result.profiles.map((item) => item.successorProfileId),
            rotationBindings: rotationBindingAudit(result.profiles),
            activeDefaultsPreservedUntilProbePasses: true,
          });
          return result;
        });
      }
      const probes = new Map<string, ProviderRevisionRecord["probe"]>();
      for (const provider of stage.providersToProbe) {
        probes.set(provider.id, await this.providerProbe.run(provider));
      }
      return await this.mutate(actor, (state) => {
        const active = state.credentials.get(current.id);
        const next = state.credentials.get(replacement.id);
        if (!active || active.state !== "ACTIVE" || active.version !== current.version
          || active.maskedFingerprint !== current.maskedFingerprint || !next || next.state !== "ACTIVE"
          || next.maskedFingerprint !== replacement.maskedFingerprint) rotationRace();

        const successorBySource = new Map(stage!.profiles.map((item) => [item.sourceProfileId, item.successorProfileId]));
        const supersededProviders = new Set<string>();
        for (const binding of stage!.profiles) {
          const source = state.profiles.get(binding.sourceProfileId);
          const successor = state.profiles.get(binding.successorProfileId);
          if (!source || source.state !== "ACTIVE" || !successor || successor.state !== "VALIDATING") rotationRace();
          if (binding.rotatesCredential) {
            const sourceProvider = state.providers.get(binding.sourceProviderId);
            const successorProvider = state.providers.get(binding.successorProviderId);
            const probe = probes.get(binding.successorProviderId);
            if (!sourceProvider || !successorProvider || !probe
              || Object.values(probe).some((result) => result !== "PASS")) rotationRace();
            if (!supersededProviders.has(sourceProvider.id)) {
              if (sourceProvider.state !== "ACTIVE" || successorProvider.state !== "VALIDATING") rotationRace();
              successorProvider.probe = probe;
              successorProvider.state = "ACTIVE";
              sourceProvider.state = "SUPERSEDED";
              supersededProviders.add(sourceProvider.id);
            } else if (sourceProvider.state !== "SUPERSEDED" || successorProvider.state !== "ACTIVE") rotationRace();
          }
          successor.state = "ACTIVE";
          source.state = "SUPERSEDED";
        }
        for (const [scope, profileId] of state.defaults.entries()) {
          const successorId = successorBySource.get(profileId);
          if (successorId) state.defaults.set(scope, successorId);
        }
        for (const profile of state.profiles.values()) {
          if (profile.credentialVersionId === current.id && !successorBySource.has(profile.id)
            && !["SUPERSEDED", "DISABLED"].includes(profile.state)) profile.state = "DEGRADED";
        }
        for (const provider of state.providers.values()) {
          if (provider.credentialVersionId === current.id && !supersededProviders.has(provider.id)
            && !["SUPERSEDED", "DISABLED"].includes(provider.state)) provider.state = "DEGRADED";
        }
        active.state = "PREVIOUS";
        this.audit(state, "CREDENTIAL_ROTATED", active.id, actor, {
          operationKey,
          replacementVersionId: replacement.id,
          successorProfileRevisionIds: stage!.profiles.map((item) => item.successorProfileId),
          reboundDefaultCount: [...state.defaults.values()].filter((id) => stage!.profiles.some((item) => item.successorProfileId === id)).length,
          oldVersionNoLongerIssued: true,
          runningTasksKeepImmutableRecordedBinding: true,
        });
        return {
          active: next,
          previous: active,
          successorProfileRevisionIds: stage!.profiles.map((item) => item.successorProfileId),
          newTasksOnly: true,
          oldVersionNoLongerIssued: true,
        };
      }, credentialResultView);
    } catch (error) {
      let cleanup: CredentialRotationCleanup | undefined;
      try {
        const recoveredStage = stage ?? await this.store.read((state) =>
          recoverCredentialRotation(state, current, operationKey)?.stage);
        cleanup = await this.store.mutate((state) => {
          const owned = recoveredStage;
          if (owned) {
            const completed = completedCredentialRotation(state, current, replacement, owned);
            if (completed) return Object.freeze({ completed });
            const next = state.credentials.get(replacement.id);
            const activeUse = owned.profiles.some((binding) =>
              state.profiles.get(binding.successorProfileId)?.state === "ACTIVE"
              || (binding.rotatesCredential
                && state.providers.get(binding.successorProviderId)?.state === "ACTIVE"));
            if (activeUse) {
              this.audit(state, "CREDENTIAL_ROTATION_CLEANUP_DEFERRED", current.id, actor, {
                operationKey,
                replacementVersionId: replacement.id,
                activeSuccessorPreserved: true,
              });
              return Object.freeze({ revoke: false });
            }
            if (next && next.state === "ACTIVE") next.state = "REVOKED";
            for (const binding of owned.profiles) {
              const successor = state.profiles.get(binding.successorProfileId);
              if (successor?.state === "VALIDATING") successor.state = "DEGRADED";
              if (binding.rotatesCredential) {
                const provider = state.providers.get(binding.successorProviderId);
                if (provider?.state === "VALIDATING") provider.state = "DEGRADED";
              }
            }
            this.audit(state, "CREDENTIAL_ROTATION_FAILED", current.id, actor, {
              operationKey,
              replacementVersionId: replacement.id,
              priorActiveConfigurationPreserved: true,
            });
            return Object.freeze({ revoke: true });
          }
          // A different idempotency operation may own this same immutable Vault
          // path. Never revoke metadata already present in the catalog without
          // this operation's staged audit binding.
          return Object.freeze({ revoke: !state.credentials.has(replacement.id) });
        });
      } catch {
        // A catalog outage leaves the key unreachable through the authority
        // projection. Revoking blindly here could break a concurrently committed
        // rotation, so a later fenced recovery owns cleanup.
      }
      if (cleanup?.completed) return credentialResultView(cleanup.completed);
      if (cleanup?.revoke) await this.vault.revoke(replacement.secretRef).catch(() => undefined);
      throw error;
    }
  }

  async revokeCredential(credentialId: string, actor: RequestActor): Promise<CredentialVersionRecord> {
    const current = await this.store.read((state) => {
      const value = state.credentials.get(credentialId);
      if (!value) throw new ServiceProblem(404, "CREDENTIAL_NOT_FOUND", "Credential version does not exist");
      assertCredentialActor(value, actor);
      return structuredClone(value);
    });
    // Revoke first: a database failure can leave a fail-closed dead SecretRef,
    // while the reverse order could keep issuing a credential after success was recorded.
    await this.vault.revoke(current.secretRef);
    return this.mutate(actor, (state) => {
      const value = state.credentials.get(credentialId);
      if (!value) throw new ServiceProblem(404, "CREDENTIAL_NOT_FOUND", "Credential version does not exist");
      assertCredentialActor(value, actor);
      if (value.state !== "REVOKED") {
        const previousState = value.state;
        value.state = "REVOKED";
        this.audit(state, "CREDENTIAL_REVOKED", value.id, actor, {
          previousState, state: value.state, newTokensIssued: false,
        });
      }
      return structuredClone(value);
    }, credentialView);
  }

  async createProfile(body: Record<string, unknown>, actor: RequestActor): Promise<Readonly<Record<string, unknown>>> {
    assertAllowedFields(body, PROFILE_DRAFT_FIELDS);
    const agent = body.agent;
    if (!isAgentKind(agent)) throw new ServiceProblem(400, "INVALID_AGENT", "Unsupported Agent kind");
    const scope = parseScope(body.scope);
    const scopeId = requiredString(body, "scopeId", 160);
    assertScopeRole(scope, scopeId, actor);
    const installationId = requiredString(body, "installationId", 180);
    const credentialVersionId = requiredString(body, "credentialVersionId", 180);

    const baseUrl = requiredString(body, "baseUrl", 1000);
    try {
      validateProviderBaseUrl(baseUrl, { approvedPorts: [443] });
    } catch (error) {
      throw new ServiceProblem(400, "PROVIDER_ENDPOINT_REJECTED", safeMessage(error, "Provider endpoint failed security policy"));
    }
    let models: ProviderRevisionRecord["models"];
    try {
      models = normalizeModelRoles({
        primaryModel: requiredString(body, "primaryModel", 200),
        planningModel: optionalString(body, "planningModel"),
        smallFastModel: optionalString(body, "smallFastModel"),
        subagentModel: optionalString(body, "subagentModel"),
      });
    } catch (error) {
      throw new ServiceProblem(400, "MODEL_ID_REJECTED", safeMessage(error, "Model IDs must be exact and pinned"));
    }
    const governance = parseGovernance(body, actor);
    const authentication = parseProviderAuthentication(body, agent);
    const pricing = parseProviderPricing(body);
    const budget = parseBudget(body);
    const fallbackProfileRevisionId = optionalString(body, "fallbackProfileRevisionId") ?? null;
    return this.mutate(actor, (state) => {
      const installation = state.installations.get(installationId);
      if (!installation || installation.agent !== agent || !["READY", "CANARY", "ACTIVE"].includes(installation.state)) {
        throw new ServiceProblem(409, "INSTALLATION_NOT_READY", "Profile requires a compatible ready Agent installation");
      }
      const credential = state.credentials.get(credentialVersionId);
      if (!credential || credential.state !== "ACTIVE") {
        throw new ServiceProblem(409, "CREDENTIAL_NOT_ACTIVE", "Profile requires an active credential version");
      }
      assertProfileCredential(scope, scopeId, credential, actor);
      assertFallbackProfile(state, fallbackProfileRevisionId, agent, scope, scopeId);
      const profileIndex = [...state.profiles.values()].filter(
        (value) => value.scope === scope && value.scopeId === scopeId,
      ).length + 1;
      const providerRevisionId = `provider-${agent}-${randomUUID()}-r1`;
      const profileId = `profile-${scope}-${scopeId}-${profileIndex}-r1`;
      const provider: ProviderRevisionRecord = {
        id: providerRevisionId,
        revision: 1,
        agent,
        protocol: agent === "codex-cli" ? "openai-responses" : "anthropic-messages",
        baseUrl: new URL(baseUrl).toString(),
        approvedPorts: Object.freeze([443]),
        authentication,
        models,
        pricing,
        credentialVersionId,
        state: "DRAFT",
        probe: {},
        governance,
      };
      const profile: ProfileRevisionRecord = {
        id: profileId,
        revision: 1,
        scope,
        scopeId,
        agent,
        installationId,
        providerRevisionId,
        credentialVersionId,
        budget,
        fallbackProfileRevisionId,
        state: "DRAFT",
        createdAt: new Date().toISOString(),
      };
      state.providers.set(provider.id, provider);
      state.profiles.set(profile.id, profile);
      this.audit(state, "AGENT_PROFILE_DRAFTED", profile.id, actor, {
        agent,
        scope,
        scopeId,
        providerRevisionId,
        baseUrl: provider.baseUrl,
      });
      return { profile, provider };
    });
  }

  async transitionProfile(
    profileId: string,
    action: "validate" | "activate" | "disable",
    actor: RequestActor,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (action === "validate") {
      const pending = await this.store.mutate((state) => {
        const profile = requireProfile(state, profileId);
        assertScopeRole(profile.scope, profile.scopeId, actor);
        const provider = requireProvider(state, profile.providerRevisionId);
        if (profile.state === "VALIDATING" && provider.state === "VALIDATING") {
          return { profileId: profile.id, provider: structuredClone(provider) };
        }
        if (profile.state !== "DRAFT" && profile.state !== "DEGRADED") {
          throw new ServiceProblem(409, "INVALID_PROFILE_TRANSITION", "Only a draft or degraded Profile can be validated");
        }
        const previousState = profile.state;
        const previousProviderState = provider.state;
        profile.state = "VALIDATING";
        provider.state = "VALIDATING";
        this.audit(state, "AGENT_PROFILE_VALIDATION_STARTED", profile.id, actor, {
          previousState,
          state: profile.state,
          previousProviderState,
          providerState: provider.state,
          providerRevisionId: provider.id,
          priorActiveConfigurationPreserved: true,
        });
        return { profileId: profile.id, provider: structuredClone(provider) };
      });
      let probe: ProviderRevisionRecord["probe"];
      try {
        probe = await this.providerProbe.run(pending.provider);
      } catch (error) {
        await this.store.mutate((state) => {
          const profile = requireProfile(state, pending.profileId);
          const provider = requireProvider(state, pending.provider.id);
          if (profile.state === "VALIDATING" && provider.state === "VALIDATING") {
            const previousState = profile.state;
            const previousProviderState = provider.state;
            profile.state = "DEGRADED";
            provider.state = "DEGRADED";
            this.audit(state, "AGENT_PROFILE_VALIDATION_FAILED", profile.id, actor, {
              previousState,
              state: profile.state,
              previousProviderState,
              providerState: provider.state,
              providerRevisionId: provider.id,
              priorActiveConfigurationPreserved: true,
            });
          }
        });
        throw error;
      }
      return this.mutate(actor, (state) => {
        const profile = requireProfile(state, pending.profileId);
        const provider = requireProvider(state, pending.provider.id);
        if (profile.state !== "VALIDATING" || provider.state !== "VALIDATING") {
          throw new ServiceProblem(409, "PROFILE_VALIDATION_RACE", "Profile changed before validation could commit");
        }
        provider.probe = probe;
        const previousState = profile.state;
        const previousProviderState = provider.state;
        profile.state = "READY";
        provider.state = "READY";
        this.audit(state, "AGENT_PROFILE_VALIDATE", profile.id, actor, {
          previousState,
          state: profile.state,
          previousProviderState,
          providerState: provider.state,
          providerRevisionId: provider.id,
          priorActiveConfigurationPreserved: true,
        });
        return { profile, provider, affectsQueuedOrRunningTasks: false };
      });
    }
    return this.mutate(actor, (state) => {
      const profile = requireProfile(state, profileId);
      assertScopeRole(profile.scope, profile.scopeId, actor);
      const provider = requireProvider(state, profile.providerRevisionId);
      const previousState = profile.state;
      const previousProviderState = provider.state;
      if (action === "activate") {
        if (actor.role !== "SecurityAdmin") {
          throw new ServiceProblem(403, "SECURITY_APPROVAL_REQUIRED", "SecurityAdmin must activate a third-party Provider endpoint");
        }
        if (profile.state !== "READY" || provider.state !== "READY" || !providerProbePassed(provider)) {
          throw new ServiceProblem(409, "PROVIDER_PROBE_REQUIRED", "All Provider probes must pass before activation");
        }
        profile.state = "ACTIVE";
        provider.state = "ACTIVE";
      } else {
        if (profile.state === "SUPERSEDED") {
          throw new ServiceProblem(409, "PROFILE_IMMUTABLE", "A superseded Profile revision cannot be changed");
        }
        profile.state = "DISABLED";
        provider.state = "DISABLED";
      }
      this.audit(state, `AGENT_PROFILE_${action.toUpperCase()}`, profile.id, actor, {
        previousState,
        state: profile.state,
        previousProviderState,
        providerState: provider.state,
        providerRevisionId: provider.id,
        priorActiveConfigurationPreserved: false,
      });
      return { profile, provider, affectsQueuedOrRunningTasks: false };
    });
  }

  async updateDefault(scopeKey: string, body: Record<string, unknown>, actor: RequestActor): Promise<Readonly<Record<string, unknown>>> {
    assertAllowedFields(body, ["profileRevisionId"]);
    const parsed = parseDefaultScope(scopeKey);
    assertScopeRole(parsed.scope, parsed.scopeId, actor);
    const profileRevisionId = requiredString(body, "profileRevisionId", 200);
    return this.mutate(actor, (state) => {
      const profile = state.profiles.get(profileRevisionId);
      if (!profile || profile.state !== "ACTIVE") {
        throw new ServiceProblem(409, "PROFILE_NOT_ACTIVE", "Defaults can only reference an active immutable Profile revision");
      }
      if (!profileSelectableForDefault(profile, parsed, actor)) {
        throw new ServiceProblem(409, "PROFILE_SCOPE_MISMATCH", "Profile revision is outside the active configuration inherited by this scope");
      }
      assertProfileServingReady(state, profile, actor);
      const previousProfileRevisionId = state.defaults.get(scopeKey) ?? null;
      state.defaults.set(scopeKey, profileRevisionId);
      this.audit(state, "AGENT_DEFAULT_UPDATED", scopeKey, actor, {
        previousProfileRevisionId,
        profileRevisionId,
        runningTasksUnaffected: true,
      });
      return {
        scope: scopeKey,
        profileRevisionId,
        precedence: "project > tenant > platform > built-in Claude Code",
        newTasksOnly: true,
      };
    });
  }

  async health(actor: RequestActor): Promise<Readonly<Record<string, unknown>>> {
    let supplyChain: AgentSupplyChainHealth | Readonly<{ service: "deviludo-agent-supply-chain"; status: "UNAVAILABLE" }>;
    try { supplyChain = await this.supplyChain.probe(); }
    catch { supplyChain = Object.freeze({ service: "deviludo-agent-supply-chain", status: "UNAVAILABLE" }); }
    let usage;
    try { usage = await this.store.readUsage(actor); }
    catch { usage = emptyUsageSummary(false); }
    return this.store.read((state) => {
      const installations = [...state.installations.values()];
      const visibleAudit = state.audit.filter((record) => auditVisibleTo(record, actor));
      const profiles = [...state.profiles.values()].filter((profile) => profileVisibleTo(profile, actor));
      const visibleProviderIds = new Set(profiles.map((profile) => profile.providerRevisionId));
      const providers = [...state.providers.values()].filter((provider) => visibleProviderIds.has(provider.id));
      const alerts = operationalAlerts(state, supplyChain, usage.available, profiles, providers);
      return {
        status: alerts.length > 0 ? "DEGRADED" : "HEALTHY",
        installations,
        providers: providers.map(({ id, state: providerState, probe }) => ({ id, state: providerState, probe })),
        supplyChain,
        isolation: { developmentWorkers: true, e2eRunnersContainAgent: false, steamPublishersContainAgent: false },
        usage,
        configurationDiffs: configurationDiffs(visibleAudit),
        alerts,
        checkedAt: new Date().toISOString(),
      };
    });
  }

  async auditLog(actor: RequestActor): Promise<readonly AuditRecord[]> {
    return this.store.read((state) => Object.freeze(state.audit.filter((record) => auditVisibleTo(record, actor))));
  }

  async reconcileInferenceRequest(
    requestId: string,
    body: Record<string, unknown>,
    actor: RequestActor,
  ): Promise<InferenceReconciliationReceipt> {
    const mutation = actor.mutation;
    if (!mutation) throw new ServiceProblem(500, "ADMIN_MUTATION_BINDING_REQUIRED", "Inference reconciliation requires an owned mutation binding");
    const action = body.action;
    const expected = action === "RECORD_USAGE"
      ? ["action", "evidenceDigest", "inputTokens", "outputTokens", "runId", "tenantId"]
      : ["action", "evidenceDigest", "runId", "tenantId"];
    if ((action !== "CONFIRM_NO_USAGE" && action !== "RECORD_USAGE")
      || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expected)) {
      throw new ServiceProblem(400, "INVALID_RECONCILIATION_REQUEST", "Inference reconciliation request is invalid");
    }
    const tenantId = requiredUuid(body, "tenantId");
    const runId = requiredUuid(body, "runId");
    if (!UUID_PATTERN.test(requestId)) throw new ServiceProblem(400, "INVALID_RECONCILIATION_REQUEST", "Inference request id is invalid");
    const evidenceDigest = requiredDigest(body, "evidenceDigest");
    const tokens = action === "RECORD_USAGE" ? reconciliationTokens(body) : {};
    const receipt = await this.inferenceReconciler.reconcile({
      operationKey: mutation.identityDigest,
      tenantId,
      runId,
      requestId,
      action,
      evidenceDigest,
      reconciledBy: actor.actorId,
      ...tokens,
    });
    return this.mutate(actor, (state) => {
      this.audit(state, "INFERENCE_REQUEST_RECONCILED", `inference-request:${requestId}`, actor, {
        affectedTenantId: tenantId,
        runId,
        action,
        evidenceDigest,
        state: receipt.state,
        usage: receipt.usage,
        reconciledAt: receipt.reconciledAt,
      });
      return receipt;
    });
  }

  async lookupInferenceReconciliation(tenantId: string, runId: string) {
    if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(runId)) {
      throw new ServiceProblem(400, "INVALID_RECONCILIATION_LOOKUP", "Inference reconciliation lookup is invalid");
    }
    return this.inferenceReconciler.lookup(tenantId, runId);
  }

  async reconcileSpecModelGeneration(
    generationOperationKey: string,
    body: Record<string, unknown>,
    actor: RequestActor,
  ): Promise<SpecModelReconciliationReceipt> {
    const mutation = actor.mutation;
    if (!mutation) throw new ServiceProblem(500, "ADMIN_MUTATION_BINDING_REQUIRED", "Specification model reconciliation requires an owned mutation binding");
    const action = body.action;
    const expected = action === "RECORD_USAGE"
      ? ["action", "evidenceDigest", "inputTokens", "outputTokens", "tenantId"]
      : ["action", "evidenceDigest", "tenantId"];
    if ((action !== "CONFIRM_NO_USAGE" && action !== "RECORD_USAGE")
      || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expected)
      || !DIGEST_PATTERN.test(generationOperationKey)) {
      throw new ServiceProblem(400, "INVALID_SPEC_MODEL_RECONCILIATION_REQUEST", "Specification model reconciliation request is invalid");
    }
    const tenantId = requiredUuid(body, "tenantId");
    const evidenceDigest = requiredDigest(body, "evidenceDigest");
    const tokens = action === "RECORD_USAGE" ? specReconciliationTokens(body) : {};
    const receipt = await this.specModelReconciler.reconcile({
      operationKey: mutation.identityDigest,
      tenantId,
      generationOperationKey,
      action,
      evidenceDigest,
      reconciledBy: actor.actorId,
      ...tokens,
    });
    return this.mutate(actor, (state) => {
      this.audit(state, "SPEC_MODEL_GENERATION_RECONCILED", `spec-model-generation:${generationOperationKey}`, actor, {
        affectedTenantId: tenantId,
        dispatchGeneration: receipt.dispatchGeneration,
        action,
        evidenceDigest,
        state: receipt.state,
        usage: receipt.usage,
        reconciledAt: receipt.reconciledAt,
      });
      return receipt;
    });
  }

  async lookupSpecModelReconciliation(tenantId: string, generationOperationKey: string) {
    if (!UUID_PATTERN.test(tenantId) || !DIGEST_PATTERN.test(generationOperationKey)) {
      throw new ServiceProblem(400, "INVALID_SPEC_MODEL_RECONCILIATION_LOOKUP", "Specification model reconciliation lookup is invalid");
    }
    return this.specModelReconciler.lookup(tenantId, generationOperationKey);
  }

  private mutate<T>(
    actor: RequestActor,
    operation: (state: AdminCatalogState) => T,
    publicPayload: (result: T) => unknown = (result) => result,
  ): Promise<T> {
    return this.store.mutate(
      operation,
      actor.mutation ? { ...actor.mutation, payload: publicPayload } : undefined,
    );
  }

  private async ingestCredential(
    familyId: string,
    version: number,
    label: string,
    scope: CredentialVersionRecord["scope"],
    scopeId: string,
    apiKey: string,
  ): Promise<CredentialVersionRecord> {
    const bytes = new TextEncoder().encode(apiKey);
    try {
      const result = await this.vault.write(`${familyId}/${version}`, bytes);
      return {
        id: `${familyId}-v${version}`,
        familyId,
        version,
        label,
        scope,
        scopeId,
        secretRef: result.secretRef,
        maskedFingerprint: result.maskedFingerprint,
        state: "ACTIVE",
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
    } finally {
      bytes.fill(0);
    }
  }

  private audit(
    state: AdminCatalogState,
    action: string,
    resource: string,
    actor: RequestActor,
    metadata: Readonly<Record<string, unknown>>,
  ): void {
    recordAdminAudit(state, {
      action,
      resource,
      role: actor.role,
      actorId: actor.actorId,
      tenantId: actor.tenantId,
      projectId: actor.projectId,
      requestId: actor.requestId,
      metadata,
    });
  }
}

Inject(AdminStore)(AdminService, undefined, 0);
Inject(SecretVault)(AdminService, undefined, 1);
Inject(ProviderProbe)(AdminService, undefined, 2);
Inject(AgentSupplyChain)(AdminService, undefined, 3);
Inject(InferenceRequestReconciler)(AdminService, undefined, 4);
Inject(SpecModelGenerationReconciler)(AdminService, undefined, 5);
Injectable()(AdminService);

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function requiredUuid(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ServiceProblem(400, "INVALID_RECONCILIATION_REQUEST", `${field} is invalid`);
  }
  return value;
}

function requiredDigest(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new ServiceProblem(400, "INVALID_RECONCILIATION_REQUEST", `${field} is invalid`);
  }
  return value;
}

function reconciliationTokens(body: Record<string, unknown>): Readonly<{ inputTokens: number; outputTokens: number }> {
  const inputTokens = body.inputTokens;
  const outputTokens = body.outputTokens;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)
    || (inputTokens as number) < 0 || (outputTokens as number) < 0
    || (inputTokens as number) + (outputTokens as number) < 1) {
    throw new ServiceProblem(400, "INVALID_RECONCILIATION_REQUEST", "Recorded usage must contain non-negative token counts");
  }
  return Object.freeze({ inputTokens: inputTokens as number, outputTokens: outputTokens as number });
}

function specReconciliationTokens(body: Record<string, unknown>): Readonly<{ inputTokens: number; outputTokens: number }> {
  const inputTokens = body.inputTokens;
  const outputTokens = body.outputTokens;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)
    || (inputTokens as number) < 0 || (outputTokens as number) < 1
    || (inputTokens as number) + (outputTokens as number) > 10_000_000) {
    throw new ServiceProblem(400, "INVALID_SPEC_MODEL_RECONCILIATION_REQUEST", "Recorded specification usage must contain bounded token counts");
  }
  return Object.freeze({ inputTokens: inputTokens as number, outputTokens: outputTokens as number });
}

function assertExactVersion(value: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) || /latest|stable|default/i.test(value)) {
    throw new ServiceProblem(400, "FLOATING_VERSION_REJECTED", "Agent and adapter versions must be exact SemVer values");
  }
}

function supplyChainOperation(actor: RequestActor): Readonly<{ operationKey: string; requestDigest: string }> {
  const mutation = actor.mutation;
  if (!mutation || !/^[a-f0-9]{64}$/.test(mutation.identityDigest)
    || !/^[a-f0-9]{64}$/.test(mutation.requestFingerprint)) {
    throw new ServiceProblem(500, "ADMIN_MUTATION_BINDING_REQUIRED", "Agent supply-chain operation requires an owned mutation binding");
  }
  return Object.freeze({ operationKey: mutation.identityDigest, requestDigest: mutation.requestFingerprint });
}

function versionCandidate(record: AgentVersionRecord): AgentVersionCandidateReceipt {
  return Object.freeze({
    agent: record.agent,
    version: record.version,
    source: record.source,
    sourceDigest: record.sourceDigest,
    releaseNotesUrl: record.releaseNotesUrl,
    catalogReceiptId: record.catalogReceiptId,
    catalogReceiptDigest: record.catalogReceiptDigest,
    discoveredAt: record.discoveredAt,
  });
}

function versionValidation(record: AgentVersionRecord): AgentVersionValidationReceipt {
  if (record.state !== "APPROVED" || !record.signatureVerified || record.scan !== "PASS"
    || !record.validationReceiptId || !record.validationReceiptDigest || !record.supplyChainEvidenceDigest || !record.validatedAt) {
    throw new ServiceProblem(409, "VERSION_NOT_ATTESTED", "Approved Agent version is missing its supply-chain validation receipt");
  }
  return Object.freeze({
    agent: record.agent,
    version: record.version,
    sourceDigest: record.sourceDigest,
    integrity: record.integrity,
    signatureVerified: true,
    sbomRef: record.sbomRef,
    scan: "PASS",
    supplyChainEvidenceDigest: record.supplyChainEvidenceDigest,
    validationReceiptId: record.validationReceiptId,
    validationReceiptDigest: record.validationReceiptDigest,
    validatedAt: record.validatedAt,
  });
}

function quarantineInstallation(
  installation: InstallationRecord,
  receipt: AgentSupplyChainTerminalFailureReceipt,
): void {
  installation.previousRolloutPercent = installation.rolloutPercent;
  installation.rolloutPercent = 0;
  installation.state = "QUARANTINED";
  installation.health = "UNHEALTHY";
  installation.failure = Object.freeze({
    failureCode: receipt.failureCode,
    evidenceDigest: receipt.evidenceDigest,
    failureReceiptId: receipt.failureReceiptId,
    failureReceiptDigest: receipt.failureReceiptDigest,
    failedAt: receipt.failedAt,
  });
}

/**
 * Replaces active immutable Profile revisions with revisions pinned to the last
 * healthy installation. Defaults move atomically; already-running tasks keep
 * their original lock and image digest.
 */
function restoreProfilesToRollback(
  state: AdminCatalogState,
  installation: InstallationRecord,
  context: Readonly<{ operationDigest: string; occurredAt: string }>,
): readonly string[] {
  const rollback = installation.rollbackInstallationId
    ? state.installations.get(installation.rollbackInstallationId)
    : undefined;
  const rollbackReady = !!rollback && rollback.health === "HEALTHY" && !!rollback.imageDigest
    && rollback.state === "ACTIVE" && rollback.rolloutPercent === 100;
  const direct = [...state.profiles.values()].filter((profile) =>
    profile.installationId === installation.id && profile.state === "ACTIVE");
  const affected = new Set(direct.map((profile) => profile.id));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const profile of state.profiles.values()) {
      if (profile.state === "ACTIVE" && !affected.has(profile.id) && profile.fallbackProfileRevisionId
        && affected.has(profile.fallbackProfileRevisionId)) {
        affected.add(profile.id);
        expanded = true;
      }
    }
  }
  if (!rollbackReady) {
    for (const profile of state.profiles.values()) {
      if ((profile.installationId === installation.id || affected.has(profile.id))
        && !["SUPERSEDED", "DISABLED"].includes(profile.state)) profile.state = "DEGRADED";
    }
    return Object.freeze([]);
  }

  const sources = [...state.profiles.values()].filter((profile) => affected.has(profile.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const successorIds = new Map(sources.map((profile) => [profile.id,
    rollbackProfileRevisionId(profile, installation.id, rollback!.id, context.operationDigest)]));
  const replacements: ProfileRevisionRecord[] = [];
  for (const profile of sources) {
    const id = successorIds.get(profile.id)!;
    const directRollback = profile.installationId === installation.id;
    const expectedFallback = profile.fallbackProfileRevisionId
      ? successorIds.get(profile.fallbackProfileRevisionId) ?? profile.fallbackProfileRevisionId
      : null;
    const existing = state.profiles.get(id);
    if (existing) {
      if (existing.revision !== profile.revision + 1
        || existing.installationId !== (directRollback ? rollback!.id : profile.installationId)
        || existing.providerRevisionId !== profile.providerRevisionId
        || existing.credentialVersionId !== profile.credentialVersionId
        || existing.fallbackProfileRevisionId !== expectedFallback
        || existing.state !== "ACTIVE") {
        throw new ServiceProblem(409, "PROFILE_ROLLBACK_RACE", "Profile rollback successor conflicts with the immutable operation");
      }
      replacements.push(existing);
      continue;
    }
    const replacement: ProfileRevisionRecord = {
      ...profile,
      id,
      revision: profile.revision + 1,
      installationId: directRollback ? rollback!.id : profile.installationId,
      fallbackProfileRevisionId: expectedFallback,
      state: "ACTIVE",
      createdAt: context.occurredAt,
    };
    state.profiles.set(id, replacement);
    replacements.push(replacement);
  }
  const replacementBySource = new Map(replacements.map((replacement) => {
    const source = sources.find((profile) => successorIds.get(profile.id) === replacement.id)!;
    return [source.id, replacement.id] as const;
  }));
  for (const profile of sources) {
    const replacementId = replacementBySource.get(profile.id);
    if (!replacementId) {
      profile.state = "DEGRADED";
      continue;
    }
    profile.state = "SUPERSEDED";
    for (const [scope, profileId] of state.defaults.entries()) {
      if (profileId === profile.id) state.defaults.set(scope, replacementId);
    }
  }
  for (const profile of state.profiles.values()) {
    if (profile.installationId === installation.id && !affected.has(profile.id)
      && !["SUPERSEDED", "DISABLED"].includes(profile.state)) profile.state = "DEGRADED";
  }
  return Object.freeze([...new Set(replacements.map((profile) => profile.id))]);
}

function profileReferencesInstallation(
  state: AdminCatalogState,
  profileId: string,
  installationId: string,
): boolean {
  const visited = new Set<string>();
  let current: string | null = profileId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const profile = state.profiles.get(current);
    if (!profile) return false;
    if (profile.installationId === installationId) return true;
    current = profile.fallbackProfileRevisionId;
  }
  return false;
}

function rollbackProfileRevisionId(
  profile: ProfileRevisionRecord,
  sourceInstallationId: string,
  rollbackInstallationId: string,
  operationDigest: string,
): string {
  const digest = createHash("sha256")
    .update(`profile-installation-rollback\0${profile.id}\0${sourceInstallationId}\0${rollbackInstallationId}\0${operationDigest}`)
    .digest("hex")
    .slice(0, 24);
  return `profile-installation-rollback-${digest}-r${profile.revision + 1}`;
}

function mostRecentlyActivatedInstallation(
  state: AdminCatalogState,
  agent: InstallationRecord["agent"],
  workerPool: string,
): InstallationRecord | null {
  const candidates = [...state.installations.values()].filter((item) => item.agent === agent
    && item.workerPool === workerPool && item.state === "ACTIVE" && item.health === "HEALTHY"
    && item.rolloutPercent === 100 && !!item.imageDigest && !!item.activatedAt
    && Number.isFinite(Date.parse(item.activatedAt)));
  candidates.sort((left, right) => {
    const activationOrder = Date.parse(right.activatedAt!) - Date.parse(left.activatedAt!);
    if (activationOrder !== 0) return activationOrder;
    const creationOrder = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return creationOrder || right.id.localeCompare(left.id);
  });
  return candidates[0] ?? null;
}

function providerProbePassed(provider: ProviderRevisionRecord): boolean {
  const keys = Object.keys(provider.probe);
  return keys.length === PROVIDER_REQUIRED_CHECKS.length
    && PROVIDER_REQUIRED_CHECKS.every((check) => provider.probe[check] === "PASS");
}

function assertProfileServingReady(
  state: AdminCatalogState,
  profile: ProfileRevisionRecord,
  actor: RequestActor,
): void {
  const installation = state.installations.get(profile.installationId);
  const version = installation ? state.versions.get(installation.agentVersionId) : undefined;
  const provider = state.providers.get(profile.providerRevisionId);
  const credential = state.credentials.get(profile.credentialVersionId);
  const installationReady = installation?.agent === profile.agent && installation.state === "ACTIVE"
    && installation.health === "HEALTHY" && installation.rolloutPercent === 100
    && installation.selfUpdateDisabled === true && !!installation.imageDigest && !!installation.workerImageId
    && !!installation.buildReceiptId && !!installation.buildReceiptDigest;
  const versionReady = version?.agent === profile.agent && version.state === "APPROVED"
    && version.signatureVerified === true && version.scan === "PASS" && !!version.validationReceiptId
    && !!version.validationReceiptDigest && !!version.supplyChainEvidenceDigest;
  const providerReady = provider?.agent === profile.agent && provider.state === "ACTIVE"
    && provider.credentialVersionId === profile.credentialVersionId && providerProbePassed(provider);
  const credentialScopeReady = profile.scope === "platform"
    ? credential?.scope === "platform" && credential.scopeId === "global"
    : credential?.scope === "tenant" && !!actor.tenantId && credential.scopeId === actor.tenantId;
  if (!installationReady || !versionReady || !providerReady || credential?.state !== "ACTIVE" || !credentialScopeReady) {
    throw new ServiceProblem(
      409,
      "PROFILE_NOT_SERVING_READY",
      "Defaults require a fully active Installation, approved version, probed Provider and active credential",
    );
  }
}

function failureAudit(receipt: AgentSupplyChainTerminalFailureReceipt): Readonly<Record<string, unknown>> {
  return Object.freeze({
    failureCode: receipt.failureCode,
    evidenceDigest: receipt.evidenceDigest,
    failureReceiptId: receipt.failureReceiptId,
    failureReceiptDigest: receipt.failureReceiptDigest,
    failedAt: receipt.failedAt,
    terminalDisposition: receipt.disposition,
  });
}

interface CredentialRotationProfileBinding {
  readonly sourceProfileId: string;
  readonly successorProfileId: string;
  readonly sourceProviderId: string;
  readonly successorProviderId: string;
  readonly rotatesCredential: boolean;
}

interface CredentialRotationStage {
  readonly profiles: readonly CredentialRotationProfileBinding[];
  readonly providersToProbe: readonly ProviderRevisionRecord[];
}

interface CredentialRotationRecovery {
  readonly replacement: CredentialVersionRecord;
  readonly stage: CredentialRotationStage;
}

interface CredentialRotationCleanup {
  readonly revoke?: boolean;
  readonly completed?: Readonly<Record<string, unknown>>;
}

interface CredentialRotationBindingMetadata {
  readonly sourceProfileId: string;
  readonly successorProfileId: string;
  readonly sourceProviderId: string;
  readonly successorProviderId: string;
  readonly usesReplacement: boolean;
}

function credentialRotationOperationKey(actor: RequestActor, credentialId: string): string {
  const identity = actor.mutation?.identityDigest;
  if (identity && DIGEST_PATTERN.test(identity)) return identity;
  return createHash("sha256")
    .update(`credential-rotation\0${actor.requestId}\0${actor.actorId}\0${credentialId}`)
    .digest("hex");
}

function rotationBindingAudit(bindings: readonly CredentialRotationProfileBinding[]): readonly Readonly<CredentialRotationBindingMetadata>[] {
  return Object.freeze(bindings.map((binding) => Object.freeze({
    sourceProfileId: binding.sourceProfileId,
    successorProfileId: binding.successorProfileId,
    sourceProviderId: binding.sourceProviderId,
    successorProviderId: binding.successorProviderId,
    usesReplacement: binding.rotatesCredential,
  })));
}

function recoverCredentialRotation(
  state: AdminCatalogState,
  expected: CredentialVersionRecord,
  operationKey: string,
): CredentialRotationRecovery | undefined {
  const candidates = [...state.credentials.values()]
    .filter((replacement) => replacement.rotation?.operationKey === operationKey
      && replacement.rotation.sourceVersionId === expected.id)
    .sort((left, right) => right.version - left.version);
  for (const replacement of candidates) {
    if (replacement.state !== "ACTIVE" || replacement.familyId !== expected.familyId
      || replacement.version <= expected.version || replacement.maskedFingerprint === expected.maskedFingerprint) continue;
    const bindings = parseRotationBindings(replacement.rotation?.bindings ?? []);
    if (!bindings) continue;
    const successorBySource = new Map(bindings.map((binding) =>
      [binding.sourceProfileId, binding.successorProfileId]));
    const providers = new Map<string, ProviderRevisionRecord>();
    let valid = true;
    for (const binding of bindings) {
      const source = state.profiles.get(binding.sourceProfileId);
      const successor = state.profiles.get(binding.successorProfileId);
      const sourceProvider = state.providers.get(binding.sourceProviderId);
      const successorProvider = state.providers.get(binding.successorProviderId);
      if (!source || source.state !== "ACTIVE" || !successor || successor.state !== "VALIDATING"
        || successor.revision !== source.revision + 1 || successor.scope !== source.scope
        || successor.scopeId !== source.scopeId || successor.agent !== source.agent
        || source.providerRevisionId !== binding.sourceProviderId
        || successor.providerRevisionId !== binding.successorProviderId
        || successor.installationId !== source.installationId
        || JSON.stringify(successor.budget) !== JSON.stringify(source.budget)
        || successor.fallbackProfileRevisionId !== (source.fallbackProfileRevisionId
          ? successorBySource.get(source.fallbackProfileRevisionId) ?? source.fallbackProfileRevisionId
          : null)) {
        valid = false; break;
      }
      if (binding.rotatesCredential) {
        if (source.credentialVersionId !== expected.id || successor.credentialVersionId !== replacement.id
          || !sourceProvider || sourceProvider.state !== "ACTIVE" || sourceProvider.credentialVersionId !== expected.id
          || !successorProvider || successorProvider.state !== "VALIDATING"
          || successorProvider.credentialVersionId !== replacement.id
          || successorProvider.revision !== sourceProvider.revision + 1
          || successorProvider.agent !== sourceProvider.agent
          || successorProvider.protocol !== sourceProvider.protocol
          || successorProvider.baseUrl !== sourceProvider.baseUrl
          || successorProvider.authentication !== sourceProvider.authentication
          || JSON.stringify(successorProvider.approvedPorts) !== JSON.stringify(sourceProvider.approvedPorts)
          || JSON.stringify(successorProvider.models) !== JSON.stringify(sourceProvider.models)
          || JSON.stringify(successorProvider.pricing) !== JSON.stringify(sourceProvider.pricing)
          || JSON.stringify(successorProvider.governance) !== JSON.stringify(sourceProvider.governance)) {
          valid = false; break;
        }
        providers.set(successorProvider.id, structuredClone(successorProvider));
      } else if (binding.successorProviderId !== binding.sourceProviderId
        || successor.credentialVersionId !== source.credentialVersionId
        || !sourceProvider || sourceProvider.state !== "ACTIVE") {
        valid = false; break;
      }
    }
    if (!valid) continue;
    return Object.freeze({
      replacement: structuredClone(replacement),
      stage: Object.freeze({
        profiles: Object.freeze(bindings),
        providersToProbe: Object.freeze([...providers.values()]),
      }),
    });
  }
  return undefined;
}

function parseRotationBindings(raw: readonly unknown[]): readonly CredentialRotationProfileBinding[] | undefined {
  const bindings: CredentialRotationProfileBinding[] = [];
  const sourceIds = new Set<string>();
  const successorIds = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const value = item as Record<string, unknown>;
    if (typeof value.sourceProfileId !== "string" || typeof value.successorProfileId !== "string"
      || typeof value.sourceProviderId !== "string" || typeof value.successorProviderId !== "string"
      || typeof value.usesReplacement !== "boolean" || sourceIds.has(value.sourceProfileId)
      || successorIds.has(value.successorProfileId)) return undefined;
    sourceIds.add(value.sourceProfileId); successorIds.add(value.successorProfileId);
    bindings.push(Object.freeze({
      sourceProfileId: value.sourceProfileId,
      successorProfileId: value.successorProfileId,
      sourceProviderId: value.sourceProviderId,
      successorProviderId: value.successorProviderId,
      rotatesCredential: value.usesReplacement,
    }));
  }
  return Object.freeze(bindings);
}

function completedCredentialRotation(
  state: AdminCatalogState,
  expected: CredentialVersionRecord,
  replacement: CredentialVersionRecord,
  stage: CredentialRotationStage,
): Readonly<Record<string, unknown>> | undefined {
  const previous = state.credentials.get(expected.id);
  const active = state.credentials.get(replacement.id);
  if (!previous || previous.state !== "PREVIOUS" || !active || active.state !== "ACTIVE"
    || active.maskedFingerprint !== replacement.maskedFingerprint) return undefined;
  const sourceIds = new Set(stage.profiles.map((binding) => binding.sourceProfileId));
  if ([...state.defaults.values()].some((profileId) => sourceIds.has(profileId))) return undefined;
  for (const binding of stage.profiles) {
    if (state.profiles.get(binding.sourceProfileId)?.state !== "SUPERSEDED"
      || state.profiles.get(binding.successorProfileId)?.state !== "ACTIVE") return undefined;
    if (binding.rotatesCredential
      && (state.providers.get(binding.sourceProviderId)?.state !== "SUPERSEDED"
        || state.providers.get(binding.successorProviderId)?.state !== "ACTIVE")) return undefined;
  }
  return Object.freeze({
    active,
    previous,
    successorProfileRevisionIds: Object.freeze(stage.profiles.map((item) => item.successorProfileId)),
    newTasksOnly: true,
    oldVersionNoLongerIssued: true,
  });
}

function stageCredentialRotation(
  state: AdminCatalogState,
  expected: CredentialVersionRecord,
  replacement: CredentialVersionRecord,
  operationKey: string,
): CredentialRotationStage {
  const active = state.credentials.get(expected.id);
  if (!active || active.state !== "ACTIVE" || active.version !== expected.version
    || active.maskedFingerprint !== expected.maskedFingerprint || active.familyId !== replacement.familyId
    || replacement.version <= active.version || state.credentials.has(replacement.id)
    || !DIGEST_PATTERN.test(operationKey)) rotationRace();

  const activeProfiles = [...state.profiles.values()].filter((profile) => profile.state === "ACTIVE");
  const directlyAffected = new Set(activeProfiles
    .filter((profile) => profile.credentialVersionId === expected.id)
    .map((profile) => profile.id));
  const affected = new Set(directlyAffected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const profile of activeProfiles) {
      if (!affected.has(profile.id) && profile.fallbackProfileRevisionId
        && affected.has(profile.fallbackProfileRevisionId)) {
        affected.add(profile.id);
        changed = true;
      }
    }
  }

  const sources = activeProfiles.filter((profile) => affected.has(profile.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const successorIds = new Map(sources.map((profile) => [profile.id,
    rotationRevisionId("profile", profile.id, replacement.id, profile.revision + 1)]));
  const providerIds = new Map<string, string>();
  const providersToProbe: ProviderRevisionRecord[] = [];

  for (const profile of sources) {
    if (!directlyAffected.has(profile.id)) continue;
    const provider = state.providers.get(profile.providerRevisionId);
    if (!provider || provider.state !== "ACTIVE" || provider.credentialVersionId !== expected.id
      || provider.agent !== profile.agent) rotationRace();
    if (!providerIds.has(provider.id)) {
      const id = rotationRevisionId("provider", provider.id, replacement.id, provider.revision + 1);
      if (state.providers.has(id)) rotationRace();
      const successor: ProviderRevisionRecord = {
        ...provider,
        id,
        revision: provider.revision + 1,
        credentialVersionId: replacement.id,
        state: "VALIDATING",
        probe: Object.freeze({}),
      };
      state.providers.set(successor.id, successor);
      providerIds.set(provider.id, successor.id);
      providersToProbe.push(structuredClone(successor));
    }
  }

  const bindings: CredentialRotationProfileBinding[] = [];
  const createdAt = new Date().toISOString();
  for (const profile of sources) {
    const rotatesCredential = directlyAffected.has(profile.id);
    const successorProfileId = successorIds.get(profile.id)!;
    if (state.profiles.has(successorProfileId)) rotationRace();
    const successorProviderId = rotatesCredential
      ? providerIds.get(profile.providerRevisionId)
      : profile.providerRevisionId;
    if (!successorProviderId) rotationRace();
    const successor: ProfileRevisionRecord = {
      ...profile,
      id: successorProfileId,
      revision: profile.revision + 1,
      providerRevisionId: successorProviderId,
      credentialVersionId: rotatesCredential ? replacement.id : profile.credentialVersionId,
      fallbackProfileRevisionId: profile.fallbackProfileRevisionId
        ? successorIds.get(profile.fallbackProfileRevisionId) ?? profile.fallbackProfileRevisionId
        : null,
      state: "VALIDATING",
      createdAt,
    };
    state.profiles.set(successor.id, successor);
    bindings.push(Object.freeze({
      sourceProfileId: profile.id,
      successorProfileId: successor.id,
      sourceProviderId: profile.providerRevisionId,
      successorProviderId,
      rotatesCredential,
    }));
  }
  state.credentials.set(replacement.id, {
    ...structuredClone(replacement),
    rotation: Object.freeze({
      operationKey,
      sourceVersionId: expected.id,
      bindings: rotationBindingAudit(bindings),
    }),
  });
  return Object.freeze({
    profiles: Object.freeze(bindings),
    providersToProbe: Object.freeze(providersToProbe),
  });
}

function rotationRevisionId(
  kind: "profile" | "provider",
  sourceId: string,
  replacementId: string,
  revision: number,
): string {
  const digest = createHash("sha256").update(`${kind}\0${sourceId}\0${replacementId}`).digest("hex").slice(0, 24);
  return `${kind}-credential-rotation-${digest}-r${revision}`;
}

function rotationRace(): never {
  throw new ServiceProblem(409, "CREDENTIAL_ROTATION_RACE", "Credential configuration changed before rotation could commit");
}

function parseScope(value: unknown): ProfileScope {
  if (value === "platform" || value === "tenant" || value === "project") return value;
  throw new ServiceProblem(400, "INVALID_SCOPE", "scope must be platform, tenant, or project");
}

function assertScopeRole(scope: ProfileScope, scopeId: string, actor: RequestActor): void {
  if (scope === "platform" && scopeId !== "global") {
    throw new ServiceProblem(400, "INVALID_SCOPE", "Platform Agent configuration must use scopeId global");
  }
  if (actor.role === "SecurityAdmin") return;
  if (scope === "platform" && scopeId === "global" && actor.role === "PlatformAgentAdmin") return;
  if (scope === "tenant" && actor.role === "TenantAdmin" && actor.tenantId === scopeId) return;
  if (scope === "project" && actor.role === "ProjectOwner" && actor.projectId === scopeId && actor.tenantId) return;
  throw new ServiceProblem(403, "SCOPE_FORBIDDEN", `Role ${actor.role} cannot administer ${scope} Agent configuration`);
}

function scopeForCredentialActor(actor: RequestActor): Pick<CredentialVersionRecord, "scope" | "scopeId"> {
  if (actor.role === "SecurityAdmin") return { scope: "platform", scopeId: "global" };
  if (actor.role === "TenantAdmin" && actor.tenantId) return { scope: "tenant", scopeId: actor.tenantId };
  throw new ServiceProblem(403, "CREDENTIAL_SCOPE_FORBIDDEN", "This principal cannot create Provider credentials");
}

function assertCredentialActor(credential: CredentialVersionRecord, actor: RequestActor): void {
  if (actor.role === "SecurityAdmin") return;
  if (actor.role === "TenantAdmin" && credential.scope === "tenant" && credential.scopeId === actor.tenantId) return;
  throw new ServiceProblem(403, "CREDENTIAL_SCOPE_FORBIDDEN", "Credential does not belong to the authenticated scope");
}

function assertProfileCredential(
  profileScope: ProfileScope,
  profileScopeId: string,
  credential: CredentialVersionRecord,
  actor: RequestActor,
): void {
  if (profileScope === "platform") {
    if (credential.scope === "platform" && credential.scopeId === "global") return;
  } else if (profileScope === "tenant") {
    if (credential.scope === "tenant" && credential.scopeId === profileScopeId) return;
  } else if (credential.scope === "tenant" && credential.scopeId === actor.tenantId) {
    return;
  }
  throw new ServiceProblem(403, "CREDENTIAL_SCOPE_FORBIDDEN", "Profile cannot use a credential from another scope");
}

function assertFallbackProfile(
  state: AdminCatalogState,
  fallbackProfileRevisionId: string | null,
  agent: ProfileRevisionRecord["agent"],
  scope: ProfileScope,
  scopeId: string,
): void {
  if (!fallbackProfileRevisionId) return;
  const fallback = state.profiles.get(fallbackProfileRevisionId);
  if (!fallback || fallback.state !== "ACTIVE" || fallback.agent !== agent
    || fallback.scope !== scope || fallback.scopeId !== scopeId) {
    throw new ServiceProblem(
      409,
      "FALLBACK_PROFILE_NOT_ALLOWED",
      "Fallback must be an active exact Profile for the same Agent and scope",
    );
  }
}

function requireProfile(state: AdminCatalogState, profileId: string): ProfileRevisionRecord {
  const profile = state.profiles.get(profileId);
  if (!profile) throw new ServiceProblem(404, "PROFILE_NOT_FOUND", "Profile revision does not exist");
  return profile;
}

function requireProvider(state: AdminCatalogState, providerId: string): ProviderRevisionRecord {
  const provider = state.providers.get(providerId);
  if (!provider) throw new ServiceProblem(409, "PROVIDER_NOT_FOUND", "Provider revision does not exist");
  return provider;
}

function auditVisibleTo(record: AuditRecord, actor: RequestActor): boolean {
  if (actor.role === "PlatformAgentAdmin" || actor.role === "SecurityAdmin") return true;
  if (actor.role === "Auditor" && !actor.tenantId) return true;
  if (record.tenantId !== actor.tenantId) return false;
  if (actor.projectId && record.projectId !== actor.projectId) return false;
  return true;
}

type OperationalAlert = Readonly<{
  id: string;
  severity: "WARNING" | "CRITICAL";
  code: string;
  resource: string;
  message: string;
}>;

type ConfigurationDiff = Readonly<{
  id: string;
  action: string;
  resource: string;
  actorId: string;
  at: string;
  changes: readonly Readonly<{ field: string; before: unknown; after: unknown }>[];
}>;

function operationalAlerts(
  state: AdminCatalogState,
  supplyChain: Readonly<{ status: string }>,
  usageAvailable: boolean,
  profiles: readonly ProfileRevisionRecord[],
  providers: readonly ProviderRevisionRecord[],
): readonly OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  const add = (severity: OperationalAlert["severity"], code: string, resource: string, message: string) => {
    alerts.push(Object.freeze({ id: `${code}:${resource}`, severity, code, resource, message }));
  };
  if (supplyChain.status !== "READY") {
    add("CRITICAL", "AGENT_SUPPLY_CHAIN_UNAVAILABLE", "agent-supply-chain", "Agent 制品供应链不可用，新版本安装与灰度已停止");
  }
  if (!usageAvailable) {
    add("WARNING", "INFERENCE_USAGE_TELEMETRY_UNAVAILABLE", "inference-usage", "推理使用账本当前不可读取，预算记录保持故障关闭");
  }
  for (const installation of state.installations.values()) {
    if (["FAILED", "QUARANTINED"].includes(installation.state)) {
      add("CRITICAL", "AGENT_INSTALLATION_UNSERVABLE", installation.id, `安装处于 ${installation.state}，新任务不会分配`);
    } else if (installation.state === "ACTIVE" && installation.health !== "HEALTHY") {
      add("CRITICAL", "ACTIVE_INSTALLATION_UNHEALTHY", installation.id, `活跃安装健康状态为 ${installation.health}`);
    }
  }
  for (const provider of providers) {
    if (provider.state === "DEGRADED") {
      add("WARNING", "PROVIDER_DEGRADED", provider.id, "Provider revision 已降级，未授权静默切换 Agent");
    }
    if (Object.values(provider.probe).some((result) => result === "FAIL")) {
      add("CRITICAL", "PROVIDER_PROBE_FAILED", provider.id, "Provider 的认证、模型或网络安全探针未全部通过");
    }
  }
  for (const profile of profiles.filter((item) => item.state === "ACTIVE")) {
    const installation = state.installations.get(profile.installationId);
    const provider = state.providers.get(profile.providerRevisionId);
    const credential = state.credentials.get(profile.credentialVersionId);
    if (!installation || installation.state !== "ACTIVE" || installation.health !== "HEALTHY") {
      add("CRITICAL", "PROFILE_INSTALLATION_BINDING_UNAVAILABLE", profile.id, "活跃 Profile 绑定的精确 WorkerImage 当前不可服务");
    }
    if (!provider || provider.state !== "ACTIVE" || !providerProbePassed(provider)) {
      add("CRITICAL", "PROFILE_PROVIDER_BINDING_UNAVAILABLE", profile.id, "活跃 Profile 绑定的 Provider revision 当前不可服务");
    }
    if (!credential || credential.state !== "ACTIVE") {
      add("CRITICAL", "PROFILE_CREDENTIAL_BINDING_UNAVAILABLE", profile.id, "活跃 Profile 绑定的凭据版本已不可签发新任务 token");
    }
  }
  return Object.freeze(alerts);
}

function configurationDiffs(records: readonly AuditRecord[]): readonly ConfigurationDiff[] {
  const result: ConfigurationDiff[] = [];
  for (const record of records) {
    if (!/^(AGENT_(VERSION|INSTALLATION|ROLLOUT|PROFILE|DEFAULT)|CREDENTIAL_)/.test(record.action)) continue;
    const changes: Array<Readonly<{ field: string; before: unknown; after: unknown }>> = [];
    appendDiff(changes, record.metadata, "state", "previousState", "state");
    appendDiff(changes, record.metadata, "providerState", "previousProviderState", "providerState");
    appendDiff(changes, record.metadata, "rolloutPercent", "previousRolloutPercent", "rolloutPercent");
    appendDiff(changes, record.metadata, "profileRevisionId", "previousProfileRevisionId", "profileRevisionId");
    if (record.action === "CREDENTIAL_ROTATED" && typeof record.metadata.replacementVersionId === "string") {
      changes.push(Object.freeze({ field: "credentialVersionId", before: record.resource, after: record.metadata.replacementVersionId }));
    }
    if (changes.length === 0 && /(CREATED|DRAFTED|DISCOVERED|READY)$/.test(record.action)) {
      changes.push(Object.freeze({ field: "resource", before: null, after: record.resource }));
    }
    if (changes.length === 0) continue;
    result.push(Object.freeze({
      id: record.id,
      action: record.action,
      resource: record.resource,
      actorId: record.actorId,
      at: record.at,
      changes: Object.freeze(changes),
    }));
    if (result.length === 50) break;
  }
  return Object.freeze(result);
}

function appendDiff(
  target: Array<Readonly<{ field: string; before: unknown; after: unknown }>>,
  metadata: Readonly<Record<string, unknown>>,
  field: string,
  beforeKey: string,
  afterKey: string,
): void {
  if (!(beforeKey in metadata) || !(afterKey in metadata)) return;
  if (JSON.stringify(metadata[beforeKey]) === JSON.stringify(metadata[afterKey])) return;
  target.push(Object.freeze({ field, before: metadata[beforeKey], after: metadata[afterKey] }));
}

function profileVisibleTo(profile: ProfileRevisionRecord, actor: RequestActor): boolean {
  if (actor.role === "PlatformAgentAdmin" || actor.role === "SecurityAdmin" || (actor.role === "Auditor" && !actor.tenantId)) return true;
  if (profile.scope === "platform") return profile.state === "ACTIVE";
  if (profile.scope === "tenant") return Boolean(actor.tenantId && profile.scopeId === actor.tenantId);
  return Boolean(actor.projectId && profile.scopeId === actor.projectId && actor.tenantId);
}

function credentialVisibleTo(credential: CredentialVersionRecord, actor: RequestActor): boolean {
  if (actor.role === "PlatformAgentAdmin" || actor.role === "SecurityAdmin" || (actor.role === "Auditor" && !actor.tenantId)) return true;
  return actor.role === "TenantAdmin" && credential.scope === "tenant" && credential.scopeId === actor.tenantId;
}

function parseDefaultScope(value: string): { scope: ProfileScope; scopeId: string } {
  if (value === "platform") return { scope: "platform", scopeId: "global" };
  const match = /^(tenant|project):([a-z0-9][a-z0-9_-]{0,159})$/i.exec(value);
  if (!match) throw new ServiceProblem(400, "INVALID_SCOPE", "Default scope must be platform, tenant:<id>, or project:<id>");
  return { scope: match[1] as "tenant" | "project", scopeId: match[2] ?? "" };
}

function profileSelectableForDefault(
  profile: ProfileRevisionRecord,
  target: Readonly<{ scope: ProfileScope; scopeId: string }>,
  actor: RequestActor,
): boolean {
  if (target.scope === "platform") return profile.scope === "platform" && profile.scopeId === "global";
  if (profile.scope === "platform") return profile.scopeId === "global";
  if (target.scope === "tenant") return profile.scope === "tenant" && profile.scopeId === target.scopeId;
  if (profile.scope === "project") return profile.scopeId === target.scopeId;
  return profile.scope === "tenant" && Boolean(actor.tenantId) && profile.scopeId === actor.tenantId;
}

function parseGovernance(body: Record<string, unknown>, actor: RequestActor): ProviderRevisionRecord["governance"] {
  return {
    dataRegion: requiredString(body, "dataRegion", 120),
    retentionPolicy: requiredString(body, "retentionPolicy", 500),
    trainingPolicy: requiredString(body, "trainingPolicy", 500),
    confirmedBy: actor.actorId,
    confirmedAt: new Date().toISOString(),
  };
}

function parseBudget(body: Record<string, unknown>): ProfileRevisionRecord["budget"] {
  const maxUsd = typeof body.maxBudgetUsd === "number" ? body.maxBudgetUsd : 25;
  const maxTurns = typeof body.maxTurns === "number" ? body.maxTurns : 100;
  const timeoutSeconds = typeof body.timeoutSeconds === "number" ? body.timeoutSeconds : 7200;
  if (!(maxUsd > 0 && maxUsd <= 100) || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 200 || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 14_400) {
    throw new ServiceProblem(400, "BUDGET_OUT_OF_POLICY", "Profile budget or timeout exceeds platform limits");
  }
  return Object.freeze({ maxUsd, maxTurns, timeoutSeconds });
}

function parseProviderAuthentication(
  body: Record<string, unknown>,
  agent: AgentKind,
): ProviderRevisionRecord["authentication"] {
  const value = requiredString(body, "authentication", 40);
  if (agent === "codex-cli" && value === "bearer") return value;
  if (agent === "claude-code" && (value === "x-api-key" || value === "authorization-bearer")) return value;
  throw new ServiceProblem(400, "PROVIDER_AUTHENTICATION_REJECTED", "Authentication is incompatible with the selected Agent protocol");
}

function parseProviderPricing(body: Record<string, unknown>): ProviderRevisionRecord["pricing"] {
  const input = body.inputUsdPerMillionTokens;
  const output = body.outputUsdPerMillionTokens;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 1_000_000
    || typeof output !== "number" || !Number.isFinite(output) || output < 0 || output > 1_000_000) {
    throw new ServiceProblem(400, "PROVIDER_PRICING_REJECTED", "Provider token pricing must be explicit non-negative USD per million tokens");
  }
  return Object.freeze({ inputUsdPerMillionTokens: input, outputUsdPerMillionTokens: output });
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
