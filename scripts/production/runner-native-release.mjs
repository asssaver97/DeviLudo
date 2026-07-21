import { createHash, createPublicKey, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NODE_VERSION = /^v22\.\d+\.\d+$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_IDENTITY_BYTES = 16 * 1024;
const CLOCK_SKEW_MS = 60_000;
const COMPONENTS = Object.freeze(["godot-testkit", "physical-runner"]);
const BUILD_KEYS = Object.freeze([
  "architecture", "artifacts", "completedAt", "esbuildBinaryDigest", "esbuildLibraryDigest", "esbuildVersion", "nodeBinaryDigest", "nodeVersion",
  "packageLockDigest", "platform", "platformVersion", "postjectCliDigest", "postjectVersion", "schemaVersion",
  "signatureState", "sourceRevision", "status",
]);
const BUILD_ARTIFACT_KEYS = Object.freeze([
  "bundleDigest", "bundleInputCount", "candidateDigest", "component", "fileName", "identityDigest", "sizeBytes",
]);
const POLICY_KEYS = Object.freeze(["keys", "policyId", "policyRevision", "schemaVersion"]);
const POLICY_KEY_KEYS = Object.freeze([
  "algorithm", "keyId", "notAfter", "notBefore", "publicKeySpkiBase64", "status",
]);
const RELEASE_KEYS = Object.freeze(["claims", "schemaVersion", "signature"]);
const RELEASE_SIGNATURE_KEYS = Object.freeze(["algorithm", "keyId", "value"]);
const CLAIM_KEYS = Object.freeze([
  "architecture", "artifacts", "buildReceiptDigest", "nodeVersion", "platform", "platformVersion", "publishedAt",
  "releaseId", "schemaVersion", "sourceRevision",
]);
const RELEASE_ARTIFACT_KEYS = Object.freeze([
  "candidateDigest", "component", "fileName", "nativeSignature", "releasedDigest", "sizeBytes",
]);
const NATIVE_SIGNATURE_KEYS = Object.freeze([
  "evidenceDigest", "notarizationDigest", "scheme", "signerIdentity", "transparencyLogDigest",
]);

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function runnerNativeTrustPolicyDigest(policy) {
  validateRunnerNativeTrustPolicy(policy);
  return sha256Canonical(policy);
}

export function validateRunnerNativeTrustPolicy(policy, expectedDigest) {
  if (!plainRecord(policy) || !exactKeys(policy, POLICY_KEYS)
    || policy.schemaVersion !== "deviludo.runner-native-trust-policy.v1"
    || typeof policy.policyId !== "string" || !SAFE_ID.test(policy.policyId)
    || !Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 1
    || !Array.isArray(policy.keys) || policy.keys.length < 1 || policy.keys.length > 16) invalidPolicy();
  const keyIds = [];
  for (const key of policy.keys) {
    if (!plainRecord(key) || !exactKeys(key, POLICY_KEY_KEYS) || key.algorithm !== "Ed25519"
      || typeof key.keyId !== "string" || !SAFE_ID.test(key.keyId)
      || !new Set(["ACTIVE", "REVOKED"]).has(key.status)
      || !canonicalTimestamp(key.notBefore) || !canonicalTimestamp(key.notAfter)
      || Date.parse(key.notBefore) >= Date.parse(key.notAfter)
      || typeof key.publicKeySpkiBase64 !== "string") invalidPolicy();
    const der = decodeCanonicalBase64(key.publicKeySpkiBase64);
    let publicKey;
    try { publicKey = createPublicKey({ key: der, format: "der", type: "spki" }); } catch { invalidPolicy(); }
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") invalidPolicy();
    keyIds.push(key.keyId);
  }
  if (new Set(keyIds).size !== keyIds.length
    || JSON.stringify(keyIds) !== JSON.stringify([...keyIds].sort())) invalidPolicy();
  const digest = sha256Canonical(policy);
  if (expectedDigest !== undefined && (!SHA256.test(expectedDigest) || digest !== expectedDigest)) invalidPolicy();
  return Object.freeze({
    ...policy,
    keys: Object.freeze(policy.keys.map((key) => Object.freeze({ ...key }))),
  });
}

export function validateRunnerNativeBuildReceipt(receipt) {
  if (!plainRecord(receipt) || !exactKeys(receipt, BUILD_KEYS)
    || receipt.schemaVersion !== "deviludo.runner-native-build-receipt.v1" || receipt.status !== "CANDIDATE"
    || typeof receipt.platformVersion !== "string" || !VERSION.test(receipt.platformVersion)
    || typeof receipt.sourceRevision !== "string" || !SOURCE_REVISION.test(receipt.sourceRevision)
    || !new Set(["windows", "linux", "macos"]).has(receipt.platform)
    || !new Set(["x86_64", "arm64"]).has(receipt.architecture)
    || typeof receipt.nodeVersion !== "string" || !NODE_VERSION.test(receipt.nodeVersion)
    || !SHA256.test(receipt.nodeBinaryDigest) || !SHA256.test(receipt.packageLockDigest)
    || receipt.esbuildVersion !== "0.28.0" || !SHA256.test(receipt.esbuildLibraryDigest)
    || !SHA256.test(receipt.esbuildBinaryDigest) || receipt.postjectVersion !== "1.0.0-alpha.6"
    || !SHA256.test(receipt.postjectCliDigest) || !canonicalTimestamp(receipt.completedAt)
    || receipt.signatureState !== expectedCandidateSignatureState(receipt.platform)
    || !Array.isArray(receipt.artifacts) || receipt.artifacts.length !== COMPONENTS.length) invalidReceipt();
  const artifacts = receipt.artifacts.map((artifact) => validateBuildArtifact(artifact, receipt.platform));
  if (JSON.stringify(artifacts.map(({ component }) => component)) !== JSON.stringify(COMPONENTS)) invalidReceipt();
  return Object.freeze({ ...receipt, artifacts: Object.freeze(artifacts) });
}

export async function verifyRunnerNativeRelease(release, buildReceipt, policy, expectedPolicyDigest, {
  artifactDirectory,
  now = new Date(),
  inspectIdentity = executeIdentity,
} = {}) {
  if (!absolute(artifactDirectory) || !(now instanceof Date) || !Number.isFinite(now.valueOf())
    || typeof inspectIdentity !== "function" || typeof expectedPolicyDigest !== "string"
    || !SHA256.test(expectedPolicyDigest)) invalidRelease();
  const build = validateRunnerNativeBuildReceipt(buildReceipt);
  const trusted = validateRunnerNativeTrustPolicy(policy, expectedPolicyDigest);
  const claims = validateReleaseEnvelope(release, build, now);
  const key = trusted.keys.find((candidate) => candidate.keyId === release.signature.keyId);
  const publishedAt = Date.parse(claims.publishedAt);
  if (!key || key.status !== "ACTIVE" || publishedAt < Date.parse(key.notBefore)
    || publishedAt >= Date.parse(key.notAfter)) invalidRelease();
  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKeySpkiBase64, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verify(null, Buffer.from(canonicalJson(claims), "utf8"), publicKey,
    Buffer.from(release.signature.value, "base64url"))) invalidRelease();
  const target = nativeHostTarget();
  if (claims.platform !== target.platform || claims.architecture !== target.architecture) invalidRelease();

  const directoryMetadata = await lstat(artifactDirectory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) invalidRelease();
  const verifiedArtifacts = [];
  for (const artifact of claims.artifacts) {
    const artifactPath = resolve(artifactDirectory, artifact.fileName);
    if (resolve(artifactPath) !== artifactPath || artifactPath === artifactDirectory) invalidRelease();
    const metadata = await fileMetadata(artifactPath);
    if (metadata.digest !== artifact.releasedDigest || metadata.sizeBytes !== artifact.sizeBytes) invalidRelease();
    const identity = await inspectIdentity(Object.freeze({ artifactPath, artifact }));
    validateIdentity(identity, artifact, claims);
    verifiedArtifacts.push(Object.freeze({
      component: artifact.component,
      fileName: artifact.fileName,
      releasedDigest: artifact.releasedDigest,
      identityDigest: sha256Canonical(identity),
    }));
  }
  return Object.freeze({
    schemaVersion: "deviludo.runner-native-install-authorization.v1",
    status: "VERIFIED",
    releaseId: claims.releaseId,
    releaseDigest: sha256Canonical(release),
    buildReceiptDigest: claims.buildReceiptDigest,
    trustPolicyDigest: expectedPolicyDigest,
    signingKeyId: key.keyId,
    platform: claims.platform,
    architecture: claims.architecture,
    platformVersion: claims.platformVersion,
    sourceRevision: claims.sourceRevision,
    verifiedAt: now.toISOString(),
    artifacts: Object.freeze(verifiedArtifacts),
  });
}

