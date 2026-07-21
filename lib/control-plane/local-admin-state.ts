import {
  getDemoStore,
  migrateDemoStoreState,
  restoreDemoStore,
  type DemoStoreState,
} from "./demo-store";

const SNAPSHOT_SCHEMA = "deviludo.local-admin-state.v2";
const LEGACY_SNAPSHOT_SCHEMA = "deviludo.local-admin-state.v1";
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const COMMAND_KEY = /^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,511}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION_STATES = new Set(["DISCOVERED", "VALIDATING", "APPROVED", "DEPRECATED", "BLOCKED", "REJECTED"]);
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
  return database.prepare(`SELECT revision, state_json
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

export function parseLocalAdminState(serialized: string): DemoStoreState {
  if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("本地 Agent 管理状态快照无效");
  }
  let envelope: unknown;
  try { envelope = JSON.parse(serialized); }
  catch { throw new Error("本地 Agent 管理状态快照无法解析"); }
  if (!record(envelope)
    || (envelope.schemaVersion !== SNAPSHOT_SCHEMA && envelope.schemaVersion !== LEGACY_SNAPSHOT_SCHEMA)
    || !record(envelope.state)) {
    throw new Error("本地 Agent 管理状态快照版本无效");
  }
  const state = migrateDemoStoreState(envelope.state);
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
    restoreDemoStore(parseLocalAdminState(row.state_json));
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
    || !Array.isArray(value.audit) || !Array.isArray(value.usage) || !record(value.idempotency)) {
    throw new Error("本地 Agent 管理状态结构无效");
  }
  for (const state of Object.values(value.agentVersions)) {
    if (typeof state !== "string" || !VERSION_STATES.has(state)) throw new Error("本地 Agent 版本状态无效");
  }
  for (const installation of value.installations) {
    if (!record(installation) || typeof installation.id !== "string"
      || (installation.agent !== "claude-code" && installation.agent !== "codex-cli")
      || typeof installation.imageDigest !== "string" || !DIGEST.test(installation.imageDigest)) {
      throw new Error("本地 Agent 安装状态无效");
    }
  }
  for (const credential of value.credentials) {
    if (!record(credential) || typeof credential.id !== "string" || typeof credential.secretRef !== "string"
      || !credential.secretRef.startsWith("vault://") || typeof credential.fingerprint !== "string"
      || !DIGEST.test(credential.fingerprint)) {
      throw new Error("本地 Agent 凭据投影无效");
    }
  }
  for (const provider of value.providers) {
    if (!record(provider) || typeof provider.id !== "string"
      || (provider.agent !== "claude-code" && provider.agent !== "codex-cli")
      || (provider.protocol !== "anthropic-messages" && provider.protocol !== "openai-responses")
      || !record(provider.models) || !record(provider.pricing) || !record(provider.governance)
      || !Array.isArray(provider.approvedPorts)
      || typeof provider.credentialVersionId !== "string") {
      throw new Error("本地 Agent Provider 投影无效");
    }
    for (const role of ["primaryModel", "planningModel", "smallFastModel", "subagentModel"] as const) {
      if (typeof provider.models[role] !== "string" || !provider.models[role]) {
        throw new Error("本地 Agent Provider 模型角色无效");
      }
    }
  }
  for (const profile of value.profiles) {
    if (!record(profile) || typeof profile.id !== "string" || typeof profile.providerRevisionId !== "string"
      || typeof profile.credentialVersionId !== "string" || !record(profile.budget)
      || typeof profile.budget.maxUsd !== "number" || typeof profile.budget.maxTurns !== "number"
      || typeof profile.budget.timeoutSeconds !== "number" || typeof profile.createdAt !== "string") {
      throw new Error("本地 Agent Profile 投影无效");
    }
  }
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
