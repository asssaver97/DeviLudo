import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { sha256Canonical, verifyCanonical } from "../../runner-control/src/canonical";
import { isBuiltInAdapterVersion } from "../../../lib/agent/adapter-registry";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface AgentMicrovmGuestTrustPolicy {
  readonly schemaVersion: "deviludo.agent-microvm-guest-trust-policy.v1";
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

export interface AgentMicrovmGuestReleaseClaims {
  readonly kind: "deviludo-agent-microvm-guest";
  readonly version: 1;
  readonly releaseId: string;
  readonly platformVersion: string;
  readonly sourceRevision: string;
  readonly agent: "claude-code" | "codex-cli";
  readonly exactAgentVersion: string;
  readonly adapterVersion: string;
  readonly workerImageDigest: string;
  readonly rootfsFormat: "squashfs";
  readonly rootfsDigest: string;
  readonly rootfsSizeBytes: number;
  readonly buildReceiptDigest: string;
  readonly sourceDateEpoch: number;
  readonly sbomDigest: string;
  readonly malwareScanDigest: string;
  readonly vulnerabilityScanDigest: string;
  readonly secretScanDigest: string;
  readonly provenanceDigest: string;
  readonly embeddedSecrets: false;
  readonly selfUpdateDisabled: true;
  readonly publishedAt: string;
}

export function agentMicrovmGuestTrustPolicyDigest(value: unknown): string {
  return sha256Canonical(validateAgentMicrovmGuestTrustPolicy(value));
}

export function validateAgentMicrovmGuestTrustPolicy(
  value: unknown,
  expectedDigest?: string,
): AgentMicrovmGuestTrustPolicy {
  const policy = record(value) as unknown as AgentMicrovmGuestTrustPolicy;
  exactKeys(record(policy), ["schemaVersion", "policyId", "policyRevision", "keys"]);
  if (policy.schemaVersion !== "deviludo.agent-microvm-guest-trust-policy.v1"
    || !SAFE_ID.test(policy.policyId) || !Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 1
    || !Array.isArray(policy.keys) || policy.keys.length < 1 || policy.keys.length > 16) invalidPolicy();
  const keys = policy.keys.map((candidate) => {
    const key = record(candidate) as unknown as AgentMicrovmGuestTrustPolicy["keys"][number];
    exactKeys(record(key), ["keyId", "algorithm", "publicKeySpkiBase64", "notBefore", "notAfter", "status"]);
    if (!SAFE_ID.test(key.keyId) || key.algorithm !== "Ed25519" || !canonicalTimestamp(key.notBefore)
      || !canonicalTimestamp(key.notAfter) || Date.parse(key.notBefore) >= Date.parse(key.notAfter)
      || (key.status !== "ACTIVE" && key.status !== "REVOKED") || typeof key.publicKeySpkiBase64 !== "string") invalidPolicy();
    publicKey(key.publicKeySpkiBase64);
    return deepFreeze({ ...key });
  });
  const ids = keys.map(({ keyId }) => keyId);
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) invalidPolicy();
  const trusted = deepFreeze({ ...policy, keys }) as AgentMicrovmGuestTrustPolicy;
  if (expectedDigest !== undefined && (!SHA256.test(expectedDigest) || sha256Canonical(trusted) !== expectedDigest)) invalidPolicy();
  return trusted;
}

