#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import { validateSteamDepotFinalizerHostInstallPlan } from "./plan-steam-depot-finalizer-host-install.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
const RECEIPT_KEYS = Object.freeze([
  "architecture", "artifacts", "nativeReleaseDigest", "planDigest", "planFileDigest", "platform", "receiptDigest",
  "releaseDirectory", "releaseId", "schemaVersion", "serviceReleaseDigest", "stagedAt", "status",
]);

export function parseSteamDepotFinalizerHostStagingArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) invalid();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!new Set(["--plan", "--plan-digest"]).has(name) || typeof value !== "string" || !value
      || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (!SHA256.test(values.get("--plan-digest"))) invalid();
  return Object.freeze({ planPath: absolute(values.get("--plan")), planDigest: values.get("--plan-digest") });
}

export async function stageSteamDepotFinalizerHostInstallation(planValue, expectedPlanDigest, {
  now = new Date(), uuid = randomUUID,
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || typeof uuid !== "function") invalid();
  const plan = validateSteamDepotFinalizerHostInstallPlan(planValue, expectedPlanDigest);
  const installRoot = await exactDirectory(plan.installRoot);
  if (installRoot !== plan.installRoot) invalid();
  await exactDirectory(plan.workRoot);
  const releasesRoot = join(installRoot, "releases");
  await ensureReleasesRoot(releasesRoot, installRoot);
  const target = join(releasesRoot, plan.releaseId);
  if (target !== plan.releaseDirectory) invalid();
  const replay = await receiptIfPresent(plan, target);
  if (replay) return Object.freeze({ receipt: replay, replayed: true });
  const temporary = join(releasesRoot, `.staging-${plan.releaseId}-${uuid()}`);
  if (!boundary(temporary, releasesRoot)) invalid();
  await mkdir(temporary, { mode: 0o700 });
  let published = false;
  try {
    const stagedArtifacts = [];
    for (const artifact of plan.artifacts) {
      const maximum = maximumBytes(artifact.component);
      const source = await fileMetadata(artifact.sourcePath, maximum);
      if (source.digest !== artifact.digest) invalid();
      const temporaryPath = join(temporary, basename(artifact.destinationPath));
      if (!boundary(temporaryPath, temporary)) invalid();
      await copyCreateOnly(artifact.sourcePath, temporaryPath, artifactMode(artifact.mode), maximum);
      const copied = await fileMetadata(temporaryPath, maximum);
      if (copied.digest !== artifact.digest || copied.sizeBytes !== source.sizeBytes) invalid();
      stagedArtifacts.push(Object.freeze({
        component: artifact.component,
        path: artifact.destinationPath,
        digest: artifact.digest,
        sizeBytes: copied.sizeBytes,
        mode: artifact.mode,
      }));
    }
    const planBody = Buffer.from(`${canonicalJson(plan)}\n`, "utf8");
    await writeCreateOnly(join(temporary, "install-plan.json"), planBody, 0o400);
    const core = Object.freeze({
      schemaVersion: "deviludo.steam-depot-finalizer-host-staging-receipt.v1",
      status: "STAGED",
      planDigest: plan.planDigest,
      planFileDigest: digest(planBody),
      releaseId: plan.releaseId,
      serviceReleaseDigest: plan.serviceReleaseDigest,
      nativeReleaseDigest: plan.nativeReleaseDigest,
      platform: plan.platform,
      architecture: plan.architecture,
      releaseDirectory: plan.releaseDirectory,
      stagedAt: now.toISOString(),
      artifacts: Object.freeze(stagedArtifacts),
    });
    const receipt = Object.freeze({ ...core, receiptDigest: sha256Canonical(core) });
    await writeCreateOnly(join(temporary, "staging-receipt.json"),
      Buffer.from(`${canonicalJson(receipt)}\n`, "utf8"), 0o400);
    await chmod(temporary, 0o500);
    await rename(temporary, target);
    published = true;
    return Object.freeze({ receipt: await verifyStagedSteamDepotFinalizerHost(plan, target), replayed: false });
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyStagedSteamDepotFinalizerHost(planValue, releaseDirectory) {
  const plan = validateSteamDepotFinalizerHostInstallPlan(planValue);
  if (!absoluteValue(releaseDirectory) || releaseDirectory !== plan.releaseDirectory) invalid();
  const root = await exactDirectory(releaseDirectory);
  if (root !== releaseDirectory) invalid();
  const [receipt, persistedPlanBytes] = await Promise.all([
    readJson(join(root, "staging-receipt.json"), MAX_JSON_BYTES),
    readFile(join(root, "install-plan.json"), MAX_JSON_BYTES),
  ]);
  if (canonicalJson(JSON.parse(persistedPlanBytes.toString("utf8"))) !== canonicalJson(plan)) invalid();
  validateSteamDepotFinalizerHostStagingReceipt(receipt, plan, digest(persistedPlanBytes));
  for (const artifact of receipt.artifacts) {
    const expected = plan.artifacts.find((candidate) => candidate.component === artifact.component);
    if (!expected || artifact.path !== expected.destinationPath || dirname(artifact.path) !== root) invalid();
    const metadata = await fileMetadata(artifact.path, maximumBytes(artifact.component));
    if (metadata.digest !== artifact.digest || metadata.sizeBytes !== artifact.sizeBytes) invalid();
  }
  return deepFreeze(receipt);
}

export function validateSteamDepotFinalizerHostStagingReceipt(receipt, plan, planFileDigest) {
  if (!plainRecord(receipt) || !exactKeys(receipt, RECEIPT_KEYS)
    || receipt.schemaVersion !== "deviludo.steam-depot-finalizer-host-staging-receipt.v1"
    || receipt.status !== "STAGED" || receipt.planDigest !== plan.planDigest
    || receipt.planFileDigest !== planFileDigest || receipt.releaseId !== plan.releaseId
    || receipt.serviceReleaseDigest !== plan.serviceReleaseDigest
    || receipt.nativeReleaseDigest !== plan.nativeReleaseDigest || receipt.platform !== plan.platform
    || receipt.architecture !== plan.architecture || receipt.releaseDirectory !== plan.releaseDirectory
    || !canonicalTimestamp(receipt.stagedAt) || !SHA256.test(receipt.receiptDigest)
    || receipt.receiptDigest !== sha256Canonical(withoutReceiptDigest(receipt))
    || !Array.isArray(receipt.artifacts) || receipt.artifacts.length !== plan.artifacts.length) invalid();
  for (let index = 0; index < receipt.artifacts.length; index += 1) {
    const value = receipt.artifacts[index]; const expected = plan.artifacts[index];
    if (!plainRecord(value) || !exactKeys(value, ["component", "digest", "mode", "path", "sizeBytes"])
      || value.component !== expected.component || value.path !== expected.destinationPath
      || value.digest !== expected.digest || !SHA256.test(value.digest) || value.mode !== expected.mode
      || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1
      || value.sizeBytes > maximumBytes(value.component)) invalid();
  }
  return receipt;
}

async function copyCreateOnly(sourcePath, destinationPath, mode, maximum) {
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum || (before.mode & 0o022) !== 0) invalid();
    destination = await open(destinationPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead < 1) invalid();
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten < 1) invalid();
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const after = await source.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    await destination.sync();
  } finally {
    await destination?.close();
    await source.close();
  }
}

