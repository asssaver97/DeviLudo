import {
  applyLocalDeliveryAction,
  approveLocalSpec,
  createLocalDelivery,
  invalidateLocalDelivery,
  normalizeLocalDeliverySnapshot,
  recordLocalAgentExecution,
  recordLocalValidation,
  type LocalDeliveryAction,
  type LocalDeliverySnapshot,
  type LocalLockedAgentProfile,
  type LocalValidationSnapshot,
} from "./model";
import type { LocalAgentExecutionReceipt } from "@/services/local-agent-runtime/src/contracts";

type SnapshotRow = { snapshot: string };
type CommandRow = { response: string };
type MutationResult = { snapshot: LocalDeliverySnapshot; replayed: boolean };
type MemoryState = {
  snapshots: Map<string, LocalDeliverySnapshot>;
  commands: Map<string, LocalDeliverySnapshot>;
};

const globalMemory = globalThis as typeof globalThis & { __deviludoLocalDelivery?: MemoryState };
let initializedDb: D1Database | null = null;
let bindingPromise: Promise<D1Database | null> | null = null;

function memory(): MemoryState {
  globalMemory.__deviludoLocalDelivery ??= { snapshots: new Map(), commands: new Map() };
  return globalMemory.__deviludoLocalDelivery;
}

async function resolveDb(): Promise<D1Database | null> {
  bindingPromise ??= import("cloudflare:workers")
    .then(({ env }) => env.DB ?? null)
    .catch(() => null);
  return bindingPromise;
}

