import { createPublicKey, type KeyObject } from "node:crypto";
import { sha256Canonical, verifyCanonical } from "../../runner-control/src/canonical";
import { parseNativeMicrovmLauncherConfig, type NativeMicrovmLauncherConfig } from "./native-microvm-launcher";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface AgentMicrovmLauncherTrustPolicy {
  readonly schemaVersion: "deviludo.agent-microvm-launcher-trust-policy.v1";
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

export interface AgentMicrovmLauncherReleaseClaims {
  readonly kind: "deviludo-agent-microvm-launcher";
  readonly version: 2;
  readonly releaseId: string;
  readonly platformVersion: string;
  readonly sourceRevision: string;
  readonly nodeTarget: "22.13";
  readonly launcherDigest: string;
  readonly launcherSizeBytes: number;
  readonly buildReceiptDigest: string;
  readonly configDigest: string;
  readonly firecrackerVersion: string;
  readonly firecrackerDigest: string;
  readonly jailerDigest: string;
  readonly kernelDigest: string;
  readonly rootfsDigest: string;
  readonly rootfsReleaseDigest: string;
  readonly rootfsTrustPolicyDigest: string;
  readonly mke2fsDigest: string;
  readonly debugfsDigest: string;
  readonly sbomDigest: string;
  readonly malwareScanDigest: string;
  readonly vulnerabilityScanDigest: string;
  readonly provenanceDigest: string;
  readonly publishedAt: string;
}

export function agentMicrovmLauncherTrustPolicyDigest(value: unknown): string {
  return sha256Canonical(validateAgentMicrovmLauncherTrustPolicy(value));
}

export function validateAgentMicrovmLauncherTrustPolicy(
  value: unknown,
  expectedDigest?: string,
): AgentMicrovmLauncherTrustPolicy {
  const policy = record(value) as unknown as AgentMicrovmLauncherTrustPolicy;
  exactKeys(record(policy), ["schemaVersion", "policyId", "policyRevision", "keys"]);
  if (policy.schemaVersion !== "deviludo.agent-microvm-launcher-trust-policy.v1"
    || !SAFE_ID.test(policy.policyId) || !Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 1
    || !Array.isArray(policy.keys) || policy.keys.length < 1 || policy.keys.length > 16) invalidPolicy();
  const keys = policy.keys.map((candidate) => {
    const key = record(candidate) as unknown as AgentMicrovmLauncherTrustPolicy["keys"][number];
    exactKeys(record(key), ["keyId", "algorithm", "publicKeySpkiBase64", "notBefore", "notAfter", "status"]);
    if (!SAFE_ID.test(key.keyId) || key.algorithm !== "Ed25519" || !canonicalTimestamp(key.notBefore)
      || !canonicalTimestamp(key.notAfter) || Date.parse(key.notBefore) >= Date.parse(key.notAfter)
      || (key.status !== "ACTIVE" && key.status !== "REVOKED") || typeof key.publicKeySpkiBase64 !== "string") invalidPolicy();
    publicKey(key.publicKeySpkiBase64);
    return deepFreeze({ ...key });
  });
  const ids = keys.map(({ keyId }) => keyId);
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) invalidPolicy();
  const trusted = deepFreeze({ ...policy, keys }) as AgentMicrovmLauncherTrustPolicy;
  if (expectedDigest !== undefined && (!SHA256.test(expectedDigest) || sha256Canonical(trusted) !== expectedDigest)) invalidPolicy();
  return trusted;
}