async function fileMetadata(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum || (before.mode & 0o022) !== 0) invalid();
    const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0;
    while (position < before.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead < 1) invalid();
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return Object.freeze({ digest: hash.digest("hex"), sizeBytes: before.size });
  } finally { await file.close(); }
}
async function exactDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid();
  return realpath(path);
}
async function ensureReleasesRoot(path, root) {
  if (!boundary(path, root)) invalid();
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  if (await exactDirectory(path) !== path) invalid();
}
async function writeCreateOnly(path, body, mode) {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
}
async function readFile(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const metadata = await file.stat(); if (!metadata.isFile() || metadata.size < 2 || metadata.size > maximum) invalid(); return file.readFile(); }
  finally { await file.close(); }
}
async function readJson(path, maximum) { try { return JSON.parse((await readFile(path, maximum)).toString("utf8")); } catch { invalid(); } }
async function receiptIfPresent(plan, target) { try { return await verifyStagedSteamDepotFinalizerHost(plan, target); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
function maximumBytes(component) { return component === "serviceArtifact" || component === "nativeArtifact" ? MAX_ARTIFACT_BYTES : component === "environment" ? MAX_ENV_BYTES : MAX_JSON_BYTES; }
function artifactMode(value) { if (value === "OWNER_READ_EXECUTE") return 0o500; if (value === "OWNER_READ_ONLY") return 0o400; invalid(); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function withoutReceiptDigest(value) { return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "receiptDigest")); }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function boundary(path, root) { return absoluteValue(path) && path !== root && path.startsWith(`${root}${sep}`); }
function absolute(value) { if (!absoluteValue(value)) invalid(); return value; }
function absoluteValue(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096; }
function exactKeys(value, expected) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
function invalid() { throw new Error("Steam depot finalizer host staging input is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production") invalid();
  const options = parseSteamDepotFinalizerHostStagingArguments(process.argv.slice(2));
  const plan = await readJson(options.planPath, MAX_JSON_BYTES);
  const result = await stageSteamDepotFinalizerHostInstallation(plan, options.planDigest);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.steam-depot-finalizer-host-staging-result.v1",
    releaseId: result.receipt.releaseId,
    planDigest: result.receipt.planDigest,
    receiptDigest: result.receipt.receiptDigest,
    replayed: result.replayed,
  })}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[stage:steam-depot-finalizer-host] staging failed\n");
    process.exitCode = 1;
  });
}
