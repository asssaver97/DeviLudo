import { createPublicKey, randomUUID, verify } from "node:crypto";
import { open } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isAbsolute, resolve } from "node:path";

import { validateSteamWorkflowExecutorImageReceipt } from "./build-steam-workflow-executor-image.mjs";
import {
  steamWorkflowExecutorRuntimeLockDigest,
  validateSteamWorkflowExecutorRuntimeLock,
} from "./lock-steam-workflow-executor-runtime.mjs";
import { canonicalJson, sha256Canonical } from "./control-release-authorization.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IMAGE = /^[a-z0-9][a-z0-9.-]*(?::[0-9]{2,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;
const VERSIONED_IMAGE = /^[a-z0-9][a-z0-9.-]*(?::[0-9]{2,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?@sha256:[a-f0-9]{64}$/;
const SOURCE = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const BASE64URL = /^[A-Za-z0-9_-]{86}$/;
const POLICY_KEYS = Object.freeze(["keys", "policyId", "policyRevision", "schemaVersion"]);
const POLICY_KEY_KEYS = Object.freeze(["algorithm", "keyId", "notAfter", "notBefore", "publicKeySpkiBase64", "status"]);
const CLAIM_KEYS = Object.freeze([
  "authorizationId", "clusterContext", "expiresAt", "imageDigest", "imageReference", "issuedAt",
  "namespace", "nativePublisherImage", "nodeBaseImage", "platform", "platformVersion", "receiptDigest",
  "replicas", "runtimeLockDigest", "schemaVersion", "sourceRevision", "timeoutSeconds",
]);
const AUTHORIZATION_KEYS = Object.freeze(["claims", "schemaVersion", "signature"]);
const SIGNATURE_KEYS = Object.freeze(["algorithm", "keyId", "value"]);
const SIGNER_RESPONSE_KEYS = Object.freeze(["algorithm", "claimsDigest", "keyId", "schemaVersion", "signature"]);
const MAX_AUTHORIZATION_SECONDS = 1_800;
const CLOCK_SKEW_MS = 60_000;
const MAX_TLS_BYTES = 1024 * 1024;

export function steamWorkflowExecutorReleaseTrustPolicyDigest(policy) {
  validateSteamWorkflowExecutorReleaseTrustPolicy(policy);
  return sha256Canonical(policy);
}

export function validateSteamWorkflowExecutorReleaseTrustPolicy(policy, expectedDigest) {
  if (!plainRecord(policy) || !exactKeys(policy, POLICY_KEYS)
    || policy.schemaVersion !== "deviludo.steam-workflow-executor-release-trust-policy.v1"
    || typeof policy.policyId !== "string" || !SAFE_ID.test(policy.policyId)
    || !Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 1
    || !Array.isArray(policy.keys) || policy.keys.length < 1 || policy.keys.length > 16) invalidPolicy();
  const ids = [];
  for (const key of policy.keys) {
    if (!plainRecord(key) || !exactKeys(key, POLICY_KEY_KEYS) || key.algorithm !== "Ed25519"
      || typeof key.keyId !== "string" || !SAFE_ID.test(key.keyId) || !new Set(["ACTIVE", "REVOKED"]).has(key.status)
      || !canonicalTimestamp(key.notBefore) || !canonicalTimestamp(key.notAfter)
      || Date.parse(key.notBefore) >= Date.parse(key.notAfter) || typeof key.publicKeySpkiBase64 !== "string") invalidPolicy();
    let publicKey;
    try {
      const bytes = Buffer.from(key.publicKeySpkiBase64, "base64");
      if (bytes.toString("base64") !== key.publicKeySpkiBase64) invalidPolicy();
      publicKey = createPublicKey({ key: bytes, format: "der", type: "spki" });
    } catch { invalidPolicy(); }
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") invalidPolicy();
    ids.push(key.keyId);
  }
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) invalidPolicy();
  const digest = sha256Canonical(policy);
  if (expectedDigest !== undefined && (!SHA256.test(expectedDigest) || digest !== expectedDigest)) invalidPolicy();
  return Object.freeze({ ...policy, keys: Object.freeze(policy.keys.map((key) => Object.freeze({ ...key }))) });
}

export function createSteamWorkflowExecutorReleaseClaims(bundle, clusterContext, {
  authorizationId = randomUUID(), issuedAt = new Date(), ttlSeconds = 900,
} = {}) {
  if (!validBundle(bundle) || typeof clusterContext !== "string" || !CONTEXT.test(clusterContext)
    || bundle.runtimeLock.clusterContext !== clusterContext || !UUID.test(authorizationId)
    || !(issuedAt instanceof Date) || !Number.isFinite(issuedAt.valueOf())
    || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_AUTHORIZATION_SECONDS) invalidAuthorization();
  return Object.freeze({
    schemaVersion: "deviludo.steam-workflow-executor-release-claims.v1",
    authorizationId,
    receiptDigest: sha256Canonical(bundle.receipt),
    imageReference: bundle.receipt.imageReference,
    imageDigest: bundle.receipt.imageDigest,
    nodeBaseImage: bundle.receipt.nodeBaseImage,
    nativePublisherImage: bundle.receipt.nativePublisherImage,
    sourceRevision: bundle.receipt.sourceRevision,
    platform: bundle.receipt.platform,
    platformVersion: bundle.receipt.platformVersion,
    clusterContext,
    namespace: bundle.namespace,
    replicas: bundle.replicas,
    timeoutSeconds: bundle.timeoutSeconds,
    runtimeLockDigest: steamWorkflowExecutorRuntimeLockDigest(bundle.runtimeLock),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.valueOf() + ttlSeconds * 1_000).toISOString(),
  });
}