export function verifySignedAgentMicrovmGuestRelease(
  value: unknown,
  options: Readonly<{
    trustPolicy: unknown;
    trustPolicyDigest: string;
    platformVersion: string;
    rootfsDigest: string;
    releaseDigest?: string;
    releaseBytes?: Buffer;
    now?: Date;
  }>,
): AgentMicrovmGuestReleaseClaims {
  if (!fixedVersion(options.platformVersion) || !SHA256.test(options.rootfsDigest)
    || (options.releaseDigest !== undefined && !SHA256.test(options.releaseDigest))
    || (options.releaseDigest !== undefined && (!options.releaseBytes
      || createHash("sha256").update(options.releaseBytes).digest("hex") !== options.releaseDigest))) invalid();
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) invalid();
  const policy = validateAgentMicrovmGuestTrustPolicy(options.trustPolicy, options.trustPolicyDigest);
  const envelope = record(value);
  exactKeys(envelope, ["keyId", "claims", "signature"]);
  const claims = record(envelope.claims) as unknown as AgentMicrovmGuestReleaseClaims;
  const key = policy.keys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!key || key.status !== "ACTIVE" || now.getTime() < Date.parse(key.notBefore) || now.getTime() >= Date.parse(key.notAfter)
    || typeof envelope.signature !== "string" || envelope.signature.length < 40 || envelope.signature.length > 512
    || !verifyCanonical(publicKey(key.publicKeySpkiBase64), claims, envelope.signature)) invalid();
  exactKeys(record(claims), [
    "kind", "version", "releaseId", "platformVersion", "sourceRevision", "agent", "exactAgentVersion",
    "adapterVersion", "workerImageDigest", "rootfsFormat", "rootfsDigest", "rootfsSizeBytes",
    "buildReceiptDigest", "sourceDateEpoch", "sbomDigest", "malwareScanDigest", "vulnerabilityScanDigest",
    "secretScanDigest", "provenanceDigest", "embeddedSecrets", "selfUpdateDisabled", "publishedAt",
  ]);
  const publishedAt = Date.parse(claims.publishedAt);
  if (claims.kind !== "deviludo-agent-microvm-guest" || claims.version !== 1 || !UUID.test(claims.releaseId)
    || claims.platformVersion !== options.platformVersion || !SOURCE_REVISION.test(claims.sourceRevision)
    || (claims.agent !== "claude-code" && claims.agent !== "codex-cli")
    || !fixedVersion(claims.exactAgentVersion) || !fixedVersion(claims.adapterVersion)
    || !isBuiltInAdapterVersion(claims.agent, claims.adapterVersion)
    || !IMAGE_DIGEST.test(claims.workerImageDigest) || claims.rootfsFormat !== "squashfs"
    || claims.rootfsDigest !== options.rootfsDigest || !Number.isSafeInteger(claims.rootfsSizeBytes)
    || claims.rootfsSizeBytes < 1024 || claims.rootfsSizeBytes > 64 * 1024 * 1024 * 1024
    || !SHA256.test(claims.buildReceiptDigest) || !Number.isSafeInteger(claims.sourceDateEpoch)
    || claims.sourceDateEpoch < 1_577_836_800 || claims.sourceDateEpoch > 4_102_444_800
    || !SHA256.test(claims.sbomDigest) || !SHA256.test(claims.malwareScanDigest)
    || !SHA256.test(claims.vulnerabilityScanDigest) || !SHA256.test(claims.secretScanDigest)
    || !SHA256.test(claims.provenanceDigest) || claims.embeddedSecrets !== false
    || claims.selfUpdateDisabled !== true || !canonicalTimestamp(claims.publishedAt)
    || publishedAt > now.getTime() + MAX_CLOCK_SKEW_MS || publishedAt < Date.parse(key.notBefore)
    || publishedAt >= Date.parse(key.notAfter)) invalid();
  return deepFreeze({ ...claims });
}

export async function verifyConfiguredAgentMicrovmGuestRelease(input: Readonly<{
  releaseFile: string;
  releaseDigest: string;
  trustPolicyFile: string;
  trustPolicyDigest: string;
  platformVersion: string;
  rootfsDigest: string;
  now?: Date;
}>): Promise<AgentMicrovmGuestReleaseClaims> {
  const [releaseBytes, trustPolicyBytes] = await Promise.all([
    boundedFile(input.releaseFile, 1024 * 1024), boundedFile(input.trustPolicyFile, 1024 * 1024),
  ]);
  let release: unknown; let trustPolicy: unknown;
  try { release = JSON.parse(releaseBytes.toString("utf8")); trustPolicy = JSON.parse(trustPolicyBytes.toString("utf8")); }
  catch { invalid(); }
  return verifySignedAgentMicrovmGuestRelease(release, { trustPolicy, trustPolicyDigest: input.trustPolicyDigest,
    platformVersion: input.platformVersion, rootfsDigest: input.rootfsDigest,
    releaseDigest: input.releaseDigest, releaseBytes, ...(input.now ? { now: input.now } : {}) });
}

async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > maximum || (before.mode & 0o022) !== 0) invalid();
    const bytes = await file.readFile(); const after = await file.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return bytes;
  } finally { await file.close(); }
}

function publicKey(value: string): KeyObject {
  let bytes: Buffer; let key: KeyObject;
  try { bytes = Buffer.from(value, "base64"); if (bytes.length < 32 || bytes.toString("base64") !== value) invalidPolicy();
    key = createPublicKey({ key: bytes, format: "der", type: "spki" }); } catch { invalidPolicy(); }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") invalidPolicy();
  return key;
}
function canonicalTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function fixedVersion(value: unknown): value is string { return typeof value === "string" && VERSION.test(value) && !/(?:latest|stable|default)/i.test(value); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void { if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) invalid(); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
function invalid(): never { throw new Error("Agent microVM guest release is invalid"); }
function invalidPolicy(): never { throw new Error("Agent microVM guest trust policy is invalid"); }
