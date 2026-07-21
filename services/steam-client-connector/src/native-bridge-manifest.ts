import { createPublicKey, type KeyObject } from "node:crypto";
import type { TargetPlatform } from "../../../lib/domain/types";
import { sha256Canonical, verifyCanonical } from "../../runner-control/src/canonical";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const RUNNER_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface SteamNativeBridgeTrustPolicy {
  readonly schemaVersion: "deviludo.steam-native-bridge-trust-policy.v1";
  readonly policyId: string;
  readonly policyRevision: number;
  readonly keys: readonly Readonly<{
    keyId: string;
    algorithm: "Ed25519";
    publicKeySpkiBase64: string;
    notBefore: string;
    notAfter: string;
    status: "ACTIVE" | "REVOKED";
  }>[];
}

export interface SteamNativeBridgeClaims {
  readonly kind: "deviludo-steam-native-bridge";
  readonly version: 1;
  readonly revision: number;
  readonly runnerId: string;
  readonly platform: TargetPlatform;
  readonly connectorVersion: string;
  readonly bridgeVersion: string;
  readonly controllerContractVersion: 1;
  readonly binaryDigest: string;
  readonly automationPolicyDigest: string;
  readonly supplyChainEvidenceDigest: string;
  readonly builtAt: string;
}

export interface SignedSteamNativeBridgeManifest {
  readonly keyId: string;
  readonly claims: SteamNativeBridgeClaims;
  readonly signature: string;
}

export function steamNativeBridgeTrustPolicyDigest(value: unknown): string {
  return sha256Canonical(validateSteamNativeBridgeTrustPolicy(value));
}

export function validateSteamNativeBridgeTrustPolicy(
  value: unknown,
  expectedDigest?: string,
): SteamNativeBridgeTrustPolicy {
  const policy = record(value) as unknown as SteamNativeBridgeTrustPolicy;
  exactKeys(record(policy), ["schemaVersion", "policyId", "policyRevision", "keys"]);
  if (policy.schemaVersion !== "deviludo.steam-native-bridge-trust-policy.v1"
    || !SAFE_ID.test(policy.policyId) || !Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 1
    || !Array.isArray(policy.keys) || policy.keys.length < 1 || policy.keys.length > 16) invalidPolicy();
  const keys = policy.keys.map((candidate) => {
    const key = record(candidate) as unknown as SteamNativeBridgeTrustPolicy["keys"][number];
    exactKeys(record(key), ["keyId", "algorithm", "publicKeySpkiBase64", "notBefore", "notAfter", "status"]);
    if (!SAFE_ID.test(key.keyId) || key.algorithm !== "Ed25519" || !canonicalTimestamp(key.notBefore)
      || !canonicalTimestamp(key.notAfter) || Date.parse(key.notBefore) >= Date.parse(key.notAfter)
      || (key.status !== "ACTIVE" && key.status !== "REVOKED") || typeof key.publicKeySpkiBase64 !== "string") invalidPolicy();
    publicKey(key.publicKeySpkiBase64);
    return deepFreeze({ ...key });
  });
  const keyIds = keys.map(({ keyId }) => keyId);
  if (new Set(keyIds).size !== keyIds.length || JSON.stringify(keyIds) !== JSON.stringify([...keyIds].sort())) invalidPolicy();
  const trusted = deepFreeze({ ...policy, keys }) as SteamNativeBridgeTrustPolicy;
  if (expectedDigest !== undefined && (!SHA256.test(expectedDigest) || sha256Canonical(trusted) !== expectedDigest)) invalidPolicy();
  return trusted;
}

/** Verifies the immutable bridge artifact identity before the executable is ever probed. */
export function verifySignedSteamNativeBridgeManifest(
  value: unknown,
  options: Readonly<{
    trustPolicy: unknown;
    trustPolicyDigest: string;
    runnerId: string;
    platform: TargetPlatform;
    connectorVersion: string;
    now?: Date;
  }>,
): SteamNativeBridgeClaims {
  if (!RUNNER_ID.test(options.runnerId) || !fixedVersion(options.connectorVersion)) invalid();
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) invalid();
  const trustPolicy = validateSteamNativeBridgeTrustPolicy(options.trustPolicy, options.trustPolicyDigest);
  const envelope = record(value);
  exactKeys(envelope, ["keyId", "claims", "signature"]);
  const claims = record(envelope.claims) as unknown as SteamNativeBridgeClaims;
  const key = trustPolicy.keys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!key || key.status !== "ACTIVE" || now.getTime() < Date.parse(key.notBefore) || now.getTime() >= Date.parse(key.notAfter)
    || typeof envelope.signature !== "string" || envelope.signature.length < 40 || envelope.signature.length > 512
    || !verifyCanonical(publicKey(key.publicKeySpkiBase64), claims, envelope.signature)) invalid();
  const body = record(claims);
  exactKeys(body, [
    "kind", "version", "revision", "runnerId", "platform", "connectorVersion", "bridgeVersion",
    "controllerContractVersion", "binaryDigest", "automationPolicyDigest", "supplyChainEvidenceDigest", "builtAt",
  ]);
  const builtAt = Date.parse(claims.builtAt);
  if (claims.kind !== "deviludo-steam-native-bridge" || claims.version !== 1
    || !Number.isSafeInteger(claims.revision) || claims.revision < 1
    || claims.runnerId !== options.runnerId || claims.platform !== options.platform
    || claims.connectorVersion !== options.connectorVersion || !fixedVersion(claims.bridgeVersion)
    || claims.controllerContractVersion !== 1 || !SHA256.test(claims.binaryDigest)
    || !SHA256.test(claims.automationPolicyDigest) || !SHA256.test(claims.supplyChainEvidenceDigest)
    || !Number.isFinite(builtAt) || !Number.isFinite(now.getTime())
    || builtAt > now.getTime() + MAX_CLOCK_SKEW_MS || builtAt < Date.parse(key.notBefore)
    || builtAt >= Date.parse(key.notAfter)) invalid();
  return deepFreeze({ ...claims });
}

function publicKey(value: string): KeyObject {
  let canonical: Buffer;
  let key: KeyObject;
  try {
    canonical = Buffer.from(value, "base64");
    if (canonical.length < 32 || canonical.toString("base64") !== value) invalidPolicy();
    key = createPublicKey({ key: canonical, format: "der", type: "spki" });
  } catch { invalidPolicy(); }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") invalidPolicy();
  return key;
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function fixedVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value) && !/(?:latest|stable|default)/i.test(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid();
}

function deepFreeze<T>(value: T): T {
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && typeof child === "object") deepFreeze(child);
  }
  return value;
}

function invalid(): never { throw new Error("Steam native bridge manifest is invalid"); }
function invalidPolicy(): never { throw new Error("Steam native bridge trust policy is invalid"); }