export function steamWorkflowExecutorReleaseSigningRequest(claims) {
  validateClaims(claims);
  return Object.freeze({
    schemaVersion: "deviludo.steam-workflow-executor-release-signing-request.v1",
    authorizationId: claims.authorizationId,
    claimsDigest: sha256Canonical(claims),
    signingInput: Buffer.from(canonicalJson(claims)).toString("base64url"),
  });
}

export function verifySteamWorkflowExecutorReleaseAuthorization(authorization, policy, policyDigest, {
  bundle, clusterContext, now = new Date(),
} = {}) {
  const trusted = validateSteamWorkflowExecutorReleaseTrustPolicy(policy, policyDigest);
  if (!plainRecord(authorization) || !exactKeys(authorization, AUTHORIZATION_KEYS)
    || authorization.schemaVersion !== "deviludo.steam-workflow-executor-release-authorization.v1"
    || !plainRecord(authorization.signature) || !exactKeys(authorization.signature, SIGNATURE_KEYS)
    || authorization.signature.algorithm !== "Ed25519" || typeof authorization.signature.keyId !== "string"
    || typeof authorization.signature.value !== "string" || !BASE64URL.test(authorization.signature.value)
    || Buffer.from(authorization.signature.value, "base64url").toString("base64url") !== authorization.signature.value
    || !(now instanceof Date) || !Number.isFinite(now.valueOf())) invalidAuthorization();
  const binding = validateClaimsBinding(authorization.claims, bundle, clusterContext, now);
  const key = trusted.keys.find((candidate) => candidate.keyId === authorization.signature.keyId);
  if (!key || key.status !== "ACTIVE" || binding.issued < Date.parse(key.notBefore)
    || binding.expires > Date.parse(key.notAfter)) invalidAuthorization();
  const publicKey = createPublicKey({ key: Buffer.from(key.publicKeySpkiBase64, "base64"), format: "der", type: "spki" });
  if (!verify(null, Buffer.from(canonicalJson(binding.claims)), publicKey,
    Buffer.from(authorization.signature.value, "base64url"))) invalidAuthorization();
  return Object.freeze({
    authorizationId: binding.claims.authorizationId,
    keyId: key.keyId,
    claimsDigest: sha256Canonical(binding.claims),
    expiresAt: binding.claims.expiresAt,
    trustPolicyDigest: policyDigest,
  });
}

