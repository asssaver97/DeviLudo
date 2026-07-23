#!/usr/bin/env node

import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { request as httpsRequest } from "node:https";
import { validateAgentMicrovmLauncherBuildReceipt } from "../build-agent-microvm-launcher.mjs";
import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import { parseNativeMicrovmLauncherConfig } from "../../services/agent-execution-broker/src/native-microvm-launcher.ts";
import {
  releaseClaimsFromConfig,
  validateAgentMicrovmLauncherTrustPolicy,
  verifySignedAgentMicrovmLauncherRelease,
} from "../../services/agent-execution-broker/src/native-microvm-launcher-release.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const MAX_JSON = 1024 * 1024;
const MAX_ARTIFACT = 1024 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60_000;

export function parseAgentMicrovmLauncherFinalizationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 20) invalid();
  const allowed = new Set(["--artifact", "--build-receipt", "--config", "--evidence", "--output", "--published-at",
    "--release-id", "--source-revision", "--trust-policy", "--trust-policy-digest"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (!SOURCE_REVISION.test(values.get("--source-revision")) || !UUID.test(values.get("--release-id"))
    || !timestamp(values.get("--published-at")) || !SHA256.test(values.get("--trust-policy-digest"))) invalid();
  return Object.freeze({ artifactPath: absolute(values.get("--artifact")), buildReceiptPath: absolute(values.get("--build-receipt")),
    configPath: absolute(values.get("--config")), evidencePath: absolute(values.get("--evidence")),
    outputPath: absolute(values.get("--output")), publishedAt: values.get("--published-at"), releaseId: values.get("--release-id"),
    sourceRevision: values.get("--source-revision"), trustPolicyPath: absolute(values.get("--trust-policy")),
    trustPolicyDigest: values.get("--trust-policy-digest") });
}

export async function prepareAgentMicrovmLauncherClaims(options) {
  validateOptions(options);
  const [launcher, buildBytes, configBytes, evidence] = await Promise.all([
    fileMetadata(options.artifactPath, MAX_ARTIFACT), boundedFile(options.buildReceiptPath, MAX_JSON),
    boundedFile(options.configPath, MAX_JSON), readJson(options.evidencePath),
  ]);
  const build = validateAgentMicrovmLauncherBuildReceipt(parseJson(buildBytes));
  const config = parseNativeMicrovmLauncherConfig(parseJson(configBytes));
  const buildReceiptDigest = hash(buildBytes); const configDigest = hash(configBytes);
  if (build.sourceRevision !== options.sourceRevision || build.artifactDigest !== launcher.digest
    || build.sizeBytes !== launcher.sizeBytes || build.platformVersion !== config.platformVersion
    || Date.parse(options.publishedAt) < Date.parse(build.completedAt)) invalid();
  validateEvidence(evidence, launcher.digest, buildReceiptDigest, configDigest);
  return Object.freeze({ kind: "deviludo-agent-microvm-launcher", version: 1, releaseId: options.releaseId,
    platformVersion: build.platformVersion, sourceRevision: build.sourceRevision, nodeTarget: build.nodeTarget,
    launcherDigest: launcher.digest, launcherSizeBytes: launcher.sizeBytes, buildReceiptDigest, configDigest,
    ...releaseClaimsFromConfig(config), sbomDigest: evidence.sbomDigest, malwareScanDigest: evidence.malwareScanDigest,
    vulnerabilityScanDigest: evidence.vulnerabilityScanDigest, provenanceDigest: evidence.provenanceDigest,
    publishedAt: options.publishedAt });
}

export class MtlsAgentMicrovmLauncherSigner {
  constructor({ endpoint, keyId, tls, request = requestSigner }) {
    this.endpoint = signerEndpoint(endpoint);
    if (typeof keyId !== "string" || !SAFE_ID.test(keyId)) invalid();
    this.keyId = keyId; this.tls = validateTls(tls); this.request = request;
  }
  async sign(claims, trustPolicy, trustPolicyDigest, config, now = new Date()) {
    const trusted = validateAgentMicrovmLauncherTrustPolicy(trustPolicy, trustPolicyDigest);
    const key = trusted.keys.find((candidate) => candidate.keyId === this.keyId);
    const publishedAt = Date.parse(claims.publishedAt);
    if (!key || key.status !== "ACTIVE" || !Number.isFinite(now.getTime()) || publishedAt > now.getTime() + CLOCK_SKEW_MS
      || publishedAt < Date.parse(key.notBefore) || publishedAt >= Date.parse(key.notAfter)
      || now.getTime() < Date.parse(key.notBefore) || now.getTime() >= Date.parse(key.notAfter)) invalid();
    const claimsDigest = sha256Canonical(claims);
    const response = await this.request(Object.freeze({
      url: new URL("/v1/agent-microvm-launchers/sign-ed25519", this.endpoint), tls: this.tls,
      headers: Object.freeze({ "content-type": "application/json", "idempotency-key": claimsDigest }),
      body: JSON.stringify({ schemaVersion: "deviludo.agent-microvm-launcher-signing-request.v1", keyId: this.keyId,
        claimsDigest, signingInput: Buffer.from(canonicalJson(claims)).toString("base64url") }),
    }));
    if (response.statusCode !== 200 || !plainRecord(response.body)
      || !exactKeys(response.body, ["schemaVersion", "algorithm", "keyId", "claimsDigest", "signature"])
      || response.body.schemaVersion !== "deviludo.agent-microvm-launcher-signing-response.v1"
      || response.body.algorithm !== "Ed25519" || response.body.keyId !== this.keyId
      || response.body.claimsDigest !== claimsDigest || typeof response.body.signature !== "string") invalid();
    const manifest = Object.freeze({ keyId: this.keyId, claims, signature: response.body.signature });
    verifySignedAgentMicrovmLauncherRelease(manifest, { trustPolicy: trusted, trustPolicyDigest,
      platformVersion: claims.platformVersion, launcherDigest: claims.launcherDigest,
      buildReceiptDigest: claims.buildReceiptDigest, config, configDigest: claims.configDigest, now });
    return manifest;
  }
}

export async function agentMicrovmLauncherSignerFromEnvironment(env = process.env) {
  const [key, cert, ca] = await Promise.all([tlsFile(env.DEVILUDO_AGENT_MICROVM_SIGNER_TLS_KEY_FILE),
    tlsFile(env.DEVILUDO_AGENT_MICROVM_SIGNER_TLS_CERT_FILE), tlsFile(env.DEVILUDO_AGENT_MICROVM_SIGNER_TLS_CA_FILE)]);
  return new MtlsAgentMicrovmLauncherSigner({ endpoint: env.DEVILUDO_AGENT_MICROVM_SIGNER_ENDPOINT,
    keyId: env.DEVILUDO_AGENT_MICROVM_SIGNING_KEY_ID, tls: { key, cert, ca } });
}

export async function finalizeAgentMicrovmLauncher(options, { signer, now = new Date() } = {}) {
  if (!signer || typeof signer.sign !== "function" || !Number.isFinite(now.getTime())) invalid();
  const [claims, trustPolicy, config] = await Promise.all([prepareAgentMicrovmLauncherClaims(options),
    readJson(options.trustPolicyPath), readJson(options.configPath)]);
  const replay = await readJsonIfPresent(options.outputPath);
  if (replay) {
    if (canonicalJson(replay.claims) !== canonicalJson(claims)) invalid();
    verify(replay, claims, trustPolicy, config, options.trustPolicyDigest, now);
    return Object.freeze({ manifest: replay, replayed: true });
  }
  const parent = await lstat(dirname(options.outputPath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  const manifest = await signer.sign(claims, trustPolicy, options.trustPolicyDigest, config, now);
  try {
    const file = await open(options.outputPath, "wx", 0o400);
    try { await file.writeFile(`${canonicalJson(manifest)}\n`); await file.sync(); } finally { await file.close(); }
    return Object.freeze({ manifest, replayed: false });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readJson(options.outputPath);
    if (canonicalJson(existing) !== canonicalJson(manifest)) invalid();
    verify(existing, claims, trustPolicy, config, options.trustPolicyDigest, now);
    return Object.freeze({ manifest: existing, replayed: true });
  }
}

function verify(manifest, claims, trustPolicy, config, trustPolicyDigest, now) {
  return verifySignedAgentMicrovmLauncherRelease(manifest, { trustPolicy, trustPolicyDigest,
    platformVersion: claims.platformVersion, launcherDigest: claims.launcherDigest,
    buildReceiptDigest: claims.buildReceiptDigest, config, configDigest: claims.configDigest, now });
}
function validateEvidence(value, artifactDigest, buildReceiptDigest, configDigest) {
  if (!plainRecord(value) || !exactKeys(value, ["schemaVersion", "scanState", "artifactDigest", "buildReceiptDigest",
    "configDigest", "sbomDigest", "malwareScanDigest", "vulnerabilityScanDigest", "provenanceDigest"])
    || value.schemaVersion !== "deviludo.agent-microvm-launcher-evidence.v1" || value.scanState !== "PASS"
    || value.artifactDigest !== artifactDigest || value.buildReceiptDigest !== buildReceiptDigest
    || value.configDigest !== configDigest || !SHA256.test(value.sbomDigest) || !SHA256.test(value.malwareScanDigest)
    || !SHA256.test(value.vulnerabilityScanDigest) || !SHA256.test(value.provenanceDigest)) invalid();
}
function validateOptions(value) { if (!plainRecord(value) || !absoluteValue(value.artifactPath) || !absoluteValue(value.buildReceiptPath)
  || !absoluteValue(value.configPath) || !absoluteValue(value.evidencePath) || !absoluteValue(value.outputPath)
  || !absoluteValue(value.trustPolicyPath) || !SOURCE_REVISION.test(value.sourceRevision) || !UUID.test(value.releaseId)
  || !timestamp(value.publishedAt) || !SHA256.test(value.trustPolicyDigest)) invalid(); }
async function fileMetadata(path, maximum) { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = await file.stat(); if (!before.isFile() || before.size < 1 || before.size > maximum) invalid();
    const hashValue = createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
    while (offset < before.size) { const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead < 1) invalid(); hashValue.update(buffer.subarray(0, bytesRead)); offset += bytesRead; }
    const after = await file.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return Object.freeze({ digest: hashValue.digest("hex"), sizeBytes: before.size }); } finally { await file.close(); } }
async function boundedFile(path, maximum) { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = await file.stat(); if (!before.isFile() || before.size < 2 || before.size > maximum) invalid();
    const value = await file.readFile(); const after = await file.stat();
    if (value.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid(); return value;
  } finally { await file.close(); } }
async function readJson(path) { return parseJson(await boundedFile(path, MAX_JSON)); }
async function readJsonIfPresent(path) { try { return await readJson(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
function parseJson(bytes) { try { const value = JSON.parse(bytes.toString("utf8")); if (!plainRecord(value)) invalid(); return value; } catch { invalid(); } }
async function tlsFile(path) { if (!absoluteValue(path)) invalid(); const value = await boundedFile(path, MAX_JSON); if (value.includes(0)) invalid(); return value; }
function requestSigner(input) { return new Promise((accept, reject) => { const request = httpsRequest(input.url, {
  method: "POST", key: input.tls.key, cert: input.tls.cert, ca: input.tls.ca, rejectUnauthorized: true, headers: input.headers,
  timeout: 30_000,
}, (response) => { const chunks = []; let size = 0; response.on("data", (chunk) => { size += chunk.length; if (size > MAX_JSON) request.destroy(); else chunks.push(chunk); });
  response.on("end", () => { try { accept({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch (error) { reject(error); } }); });
  request.once("error", reject); request.end(input.body); }); }
function signerEndpoint(value) { const url = new URL(value); if (url.protocol !== "https:" || !url.hostname || url.username || url.password
  || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) invalid(); return url; }
function validateTls(value) { if (!plainRecord(value) || !Buffer.isBuffer(value.key) || !Buffer.isBuffer(value.cert) || !Buffer.isBuffer(value.ca)
  || value.key.length < 32 || value.cert.length < 32 || value.ca.length < 32) invalid(); return Object.freeze({ ...value }); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function timestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function absolute(value) { if (!absoluteValue(value)) invalid(); return value; }
function absoluteValue(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4096 && !/[\0\r\n]/.test(value); }
function exactKeys(value, expected) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function invalid() { throw new Error("Agent microVM launcher finalization input is invalid"); }

async function main() { const options = parseAgentMicrovmLauncherFinalizationArguments(process.argv.slice(2));
  const signer = await agentMicrovmLauncherSignerFromEnvironment(); const result = await finalizeAgentMicrovmLauncher(options, { signer });
  process.stdout.write(`${JSON.stringify({ releaseId: result.manifest.claims.releaseId, replayed: result.replayed })}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[finalize:agent-microvm-launcher] finalization failed\n"); process.exitCode = 1; });
}
