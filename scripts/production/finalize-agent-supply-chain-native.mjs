#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateAgentSupplyChainNativeBuildReceipt } from "../build-agent-supply-chain-native.mjs";
import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import {
  validateAgentSupplyChainNativeTrustPolicy,
  verifySignedAgentSupplyChainNativeRelease,
} from "../../services/agent-supply-chain/src/native-release-manifest.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_TLS_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const CLOCK_SKEW_MS = 60_000;
const EVIDENCE_KEYS = Object.freeze([
  "artifactDigest", "buildReceiptDigest", "malwareScanDigest", "provenanceDigest", "sbomDigest", "scanState",
  "schemaVersion", "vulnerabilityScanDigest",
]);
const SIGNER_RESPONSE_KEYS = Object.freeze(["algorithm", "claimsDigest", "keyId", "schemaVersion", "signature"]);

export function parseAgentSupplyChainNativeFinalizationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 18) invalidInput();
  const allowed = new Set([
    "--artifact", "--build-receipt", "--evidence", "--output", "--published-at", "--release-id",
    "--trust-policy", "--trust-policy-digest", "--source-revision",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalidInput();
    values.set(name, value);
  }
  const sourceRevision = values.get("--source-revision");
  const releaseId = values.get("--release-id");
  const publishedAt = values.get("--published-at");
  const trustPolicyDigest = values.get("--trust-policy-digest");
  if (!SOURCE_REVISION.test(sourceRevision) || !UUID.test(releaseId) || !canonicalTimestamp(publishedAt)
    || !SHA256.test(trustPolicyDigest)) invalidInput();
  return Object.freeze({
    artifactPath: absolute(values.get("--artifact")),
    buildReceiptPath: absolute(values.get("--build-receipt")),
    evidencePath: absolute(values.get("--evidence")),
    outputPath: absolute(values.get("--output")),
    publishedAt,
    releaseId,
    sourceRevision,
    trustPolicyDigest,
    trustPolicyPath: absolute(values.get("--trust-policy")),
  });
}

export async function prepareAgentSupplyChainNativeClaims(options) {
  validateOptions(options);
  const [artifact, buildBytes, evidence] = await Promise.all([
    fileMetadata(options.artifactPath, MAX_ARTIFACT_BYTES),
    readBoundedFile(options.buildReceiptPath, MAX_JSON_BYTES),
    readBoundedJson(options.evidencePath),
  ]);
  const buildValue = parseJson(buildBytes);
  const build = validateAgentSupplyChainNativeBuildReceipt(buildValue);
  const buildReceiptDigest = fileDigest(buildBytes);
  if (build.sourceRevision !== options.sourceRevision || build.artifactDigest !== artifact.digest
    || build.sizeBytes !== artifact.sizeBytes || Date.parse(options.publishedAt) < Date.parse(build.completedAt)) invalidInput();
  validateEvidence(evidence, artifact.digest, buildReceiptDigest);
  return Object.freeze({
    kind: "deviludo-agent-supply-chain-native",
    version: 1,
    releaseId: options.releaseId,
    platformVersion: build.platformVersion,
    sourceRevision: build.sourceRevision,
    nodeTarget: build.nodeTarget,
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.sizeBytes,
    buildReceiptDigest,
    sbomDigest: evidence.sbomDigest,
    malwareScanDigest: evidence.malwareScanDigest,
    vulnerabilityScanDigest: evidence.vulnerabilityScanDigest,
    provenanceDigest: evidence.provenanceDigest,
    publishedAt: options.publishedAt,
  });
}

export class MtlsAgentSupplyChainNativeSigner {
  constructor({ endpoint, keyId, tls, request = requestSigner }) {
    this.endpoint = signerEndpoint(endpoint);
    if (typeof keyId !== "string" || !SAFE_ID.test(keyId)) invalidInput();
    this.keyId = keyId;
    this.tls = validateTls(tls);
    this.request = request;
  }

