import { createPublicKey, randomUUID, verify } from "node:crypto";
import { open } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isAbsolute, resolve } from "node:path";

import { validateArtifactPreparerImageReceipt } from "./build-artifact-preparer-image.mjs";
import {
  artifactPreparerRuntimeLockDigest,
  validateArtifactPreparerRuntimeLock,
} from "./lock-artifact-preparer-runtime.mjs";
import { canonicalJson, sha256Canonical } from "./control-release-authorization.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IMAGE = /^[a-z0-9][a-z0-9.-]*(?::[0-9]{2,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;
const BASE_IMAGE = /^[a-z0-9][a-z0-9.-]*(?::[0-9]{2,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+:22\.\d+\.\d+-(?:bookworm|trixie)-slim@sha256:[a-f0-9]{64}$/;
const SOURCE = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const BASE64URL = /^[A-Za-z0-9_-]{86}$/;
const CLAIM_KEYS = Object.freeze([
  "authorizationId", "baseImage", "clusterContext", "expiresAt", "imageDigest", "imageReference", "issuedAt",
  "namespace", "platform", "platformVersion", "receiptDigest", "replicas", "runtimeLockDigest", "schemaVersion",
  "sourceRevision", "timeoutSeconds",
]);
const AUTHORIZATION_KEYS = Object.freeze(["claims", "schemaVersion", "signature"]);
const SIGNATURE_KEYS = Object.freeze(["algorithm", "keyId", "value"]);
const POLICY_KEYS = Object.freeze(["keys", "policyId", "policyRevision", "schemaVersion"]);
const POLICY_KEY_KEYS = Object.freeze(["algorithm", "keyId", "notAfter", "notBefore", "publicKeySpkiBase64", "status"]);
const SIGNER_RESPONSE_KEYS = Object.freeze(["algorithm", "claimsDigest", "keyId", "schemaVersion", "signature"]);
const MAX_AUTHORIZATION_SECONDS = 1_800;
const CLOCK_SKEW_MS = 60_000;
const MAX_TLS_FILE_BYTES = 1024 * 1024;

export function artifactPreparerReleaseTrustPolicyDigest(policy) {
  validateArtifactPreparerReleaseTrustPolicy(policy);
  return sha256Canonical(policy);
}

export function validateArtifactPreparerReleaseTrustPolicy(policy, expectedDigest) {
  if (!plainRecord(policy) || !exactKeys(policy, POLICY_KEYS)
    || policy.schemaVersion !== "deviludo.artifact-preparer-release-trust-policy.v1"
    || typeof policy.policyId !== "string" || !SAFE_ID.test(policy.policyId)
    || !Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 1
    || !Array.isArray(policy.keys) || policy.keys.length < 1 || policy.keys.length > 16) invalidPolicy();
  const keyIds = [];
  for (const key of policy.keys) {
    if (!plainRecord(key) || !exactKeys(key, POLICY_KEY_KEYS)
      || key.algorithm !== "Ed25519" || typeof key.keyId !== "string" || !SAFE_ID.test(key.keyId)
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
  if (new Set(keyIds).size !== keyIds.length || JSON.stringify(keyIds) !== JSON.stringify([...keyIds].sort())) invalidPolicy();
  const digest = sha256Canonical(policy);
  if (expectedDigest !== undefined && (!SHA256.test(expectedDigest) || digest !== expectedDigest)) invalidPolicy();
  return Object.freeze({ ...policy, keys: Object.freeze(policy.keys.map((key) => Object.freeze({ ...key }))) });
}

export function createArtifactPreparerReleaseClaims(bundle, clusterContext, {
  authorizationId = randomUUID(), issuedAt = new Date(), ttlSeconds = 900,
} = {}) {
  if (!validReleaseBundle(bundle) || typeof clusterContext !== "string" || !CONTEXT.test(clusterContext)
    || bundle.runtimeLock.clusterContext !== clusterContext || typeof authorizationId !== "string" || !UUID.test(authorizationId)
    || !(issuedAt instanceof Date) || !Number.isFinite(issuedAt.valueOf())
    || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_AUTHORIZATION_SECONDS) invalidAuthorization();
  return Object.freeze({
    schemaVersion: "deviludo.artifact-preparer-release-claims.v1",
    authorizationId,
    receiptDigest: sha256Canonical(bundle.receipt),
    imageReference: bundle.receipt.imageReference,
    imageDigest: bundle.receipt.imageDigest,
    baseImage: bundle.receipt.baseImage,
    sourceRevision: bundle.receipt.sourceRevision,
    platform: bundle.receipt.platform,
    platformVersion: bundle.receipt.platformVersion,
    clusterContext,
    namespace: bundle.namespace,
    replicas: bundle.replicas,
    timeoutSeconds: bundle.timeoutSeconds,
    runtimeLockDigest: artifactPreparerRuntimeLockDigest(bundle.runtimeLock),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.valueOf() + ttlSeconds * 1_000).toISOString(),
  });
}

export function artifactPreparerReleaseSigningRequest(claims) {
  validateClaimsShape(claims);
  return Object.freeze({
    schemaVersion: "deviludo.artifact-preparer-release-signing-request.v1",
    authorizationId: claims.authorizationId,
    claimsDigest: sha256Canonical(claims),
    signingInput: Buffer.from(canonicalJson(claims), "utf8").toString("base64url"),
  });
}

export function artifactPreparerReleaseAuthorizationFromSigner(
  claims, response, bundle, policy, expectedPolicyDigest, now = new Date(),
) {
  if (typeof expectedPolicyDigest !== "string" || !SHA256.test(expectedPolicyDigest)) invalidAuthorization();
  const trusted = validateArtifactPreparerReleaseTrustPolicy(policy, expectedPolicyDigest);
  const request = artifactPreparerReleaseSigningRequest(claims);
  if (!plainRecord(response) || !exactKeys(response, SIGNER_RESPONSE_KEYS)
    || response.schemaVersion !== "deviludo.artifact-preparer-release-signing-response.v1"
    || response.algorithm !== "Ed25519" || response.claimsDigest !== request.claimsDigest
    || typeof response.keyId !== "string" || typeof response.signature !== "string") invalidAuthorization();
  const authorization = Object.freeze({
    schemaVersion: "deviludo.artifact-preparer-release-authorization.v1",
    claims,
    signature: Object.freeze({ algorithm: "Ed25519", keyId: response.keyId, value: response.signature }),
  });
  verifyArtifactPreparerReleaseAuthorization(authorization, trusted, expectedPolicyDigest, {
    bundle, clusterContext: claims.clusterContext, now,
  });
  return authorization;
}

export function verifyArtifactPreparerReleaseAuthorization(authorization, policy, expectedPolicyDigest, {
  bundle, clusterContext, now = new Date(),
} = {}) {
  if (typeof expectedPolicyDigest !== "string" || !SHA256.test(expectedPolicyDigest)) invalidAuthorization();
  const trusted = validateArtifactPreparerReleaseTrustPolicy(policy, expectedPolicyDigest);
  if (!plainRecord(authorization) || !exactKeys(authorization, AUTHORIZATION_KEYS)
    || authorization.schemaVersion !== "deviludo.artifact-preparer-release-authorization.v1"
    || !plainRecord(authorization.signature) || !exactKeys(authorization.signature, SIGNATURE_KEYS)
    || authorization.signature.algorithm !== "Ed25519" || typeof authorization.signature.keyId !== "string"
    || typeof authorization.signature.value !== "string" || !BASE64URL.test(authorization.signature.value)
    || Buffer.from(authorization.signature.value, "base64url").length !== 64
    || Buffer.from(authorization.signature.value, "base64url").toString("base64url") !== authorization.signature.value
    || !(now instanceof Date) || !Number.isFinite(now.valueOf())) invalidAuthorization();
  const { claims, issued, expires } = validateClaimsBinding(authorization.claims, bundle, clusterContext, now);
  const key = trusted.keys.find((candidate) => candidate.keyId === authorization.signature.keyId);
  if (!key || key.status !== "ACTIVE" || issued < Date.parse(key.notBefore) || expires > Date.parse(key.notAfter)) invalidAuthorization();
  const publicKey = createPublicKey({ key: Buffer.from(key.publicKeySpkiBase64, "base64"), format: "der", type: "spki" });
  if (!verify(null, Buffer.from(canonicalJson(claims), "utf8"), publicKey,
    Buffer.from(authorization.signature.value, "base64url"))) invalidAuthorization();
  return Object.freeze({
    authorizationId: claims.authorizationId, keyId: key.keyId, claimsDigest: sha256Canonical(claims),
    expiresAt: claims.expiresAt, trustPolicyDigest: expectedPolicyDigest,
  });
}

export class MtlsArtifactPreparerReleaseSigner {
  constructor({ endpoint, keyId, tls, request = requestSigner }) {
    this.endpoint = signerEndpoint(endpoint);
    if (typeof keyId !== "string" || !SAFE_ID.test(keyId)) invalidSigner();
    this.keyId = keyId; this.tls = validateTls(tls); this.request = request;
  }

  async sign(bundle, claims, policy, expectedPolicyDigest, now = new Date()) {
    const trusted = validateArtifactPreparerReleaseTrustPolicy(policy, expectedPolicyDigest);
    const binding = validateClaimsBinding(claims, bundle, claims?.clusterContext, now);
    const selected = trusted.keys.find((key) => key.keyId === this.keyId);
    if (!selected || selected.status !== "ACTIVE" || binding.issued < Date.parse(selected.notBefore)
      || binding.expires > Date.parse(selected.notAfter)) invalidSigner();
    const signingRequest = artifactPreparerReleaseSigningRequest(claims);
    const response = await this.request({
      url: new URL("/v1/artifact-preparer-releases/sign-ed25519", this.endpoint),
      tls: this.tls,
      headers: Object.freeze({ "content-type": "application/json", "idempotency-key": claims.authorizationId }),
      body: JSON.stringify({ ...signingRequest, keyId: this.keyId }),
    });
    if (response.statusCode !== 200 || response.body?.keyId !== this.keyId) {
      throw new Error("Artifact Preparer release signing Broker rejected the request");
    }
    return artifactPreparerReleaseAuthorizationFromSigner(
      claims, response.body, bundle, trusted, expectedPolicyDigest, now);
  }
}

export async function artifactPreparerReleaseSignerFromEnvironment(env = process.env) {
  const [key, cert, ca] = await Promise.all([
    boundedFile(env.DEVILUDO_ARTIFACT_PREPARER_RELEASE_SIGNER_TLS_KEY_FILE),
    boundedFile(env.DEVILUDO_ARTIFACT_PREPARER_RELEASE_SIGNER_TLS_CERT_FILE),
    boundedFile(env.DEVILUDO_ARTIFACT_PREPARER_RELEASE_SIGNER_TLS_CA_FILE),
  ]);
  return new MtlsArtifactPreparerReleaseSigner({
    endpoint: env.DEVILUDO_ARTIFACT_PREPARER_RELEASE_SIGNER_ENDPOINT,
    keyId: env.DEVILUDO_ARTIFACT_PREPARER_RELEASE_SIGNING_KEY_ID,
    tls: { key, cert, ca },
  });
}

function validateClaimsShape(claims) {
  if (!plainRecord(claims) || !exactKeys(claims, CLAIM_KEYS)
    || claims.schemaVersion !== "deviludo.artifact-preparer-release-claims.v1"
    || typeof claims.authorizationId !== "string" || !UUID.test(claims.authorizationId)
    || typeof claims.receiptDigest !== "string" || !SHA256.test(claims.receiptDigest)
    || typeof claims.imageReference !== "string" || !IMAGE.test(claims.imageReference)
    || typeof claims.imageDigest !== "string" || !SHA256.test(claims.imageDigest)
    || !claims.imageReference.endsWith(`@${claims.imageDigest}`)
    || typeof claims.baseImage !== "string" || !BASE_IMAGE.test(claims.baseImage)
    || typeof claims.sourceRevision !== "string" || !SOURCE.test(claims.sourceRevision)
    || !new Set(["linux/amd64", "linux/arm64"]).has(claims.platform)
    || typeof claims.platformVersion !== "string" || !VERSION.test(claims.platformVersion)
    || typeof claims.clusterContext !== "string" || !CONTEXT.test(claims.clusterContext)
    || typeof claims.namespace !== "string" || !NAMESPACE.test(claims.namespace)
    || !Number.isSafeInteger(claims.replicas) || claims.replicas < 1 || claims.replicas > 10
    || !Number.isSafeInteger(claims.timeoutSeconds) || claims.timeoutSeconds < 60 || claims.timeoutSeconds > 3_600
    || typeof claims.runtimeLockDigest !== "string" || !SHA256.test(claims.runtimeLockDigest)
    || !canonicalTimestamp(claims.issuedAt) || !canonicalTimestamp(claims.expiresAt)) invalidAuthorization();
  return claims;
}

function validateClaimsBinding(value, bundle, clusterContext, now) {
  const claims = validateClaimsShape(value);
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf()) || typeof clusterContext !== "string"
    || !CONTEXT.test(clusterContext) || claims.clusterContext !== clusterContext || !validReleaseBundle(bundle)
    || claims.receiptDigest !== sha256Canonical(bundle.receipt)
    || claims.imageReference !== bundle.receipt.imageReference || claims.imageDigest !== bundle.receipt.imageDigest
    || claims.baseImage !== bundle.receipt.baseImage || claims.sourceRevision !== bundle.receipt.sourceRevision
    || claims.platform !== bundle.receipt.platform || claims.platformVersion !== bundle.receipt.platformVersion
    || claims.namespace !== bundle.namespace || claims.replicas !== bundle.replicas
    || claims.timeoutSeconds !== bundle.timeoutSeconds || bundle.runtimeLock.clusterContext !== clusterContext
    || claims.runtimeLockDigest !== artifactPreparerRuntimeLockDigest(bundle.runtimeLock)) invalidAuthorization();
  const issued = Date.parse(claims.issuedAt); const expires = Date.parse(claims.expiresAt);
  if (expires - issued < 60_000 || expires - issued > MAX_AUTHORIZATION_SECONDS * 1_000
    || issued > now.valueOf() + CLOCK_SKEW_MS || expires <= now.valueOf()) invalidAuthorization();
  return Object.freeze({ claims, issued, expires });
}

function validReleaseBundle(bundle) {
  try {
    validateArtifactPreparerImageReceipt(bundle?.receipt, {
      platformVersion: bundle?.receipt?.platformVersion, dockerfileDigest: bundle?.receipt?.dockerfileDigest,
      packageLockDigest: bundle?.receipt?.packageLockDigest, baseImage: bundle?.receipt?.baseImage,
      sourceRevision: bundle?.receipt?.sourceRevision, platform: bundle?.receipt?.platform,
    });
    validateArtifactPreparerRuntimeLock(bundle?.runtimeLock, {
      clusterContext: bundle?.runtimeLock?.clusterContext, namespace: bundle?.namespace,
    });
  } catch { return false; }
  return plainRecord(bundle) && typeof bundle.namespace === "string" && NAMESPACE.test(bundle.namespace)
    && bundle.runtimeLock.namespace === bundle.namespace
    && Number.isSafeInteger(bundle.replicas) && bundle.replicas >= 1 && bundle.replicas <= 10
    && Number.isSafeInteger(bundle.timeoutSeconds) && bundle.timeoutSeconds >= 60 && bundle.timeoutSeconds <= 3_600;
}

function exactKeys(value, keys) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function plainRecord(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function decodeCanonicalBase64(value) { if (typeof value !== "string" || value.length < 16 || value.length > 1_024
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) invalidPolicy();
  const decoded = Buffer.from(value, "base64"); if (decoded.toString("base64") !== value) invalidPolicy(); return decoded; }
function signerEndpoint(value) { let url; try { url = new URL(value); } catch { invalidSigner(); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(url.hostname)
    || !new Set(["", "443", "8443"]).has(url.port)) invalidSigner(); return url; }
function validateTls(tls) { if (!plainRecord(tls) || !Buffer.isBuffer(tls.key) || !Buffer.isBuffer(tls.cert)
    || !Buffer.isBuffer(tls.ca) || [tls.key, tls.cert, tls.ca]
      .some((value) => value.length < 32 || value.length > MAX_TLS_FILE_BYTES)) invalidSigner();
  return Object.freeze({ key: Buffer.from(tls.key), cert: Buffer.from(tls.cert), ca: Buffer.from(tls.ca) }); }
async function boundedFile(path) { if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) invalidSigner();
  let file; try { file = await open(path, "r"); const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_TLS_FILE_BYTES || (metadata.mode & 0o022) !== 0) invalidSigner();
    const value = await file.readFile(); if (value.includes(0)) invalidSigner(); return value;
  } catch { invalidSigner(); } finally { await file?.close().catch(() => undefined); } }
