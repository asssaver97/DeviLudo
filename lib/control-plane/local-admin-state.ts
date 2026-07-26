import {
  getDemoStore,
  migrateDemoStoreState,
  restoreDemoStore,
  type DemoStoreState,
} from "./demo-store";
import { isExactAdapterCompatibility } from "../agent/adapter-registry";
import { assertPinnedModelId } from "../agent/providers";
import { validateProviderBaseUrl } from "../security/network";

const SNAPSHOT_SCHEMA = "deviludo.local-admin-state.v5";
const LEGACY_SNAPSHOT_SCHEMAS = new Set([
  "deviludo.local-admin-state.v1",
  "deviludo.local-admin-state.v2",
  "deviludo.local-admin-state.v3",
  "deviludo.local-admin-state.v4",
]);
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const COMMAND_KEY = /^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,511}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VERSION_STATES = new Set(["DISCOVERED", "VALIDATING", "APPROVED", "DEPRECATED", "BLOCKED", "REJECTED"]);
const INSTALLATION_STATES = new Set([
  "BUILDING", "SCANNING", "SMOKE_TESTING", "READY", "CANARY", "ACTIVE", "DRAINING", "RETIRED", "FAILED", "QUARANTINED",
]);
const INSTALLATION_HEALTH = new Set(["HEALTHY", "DEGRADED", "UNHEALTHY"]);
const PROVIDER_STATES = new Set(["DRAFT", "VALIDATING", "READY", "ACTIVE", "DISABLED"]);
const PROFILE_STATES = new Set(["DRAFT", "VALIDATING", "READY", "ACTIVE", "SUPERSEDED", "DEGRADED", "DISABLED"]);
const CREDENTIAL_STATES = new Set(["ACTIVE", "PREVIOUS", "REVOKED"]);
const ROLLOUT_PERCENTAGES = new Set([0, 5, 25, 100]);
const PROVIDER_REQUIRED_CHECKS = Object.freeze([
  "authentication", "modelExistence", "streaming", "toolCalling", "cancellation",
  "usage", "timeout", "minimalReasoning", "dnsPinning", "redirectRevalidation",
]);
const STORE_FIELDS = Object.freeze([
  "agentVersionMetadata", "agentVersions", "audit", "credentials", "defaults", "feedback", "idempotency",
  "installations", "invalidatedEvidence", "profiles", "providers", "resourceSequences", "rollouts", "specRevision",
  "specState", "usage",
]);
const VERSION_METADATA_FIELDS = Object.freeze([
  "adapterCompatibility", "discoveredAt", "integrity", "releaseNotesUrl", "sbomRef", "scan", "signatureVerified",
  "source", "sourceDigest", "supplyChainEvidenceDigest", "validatedAdapterVersion", "validatedAt",
  "validationReceiptDigest", "validationReceiptId",
]);
const INSTALLATION_FIELDS = Object.freeze([
  "activatedAt", "adapterVersion", "agent", "buildReceiptDigest", "buildReceiptId", "createdAt", "drainingAt", "health",
  "id", "imageDigest", "retiredAt", "rollbackInstallationId", "rolloutPercent", "state", "version", "workerPool",
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
  "createdAt", "familyId", "fingerprint", "id", "label", "masked", "rotatedAt", "scope", "scopeId", "secretRef", "state", "version",
]);
const FORBIDDEN_PERSISTED_KEYS = new Set([
  "apikey",
  "password",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "rawsecret",
]);

type SnapshotEnvelope = Readonly<{
  schemaVersion: typeof SNAPSHOT_SCHEMA;
  state: DemoStoreState;
}>;

type SnapshotRow = Readonly<{
  revision: number;
  schema_version: string;
  state_json: string;
}>;

export type LocalAdminStateLease = Readonly<{
  persistent: boolean;
  revision: number;
  persist(commandKey: string): Promise<void>;
  release(): void;
}>;

let bindingPromise: Promise<D1Database | null> | null = null;
const initializedDatabases = new WeakSet<object>();
let requestQueue: Promise<void> = Promise.resolve();

async function resolveDatabase(): Promise<D1Database | null> {
  bindingPromise ??= import("cloudflare:workers")
    .then(({ env }) => env.DB ?? null)
    .catch(() => null);
  return bindingPromise;
}

