#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateSteamDepotFinalizerServiceBuildReceipt } from "../build-steam-depot-finalizer-service.mjs";
import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import {
  validateSteamDepotFinalizerServiceTrustPolicy,
  verifySignedSteamDepotFinalizerServiceRelease,
} from "../../services/steam-depot-finalizer/src/native-service-release.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_TLS_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const CLOCK_SKEW_MS = 60_000;
const EVIDENCE_KEYS = Object.freeze([
  "artifactDigest", "buildReceiptDigest", "malwareScanDigest", "provenanceDigest", "sbomDigest", "scanState",
  "schemaVersion", "vulnerabilityScanDigest",
]);
const RESPONSE_KEYS = Object.freeze(["algorithm", "claimsDigest", "keyId", "schemaVersion", "signature"]);

export function parseSteamDepotFinalizerServiceFinalizationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 18) invalid();
  const allowed = new Set([
    "--artifact", "--build-receipt", "--evidence", "--output", "--published-at", "--release-id",
    "--source-revision", "--trust-policy", "--trust-policy-digest",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (!SOURCE_REVISION.test(values.get("--source-revision")) || !UUID.test(values.get("--release-id"))
    || !canonicalTimestamp(values.get("--published-at")) || !SHA256.test(values.get("--trust-policy-digest"))) invalid();
  return Object.freeze({
    artifactPath: absolute(values.get("--artifact")),
    buildReceiptPath: absolute(values.get("--build-receipt")),
    evidencePath: absolute(values.get("--evidence")),
    outputPath: absolute(values.get("--output")),
    publishedAt: values.get("--published-at"),
    releaseId: values.get("--release-id"),
    sourceRevision: values.get("--source-revision"),
    trustPolicyPath: absolute(values.get("--trust-policy")),
    trustPolicyDigest: values.get("--trust-policy-digest"),
  });
}

export async function prepareSteamDepotFinalizerServiceClaims(options) {
  validateOptions(options);
  const [artifact, buildBytes, evidence] = await Promise.all([
    fileMetadata(options.artifactPath, MAX_ARTIFACT_BYTES),
    boundedFile(options.buildReceiptPath, MAX_JSON_BYTES),
    readJson(options.evidencePath),
  ]);
  const build = validateSteamDepotFinalizerServiceBuildReceipt(parseJson(buildBytes));
  const buildReceiptDigest = hash(buildBytes);
  if (build.sourceRevision !== options.sourceRevision || build.artifactDigest !== artifact.digest
    || build.sizeBytes !== artifact.sizeBytes || Date.parse(options.publishedAt) < Date.parse(build.completedAt)) invalid();
  validateEvidence(evidence, artifact.digest, buildReceiptDigest);
  return Object.freeze({
    kind: "deviludo-steam-depot-finalizer-service",
    version: 1,
    releaseId: options.releaseId,
    platformVersion: build.platformVersion,
    sourceRevision: build.sourceRevision,
    nodeTarget: build.nodeTarget,
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.sizeBytes,
    buildReceiptDigest,
    packageLockDigest: build.packageLockDigest,
    bundleInputDigest: build.bundleInputDigest,
    sbomDigest: evidence.sbomDigest,
    malwareScanDigest: evidence.malwareScanDigest,
    vulnerabilityScanDigest: evidence.vulnerabilityScanDigest,
    provenanceDigest: evidence.provenanceDigest,
    publishedAt: options.publishedAt,
  });
}

export class MtlsSteamDepotFinalizerServiceSigner {
  constructor({ endpoint, keyId, tls, request = requestSigner }) {
    this.endpoint = signerEndpoint(endpoint);
    if (typeof keyId !== "string" || !SAFE_ID.test(keyId)) invalid();
    this.keyId = keyId;
    this.tls = validateTls(tls);
    this.request = request;
  }

  async sign(claims, trustPolicy, trustPolicyDigest, now = new Date()) {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) invalid();
    const trusted = validateSteamDepotFinalizerServiceTrustPolicy(trustPolicy, trustPolicyDigest);
    const key = trusted.keys.find((candidate) => candidate.keyId === this.keyId);
    const publishedAt = Date.parse(claims.publishedAt);
    if (!key || key.status !== "ACTIVE" || publishedAt > now.getTime() + CLOCK_SKEW_MS
      || publishedAt < Date.parse(key.notBefore) || publishedAt >= Date.parse(key.notAfter)
      || now.getTime() < Date.parse(key.notBefore) || now.getTime() >= Date.parse(key.notAfter)) invalid();
    const claimsDigest = sha256Canonical(claims);
    const response = await this.request(Object.freeze({
      url: new URL("/v1/steam-depot-finalizer-service-releases/sign-ed25519", this.endpoint),
      tls: this.tls,
      headers: Object.freeze({ "content-type": "application/json", "idempotency-key": claimsDigest }),
      body: JSON.stringify({
        schemaVersion: "deviludo.steam-depot-finalizer-service-signing-request.v1",
        keyId: this.keyId,
        claimsDigest,
        signingInput: Buffer.from(canonicalJson(claims), "utf8").toString("base64url"),
      }),
    }));
    if (response.statusCode !== 200 || !plainRecord(response.body) || !exactKeys(response.body, RESPONSE_KEYS)
      || response.body.schemaVersion !== "deviludo.steam-depot-finalizer-service-signing-response.v1"
      || response.body.algorithm !== "Ed25519" || response.body.keyId !== this.keyId
      || response.body.claimsDigest !== claimsDigest || typeof response.body.signature !== "string") invalid();
    const manifest = Object.freeze({ keyId: this.keyId, claims, signature: response.body.signature });
    verifyManifest(manifest, claims, trusted, trustPolicyDigest, now);
    return manifest;
  }
}

