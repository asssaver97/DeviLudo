import { isExactAdapterCompatibility } from "../../../lib/agent/adapter-registry";
import { assertPinnedModelId } from "../../../lib/agent/providers";
import { validateProviderBaseUrl } from "../../../lib/security/network";
import {
  parseAgentInstallationFleetHealth,
  parseAgentInstallationRuntimeBinding,
} from "../../../lib/agent/installation-runtime";
import { PROVIDER_REQUIRED_CHECKS } from "./provider-probe";
import type { AdminCatalogState } from "./admin.store";
import type {
  AgentVersionRecord,
  CredentialVersionRecord,
  InstallationRecord,
  ProfileRevisionRecord,
  ProviderRevisionRecord,
} from "./contracts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VERSION_STATES = new Set(["DISCOVERED", "VALIDATING", "APPROVED", "DEPRECATED", "BLOCKED", "REJECTED"]);
const INSTALLATION_STATES = new Set([
  "BUILDING", "SCANNING", "SMOKE_TESTING", "READY", "CANARY", "ACTIVE", "DRAINING", "RETIRED", "FAILED", "QUARANTINED",
]);
const PROFILE_STATES = new Set(["DRAFT", "VALIDATING", "READY", "ACTIVE", "SUPERSEDED", "DEGRADED", "DISABLED"]);
const INSTALLATION_HEALTH = new Set(["HEALTHY", "DEGRADED", "UNHEALTHY"]);
const ROLLOUT_PERCENTAGES = new Set([0, 5, 25, 100]);

const VERSION_FIELDS = Object.freeze([
  "adapterCompatibility", "agent", "catalogReceiptDigest", "catalogReceiptId", "discoveredAt", "id", "integrity",
  "releaseNotesUrl", "sbomRef", "scan", "signatureVerified", "source", "sourceDigest", "state",
  "supplyChainEvidenceDigest", "validatedAdapterVersion", "validatedAt", "validationReceiptDigest", "validationReceiptId", "version",
]);
const INSTALLATION_FIELDS = Object.freeze([
  "activatedAt", "adapterVersion", "agent", "agentVersionId", "buildReceiptDigest", "buildReceiptId", "createdAt", "drainingAt",
  "failure", "fleetHealth", "health", "id", "imageDigest", "previousRolloutPercent", "retiredAt", "rollbackInstallationId",
  "rolloutPercent", "runtimeBinding", "selfUpdateDisabled", "state", "workerImageId", "workerPool",
]);
const PROVIDER_FIELDS = Object.freeze([
  "agent", "approvedPorts", "authentication", "baseUrl", "credentialVersionId", "governance", "id", "models", "pricing",
  "probe", "protocol", "revision", "state",
]);
const PROFILE_FIELDS = Object.freeze([
  "agent", "budget", "createdAt", "credentialVersionId", "fallbackProfileRevisionId", "id", "installationId",
  "providerRevisionId", "revision", "scope", "scopeId", "state",
]);
const CREDENTIAL_FIELDS = Object.freeze([
  "createdAt", "familyId", "id", "label", "lastUsedAt", "maskedFingerprint", "rotatedAt", "rotation", "scope", "scopeId",
  "secretRef", "state", "version",
]);