async function ensureStore(database: D1Database): Promise<void> {
  if (initializedDatabases.has(database)) return;
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS local_admin_state_revisions (
      revision INTEGER PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      command_key TEXT UNIQUE,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    database.prepare(`CREATE TRIGGER IF NOT EXISTS local_admin_state_no_update
      BEFORE UPDATE ON local_admin_state_revisions
      BEGIN SELECT RAISE(ABORT, 'local administrator state revisions are immutable'); END`),
    database.prepare(`CREATE TRIGGER IF NOT EXISTS local_admin_state_no_delete
      BEFORE DELETE ON local_admin_state_revisions
      BEGIN SELECT RAISE(ABORT, 'local administrator state revisions are immutable'); END`),
  ]);
  initializedDatabases.add(database);
}

async function latest(database: D1Database): Promise<SnapshotRow | null> {
  return database.prepare(`SELECT revision, schema_version, state_json
    FROM local_admin_state_revisions
    ORDER BY revision DESC LIMIT 1`).first<SnapshotRow>();
}

async function initialize(database: D1Database): Promise<SnapshotRow> {
  const stateJson = serializeLocalAdminState(getDemoStore());
  await database.prepare(`INSERT OR IGNORE INTO local_admin_state_revisions
    (revision, schema_version, command_key, state_json, created_at)
    VALUES (0, ?, NULL, ?, ?)`).bind(SNAPSHOT_SCHEMA, stateJson, new Date().toISOString()).run();
  const row = await latest(database);
  if (!row) throw new Error("无法初始化本地 Agent 管理状态");
  return row;
}

/**
 * Serializes only the non-secret local control-plane projection. API keys are
 * destroyed before the store is mutated and this boundary rejects dangerous
 * field names if a future change accidentally introduces one.
 */
export function serializeLocalAdminState(state: DemoStoreState): string {
  assertDemoStoreState(state);
  if (hasForbiddenPersistedKey(state)) throw new Error("本地 Agent 管理状态包含禁止持久化的敏感字段");
  const serialized = JSON.stringify({ schemaVersion: SNAPSHOT_SCHEMA, state } satisfies SnapshotEnvelope);
  if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("本地 Agent 管理状态超过持久化上限");
  }
  return serialized;
}

export function parseLocalAdminState(serialized: string, expectedSchemaVersion?: string): DemoStoreState {
  if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("本地 Agent 管理状态快照无效");
  }
  let envelope: unknown;
  try { envelope = JSON.parse(serialized); }
  catch { throw new Error("本地 Agent 管理状态快照无法解析"); }
  if (!record(envelope)
    || (envelope.schemaVersion !== SNAPSHOT_SCHEMA
      && (typeof envelope.schemaVersion !== "string" || !LEGACY_SNAPSHOT_SCHEMAS.has(envelope.schemaVersion)))
    || !record(envelope.state)) {
    throw new Error("本地 Agent 管理状态快照版本无效");
  }
  if (expectedSchemaVersion !== undefined && envelope.schemaVersion !== expectedSchemaVersion) {
    throw new Error("本地 Agent 管理状态快照列版本与正文不一致");
  }
  // Migration is intentionally legacy-only. Repairing a current revision here
  // would let a truncated or tampered v5 snapshot acquire invented fields and
  // silently become authoritative again.
  const state = envelope.schemaVersion === SNAPSHOT_SCHEMA
    ? structuredClone(envelope.state) as DemoStoreState
    : migrateDemoStoreState(envelope.state);
  assertDemoStoreState(state);
  if (hasForbiddenPersistedKey(state)) throw new Error("本地 Agent 管理状态包含禁止持久化的敏感字段");
  return state;
}

/**
 * Acquires one local request lease, refreshes the projection from the newest
 * immutable D1 revision, and provides a compare-and-swap append operation.
 * The process-local queue avoids interleaving while D1 protects against a
 * second isolate writing from the same base revision.
 */
