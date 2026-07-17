import { randomUUID } from "node:crypto";

export type AdminIdempotencyClaim =
  | { readonly kind: "ACQUIRED"; readonly claimToken: string }
  | { readonly kind: "BUSY" }
  | { readonly kind: "CONFLICT" }
  | { readonly kind: "REPLAY"; readonly payload: unknown };

export abstract class AdminIdempotencyStore {
  abstract acquire(input: {
    readonly identityDigest: string;
    readonly requestFingerprint: string;
  }): Promise<AdminIdempotencyClaim>;

  abstract complete(input: {
    readonly identityDigest: string;
    readonly requestFingerprint: string;
    readonly claimToken: string;
    readonly payload: unknown;
  }): Promise<void>;

  abstract release(input: {
    readonly identityDigest: string;
    readonly requestFingerprint: string;
    readonly claimToken: string;
  }): Promise<void>;
}

interface MemoryRecord {
  readonly requestFingerprint: string;
  state: "AVAILABLE" | "CLAIMED" | "COMPLETED";
  claimToken: string | null;
  claimExpiresAt: number | null;
  payload: unknown;
  expiresAt: number;
}

export class InMemoryAdminIdempotencyStore extends AdminIdempotencyStore {
  readonly #records = new Map<string, MemoryRecord>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  async acquire(input: {
    readonly identityDigest: string;
    readonly requestFingerprint: string;
  }): Promise<AdminIdempotencyClaim> {
    validateDigest(input.identityDigest);
    validateDigest(input.requestFingerprint);
    const now = validNow(this.now());
    let record = this.#records.get(input.identityDigest);
    if (record && record.expiresAt <= now) {
      this.#records.delete(input.identityDigest);
      record = undefined;
    }
    if (!record) {
      const claimToken = randomUUID();
      this.#records.set(input.identityDigest, {
        requestFingerprint: input.requestFingerprint,
        state: "CLAIMED",
        claimToken,
        claimExpiresAt: now + 5 * 60_000,
        payload: null,
        expiresAt: now + 24 * 60 * 60_000,
      });
      return Object.freeze({ kind: "ACQUIRED" as const, claimToken });
    }
    if (record.requestFingerprint !== input.requestFingerprint) return Object.freeze({ kind: "CONFLICT" as const });
    if (record.state === "COMPLETED") {
      return Object.freeze({ kind: "REPLAY" as const, payload: structuredClone(record.payload) });
    }
    if (record.state === "CLAIMED" && (record.claimExpiresAt ?? 0) > now) {
      return Object.freeze({ kind: "BUSY" as const });
    }
    const claimToken = randomUUID();
    Object.assign(record, { state: "CLAIMED", claimToken, claimExpiresAt: now + 5 * 60_000 });
    return Object.freeze({ kind: "ACQUIRED" as const, claimToken });
  }

  async complete(input: {
    readonly identityDigest: string;
    readonly requestFingerprint: string;
    readonly claimToken: string;
    readonly payload: unknown;
  }): Promise<void> {
    validatePayload(input.payload);
    const record = this.#records.get(input.identityDigest);
    if (record?.requestFingerprint === input.requestFingerprint && record.state === "COMPLETED"
      && canonicalJson(record.payload) === canonicalJson(input.payload)) return;
    if (!record || record.requestFingerprint !== input.requestFingerprint
      || record.state !== "CLAIMED" || record.claimToken !== input.claimToken) {
      throw new Error("Administrator idempotency claim was lost before completion");
    }
    Object.assign(record, {
      state: "COMPLETED",
      claimToken: null,
      claimExpiresAt: null,
      payload: structuredClone(input.payload),
    });
  }

  async release(input: {
    readonly identityDigest: string;
    readonly requestFingerprint: string;
    readonly claimToken: string;
  }): Promise<void> {
    const record = this.#records.get(input.identityDigest);
    if (!record || record.requestFingerprint !== input.requestFingerprint
      || record.state !== "CLAIMED" || record.claimToken !== input.claimToken) return;
    Object.assign(record, { state: "AVAILABLE", claimToken: null, claimExpiresAt: null });
  }
}

export function validatePayload(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 1024 * 1024) {
    throw new Error("Administrator idempotency result is invalid");
  }
}

function validateDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Administrator idempotency digest is invalid");
}

function validNow(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Administrator idempotency clock is invalid");
  return value;
}

export function canonicalAdminJson(value: unknown): string {
  return canonicalJson(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}
