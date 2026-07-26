import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { sha256Canonical, verifyCanonical } from "../../runner-control/src/canonical";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

export interface AgentExecutionWorkerNativeTrustPolicy {
  readonly schemaVersion: "deviludo.agent-execution-worker-native-trust-policy.v1";
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

export interface AgentExecutionWorkerNativeReleaseClaims {
  readonly kind: "deviludo-agent-execution-worker-native";
  readonly version: 1;
  readonly releaseId: string;
  readonly platformVersion: string;
  readonly sourceRevision: string;
  readonly nodeTarget: "22.13";
  readonly artifactDigest: string;
  readonly artifactSizeBytes: number;
  readonly buildReceiptDigest: string;
  readonly packageLockDigest: string;
  readonly bundleInputDigest: string;
  readonly sbomDigest: string;
  readonly malwareScanDigest: string;
  readonly vulnerabilityScanDigest: string;
  readonly provenanceDigest: string;
  readonly publishedAt: string;
}

export interface SignedAgentExecutionWorkerNativeRelease {
  readonly keyId: string;
  readonly claims: AgentExecutionWorkerNativeReleaseClaims;
  readonly signature: string;
}

export function agentExecutionWorkerNativeTrustPolicyDigest(value: unknown): string {
  return sha256Canonical(validateAgentExecutionWorkerNativeTrustPolicy(value));
}

export function validateAgentExecutionWorkerNativeTrustPolicy(
  value: unknown,
  expectedDigest?: string,
): AgentExecutionWorkerNativeTrustPolicy {
  const policy = record(value) as unknown as AgentExecutionWorkerNativeTrustPolicy;
  exactKeys(record(policy), ["schemaVersion", "policyId", "policyRevision", "keys"]);
  if (policy.schemaVersion !== "deviludo.agent-execution-worker-native-trust-policy.v1"
    || !SAFE_ID.test(policy.policyId) || !Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 1
    || !Array.isArray(policy.keys) || policy.keys.length < 1 || policy.keys.length > 16) invalidPolicy();
  const keys = policy.keys.map((candidate) => {
    const key = record(candidate) as unknown as AgentExecutionWorkerNativeTrustPolicy["keys"][number];
    exactKeys(record(key), ["keyId", "algorithm", "publicKeySpkiBase64", "notBefore", "notAfter", "status"]);
    if (!SAFE_ID.test(key.keyId) || key.algorithm !== "Ed25519" || !canonicalTimestamp(key.notBefore)
      || !canonicalTimestamp(key.notAfter) || Date.parse(key.notBefore) >= Date.parse(key.notAfter)
      || (key.status !== "ACTIVE" && key.status !== "REVOKED") || typeof key.publicKeySpkiBase64 !== "string") invalidPolicy();
    publicKey(key.publicKeySpkiBase64);
    return deepFreeze({ ...key });
  });
  const ids = keys.map(({ keyId }) => keyId);
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) invalidPolicy();
  const trusted = deepFreeze({ ...policy, keys }) as AgentExecutionWorkerNativeTrustPolicy;
  if (expectedDigest !== undefined && (!SHA256.test(expectedDigest)
    || sha256Canonical(trusted) !== expectedDigest)) invalidPolicy();
  return trusted;
}

