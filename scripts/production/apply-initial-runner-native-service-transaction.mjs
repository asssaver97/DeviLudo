#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import {
  NodePosixRunnerNativeHost,
  activateRunnerNativeDefinitions,
  assertRunnerNativeDefinitionsRunning,
  assertRunnerNativeHostBinding,
  preflightRunnerNativeLockedFiles,
  validateRunnerNativeDefinitions,
} from "./apply-runner-native-service-transaction.mjs";
import { prepareRunnerNativeServiceTransaction } from "./compile-runner-native-service-transaction.mjs";
import { validateRunnerNativeInstallPlan } from "./plan-runner-native-install.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export function parseInitialRunnerNativeActuationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 10) invalid();
  const allowed = new Set(["--output", "--plan", "--plan-digest", "--transaction", "--transaction-digest"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (!SHA256.test(values.get("--plan-digest")) || !SHA256.test(values.get("--transaction-digest"))) invalid();
  return Object.freeze({
    outputPath: absolute(values.get("--output")),
    planPath: absolute(values.get("--plan")),
    planDigest: values.get("--plan-digest"),
    transactionPath: absolute(values.get("--transaction")),
    transactionDigest: values.get("--transaction-digest"),
    windowsBridgePath: null,
    windowsBridgeManifestPath: null,
    windowsBridgeTrustPolicyPath: null,
    windowsBridgeTrustPolicyDigest: null,
  });
}

export async function verifyInitialRunnerNativeActuation(options, dependencies = {}) {
  const prepare = dependencies.prepareTransaction ?? prepareRunnerNativeServiceTransaction;
  const [planValue, transaction, expected] = await Promise.all([
    readJson(options.planPath), readJson(options.transactionPath), prepare(options),
  ]);
  const plan = validateRunnerNativeInstallPlan(planValue, options.planDigest);
  if (canonicalJson(transaction) !== canonicalJson(expected) || transaction.transactionDigest !== options.transactionDigest
    || transaction.status !== "READY" || plan.activation.mode !== "INITIAL_ENROLLMENT" || plan.rollback !== null
    || plan.activation.activationGrantFile !== null || transaction.activation?.mode !== "INITIAL_ENROLLMENT"
    || transaction.activation?.grantFile !== null || transaction.rollback !== null) invalid();
  return Object.freeze({ plan, transaction });
}

export async function applyInitialRunnerNativeServiceTransaction(options, dependencies = {}) {
  const verified = await verifyInitialRunnerNativeActuation(options, dependencies);
  const host = dependencies.host ?? new NodePosixRunnerNativeHost();
  const now = dependencies.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) invalid();
  const { plan, transaction } = verified;
  assertRunnerNativeHostBinding(host, transaction);
  validateRunnerNativeDefinitions(transaction);
  const journalPath = `${options.outputPath}.journal`;
  const existingReceipt = await optionalJson(options.outputPath);
  if (existingReceipt !== null) return validateReceipt(existingReceipt, transaction);
  const interrupted = await optionalJson(journalPath);
  if (interrupted !== null) {
    validateJournal(interrupted, transaction);
    await removeInitialDefinitions(host, transaction);
    const receipt = createReceipt(transaction, "ROLLED_BACK", "RECOVER_INTERRUPTED_ENROLLMENT", now.toISOString());
    await createOnlyJson(options.outputPath, receipt); await rm(journalPath, { force: true });
    return receipt;
  }
  await preflightRunnerNativeLockedFiles(host, transaction);
  for (const definition of transaction.definitions) {
    if (await host.readDefinition(definition.destination) !== null) {
      throw new Error("Initial Runner enrollment refuses to replace an existing service definition");
    }
  }
  await createOnlyJson(journalPath, createJournal(transaction, now.toISOString()));
  let failure = null;
  try {
    for (const definition of transaction.definitions) {
      await host.writeDefinition(definition.destination, Buffer.from(definition.rendered, "utf8"));
    }
    await activateRunnerNativeDefinitions(host, transaction);
    await assertRunnerNativeDefinitionsRunning(host, transaction);
  } catch {
    failure = "INITIAL_ENROLLMENT_ACTIVATION_FAILED";
    await removeInitialDefinitions(host, transaction);
  }
  const receipt = createReceipt(transaction, failure === null ? "SERVICES_STARTED" : "ROLLED_BACK", failure, now.toISOString());
  await createOnlyJson(options.outputPath, receipt); await rm(journalPath, { force: true });
  return receipt;
}

