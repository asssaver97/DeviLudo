import { execFile } from "node:child_process";
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
const NODE_VERSION = /^v22\.\d+\.\d+$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_IDENTITY_BYTES = 16 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const SIGNING_SCHEMES = Object.freeze({
  windows: "authenticode-sha256",
  linux: "sigstore-cosign",
  macos: "developer-id-notarized",
} as const);

export type SteamDepotFinalizerNativePlatform = keyof typeof SIGNING_SCHEMES;

export interface SteamDepotFinalizerNativeTrustPolicy {
  readonly schemaVersion: "deviludo.steam-depot-finalizer-native-trust-policy.v1";
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

export interface SteamDepotFinalizerNativeReleaseClaims {
  readonly schemaVersion: "deviludo.steam-depot-finalizer-native-release-claims.v1";
  readonly releaseId: string;
  readonly platformVersion: string;
  readonly sourceRevision: string;
  readonly platform: SteamDepotFinalizerNativePlatform;
  readonly architecture: "x86_64" | "arm64";
  readonly nodeVersion: string;
  readonly artifactDigest: string;
  readonly artifactSizeBytes: number;
  readonly buildReceiptDigest: string;
  readonly identityDigest: string;
  readonly nativeSignature: Readonly<{
    scheme: "authenticode-sha256" | "sigstore-cosign" | "developer-id-notarized";
    signerIdentity: string;
    evidenceDigest: string;
    transparencyLogDigest: string | null;
    notarizationDigest: string | null;
  }>;
  readonly publishedAt: string;
}

export interface SteamDepotFinalizerNativeRelease {
  readonly schemaVersion: "deviludo.steam-depot-finalizer-native-release.v1";
  readonly claims: SteamDepotFinalizerNativeReleaseClaims;
  readonly signature: Readonly<{ algorithm: "Ed25519"; keyId: string; value: string }>;
}

export function steamDepotFinalizerNativeTrustPolicyDigest(value: unknown): string {
  return sha256Canonical(validateSteamDepotFinalizerNativeTrustPolicy(value));
}

export function validateSteamDepotFinalizerNativeTrustPolicy(
  value: unknown,
  expectedDigest?: string,
): SteamDepotFinalizerNativeTrustPolicy {
  const source = record(value);
  exactKeys(source, ["schemaVersion", "policyId", "policyRevision", "keys"]);
  if (source.schemaVersion !== "deviludo.steam-depot-finalizer-native-trust-policy.v1"
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
    schemaVersion: "deviludo.steam-depot-finalizer-native-trust-policy.v1" as const,
    policyId: source.policyId,
    policyRevision: Number(source.policyRevision),
    keys,
  });
  if (expectedDigest !== undefined && (!SHA256.test(expectedDigest)
    || sha256Canonical(policy) !== expectedDigest)) invalidPolicy();
  return policy;
}

export function verifySignedSteamDepotFinalizerNativeRelease(
  value: unknown,
  options: Readonly<{
    trustPolicy: unknown;
    trustPolicyDigest: string;
    platformVersion: string;
    platform: SteamDepotFinalizerNativePlatform;
    artifactDigest: string;
    artifactSizeBytes: number;
    buildReceiptDigest: string;
    now?: Date;
  }>,
): SteamDepotFinalizerNativeRelease {
  const now = options.now ?? new Date();
  if (!fixedVersion(options.platformVersion) || !SIGNING_SCHEMES[options.platform]
    || !SHA256.test(options.artifactDigest) || !SHA256.test(options.buildReceiptDigest)
    || !Number.isSafeInteger(options.artifactSizeBytes) || options.artifactSizeBytes < 1
    || options.artifactSizeBytes > MAX_ARTIFACT_BYTES || !Number.isFinite(now.getTime())) invalid();
  const policy = validateSteamDepotFinalizerNativeTrustPolicy(options.trustPolicy, options.trustPolicyDigest);
  const envelope = record(value);
  exactKeys(envelope, ["schemaVersion", "claims", "signature"]);
  if (envelope.schemaVersion !== "deviludo.steam-depot-finalizer-native-release.v1") invalid();
  const signature = record(envelope.signature);
  exactKeys(signature, ["algorithm", "keyId", "value"]);
  if (signature.algorithm !== "Ed25519" || typeof signature.keyId !== "string" || !SAFE_ID.test(signature.keyId)
    || typeof signature.value !== "string" || signature.value.length !== 86) invalid();
  const claims = releaseClaims(envelope.claims, options);
  const key = policy.keys.find((candidate) => candidate.keyId === signature.keyId);
  const publishedAt = Date.parse(claims.publishedAt);
  if (!key || key.status !== "ACTIVE" || publishedAt > now.getTime() + MAX_CLOCK_SKEW_MS
    || publishedAt < Date.parse(key.notBefore) || publishedAt >= Date.parse(key.notAfter)
    || now.getTime() < Date.parse(key.notBefore) || now.getTime() >= Date.parse(key.notAfter)
    || !verifyCanonical(publicKey(key.publicKeySpkiBase64), claims, signature.value)) invalid();
  return deepFreeze({
    schemaVersion: "deviludo.steam-depot-finalizer-native-release.v1" as const,
    claims,
    signature: { algorithm: "Ed25519" as const, keyId: signature.keyId, value: signature.value },
  });
}

