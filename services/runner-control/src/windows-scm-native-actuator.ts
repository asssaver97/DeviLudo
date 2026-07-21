import { createPublicKey, type KeyObject } from "node:crypto";
import { sha256Canonical, verifyCanonical } from "./canonical";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface WindowsScmNativeActuatorTrustPolicy {
  readonly schemaVersion: "deviludo.windows-scm-native-actuator-trust-policy.v1";
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

export interface WindowsScmNativeActuatorClaims {
  readonly kind: "deviludo-windows-scm-native-actuator";
  readonly version: 1;
  readonly revision: number;
  readonly platform: "windows";
  readonly architecture: "x86_64" | "arm64";
  readonly actuatorVersion: string;
  readonly requestContractVersion: 1;
  readonly binaryDigest: string;
  readonly sourceDigest: string;
  readonly supplyChainEvidenceDigest: string;
  readonly builtAt: string;
}

export interface SignedWindowsScmNativeActuatorManifest {
  readonly keyId: string;
  readonly claims: WindowsScmNativeActuatorClaims;
  readonly signature: string;
}

export function windowsScmNativeActuatorTrustPolicyDigest(value: unknown): string {
  return sha256Canonical(validateWindowsScmNativeActuatorTrustPolicy(value));
}

export function validateWindowsScmNativeActuatorTrustPolicy(
  value: unknown,
  expectedDigest?: string,
): WindowsScmNativeActuatorTrustPolicy {
  const policy = record(value) as unknown as WindowsScmNativeActuatorTrustPolicy;
  exactKeys(record(policy), ["schemaVersion", "policyId", "policyRevision", "keys"]);
  if (policy.schemaVersion !== "deviludo.windows-scm-native-actuator-trust-policy.v1"
    || !SAFE_ID.test(policy.policyId) || !Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 1
    || !Array.isArray(policy.keys) || policy.keys.length < 1 || policy.keys.length > 16) invalidPolicy();
  const keys = policy.keys.map((candidate) => {
    const key = record(candidate) as unknown as WindowsScmNativeActuatorTrustPolicy["keys"][number];
    exactKeys(record(key), ["keyId", "algorithm", "publicKeySpkiBase64", "notBefore", "notAfter", "status"]);
    if (!SAFE_ID.test(key.keyId) || key.algorithm !== "Ed25519" || !canonicalTimestamp(key.notBefore)
      || !canonicalTimestamp(key.notAfter) || Date.parse(key.notBefore) >= Date.parse(key.notAfter)
      || !new Set(["ACTIVE", "REVOKED"]).has(key.status) || typeof key.publicKeySpkiBase64 !== "string") invalidPolicy();
    publicKey(key.publicKeySpkiBase64);
    return deepFreeze({ ...key });
  });
  const keyIds = keys.map(({ keyId }) => keyId);
  if (new Set(keyIds).size !== keyIds.length || JSON.stringify(keyIds) !== JSON.stringify([...keyIds].sort())) invalidPolicy();
  const trusted = deepFreeze({ ...policy, keys }) as WindowsScmNativeActuatorTrustPolicy;
  if (expectedDigest !== undefined && (!SHA256.test(expectedDigest) || sha256Canonical(trusted) !== expectedDigest)) invalidPolicy();
  return trusted;
}

export function verifySignedWindowsScmNativeActuatorManifest(
  value: unknown,
  options: Readonly<{
    trustPolicy: unknown;
    trustPolicyDigest: string;
    architecture: "x86_64" | "arm64";
    now?: Date;
  }>,
): WindowsScmNativeActuatorClaims {
  const now = options.now ?? new Date();
  if (!new Set(["x86_64", "arm64"]).has(options.architecture) || !Number.isFinite(now.valueOf())) invalid();
  const trustPolicy = validateWindowsScmNativeActuatorTrustPolicy(options.trustPolicy, options.trustPolicyDigest);
  const envelope = record(value);
  exactKeys(envelope, ["keyId", "claims", "signature"]);
  const claims = record(envelope.claims) as unknown as WindowsScmNativeActuatorClaims;
  const key = trustPolicy.keys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!key || key.status !== "ACTIVE" || now.valueOf() < Date.parse(key.notBefore) || now.valueOf() >= Date.parse(key.notAfter)
    || typeof envelope.signature !== "string" || envelope.signature.length < 40 || envelope.signature.length > 512
    || !verifyCanonical(publicKey(key.publicKeySpkiBase64), claims, envelope.signature)) invalid();
  exactKeys(record(claims), [
    "actuatorVersion", "architecture", "binaryDigest", "builtAt", "kind", "platform", "requestContractVersion",
    "revision", "sourceDigest", "supplyChainEvidenceDigest", "version",
  ]);
  const builtAt = Date.parse(claims.builtAt);
  if (claims.kind !== "deviludo-windows-scm-native-actuator" || claims.version !== 1
    || !Number.isSafeInteger(claims.revision) || claims.revision < 1 || claims.platform !== "windows"
    || claims.architecture !== options.architecture || !fixedVersion(claims.actuatorVersion)
    || claims.requestContractVersion !== 1 || !SHA256.test(claims.binaryDigest)
    || !SHA256.test(claims.sourceDigest) || !SHA256.test(claims.supplyChainEvidenceDigest)
    || !Number.isFinite(builtAt) || builtAt > now.valueOf() + MAX_CLOCK_SKEW_MS
    || builtAt < Date.parse(key.notBefore) || builtAt >= Date.parse(key.notAfter)) invalid();
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

function fixedVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value) && !/(?:latest|stable|default)/i.test(value);
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
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
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function invalid(): never { throw new Error("Windows SCM native actuator manifest is invalid"); }
function invalidPolicy(): never { throw new Error("Windows SCM native actuator trust policy is invalid"); }