async function requestSigner(input) { return new Promise((accept, reject) => {
  const request = httpsRequest(input.url, { method: "POST", key: input.tls.key, cert: input.tls.cert, ca: input.tls.ca,
    minVersion: "TLSv1.3", rejectUnauthorized: true,
    headers: { ...input.headers, "content-length": Buffer.byteLength(input.body) }, timeout: 10_000 }, (response) => {
    if (response.headers["content-type"] !== "application/json") { response.resume();
      reject(new Error("Artifact Preparer release signing response content type is invalid")); return; }
    const chunks = []; let length = 0;
    response.on("data", (chunk) => { length += chunk.length;
      if (length > 16_384) request.destroy(new Error("Artifact Preparer release signing response is too large"));
      else chunks.push(chunk); });
    response.on("end", () => { let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { reject(new Error("Artifact Preparer release signing response is invalid")); return; }
      accept({ statusCode: response.statusCode ?? 0, body }); });
  });
  request.once("timeout", () => request.destroy(new Error("Artifact Preparer release signing request timed out")));
  request.once("error", reject); request.end(input.body);
}); }
function invalidPolicy() { throw new Error("Artifact Preparer release trust policy is invalid"); }
function invalidAuthorization() { throw new Error("Artifact Preparer release authorization is invalid"); }
function invalidSigner() { throw new Error("Artifact Preparer release signing configuration is invalid"); }