function validateReleaseEnvelope(release, build, now) {
  if (!plainRecord(release) || !exactKeys(release, RELEASE_KEYS)
    || release.schemaVersion !== "deviludo.runner-native-release.v1"
    || !plainRecord(release.signature) || !exactKeys(release.signature, RELEASE_SIGNATURE_KEYS)
    || release.signature.algorithm !== "Ed25519" || typeof release.signature.keyId !== "string"
    || !SAFE_ID.test(release.signature.keyId) || typeof release.signature.value !== "string"
    || !BASE64URL_SIGNATURE.test(release.signature.value)
    || Buffer.from(release.signature.value, "base64url").length !== 64
    || Buffer.from(release.signature.value, "base64url").toString("base64url") !== release.signature.value) invalidRelease();
  const claims = release.claims;
  if (!plainRecord(claims) || !exactKeys(claims, CLAIM_KEYS)
    || claims.schemaVersion !== "deviludo.runner-native-release-claims.v1"
    || typeof claims.releaseId !== "string" || !UUID.test(claims.releaseId)
    || claims.buildReceiptDigest !== sha256Canonical(build) || claims.platformVersion !== build.platformVersion
    || claims.sourceRevision !== build.sourceRevision || claims.platform !== build.platform
    || claims.architecture !== build.architecture || claims.nodeVersion !== build.nodeVersion
    || !canonicalTimestamp(claims.publishedAt) || Date.parse(claims.publishedAt) > now.valueOf() + CLOCK_SKEW_MS
    || Date.parse(claims.publishedAt) < Date.parse(build.completedAt)
    || !Array.isArray(claims.artifacts) || claims.artifacts.length !== COMPONENTS.length) invalidRelease();
  const artifacts = claims.artifacts.map((artifact, index) => validateReleaseArtifact(
    artifact, build.artifacts[index], build.platform,
  ));
  return Object.freeze({ ...claims, artifacts: Object.freeze(artifacts) });
}

