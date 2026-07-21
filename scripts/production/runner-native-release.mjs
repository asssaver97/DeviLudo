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
const COMPONENTS_V1 = Object.freeze(["godot-testkit", "physical-runner"]);
const COMPONENTS_V2 = Object.freeze([...COMPONENTS_V1, "steam-client-connector"]);
const FILE_NAMES = Object.freeze({
  "godot-testkit": "deviludo-testkit",
  "physical-runner": "deviludo-physical-runner",
  "steam-client-connector": "deviludo-steam-client-connector",
});
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
const SIGNER_RESPONSE_KEYS = Object.freeze(["algorithm", "claimsDigest", "keyId", "schemaVersion", "signature"]);

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
  const components = buildComponents(receipt?.schemaVersion);
  if (!plainRecord(receipt) || !exactKeys(receipt, BUILD_KEYS)
    || receipt.status !== "CANDIDATE"
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
    || !Array.isArray(receipt.artifacts) || receipt.artifacts.length !== components.length) invalidReceipt();
  const artifacts = receipt.artifacts.map((artifact) => validateBuildArtifact(artifact, receipt.platform));
  if (JSON.stringify(artifacts.map(({ component }) => component)) !== JSON.stringify(components)) invalidReceipt();
  return Object.freeze({ ...receipt, artifacts: Object.freeze(artifacts) });
}

export function createRunnerNativeReleaseClaims(buildReceipt, {
  releaseId,
  publishedAt,
  artifacts,
} = {}) {
  const build = validateRunnerNativeBuildReceipt(buildReceipt);
  const version = contractVersion(build);
  const claims = {
    schemaVersion: `deviludo.runner-native-release-claims.v${version}`,
    releaseId,
    buildReceiptDigest: sha256Canonical(build),
    platformVersion: build.platformVersion,
    sourceRevision: build.sourceRevision,
    platform: build.platform,
    architecture: build.architecture,
    nodeVersion: build.nodeVersion,
    publishedAt,
    artifacts,
  };
  const published = canonicalTimestamp(publishedAt) ? new Date(publishedAt) : new Date(Number.NaN);
  return validateReleaseClaims(claims, build, published);
}

export function runnerNativeReleaseSigningRequest(claims, buildReceipt) {
  const build = validateRunnerNativeBuildReceipt(buildReceipt);
  const published = canonicalTimestamp(claims?.publishedAt) ? new Date(claims.publishedAt) : new Date(Number.NaN);
  const validated = validateReleaseClaims(claims, build, published);
  const version = contractVersion(build);
  return Object.freeze({
    schemaVersion: `deviludo.runner-native-release-signing-request.v${version}`,
    releaseId: validated.releaseId,
    claimsDigest: sha256Canonical(validated),
    signingInput: Buffer.from(canonicalJson(validated), "utf8").toString("base64url"),
  });
}

export function runnerNativeReleaseFromSigner(claims, response, buildReceipt, policy, expectedPolicyDigest, now = new Date()) {
  const request = runnerNativeReleaseSigningRequest(claims, buildReceipt);
  const version = contractVersion(buildReceipt);
  if (!plainRecord(response) || !exactKeys(response, SIGNER_RESPONSE_KEYS)
    || response.schemaVersion !== `deviludo.runner-native-release-signing-response.v${version}`
    || response.algorithm !== "Ed25519" || response.claimsDigest !== request.claimsDigest
    || typeof response.keyId !== "string" || !SAFE_ID.test(response.keyId)
    || typeof response.signature !== "string") invalidRelease();
  const release = Object.freeze({
    schemaVersion: `deviludo.runner-native-release.v${version}`,
    claims,
    signature: Object.freeze({ algorithm: "Ed25519", keyId: response.keyId, value: response.signature }),
  });
  return verifyRunnerNativeReleaseEnvelope(release, buildReceipt, policy, expectedPolicyDigest, { now }).release;
}

export function verifyRunnerNativeReleaseEnvelope(release, buildReceipt, policy, expectedPolicyDigest, {
  now = new Date(),
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf()) || typeof expectedPolicyDigest !== "string"
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
  return Object.freeze({
    release: Object.freeze({
      schemaVersion: release.schemaVersion,
      claims,
      signature: Object.freeze({ ...release.signature }),
    }),
    claims,
    build,
    signingKeyId: key.keyId,
    releaseDigest: sha256Canonical(release),
    trustPolicyDigest: expectedPolicyDigest,
  });
}

