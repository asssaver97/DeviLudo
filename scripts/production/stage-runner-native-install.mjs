#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import { validateRunnerNativeInstallPlan } from "./plan-runner-native-install.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 1024 * 1024;
const RECEIPT_KEYS = Object.freeze([
  "architecture", "artifacts", "planDigest", "planFileDigest", "platform", "receiptDigest", "releaseDigest",
  "releaseDirectory", "releaseId", "schemaVersion", "stagedAt", "status",
]);
const RECEIPT_ARTIFACT_KEYS = Object.freeze(["component", "digest", "path", "readOnly", "sizeBytes"]);

export function parseRunnerNativeStagingArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) invalidInput();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--plan", "--plan-digest"]).has(name) || typeof value !== "string" || !value
      || values.has(name) || /[\0\r\n]/.test(value)) invalidInput();
    values.set(name, value);
  }
  if (!SHA256.test(values.get("--plan-digest"))) invalidInput();
  return Object.freeze({ planPath: absolute(values.get("--plan")), planDigest: values.get("--plan-digest") });
}

export async function stageRunnerNativeInstallation(planValue, expectedPlanDigest, {
  now = new Date(),
  uuid = randomUUID,
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf()) || typeof uuid !== "function") invalidInput();
  const plan = validateRunnerNativeInstallPlan(planValue, expectedPlanDigest);
  const installRoot = await verifiedDirectory(plan.installRoot);
  if (installRoot !== plan.installRoot) invalidInput();
  const releasesRoot = join(installRoot, "releases");
  await ensureReleaseRoot(releasesRoot, installRoot);
  const target = join(releasesRoot, plan.releaseId);
  if (target !== plan.releaseDirectory) invalidInput();
  const replay = await receiptIfPresent(target, plan);
  if (replay) return Object.freeze({ receipt: replay, replayed: true });
  const temporary = join(releasesRoot, `.staging-${plan.releaseId}-${uuid()}`);
  if (!boundaryPath(temporary, releasesRoot)) invalidInput();
  await mkdir(temporary, { mode: 0o700 });
  let published = false;
  try {
    const stagedArtifacts = [];
    for (const artifact of plan.artifacts) {
      const source = await fileMetadata(artifact.sourcePath, artifact.sizeLimitBytes);
      if (source.digest !== artifact.digest) invalidInput();
      const temporaryPath = join(temporary, basename(artifact.destinationPath));
      if (!boundaryPath(temporaryPath, temporary)) invalidInput();
      await copyFile(artifact.sourcePath, temporaryPath, constants.COPYFILE_EXCL);
      await chmod(temporaryPath, 0o500);
      const copied = await fileMetadata(temporaryPath, artifact.sizeLimitBytes);
      if (copied.digest !== artifact.digest || copied.sizeBytes !== source.sizeBytes) invalidInput();
      stagedArtifacts.push(Object.freeze({
        component: artifact.component,
        path: artifact.destinationPath,
        digest: artifact.digest,
        sizeBytes: copied.sizeBytes,
        readOnly: true,
      }));
    }
    const planBody = Buffer.from(`${canonicalJson(plan)}\n`, "utf8");
    await writeCreateOnly(join(temporary, "install-plan.json"), planBody, 0o400);
    const core = Object.freeze({
      schemaVersion: "deviludo.runner-native-staging-receipt.v1",
      status: "STAGED",
      planDigest: plan.planDigest,
      planFileDigest: digestBytes(planBody),
      releaseId: plan.releaseId,
      releaseDigest: plan.releaseDigest,
      platform: plan.platform,
      architecture: plan.architecture,
      releaseDirectory: plan.releaseDirectory,
      stagedAt: now.toISOString(),
      artifacts: Object.freeze(stagedArtifacts),
    });
    const receipt = Object.freeze({ ...core, receiptDigest: sha256Canonical(core) });
    await writeCreateOnly(join(temporary, "staging-receipt.json"), Buffer.from(`${canonicalJson(receipt)}\n`, "utf8"), 0o400);
    await rename(temporary, target);
    published = true;
    const verified = await verifyStagedRunnerNativeInstallation(plan, target);
    return Object.freeze({ receipt: verified, replayed: false });
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyStagedRunnerNativeInstallation(planValue, releaseDirectory) {
  const plan = validateRunnerNativeInstallPlan(planValue);
  if (!absoluteValue(releaseDirectory) || releaseDirectory !== plan.releaseDirectory) invalidInput();
  const root = await verifiedDirectory(releaseDirectory);
  if (root !== releaseDirectory) invalidInput();
  const [receipt, persistedPlanBytes] = await Promise.all([
    readBoundedJson(join(root, "staging-receipt.json")),
    readBoundedFile(join(root, "install-plan.json"), MAX_JSON_BYTES),
  ]);
  const persistedPlan = JSON.parse(persistedPlanBytes.toString("utf8"));
  if (canonicalJson(persistedPlan) !== canonicalJson(plan)) invalidInput();
  validateStagingReceipt(receipt, plan, digestBytes(persistedPlanBytes));
  for (const artifact of receipt.artifacts) {
    const expected = plan.artifacts.find((candidate) => candidate.component === artifact.component);
    if (!expected || artifact.path !== expected.destinationPath || dirname(artifact.path) !== root) invalidInput();
    const metadata = await fileMetadata(artifact.path, expected.sizeLimitBytes);
    if (metadata.digest !== artifact.digest || metadata.sizeBytes !== artifact.sizeBytes) invalidInput();
  }
  return deepFreeze(receipt);
}

export function validateStagingReceipt(receipt, plan, planFileDigest) {
  if (!plainRecord(receipt) || !exactKeys(receipt, RECEIPT_KEYS)
    || receipt.schemaVersion !== "deviludo.runner-native-staging-receipt.v1" || receipt.status !== "STAGED"
    || receipt.planDigest !== plan.planDigest || receipt.planFileDigest !== planFileDigest
    || receipt.releaseId !== plan.releaseId || receipt.releaseDigest !== plan.releaseDigest
    || receipt.platform !== plan.platform || receipt.architecture !== plan.architecture
    || receipt.releaseDirectory !== plan.releaseDirectory || !canonicalTimestamp(receipt.stagedAt)
    || !SHA256.test(receipt.receiptDigest) || receipt.receiptDigest !== sha256Canonical(withoutReceiptDigest(receipt))
    || !Array.isArray(receipt.artifacts) || receipt.artifacts.length !== plan.artifacts.length) invalidInput();
  for (let index = 0; index < receipt.artifacts.length; index += 1) {
    const artifact = receipt.artifacts[index];
    const expected = plan.artifacts[index];
    if (!plainRecord(artifact) || !exactKeys(artifact, RECEIPT_ARTIFACT_KEYS)
      || artifact.component !== expected.component || artifact.path !== expected.destinationPath
      || artifact.digest !== expected.digest || !PREFIXED_SHA256.test(artifact.digest)
      || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1
      || artifact.sizeBytes > expected.sizeLimitBytes || artifact.readOnly !== true) invalidInput();
  }
  return receipt;
}

async function receiptIfPresent(target, plan) {
  try { return await verifyStagedRunnerNativeInstallation(plan, target); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function ensureReleaseRoot(path, installRoot) {
  if (!boundaryPath(path, installRoot)) invalidInput();
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalidInput();
  if (await realpath(path) !== path) invalidInput();
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
    return Object.freeze({ digest: `sha256:${hash.digest("hex")}`, sizeBytes: metadata.size });
  } finally { await file.close(); }
}

async function writeCreateOnly(path, body, mode) {
  const file = await open(path, "wx", mode);
  try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
}

async function verifiedDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalidInput();
  return realpath(path);
}

async function readBoundedJson(path) {
  const body = await readBoundedFile(path, MAX_JSON_BYTES);
  try { return JSON.parse(body.toString("utf8")); } catch { invalidInput(); }
}

async function readBoundedFile(path, maximum) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximum) invalidInput();
  return readFile(path);
}

function digestBytes(value) { return createHash("sha256").update(value).digest("hex"); }
function withoutReceiptDigest(receipt) { return Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receiptDigest")); }
function boundaryPath(path, root) { return absoluteValue(path) && path !== root && path.startsWith(`${root}${sep}`); }
function absolute(value) { if (!absoluteValue(value)) invalidInput(); return value; }
function absoluteValue(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096; }
function exactKeys(value, keys) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function plainRecord(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const p = Object.getPrototypeOf(value); return p === Object.prototype || p === null; }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
function invalidInput() { throw new Error("Runner native installation staging input is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production") invalidInput();
  const options = parseRunnerNativeStagingArguments(process.argv.slice(2));
  const plan = await readBoundedJson(options.planPath);
  const result = await stageRunnerNativeInstallation(plan, options.planDigest);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.runner-native-staging-result.v1",
    releaseId: result.receipt.releaseId,
    planDigest: result.receipt.planDigest,
    receiptDigest: result.receipt.receiptDigest,
    replayed: result.replayed,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[stage:runner-native-install] staging failed\n");
    process.exitCode = 1;
  });
}