export async function acquireLocalAdminState(
  options: Readonly<{ database?: D1Database | null }> = {},
): Promise<LocalAdminStateLease> {
  let unlock!: () => void;
  const previous = requestQueue;
  requestQueue = new Promise<void>((resolve) => { unlock = resolve; });
  await previous;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    unlock();
  };

  try {
    const database = Object.prototype.hasOwnProperty.call(options, "database")
      ? options.database ?? null
      : await resolveDatabase();
    if (!database) {
      return Object.freeze({
        persistent: false,
        revision: -1,
        async persist(commandKey: string) {
          if (!COMMAND_KEY.test(commandKey)) throw new Error("本地 Agent 管理命令键无效");
        },
        release,
      });
    }
    await ensureStore(database);
    const row = await latest(database) ?? await initialize(database);
    restoreDemoStore(parseLocalAdminState(row.state_json, row.schema_version));
    let revision = row.revision;
    let persisted = false;
    return Object.freeze({
      persistent: true,
      revision,
      async persist(commandKey: string) {
        if (released) throw new Error("本地 Agent 管理状态租约已经释放");
        if (persisted) throw new Error("一个本地 Agent 管理请求只能提交一次状态修订");
        if (!COMMAND_KEY.test(commandKey)) throw new Error("本地 Agent 管理命令键无效");
        const stateJson = serializeLocalAdminState(getDemoStore());
        const nextRevision = revision + 1;
        const result = await database.prepare(`INSERT INTO local_admin_state_revisions
          (revision, schema_version, command_key, state_json, created_at)
          SELECT ?, ?, ?, ?, ?
          WHERE (SELECT COALESCE(MAX(revision), -1) FROM local_admin_state_revisions) = ?`)
          .bind(nextRevision, SNAPSHOT_SCHEMA, commandKey, stateJson, new Date().toISOString(), revision)
          .run();
        if (result.meta.changes !== 1) {
          throw new Error("本地 Agent 管理状态已被并发更新，请重试");
        }
        revision = nextRevision;
        persisted = true;
      },
      release,
    });
  } catch (error) {
    release();
    throw error;
  }
}

