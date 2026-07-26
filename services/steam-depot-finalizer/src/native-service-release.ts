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
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface SteamDepotFinalizerServiceTrustPolicy {
  readonly schemaVersion: "deviludo.steam-depot-finalizer-service-trust-policy.v1";
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

export interface SteamDepotFinalizerServiceReleaseClaims {
  readonly kind: "deviludo-steam-depot-finalizer-service";
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

export function steamDepotFinalizerServiceTrustPolicyDigest(value: unknown): string {
  return sha256Canonical(validateSteamDepotFinalizerServiceTrustPolicy(value));
}

export function validateSteamDepotFinalizerServiceTrustPolicy(
  value: unknown,
  expectedDigest?: string,
): SteamDepotFinalizerServiceTrustPolicy {
  const source = record(value);
  exactKeys(source, ["schemaVersion", "policyId", "policyRevision", "keys"]);
  if (source.schemaVersion !== "deviludo.steam-depot-finalizer-service-trust-policy.v1"
    || typeof source.policyId !== "string" || !SAFE_ID.test(source.policyId)
    || !Number.isSafeInteger(source.policyRevision) || Number(source.policyRevision) < 1
    || !Array.isArray(source.keys) || source.keys.length < 1 || source.keys.length > 16) invalidPolicy();
  const keys = source.keys.map((candidate) => {
    const key = record(candidate);
    exactKeys(key, ["keyId", "algorithm", "publicKeySpkiBase64", "notBefore", "notAfter", "status"]);
    if (typeof key.keyId !== "string" || !SAFE_ID.test(key.keyId) || key.algorithm !== "Ed25519"
      || typeof key.notBefore !== "string" || !canonicalTimestamp(key.notBefore)
      || typeof key.notAfter !== "string" || !canonicalTimestamp(key.notAfter)
      || Date.parse(key.notBefore) >= Date.parse(key.notAfter)
      || (key.status !== "ACTIVE" && key.status !== "REVOKED")
      || typeof key.publicKeySpkiBase64 !== "string") invalidPolicy();
    publicKey(key.publicKeySpkiBase64);
    return deepFreeze({
      keyId: key.keyId,
      algorithm: "Ed25519" as const,
      publicKeySpkiBase64: key.publicKeySpkiBase64,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
      status: key.status as "ACTIVE" | "REVOKED",
    });
  });
  const ids = keys.map(({ keyId }) => keyId);
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) invalidPolicy();
  const policy = deepFreeze({
    schemaVersion: "deviludo.steam-depot-finalizer-service-trust-policy.v1" as const,
    policyId: source.policyId,
    policyRevision: Number(source.policyRevision),
    keys,
  });
  if (expectedDigest !== undefined && (!SHA256.test(expectedDigest)
    || sha256Canonical(policy) !== expectedDigest)) invalidPolicy();
  return policy;
}

export function verifySignedSteamDepotFinalizerServiceRelease(
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
): SteamDepotFinalizerServiceReleaseClaims {
  if (!fixedVersion(options.platformVersion) || !SHA256.test(options.artifactDigest)
    || !Number.isSafeInteger(options.artifactSizeBytes) || options.artifactSizeBytes < 1
    || options.artifactSizeBytes > MAX_ARTIFACT_BYTES || !SHA256.test(options.buildReceiptDigest)) invalid();
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) invalid();
  const policy = validateSteamDepotFinalizerServiceTrustPolicy(options.trustPolicy, options.trustPolicyDigest);
  const envelope = record(value);
  exactKeys(envelope, ["keyId", "claims", "signature"]);
  const claims = record(envelope.claims);
  exactKeys(claims, [
    "kind", "version", "releaseId", "platformVersion", "sourceRevision", "nodeTarget", "artifactDigest",
    "artifactSizeBytes", "buildReceiptDigest", "packageLockDigest", "bundleInputDigest", "sbomDigest",
    "malwareScanDigest", "vulnerabilityScanDigest", "provenanceDigest", "publishedAt",
  ]);
  const key = policy.keys.find((candidate) => candidate.keyId === envelope.keyId);
  const publishedAt = typeof claims.publishedAt === "string" ? Date.parse(claims.publishedAt) : Number.NaN;
  if (!key || key.status !== "ACTIVE" || now.getTime() < Date.parse(key.notBefore) || now.getTime() >= Date.parse(key.notAfter)
    || typeof envelope.signature !== "string" || envelope.signature.length < 40 || envelope.signature.length > 512
    || !verifyCanonical(publicKey(key.publicKeySpkiBase64), claims, envelope.signature)
    || claims.kind !== "deviludo-steam-depot-finalizer-service" || claims.version !== 1
    || typeof claims.releaseId !== "string" || !UUID.test(claims.releaseId)
    || claims.platformVersion !== options.platformVersion || !fixedVersion(claims.platformVersion)
    || typeof claims.sourceRevision !== "string" || !SOURCE_REVISION.test(claims.sourceRevision)
    || claims.nodeTarget !== "22.13" || claims.artifactDigest !== options.artifactDigest
    || claims.artifactSizeBytes !== options.artifactSizeBytes || claims.buildReceiptDigest !== options.buildReceiptDigest
    || typeof claims.packageLockDigest !== "string" || !SHA256.test(claims.packageLockDigest)
    || typeof claims.bundleInputDigest !== "string" || !SHA256.test(claims.bundleInputDigest)
    || typeof claims.sbomDigest !== "string" || !SHA256.test(claims.sbomDigest)
    || typeof claims.malwareScanDigest !== "string" || !SHA256.test(claims.malwareScanDigest)
    || typeof claims.vulnerabilityScanDigest !== "string" || !SHA256.test(claims.vulnerabilityScanDigest)
    || typeof claims.provenanceDigest !== "string" || !SHA256.test(claims.provenanceDigest)
    || typeof claims.publishedAt !== "string" || !canonicalTimestamp(claims.publishedAt)
    || publishedAt > now.getTime() + MAX_CLOCK_SKEW_MS || publishedAt < Date.parse(key.notBefore)
    || publishedAt >= Date.parse(key.notAfter)) invalid();
  return deepFreeze({ ...claims }) as unknown as SteamDepotFinalizerServiceReleaseClaims;
}