export function verifySignedAgentMicrovmLauncherRelease(
  value: unknown,
  options: Readonly<{
    trustPolicy: unknown;
    trustPolicyDigest: string;
    platformVersion: string;
    launcherDigest: string;
    buildReceiptDigest: string;
    config: unknown;
    configDigest: string;
    now?: Date;
  }>,
): AgentMicrovmLauncherReleaseClaims {
  if (!fixedVersion(options.platformVersion) || !SHA256.test(options.launcherDigest)
    || !SHA256.test(options.buildReceiptDigest) || !SHA256.test(options.configDigest)) invalid();
  const config = parseNativeMicrovmLauncherConfig(options.config);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) invalid();
  const policy = validateAgentMicrovmLauncherTrustPolicy(options.trustPolicy, options.trustPolicyDigest);
  const envelope = record(value);
  exactKeys(envelope, ["keyId", "claims", "signature"]);
  const claims = record(envelope.claims) as unknown as AgentMicrovmLauncherReleaseClaims;
  const key = policy.keys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!key || key.status !== "ACTIVE" || now.getTime() < Date.parse(key.notBefore) || now.getTime() >= Date.parse(key.notAfter)
    || typeof envelope.signature !== "string" || envelope.signature.length < 40 || envelope.signature.length > 512
    || !verifyCanonical(publicKey(key.publicKeySpkiBase64), claims, envelope.signature)) invalid();
  exactKeys(record(claims), [
    "kind", "version", "releaseId", "platformVersion", "sourceRevision", "nodeTarget", "launcherDigest",
    "launcherSizeBytes", "buildReceiptDigest", "configDigest", "firecrackerVersion", "firecrackerDigest",
    "jailerDigest", "kernelDigest", "rootfsDigest", "rootfsReleaseDigest", "rootfsTrustPolicyDigest",
    "mke2fsDigest", "debugfsDigest", "sbomDigest",
    "malwareScanDigest", "vulnerabilityScanDigest", "provenanceDigest", "publishedAt",
  ]);
  const publishedAt = Date.parse(claims.publishedAt);
  if (claims.kind !== "deviludo-agent-microvm-launcher" || claims.version !== 2 || !UUID.test(claims.releaseId)
    || claims.platformVersion !== options.platformVersion || claims.platformVersion !== config.platformVersion
    || !SOURCE_REVISION.test(claims.sourceRevision) || claims.nodeTarget !== "22.13"
    || claims.launcherDigest !== options.launcherDigest || claims.buildReceiptDigest !== options.buildReceiptDigest
    || claims.configDigest !== options.configDigest || !Number.isSafeInteger(claims.launcherSizeBytes)
    || claims.launcherSizeBytes < 1 || claims.launcherSizeBytes > 1024 * 1024 * 1024
    || claims.firecrackerVersion !== config.firecrackerVersion
    || claims.firecrackerDigest !== config.firecrackerDigest || claims.jailerDigest !== config.jailerDigest
    || claims.kernelDigest !== config.kernelDigest || claims.rootfsDigest !== config.rootfsDigest
    || claims.rootfsReleaseDigest !== config.rootfsReleaseDigest
    || claims.rootfsTrustPolicyDigest !== config.rootfsTrustPolicyDigest
    || claims.mke2fsDigest !== config.mke2fsDigest || claims.debugfsDigest !== config.debugfsDigest
    || !SHA256.test(claims.sbomDigest) || !SHA256.test(claims.malwareScanDigest)
    || !SHA256.test(claims.vulnerabilityScanDigest) || !SHA256.test(claims.provenanceDigest)
    || !canonicalTimestamp(claims.publishedAt) || publishedAt > now.getTime() + MAX_CLOCK_SKEW_MS
    || publishedAt < Date.parse(key.notBefore) || publishedAt >= Date.parse(key.notAfter)) invalid();
  return deepFreeze({ ...claims });
}

export function releaseClaimsFromConfig(config: NativeMicrovmLauncherConfig): Readonly<{
  firecrackerVersion: string;
  firecrackerDigest: string;
  jailerDigest: string;
  kernelDigest: string;
  rootfsDigest: string;
  rootfsReleaseDigest: string;
  rootfsTrustPolicyDigest: string;
  mke2fsDigest: string;
  debugfsDigest: string;
}> {
  return Object.freeze({ firecrackerVersion: config.firecrackerVersion, firecrackerDigest: config.firecrackerDigest,
    jailerDigest: config.jailerDigest, kernelDigest: config.kernelDigest, rootfsDigest: config.rootfsDigest,
    rootfsReleaseDigest: config.rootfsReleaseDigest, rootfsTrustPolicyDigest: config.rootfsTrustPolicyDigest,
    mke2fsDigest: config.mke2fsDigest, debugfsDigest: config.debugfsDigest });
}

function publicKey(value: string): KeyObject {
  let bytes: Buffer;
  let key: KeyObject;
  try {
    bytes = Buffer.from(value, "base64");
    if (bytes.length < 32 || bytes.toString("base64") !== value) invalidPolicy();
    key = createPublicKey({ key: bytes, format: "der", type: "spki" });
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
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) invalid();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(): never { throw new Error("Agent microVM launcher release is invalid"); }
function invalidPolicy(): never { throw new Error("Agent microVM launcher trust policy is invalid"); }