function assertDemoStoreState(value: unknown): asserts value is DemoStoreState {
  if (!record(value)
    || !Number.isInteger(value.specRevision) || (value.specRevision as number) < 1
    || (value.specState !== "DRAFT" && value.specState !== "APPROVED")
    || !Array.isArray(value.feedback) || !Array.isArray(value.invalidatedEvidence)
    || !record(value.agentVersions) || !record(value.agentVersionMetadata)
    || !Array.isArray(value.installations) || !record(value.rollouts)
    || !Array.isArray(value.providers) || !Array.isArray(value.profiles)
    || !Array.isArray(value.credentials) || !record(value.defaults)
    || !Array.isArray(value.audit) || !Array.isArray(value.usage) || !record(value.idempotency)
    || !validResourceSequences(value.resourceSequences)) {
    throw new Error("本地 Agent 管理状态结构无效");
  }
  exactFields(value, STORE_FIELDS, "本地 Agent 管理状态结构");
  for (const evidenceId of value.invalidatedEvidence) {
    if (typeof evidenceId !== "string" || !SAFE_ID.test(evidenceId)) throw new Error("本地失效证据投影无效");
  }
  const versionIds = Object.keys(value.agentVersions);
  if (!sameStringSet(versionIds, Object.keys(value.agentVersionMetadata))) {
    throw new Error("本地 Agent 版本元数据引用无效");
  }
  for (const [id, state] of Object.entries(value.agentVersions)) {
    const identity = parseVersionId(id);
    if (!identity || typeof state !== "string" || !VERSION_STATES.has(state)) {
      throw new Error("本地 Agent 版本状态无效");
    }
    assertVersionMetadata(id, state, value.agentVersionMetadata[id]);
  }
  for (const feedback of value.feedback) {
    if (!record(feedback) || !exactFieldsMatch(feedback, ["at", "id", "projectId", "revision", "text"])
      || typeof feedback.projectId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(feedback.projectId)
      || typeof feedback.id !== "string" || !SAFE_ID.test(feedback.id)
      || typeof feedback.text !== "string" || feedback.text.length < 1 || feedback.text.length > 10_000
      || !Number.isInteger(feedback.revision) || (feedback.revision as number) < 1
      || !validTimestamp(feedback.at)) {
      throw new Error("本地项目反馈投影无效");
    }
  }
  assertUniqueIds(value.installations, "本地 Agent 安装状态");
  for (const installation of value.installations) {
    if (!record(installation) || !exactFieldsMatch(installation, INSTALLATION_FIELDS)
      || typeof installation.id !== "string" || !SAFE_ID.test(installation.id)
      || (installation.agent !== "claude-code" && installation.agent !== "codex-cli")
      || typeof installation.version !== "string" || !exactVersion(installation.version)
      || typeof installation.workerPool !== "string" || !/^dev(?:elopment)?[-_a-z0-9]*$/i.test(installation.workerPool)
      || typeof installation.adapterVersion !== "string" || !EXACT_VERSION.test(installation.adapterVersion)
      || typeof installation.imageDigest !== "string" || !DIGEST.test(installation.imageDigest)
      || typeof installation.buildReceiptId !== "string" || !SAFE_ID.test(installation.buildReceiptId)
      || typeof installation.buildReceiptDigest !== "string" || !DIGEST.test(installation.buildReceiptDigest)
      || typeof installation.state !== "string" || !INSTALLATION_STATES.has(installation.state)
      || typeof installation.health !== "string" || !INSTALLATION_HEALTH.has(installation.health)
      || typeof installation.rolloutPercent !== "number" || !ROLLOUT_PERCENTAGES.has(installation.rolloutPercent)
      || (installation.rollbackInstallationId !== null
        && (typeof installation.rollbackInstallationId !== "string" || !SAFE_ID.test(installation.rollbackInstallationId)))
      || !validTimestamp(installation.createdAt) || !validNullableTimestamp(installation.activatedAt)
      || !validNullableTimestamp(installation.drainingAt) || !validNullableTimestamp(installation.retiredAt)) {
      throw new Error("本地 Agent 安装状态无效");
    }
    const versionId = `${installation.agent}@${installation.version}`;
    if (!Object.prototype.hasOwnProperty.call(value.agentVersions, versionId)) {
      throw new Error("本地 Agent 安装版本引用无效");
    }
  }
  const validatedState = value as unknown as DemoStoreState;
  assertInstallationReferences(validatedState);
  assertUniqueIds(value.credentials, "本地 Agent 凭据投影");
  for (const credential of value.credentials) {
    if (!record(credential) || !exactFieldsMatch(credential, CREDENTIAL_FIELDS)
      || typeof credential.id !== "string" || !SAFE_ID.test(credential.id)
      || typeof credential.familyId !== "string" || !SAFE_ID.test(credential.familyId)
      || typeof credential.label !== "string" || credential.label.trim() !== credential.label
      || credential.label.length < 1 || credential.label.length > 120
      || typeof credential.secretRef !== "string"
      || !validCredentialSecretRef(credential) || typeof credential.fingerprint !== "string"
      || !DIGEST.test(credential.fingerprint) || typeof credential.masked !== "string"
      || credential.masked.length < 8 || credential.masked.length > 200
      || !Number.isSafeInteger(credential.version) || Number(credential.version) < 1
      || typeof credential.state !== "string" || !CREDENTIAL_STATES.has(credential.state)
      || (credential.scope !== "platform" && credential.scope !== "tenant")
      || typeof credential.scopeId !== "string" || !credential.scopeId || !SCOPE_ID.test(credential.scopeId)
      || (credential.scope === "platform" && credential.scopeId !== "global")
      || !validTimestamp(credential.createdAt) || !validNullableTimestamp(credential.rotatedAt)) {
      throw new Error("本地 Agent 凭据投影无效");
    }
  }
  assertUniqueIds(value.providers, "本地 Agent Provider 投影");
  for (const provider of value.providers) {
    if (!record(provider) || !exactFieldsMatch(provider, PROVIDER_FIELDS)
      || typeof provider.id !== "string" || !SAFE_ID.test(provider.id)
      || !Number.isSafeInteger(provider.revision) || Number(provider.revision) < 1
      || (provider.agent !== "claude-code" && provider.agent !== "codex-cli")
      || (provider.protocol !== "anthropic-messages" && provider.protocol !== "openai-responses")
      || !record(provider.models) || !record(provider.pricing) || !record(provider.governance)
      || !Array.isArray(provider.approvedPorts)
      || typeof provider.credentialVersionId !== "string" || !SAFE_ID.test(provider.credentialVersionId)
      || typeof provider.state !== "string" || !PROVIDER_STATES.has(provider.state)) {
      throw new Error("本地 Agent Provider 投影无效");
    }
    if ((provider.agent === "claude-code" && (provider.protocol !== "anthropic-messages"
      || (provider.authentication !== "x-api-key" && provider.authentication !== "authorization-bearer")))
      || (provider.agent === "codex-cli" && (provider.protocol !== "openai-responses" || provider.authentication !== "bearer"))) {
      throw new Error("本地 Agent Provider 协议绑定无效");
    }
    const approvedPorts = provider.approvedPorts as unknown[];
    if (approvedPorts.length < 1 || approvedPorts.length > 16
      || approvedPorts.some((port) => typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)
      || new Set(approvedPorts).size !== approvedPorts.length
      || approvedPorts.some((port, index) => index > 0 && Number(approvedPorts[index - 1]) >= Number(port))) {
      throw new Error("本地 Agent Provider 端口策略无效");
    }
    try {
      validateProviderBaseUrl(provider.baseUrl as string, { approvedPorts: provider.approvedPorts as number[] });
      if (new URL(provider.baseUrl as string).toString() !== provider.baseUrl) throw new Error("not canonical");
    } catch { throw new Error("本地 Agent Provider Base URL 无效"); }
    exactFields(provider.models, ["planningModel", "primaryModel", "smallFastModel", "subagentModel"], "本地 Agent Provider 模型角色");
    for (const role of ["primaryModel", "planningModel", "smallFastModel", "subagentModel"] as const) {
      if (typeof provider.models[role] !== "string" || !provider.models[role]) {
        throw new Error("本地 Agent Provider 模型角色无效");
      }
      try { assertPinnedModelId(provider.models[role] as string); }
      catch { throw new Error("本地 Agent Provider 模型角色无效"); }
    }
    exactFields(provider.pricing, ["inputUsdPerMillionTokens", "outputUsdPerMillionTokens"], "本地 Agent Provider 计价");
    if (Object.values(provider.pricing).some((price) => typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 1_000_000)) {
      throw new Error("本地 Agent Provider 计价无效");
    }
    exactFields(provider.governance, ["confirmedAt", "confirmedBy", "dataRegion", "retentionPolicy", "trainingPolicy"], "本地 Agent Provider 治理");
    for (const key of ["dataRegion", "retentionPolicy", "trainingPolicy"] as const) {
      const text = provider.governance[key];
      if (typeof text !== "string" || text.trim() !== text || text.length < 1 || text.length > 500) {
        throw new Error("本地 Agent Provider 治理信息无效");
      }
    }
    if ((provider.governance.confirmedBy === null) !== (provider.governance.confirmedAt === null)
      || (provider.governance.confirmedBy !== null
        && (typeof provider.governance.confirmedBy !== "string" || !SAFE_ID.test(provider.governance.confirmedBy)))
      || !validNullableTimestamp(provider.governance.confirmedAt)) {
      throw new Error("本地 Agent Provider 治理确认无效");
    }
    if (!validProviderProbe(provider.probe, provider.state as string)) throw new Error("本地 Agent Provider 探针无效");
  }
  assertUniqueIds(value.profiles, "本地 Agent Profile 投影");
  for (const profile of value.profiles) {
    if (!record(profile) || !exactFieldsMatch(profile, PROFILE_FIELDS)
      || typeof profile.id !== "string" || !SAFE_ID.test(profile.id)
      || !Number.isSafeInteger(profile.revision) || Number(profile.revision) < 1
      || (profile.agent !== "claude-code" && profile.agent !== "codex-cli")
      || (profile.scope !== "platform" && profile.scope !== "tenant" && profile.scope !== "project")
      || typeof profile.scopeId !== "string" || !SCOPE_ID.test(profile.scopeId)
      || (profile.scope === "platform" && profile.scopeId !== "global")
      || typeof profile.providerRevisionId !== "string" || !SAFE_ID.test(profile.providerRevisionId)
      || typeof profile.installationId !== "string" || !SAFE_ID.test(profile.installationId)
      || typeof profile.credentialVersionId !== "string" || !SAFE_ID.test(profile.credentialVersionId)
      || typeof profile.state !== "string" || !PROFILE_STATES.has(profile.state)
      || (profile.fallbackProfileRevisionId !== null
        && (typeof profile.fallbackProfileRevisionId !== "string" || !SAFE_ID.test(profile.fallbackProfileRevisionId)))
      || !record(profile.budget) || !exactFieldsMatch(profile.budget, ["maxTurns", "maxUsd", "timeoutSeconds"])
      || typeof profile.budget.maxUsd !== "number" || !Number.isFinite(profile.budget.maxUsd)
      || profile.budget.maxUsd <= 0 || profile.budget.maxUsd > 100
      || !Number.isSafeInteger(profile.budget.maxTurns) || Number(profile.budget.maxTurns) < 1 || Number(profile.budget.maxTurns) > 200
      || !Number.isSafeInteger(profile.budget.timeoutSeconds) || Number(profile.budget.timeoutSeconds) < 60
      || Number(profile.budget.timeoutSeconds) > 14_400 || !validTimestamp(profile.createdAt)) {
      throw new Error("本地 Agent Profile 投影无效");
    }
  }
  assertProfileReferences(validatedState);
  assertDefaults(validatedState);
  assertAudit(value.audit);
  assertUsage(value.usage);
}

