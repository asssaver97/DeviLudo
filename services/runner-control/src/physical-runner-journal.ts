import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson, sha256Canonical } from "./canonical";
import {
  assertPhysicalRunnerJournalAdvance,
  type PhysicalRunnerJournal,
  type PhysicalRunnerJournalRecord,
  validatePhysicalRunnerJournalRecord,
} from "./physical-runner";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;

interface PhysicalRunnerJournalEnvelope {
  readonly schemaVersion: "deviludo.physical-runner-journal-envelope.v1";
  readonly recordDigest: string;
  readonly record: PhysicalRunnerJournalRecord;
  readonly mac: string;
}

/**
 * Cross-platform, atomically replaced and machine-key-authenticated journal.
 * The server-signed job remains the second independent integrity boundary.
 */
export class FilePhysicalRunnerJournal implements PhysicalRunnerJournal {
  readonly #configuredRoot: string;
  readonly #hmacKey: Buffer;
  #rootPromise: Promise<string> | null = null;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: { readonly root: string; readonly hmacKey: Buffer }) {
    if (!isAbsolute(options.root) || resolve(options.root) !== options.root
      || options.root.length > 4_096 || /\0/.test(options.root)) {
      throw new Error("Physical Runner journal root is invalid");
    }
    if (!Buffer.isBuffer(options.hmacKey) || options.hmacKey.byteLength < 32 || options.hmacKey.byteLength > 64) {
      throw new Error("Physical Runner journal HMAC key is invalid");
    }
    this.#configuredRoot = options.root;
    this.#hmacKey = Buffer.from(options.hmacKey);
  }

  async load(attemptId: string, fencingToken: number): Promise<PhysicalRunnerJournalRecord | null> {
    const path = await this.#recordPath(attemptId, fencingToken);
    let file;
    try {
      file = await open(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_RECORD_BYTES) invalid();
      const parsed = JSON.parse(await file.readFile({ encoding: "utf8" })) as unknown;
      return deepFreeze(verifyEnvelope(parsed, this.#hmacKey));
    } finally {
      await file.close();
    }
  }

  async save(record: PhysicalRunnerJournalRecord): Promise<void> {
    validatePhysicalRunnerJournalRecord(record);
    const operation = this.#writeQueue.then(() => this.#save(record));
    this.#writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async #save(record: PhysicalRunnerJournalRecord): Promise<void> {
    const current = await this.load(record.attemptId, record.fencingToken);
    if (current) assertPhysicalRunnerJournalAdvance(current, record);
    const root = await this.#preparedRoot();
    const path = join(root, recordFileName(record.attemptId, record.fencingToken));
    const envelope = envelopeFor(record, this.#hmacKey);
    const encoded = `${canonicalJson(envelope)}\n`;
    if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES) invalid();
    const temporary = join(root, `.${recordFileName(record.attemptId, record.fencingToken)}.${randomUUID()}.tmp`);
    let temporaryExists = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      temporaryExists = true;
      try {
        await file.writeFile(encoded, { encoding: "utf8" });
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      temporaryExists = false;
      if (process.platform !== "win32") await chmod(path, 0o600);
      await syncDirectory(root);
    } finally {
      if (temporaryExists) await unlink(temporary).catch(() => undefined);
    }
  }

  async #recordPath(attemptId: string, fencingToken: number): Promise<string> {
    validateIdentity(attemptId, fencingToken);
    return join(await this.#preparedRoot(), recordFileName(attemptId, fencingToken));
  }

  #preparedRoot(): Promise<string> {
    this.#rootPromise ??= prepareRoot(this.#configuredRoot);
    return this.#rootPromise;
  }
}

function envelopeFor(record: PhysicalRunnerJournalRecord, key: Buffer): PhysicalRunnerJournalEnvelope {
  const recordDigest = sha256Canonical(record);
  return Object.freeze({
    schemaVersion: "deviludo.physical-runner-journal-envelope.v1",
    recordDigest,
    record,
    mac: macFor(recordDigest, record, key),
  });
}

function verifyEnvelope(value: unknown, key: Buffer): PhysicalRunnerJournalRecord {
  const body = object(value);
  exactKeys(body, ["schemaVersion", "recordDigest", "record", "mac"]);
  if (body.schemaVersion !== "deviludo.physical-runner-journal-envelope.v1"
    || typeof body.recordDigest !== "string" || !SHA256.test(body.recordDigest)
    || typeof body.mac !== "string" || !MAC.test(body.mac)) invalid();
  const record = object(body.record) as unknown as PhysicalRunnerJournalRecord;
  validatePhysicalRunnerJournalRecord(record);
  const digest = sha256Canonical(record);
  if (digest !== body.recordDigest) invalid();
  const expected = macFor(digest, record, key);
  const actualBytes = Buffer.from(body.mac, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (actualBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(actualBytes, expectedBytes)) invalid();
  return record;
}

function macFor(recordDigest: string, record: PhysicalRunnerJournalRecord, key: Buffer): string {
  return createHmac("sha256", key)
    .update(canonicalJson({ recordDigest, record }))
    .digest("base64url");
}

async function prepareRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  const stat = await lstat(canonicalRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Physical Runner journal root is invalid");
  if (process.platform !== "win32") await chmod(canonicalRoot, 0o700);
  return canonicalRoot;
}

async function syncDirectory(root: string): Promise<void> {
  const directory = await open(root, "r");
  try {
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EINVAL" && code !== "EPERM" && code !== "EBADF")) throw error;
  } finally {
    await directory.close();
  }
}

function recordFileName(attemptId: string, fencingToken: number): string {
  validateIdentity(attemptId, fencingToken);
  return `${attemptId}.${fencingToken}.journal.json`;
}

function validateIdentity(attemptId: string, fencingToken: number): void {
  if (!UUID.test(attemptId) || !Number.isSafeInteger(fencingToken) || fencingToken < 1) invalid();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(): never {
  throw new Error("Physical Runner journal envelope is invalid");
}