/** Rejects untyped or secret-smuggling fields before a catalog record can be projected to an administrator. */
export function assertAdminCatalogSchema(state: AdminCatalogState): void {
  for (const [key, record] of state.versions) {
    recordKey(key, record.id, "Agent version");
    exactFields(record, VERSION_FIELDS, "Agent version");
    versionRecord(record);
  }
  for (const [key, record] of state.installations) {
    recordKey(key, record.id, "Agent installation");
    exactFields(record, INSTALLATION_FIELDS, "Agent installation", new Set(["failure"]));
    installationRecord(record);
  }
  for (const [key, record] of state.providers) {
    recordKey(key, record.id, "Provider revision");
    exactFields(record, PROVIDER_FIELDS, "Provider revision");
    providerRecord(record);
  }
  for (const [key, record] of state.profiles) {
    recordKey(key, record.id, "Profile revision");
    exactFields(record, PROFILE_FIELDS, "Profile revision");
    profileRecord(record);
  }
  for (const [key, record] of state.credentials) {
    recordKey(key, record.id, "Credential version");
    exactFields(record, CREDENTIAL_FIELDS, "Credential version", new Set(["rotation"]));
    credentialRecord(record);
  }
  if (state.defaults.size > 300_000) invalid("Agent default catalog exceeds its bound");
  for (const [scope, profileId] of state.defaults) {
    if (scope !== "platform" && !/^(tenant|project):[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(scope)) invalid("Agent default scope is invalid");
    safeId(profileId, "Agent default Profile");
  }
}

/**
 * Proves every cross-record edge and scope boundary. PostgreSQL callers pass
 * authoritative project→tenant bindings; local fixtures may derive them from
 * the already-authorized Profile credential binding.
 */
export function assertAdminCatalogReferences(
  state: AdminCatalogState,
  projectTenants: ReadonlyMap<string, string> = new Map(),
  requireProjectBindings = false,
): void {
  assertAdminCatalogSchema(state);
  for (const installation of state.installations.values()) {
    const version = state.versions.get(installation.agentVersionId);
    if (!version || version.agent !== installation.agent) invalid("Agent installation version binding is invalid");
    if (installation.runtimeBinding && installation.runtimeBinding.exactAgentVersion !== version.version) {
      invalid("Agent installation runtime version binding is invalid");
    }
    if (installation.rollbackInstallationId) {
      const rollback = state.installations.get(installation.rollbackInstallationId);
      if (!rollback || rollback.id === installation.id || rollback.agent !== installation.agent
        || rollback.workerPool !== installation.workerPool) invalid("Agent installation rollback binding is invalid");
    }
  }
  for (const provider of state.providers.values()) {
    const credential = state.credentials.get(provider.credentialVersionId);
    if (!credential) invalid("Provider credential binding is invalid");
    if (["READY", "ACTIVE", "SUPERSEDED"].includes(provider.state)
      && (Object.keys(provider.probe).length !== PROVIDER_REQUIRED_CHECKS.length
        || PROVIDER_REQUIRED_CHECKS.some((key) => provider.probe[key] !== "PASS"))) {
      invalid("Serving Provider probe receipt is incomplete");
    }
  }
  for (const profile of state.profiles.values()) {
    const installation = state.installations.get(profile.installationId);
    const provider = state.providers.get(profile.providerRevisionId);
    const credential = state.credentials.get(profile.credentialVersionId);
    if (!installation || !provider || !credential || installation.agent !== profile.agent || provider.agent !== profile.agent
      || provider.credentialVersionId !== profile.credentialVersionId) invalid("Profile authority binding is invalid");
    assertCredentialScope(profile, credential, projectTenants, requireProjectBindings);
    if (profile.fallbackProfileRevisionId) {
      const fallback = state.profiles.get(profile.fallbackProfileRevisionId);
      if (!fallback || fallback.id === profile.id || fallback.agent !== profile.agent
        || fallback.scope !== profile.scope || fallback.scopeId !== profile.scopeId) invalid("Profile fallback binding is invalid");
    }
  }
  assertNoFallbackCycles(state.profiles);
  for (const [scope, profileId] of state.defaults) {
    const profile = state.profiles.get(profileId);
    if (!profile) invalid("Agent default references a missing Profile");
    assertDefaultScope(scope, profile, state, projectTenants, requireProjectBindings);
  }
  for (const credential of state.credentials.values()) {
    if (!credential.rotation) continue;
    const source = state.credentials.get(credential.rotation.sourceVersionId);
    if (!source || source.familyId !== credential.familyId || source.version + 1 !== credential.version
      || source.scope !== credential.scope || source.scopeId !== credential.scopeId
      || source.maskedFingerprint === credential.maskedFingerprint) {
      invalid("Credential rotation source binding is invalid");
    }
    const sourceProfiles = new Set<string>();
    const successorProfiles = new Set<string>();
    const successorBySource = new Map(credential.rotation.bindings.map((binding) =>
      [binding.sourceProfileId, binding.successorProfileId]));
    for (const binding of credential.rotation.bindings) {
      if (sourceProfiles.has(binding.sourceProfileId) || successorProfiles.has(binding.successorProfileId)
        || !assertRotationBinding(state, source, credential, binding, successorBySource)) {
        invalid("Credential rotation Profile binding is invalid");
      }
      sourceProfiles.add(binding.sourceProfileId); successorProfiles.add(binding.successorProfileId);
    }
  }
}

function assertRotationBinding(
  state: AdminCatalogState,
  sourceCredential: CredentialVersionRecord,
  successorCredential: CredentialVersionRecord,
  binding: NonNullable<CredentialVersionRecord["rotation"]>["bindings"][number],
  successorBySource: ReadonlyMap<string, string>,
): boolean {
  const source = state.profiles.get(binding.sourceProfileId);
  const successor = state.profiles.get(binding.successorProfileId);
  const sourceProvider = state.providers.get(binding.sourceProviderId);
  const successorProvider = state.providers.get(binding.successorProviderId);
  if (!source || !successor || !sourceProvider || !successorProvider
    || source.providerRevisionId !== sourceProvider.id || successor.providerRevisionId !== successorProvider.id
    || successor.revision !== source.revision + 1 || successor.scope !== source.scope || successor.scopeId !== source.scopeId
    || successor.agent !== source.agent || successor.installationId !== source.installationId
    || !sameBudget(successor.budget, source.budget)
    || successor.fallbackProfileRevisionId !== (source.fallbackProfileRevisionId
      ? successorBySource.get(source.fallbackProfileRevisionId) ?? source.fallbackProfileRevisionId
      : null)) return false;
  if (!binding.usesReplacement) {
    return successorProvider.id === sourceProvider.id
      && successor.credentialVersionId === source.credentialVersionId;
  }
  return source.credentialVersionId === sourceCredential.id
    && successor.credentialVersionId === successorCredential.id
    && sourceProvider.credentialVersionId === sourceCredential.id
    && successorProvider.credentialVersionId === successorCredential.id
    && successorProvider.revision === sourceProvider.revision + 1
    && sameProviderConfiguration(successorProvider, sourceProvider);
}

function sameBudget(left: ProfileRevisionRecord["budget"], right: ProfileRevisionRecord["budget"]): boolean {
  return left.maxUsd === right.maxUsd && left.maxTurns === right.maxTurns && left.timeoutSeconds === right.timeoutSeconds;
}

function sameProviderConfiguration(left: ProviderRevisionRecord, right: ProviderRevisionRecord): boolean {
  return left.agent === right.agent && left.protocol === right.protocol && left.baseUrl === right.baseUrl
    && left.authentication === right.authentication
    && left.approvedPorts.length === right.approvedPorts.length
    && left.approvedPorts.every((port, index) => port === right.approvedPorts[index])
    && left.models.primaryModel === right.models.primaryModel && left.models.planningModel === right.models.planningModel
    && left.models.smallFastModel === right.models.smallFastModel && left.models.subagentModel === right.models.subagentModel
    && left.pricing.inputUsdPerMillionTokens === right.pricing.inputUsdPerMillionTokens
    && left.pricing.outputUsdPerMillionTokens === right.pricing.outputUsdPerMillionTokens
    && left.governance.dataRegion === right.governance.dataRegion
    && left.governance.retentionPolicy === right.governance.retentionPolicy
    && left.governance.trainingPolicy === right.governance.trainingPolicy
    && left.governance.confirmedBy === right.governance.confirmedBy
    && left.governance.confirmedAt === right.governance.confirmedAt;
}

function versionRecord(record: AgentVersionRecord): void {
  safeId(record.id, "Agent version ID"); agent(record.agent); exactVersion(record.version);
  if (record.id !== `${record.agent}@${record.version}` || !VERSION_STATES.has(record.state)) invalid("Agent version identity is invalid");
  httpsUrl(record.source, "Agent version source"); httpsUrl(record.releaseNotesUrl, "Agent release notes");
  digest(record.sourceDigest, "Agent source digest"); digest(record.catalogReceiptDigest, "Agent catalog receipt digest");
  safeId(record.catalogReceiptId, "Agent catalog receipt ID"); timestamp(record.discoveredAt, "Agent discovery time");
  if (!/^sha256:[a-f0-9]{64}$/.test(record.integrity) || typeof record.signatureVerified !== "boolean"
    || !new Set(["PASS", "FAIL", "PENDING"]).has(record.scan) || typeof record.sbomRef !== "string"
    || record.sbomRef.length < 4 || record.sbomRef.length > 2_000) invalid("Agent version supply-chain metadata is invalid");
  const receiptValues = [record.validationReceiptId, record.validationReceiptDigest, record.supplyChainEvidenceDigest, record.validatedAt];
  const adapterValues = [record.validatedAdapterVersion, record.adapterCompatibility];
  if (receiptValues.every((value) => value === null) && adapterValues.every((value) => value === null)) return;
  if (record.validationReceiptId === null || record.validationReceiptDigest === null || record.supplyChainEvidenceDigest === null
    || record.validatedAt === null
    || (adapterValues.some((value) => value === null) && adapterValues.some((value) => value !== null))) {
    invalid("Agent version validation binding is incomplete");
  }
  safeId(record.validationReceiptId, "Agent validation receipt ID");
  digest(record.validationReceiptDigest, "Agent validation receipt digest");
  digest(record.supplyChainEvidenceDigest, "Agent supply-chain evidence digest");
  timestamp(record.validatedAt, "Agent validation time");
  if (record.validatedAdapterVersion !== null && record.adapterCompatibility !== null) {
    exactVersion(record.validatedAdapterVersion);
    exactFields(record.adapterCompatibility, ["maxExclusive", "min"], "Agent Adapter compatibility");
    if (!isExactAdapterCompatibility(record.validatedAdapterVersion, record.adapterCompatibility)) {
      invalid("Agent Adapter compatibility binding is invalid");
    }
  }
}

function installationRecord(record: InstallationRecord): void {
  safeId(record.id, "Agent installation ID"); agent(record.agent); safeId(record.agentVersionId, "Agent version binding");
  if (!/^dev(?:elopment)?[-_a-z0-9]*$/i.test(record.workerPool) || record.workerPool.length > 120
    || !EXACT_SEMVER.test(record.adapterVersion) || !INSTALLATION_STATES.has(record.state)
    || !INSTALLATION_HEALTH.has(record.health) || !ROLLOUT_PERCENTAGES.has(record.rolloutPercent)
    || !ROLLOUT_PERCENTAGES.has(record.previousRolloutPercent) || record.selfUpdateDisabled !== true) {
    invalid("Agent installation lifecycle is invalid");
  }
  timestamp(record.createdAt, "Agent installation creation time");
  nullableTimestamp(record.activatedAt, "Agent installation activation time");
  nullableTimestamp(record.drainingAt, "Agent installation draining time");
  nullableTimestamp(record.retiredAt, "Agent installation retirement time");
  nullableSafeId(record.rollbackInstallationId, "Agent rollback installation");
  const build = [record.imageDigest, record.workerImageId, record.buildReceiptId, record.buildReceiptDigest];
  const runtime = [record.runtimeBinding, record.fleetHealth];
  const hasBuild = !build.every((value) => value === null);
  const hasRuntime = !runtime.every((value) => value === null);
  if (hasBuild !== build.every((value) => value !== null)
    || hasRuntime !== runtime.every((value) => value !== null) || hasRuntime && !hasBuild) {
    invalid("Agent WorkerImage/runtime binding is incomplete");
  }
  if ((!hasBuild || !hasRuntime) && ["READY", "CANARY", "ACTIVE", "DRAINING", "RETIRED"].includes(record.state)) {
    invalid("Serving Agent installation lacks a microVM runtime deployment proof");
  }
  if (hasBuild) {
    if (record.imageDigest === null || record.workerImageId === null || record.buildReceiptId === null || record.buildReceiptDigest === null
      || !IMAGE_DIGEST.test(record.imageDigest)) invalid("Agent WorkerImage binding is incomplete");
    safeId(record.workerImageId, "WorkerImage ID"); safeId(record.buildReceiptId, "WorkerImage build receipt ID");
    digest(record.buildReceiptDigest, "WorkerImage build receipt digest");
  }
  if (hasRuntime) {
    if (!record.runtimeBinding || !record.fleetHealth || !record.imageDigest) invalid("Agent microVM runtime deployment proof is incomplete");
    try {
      parseAgentInstallationRuntimeBinding(record.runtimeBinding, {
        installationId: record.id,
        workerPool: record.workerPool,
        agent: record.agent,
        adapterVersion: record.adapterVersion,
        workerImageDigest: record.imageDigest,
      });
      parseAgentInstallationFleetHealth(record.fleetHealth, { requireReadyWorker: record.state === "ACTIVE" });
    } catch { invalid("Agent microVM runtime deployment proof is invalid"); }
  }
  if (record.failure) {
    exactFields(record.failure, ["evidenceDigest", "failedAt", "failureCode", "failureReceiptDigest", "failureReceiptId"], "Agent installation failure");
    safeId(record.failure.failureCode, "Agent failure code"); safeId(record.failure.failureReceiptId, "Agent failure receipt ID");
    digest(record.failure.evidenceDigest, "Agent failure evidence digest");
    digest(record.failure.failureReceiptDigest, "Agent failure receipt digest"); timestamp(record.failure.failedAt, "Agent failure time");
  }
}

function providerRecord(record: ProviderRevisionRecord): void {
  safeId(record.id, "Provider ID"); positiveInteger(record.revision, "Provider revision"); agent(record.agent);
  if (!PROFILE_STATES.has(record.state) || (record.agent === "codex-cli" && record.protocol !== "openai-responses")
    || (record.agent === "claude-code" && record.protocol !== "anthropic-messages")
    || (record.agent === "codex-cli" && record.authentication !== "bearer")
    || (record.agent === "claude-code" && !new Set(["x-api-key", "authorization-bearer"]).has(record.authentication))) {
    invalid("Provider protocol binding is invalid");
  }
  safeId(record.credentialVersionId, "Provider credential ID");
  if (!Array.isArray(record.approvedPorts) || record.approvedPorts.length < 1 || record.approvedPorts.length > 16
    || record.approvedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
    || new Set(record.approvedPorts).size !== record.approvedPorts.length
    || JSON.stringify([...record.approvedPorts].sort((left, right) => left - right)) !== JSON.stringify(record.approvedPorts)) {
    invalid("Provider approved ports are invalid");
  }
  try { validateProviderBaseUrl(record.baseUrl, { approvedPorts: record.approvedPorts }); }
  catch { invalid("Provider Base URL is invalid"); }
  if (new URL(record.baseUrl).toString() !== record.baseUrl) invalid("Provider Base URL is not canonical");
  exactFields(record.models, ["planningModel", "primaryModel", "smallFastModel", "subagentModel"], "Provider model roles");
  for (const model of Object.values(record.models)) { try { assertPinnedModelId(model); } catch { invalid("Provider model role is invalid"); } }
  exactFields(record.pricing, ["inputUsdPerMillionTokens", "outputUsdPerMillionTokens"], "Provider pricing");
  for (const price of Object.values(record.pricing)) if (!Number.isFinite(price) || price < 0 || price > 1_000_000) invalid("Provider pricing is invalid");
  exactFields(record.governance, ["confirmedAt", "confirmedBy", "dataRegion", "retentionPolicy", "trainingPolicy"], "Provider governance");
  for (const [key, value] of Object.entries(record.governance)) {
    if (key === "confirmedAt") timestamp(value, "Provider governance confirmation time");
    else boundedText(value, `Provider governance ${key}`, 1, 500);
  }
  if (!record.probe || typeof record.probe !== "object" || Array.isArray(record.probe)
    || Object.keys(record.probe).some((key) => !(PROVIDER_REQUIRED_CHECKS as readonly string[]).includes(key))
    || Object.values(record.probe).some((value) => value !== "PASS" && value !== "FAIL")) invalid("Provider probe receipt is invalid");
}

function profileRecord(record: ProfileRevisionRecord): void {
  safeId(record.id, "Profile ID"); positiveInteger(record.revision, "Profile revision"); agent(record.agent);
  if (!PROFILE_STATES.has(record.state) || !new Set(["platform", "tenant", "project"]).has(record.scope)) invalid("Profile lifecycle is invalid");
  if ((record.scope === "platform" && record.scopeId !== "global")
    || (record.scope !== "platform" && !SAFE_ID.test(record.scopeId))) invalid("Profile scope is invalid");
  safeId(record.installationId, "Profile installation ID"); safeId(record.providerRevisionId, "Profile Provider ID");
  safeId(record.credentialVersionId, "Profile credential ID"); nullableSafeId(record.fallbackProfileRevisionId, "Profile fallback ID");
  exactFields(record.budget, ["maxTurns", "maxUsd", "timeoutSeconds"], "Profile budget");
  if (!Number.isFinite(record.budget.maxUsd) || record.budget.maxUsd < 0 || record.budget.maxUsd > 100
    || !Number.isInteger(record.budget.maxTurns) || record.budget.maxTurns < 1 || record.budget.maxTurns > 200
    || !Number.isInteger(record.budget.timeoutSeconds) || record.budget.timeoutSeconds < 60 || record.budget.timeoutSeconds > 14_400) {
    invalid("Profile budget is invalid");
  }
  timestamp(record.createdAt, "Profile creation time");
}

function credentialRecord(record: CredentialVersionRecord): void {
  safeId(record.id, "Credential ID"); safeId(record.familyId, "Credential family ID"); positiveInteger(record.version, "Credential version");
  boundedText(record.label, "Credential label", 1, 120);
  if (!new Set(["platform", "tenant"]).has(record.scope)
    || (record.scope === "platform" && record.scopeId !== "global")
    || (record.scope === "tenant" && !SAFE_ID.test(record.scopeId))
    || !new Set(["ACTIVE", "PREVIOUS", "REVOKED"]).has(record.state)
    || !/^sha256:[A-Za-z0-9]{8}…[A-Za-z0-9]{6}$/.test(record.maskedFingerprint)) invalid("Credential metadata is invalid");
  let secretRef: URL;
  try { secretRef = new URL(record.secretRef); } catch { invalid("Credential SecretRef is invalid"); }
  if (secretRef.protocol !== "vault:" || secretRef.username || secretRef.password || secretRef.hash
    || record.secretRef.length > 2_000) invalid("Credential SecretRef is invalid");
  timestamp(record.createdAt, "Credential creation time"); nullableTimestamp(record.rotatedAt, "Credential rotation time");
  nullableTimestamp(record.lastUsedAt, "Credential last-used time");
  if (!record.rotation) return;
  exactFields(record.rotation, ["bindings", "operationKey", "sourceVersionId"], "Credential rotation");
  digest(record.rotation.operationKey, "Credential rotation operation"); safeId(record.rotation.sourceVersionId, "Credential rotation source");
  if (!Array.isArray(record.rotation.bindings) || record.rotation.bindings.length > 100_000) invalid("Credential rotation bindings are invalid");
  for (const binding of record.rotation.bindings) {
    exactFields(binding, ["sourceProfileId", "sourceProviderId", "successorProfileId", "successorProviderId", "usesReplacement"], "Credential rotation binding");
    safeId(binding.sourceProfileId, "Credential source Profile"); safeId(binding.successorProfileId, "Credential successor Profile");
    safeId(binding.sourceProviderId, "Credential source Provider"); safeId(binding.successorProviderId, "Credential successor Provider");
    if (typeof binding.usesReplacement !== "boolean") invalid("Credential rotation binding is invalid");
  }
}

function assertCredentialScope(profile: ProfileRevisionRecord, credential: CredentialVersionRecord,
  projectTenants: ReadonlyMap<string, string>, requireProjectBindings: boolean): void {
  if (profile.scope === "platform") {
    if (credential.scope !== "platform" || credential.scopeId !== "global") invalid("Platform Profile credential scope is invalid");
    return;
  }
  if (profile.scope === "tenant") {
    if (credential.scope !== "tenant" || credential.scopeId !== profile.scopeId) invalid("Tenant Profile credential scope is invalid");
    return;
  }
  const tenantId = projectTenants.get(profile.scopeId);
  if (requireProjectBindings && !tenantId) invalid("Project Profile tenant binding is unavailable");
  if (credential.scope !== "tenant" || (tenantId && credential.scopeId !== tenantId)) invalid("Project Profile credential scope is invalid");
}

function assertDefaultScope(scope: string, profile: ProfileRevisionRecord, state: AdminCatalogState,
  projectTenants: ReadonlyMap<string, string>, requireProjectBindings: boolean): void {
  if (scope === "platform") {
    if (profile.scope !== "platform" || profile.scopeId !== "global") invalid("Platform Agent default scope is invalid");
    return;
  }
  const [kind, id] = scope.split(":", 2) as ["tenant" | "project", string];
  if (kind === "tenant") {
    if (profile.scope !== "platform" && (profile.scope !== "tenant" || profile.scopeId !== id)) invalid("Tenant Agent default scope is invalid");
    return;
  }
  const authoritativeTenant = projectTenants.get(id);
  if (requireProjectBindings && !authoritativeTenant) invalid("Project Agent default tenant binding is unavailable");
  const derivedTenant = authoritativeTenant ?? (profile.scope === "tenant" ? profile.scopeId
    : profile.scope === "project" ? state.credentials.get(profile.credentialVersionId)?.scopeId : undefined);
  if ((profile.scope === "project" && profile.scopeId !== id)
    || (profile.scope === "tenant" && profile.scopeId !== derivedTenant)
    || (profile.scope === "project" && state.credentials.get(profile.credentialVersionId)?.scopeId !== derivedTenant)) {
    invalid("Project Agent default scope is invalid");
  }
}

function assertNoFallbackCycles(profiles: ReadonlyMap<string, ProfileRevisionRecord>): void {
  for (const profile of profiles.values()) {
    const visited = new Set<string>();
    let current: ProfileRevisionRecord | undefined = profile;
    while (current?.fallbackProfileRevisionId) {
      if (visited.has(current.id)) invalid("Profile fallback graph contains a cycle");
      visited.add(current.id);
      current = profiles.get(current.fallbackProfileRevisionId);
    }
  }
}

function exactFields(value: unknown, fields: readonly string[], label: string, optional: ReadonlySet<string> = new Set()): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const allowed = [...fields].sort();
  if (keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !optional.has(key) && !keys.includes(key))) {
    invalid(`${label} schema is invalid`);
  }
}
function recordKey(key: string, id: string, label: string): void { if (key !== id) invalid(`${label} map key is invalid`); }
function agent(value: unknown): asserts value is "claude-code" | "codex-cli" { if (value !== "claude-code" && value !== "codex-cli") invalid("Agent kind is invalid"); }
function safeId(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !SAFE_ID.test(value)) invalid(`${label} is invalid`); }
function nullableSafeId(value: unknown, label: string): void { if (value !== null) safeId(value, label); }
function exactVersion(value: unknown): asserts value is string { if (typeof value !== "string" || !EXACT_SEMVER.test(value) || /latest|stable|default/i.test(value)) invalid("Exact version is invalid"); }
function digest(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !SHA256.test(value)) invalid(`${label} is invalid`); }
function positiveInteger(value: unknown, label: string): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${label} is invalid`); }
function boundedText(value: unknown, label: string, minimum: number, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${label} is invalid`);
}
function timestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(`${label} is invalid`);
}
function nullableTimestamp(value: unknown, label: string): void { if (value !== null) timestamp(value, label); }
function httpsUrl(value: unknown, label: string): void {
  let url: URL; try { if (typeof value !== "string") invalid(`${label} is invalid`); url = new URL(value); }
  catch { invalid(`${label} is invalid`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || value.length > 2_000) invalid(`${label} is invalid`);
}
function invalid(message: string): never { throw new Error(`Administrator catalog integrity failed: ${message}`); }