function assertVersionMetadata(id: string, state: string, metadata: unknown): void {
  if (!record(metadata) || !exactFieldsMatch(metadata, VERSION_METADATA_FIELDS)
    || typeof metadata.source !== "string" || !validHttpsUrl(metadata.source)
    || typeof metadata.releaseNotesUrl !== "string" || !validHttpsUrl(metadata.releaseNotesUrl)
    || typeof metadata.sourceDigest !== "string" || !DIGEST.test(metadata.sourceDigest)
    || !validTimestamp(metadata.discoveredAt) || typeof metadata.signatureVerified !== "boolean"
    || (metadata.integrity !== null && (typeof metadata.integrity !== "string" || !DIGEST.test(metadata.integrity)))
    || (metadata.sbomRef !== null && (typeof metadata.sbomRef !== "string" || metadata.sbomRef.length < 4 || metadata.sbomRef.length > 2_000))
    || (metadata.scan !== "PASS" && metadata.scan !== "FAIL" && metadata.scan !== "PENDING")) {
    throw new Error(`本地 Agent 版本元数据无效: ${id}`);
  }
  const receipt = [metadata.validationReceiptId, metadata.validationReceiptDigest, metadata.supplyChainEvidenceDigest, metadata.validatedAt];
  if (!receipt.every((item) => item === null) && !receipt.every((item) => item !== null)) {
    throw new Error(`本地 Agent 版本验证回执不完整: ${id}`);
  }
  if (metadata.validationReceiptId !== null
    && (typeof metadata.validationReceiptId !== "string" || !SAFE_ID.test(metadata.validationReceiptId)
      || typeof metadata.validationReceiptDigest !== "string" || !DIGEST.test(metadata.validationReceiptDigest)
      || typeof metadata.supplyChainEvidenceDigest !== "string" || !DIGEST.test(metadata.supplyChainEvidenceDigest)
      || !validTimestamp(metadata.validatedAt))) {
    throw new Error(`本地 Agent 版本验证回执无效: ${id}`);
  }
  const adapter = [metadata.validatedAdapterVersion, metadata.adapterCompatibility];
  if (adapter.some((item) => item === null) && adapter.some((item) => item !== null)) {
    throw new Error(`本地 Agent Adapter 验证绑定不完整: ${id}`);
  }
  if (metadata.validatedAdapterVersion !== null) {
    if (typeof metadata.validatedAdapterVersion !== "string" || !EXACT_VERSION.test(metadata.validatedAdapterVersion)
      || !record(metadata.adapterCompatibility)
      || !exactFieldsMatch(metadata.adapterCompatibility, ["maxExclusive", "min"])
      || typeof metadata.adapterCompatibility.min !== "string" || typeof metadata.adapterCompatibility.maxExclusive !== "string"
      || !isExactAdapterCompatibility(metadata.validatedAdapterVersion, {
        min: metadata.adapterCompatibility.min,
        maxExclusive: metadata.adapterCompatibility.maxExclusive,
      })) {
      throw new Error(`本地 Agent Adapter 验证绑定无效: ${id}`);
    }
  }
  if (["APPROVED", "DEPRECATED"].includes(state)
    && (metadata.integrity === null || metadata.signatureVerified !== true || metadata.sbomRef === null || metadata.scan !== "PASS"
      || metadata.validationReceiptId === null || metadata.validatedAdapterVersion === null)) {
    throw new Error(`本地 Agent 已批准版本缺少供应链证明: ${id}`);
  }
}

