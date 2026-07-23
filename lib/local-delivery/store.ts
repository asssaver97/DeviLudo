import {
  applyLocalDeliveryAction,
  approveLocalSpec,
  createLocalDelivery,
  invalidateLocalDelivery,
  normalizeLocalDeliverySnapshot,
  recordLocalDeliveryCancellation,
  recordLocalAgentExecution,
  recordLocalExternalApproval,
  recordLocalMainValidation,
  recordLocalSteamReinstall,
  recordLocalValidation,
  type LocalDeliveryAction,
  type LocalDeliveryCancellation,
  type LocalDeliverySnapshot,
  type LocalExternalApprovalEvidenceSnapshot,
  type LocalFeedbackInvalidationAuthority,
  type LocalLockedAgentProfile,
  type LocalMainValidationSnapshot,
  type LocalSteamReinstallSnapshot,
  type LocalTargetPlatform,
  type LocalValidationSnapshot,
} from "./model";
import type { LocalAgentExecutionReceipt } from "@/services/local-agent-runtime/src/contracts";
import { isManagedSmokeProjectId } from "@/lib/local-smoke-project";

type SnapshotRow = { snapshot: string };
type CommandRow = { response: string };
type MutationResult = { snapshot: LocalDeliverySnapshot; replayed: boolean };
type MemoryState = {
  snapshots: Map<string, LocalDeliverySnapshot>;
  commands: Map<string, LocalDeliverySnapshot>;
  automationCommands?: Map<string, { projectId: string; response: LocalAutomationCommandResult }>;
  feedbackCommands?: Map<string, { projectId: string; requestDigest: string; response: string | null }>;
};

export type LocalFeedbackCommandState = Readonly<{
  kind: "MISSING" | "CLAIMED" | "REPLAY" | "CONFLICT";
  response: string | null;
}>;

export type LocalAutomationCommandResult = {
  readonly snapshot: LocalDeliverySnapshot;
  readonly stopReason: string;
  readonly automaticTransitions: number;
  readonly validationExecuted: boolean;
  readonly mainValidationExecuted: boolean;
  readonly steamReinstallExecuted: boolean;
  readonly agentExecutionAttempted: boolean;
  readonly developmentMode: "REAL_AGENT" | "FIXTURE" | null;
  readonly fixtureFallbackCode: string | null;
  readonly requiredPhysicalPlatforms: readonly ("linux" | "windows")[];
};

const globalMemory = globalThis as typeof globalThis & { __deviludoLocalDelivery?: MemoryState };
let initializedDb: D1Database | null = null;
let bindingPromise: Promise<D1Database | null> | null = null;

function memory(): MemoryState {
  globalMemory.__deviludoLocalDelivery ??= { snapshots: new Map(), commands: new Map() };
  globalMemory.__deviludoLocalDelivery.automationCommands ??= new Map();
  globalMemory.__deviludoLocalDelivery.feedbackCommands ??= new Map();
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
    db.prepare(`CREATE TABLE IF NOT EXISTS local_delivery_automation_commands (
      key TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS local_feedback_commands (
      key TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      response TEXT,
      created_at TEXT NOT NULL
    )`),
  ]);
  initializedDb = db;
}

export async function cleanupLocalSmokeDeliveries(projectIds: readonly string[]): Promise<Readonly<{
  snapshots: number;
  events: number;
  commands: number;
  automationCommands: number;
  feedbackCommands: number;
}>> {
  if (!projectIds.length || projectIds.some((projectId) => !isManagedSmokeProjectId(projectId))
    || new Set(projectIds).size !== projectIds.length) {
    throw new Error("Local delivery cleanup target is invalid");
  }
  const db = await resolveDb();
  if (!db) {
    const state = memory();
    let snapshots = 0;
    let commands = 0;
    let automationCommands = 0;
    let feedbackCommands = 0;
    for (const projectId of projectIds) {
      if (state.snapshots.delete(projectId)) snapshots += 1;
    }
    for (const [key, snapshot] of state.commands) {
      if (projectIds.includes(snapshot.projectId)) {
        state.commands.delete(key);
        commands += 1;
      }
    }
    for (const [key, command] of state.automationCommands ?? []) {
      if (projectIds.includes(command.projectId)) {
        state.automationCommands!.delete(key);
        automationCommands += 1;
      }
    }
    for (const [key, command] of state.feedbackCommands ?? []) {
      if (projectIds.includes(command.projectId)) {
        state.feedbackCommands!.delete(key);
        feedbackCommands += 1;
      }
    }
    return Object.freeze({ snapshots, events: 0, commands, automationCommands, feedbackCommands });
  }
  await ensureStore(db);
  const statements = projectIds.flatMap((projectId) => [
    db.prepare("DELETE FROM local_feedback_commands WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM local_delivery_automation_commands WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM local_delivery_commands WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM local_delivery_events WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM local_delivery_snapshots WHERE project_id = ?").bind(projectId),
  ]);
  const results = await db.batch(statements);
  const totals = { snapshots: 0, events: 0, commands: 0, automationCommands: 0, feedbackCommands: 0 };
  for (let index = 0; index < results.length; index += 1) {
    const rawChanges = results[index]?.meta.changes;
    const changes = typeof rawChanges === "number" && Number.isSafeInteger(rawChanges) ? rawChanges : 0;
    if (index % 5 === 0) totals.feedbackCommands += changes;
    else if (index % 5 === 1) totals.automationCommands += changes;
    else if (index % 5 === 2) totals.commands += changes;
    else if (index % 5 === 3) totals.events += changes;
    else totals.snapshots += changes;
  }
  return Object.freeze(totals);
}