function validateBuildArtifact(artifact, platform) {
  if (!plainRecord(artifact) || !exactKeys(artifact, BUILD_ARTIFACT_KEYS)
    || !COMPONENTS.includes(artifact.component) || artifact.fileName !== expectedFileName(artifact.component, platform)
    || !SHA256.test(artifact.candidateDigest) || !SHA256.test(artifact.bundleDigest)
    || !SHA256.test(artifact.identityDigest) || !Number.isSafeInteger(artifact.bundleInputCount)
    || artifact.bundleInputCount < 1 || !Number.isSafeInteger(artifact.sizeBytes)
    || artifact.sizeBytes < 1 || artifact.sizeBytes > MAX_ARTIFACT_BYTES) invalidReceipt();
  return Object.freeze({ ...artifact });
}

function validateReleaseArtifact(artifact, candidate, platform) {
  if (!plainRecord(artifact) || !exactKeys(artifact, RELEASE_ARTIFACT_KEYS)
    || artifact.component !== candidate.component || artifact.fileName !== candidate.fileName
    || artifact.fileName !== expectedFileName(artifact.component, platform)
    || artifact.candidateDigest !== candidate.candidateDigest || !SHA256.test(artifact.releasedDigest)
    || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1 || artifact.sizeBytes > MAX_ARTIFACT_BYTES) {
    invalidRelease();
  }
  validateNativeSignature(artifact.nativeSignature, platform);
  return Object.freeze({ ...artifact, nativeSignature: Object.freeze({ ...artifact.nativeSignature }) });
}