  async sign(claims, trustPolicy, trustPolicyDigest, now = new Date()) {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) invalidInput();
    const trusted = validateAgentSupplyChainNativeTrustPolicy(trustPolicy, trustPolicyDigest);
    const key = trusted.keys.find((candidate) => candidate.keyId === this.keyId);
    const publishedAt = Date.parse(claims.publishedAt);
    if (!key || key.status !== "ACTIVE" || publishedAt > now.getTime() + CLOCK_SKEW_MS
      || publishedAt < Date.parse(key.notBefore) || publishedAt >= Date.parse(key.notAfter)
      || now.getTime() < Date.parse(key.notBefore) || now.getTime() >= Date.parse(key.notAfter)) invalidInput();
    const claimsDigest = sha256Canonical(claims);
    const response = await this.request(Object.freeze({
      url: new URL("/v1/agent-supply-chain-native/sign-ed25519", this.endpoint),
      tls: this.tls,
      headers: Object.freeze({ "content-type": "application/json", "idempotency-key": claimsDigest }),
      body: JSON.stringify({
        schemaVersion: "deviludo.agent-supply-chain-native-signing-request.v1",
        keyId: this.keyId,
        claimsDigest,
        signingInput: Buffer.from(canonicalJson(claims), "utf8").toString("base64url"),
      }),
    }));
    if (response.statusCode !== 200 || !plainRecord(response.body) || !exactKeys(response.body, SIGNER_RESPONSE_KEYS)
      || response.body.schemaVersion !== "deviludo.agent-supply-chain-native-signing-response.v1"
      || response.body.algorithm !== "Ed25519" || response.body.keyId !== this.keyId
      || response.body.claimsDigest !== claimsDigest || typeof response.body.signature !== "string") invalidInput();
    const manifest = Object.freeze({ keyId: this.keyId, claims, signature: response.body.signature });
    verifySignedAgentSupplyChainNativeRelease(manifest, {
      trustPolicy: trusted,
      trustPolicyDigest,
      platformVersion: claims.platformVersion,
      artifactDigest: claims.artifactDigest,
      buildReceiptDigest: claims.buildReceiptDigest,
      now,
    });
    return manifest;
  }
}

export async function agentSupplyChainNativeSignerFromEnvironment(env = process.env) {
  const [key, cert, ca] = await Promise.all([
    boundedTlsFile(env.DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_SIGNER_TLS_KEY_FILE),
    boundedTlsFile(env.DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_SIGNER_TLS_CERT_FILE),
    boundedTlsFile(env.DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_SIGNER_TLS_CA_FILE),
  ]);
  return new MtlsAgentSupplyChainNativeSigner({
    endpoint: env.DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_SIGNER_ENDPOINT,
    keyId: env.DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_SIGNING_KEY_ID,
    tls: { key, cert, ca },
  });
}

export async function finalizeAgentSupplyChainNative(options, { signer, now = new Date() } = {}) {
  if (!signer || typeof signer.sign !== "function" || !(now instanceof Date) || !Number.isFinite(now.getTime())) invalidInput();
  const [claims, trustPolicy] = await Promise.all([
    prepareAgentSupplyChainNativeClaims(options),
    readBoundedJson(options.trustPolicyPath),
  ]);
  const replay = await readJsonIfPresent(options.outputPath);
  if (replay) {
    if (canonicalJson(replay.claims) !== canonicalJson(claims)) invalidInput();
    verifyManifest(replay, claims, trustPolicy, options.trustPolicyDigest, now);
    return Object.freeze({ manifest: replay, replayed: true });
  }
  await verifyOutputParent(options.outputPath);
  const manifest = await signer.sign(claims, trustPolicy, options.trustPolicyDigest, now);
  try {
    const file = await open(options.outputPath, "wx", 0o400);
    try { await file.writeFile(`${canonicalJson(manifest)}\n`, "utf8"); await file.sync(); }
    finally { await file.close(); }
    return Object.freeze({ manifest, replayed: false });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readBoundedJson(options.outputPath);
    if (canonicalJson(existing) !== canonicalJson(manifest)) invalidInput();
    verifyManifest(existing, claims, trustPolicy, options.trustPolicyDigest, now);
    return Object.freeze({ manifest: existing, replayed: true });
  }
}

function verifyManifest(manifest, claims, trustPolicy, trustPolicyDigest, now) {
  return verifySignedAgentSupplyChainNativeRelease(manifest, {
    trustPolicy,
    trustPolicyDigest,
    platformVersion: claims.platformVersion,
    artifactDigest: claims.artifactDigest,
    buildReceiptDigest: claims.buildReceiptDigest,
    now,
  });
}

function validateEvidence(value, artifactDigest, buildReceiptDigest) {
  if (!plainRecord(value) || !exactKeys(value, EVIDENCE_KEYS)
    || value.schemaVersion !== "deviludo.agent-supply-chain-native-evidence.v1" || value.scanState !== "PASS"
    || value.artifactDigest !== artifactDigest || value.buildReceiptDigest !== buildReceiptDigest
    || !SHA256.test(value.sbomDigest) || !SHA256.test(value.malwareScanDigest)
    || !SHA256.test(value.vulnerabilityScanDigest) || !SHA256.test(value.provenanceDigest)) invalidInput();
}