export async function steamDepotFinalizerServiceSignerFromEnv(env = process.env) {
  const [key, cert, ca] = await Promise.all([
    tlsFile(env.DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_SIGNER_TLS_KEY_FILE),
    tlsFile(env.DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_SIGNER_TLS_CERT_FILE),
    tlsFile(env.DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_SIGNER_TLS_CA_FILE),
  ]);
  return new MtlsSteamDepotFinalizerServiceSigner({
    endpoint: env.DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_SIGNER_ENDPOINT,
    keyId: env.DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_SIGNING_KEY_ID,
    tls: { key, cert, ca },
  });
}

export async function finalizeSteamDepotFinalizerService(options, { signer, now = new Date() } = {}) {
  if (!signer || typeof signer.sign !== "function" || !(now instanceof Date) || !Number.isFinite(now.getTime())) invalid();
  const [claims, trustPolicy] = await Promise.all([
    prepareSteamDepotFinalizerServiceClaims(options), readJson(options.trustPolicyPath),
  ]);
  const replay = await readJsonIfPresent(options.outputPath);
  if (replay) {
    if (canonicalJson(replay.claims) !== canonicalJson(claims)) invalid();
    verifyManifest(replay, claims, trustPolicy, options.trustPolicyDigest, now);
    return Object.freeze({ manifest: replay, replayed: true });
  }
  const parent = await lstat(dirname(options.outputPath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  const manifest = await signer.sign(claims, trustPolicy, options.trustPolicyDigest, now);
  try {
    const file = await open(options.outputPath, "wx", 0o400);
    try { await file.writeFile(`${canonicalJson(manifest)}\n`, "utf8"); await file.sync(); }
    finally { await file.close(); }
    return Object.freeze({ manifest, replayed: false });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readJson(options.outputPath);
    if (canonicalJson(existing) !== canonicalJson(manifest)) invalid();
    verifyManifest(existing, claims, trustPolicy, options.trustPolicyDigest, now);
    return Object.freeze({ manifest: existing, replayed: true });
  }
}

function verifyManifest(manifest, claims, trustPolicy, trustPolicyDigest, now) {
  return verifySignedSteamDepotFinalizerServiceRelease(manifest, {
    trustPolicy, trustPolicyDigest, platformVersion: claims.platformVersion, artifactDigest: claims.artifactDigest,
    artifactSizeBytes: claims.artifactSizeBytes, buildReceiptDigest: claims.buildReceiptDigest, now,
  });
}
function validateEvidence(value, artifactDigest, buildReceiptDigest) {
  if (!plainRecord(value) || !exactKeys(value, EVIDENCE_KEYS)
    || value.schemaVersion !== "deviludo.steam-depot-finalizer-service-evidence.v1" || value.scanState !== "PASS"
    || value.artifactDigest !== artifactDigest || value.buildReceiptDigest !== buildReceiptDigest
    || !SHA256.test(value.sbomDigest) || !SHA256.test(value.malwareScanDigest)
    || !SHA256.test(value.vulnerabilityScanDigest) || !SHA256.test(value.provenanceDigest)) invalid();
}
function validateOptions(options) {
  if (!plainRecord(options) || !absoluteValue(options.artifactPath) || !absoluteValue(options.buildReceiptPath)
    || !absoluteValue(options.evidencePath) || !absoluteValue(options.outputPath) || !absoluteValue(options.trustPolicyPath)
    || !SOURCE_REVISION.test(options.sourceRevision) || !UUID.test(options.releaseId)
    || !canonicalTimestamp(options.publishedAt) || !SHA256.test(options.trustPolicyDigest)) invalid();
}
async function fileMetadata(path, maximum) {
  const bytes = await boundedFile(path, maximum);
  return Object.freeze({ digest: hash(bytes), sizeBytes: bytes.byteLength });
}
async function boundedFile(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum || (before.mode & 0o022) !== 0) invalid();
    const value = await file.readFile(); const after = await file.stat();
    if (value.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return value;
  } finally { await file.close(); }
}
async function readJson(path) { return parseJson(await boundedFile(path, MAX_JSON_BYTES)); }
async function readJsonIfPresent(path) {
  try { return await readJson(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
async function tlsFile(path) {
  if (!absoluteValue(path)) invalid();
  const value = await boundedFile(path, MAX_TLS_BYTES);
  if (value.length < 32 || value.includes(0)) invalid();
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
        response.resume(); reject(new Error("Steam depot finalizer service signing response is invalid")); return;
      }
      const chunks = []; let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) request.destroy(new Error("Steam depot finalizer service signing response is invalid"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try { accept(Object.freeze({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) })); }
        catch { reject(new Error("Steam depot finalizer service signing response is invalid")); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Steam depot finalizer service signing request timed out")));
    request.on("error", reject); request.end(input.body);
  });
}
function signerEndpoint(value) {
  let url; try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(url.hostname)
    || !new Set(["", "443", "8443"]).has(url.port)) invalid();
  return url;
}
function validateTls(tls) {
  if (!plainRecord(tls) || !Buffer.isBuffer(tls.key) || !Buffer.isBuffer(tls.cert) || !Buffer.isBuffer(tls.ca)
    || [tls.key, tls.cert, tls.ca].some((value) => value.length < 32 || value.length > MAX_TLS_BYTES)) invalid();
  return Object.freeze({ key: Buffer.from(tls.key), cert: Buffer.from(tls.cert), ca: Buffer.from(tls.ca) });
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function parseJson(value) { try { return JSON.parse(value.toString("utf8")); } catch { invalid(); } }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function absolute(value) { if (!absoluteValue(value)) invalid(); return value; }
function absoluteValue(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096; }
function exactKeys(value, expected) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function invalid() { throw new Error("Steam depot finalizer service finalization input is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production") invalid();
  const options = parseSteamDepotFinalizerServiceFinalizationArguments(process.argv.slice(2));
  const signer = await steamDepotFinalizerServiceSignerFromEnv();
  const result = await finalizeSteamDepotFinalizerService(options, { signer });
  process.stdout.write(`${JSON.stringify({ status: "ok", releaseId: result.manifest.claims.releaseId, replayed: result.replayed })}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[finalize:steam-depot-finalizer-service] finalization failed\n"); process.exitCode = 1; });
}