function validateNativeSignature(signature, platform) {
  if (!plainRecord(signature) || !exactKeys(signature, NATIVE_SIGNATURE_KEYS)
    || typeof signature.signerIdentity !== "string" || !SAFE_ID.test(signature.signerIdentity)
    || !SHA256.test(signature.evidenceDigest)
    || signature.transparencyLogDigest !== null && !SHA256.test(signature.transparencyLogDigest)
    || signature.notarizationDigest !== null && !SHA256.test(signature.notarizationDigest)) invalidRelease();
  const valid = platform === "macos"
    ? signature.scheme === "DEVELOPER_ID_NOTARIZED" && SHA256.test(signature.notarizationDigest)
      && signature.transparencyLogDigest === null
    : platform === "windows"
      ? signature.scheme === "AUTHENTICODE" && signature.notarizationDigest === null
        && signature.transparencyLogDigest === null
      : signature.scheme === "SIGSTORE_BUNDLE" && SHA256.test(signature.transparencyLogDigest)
        && signature.notarizationDigest === null;
  if (!valid) invalidRelease();
}

function validateIdentity(identity, artifact, claims) {
  if (!plainRecord(identity) || !exactKeys(identity, [
    "architecture", "component", "nodeVersion", "platform", "platformVersion", "schemaVersion", "sourceRevision",
  ]) || identity.schemaVersion !== "deviludo.native-component-identity.v1"
    || identity.component !== artifact.component || identity.platformVersion !== claims.platformVersion
    || identity.sourceRevision !== claims.sourceRevision || identity.nodeVersion !== claims.nodeVersion
    || identity.platform !== hostPlatformName(claims.platform) || identity.architecture !== hostArchitectureName(claims.architecture)) {
    invalidRelease();
  }
  return identity;
}

async function executeIdentity({ artifactPath }) {
  const output = await executeCapture(artifactPath, ["--identity"]);
  let identity;
  try { identity = JSON.parse(output); } catch { invalidRelease(); }
  return identity;
}

function executeCapture(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    let length = 0;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_IDENTITY_BYTES) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && signal === null && length <= MAX_IDENTITY_BYTES) {
        accept(Buffer.concat(chunks).toString("utf8"));
      } else reject(new Error("Runner native identity inspection failed"));
    });
  });
}

async function fileMetadata(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1
    || metadata.size > MAX_ARTIFACT_BYTES) invalidRelease();
  const body = await readFile(path);
  return Object.freeze({
    digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    sizeBytes: body.length,
  });
}

function nativeHostTarget() {
  return Object.freeze({ platform: targetPlatform(process.platform), architecture: targetArchitecture(process.arch) });
}

function targetPlatform(platform) {
  const value = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;
  if (!new Set(["windows", "linux", "macos"]).has(value)) invalidRelease();
  return value;
}

function targetArchitecture(architecture) {
  const value = architecture === "x64" ? "x86_64" : architecture;
  if (!new Set(["x86_64", "arm64"]).has(value)) invalidRelease();
  return value;
}

function hostPlatformName(platform) {
  return platform === "macos" ? "darwin" : platform === "windows" ? "win32" : "linux";
}

function hostArchitectureName(architecture) {
  return architecture === "x86_64" ? "x64" : "arm64";
}

function expectedFileName(component, platform) {
  const base = component === "godot-testkit" ? "deviludo-testkit" : "deviludo-physical-runner";
  return `${base}${platform === "windows" ? ".exe" : ""}`;
}

function expectedCandidateSignatureState(platform) {
  return platform === "macos" ? "ADHOC_BUILD_ONLY"
    : platform === "windows" ? "INVALIDATED_UPSTREAM_SIGNATURE" : "UNSIGNED";
}

function canonicalize(value) {
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") invalidRelease();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (plainRecord(value)) return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalize(child)]));
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number" && Number.isSafeInteger(value)) return value;
  invalidRelease();
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length < 16 || value.length > 1_024
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) invalidPolicy();
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.length < 32 || decoded.length > 512) invalidPolicy();
  return decoded;
}

function canonicalTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function absolute(value) {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096;
}

function invalidPolicy() {
  throw new Error("Runner native trust policy is invalid");
}

function invalidReceipt() {
  throw new Error("Runner native build receipt is invalid");
}

function invalidRelease() {
  throw new Error("Runner native release is invalid");
}
