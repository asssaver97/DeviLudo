import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isAbsolute, resolve } from "node:path";

import {
  createRunnerNativeReleaseClaims,
  runnerNativeReleaseFromSigner,
  runnerNativeReleaseSigningRequest,
  validateRunnerNativeBuildReceipt,
  validateRunnerNativeTrustPolicy,
} from "./runner-native-release.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EVIDENCE_KEYS = Object.freeze([
  "candidateDigest", "component", "nativeSignature", "releasedDigest", "schemaVersion", "sizeBytes",
]);
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_TLS_FILE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_IDENTITY_BYTES = 16 * 1024;
const CLOCK_SKEW_MS = 60_000;

export async function prepareRunnerNativeReleaseClaims(buildReceipt, {
  artifactDirectory,
  evidenceDirectory,
  releaseId,
  publishedAt,
  inspectIdentity = executeIdentity,
} = {}) {
  if (!absolute(artifactDirectory) || !absolute(evidenceDirectory) || typeof releaseId !== "string"
    || !UUID.test(releaseId) || typeof publishedAt !== "string" || typeof inspectIdentity !== "function") invalid();
  const build = validateRunnerNativeBuildReceipt(buildReceipt);
  const [artifactRoot, evidenceRoot] = await Promise.all([
    verifiedDirectory(artifactDirectory),
    verifiedDirectory(evidenceDirectory),
  ]);
  const artifacts = [];
  for (const candidate of build.artifacts) {
    const artifactPath = childPath(artifactRoot, candidate.fileName);
    const evidencePath = childPath(evidenceRoot, `${candidate.component}.signing-evidence.json`);
    const [metadata, evidence] = await Promise.all([
      fileMetadata(artifactPath, MAX_ARTIFACT_BYTES),
      readBoundedJson(evidencePath, 1024 * 1024),
    ]);
    validateSigningEvidence(evidence, candidate, metadata);
    const identity = await inspectIdentity(Object.freeze({ artifactPath, component: candidate.component }));
    validateIdentity(identity, candidate.component, build);
    artifacts.push(Object.freeze({
      component: candidate.component,
      fileName: candidate.fileName,
      candidateDigest: candidate.candidateDigest,
      releasedDigest: metadata.digest,
      sizeBytes: metadata.sizeBytes,
      nativeSignature: Object.freeze({ ...evidence.nativeSignature }),
    }));
  }
  return createRunnerNativeReleaseClaims(build, { releaseId, publishedAt, artifacts: Object.freeze(artifacts) });
}

export class MtlsRunnerNativeReleaseSigner {
  constructor({ endpoint, keyId, tls, request = requestSigner }) {
    this.endpoint = signerEndpoint(endpoint);
    if (typeof keyId !== "string" || !SAFE_ID.test(keyId)) invalid();
    this.keyId = keyId;
    this.tls = validateTls(tls);
    this.request = request;
  }

  async sign(claims, buildReceipt, policy, expectedPolicyDigest, now = new Date()) {
    const trusted = validateRunnerNativeTrustPolicy(policy, expectedPolicyDigest);
    const key = trusted.keys.find((candidate) => candidate.keyId === this.keyId);
    const signingRequest = runnerNativeReleaseSigningRequest(claims, buildReceipt);
    const publishedAt = Date.parse(claims.publishedAt);
    if (!key || key.status !== "ACTIVE" || !(now instanceof Date) || !Number.isFinite(now.valueOf())
      || publishedAt > now.valueOf() + CLOCK_SKEW_MS || publishedAt < Date.parse(key.notBefore)
      || publishedAt >= Date.parse(key.notAfter)) invalid();
    const response = await this.request(Object.freeze({
      url: new URL("/v1/runner-native-releases/sign-ed25519", this.endpoint),
      tls: this.tls,
      headers: Object.freeze({
        "content-type": "application/json",
        "idempotency-key": claims.releaseId,
      }),
      body: JSON.stringify({ ...signingRequest, keyId: this.keyId }),
    }));
    if (response.statusCode !== 200 || response.body?.keyId !== this.keyId) invalid();
    return runnerNativeReleaseFromSigner(claims, response.body, buildReceipt, trusted, expectedPolicyDigest, now);
  }
}

