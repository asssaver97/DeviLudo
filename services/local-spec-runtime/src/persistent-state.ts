import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { chmod, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  parseInMemorySpecDialogueState,
  type InMemorySpecDialogueState,
} from "../../spec-dialogue/src/store";

const STATE_SCHEMA = "deviludo.local-spec-state.v1";
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_PROJECTS = 10_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type PersistedFeedbackClaim = Readonly<{ conversationId: string; expectedRevision: number }>;

export interface LocalSpecRuntimeState {
  readonly schema: typeof STATE_SCHEMA;
  readonly store: InMemorySpecDialogueState;
  readonly currentConversationIds: readonly (readonly [string, string])[];
  readonly feedbackClaims: readonly (readonly [string, PersistedFeedbackClaim])[];
}

export class LocalSpecRuntimePersistenceError extends Error {
  readonly code = "LOCAL_SPEC_PERSISTENCE_UNAVAILABLE";
  constructor(message: string, cause?: unknown) { super(message, cause === undefined ? undefined : { cause }); }
}

export class LocalSpecRuntimeStateFile {
  readonly #file: string;
  #queue: Promise<void> = Promise.resolve();
  #lastError: unknown = null;

  constructor(file: string) {
    if (!path.isAbsolute(file) || path.normalize(file) !== file || file.length > 4_096 || file.includes("\0")) {
      throw new Error("DEVILUDO_LOCAL_SPEC_STATE_FILE must be an absolute normalized path");
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.#file = file;
  }

  load(): LocalSpecRuntimeState | null {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(this.#file, constants.O_RDONLY | noFollowFlag());
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_STATE_BYTES) invalidState();
      if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) invalidState();
      return parseLocalSpecRuntimeState(JSON.parse(readFileSync(descriptor, "utf8")));
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error("Local specification state could not be loaded safely", { cause: error });
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }

  save(state: LocalSpecRuntimeState): Promise<void> {
    const normalized = parseLocalSpecRuntimeState(state);
    const encoded = `${JSON.stringify(normalized)}\n`;
    if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) {
      return Promise.reject(new LocalSpecRuntimePersistenceError("Local specification state exceeds its size limit"));
    }
    const operation = this.#queue.then(async () => {
      const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
        await handle.writeFile(encoded, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        if (process.platform !== "win32") await chmod(temporary, 0o600);
        await rename(temporary, this.#file);
        await syncDirectory(path.dirname(this.#file));
        this.#lastError = null;
      } catch (error) {
        this.#lastError = error;
        if (handle) await handle.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
        throw new LocalSpecRuntimePersistenceError("Local specification state could not be persisted", error);
      }
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async probe(): Promise<void> {
    await this.#queue;
    if (this.#lastError) throw new Error("Local specification persistence is unhealthy", { cause: this.#lastError });
  }
}

export function parseLocalSpecRuntimeState(value: unknown): LocalSpecRuntimeState {
  const body = exactObject(value, ["currentConversationIds", "feedbackClaims", "schema", "store"]);
  if (body.schema !== STATE_SCHEMA) invalidState();
  const store = parseInMemorySpecDialogueState(body.store);
  if (store.conversations.some((snapshot) => snapshot.tenantId !== "tenant-local")) invalidState();
  const conversations = new Set(store.conversations.map((snapshot) => `${snapshot.projectId}\0${snapshot.conversationId}`));
  const currentProjects = new Set<string>();
  const currentConversationIds = array(body.currentConversationIds, MAX_PROJECTS).map((value) => {
    if (!Array.isArray(value) || value.length !== 2) invalidState();
    const projectId = safeId(value[0]);
    const conversationId = safeId(value[1]);
    if (currentProjects.has(projectId) || !conversations.has(`${projectId}\0${conversationId}`)) invalidState();
    currentProjects.add(projectId);
    return Object.freeze([projectId, conversationId] as const);
  });
  const feedbackKeys = new Set<string>();
  const feedbackClaims = array(body.feedbackClaims, 50_000).map((value) => {
    if (!Array.isArray(value) || value.length !== 2) invalidState();
    const operationKey = sha(value[0]);
    const claim = exactObject(value[1], ["conversationId", "expectedRevision"]);
    const conversationId = safeId(claim.conversationId);
    const expectedRevision = integer(claim.expectedRevision, 0, 1_000_000);
    if (feedbackKeys.has(operationKey)) invalidState();
    feedbackKeys.add(operationKey);
    if (!store.operations.some((operation) => operation.operationKey === operationKey
      && operation.snapshot.conversationId === conversationId
      && operation.snapshot.revision === expectedRevision + 1)) invalidState();
    return Object.freeze([operationKey, Object.freeze({ conversationId, expectedRevision })] as const);
  });
  return Object.freeze({
    schema: STATE_SCHEMA,
    store,
    currentConversationIds: Object.freeze(currentConversationIds),
    feedbackClaims: Object.freeze(feedbackClaims),
  });
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function noFollowFlag(): number { return constants.O_NOFOLLOW ?? 0; }
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidState();
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) invalidState();
  return body;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalidState();
  return value;
}
function safeId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) invalidState();
  return value;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) invalidState();
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalidState();
  return value as number;
}
function invalidState(): never { throw new Error("Local specification state is invalid"); }