/** Verifies the controller's independent release and embedded SEA identity before any probe or signing operation. */
export async function verifySteamDepotFinalizerNativeRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: Readonly<{ inspectIdentity?: typeof executeIdentity; now?: Date }> = {},
): Promise<SteamDepotFinalizerNativeRelease> {
  const artifactPath = absolute(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE");
  const buildReceiptPath = absolute(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_BUILD_RECEIPT_FILE");
  const [artifact, buildReceipt, releaseValue, trustPolicy] = await Promise.all([
    hashedFile(artifactPath, MAX_ARTIFACT_BYTES),
    hashedFile(buildReceiptPath, MAX_JSON_BYTES),
    jsonFile(absolute(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_RELEASE_FILE")),
    jsonFile(absolute(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_TRUST_POLICY_FILE")),
  ]);
  const platform = platformValue(required(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_PLATFORM"));
  if (artifact.digest !== digestEnv(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE_DIGEST")
    || buildReceipt.digest !== digestEnv(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_BUILD_RECEIPT_DIGEST")) invalid();
  const release = verifySignedSteamDepotFinalizerNativeRelease(releaseValue, {
    trustPolicy,
    trustPolicyDigest: digestEnv(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_TRUST_POLICY_DIGEST"),
    platformVersion: required(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_VERSION"),
    platform,
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.sizeBytes,
    buildReceiptDigest: buildReceipt.digest,
    now: dependencies.now,
  });
  const identity = await (dependencies.inspectIdentity ?? executeIdentity)(artifactPath);
  validateIdentity(identity, release.claims);
  return release;
}

function releaseClaims(
  value: unknown,
  expected: Readonly<{
    platformVersion: string;
    platform: SteamDepotFinalizerNativePlatform;
    artifactDigest: string;
    artifactSizeBytes: number;
    buildReceiptDigest: string;
  }>,
): SteamDepotFinalizerNativeReleaseClaims {
  const claims = record(value);
  exactKeys(claims, [
    "schemaVersion", "releaseId", "platformVersion", "sourceRevision", "platform", "architecture", "nodeVersion",
    "artifactDigest", "artifactSizeBytes", "buildReceiptDigest", "identityDigest", "nativeSignature", "publishedAt",
  ]);
  const platform = platformValue(claims.platform);
  const nativeSignature = signatureEvidence(claims.nativeSignature, platform);
  if (claims.schemaVersion !== "deviludo.steam-depot-finalizer-native-release-claims.v1"
    || typeof claims.releaseId !== "string" || !UUID.test(claims.releaseId)
    || claims.platformVersion !== expected.platformVersion || !fixedVersion(claims.platformVersion)
    || typeof claims.sourceRevision !== "string" || !SOURCE_REVISION.test(claims.sourceRevision)
    || platform !== expected.platform || (claims.architecture !== "x86_64" && claims.architecture !== "arm64")
    || typeof claims.nodeVersion !== "string" || !NODE_VERSION.test(claims.nodeVersion)
    || claims.artifactDigest !== expected.artifactDigest || claims.artifactSizeBytes !== expected.artifactSizeBytes
    || claims.buildReceiptDigest !== expected.buildReceiptDigest || typeof claims.identityDigest !== "string"
    || !SHA256.test(claims.identityDigest) || typeof claims.publishedAt !== "string"
    || !canonicalTimestamp(claims.publishedAt)) invalid();
  return deepFreeze({
    schemaVersion: "deviludo.steam-depot-finalizer-native-release-claims.v1" as const,
    releaseId: claims.releaseId,
    platformVersion: claims.platformVersion,
    sourceRevision: claims.sourceRevision,
    platform,
    architecture: claims.architecture,
    nodeVersion: claims.nodeVersion,
    artifactDigest: claims.artifactDigest,
    artifactSizeBytes: claims.artifactSizeBytes,
    buildReceiptDigest: claims.buildReceiptDigest,
    identityDigest: claims.identityDigest,
    nativeSignature,
    publishedAt: claims.publishedAt,
  });
}

function signatureEvidence(value: unknown, platform: SteamDepotFinalizerNativePlatform) {
  const evidence = record(value);
  exactKeys(evidence, ["scheme", "signerIdentity", "evidenceDigest", "transparencyLogDigest", "notarizationDigest"]);
  if (evidence.scheme !== SIGNING_SCHEMES[platform] || typeof evidence.signerIdentity !== "string"
    || !SAFE_ID.test(evidence.signerIdentity) || typeof evidence.evidenceDigest !== "string"
    || !SHA256.test(evidence.evidenceDigest)) invalid();
  const transparencyLogDigest = nullableDigest(evidence.transparencyLogDigest);
  const notarizationDigest = nullableDigest(evidence.notarizationDigest);
  if (platform === "linux" ? transparencyLogDigest === null || notarizationDigest !== null
    : platform === "macos" ? notarizationDigest === null || transparencyLogDigest !== null
      : transparencyLogDigest !== null || notarizationDigest !== null) invalid();
  return deepFreeze({
    scheme: SIGNING_SCHEMES[platform],
    signerIdentity: evidence.signerIdentity,
    evidenceDigest: evidence.evidenceDigest,
    transparencyLogDigest,
    notarizationDigest,
  });
}

function validateIdentity(value: unknown, claims: SteamDepotFinalizerNativeReleaseClaims): void {
  const identity = record(value);
  exactKeys(identity, [
    "schemaVersion", "component", "platformVersion", "sourceRevision", "nodeVersion", "platform", "architecture",
  ]);
  const expectedPlatform = claims.platform === "macos" ? "darwin" : claims.platform === "windows" ? "win32" : "linux";
  const expectedArchitecture = claims.architecture === "x86_64" ? "x64" : "arm64";
  if (identity.schemaVersion !== "deviludo.native-component-identity.v1"
    || identity.component !== "steam-depot-finalizer-controller" || identity.platformVersion !== claims.platformVersion
    || identity.sourceRevision !== claims.sourceRevision || identity.nodeVersion !== claims.nodeVersion
    || identity.platform !== expectedPlatform || identity.architecture !== expectedArchitecture
    || sha256Canonical(identity) !== claims.identityDigest) invalid();
}

function executeIdentity(executable: string): Promise<unknown> {
  return new Promise((accept, reject) => execFile(executable, ["--identity"], {
    encoding: "utf8", env: { NODE_ENV: "production" }, shell: false, windowsHide: true,
    timeout: 10_000, maxBuffer: MAX_IDENTITY_BYTES,
  }, (error, stdout, stderr) => {
    if (error || stderr || Buffer.byteLength(stdout) > MAX_IDENTITY_BYTES) { reject(new Error("Native identity failed")); return; }
    try { accept(JSON.parse(stdout) as unknown); } catch { reject(new Error("Native identity failed")); }
  }));
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
    const value = await file.readFile(); const after = await file.stat();
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
function platformValue(value: unknown): SteamDepotFinalizerNativePlatform {
  if (value !== "windows" && value !== "linux" && value !== "macos") invalid();
  return value;
}
function nullableDigest(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !SHA256.test(value)) invalid();
  return value;
}
function canonicalTimestamp(value: string): boolean { return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function fixedVersion(value: unknown): value is string { return typeof value === "string" && VERSION.test(value) && !/(latest|stable|default)/i.test(value); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void { if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) invalid(); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
function invalid(): never { throw new Error("Steam depot finalizer native release is invalid"); }
function invalidPolicy(): never { throw new Error("Steam depot finalizer native trust policy is invalid"); }
