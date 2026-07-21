#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import {
  validateWindowsScmServiceBridgeTrustPolicy,
  verifySignedWindowsScmServiceBridgeManifest,
} from "../../services/runner-control/src/windows-scm-service-bridge.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const SIGNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/ ,=+-]{2,159}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_TLS_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const CLOCK_SKEW_MS = 60_000;
const EVIDENCE_KEYS = Object.freeze([
  "architecture", "binaryDigest", "compiler", "malwareScanDigest", "nativeSignature", "platform",
  "sbomDigest", "schemaVersion", "sizeBytes", "vulnerabilityScanDigest",
]);
const COMPILER_KEYS = Object.freeze(["binaryDigest", "name", "version"]);
const SIGNATURE_KEYS = Object.freeze(["evidenceDigest", "scheme", "signerIdentity"]);
const SIGNER_RESPONSE_KEYS = Object.freeze(["algorithm", "claimsDigest", "keyId", "schemaVersion", "signature"]);

export function parseWindowsScmServiceBridgeFinalizationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 20) invalidInput();
  const allowed = new Set([
    "--architecture", "--binary", "--bridge-version", "--built-at", "--evidence", "--output", "--revision",
    "--source-digest", "--trust-policy", "--trust-policy-digest",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalidInput();
    values.set(name, value);
  }
  const revision = Number(values.get("--revision"));
  if (!new Set(["x86_64", "arm64"]).has(values.get("--architecture"))
    || !fixedVersion(values.get("--bridge-version")) || !canonicalTimestamp(values.get("--built-at"))
    || !Number.isSafeInteger(revision) || revision < 1 || String(revision) !== values.get("--revision")
    || !SHA256.test(values.get("--source-digest")) || !SHA256.test(values.get("--trust-policy-digest"))) invalidInput();
  return Object.freeze({
    architecture: values.get("--architecture"),
    binaryPath: absolute(values.get("--binary")),
    bridgeVersion: values.get("--bridge-version"),
    builtAt: values.get("--built-at"),
    evidencePath: absolute(values.get("--evidence")),
    outputPath: absolute(values.get("--output")),
    revision,
    sourceDigest: values.get("--source-digest"),
    trustPolicyDigest: values.get("--trust-policy-digest"),
    trustPolicyPath: absolute(values.get("--trust-policy")),
  });
}

export async function prepareWindowsScmServiceBridgeClaims(options) {
  validateOptions(options);
  const [binary, evidence] = await Promise.all([
    fileMetadata(options.binaryPath, MAX_BINARY_BYTES),
    readBoundedJson(options.evidencePath),
  ]);
  validateSigningEvidence(evidence, options.architecture, binary);
  return Object.freeze({
    kind: "deviludo-windows-scm-service-bridge",
    version: 1,
    revision: options.revision,
    platform: "windows",
    architecture: options.architecture,
    bridgeVersion: options.bridgeVersion,
    serviceContractVersion: 1,
    binaryDigest: binary.digest,
    sourceDigest: options.sourceDigest,
    supplyChainEvidenceDigest: sha256Canonical(evidence),
    builtAt: options.builtAt,
  });
}

export class MtlsWindowsScmServiceBridgeSigner {
  constructor({ endpoint, keyId, tls, request = requestSigner }) {
    this.endpoint = signerEndpoint(endpoint);
    if (typeof keyId !== "string" || !SAFE_ID.test(keyId)) invalidInput();
    this.keyId = keyId;
    this.tls = validateTls(tls);
    this.request = request;
  }

  async sign(claims, trustPolicy, trustPolicyDigest, now = new Date()) {
    if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) invalidInput();
    const trusted = validateWindowsScmServiceBridgeTrustPolicy(trustPolicy, trustPolicyDigest);
    const key = trusted.keys.find((candidate) => candidate.keyId === this.keyId);
    const builtAt = Date.parse(claims.builtAt);
    if (!key || key.status !== "ACTIVE" || builtAt > now.valueOf() + CLOCK_SKEW_MS
      || builtAt < Date.parse(key.notBefore) || builtAt >= Date.parse(key.notAfter)
      || now.valueOf() < Date.parse(key.notBefore) || now.valueOf() >= Date.parse(key.notAfter)) invalidInput();
    const claimsDigest = sha256Canonical(claims);
    const response = await this.request(Object.freeze({
      url: new URL("/v1/windows-scm-service-bridges/sign-ed25519", this.endpoint),
      tls: this.tls,
      headers: Object.freeze({ "content-type": "application/json", "idempotency-key": claimsDigest }),
      body: JSON.stringify({
        schemaVersion: "deviludo.windows-scm-service-bridge-signing-request.v1",
        keyId: this.keyId,
        claimsDigest,
        signingInput: Buffer.from(canonicalJson(claims), "utf8").toString("base64url"),
      }),
    }));
    if (response.statusCode !== 200 || !plainRecord(response.body) || !exactKeys(response.body, SIGNER_RESPONSE_KEYS)
      || response.body.schemaVersion !== "deviludo.windows-scm-service-bridge-signing-response.v1"
      || response.body.algorithm !== "Ed25519" || response.body.keyId !== this.keyId
      || response.body.claimsDigest !== claimsDigest || typeof response.body.signature !== "string") invalidInput();
    const manifest = Object.freeze({ keyId: this.keyId, claims, signature: response.body.signature });
    verifySignedWindowsScmServiceBridgeManifest(manifest, {
      trustPolicy: trusted, trustPolicyDigest, architecture: claims.architecture, now,
    });
    return manifest;
  }
}