async function removeInitialDefinitions(host, transaction) {
  for (const definition of [...transaction.definitions].reverse()) {
    const current = await host.readDefinition(definition.destination);
    if (current === null) continue;
    if (createHash("sha256").update(current).digest("hex") !== definition.renderedDigest) {
      throw new Error("Runner initial enrollment recovery requires manual service review");
    }
    if (transaction.platform === "linux") {
      await host.run("/usr/bin/systemctl", ["stop", definition.serviceId], { allowFailure: true });
      await host.run("/usr/bin/systemctl", ["disable", definition.serviceId], { allowFailure: true });
    } else {
      await host.run("/bin/launchctl", ["bootout", `system/${definition.serviceId}`], { allowFailure: true });
    }
    await host.removeDefinition(definition.destination);
  }
  if (transaction.platform === "linux") await host.run("/usr/bin/systemctl", ["daemon-reload"]);
}

function createJournal(transaction, preparedAt) {
  const core = Object.freeze({
    schemaVersion: "deviludo.runner-native-initial-enrollment-journal.v1",
    state: "PREPARED",
    transactionDigest: transaction.transactionDigest,
    platform: transaction.platform,
    architecture: transaction.architecture,
    preparedAt,
  });
  return Object.freeze({ ...core, journalDigest: sha256Canonical(core) });
}
function validateJournal(value, transaction) {
  if (!record(value) || value.schemaVersion !== "deviludo.runner-native-initial-enrollment-journal.v1"
    || value.state !== "PREPARED" || value.transactionDigest !== transaction.transactionDigest
    || value.platform !== transaction.platform || value.architecture !== transaction.architecture) invalid();
  const core = { ...value }; delete core.journalDigest;
  if (value.journalDigest !== sha256Canonical(core)) invalid();
}
function createReceipt(transaction, state, failureCode, completedAt) {
  const core = Object.freeze({
    schemaVersion: "deviludo.runner-native-initial-enrollment-receipt.v1",
    state,
    releaseId: transaction.releaseId,
    planDigest: transaction.planDigest,
    transactionDigest: transaction.transactionDigest,
    stagingReceiptDigest: transaction.stagingReceiptDigest,
    platform: transaction.platform,
    architecture: transaction.architecture,
    failureCode,
    completedAt,
  });
  return Object.freeze({ ...core, receiptDigest: sha256Canonical(core) });
}
function validateReceipt(value, transaction) {
  if (!record(value) || value.schemaVersion !== "deviludo.runner-native-initial-enrollment-receipt.v1"
    || !new Set(["SERVICES_STARTED", "ROLLED_BACK"]).has(value.state) || value.releaseId !== transaction.releaseId
    || value.planDigest !== transaction.planDigest || value.transactionDigest !== transaction.transactionDigest
    || value.stagingReceiptDigest !== transaction.stagingReceiptDigest || value.platform !== transaction.platform
    || value.architecture !== transaction.architecture) invalid();
  const core = { ...value }; delete core.receiptDigest;
  if (value.receiptDigest !== sha256Canonical(core)) invalid();
  return Object.freeze({ ...value });
}
async function readJson(path) { const metadata = await lstat(path); if (!metadata.isFile() || metadata.isSymbolicLink()
  || metadata.size < 2 || metadata.size > MAX_JSON_BYTES) invalid(); try { return JSON.parse(await readFile(path, "utf8")); } catch { invalid(); } }
async function optionalJson(path) { try { return await readJson(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function createOnlyJson(path, value) { const parent = await lstat(dirname(path)); if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  const body = `${canonicalJson(value)}\n`; try { const file = await open(path, "wx", 0o400); try { await file.writeFile(body); await file.sync(); } finally { await file.close(); } }
  catch (error) { if (error?.code !== "EEXIST" || canonicalJson(await readJson(path)) !== canonicalJson(value)) throw error; } }
function absolute(value) { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/.test(value)) invalid(); return value; }
function record(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function invalid() { throw new Error("Initial Runner native actuation input is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production" || typeof process.getuid !== "function" || process.getuid() !== 0) invalid();
  const receipt = await applyInitialRunnerNativeServiceTransaction(parseInitialRunnerNativeActuationArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(receipt)}\n`); if (receipt.state !== "SERVICES_STARTED") process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[apply:initial-runner-native] actuation failed\n"); process.exitCode = 1; });
}
