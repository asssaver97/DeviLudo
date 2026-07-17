import { createHash, sign, verify, type KeyObject } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function signCanonical(privateKey: KeyObject, value: unknown): string {
  return sign(null, Buffer.from(canonicalJson(value)), privateKey).toString("base64url");
}

export function verifyCanonical(publicKey: KeyObject, value: unknown, signature: string): boolean {
  try {
    return verify(null, Buffer.from(canonicalJson(value)), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function canonicalize(value: unknown): unknown {
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Error("Canonical JSON contains a non-JSON value");
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Canonical JSON accepts only plain objects and arrays");
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Canonical JSON cannot encode a non-finite number");
  return value;
}