export async function windowsScmServiceBridgeSignerFromEnvironment(env = process.env) {
  const [key, cert, ca] = await Promise.all([
    boundedTlsFile(env.DEVILUDO_WINDOWS_SCM_BRIDGE_SIGNER_TLS_KEY_FILE),
    boundedTlsFile(env.DEVILUDO_WINDOWS_SCM_BRIDGE_SIGNER_TLS_CERT_FILE),
    boundedTlsFile(env.DEVILUDO_WINDOWS_SCM_BRIDGE_SIGNER_TLS_CA_FILE),
  ]);
  return new MtlsWindowsScmServiceBridgeSigner({
    endpoint: env.DEVILUDO_WINDOWS_SCM_BRIDGE_SIGNER_ENDPOINT,
    keyId: env.DEVILUDO_WINDOWS_SCM_BRIDGE_SIGNING_KEY_ID,
    tls: { key, cert, ca },
  });
}

export async function finalizeWindowsScmServiceBridge(options, { signer, now = new Date() } = {}) {
  if (!signer || typeof signer.sign !== "function" || !(now instanceof Date) || !Number.isFinite(now.valueOf())) invalidInput();
  const [claims, trustPolicy] = await Promise.all([
    prepareWindowsScmServiceBridgeClaims(options),
    readBoundedJson(options.trustPolicyPath),
  ]);
  const replay = await readJsonIfPresent(options.outputPath);
  if (replay) {
    if (canonicalJson(replay.claims) !== canonicalJson(claims)) invalidInput();
    verifySignedWindowsScmServiceBridgeManifest(replay, {
      trustPolicy, trustPolicyDigest: options.trustPolicyDigest, architecture: options.architecture, now,
    });
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
    verifySignedWindowsScmServiceBridgeManifest(existing, {
      trustPolicy, trustPolicyDigest: options.trustPolicyDigest, architecture: options.architecture, now,
    });
    return Object.freeze({ manifest: existing, replayed: true });
  }
}

function validateSigningEvidence(evidence, architecture, binary) {
  if (!plainRecord(evidence) || !exactKeys(evidence, EVIDENCE_KEYS)
    || evidence.schemaVersion !== "deviludo.windows-scm-service-bridge-signing-evidence.v1"
    || evidence.platform !== "windows" || evidence.architecture !== architecture
    || evidence.binaryDigest !== binary.digest || evidence.sizeBytes !== binary.sizeBytes
    || !SHA256.test(evidence.sbomDigest) || !SHA256.test(evidence.malwareScanDigest)
    || !SHA256.test(evidence.vulnerabilityScanDigest) || !plainRecord(evidence.compiler)
    || !exactKeys(evidence.compiler, COMPILER_KEYS) || evidence.compiler.name !== "msvc"
    || !fixedVersion(evidence.compiler.version) || !SHA256.test(evidence.compiler.binaryDigest)
    || !plainRecord(evidence.nativeSignature) || !exactKeys(evidence.nativeSignature, SIGNATURE_KEYS)
    || evidence.nativeSignature.scheme !== "AUTHENTICODE"
    || typeof evidence.nativeSignature.signerIdentity !== "string"
    || !SIGNER_ID.test(evidence.nativeSignature.signerIdentity)
    || !SHA256.test(evidence.nativeSignature.evidenceDigest)) invalidInput();
}

function validateOptions(options) {
  if (!plainRecord(options) || !absoluteValue(options.binaryPath) || !absoluteValue(options.evidencePath)
    || !absoluteValue(options.outputPath) || !absoluteValue(options.trustPolicyPath)
    || !new Set(["x86_64", "arm64"]).has(options.architecture) || !fixedVersion(options.bridgeVersion)
    || !Number.isSafeInteger(options.revision) || options.revision < 1 || !canonicalTimestamp(options.builtAt)
    || !SHA256.test(options.sourceDigest) || !SHA256.test(options.trustPolicyDigest)) invalidInput();
}

async function fileMetadata(path, maximum) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximum) invalidInput();
  const file = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, metadata.size - position), position);
      if (bytesRead < 1) invalidInput();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) invalidInput();
    return Object.freeze({ digest: hash.digest("hex"), sizeBytes: metadata.size });
  } finally { await file.close(); }
}

async function readBoundedJson(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_JSON_BYTES) invalidInput();
  try { return JSON.parse(await readFile(path, "utf8")); } catch { invalidInput(); }
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
        response.resume(); reject(new Error("Windows SCM bridge signing response is invalid")); return;
      }
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) request.destroy(new Error("Windows SCM bridge signing response is invalid"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try { accept(Object.freeze({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) })); }
        catch { reject(new Error("Windows SCM bridge signing response is invalid")); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Windows SCM bridge signing request timed out")));
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
function fixedVersion(value) { return typeof value === "string" && VERSION.test(value) && !/(?:latest|stable|default)/i.test(value); }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function absolute(value) { if (!absoluteValue(value)) invalidInput(); return value; }
function absoluteValue(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096; }
function exactKeys(value, keys) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function plainRecord(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function invalidInput() { throw new Error("Windows SCM service bridge finalization input is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production") invalidInput();
  const options = parseWindowsScmServiceBridgeFinalizationArguments(process.argv.slice(2));
  const signer = await windowsScmServiceBridgeSignerFromEnvironment();
  const result = await finalizeWindowsScmServiceBridge(options, { signer });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.windows-scm-service-bridge-finalization-result.v1",
    architecture: result.manifest.claims.architecture,
    revision: result.manifest.claims.revision,
    manifestDigest: sha256Canonical(result.manifest),
    replayed: result.replayed,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[finalize:windows-scm-service-bridge] finalization failed\n");
    process.exitCode = 1;
  });
}
