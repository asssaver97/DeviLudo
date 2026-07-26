#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateAgentMicrovmGuestRootfsBuildReceipt } from "./build-agent-microvm-guest-rootfs.mjs";
import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import {
  validateAgentMicrovmGuestTrustPolicy,
  verifySignedAgentMicrovmGuestRelease,
} from "../../services/agent-execution-broker/src/native-microvm-guest-release.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const MAX_JSON = 1024 * 1024;

export function parseAgentMicrovmGuestFinalizationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 18) invalid();
  const allowed = new Set(["--rootfs", "--build-receipt", "--evidence", "--output", "--published-at", "--release-id",
    "--source-revision", "--trust-policy", "--trust-policy-digest"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) { const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value); }
  if (values.size !== allowed.size || !UUID.test(values.get("--release-id")) || !SOURCE_REVISION.test(values.get("--source-revision"))
    || !timestamp(values.get("--published-at")) || !SHA256.test(values.get("--trust-policy-digest"))) invalid();
  return Object.freeze({ rootfsPath: absolute(values.get("--rootfs")), buildReceiptPath: absolute(values.get("--build-receipt")),
    evidencePath: absolute(values.get("--evidence")), outputPath: absolute(values.get("--output")),
    publishedAt: values.get("--published-at"), releaseId: values.get("--release-id"),
    sourceRevision: values.get("--source-revision"), trustPolicyPath: absolute(values.get("--trust-policy")),
    trustPolicyDigest: values.get("--trust-policy-digest") });
}

export async function prepareAgentMicrovmGuestClaims(options) {
  validateOptions(options);
  const [rootfs, buildBytes, evidence, trustPolicy] = await Promise.all([
    hashedFile(options.rootfsPath, 64 * 1024 * 1024 * 1024), boundedFile(options.buildReceiptPath, MAX_JSON),
    readJson(options.evidencePath), readJson(options.trustPolicyPath),
  ]);
  const buildReceipt = validateAgentMicrovmGuestRootfsBuildReceipt(parseJson(buildBytes));
  validateAgentMicrovmGuestTrustPolicy(trustPolicy, options.trustPolicyDigest);
  const buildReceiptDigest = hash(buildBytes); validateEvidence(evidence, rootfs.digest, buildReceiptDigest);
  if (buildReceipt.sourceRevision !== options.sourceRevision || buildReceipt.rootfsDigest !== rootfs.digest
    || buildReceipt.rootfsSizeBytes !== rootfs.sizeBytes
    || Date.parse(options.publishedAt) < Date.parse(buildReceipt.completedAt)) invalid();
  return Object.freeze({ kind: "deviludo-agent-microvm-guest", version: 1, releaseId: options.releaseId,
    platformVersion: buildReceipt.platformVersion, sourceRevision: options.sourceRevision, agent: buildReceipt.agent,
    exactAgentVersion: buildReceipt.exactAgentVersion, adapterVersion: buildReceipt.adapterVersion,
    workerImageDigest: buildReceipt.workerImageDigest, rootfsFormat: "squashfs", rootfsDigest: rootfs.digest,
    rootfsSizeBytes: rootfs.sizeBytes, buildReceiptDigest, sourceDateEpoch: buildReceipt.sourceDateEpoch,
    sbomDigest: evidence.sbomDigest, malwareScanDigest: evidence.malwareScanDigest,
    vulnerabilityScanDigest: evidence.vulnerabilityScanDigest, secretScanDigest: evidence.secretScanDigest,
    provenanceDigest: evidence.provenanceDigest, embeddedSecrets: false, selfUpdateDisabled: true,
    publishedAt: options.publishedAt });
}