export async function verifyRunnerNativeRelease(release, buildReceipt, policy, expectedPolicyDigest, {
  artifactDirectory,
  now = new Date(),
  inspectIdentity = executeIdentity,
} = {}) {
  if (!absolute(artifactDirectory) || !(now instanceof Date) || !Number.isFinite(now.valueOf())
    || typeof inspectIdentity !== "function" || typeof expectedPolicyDigest !== "string"
    || !SHA256.test(expectedPolicyDigest)) invalidRelease();
  const envelope = verifyRunnerNativeReleaseEnvelope(release, buildReceipt, policy, expectedPolicyDigest, { now });
  const claims = envelope.claims;
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
    schemaVersion: `deviludo.runner-native-install-authorization.v${contractVersion(envelope.build)}`,
    status: "VERIFIED",
    releaseId: claims.releaseId,
    releaseDigest: sha256Canonical(release),
    buildReceiptDigest: claims.buildReceiptDigest,
    trustPolicyDigest: expectedPolicyDigest,
    signingKeyId: envelope.signingKeyId,
    platform: claims.platform,
    architecture: claims.architecture,
    platformVersion: claims.platformVersion,
    sourceRevision: claims.sourceRevision,
    verifiedAt: now.toISOString(),
    artifacts: Object.freeze(verifiedArtifacts),
  });
}

function validateReleaseEnvelope(release, build, now) {
  const version = contractVersion(build);
  if (!plainRecord(release) || !exactKeys(release, RELEASE_KEYS)
    || release.schemaVersion !== `deviludo.runner-native-release.v${version}`
    || !plainRecord(release.signature) || !exactKeys(release.signature, RELEASE_SIGNATURE_KEYS)
    || release.signature.algorithm !== "Ed25519" || typeof release.signature.keyId !== "string"
    || !SAFE_ID.test(release.signature.keyId) || typeof release.signature.value !== "string"
    || !BASE64URL_SIGNATURE.test(release.signature.value)
    || Buffer.from(release.signature.value, "base64url").length !== 64
    || Buffer.from(release.signature.value, "base64url").toString("base64url") !== release.signature.value) invalidRelease();
  return validateReleaseClaims(release.claims, build, now);
}

function validateReleaseClaims(claims, build, now) {
  const version = contractVersion(build);
  const components = buildComponents(build.schemaVersion);
  if (!plainRecord(claims) || !exactKeys(claims, CLAIM_KEYS)
    || claims.schemaVersion !== `deviludo.runner-native-release-claims.v${version}`
    || typeof claims.releaseId !== "string" || !UUID.test(claims.releaseId)
    || claims.buildReceiptDigest !== sha256Canonical(build) || claims.platformVersion !== build.platformVersion
    || claims.sourceRevision !== build.sourceRevision || claims.platform !== build.platform
    || claims.architecture !== build.architecture || claims.nodeVersion !== build.nodeVersion
    || !(now instanceof Date) || !Number.isFinite(now.valueOf())
    || !canonicalTimestamp(claims.publishedAt) || Date.parse(claims.publishedAt) > now.valueOf() + CLOCK_SKEW_MS
    || Date.parse(claims.publishedAt) < Date.parse(build.completedAt)
    || !Array.isArray(claims.artifacts) || claims.artifacts.length !== components.length) invalidRelease();
  const artifacts = claims.artifacts.map((artifact, index) => validateReleaseArtifact(
    artifact, build.artifacts[index], build.platform,
  ));
  return Object.freeze({ ...claims, artifacts: Object.freeze(artifacts) });
}

function validateBuildArtifact(artifact, platform) {
  if (!plainRecord(artifact) || !exactKeys(artifact, BUILD_ARTIFACT_KEYS)
    || !COMPONENTS_V2.includes(artifact.component) || artifact.fileName !== expectedFileName(artifact.component, platform)
    || !SHA256.test(artifact.candidateDigest) || !SHA256.test(artifact.bundleDigest)
    || !SHA256.test(artifact.identityDigest) || !Number.isSafeInteger(artifact.bundleInputCount)
    || artifact.bundleInputCount < 1 || !Number.isSafeInteger(artifact.sizeBytes)
    || artifact.sizeBytes < 1 || artifact.sizeBytes > MAX_ARTIFACT_BYTES) invalidReceipt();
  return Object.freeze({ ...artifact });
}

function buildComponents(schemaVersion) {
  if (schemaVersion === "deviludo.runner-native-build-receipt.v1") return COMPONENTS_V1;
  if (schemaVersion === "deviludo.runner-native-build-receipt.v2") return COMPONENTS_V2;
  invalidReceipt();
}

function contractVersion(buildReceipt) {
  const schemaVersion = buildReceipt?.schemaVersion;
  if (schemaVersion === "deviludo.runner-native-build-receipt.v1") return 1;
  if (schemaVersion === "deviludo.runner-native-build-receipt.v2") return 2;
  invalidReceipt();
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
  const base = FILE_NAMES[component];
  if (!base) invalidRelease();
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