export async function runnerNativeReleaseSignerFromEnvironment(env = process.env) {
  const [key, cert, ca] = await Promise.all([
    boundedTlsFile(env.DEVILUDO_RUNNER_NATIVE_SIGNER_TLS_KEY_FILE),
    boundedTlsFile(env.DEVILUDO_RUNNER_NATIVE_SIGNER_TLS_CERT_FILE),
    boundedTlsFile(env.DEVILUDO_RUNNER_NATIVE_SIGNER_TLS_CA_FILE),
  ]);
  return new MtlsRunnerNativeReleaseSigner({
    endpoint: env.DEVILUDO_RUNNER_NATIVE_SIGNER_ENDPOINT,
    keyId: env.DEVILUDO_RUNNER_NATIVE_SIGNING_KEY_ID,
    tls: { key, cert, ca },
  });
}

function validateSigningEvidence(evidence, candidate, metadata) {
  if (!plainRecord(evidence) || !exactKeys(evidence, EVIDENCE_KEYS)
    || evidence.schemaVersion !== "deviludo.runner-native-signing-evidence.v1"
    || evidence.component !== candidate.component || evidence.candidateDigest !== candidate.candidateDigest
    || evidence.releasedDigest !== metadata.digest || evidence.sizeBytes !== metadata.sizeBytes
    || !plainRecord(evidence.nativeSignature)) invalid();
}

function validateIdentity(identity, component, build) {
  if (!plainRecord(identity) || !exactKeys(identity, [
    "architecture", "component", "nodeVersion", "platform", "platformVersion", "schemaVersion", "sourceRevision",
  ]) || identity.schemaVersion !== "deviludo.native-component-identity.v1" || identity.component !== component
    || identity.platformVersion !== build.platformVersion || identity.sourceRevision !== build.sourceRevision
    || identity.nodeVersion !== build.nodeVersion || identity.platform !== hostPlatformName(build.platform)
    || identity.architecture !== hostArchitectureName(build.architecture)) invalid();
}

async function executeIdentity({ artifactPath }) {
  const output = await executeCapture(artifactPath, ["--identity"]);
  let identity;
  try { identity = JSON.parse(output); } catch { invalid(); }
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
      } else reject(new Error("Runner native finalizer identity inspection failed"));
    });
  });
}

async function verifiedDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid();
  return path;
}

function childPath(root, name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(name)) invalid();
  const path = resolve(root, name);
  if (path === root || !path.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) invalid();
  return path;
}

async function readBoundedJson(path, maximumBytes) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximumBytes) invalid();
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { invalid(); }
  return value;
}

async function fileMetadata(path, maximumBytes) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumBytes) invalid();
  const body = await readFile(path);
  return Object.freeze({
    digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    sizeBytes: body.length,
  });
}

async function boundedTlsFile(path) {
  if (!absolute(path)) invalid();
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 32 || metadata.size > MAX_TLS_FILE_BYTES) invalid();
  const value = await readFile(path);
  if (value.includes(0)) invalid();
  return value;
}

function signerEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(url.hostname)
    || !new Set(["", "443", "8443"]).has(url.port)) invalid();
  return url;
}

function validateTls(tls) {
  if (!plainRecord(tls) || !Buffer.isBuffer(tls.key) || !Buffer.isBuffer(tls.cert) || !Buffer.isBuffer(tls.ca)
    || [tls.key, tls.cert, tls.ca].some((value) => value.length < 32 || value.length > MAX_TLS_FILE_BYTES)) invalid();
  return Object.freeze({ key: Buffer.from(tls.key), cert: Buffer.from(tls.cert), ca: Buffer.from(tls.ca) });
}

function requestSigner(input) {
  return new Promise((accept, reject) => {
    const request = httpsRequest(input.url, {
      method: "POST",
      key: input.tls.key,
      cert: input.tls.cert,
      ca: input.tls.ca,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      headers: { ...input.headers, "content-length": Buffer.byteLength(input.body) },
      timeout: 10_000,
    }, (response) => {
      if (response.headers["content-type"] !== "application/json") {
        response.resume();
        reject(new Error("Runner native signing response is invalid"));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) request.destroy(new Error("Runner native signing response is invalid"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
          reject(new Error("Runner native signing response is invalid"));
          return;
        }
        accept(Object.freeze({ statusCode: response.statusCode, body }));
      });
    });
    request.on("timeout", () => request.destroy(new Error("Runner native signing request timed out")));
    request.on("error", reject);
    request.end(input.body);
  });
}

function hostPlatformName(platform) {
  return platform === "macos" ? "darwin" : platform === "windows" ? "win32" : "linux";
}

function hostArchitectureName(architecture) {
  return architecture === "x86_64" ? "x64" : "arm64";
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

function invalid() {
  throw new Error("Runner native finalization is invalid");
}