export class MtlsSteamWorkflowExecutorReleaseSigner {
  constructor({ endpoint, keyId, tls, request = requestSigner }) {
    this.endpoint = signerEndpoint(endpoint);
    if (typeof keyId !== "string" || !SAFE_ID.test(keyId)) invalidSigner();
    this.keyId = keyId; this.tls = validateTls(tls); this.request = request;
  }
  async sign(bundle, claims, policy, policyDigest, now = new Date()) {
    const trusted = validateSteamWorkflowExecutorReleaseTrustPolicy(policy, policyDigest);
    const binding = validateClaimsBinding(claims, bundle, claims?.clusterContext, now);
    const key = trusted.keys.find((candidate) => candidate.keyId === this.keyId);
    if (!key || key.status !== "ACTIVE" || binding.issued < Date.parse(key.notBefore)
      || binding.expires > Date.parse(key.notAfter)) invalidSigner();
    const request = steamWorkflowExecutorReleaseSigningRequest(claims);
    const response = await this.request({
      url: new URL("/v1/steam-workflow-executor-releases/sign-ed25519", this.endpoint),
      tls: this.tls,
      headers: Object.freeze({ "content-type": "application/json", "idempotency-key": claims.authorizationId }),
      body: JSON.stringify({ ...request, keyId: this.keyId }),
    });
    if (response.statusCode !== 200 || !plainRecord(response.body) || !exactKeys(response.body, SIGNER_RESPONSE_KEYS)
      || response.body.schemaVersion !== "deviludo.steam-workflow-executor-release-signing-response.v1"
      || response.body.algorithm !== "Ed25519" || response.body.keyId !== this.keyId
      || response.body.claimsDigest !== request.claimsDigest || typeof response.body.signature !== "string") invalidSigner();
    const authorization = Object.freeze({
      schemaVersion: "deviludo.steam-workflow-executor-release-authorization.v1",
      claims,
      signature: Object.freeze({ algorithm: "Ed25519", keyId: this.keyId, value: response.body.signature }),
    });
    verifySteamWorkflowExecutorReleaseAuthorization(authorization, trusted, policyDigest,
      { bundle, clusterContext: claims.clusterContext, now });
    return authorization;
  }
}

export async function steamWorkflowExecutorReleaseSignerFromEnvironment(env = process.env) {
  const [key, cert, ca] = await Promise.all([
    tlsFile(env.DEVILUDO_STEAM_WORKFLOW_EXECUTOR_RELEASE_SIGNER_TLS_KEY_FILE),
    tlsFile(env.DEVILUDO_STEAM_WORKFLOW_EXECUTOR_RELEASE_SIGNER_TLS_CERT_FILE),
    tlsFile(env.DEVILUDO_STEAM_WORKFLOW_EXECUTOR_RELEASE_SIGNER_TLS_CA_FILE),
  ]);
  return new MtlsSteamWorkflowExecutorReleaseSigner({
    endpoint: env.DEVILUDO_STEAM_WORKFLOW_EXECUTOR_RELEASE_SIGNER_ENDPOINT,
    keyId: env.DEVILUDO_STEAM_WORKFLOW_EXECUTOR_RELEASE_SIGNING_KEY_ID,
    tls: { key, cert, ca },
  });
}