export function verifySignedAgentExecutionWorkerNativeRelease(
  value: unknown,
  options: Readonly<{
    trustPolicy: unknown;
    trustPolicyDigest: string;
    platformVersion: string;
    artifactDigest: string;
    artifactSizeBytes: number;
    buildReceiptDigest: string;
    now?: Date;
  }>,
): AgentExecutionWorkerNativeReleaseClaims {
  if (!fixedVersion(options.platformVersion) || !SHA256.test(options.artifactDigest)
    || !Number.isSafeInteger(options.artifactSizeBytes) || options.artifactSizeBytes < 1
    || options.artifactSizeBytes > MAX_ARTIFACT_BYTES || !SHA256.test(options.buildReceiptDigest)) invalid();
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) invalid();
  const policy = validateAgentExecutionWorkerNativeTrustPolicy(options.trustPolicy, options.trustPolicyDigest);
  const envelope = record(value);
  exactKeys(envelope, ["keyId", "claims", "signature"]);
  const claims = record(envelope.claims) as unknown as AgentExecutionWorkerNativeReleaseClaims;
  const key = policy.keys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!key || key.status !== "ACTIVE" || now.getTime() < Date.parse(key.notBefore) || now.getTime() >= Date.parse(key.notAfter)
    || typeof envelope.signature !== "string" || envelope.signature.length < 40 || envelope.signature.length > 512
    || !verifyCanonical(publicKey(key.publicKeySpkiBase64), claims, envelope.signature)) invalid();
  exactKeys(record(claims), [
    "kind", "version", "releaseId", "platformVersion", "sourceRevision", "nodeTarget", "artifactDigest",
    "artifactSizeBytes", "buildReceiptDigest", "packageLockDigest", "bundleInputDigest", "sbomDigest",
    "malwareScanDigest", "vulnerabilityScanDigest", "provenanceDigest", "publishedAt",
  ]);
  const publishedAt = Date.parse(claims.publishedAt);
  if (claims.kind !== "deviludo-agent-execution-worker-native" || claims.version !== 1 || !UUID.test(claims.releaseId)
    || claims.platformVersion !== options.platformVersion || !fixedVersion(claims.platformVersion)
    || !SOURCE_REVISION.test(claims.sourceRevision) || claims.nodeTarget !== "22.13"
    || claims.artifactDigest !== options.artifactDigest || claims.artifactSizeBytes !== options.artifactSizeBytes
    || claims.buildReceiptDigest !== options.buildReceiptDigest || !SHA256.test(claims.packageLockDigest)
    || !SHA256.test(claims.bundleInputDigest) || !SHA256.test(claims.sbomDigest)
    || !SHA256.test(claims.malwareScanDigest) || !SHA256.test(claims.vulnerabilityScanDigest)
    || !SHA256.test(claims.provenanceDigest) || !canonicalTimestamp(claims.publishedAt)
    || publishedAt > now.getTime() + MAX_CLOCK_SKEW_MS || publishedAt < Date.parse(key.notBefore)
    || publishedAt >= Date.parse(key.notAfter)) invalid();
  return deepFreeze({ ...claims });
}

/** Verifies the exact executing bundle before any network client or database pool is created. */
export async function verifyAgentExecutionWorkerNativeRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: Readonly<{ executedPath?: string; now?: Date }> = {},
): Promise<AgentExecutionWorkerNativeReleaseClaims | null> {
  if (env.DEVILUDO_LOCAL_TEST_MODE === "1" && env.NODE_ENV !== "production") return null;
  const artifactPath = absolute(env, "DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_ARTIFACT_FILE");
  const executedPath = resolve(options.executedPath ?? process.argv[1] ?? "");
  if (executedPath !== artifactPath) invalid();
  const buildReceiptPath = absolute(env, "DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_BUILD_RECEIPT_FILE");
  const [artifact, buildReceipt, release, trustPolicy] = await Promise.all([
    hashedFile(artifactPath, MAX_ARTIFACT_BYTES),
    hashedFile(buildReceiptPath, MAX_JSON_BYTES),
    jsonFile(absolute(env, "DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_RELEASE_FILE")),
    jsonFile(absolute(env, "DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_TRUST_POLICY_FILE")),
  ]);
  const expectedArtifactDigest = digestEnv(env, "DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_ARTIFACT_DIGEST");
  const expectedBuildReceiptDigest = digestEnv(env, "DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_BUILD_RECEIPT_DIGEST");
  if (artifact.digest !== expectedArtifactDigest || buildReceipt.digest !== expectedBuildReceiptDigest) invalid();
  return verifySignedAgentExecutionWorkerNativeRelease(release, {
    trustPolicy,
    trustPolicyDigest: digestEnv(env, "DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_TRUST_POLICY_DIGEST"),
    platformVersion: required(env, "DEVILUDO_PLATFORM_VERSION"),
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.sizeBytes,
    buildReceiptDigest: buildReceipt.digest,
    now: options.now,
  });
}

async function jsonFile(path: string): Promise<unknown> {
  const bytes = await boundedFile(path, MAX_JSON_BYTES);
  try { return JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
}

async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > maximum || (before.mode & 0o022) !== 0) invalid();
    const value = await file.readFile();
    const after = await file.stat();
    if (value.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return value;
  } finally { await file.close(); }
}

async function hashedFile(path: string, maximum: number): Promise<Readonly<{ digest: string; sizeBytes: number }>> {
  const bytes = await boundedFile(path, maximum);
  return Object.freeze({ digest: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength });
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

function absolute(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || value.includes("\0")) invalid();
  return value;
}
function digestEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name); if (!SHA256.test(value)) invalid(); return value;
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim(); if (!value) invalid(); return value;
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
function invalid(): never { throw new Error("Agent execution Worker native release is invalid"); }
function invalidPolicy(): never { throw new Error("Agent execution Worker native trust policy is invalid"); }