function validateOptions(options) {
  if (!plainRecord(options) || !absoluteValue(options.artifactPath) || !absoluteValue(options.buildReceiptPath)
    || !absoluteValue(options.evidencePath) || !absoluteValue(options.outputPath) || !absoluteValue(options.trustPolicyPath)
    || !SOURCE_REVISION.test(options.sourceRevision) || !UUID.test(options.releaseId)
    || !canonicalTimestamp(options.publishedAt) || !SHA256.test(options.trustPolicyDigest)) invalidInput();
}

async function fileMetadata(path, maximum) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximum) invalidInput();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, metadata.size - position), position);
      if (bytesRead < 1) invalidInput();
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) invalidInput();
    return Object.freeze({ digest: hash.digest("hex"), sizeBytes: metadata.size });
  } finally { await file.close(); }
}

async function readBoundedFile(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > maximum) invalidInput();
    const value = await file.readFile();
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || value.byteLength !== before.size) invalidInput();
    return value;
  } finally { await file.close(); }
}

async function readBoundedJson(path) {
  try { return parseJson(await readBoundedFile(path, MAX_JSON_BYTES)); }
  catch (error) { if (error?.code === "ENOENT") throw error; invalidInput(); }
}

async function readJsonIfPresent(path) {
  try { return await readBoundedJson(path); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function verifyOutputParent(path) {
  const metadata = await lstat(dirname(path));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalidInput();
}

async function boundedTlsFile(path) {
  if (!absoluteValue(path)) invalidInput();
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 32 || metadata.size > MAX_TLS_BYTES) invalidInput();
  const value = await readFile(path);
  if (value.includes(0)) invalidInput();
  return value;
}

function requestSigner(input) {
  return new Promise((accept, reject) => {
    const request = httpsRequest(input.url, {
      method: "POST", key: input.tls.key, cert: input.tls.cert, ca: input.tls.ca,
      minVersion: "TLSv1.3", rejectUnauthorized: true,
      headers: { ...input.headers, "content-length": Buffer.byteLength(input.body) }, timeout: 10_000,
    }, (response) => {
      if (response.headers["content-type"] !== "application/json") {
        response.resume(); reject(new Error("Agent supply-chain native signing response is invalid")); return;
      }
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) request.destroy(new Error("Agent supply-chain native signing response is invalid"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try { accept(Object.freeze({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) })); }
        catch { reject(new Error("Agent supply-chain native signing response is invalid")); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Agent supply-chain native signing request timed out")));
    request.on("error", reject);
    request.end(input.body);
  });
}

function signerEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { invalidInput(); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(url.hostname)
    || !new Set(["", "443", "8443"]).has(url.port)) invalidInput();
  return url;
}

function validateTls(tls) {
  if (!plainRecord(tls) || !Buffer.isBuffer(tls.key) || !Buffer.isBuffer(tls.cert) || !Buffer.isBuffer(tls.ca)
    || [tls.key, tls.cert, tls.ca].some((value) => value.length < 32 || value.length > MAX_TLS_BYTES)) invalidInput();
  return Object.freeze({ key: Buffer.from(tls.key), cert: Buffer.from(tls.cert), ca: Buffer.from(tls.ca) });
}

function fileDigest(value) { return createHash("sha256").update(value).digest("hex"); }
function parseJson(value) { try { return JSON.parse(value.toString("utf8")); } catch { invalidInput(); } }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function absolute(value) { if (!absoluteValue(value)) invalidInput(); return value; }
function absoluteValue(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4096; }
function exactKeys(value, keys) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function invalidInput() { throw new Error("Agent supply-chain native finalization input is invalid"); }

async function main() {
  const options = parseAgentSupplyChainNativeFinalizationArguments(process.argv.slice(2));
  const signer = await agentSupplyChainNativeSignerFromEnvironment();
  const result = await finalizeAgentSupplyChainNative(options, { signer });
  process.stdout.write(`${JSON.stringify({ status: "ok", releaseId: result.manifest.claims.releaseId, replayed: result.replayed })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[finalize:agent-supply-chain-native] finalization failed\n");
    process.exitCode = 1;
  });
}