function assertInstallationReferences(state: DemoStoreState): void {
  const installations = new Map(state.installations.map((installation) => [installation.id, installation]));
  if (!sameStringSet(Object.keys(state.rollouts), [...installations.keys()])) throw new Error("本地 Agent 灰度状态引用无效");
  for (const installation of state.installations) {
    const rollout = state.rollouts[installation.id];
    if (!record(rollout) || !exactFieldsMatch(rollout, ["percent", "previous", "state"])
      || typeof rollout.percent !== "number" || !ROLLOUT_PERCENTAGES.has(rollout.percent)
      || typeof rollout.previous !== "number" || !ROLLOUT_PERCENTAGES.has(rollout.previous)
      || typeof rollout.state !== "string" || !INSTALLATION_STATES.has(rollout.state)
      || rollout.percent !== installation.rolloutPercent || rollout.state !== installation.state) {
      throw new Error("本地 Agent 灰度状态无效");
    }
    if (installation.rollbackInstallationId) {
      const rollback = installations.get(installation.rollbackInstallationId);
      if (!rollback || rollback.id === installation.id || rollback.agent !== installation.agent
        || rollback.workerPool !== installation.workerPool) throw new Error("本地 Agent 回滚引用无效");
    }
  }
}

function assertProfileReferences(state: DemoStoreState): void {
  const profiles = new Map(state.profiles.map((profile) => [profile.id, profile]));
  const providers = new Map(state.providers.map((provider) => [provider.id, provider]));
  const installations = new Map(state.installations.map((installation) => [installation.id, installation]));
  const credentials = new Map(state.credentials.map((credential) => [credential.id, credential]));
  for (const profile of state.profiles) {
    const provider = providers.get(profile.providerRevisionId);
    const installation = installations.get(profile.installationId);
    const credential = credentials.get(profile.credentialVersionId);
    const fixtureCredential = provider ? fixtureProviderCredential(provider.id, provider.credentialVersionId) : false;
    if (!provider || !installation || provider.agent !== profile.agent || installation.agent !== profile.agent
      || provider.credentialVersionId !== profile.credentialVersionId || (!credential && !fixtureCredential)) {
      throw new Error("本地 Agent Profile 权限绑定无效");
    }
    if (credential && ((profile.scope === "platform" && (credential.scope !== "platform" || credential.scopeId !== "global"))
      || (profile.scope === "tenant" && (credential.scope !== "tenant" || credential.scopeId !== profile.scopeId))
      || (profile.scope === "project" && (credential.scope !== "tenant" || credential.scopeId !== "tenant-local")))) {
      throw new Error("本地 Agent Profile 凭据作用域无效");
    }
    if (profile.fallbackProfileRevisionId) {
      const fallback = profiles.get(profile.fallbackProfileRevisionId);
      if (!fallback || fallback.id === profile.id || fallback.agent !== profile.agent
        || fallback.scope !== profile.scope || fallback.scopeId !== profile.scopeId) {
        throw new Error("本地 Agent Profile 回退绑定无效");
      }
    }
  }
  for (const profile of state.profiles) {
    const visited = new Set<string>();
    let current: typeof profile | undefined = profile;
    while (current?.fallbackProfileRevisionId) {
      if (visited.has(current.id)) throw new Error("本地 Agent Profile 回退链存在循环");
      visited.add(current.id);
      current = profiles.get(current.fallbackProfileRevisionId);
    }
  }
}

