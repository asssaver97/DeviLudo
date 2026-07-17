import { createHash, sign, verify, type KeyObject } from "node:crypto";
import type {
  SignedSteamPublishAuthorization,
  SignedSteamRcArtifact,
  SteamPublishAuthorizationClaims,
  SteamRcArtifactClaims,
} from "./contracts";

export function signSteamRcArtifact(keyId: string, privateKey: KeyObject, claims: SteamRcArtifactClaims): SignedSteamRcArtifact {
  validateKeyId(keyId);
  return Object.freeze({ keyId, claims, signature: signValue(privateKey, claims) });
}

export function verifySteamRcArtifact(publicKey: KeyObject, artifact: SignedSteamRcArtifact): boolean {
  return verifyValue(publicKey, artifact.claims, artifact.signature);
}

export function signSteamPublishAuthorization(
  keyId: string,
  privateKey: KeyObject,
  claims: SteamPublishAuthorizationClaims,
): SignedSteamPublishAuthorization {
  validateKeyId(keyId);
  return Object.freeze({ keyId, claims, signature: signValue(privateKey, claims) });
}

export function verifySteamPublishAuthorization(publicKey: KeyObject, artifact: SignedSteamPublishAuthorization): boolean {
  return verifyValue(publicKey, artifact.claims, artifact.signature);
}

export function steamCanonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function signValue(privateKey: KeyObject, value: unknown): string {
  return sign(null, Buffer.from(canonicalJson(value)), privateKey).toString("base64url");
}

function verifyValue(publicKey: KeyObject, value: unknown, signature: string): boolean {
  try {
    return verify(null, Buffer.from(canonicalJson(value)), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Error("Steam canonical JSON contains a non-JSON value");
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Steam canonical JSON accepts only plain objects and arrays");
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Steam canonical JSON cannot encode a non-finite number");
  return value;
}

function validateKeyId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error("Steam signing key ID is invalid");
}