export async function readLocalFeedbackCommand(
  projectId: string,
  commandKey: string,
  requestDigest: string,
): Promise<LocalFeedbackCommandState> {
  validateFeedbackCommand(projectId, commandKey, requestDigest);
  const db = await resolveDb();
  if (!db) return feedbackCommandState(memory().feedbackCommands!.get(commandKey), projectId, requestDigest);
  await ensureStore(db);
  const row = await db.prepare(`SELECT project_id, request_digest, response
    FROM local_feedback_commands WHERE key = ?`).bind(commandKey)
    .first<{ project_id: string; request_digest: string; response: string | null }>();
  return feedbackCommandState(row ? {
    projectId: row.project_id,
    requestDigest: row.request_digest,
    response: row.response,
  } : undefined, projectId, requestDigest);
}

export async function claimLocalFeedbackCommand(
  projectId: string,
  commandKey: string,
  requestDigest: string,
): Promise<LocalFeedbackCommandState> {
  validateFeedbackCommand(projectId, commandKey, requestDigest);
  const db = await resolveDb();
  if (!db) {
    const state = memory();
    state.feedbackCommands!.set(commandKey, state.feedbackCommands!.get(commandKey) ?? {
      projectId, requestDigest, response: null,
    });
    return feedbackCommandState(state.feedbackCommands!.get(commandKey), projectId, requestDigest);
  }
  await ensureStore(db);
  await db.prepare(`INSERT OR IGNORE INTO local_feedback_commands
    (key, project_id, request_digest, response, created_at) VALUES (?, ?, ?, NULL, ?)`)
    .bind(commandKey, projectId, requestDigest, new Date().toISOString()).run();
  return readLocalFeedbackCommand(projectId, commandKey, requestDigest);
}

export async function completeLocalFeedbackCommand(
  projectId: string,
  commandKey: string,
  requestDigest: string,
  response: string,
): Promise<void> {
  validateFeedbackCommand(projectId, commandKey, requestDigest);
  if (!response || new TextEncoder().encode(response).byteLength > 256 * 1024) {
    throw new Error("Local feedback command response is invalid");
  }
  const db = await resolveDb();
  if (!db) {
    const state = memory();
    const command = state.feedbackCommands!.get(commandKey);
    if (!command || command.projectId !== projectId || command.requestDigest !== requestDigest
      || (command.response !== null && command.response !== response)) {
      throw new Error("Local feedback command completion conflict");
    }
    command.response = response;
    return;
  }
  await ensureStore(db);
  await db.prepare(`UPDATE local_feedback_commands SET response = ?
    WHERE key = ? AND project_id = ? AND request_digest = ? AND response IS NULL`)
    .bind(response, commandKey, projectId, requestDigest).run();
  const state = await readLocalFeedbackCommand(projectId, commandKey, requestDigest);
  if (state.kind !== "REPLAY" || state.response !== response) throw new Error("Local feedback command completion conflict");
}

export async function listLocalFeedbackCommandResponses(projectId: string): Promise<readonly string[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(projectId)) throw new Error("Local feedback project is invalid");
  const db = await resolveDb();
  if (!db) {
    return Object.freeze([...memory().feedbackCommands!.values()]
      .filter((command) => command.projectId === projectId && command.response !== null)
      .map((command) => command.response!));
  }
  await ensureStore(db);
  const rows = await db.prepare(`SELECT response FROM local_feedback_commands
    WHERE project_id = ? AND response IS NOT NULL ORDER BY created_at ASC, key ASC`)
    .bind(projectId).all<{ response: string }>();
  return Object.freeze(rows.results.map((row) => row.response));
}

