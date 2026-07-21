#!/usr/bin/env node

import { lstat, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  prepareRunnerNativeReleaseClaims,
  runnerNativeReleaseSignerFromEnvironment,
} from "./runner-native-finalizer.mjs";
import {
  canonicalJson,
  sha256Canonical,
  verifyRunnerNativeRelease,
} from "./runner-native-release.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_JSON_BYTES = 1024 * 1024;

export function parseRunnerNativeFinalizationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 16) invalidInput();
  const allowed = new Set([
    "--artifacts", "--build-receipt", "--evidence", "--output", "--published-at", "--release-id",
    "--trust-policy", "--trust-policy-digest",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalidInput();
    values.set(name, value);
  }
  const releaseId = values.get("--release-id");
  const publishedAt = values.get("--published-at");
  const trustPolicyDigest = values.get("--trust-policy-digest");
  if (!UUID.test(releaseId) || !canonicalTimestamp(publishedAt) || !SHA256.test(trustPolicyDigest)) invalidInput();
  return Object.freeze({
    artifactDirectory: absolute(values.get("--artifacts")),
    buildReceiptPath: absolute(values.get("--build-receipt")),
    evidenceDirectory: absolute(values.get("--evidence")),
    outputPath: absolute(values.get("--output")),
    publishedAt,
    releaseId,
    trustPolicyPath: absolute(values.get("--trust-policy")),
    trustPolicyDigest,
  });
}

export async function finalizeRunnerNativeRelease(options, {
  signer,
  now = new Date(),
} = {}) {
  if (!options || !signer || typeof signer.sign !== "function" || !(now instanceof Date)
    || !Number.isFinite(now.valueOf())) invalidInput();
  const [buildReceipt, trustPolicy] = await Promise.all([
    readBoundedJson(options.buildReceiptPath),
    readBoundedJson(options.trustPolicyPath),
  ]);
  const replay = await readJsonIfPresent(options.outputPath);
  if (replay) {
    if (replay.claims?.releaseId !== options.releaseId || replay.claims?.publishedAt !== options.publishedAt) invalidInput();
    await verifyRunnerNativeRelease(replay, buildReceipt, trustPolicy, options.trustPolicyDigest, {
      artifactDirectory: options.artifactDirectory,
      now,
    });
    return Object.freeze({ release: replay, replayed: true });
  }
  await verifyOutputParent(options.outputPath);
  const claims = await prepareRunnerNativeReleaseClaims(buildReceipt, {
    artifactDirectory: options.artifactDirectory,
    evidenceDirectory: options.evidenceDirectory,
    releaseId: options.releaseId,
    publishedAt: options.publishedAt,
  });
  const release = await signer.sign(claims, buildReceipt, trustPolicy, options.trustPolicyDigest, now);
  await verifyRunnerNativeRelease(release, buildReceipt, trustPolicy, options.trustPolicyDigest, {
    artifactDirectory: options.artifactDirectory,
    now,
  });
  try {
    const file = await open(options.outputPath, "wx", 0o400);
    try { await file.writeFile(`${canonicalJson(release)}\n`, "utf8"); await file.sync(); }
    finally { await file.close(); }
    return Object.freeze({ release, replayed: false });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readBoundedJson(options.outputPath);
    if (canonicalJson(existing) !== canonicalJson(release)) invalidInput();
    await verifyRunnerNativeRelease(existing, buildReceipt, trustPolicy, options.trustPolicyDigest, {
      artifactDirectory: options.artifactDirectory,
      now,
    });
    return Object.freeze({ release: existing, replayed: true });
  }
}

async function verifyOutputParent(path) {
  const metadata = await lstat(dirname(path));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalidInput();
}

async function readBoundedJson(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_JSON_BYTES) invalidInput();
  try { return JSON.parse(await readFile(path, "utf8")); } catch { invalidInput(); }
}

async function readJsonIfPresent(path) {
  try { return await readBoundedJson(path); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function canonicalTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function absolute(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.length > 4_096) invalidInput();
  return value;
}

function invalidInput() {
  throw new Error("Runner native finalization input is invalid");
}

async function main() {
  if (process.env.NODE_ENV !== "production") invalidInput();
  const options = parseRunnerNativeFinalizationArguments(process.argv.slice(2));
  const signer = await runnerNativeReleaseSignerFromEnvironment();
  const result = await finalizeRunnerNativeRelease(options, { signer });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.runner-native-finalization-result.v1",
    releaseId: result.release.claims.releaseId,
    releaseDigest: sha256Canonical(result.release),
    replayed: result.replayed,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[finalize:runner-native] finalization failed\n");
    process.exitCode = 1;
  });
}