function assertDefaults(state: DemoStoreState): void {
  const profiles = new Map(state.profiles.map((profile) => [profile.id, profile]));
  for (const [scope, profileId] of Object.entries(state.defaults)) {
    if (scope !== "platform" && !/^(tenant|project):[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(scope)) {
      throw new Error("本地 Agent 默认选择作用域无效");
    }
    if (typeof profileId !== "string") throw new Error("本地 Agent 默认选择无效");
    const profile = profiles.get(profileId);
    if (!profile) throw new Error("本地 Agent 默认选择引用不存在的 Profile");
    if (scope === "platform") {
      if (profile.scope !== "platform" || profile.scopeId !== "global") throw new Error("本地 Agent 平台默认作用域无效");
      continue;
    }
    const separator = scope.indexOf(":");
    const kind = scope.slice(0, separator);
    const id = scope.slice(separator + 1);
    if (kind === "tenant" && profile.scope !== "platform"
      && (profile.scope !== "tenant" || profile.scopeId !== id)) throw new Error("本地 Agent 租户默认作用域无效");
    if (kind === "project" && profile.scope !== "platform"
      && (profile.scope === "project" ? profile.scopeId !== id : profile.scope !== "tenant" || profile.scopeId !== "tenant-local")) {
      throw new Error("本地 Agent 项目默认作用域无效");
    }
  }
}

function assertAudit(events: DemoStoreState["audit"]): void {
  assertUniqueIds(events, "本地 Agent 审计投影");
  for (const event of events) {
    if (!record(event) || !exactFieldsMatch(event, ["action", "actor", "at", "id", "metadata", "resource"])
      || typeof event.id !== "string" || !SAFE_ID.test(event.id)
      || typeof event.action !== "string" || !SAFE_ID.test(event.action)
      || typeof event.resource !== "string" || !SAFE_ID.test(event.resource)
      || typeof event.actor !== "string" || !SAFE_ID.test(event.actor)
      || !validTimestamp(event.at) || !record(event.metadata)
      || Object.values(event.metadata).some((item) => typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")) {
      throw new Error("本地 Agent 审计投影无效");
    }
  }
}

function assertUsage(records: DemoStoreState["usage"]): void {
  const requestIds = new Set<string>();
  for (const usage of records) {
    if (!record(usage) || !exactFieldsMatch(usage, [
      "costUsd", "credentialVersionId", "inputTokens", "model", "outputTokens", "projectId", "providerRevisionId",
      "recordedAt", "requestId", "runId", "tenantId",
    ]) || typeof usage.requestId !== "string" || !SAFE_ID.test(usage.requestId) || requestIds.has(usage.requestId)
      || [usage.tenantId, usage.projectId, usage.runId, usage.providerRevisionId, usage.credentialVersionId, usage.model]
        .some((item) => typeof item !== "string" || !SAFE_ID.test(item))
      || !Number.isSafeInteger(usage.inputTokens) || Number(usage.inputTokens) < 0
      || !Number.isSafeInteger(usage.outputTokens) || Number(usage.outputTokens) < 0
      || typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0
      || !validTimestamp(usage.recordedAt)) {
      throw new Error("本地 Agent 使用量投影无效");
    }
    requestIds.add(usage.requestId);
  }
}

function parseVersionId(value: string): { agent: "claude-code" | "codex-cli"; version: string } | null {
  const match = /^(claude-code|codex-cli)@(.+)$/.exec(value);
  if (!match || !exactVersion(match[2] ?? "")) return null;
  return { agent: match[1] as "claude-code" | "codex-cli", version: match[2]! };
}

function exactVersion(value: string): boolean {
  return EXACT_VERSION.test(value) && !/(?:^|[._-])(latest|stable|default)(?:$|[._-])/i.test(value);
}

function fixtureProviderCredential(providerId: string, credentialVersionId: string): boolean {
  return (providerId === "provider-claude-platform-r3" && credentialVersionId === "cred-claude-platform-v4")
    || (providerId === "provider-codex-platform-r2" && credentialVersionId === "cred-codex-platform-v2");
}

function validProviderProbe(value: unknown, state: string): boolean {
  if (!record(value) || Object.keys(value).some((key) => !PROVIDER_REQUIRED_CHECKS.includes(key))) return false;
  if (Object.values(value).some((result) => result !== "PASS" && result !== "FAIL")) return false;
  return !["READY", "ACTIVE"].includes(state)
    || Object.keys(value).length === PROVIDER_REQUIRED_CHECKS.length
      && PROVIDER_REQUIRED_CHECKS.every((check) => value[check] === "PASS");
}

function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && value.length <= 2_000;
  } catch { return false; }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validNullableTimestamp(value: unknown): boolean {
  return value === null || validTimestamp(value);
}

function assertUniqueIds(rows: readonly unknown[], label: string): void {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!record(row) || typeof row.id !== "string" || ids.has(row.id)) throw new Error(`${label} ID 重复或无效`);
    ids.add(row.id);
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((item) => right.includes(item));
}

function exactFields(value: unknown, fields: readonly string[], label: string): void {
  if (!record(value) || !exactFieldsMatch(value, fields)) throw new Error(`${label}无效`);
}

function exactFieldsMatch(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validCredentialSecretRef(credential: Record<string, unknown>): boolean {
  if (typeof credential.id !== "string" || typeof credential.secretRef !== "string") return false;
  return credential.secretRef.startsWith("vault://")
    || credential.secretRef === `secret://local-agent-runtime/${credential.id}`;
}

function validResourceSequences(value: unknown): boolean {
  if (!record(value)) return false;
  const fields = ["audit", "credential", "profile", "provider"];
  return exactFieldsMatch(value, fields) && fields.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
}

function hasForbiddenPersistedKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenPersistedKey);
  if (!record(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    FORBIDDEN_PERSISTED_KEYS.has(key.toLowerCase()) || hasForbiddenPersistedKey(nested));
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