function feedbackCommandState(
  command: { projectId: string; requestDigest: string; response: string | null } | undefined,
  projectId: string,
  requestDigest: string,
): LocalFeedbackCommandState {
  if (!command) return Object.freeze({ kind: "MISSING", response: null });
  if (command.projectId !== projectId || command.requestDigest !== requestDigest) {
    return Object.freeze({ kind: "CONFLICT", response: null });
  }
  return Object.freeze({ kind: command.response === null ? "CLAIMED" : "REPLAY", response: command.response });
}

function validateFeedbackCommand(projectId: string, commandKey: string, requestDigest: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(projectId)
    || commandKey.length < 1 || commandKey.length > 320 || /[\0-\x1f\x7f]/.test(commandKey)
    || !/^[a-f0-9]{64}$/.test(requestDigest)) {
    throw new Error("Local feedback command is invalid");
  }
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

export async function replayLocalDeliveryCommand(
  projectId: string,
  commandKey: string,
): Promise<LocalDeliverySnapshot | null> {
  const db = await resolveDb();
  if (db) await ensureStore(db);
  const snapshot = await replay(db, commandKey);
  if (snapshot && snapshot.projectId !== projectId) {
    throw new Error("本地交付命令重放绑定冲突");
  }
  return snapshot;
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

export async function cancelLocalDelivery(
  projectId: string,
  reason: string,
  agentCancellation: LocalDeliveryCancellation["agentCancellation"],
  commandKey: string,
): Promise<MutationResult> {
  return mutate(
    projectId,
    commandKey,
    (current) => recordLocalDeliveryCancellation(current, reason, agentCancellation),
  );
}

export async function startLocalDelivery(
  projectId: string,
  specRevisionId: string,
  runId: string,
  commandKey: string,
  lockedProfile?: LocalLockedAgentProfile,
  targetMatrix?: readonly LocalTargetPlatform[],
): Promise<MutationResult> {
  return mutate(
    projectId,
    commandKey,
    (current) => approveLocalSpec(
      current,
      specRevisionId,
      runId,
      lockedProfile ?? current.lockedProfile,
      targetMatrix,
    ),
    specRevisionId,
  );
}

export async function invalidateLocalEvidence(
  projectId: string,
  nextSpecRevisionId: string,
  commandKey: string,
  authority: LocalFeedbackInvalidationAuthority,
): Promise<MutationResult> {
  return mutate(
    projectId,
    commandKey,
    (current) => invalidateLocalDelivery(current, nextSpecRevisionId, authority),
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

export async function saveLocalMainValidation(
  projectId: string,
  validation: Omit<LocalMainValidationSnapshot, "valid">,
  commandKey: string,
): Promise<MutationResult> {
  return mutate(projectId, commandKey, (current) => recordLocalMainValidation(current, validation));
}

export async function saveLocalSteamReinstall(
  projectId: string,
  validation: Omit<LocalSteamReinstallSnapshot, "valid">,
  commandKey: string,
): Promise<MutationResult> {
  return mutate(projectId, commandKey, (current) => recordLocalSteamReinstall(current, validation));
}

export async function saveLocalExternalApproval(
  projectId: string,
  evidence: Omit<LocalExternalApprovalEvidenceSnapshot, "valid">,
  commandKey: string,
): Promise<MutationResult> {
  return mutate(projectId, commandKey, (current) => recordLocalExternalApproval(current, evidence));
}

export async function readLocalDeliveryCommand(
  projectId: string,
  commandKey: string,
): Promise<LocalDeliverySnapshot | null> {
  const db = await resolveDb();
  if (!db) {
    const snapshot = memory().commands.get(commandKey);
    return snapshot?.projectId === projectId ? normalizeLocalDeliverySnapshot(snapshot) : null;
  }
  await ensureStore(db);
  const row = await db.prepare(
    "SELECT response FROM local_delivery_commands WHERE key = ? AND project_id = ?",
  ).bind(commandKey, projectId).first<CommandRow>();
  return row ? parseSnapshot(row.response) : null;
}

export async function saveLocalAgentExecution(
  projectId: string,
  receipt: LocalAgentExecutionReceipt,
  commandKey: string,
): Promise<MutationResult> {
  return mutate(projectId, commandKey, (current) => recordLocalAgentExecution(current, receipt));
}

export async function readLocalAutomationCommand(
  projectId: string,
  commandKey: string,
): Promise<LocalAutomationCommandResult | null> {
  const db = await resolveDb();
  if (!db) return memory().automationCommands?.get(commandKey)?.projectId === projectId
    ? memory().automationCommands!.get(commandKey)!.response
    : null;
  await ensureStore(db);
  const row = await db.prepare(
    "SELECT response FROM local_delivery_automation_commands WHERE key = ? AND project_id = ?",
  ).bind(commandKey, projectId).first<CommandRow>();
  return row ? parseAutomationResult(row.response, projectId) : null;
}

export async function saveLocalAutomationCommand(
  projectId: string,
  commandKey: string,
  response: LocalAutomationCommandResult,
): Promise<{ response: LocalAutomationCommandResult; replayed: boolean }> {
  const db = await resolveDb();
  if (!db) {
    const commands = memory().automationCommands!;
    const previous = commands.get(commandKey);
    if (previous) {
      if (previous.projectId !== projectId) throw new Error("本地自动编排幂等键已绑定到另一个项目");
      return { response: previous.response, replayed: true };
    }
    commands.set(commandKey, { projectId, response });
    return { response, replayed: false };
  }
  await ensureStore(db);
  const inserted = await db.prepare(`INSERT OR IGNORE INTO local_delivery_automation_commands
    (key, project_id, response, created_at) VALUES (?, ?, ?, ?)`)
    .bind(commandKey, projectId, JSON.stringify(response), new Date().toISOString())
    .run();
  const stored = await readLocalAutomationCommand(projectId, commandKey);
  if (!stored) throw new Error("无法保存本地自动编排幂等回执");
  return { response: stored, replayed: inserted.meta.changes !== 1 };
}

function parseAutomationResult(value: string, projectId: string): LocalAutomationCommandResult {
  const parsed = JSON.parse(value) as LocalAutomationCommandResult & {
    requiredPhysicalPlatforms?: readonly ("linux" | "windows")[];
    mainValidationExecuted?: boolean;
    steamReinstallExecuted?: boolean;
    agentExecutionAttempted?: boolean;
    developmentMode?: "REAL_AGENT" | "FIXTURE" | null;
    fixtureFallbackCode?: string | null;
  };
  const snapshot = normalizeLocalDeliverySnapshot(parsed.snapshot);
  const requiredPhysicalPlatforms = parsed.requiredPhysicalPlatforms ?? [];
  if (snapshot.projectId !== projectId
    || ![
      "USER_ACCEPTANCE_REQUIRED", "MFA_REQUIRED", "EXTERNAL_APPROVAL_REQUIRED", "WAITING_PROVIDER",
      "SPEC_APPROVAL_REQUIRED", "LOCAL_EXPORT_TEMPLATES_REQUIRED", "LOCAL_VALIDATION_FAILED", "TERMINAL",
      "LOCAL_MAIN_VALIDATION_FAILED", "LOCAL_STEAM_REINSTALL_FAILED", "PHYSICAL_RUNNERS_REQUIRED",
      "LOCAL_AGENT_EXECUTOR_REQUIRED",
    ].includes(parsed.stopReason)
    || !Number.isSafeInteger(parsed.automaticTransitions) || parsed.automaticTransitions < 0
    || typeof parsed.validationExecuted !== "boolean"
    || (parsed.mainValidationExecuted !== undefined && typeof parsed.mainValidationExecuted !== "boolean")
    || (parsed.steamReinstallExecuted !== undefined && typeof parsed.steamReinstallExecuted !== "boolean")
    || (parsed.agentExecutionAttempted !== undefined && typeof parsed.agentExecutionAttempted !== "boolean")
    || (parsed.developmentMode !== undefined && parsed.developmentMode !== null
      && parsed.developmentMode !== "REAL_AGENT" && parsed.developmentMode !== "FIXTURE")
    || (parsed.fixtureFallbackCode !== undefined && parsed.fixtureFallbackCode !== null
      && (typeof parsed.fixtureFallbackCode !== "string" || parsed.fixtureFallbackCode.length > 100))
    || !Array.isArray(requiredPhysicalPlatforms)
    || requiredPhysicalPlatforms.some((platform) => platform !== "linux" && platform !== "windows")
    || new Set(requiredPhysicalPlatforms).size !== requiredPhysicalPlatforms.length) {
    throw new Error("本地自动编排回执已损坏");
  }
  return {
    ...parsed,
    snapshot,
    mainValidationExecuted: parsed.mainValidationExecuted ?? false,
    steamReinstallExecuted: parsed.steamReinstallExecuted ?? false,
    agentExecutionAttempted: parsed.agentExecutionAttempted ?? false,
    developmentMode: parsed.developmentMode ?? null,
    fixtureFallbackCode: parsed.fixtureFallbackCode ?? null,
    requiredPhysicalPlatforms,
  };
}