/** Verify the exact executing service bundle before PostgreSQL, TLS or native signing initialization. */
export async function verifySteamDepotFinalizerServiceRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: Readonly<{ executedPath?: string; now?: Date }> = {},
): Promise<SteamDepotFinalizerServiceReleaseClaims | null> {
  if (env.DEVILUDO_LOCAL_TEST_MODE === "1" && env.NODE_ENV !== "production") return null;
  const artifactPath = absolute(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_ARTIFACT_FILE");
  if (resolve(options.executedPath ?? process.argv[1] ?? "") !== artifactPath) invalid();
  const buildReceiptPath = absolute(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_BUILD_RECEIPT_FILE");
  const [artifact, buildReceipt, release, trustPolicy] = await Promise.all([
    hashedFile(artifactPath, MAX_ARTIFACT_BYTES),
    hashedFile(buildReceiptPath, MAX_JSON_BYTES),
    jsonFile(absolute(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_RELEASE_FILE")),
    jsonFile(absolute(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_TRUST_POLICY_FILE")),
  ]);
  const expectedArtifactDigest = digestEnv(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_BINARY_DIGEST");
  const expectedBuildReceiptDigest = digestEnv(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_BUILD_RECEIPT_DIGEST");
  if (artifact.digest !== expectedArtifactDigest || buildReceipt.digest !== expectedBuildReceiptDigest) invalid();
  return verifySignedSteamDepotFinalizerServiceRelease(release, {
    trustPolicy,
    trustPolicyDigest: digestEnv(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_TRUST_POLICY_DIGEST"),
    platformVersion: required(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_VERSION"),
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.sizeBytes,
    buildReceiptDigest: buildReceipt.digest,
    now: options.now,
  });
}

async function jsonFile(path: string): Promise<unknown> {
  const bytes = await boundedFile(path, MAX_JSON_BYTES);
  try { return JSON.parse(bytes.toString("utf8")) as unknown; } catch { invalid(); }
}
async function hashedFile(path: string, maximum: number) {
  const bytes = await boundedFile(path, maximum);
  return Object.freeze({ digest: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength });
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
function publicKey(value: string): KeyObject {
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < 32 || bytes.toString("base64") !== value) invalidPolicy();
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") invalidPolicy();
    return key;
  } catch { invalidPolicy(); }
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
function canonicalTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
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
function invalid(): never { throw new Error("Steam depot finalizer service release is invalid"); }
function invalidPolicy(): never { throw new Error("Steam depot finalizer service trust policy is invalid"); }