function validateClaims(claims) {
  if (!plainRecord(claims) || !exactKeys(claims, CLAIM_KEYS)
    || claims.schemaVersion !== "deviludo.steam-workflow-executor-release-claims.v1"
    || !UUID.test(claims.authorizationId) || !SHA256.test(claims.receiptDigest)
    || !IMAGE.test(claims.imageReference) || !SHA256.test(claims.imageDigest)
    || !claims.imageReference.endsWith(`@${claims.imageDigest}`)
    || !VERSIONED_IMAGE.test(claims.nodeBaseImage) || !VERSIONED_IMAGE.test(claims.nativePublisherImage)
    || !SOURCE.test(claims.sourceRevision) || !new Set(["linux/amd64", "linux/arm64"]).has(claims.platform)
    || !VERSION.test(claims.platformVersion) || !CONTEXT.test(claims.clusterContext) || !NAMESPACE.test(claims.namespace)
    || !Number.isSafeInteger(claims.replicas) || claims.replicas < 1 || claims.replicas > 10
    || !Number.isSafeInteger(claims.timeoutSeconds) || claims.timeoutSeconds < 60 || claims.timeoutSeconds > 3_600
    || !SHA256.test(claims.runtimeLockDigest) || !canonicalTimestamp(claims.issuedAt)
    || !canonicalTimestamp(claims.expiresAt)) invalidAuthorization();
  return claims;
}
function validateClaimsBinding(value, bundle, clusterContext, now) {
  const claims = validateClaims(value);
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf()) || !CONTEXT.test(clusterContext)
    || claims.clusterContext !== clusterContext || !validBundle(bundle)
    || claims.receiptDigest !== sha256Canonical(bundle.receipt) || claims.imageReference !== bundle.receipt.imageReference
    || claims.imageDigest !== bundle.receipt.imageDigest || claims.nodeBaseImage !== bundle.receipt.nodeBaseImage
    || claims.nativePublisherImage !== bundle.receipt.nativePublisherImage
    || claims.sourceRevision !== bundle.receipt.sourceRevision || claims.platform !== bundle.receipt.platform
    || claims.platformVersion !== bundle.receipt.platformVersion || claims.namespace !== bundle.namespace
    || claims.replicas !== bundle.replicas || claims.timeoutSeconds !== bundle.timeoutSeconds
    || bundle.runtimeLock.clusterContext !== clusterContext
    || claims.runtimeLockDigest !== steamWorkflowExecutorRuntimeLockDigest(bundle.runtimeLock)) invalidAuthorization();
  const issued = Date.parse(claims.issuedAt); const expires = Date.parse(claims.expiresAt);
  if (expires - issued < 60_000 || expires - issued > MAX_AUTHORIZATION_SECONDS * 1_000
    || issued > now.valueOf() + CLOCK_SKEW_MS || expires <= now.valueOf()) invalidAuthorization();
  return Object.freeze({ claims, issued, expires });
}
function validBundle(bundle) {
  try {
    validateSteamWorkflowExecutorImageReceipt(bundle?.receipt, {
      platformVersion: bundle?.receipt?.platformVersion, dockerfileDigest: bundle?.receipt?.dockerfileDigest,
      packageLockDigest: bundle?.receipt?.packageLockDigest, nodeBaseImage: bundle?.receipt?.nodeBaseImage,
      nativePublisherImage: bundle?.receipt?.nativePublisherImage,
      sourceRevision: bundle?.receipt?.sourceRevision, platform: bundle?.receipt?.platform,
    });
    validateSteamWorkflowExecutorRuntimeLock(bundle?.runtimeLock, {
      clusterContext: bundle?.runtimeLock?.clusterContext, namespace: bundle?.namespace,
    });
  } catch { return false; }
  return plainRecord(bundle) && NAMESPACE.test(bundle.namespace) && bundle.runtimeLock.namespace === bundle.namespace
    && Number.isSafeInteger(bundle.replicas) && bundle.replicas >= 1 && bundle.replicas <= 10
    && Number.isSafeInteger(bundle.timeoutSeconds) && bundle.timeoutSeconds >= 60 && bundle.timeoutSeconds <= 3_600;
}
function signerEndpoint(value) { let url; try { url = new URL(value); } catch { invalidSigner(); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(url.hostname)
    || !new Set(["", "443", "8443"]).has(url.port)) invalidSigner(); return url; }
function validateTls(tls) { if (!plainRecord(tls) || !Buffer.isBuffer(tls.key) || !Buffer.isBuffer(tls.cert)
    || !Buffer.isBuffer(tls.ca) || [tls.key, tls.cert, tls.ca].some((value) => value.length < 32 || value.length > MAX_TLS_BYTES)) invalidSigner();
  return Object.freeze({ key: Buffer.from(tls.key), cert: Buffer.from(tls.cert), ca: Buffer.from(tls.ca) }); }
async function tlsFile(path) { if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) invalidSigner();
  const file = await open(path, "r"); try { const stat = await file.stat();
    if (!stat.isFile() || stat.size < 32 || stat.size > MAX_TLS_BYTES || (stat.mode & 0o022) !== 0) invalidSigner();
    const value = await file.readFile(); if (value.includes(0)) invalidSigner(); return value; } finally { await file.close(); } }
function requestSigner(input) { return new Promise((accept, reject) => {
  const request = httpsRequest(input.url, { method: "POST", key: input.tls.key, cert: input.tls.cert, ca: input.tls.ca,
    minVersion: "TLSv1.3", rejectUnauthorized: true,
    headers: { ...input.headers, "content-length": Buffer.byteLength(input.body) }, timeout: 10_000 }, (response) => {
    if (response.headers["content-type"] !== "application/json") { response.resume(); reject(new Error("Steam executor signing response is invalid")); return; }
    const chunks = []; let length = 0;
    response.on("data", (chunk) => { length += chunk.length; if (length > 16_384) request.destroy(new Error("Steam executor signing response is invalid")); else chunks.push(chunk); });
    response.on("end", () => { try { accept({ statusCode: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
      catch { reject(new Error("Steam executor signing response is invalid")); } });
  });
  request.once("timeout", () => request.destroy(new Error("Steam executor signing request timed out")));
  request.once("error", reject); request.end(input.body);
}); }
function exactKeys(value, keys) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function plainRecord(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function invalidPolicy() { throw new Error("Steam workflow executor release trust policy is invalid"); }
function invalidAuthorization() { throw new Error("Steam workflow executor release authorization is invalid"); }
function invalidSigner() { throw new Error("Steam workflow executor release signing configuration is invalid"); }
