import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { normalizeModelRoles } from "../../../lib/agent/providers";
import { validateProviderBaseUrl } from "../../../lib/security/network";
import { AdminStore, recordAdminAudit, type AdminCatalogState } from "./admin.store";
import {
  ServiceProblem,
  isAgentKind,
  optionalString,
  requiredString,
  type AuditRecord,
  type CredentialVersionRecord,
  type InstallationRecord,
  type ProfileRevisionRecord,
  type ProfileScope,
  type ProviderRevisionRecord,
  type RequestActor,
} from "./contracts";
import { SecretVault } from "./secret-vault";
import { ProviderProbe } from "./provider-probe";

export class AdminService {
  constructor(
    private readonly store: AdminStore,
    private readonly vault: SecretVault,
    private readonly providerProbe: ProviderProbe,
  ) {}

  async agents(): Promise<Readonly<Record<string, unknown>>> {
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
      return Object.freeze({
        catalog,
        platformDefault: state.defaults.get("platform") ?? "built-in:claude-code",
        selectionPrecedence: ["project", "tenant", "platform", "built-in:claude-code"],
        pinnedVersionsOnly: true,
      });
    });
  }

  async discoverVersions(body: Record<string, unknown>, actor: RequestActor): Promise<Readonly<Record<string, unknown>>> {
    const agentInput = body.agent ?? "claude-code";
    if (!isAgentKind(agentInput)) throw new ServiceProblem(400, "INVALID_AGENT", "Unsupported Agent kind");
    const version = optionalString(body, "version") ?? (agentInput === "claude-code" ? "2.1.15" : "0.92.0");
    assertExactVersion(version);
    const id = `${agentInput}@${version}`;
    return this.store.mutate((state) => {
      const existing = state.versions.get(id);
      if (existing) return { candidates: [existing], activationChanged: false };
      const record = {
        id,
        agent: agentInput,
        version,
        state: "DISCOVERED" as const,
        source:
          agentInput === "claude-code"
            ? "https://code.claude.com/docs/en/installation"
            : "https://github.com/openai/codex",
        integrity: `sha256:${"0".repeat(64)}`,
        signatureVerified: false,
        sbomRef: `pending://${id}`,
        scan: "PENDING" as const,
        discoveredAt: new Date().toISOString(),
      };
      state.versions.set(id, record);
      this.audit(state, "AGENT_VERSION_DISCOVERED", id, actor, { source: "official-catalog", activationChanged: false });
      return { candidates: [record], activationChanged: false };
    });
  }

  setVersionState(
    action: "approve" | "block",
    body: Record<string, unknown>,
    actor: RequestActor,
  ): Promise<Readonly<Record<string, unknown>>> {
    const id = requiredString(body, "id", 160);
    return this.store.mutate((state) => {
      const record = state.versions.get(id);
      if (!record) throw new ServiceProblem(404, "AGENT_VERSION_NOT_FOUND", "Agent version was not discovered");
      if (action === "approve") {
      if (record.state !== "DISCOVERED" && record.state !== "VALIDATING") {
        throw new ServiceProblem(409, "INVALID_VERSION_TRANSITION", "Only a discovered or validating version can be approved");
      }
      const integrity = requiredString(body, "integrity", 80).toLowerCase();
      const sbomRef = requiredString(body, "sbomRef", 1000);
      if (!/^sha256:[a-f0-9]{64}$/.test(integrity) || body.signatureVerified !== true || body.scan !== "PASS") {
        throw new ServiceProblem(409, "SUPPLY_CHAIN_GATES_FAILED", "Signature, integrity and scanner gates must pass before approval");
      }
      if (!/^oci:\/\/[a-z0-9._:/@-]+$/i.test(sbomRef)) {
        throw new ServiceProblem(400, "INVALID_SBOM_REFERENCE", "SBOM must be mirrored to an internal OCI reference");
      }
      Object.assign(record, {
        state: "APPROVED",
        signatureVerified: true,
        scan: "PASS",
        integrity,
        sbomRef,
      });
      } else {
        if (record.state === "DEPRECATED") {
          throw new ServiceProblem(409, "INVALID_VERSION_TRANSITION", "A deprecated version cannot be blocked in place");
        }
        record.state = "BLOCKED";
      }
      this.audit(state, `AGENT_VERSION_${record.state}`, record.id, actor, { automaticActivation: false });
      return { version: record, automaticActivation: false };
    });
  }

  async createInstallation(body: Record<string, unknown>, actor: RequestActor): Promise<InstallationRecord> {
    const agent = body.agent;
    if (!isAgentKind(agent)) throw new ServiceProblem(400, "INVALID_AGENT", "Unsupported Agent kind");
    const version = requiredString(body, "version", 100);
    assertExactVersion(version);
    const imageDigest = requiredString(body, "imageDigest", 80);
    if (!/^sha256:[a-f0-9]{64}$/i.test(imageDigest)) {
      throw new ServiceProblem(400, "INVALID_IMAGE_DIGEST", "imageDigest must be an exact sha256 OCI digest");
    }
    const workerPool = requiredString(body, "workerPool", 120);
    if (!/^dev(?:elopment)?[-_a-z0-9]*$/i.test(workerPool)) {
      throw new ServiceProblem(400, "UNSAFE_WORKER_POOL", "Autonomous Agents may only be installed on development Worker pools");
    }
    const adapterVersion = requiredString(body, "adapterVersion", 100);
    assertExactVersion(adapterVersion);
    return this.store.mutate((state) => {
      const versionRecord = state.versions.get(`${agent}@${version}`);
      if (!versionRecord || versionRecord.state !== "APPROVED") {
        throw new ServiceProblem(409, "VERSION_NOT_APPROVED", "Installation requires an approved exact Agent version");
      }
      const id = `${agent}-installation-${randomUUID()}`;
      const installation: InstallationRecord = {
        id,
        agent,
        agentVersionId: versionRecord.id,
        workerPool,
        imageDigest: imageDigest.toLowerCase(),
        adapterVersion,
        state: "READY",
        rolloutPercent: 0,
        previousRolloutPercent: 0,
        selfUpdateDisabled: true,
        createdAt: new Date().toISOString(),
      };
      state.installations.set(id, installation);
      this.audit(state, "AGENT_INSTALLATION_READY", id, actor, {
        agent,
        version,
        workerPool,
        imageDigest: installation.imageDigest,
        supplyChainGates: "signature,sbom,vulnerability,malware,adapter-smoke,sandbox-smoke",
      });
      return installation;
    });
  }

  rollout(
    installationId: string,
    action: "advance" | "rollback",
    actor: RequestActor,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.store.mutate((state) => {
      const installation = state.installations.get(installationId);
      if (!installation) throw new ServiceProblem(404, "INSTALLATION_NOT_FOUND", "Agent installation does not exist");
      if (["FAILED", "QUARANTINED", "RETIRED"].includes(installation.state)) {
        throw new ServiceProblem(409, "INSTALLATION_NOT_ROLLOUT_ELIGIBLE", "Installation cannot accept new tasks");
      }
      installation.previousRolloutPercent = installation.rolloutPercent;
      if (action === "rollback") {
        installation.rolloutPercent = 0;
        installation.state = "READY";
      } else {
        installation.rolloutPercent =
          installation.rolloutPercent < 5 ? 5 : installation.rolloutPercent < 25 ? 25 : 100;
        installation.state = installation.rolloutPercent === 100 ? "ACTIVE" : "CANARY";
      }
      this.audit(state, `AGENT_ROLLOUT_${action.toUpperCase()}`, installationId, actor, {
        rolloutPercent: installation.rolloutPercent,
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
      return await this.store.mutate((state) => {
        state.credentials.set(credential.id, credential);
        this.audit(state, "CREDENTIAL_CREATED", credential.id, actor, { label, version: 1 });
        return credential;
      });
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
      return await this.store.mutate((state) => {
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
      });
    } catch (error) {
      await this.vault.revoke(replacement.secretRef).catch(() => undefined);
      throw error;
    }
  }

  async revokeCredential(credentialId: string, actor: RequestActor): Promise<CredentialVersionRecord> {
    const credential = await this.store.mutate((state) => {
      const value = state.credentials.get(credentialId);
      if (!value) throw new ServiceProblem(404, "CREDENTIAL_NOT_FOUND", "Credential version does not exist");
      assertCredentialActor(value, actor);
      if (value.state !== "REVOKED") {
        value.state = "REVOKED";
        this.audit(state, "CREDENTIAL_REVOKED", value.id, actor, { newTokensIssued: false });
      }
      return structuredClone(value);
    });
    await this.vault.revoke(credential.secretRef);
    return credential;
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
    const budget = parseBudget(body);
    const fallbackProfileRevisionId = optionalString(body, "fallbackProfileRevisionId") ?? null;
    return this.store.mutate((state) => {
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
        models,
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
      return this.store.mutate((state) => {
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
    return this.store.mutate((state) => {
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
    return this.store.mutate((state) => {
      const profile = state.profiles.get(profileRevisionId);
      if (!profile || profile.state !== "ACTIVE") {
        throw new ServiceProblem(409, "PROFILE_NOT_ACTIVE", "Defaults can only reference an active immutable Profile revision");
      }
      if (profile.scope !== parsed.scope || (parsed.scope !== "platform" && profile.scopeId !== parsed.scopeId)) {
        throw new ServiceProblem(409, "PROFILE_SCOPE_MISMATCH", "Profile revision does not belong to the requested default scope");
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
    return this.store.read((state) => {
      const installations = [...state.installations.values()];
      return {
        status: installations.some((item) => ["FAILED", "QUARANTINED"].includes(item.state)) ? "DEGRADED" : "HEALTHY",
        installations,
        providers: [...state.providers.values()].map(({ id, state: providerState, probe }) => ({ id, state: providerState, probe })),
        isolation: { developmentWorkers: true, e2eRunnersContainAgent: false, steamPublishersContainAgent: false },
        checkedAt: new Date().toISOString(),
      };
    });
  }

  async auditLog(actor: RequestActor): Promise<readonly AuditRecord[]> {
    return this.store.read((state) => Object.freeze(state.audit.filter((record) => auditVisibleTo(record, actor))));
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
Injectable()(AdminService);

function assertExactVersion(value: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) || /latest|stable|default/i.test(value)) {
    throw new ServiceProblem(400, "FLOATING_VERSION_REJECTED", "Agent and adapter versions must be exact SemVer values");
  }
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

function parseDefaultScope(value: string): { scope: ProfileScope; scopeId: string } {
  if (value === "platform") return { scope: "platform", scopeId: "global" };
  const match = /^(tenant|project):([a-z0-9][a-z0-9_-]{0,159})$/i.exec(value);
  if (!match) throw new ServiceProblem(400, "INVALID_SCOPE", "Default scope must be platform, tenant:<id>, or project:<id>");
  return { scope: match[1] as "tenant" | "project", scopeId: match[2] ?? "" };
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

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