async function ensureStore(db: D1Database) {
  if (initializedDb === db) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS local_delivery_snapshots (
      project_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS local_delivery_events (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS local_delivery_event_revision_unique
      ON local_delivery_events (project_id, revision)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS local_delivery_event_project_time_idx
      ON local_delivery_events (project_id, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS local_delivery_commands (
      key TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
  ]);
  initializedDb = db;
}

function parseSnapshot(value: string): LocalDeliverySnapshot {
  const parsed = JSON.parse(value) as LocalDeliverySnapshot;
  if (!parsed.projectId || !parsed.stage || !Number.isInteger(parsed.revision)) {
    throw new Error("本地交付快照已损坏");
  }
  return normalizeLocalDeliverySnapshot(parsed);
}

async function insertInitial(
  db: D1Database,
  projectId: string,
  specRevisionId?: string,
) {
  const initial = createLocalDelivery(projectId, specRevisionId);
  const firstEvent = initial.events[0];
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO local_delivery_snapshots
      (project_id, revision, snapshot, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(projectId, initial.revision, JSON.stringify(initial), initial.updatedAt),
    db.prepare(`INSERT OR IGNORE INTO local_delivery_events
      (id, project_id, revision, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        `${projectId}:${firstEvent.id}`,
        projectId,
        initial.revision,
        firstEvent.type,
        JSON.stringify(firstEvent),
        firstEvent.at,
      ),
  ]);
}

async function readD1Delivery(
  db: D1Database,
  projectId: string,
  specRevisionId?: string,
): Promise<LocalDeliverySnapshot> {
  await ensureStore(db);
  let row = await db.prepare(
    "SELECT snapshot FROM local_delivery_snapshots WHERE project_id = ?",
  ).bind(projectId).first<SnapshotRow>();
  if (!row) {
    await insertInitial(db, projectId, specRevisionId);
    row = await db.prepare(
      "SELECT snapshot FROM local_delivery_snapshots WHERE project_id = ?",
    ).bind(projectId).first<SnapshotRow>();
  }
  if (!row) throw new Error("无法创建本地交付快照");
  return parseSnapshot(row.snapshot);
}

function readMemoryDelivery(projectId: string, specRevisionId?: string) {
  const state = memory();
  let snapshot = state.snapshots.get(projectId);
  if (!snapshot) {
    snapshot = createLocalDelivery(projectId, specRevisionId);
    state.snapshots.set(projectId, snapshot);
  }
  return normalizeLocalDeliverySnapshot(snapshot);
}

export async function readLocalDelivery(
  projectId: string,
  specRevisionId?: string,
): Promise<LocalDeliverySnapshot> {
  const db = await resolveDb();
  return db
    ? readD1Delivery(db, projectId, specRevisionId)
    : readMemoryDelivery(projectId, specRevisionId);
}

async function persistD1Mutation(
  db: D1Database,
  current: LocalDeliverySnapshot,
  next: LocalDeliverySnapshot,
  commandKey: string,
) {
  const latestEvent = next.events[0];
  await db.batch([
    db.prepare(`UPDATE local_delivery_snapshots
      SET revision = ?, snapshot = ?, updated_at = ?
      WHERE project_id = ? AND revision = ?`)
      .bind(next.revision, JSON.stringify(next), next.updatedAt, next.projectId, current.revision),
    db.prepare(`INSERT INTO local_delivery_events
      (id, project_id, revision, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        `${next.projectId}:${latestEvent.id}`,
        next.projectId,
        next.revision,
        latestEvent.type,
        JSON.stringify(latestEvent),
        latestEvent.at,
      ),
    db.prepare(`INSERT INTO local_delivery_commands
      (key, project_id, response, created_at) VALUES (?, ?, ?, ?)`)
      .bind(commandKey, next.projectId, JSON.stringify(next), next.updatedAt),
  ]);
  return next;
}

function persistMemoryMutation(next: LocalDeliverySnapshot, commandKey: string) {
  const state = memory();
  state.snapshots.set(next.projectId, next);
  state.commands.set(commandKey, next);
  return next;
}

async function replay(db: D1Database | null, commandKey: string): Promise<LocalDeliverySnapshot | null> {
  if (!db) return memory().commands.get(commandKey) ?? null;
  const row = await db.prepare(
    "SELECT response FROM local_delivery_commands WHERE key = ?",
  ).bind(commandKey).first<CommandRow>();
  return row ? parseSnapshot(row.response) : null;
}

async function mutate(
  projectId: string,
  commandKey: string,
  operation: (current: LocalDeliverySnapshot) => LocalDeliverySnapshot,
  specRevisionId?: string,
): Promise<MutationResult> {
  const db = await resolveDb();
  if (db) await ensureStore(db);
  const previous = await replay(db, commandKey);
  if (previous) return { snapshot: previous, replayed: true };
  const current = db
    ? await readD1Delivery(db, projectId, specRevisionId)
    : readMemoryDelivery(projectId, specRevisionId);
  const next = operation(current);
  const snapshot = db
    ? await persistD1Mutation(db, current, next, commandKey)
    : persistMemoryMutation(next, commandKey);
  return { snapshot, replayed: false };
}

export async function commandLocalDelivery(
  projectId: string,
  action: LocalDeliveryAction,
  commandKey: string,
): Promise<MutationResult> {
  return mutate(projectId, commandKey, (current) => applyLocalDeliveryAction(current, action));
}

export async function startLocalDelivery(
  projectId: string,
  specRevisionId: string,
  runId: string,
  commandKey: string,
  lockedProfile?: LocalLockedAgentProfile,
): Promise<MutationResult> {
  return mutate(
    projectId,
    commandKey,
    (current) => approveLocalSpec(current, specRevisionId, runId, lockedProfile ?? current.lockedProfile),
    specRevisionId,
  );
}

export async function invalidateLocalEvidence(
  projectId: string,
  nextSpecRevisionId: string,
  commandKey: string,
): Promise<MutationResult> {
  return mutate(
    projectId,
    commandKey,
    (current) => invalidateLocalDelivery(current, nextSpecRevisionId),
    nextSpecRevisionId,
  );
}

export async function saveLocalValidation(
  projectId: string,
  validation: Omit<LocalValidationSnapshot, "valid">,
  commandKey: string,
): Promise<MutationResult> {
  return mutate(projectId, commandKey, (current) => recordLocalValidation(current, validation));
}

export async function saveLocalAgentExecution(
  projectId: string,
  receipt: LocalAgentExecutionReceipt,
  commandKey: string,
): Promise<MutationResult> {
  return mutate(projectId, commandKey, (current) => recordLocalAgentExecution(current, receipt));
}
