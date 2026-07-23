import { createPublicKey, type KeyObject } from "node:crypto";
import { sha256Canonical, verifyCanonical } from "../../runner-control/src/canonical";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface AgentSupplyChainNativeTrustPolicy {
  readonly schemaVersion: "deviludo.agent-supply-chain-native-trust-policy.v1";
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

export interface AgentSupplyChainNativeReleaseClaims {
  readonly kind: "deviludo-agent-supply-chain-native";
  readonly version: 1;
  readonly releaseId: string;
  readonly platformVersion: string;
  readonly sourceRevision: string;
  readonly nodeTarget: "22.13";
  readonly artifactDigest: string;
  readonly artifactSizeBytes: number;
  readonly buildReceiptDigest: string;
  readonly sbomDigest: string;
  readonly malwareScanDigest: string;
  readonly vulnerabilityScanDigest: string;
  readonly provenanceDigest: string;
  readonly publishedAt: string;
}

export interface SignedAgentSupplyChainNativeRelease {
  readonly keyId: string;
  readonly claims: AgentSupplyChainNativeReleaseClaims;
  readonly signature: string;
}

export function agentSupplyChainNativeTrustPolicyDigest(value: unknown): string {
  return sha256Canonical(validateAgentSupplyChainNativeTrustPolicy(value));
}

export function validateAgentSupplyChainNativeTrustPolicy(
  value: unknown,
  expectedDigest?: string,
): AgentSupplyChainNativeTrustPolicy {
  const policy = record(value) as unknown as AgentSupplyChainNativeTrustPolicy;
  exactKeys(record(policy), ["schemaVersion", "policyId", "policyRevision", "keys"]);
  if (policy.schemaVersion !== "deviludo.agent-supply-chain-native-trust-policy.v1"
    || !SAFE_ID.test(policy.policyId) || !Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 1
    || !Array.isArray(policy.keys) || policy.keys.length < 1 || policy.keys.length > 16) invalidPolicy();
  const keys = policy.keys.map((candidate) => {
    const key = record(candidate) as unknown as AgentSupplyChainNativeTrustPolicy["keys"][number];
    exactKeys(record(key), ["keyId", "algorithm", "publicKeySpkiBase64", "notBefore", "notAfter", "status"]);
    if (!SAFE_ID.test(key.keyId) || key.algorithm !== "Ed25519" || !canonicalTimestamp(key.notBefore)
      || !canonicalTimestamp(key.notAfter) || Date.parse(key.notBefore) >= Date.parse(key.notAfter)
      || (key.status !== "ACTIVE" && key.status !== "REVOKED") || typeof key.publicKeySpkiBase64 !== "string") invalidPolicy();
    publicKey(key.publicKeySpkiBase64);
    return deepFreeze({ ...key });
  });
  const keyIds = keys.map(({ keyId }) => keyId);
  if (new Set(keyIds).size !== keyIds.length || JSON.stringify(keyIds) !== JSON.stringify([...keyIds].sort())) invalidPolicy();
  const trusted = deepFreeze({ ...policy, keys }) as AgentSupplyChainNativeTrustPolicy;
  if (expectedDigest !== undefined && (!SHA256.test(expectedDigest) || sha256Canonical(trusted) !== expectedDigest)) invalidPolicy();
  return trusted;
}

/** Verifies the privileged policy executor before the Broker may probe or execute it. */
export function verifySignedAgentSupplyChainNativeRelease(
  value: unknown,
  options: Readonly<{
    trustPolicy: unknown;
    trustPolicyDigest: string;
    platformVersion: string;
    artifactDigest: string;
    buildReceiptDigest: string;
    now?: Date;
  }>,
): AgentSupplyChainNativeReleaseClaims {
  if (!fixedVersion(options.platformVersion) || !SHA256.test(options.artifactDigest)
    || !SHA256.test(options.buildReceiptDigest)) invalid();
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) invalid();
  const trustPolicy = validateAgentSupplyChainNativeTrustPolicy(options.trustPolicy, options.trustPolicyDigest);
  const envelope = record(value);
  exactKeys(envelope, ["keyId", "claims", "signature"]);
  const claims = record(envelope.claims) as unknown as AgentSupplyChainNativeReleaseClaims;
  const key = trustPolicy.keys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!key || key.status !== "ACTIVE" || now.getTime() < Date.parse(key.notBefore) || now.getTime() >= Date.parse(key.notAfter)
    || typeof envelope.signature !== "string" || envelope.signature.length < 40 || envelope.signature.length > 512
    || !verifyCanonical(publicKey(key.publicKeySpkiBase64), claims, envelope.signature)) invalid();
  exactKeys(record(claims), [
    "kind", "version", "releaseId", "platformVersion", "sourceRevision", "nodeTarget", "artifactDigest",
    "artifactSizeBytes", "buildReceiptDigest", "sbomDigest", "malwareScanDigest", "vulnerabilityScanDigest",
    "provenanceDigest", "publishedAt",
  ]);
  const publishedAt = Date.parse(claims.publishedAt);
  if (claims.kind !== "deviludo-agent-supply-chain-native" || claims.version !== 1 || !UUID.test(claims.releaseId)
    || claims.platformVersion !== options.platformVersion || !fixedVersion(claims.platformVersion)
    || !SOURCE_REVISION.test(claims.sourceRevision) || claims.nodeTarget !== "22.13"
    || claims.artifactDigest !== options.artifactDigest || claims.buildReceiptDigest !== options.buildReceiptDigest
    || !Number.isSafeInteger(claims.artifactSizeBytes) || claims.artifactSizeBytes < 1
    || claims.artifactSizeBytes > 1024 * 1024 * 1024
    || !SHA256.test(claims.sbomDigest) || !SHA256.test(claims.malwareScanDigest)
    || !SHA256.test(claims.vulnerabilityScanDigest) || !SHA256.test(claims.provenanceDigest)
    || !canonicalTimestamp(claims.publishedAt) || publishedAt > now.getTime() + MAX_CLOCK_SKEW_MS
    || publishedAt < Date.parse(key.notBefore) || publishedAt >= Date.parse(key.notAfter)) invalid();
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

function invalid(): never { throw new Error("Agent supply-chain native release is invalid"); }
function invalidPolicy(): never { throw new Error("Agent supply-chain native trust policy is invalid"); }
