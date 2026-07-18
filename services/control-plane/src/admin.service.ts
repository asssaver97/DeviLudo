import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { InferenceReconciliationReceipt } from "../../inference-gateway/src/contracts";
import { normalizeModelRoles } from "../../../lib/agent/providers";
import { validateProviderBaseUrl } from "../../../lib/security/network";
import { AdminStore, recordAdminAudit, type AdminCatalogState } from "./admin.store";
import {
  ServiceProblem,
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
import { ProviderProbe } from "./provider-probe";
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

export class AdminService {
  constructor(
    private readonly store: AdminStore,
    private readonly vault: SecretVault,
    private readonly providerProbe: ProviderProbe,
    private readonly supplyChain: AgentSupplyChain,
    private readonly inferenceReconciler: InferenceRequestReconciler,
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
      return this.mutate(actor, (state) => {
        const record = state.versions.get(id);
        if (!record) throw new ServiceProblem(404, "AGENT_VERSION_NOT_FOUND", "Agent version was not discovered");
        if (record.state === "DEPRECATED") {
          throw new ServiceProblem(409, "INVALID_VERSION_TRANSITION", "A deprecated version cannot be blocked in place");
        }
        record.state = "BLOCKED";
        this.audit(state, "AGENT_VERSION_BLOCKED", record.id, actor, { automaticActivation: false });
        return { version: record, automaticActivation: false };
      });
    }
    if ([
      "integrity", "signatureVerified", "scan", "sbomRef", "sourceDigest", "validationReceipt",
      "validationReceiptId", "validationReceiptDigest", "supplyChainEvidenceDigest", "validatedAt", "imageDigest",
    ].some((field) => body[field] !== undefined)) {
      throw new ServiceProblem(400, "CALLER_ATTESTATION_FORBIDDEN", "Supply-chain evidence must come from the isolated Broker");
    }
    const candidate = await this.store.mutate((state) => {
      const record = state.versions.get(id);
      if (!record) throw new ServiceProblem(404, "AGENT_VERSION_NOT_FOUND", "Agent version was not discovered");
      if (record.state !== "DISCOVERED" && record.state !== "VALIDATING") {
        throw new ServiceProblem(409, "INVALID_VERSION_TRANSITION", "Only a discovered or validating version can be approved");
      }
      record.state = "VALIDATING";
      this.audit(state, "AGENT_VERSION_VALIDATION_STARTED", record.id, actor, {
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
      const rollback = [...state.installations.values()].find((item) => item.agent === agent
        && item.workerPool === workerPool && item.state === "ACTIVE") ?? null;
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
          const rollbackProfiles = restoreProfilesToRollback(state, installation, error.receipt);
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
          const rollbackProfiles = restoreProfilesToRollback(state, installation, error.receipt);
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
      this.audit(state, `AGENT_ROLLOUT_${action.toUpperCase()}`, installationId, actor, {
        rolloutPercent: installation.rolloutPercent,
        rolloutReceiptId: receipt.rolloutReceiptId,
        rolloutReceiptDigest: receipt.rolloutReceiptDigest,
        runningTasksUnaffected: true,
      });
      return {
        installation,
        newTasksOnly: true,
        activeRunsKeepPinnedImage: true,
        incompatibleSessionsNeverResumeAcrossVersions: true,
      };
    });
  }

  async createCredential(body: Record<string, unknown>, actor: RequestActor): Promise<CredentialVersionRecord> {
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
    const current = await this.store.read((state) => {
      const value = state.credentials.get(credentialId);
      return value ? structuredClone(value) : undefined;
    });
    if (!current) throw new ServiceProblem(404, "CREDENTIAL_NOT_FOUND", "Credential version does not exist");
    if (current.state !== "ACTIVE") throw new ServiceProblem(409, "CREDENTIAL_NOT_ACTIVE", "Only an active credential can be rotated");
    assertCredentialActor(current, actor);
    const apiKey = requiredString(body, "apiKey", 8192);
    let replacement: CredentialVersionRecord;
    try {
      replacement = await this.ingestCredential(
        current.familyId,
        current.version + 1,
        current.label,
        current.scope,
        current.scopeId,
        apiKey,
      );
    } finally {
      body.apiKey = "";
    }
    if (replacement.maskedFingerprint === current.maskedFingerprint) {
      await this.vault.revoke(replacement.secretRef);
      throw new ServiceProblem(409, "CREDENTIAL_REUSED", "Replacement credential must contain new secret material");
    }
    try {
      return await this.mutate(actor, (state) => {
        const active = state.credentials.get(credentialId);
        if (!active || active.state !== "ACTIVE" || active.version !== current.version
          || active.maskedFingerprint !== current.maskedFingerprint) {
          throw new ServiceProblem(409, "CREDENTIAL_ROTATION_RACE", "Credential changed before rotation could commit");
        }
        active.state = "PREVIOUS";
        state.credentials.set(replacement.id, replacement);
        this.audit(state, "CREDENTIAL_ROTATED", active.id, actor, {
          replacementVersionId: replacement.id,
          oldVersionNoLongerIssued: true,
        });
        return { active: replacement, previous: active, newTasksOnly: true };
      }, credentialResultView);
    } catch (error) {
      await this.vault.revoke(replacement.secretRef).catch(() => undefined);
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
        value.state = "REVOKED";
        this.audit(state, "CREDENTIAL_REVOKED", value.id, actor, { newTokensIssued: false });
      }
      return structuredClone(value);
    }, credentialView);
  }

  async createProfile(body: Record<string, unknown>, actor: RequestActor): Promise<Readonly<Record<string, unknown>>> {
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
        profile.state = "VALIDATING";
        provider.state = "VALIDATING";
        this.audit(state, "AGENT_PROFILE_VALIDATION_STARTED", profile.id, actor, {
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
            profile.state = "DEGRADED";
            provider.state = "DEGRADED";
            this.audit(state, "AGENT_PROFILE_VALIDATION_FAILED", profile.id, actor, {
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
        profile.state = "READY";
        provider.state = "READY";
        this.audit(state, "AGENT_PROFILE_VALIDATE", profile.id, actor, {
          state: profile.state,
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
      if (action === "activate") {
        if (actor.role !== "SecurityAdmin") {
          throw new ServiceProblem(403, "SECURITY_APPROVAL_REQUIRED", "SecurityAdmin must activate a third-party Provider endpoint");
        }
        if (profile.state !== "READY" || provider.state !== "READY" || Object.values(provider.probe).some((result) => result !== "PASS")) {
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
        state: profile.state,
        providerRevisionId: provider.id,
        priorActiveConfigurationPreserved: false,
      });
      return { profile, provider, affectsQueuedOrRunningTasks: false };
    });
  }

  async updateDefault(scopeKey: string, body: Record<string, unknown>, actor: RequestActor): Promise<Readonly<Record<string, unknown>>> {
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
      state.defaults.set(scopeKey, profileRevisionId);
      this.audit(state, "AGENT_DEFAULT_UPDATED", scopeKey, actor, { profileRevisionId, runningTasksUnaffected: true });
      return {
        scope: scopeKey,
        profileRevisionId,
        precedence: "project > tenant > platform > built-in Claude Code",
        newTasksOnly: true,
      };
    });
  }

  async health(): Promise<Readonly<Record<string, unknown>>> {
    let supplyChain: AgentSupplyChainHealth | Readonly<{ service: "deviludo-agent-supply-chain"; status: "UNAVAILABLE" }>;
    try { supplyChain = await this.supplyChain.probe(); }
    catch { supplyChain = Object.freeze({ service: "deviludo-agent-supply-chain", status: "UNAVAILABLE" }); }
    return this.store.read((state) => {
      const installations = [...state.installations.values()];
      return {
        status: supplyChain.status !== "READY" || installations.some((item) => ["FAILED", "QUARANTINED"].includes(item.state)) ? "DEGRADED" : "HEALTHY",
        installations,
        providers: [...state.providers.values()].map(({ id, state: providerState, probe }) => ({ id, state: providerState, probe })),
        supplyChain,
        isolation: { developmentWorkers: true, e2eRunnersContainAgent: false, steamPublishersContainAgent: false },
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
  receipt: AgentSupplyChainTerminalFailureReceipt,
): readonly string[] {
  const rollback = installation.rollbackInstallationId
    ? state.installations.get(installation.rollbackInstallationId)
    : undefined;
  const rollbackReady = !!rollback && rollback.health === "HEALTHY" && !!rollback.imageDigest
    && ["READY", "CANARY", "ACTIVE"].includes(rollback.state);
  const replacements: string[] = [];
  for (const profile of [...state.profiles.values()]) {
    if (profile.installationId !== installation.id || ["SUPERSEDED", "DISABLED"].includes(profile.state)) continue;
    if (profile.state !== "ACTIVE" || !rollbackReady) {
      profile.state = "DEGRADED";
      continue;
    }
    const configuredFallback = profile.fallbackProfileRevisionId
      ? state.profiles.get(profile.fallbackProfileRevisionId)
      : undefined;
    let replacement = configuredFallback?.state === "ACTIVE"
      && configuredFallback.installationId === rollback!.id
      && configuredFallback.agent === profile.agent
      && configuredFallback.scope === profile.scope
      && configuredFallback.scopeId === profile.scopeId
      ? configuredFallback
      : [...state.profiles.values()].find((candidate) => candidate.id !== profile.id
        && candidate.state === "ACTIVE" && candidate.installationId === rollback!.id
        && candidate.agent === profile.agent && candidate.scope === profile.scope && candidate.scopeId === profile.scopeId);
    if (!replacement) {
      const revision = profile.revision + 1;
      const id = `${profile.id}-rollback-${receipt.failureReceiptDigest.slice(0, 12)}-r${revision}`;
      const existing = state.profiles.get(id);
      if (existing) {
        if (existing.installationId !== rollback!.id || existing.providerRevisionId !== profile.providerRevisionId) {
          profile.state = "DEGRADED";
          continue;
        }
        replacement = existing;
      } else {
        replacement = {
          ...profile,
          id,
          revision,
          installationId: rollback!.id,
          state: "ACTIVE",
          createdAt: receipt.failedAt,
        };
        state.profiles.set(id, replacement);
      }
    }
    profile.state = "SUPERSEDED";
    for (const [scope, profileId] of state.defaults.entries()) {
      if (profileId === profile.id) state.defaults.set(scope, replacement.id);
    }
    replacements.push(replacement.id);
  }
  return Object.freeze([...new Set(replacements)]);
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