export class MtlsAgentMicrovmGuestSigner {
  #endpoint; #keyId; #tls; #request;
  constructor(options) { this.#endpoint = signerEndpoint(options.endpoint); if (!SAFE_ID.test(options.keyId)) invalid();
    this.#keyId = options.keyId; this.#tls = validateTls(options.tls); this.#request = options.request ?? requestSigner; }
  async sign(claims) {
    const signingInput = Buffer.from(canonicalJson(claims)).toString("base64url"); const claimsDigest = sha256Canonical(claims);
    const body = canonicalJson({ schemaVersion: "deviludo.agent-microvm-guest-signing-request.v1", algorithm: "Ed25519",
      keyId: this.#keyId, claimsDigest, signingInput });
    const response = await this.#request({ url: new URL("/v1/agent-microvm-guests/sign-ed25519", this.#endpoint),
      headers: { accept: "application/json", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
      body, tls: this.#tls });
    if (response.statusCode !== 200 || !plainRecord(response.body)
      || !exactKeys(response.body, ["schemaVersion", "algorithm", "keyId", "claimsDigest", "signature"])
      || response.body.schemaVersion !== "deviludo.agent-microvm-guest-signing-response.v1"
      || response.body.algorithm !== "Ed25519" || response.body.keyId !== this.#keyId
      || response.body.claimsDigest !== claimsDigest || typeof response.body.signature !== "string") invalid();
    return Object.freeze({ keyId: this.#keyId, claims, signature: response.body.signature });
  }
}

export async function finalizeAgentMicrovmGuestRootfs(options, { signer, now = new Date() } = {}) {
  if (!signer || typeof signer.sign !== "function" || !(now instanceof Date) || !Number.isFinite(now.getTime())) invalid();
  const claims = await prepareAgentMicrovmGuestClaims(options);
  if (Date.parse(claims.publishedAt) > now.getTime() + 5 * 60_000) invalid();
  const trustPolicy = await readJson(options.trustPolicyPath);
  const existing = await readJsonIfPresent(options.outputPath);
  if (existing) {
    const verified = verifySignedAgentMicrovmGuestRelease(existing, { trustPolicy, trustPolicyDigest: options.trustPolicyDigest,
      platformVersion: claims.platformVersion, rootfsDigest: claims.rootfsDigest, now });
    if (canonicalJson(verified) !== canonicalJson(claims)) invalid();
    return Object.freeze({ manifest: existing, replayed: true });
  }
  const manifest = await signer.sign(claims);
  verifySignedAgentMicrovmGuestRelease(manifest, { trustPolicy, trustPolicyDigest: options.trustPolicyDigest,
    platformVersion: claims.platformVersion, rootfsDigest: claims.rootfsDigest, now });
  const parent = await lstat(dirname(options.outputPath)); if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  await writeFile(options.outputPath, `${canonicalJson(manifest)}\n`, { flag: "wx", mode: 0o400 });
  return Object.freeze({ manifest, replayed: false });
}

export async function agentMicrovmGuestSignerFromEnvironment(env = process.env) {
  const [key, cert, ca] = await Promise.all([tlsFile(env.DEVILUDO_AGENT_MICROVM_GUEST_KMS_TLS_KEY_FILE),
    tlsFile(env.DEVILUDO_AGENT_MICROVM_GUEST_KMS_TLS_CERT_FILE), tlsFile(env.DEVILUDO_AGENT_MICROVM_GUEST_KMS_CA_FILE)]);
  return new MtlsAgentMicrovmGuestSigner({ endpoint: env.DEVILUDO_AGENT_MICROVM_GUEST_KMS_URL,
    keyId: env.DEVILUDO_AGENT_MICROVM_GUEST_KMS_KEY_ID, tls: { key, cert, ca } });
}

function validateOptions(value) { if (!plainRecord(value) || !absoluteValue(value.rootfsPath) || !absoluteValue(value.buildReceiptPath)
  || !absoluteValue(value.evidencePath) || !absoluteValue(value.outputPath) || !absoluteValue(value.trustPolicyPath)
  || !timestamp(value.publishedAt) || !UUID.test(value.releaseId) || !SOURCE_REVISION.test(value.sourceRevision)
  || !SHA256.test(value.trustPolicyDigest)) invalid(); }
function validateEvidence(value, rootfsDigest, buildReceiptDigest) { if (!plainRecord(value) || !exactKeys(value, ["schemaVersion", "scanState",
  "rootfsDigest", "buildReceiptDigest", "sbomDigest", "malwareScanDigest", "vulnerabilityScanDigest", "secretScanDigest", "provenanceDigest"])
  || value.schemaVersion !== "deviludo.agent-microvm-guest-evidence.v1" || value.scanState !== "PASS"
  || value.rootfsDigest !== rootfsDigest || value.buildReceiptDigest !== buildReceiptDigest
  || [value.sbomDigest, value.malwareScanDigest, value.vulnerabilityScanDigest, value.secretScanDigest, value.provenanceDigest]
    .some((digest) => !SHA256.test(digest))) invalid(); }
async function hashedFile(path, maximum) { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = await file.stat(); if (!before.isFile() || before.size < 1 || before.size > maximum || (before.mode & 0o022) !== 0) invalid();
    const digest = createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
    while (offset < before.size) { const read = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (read.bytesRead < 1) invalid(); digest.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead; }
    const after = await file.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return Object.freeze({ digest: digest.digest("hex"), sizeBytes: before.size }); } finally { await file.close(); } }
async function boundedFile(path, maximum) { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = await file.stat(); if (!before.isFile() || before.size < 2 || before.size > maximum || (before.mode & 0o022) !== 0) invalid();
    const bytes = await file.readFile(); const after = await file.stat(); if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid(); return bytes;
  } finally { await file.close(); } }
async function readJson(path) { return parseJson(await boundedFile(path, MAX_JSON)); }
async function readJsonIfPresent(path) { try { return await readJson(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
function parseJson(bytes) { try { const value = JSON.parse(bytes.toString("utf8")); if (!plainRecord(value)) invalid(); return value; } catch { invalid(); } }
async function tlsFile(path) { if (!absoluteValue(path)) invalid(); const value = await boundedFile(path, MAX_JSON); if (value.includes(0)) invalid(); return value; }
function requestSigner(input) { return new Promise((accept, reject) => { const request = httpsRequest(input.url, { method: "POST", key: input.tls.key,
  cert: input.tls.cert, ca: input.tls.ca, rejectUnauthorized: true, minVersion: "TLSv1.3", headers: input.headers, timeout: 30_000 },
  (response) => { const chunks = []; let size = 0; response.on("data", (chunk) => { size += chunk.length; if (size > MAX_JSON) request.destroy(); else chunks.push(chunk); });
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
function invalid() { throw new Error("Agent microVM guest finalization input is invalid"); }

async function main() { const options = parseAgentMicrovmGuestFinalizationArguments(process.argv.slice(2));
  const signer = await agentMicrovmGuestSignerFromEnvironment(); const result = await finalizeAgentMicrovmGuestRootfs(options, { signer });
  process.stdout.write(`${JSON.stringify({ releaseId: result.manifest.claims.releaseId, replayed: result.replayed })}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[finalize:agent-microvm-guest-rootfs] finalization failed\n"); process.exitCode = 1; });
}
