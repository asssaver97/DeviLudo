#!/usr/bin/env node

import { createHash, createPublicKey } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import { verifyRunnerNativeInstallActivationGrant } from "../../services/runner-control/src/native-install.ts";
import { physicalRunnerIngressClientFromEnv } from "../../services/runner-control/src/runner-ingress-client.ts";
import {
  prepareRunnerNativeServiceTransaction,
} from "./compile-runner-native-service-transaction.mjs";
import { validateRunnerNativeInstallPlan } from "./plan-runner-native-install.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_DEFINITION_BYTES = 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_ENVIRONMENT_BYTES = 256 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const SERVICE_IDS = Object.freeze({
  linux: Object.freeze({
    "physical-runner": "deviludo-physical-runner.service",
    "steam-client-connector": "deviludo-steam-client-connector.service",
  }),
  macos: Object.freeze({
    "physical-runner": "com.deviludo.physical-runner",
    "steam-client-connector": "com.deviludo.steam-client-connector",
  }),
});

export function parseRunnerNativeServiceActuationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 12) invalidInput();
  const allowed = new Set([
    "--activation-grant", "--output", "--plan", "--plan-digest", "--transaction", "--transaction-digest",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) {
      invalidInput();
    }
    values.set(name, value);
  }
  if (!SHA256.test(values.get("--plan-digest")) || !SHA256.test(values.get("--transaction-digest"))) invalidInput();
  return Object.freeze({
    activationGrantPath: absolute(values.get("--activation-grant")),
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

export async function verifyRunnerNativeServiceActuation(options, dependencies = {}) {
  const prepareTransaction = dependencies.prepareTransaction ?? prepareRunnerNativeServiceTransaction;
  const now = dependencies.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf()) || !plainRecord(options)
    || !SHA256.test(options.planDigest) || !SHA256.test(options.transactionDigest)
    || !absoluteValue(options.planPath) || !absoluteValue(options.transactionPath)
    || !absoluteValue(options.activationGrantPath) || !absoluteValue(options.outputPath)
    || typeof options.keyId !== "string" || !SAFE_ID.test(options.keyId) || !options.publicKey) invalidInput();
  const [planValue, transaction, grantValue, expected, replayReceipt, recoveryJournal, failureRecord] = await Promise.all([
    readBoundedJson(options.planPath),
    readBoundedJson(options.transactionPath),
    readBoundedJson(options.activationGrantPath),
    prepareTransaction(options),
    readJsonIfPresent(options.outputPath),
    readJsonIfPresent(`${options.outputPath}.journal`),
    readJsonIfPresent(`${options.outputPath}.failure`),
  ]);
  const plan = validateRunnerNativeInstallPlan(planValue, options.planDigest);
  if (canonicalJson(transaction) !== canonicalJson(expected)
    || transaction.transactionDigest !== options.transactionDigest
    || transaction.transactionDigest !== transactionDigest(transaction)
    || transaction.status !== "READY" || transaction.activation?.mode !== "DRAINED_UPGRADE"
    || transaction.rollback === null || transaction.activation?.grantFile !== options.activationGrantPath
    || plan.activation.mode !== "DRAINED_UPGRADE" || plan.rollback === null) invalidInput();
  const grant = verifyRunnerNativeInstallActivationGrant(grantValue, {
    publicKey: options.publicKey,
    keyId: options.keyId,
    now: now.toISOString(),
    allowExpired: replayReceipt !== null || recoveryJournal !== null || failureRecord !== null,
  });
  assertGrantBinding(plan, transaction, grant);
  return deepFreeze({ plan, transaction, grant });
}

export async function applyRunnerNativeServiceTransaction(options, dependencies = {}) {
  const authorization = await verifyRunnerNativeServiceActuation(options, dependencies);
  const host = dependencies.host ?? new NodePosixRunnerNativeHost();
  const reportRollback = dependencies.reportRollback ?? (async (grant, failureDigest) => {
    const ingress = await physicalRunnerIngressClientFromEnv();
    return ingress.rollbackNativeInstall(grant, failureDigest);
  });
  return executeRunnerNativeServiceTransaction({
    ...authorization,
    outputPath: options.outputPath,
  }, { host, reportRollback, now: dependencies.now ?? new Date() });
}

async function executeRunnerNativeServiceTransaction(input, dependencies = {}) {
  const host = dependencies.host;
  const reportRollback = dependencies.reportRollback;
  const now = dependencies.now ?? new Date();
  if (!host || typeof host.readDefinition !== "function" || typeof host.writeDefinition !== "function"
    || typeof host.removeDefinition !== "function" || typeof host.digestFile !== "function"
    || typeof host.run !== "function" || typeof host.sleep !== "function" || typeof reportRollback !== "function"
    || !(now instanceof Date)
    || !Number.isFinite(now.valueOf()) || !absoluteValue(input.outputPath)) invalidInput();
  const { plan, transaction, grant } = input;
  assertGrantBinding(plan, transaction, grant);
  assertRunnerNativeHostBinding(host, transaction);
  validateRunnerNativeDefinitions(transaction);
  const journalPath = `${input.outputPath}.journal`;
  const failurePath = `${input.outputPath}.failure`;
  const existingReceipt = await readJsonIfPresent(input.outputPath);
  if (existingReceipt !== null) {
    const receipt = validateExecutionReceipt(existingReceipt, transaction, grant);
    await rm(journalPath, { force: true });
    await rm(failurePath, { force: true });
    return receipt;
  }
  const interrupted = await readJsonIfPresent(journalPath);
  if (interrupted !== null) {
    const journal = validateActuationJournal(interrupted, transaction);
    await rollbackDefinitions(host, transaction, journal.previousDefinitions);
    let failure = await readJsonIfPresent(failurePath);
    if (failure === null) {
      failure = createActuationFailure(transaction, "RECOVER_INTERRUPTED_ACTUATION", now.toISOString());
      await createOnlyJson(failurePath, failure);
    } else failure = validateActuationFailure(failure, transaction);
    await reportRollback(grant, failure.failureDigest);
    const receipt = createExecutionReceipt(
      transaction, grant, journal.previousDefinitions, now.toISOString(), failure.failureDigest);
    await createOnlyJson(input.outputPath, receipt);
    await rm(journalPath, { force: true });
    await rm(failurePath, { force: true });
    return receipt;
  }
  if (await readJsonIfPresent(failurePath) !== null) invalidInput();
  await preflightRunnerNativeLockedFiles(host, transaction);
  const previousDefinitions = [];
  for (const definition of transaction.definitions) {
    const body = await host.readDefinition(definition.destination);
    if (!Buffer.isBuffer(body) || body.length < 1 || body.length > MAX_DEFINITION_BYTES) invalidInput();
    previousDefinitions.push(Object.freeze({
      component: definition.component,
      destination: definition.destination,
      bodyBase64: body.toString("base64"),
      digest: createHash("sha256").update(body).digest("hex"),
    }));
  }
  const journal = createActuationJournal(transaction, previousDefinitions, now.toISOString());
  await createOnlyJson(journalPath, journal);
  let step = "INSTALL_DEFINITIONS";
  let failure = null;
  try {
    for (const definition of transaction.definitions) {
      await host.writeDefinition(definition.destination, Buffer.from(definition.rendered, "utf8"));
    }
    step = "ACTIVATE_SERVICES";
    await activateRunnerNativeDefinitions(host, transaction);
    step = "ASSERT_RUNNING";
    await assertRunnerNativeDefinitionsRunning(host, transaction);
  } catch {
    try {
      await rollbackDefinitions(host, transaction, previousDefinitions);
    } catch {
      throw new Error("Runner native service actuation rollback requires host recovery");
    }
    failure = createActuationFailure(transaction, step, now.toISOString());
    await createOnlyJson(failurePath, failure);
  }
  if (failure !== null) await reportRollback(grant, failure.failureDigest);
  const receipt = createExecutionReceipt(
    transaction, grant, previousDefinitions, now.toISOString(), failure?.failureDigest ?? null);
  await createOnlyJson(input.outputPath, receipt);
  await rm(journalPath, { force: true });
  await rm(failurePath, { force: true });
  return receipt;
}

export class NodePosixRunnerNativeHost {
  constructor(runtime = process) {
    this.platform = targetPlatform(runtime.platform);
    this.architecture = targetArchitecture(runtime.arch);
    if (this.platform === "windows") {
      throw new Error("A separately signed Windows native host actuator is required");
    }
  }

  async readDefinition(path) {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_DEFINITION_BYTES) {
        invalidInput();
      }
      return readFile(path);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeDefinition(path, body) {
    if (!Buffer.isBuffer(body) || body.length < 1 || body.length > MAX_DEFINITION_BYTES) invalidInput();
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink()) invalidInput();
    const temporary = `${path}.deviludo-actuator-${process.pid}.tmp`;
    let created = false;
    try {
      const file = await open(temporary, "wx", 0o400);
      created = true;
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      await chmod(temporary, 0o444);
      await rename(temporary, path);
      created = false;
    } finally {
      if (created) await rm(temporary, { force: true });
    }
  }

  async removeDefinition(path) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) invalidInput();
    await unlink(path);
  }

  async digestFile(path, maximumBytes) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumBytes) invalidInput();
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
      return hash.digest("hex");
    } finally { await file.close(); }
  }

  async run(command, args, { allowFailure = false } = {}) {
    if (!absoluteValue(command) || !Array.isArray(args) || args.some((value) =>
      typeof value !== "string" || !value || value.length > 4_096 || /[\0\r\n]/.test(value))) invalidInput();
    const result = await executeFixed(command, args);
    if (!allowFailure && result.exitCode !== 0) throw new Error("Runner native fixed host action failed");
    return result;
  }

  async sleep(milliseconds) {
    await new Promise((accept) => setTimeout(accept, milliseconds));
  }
}

function assertGrantBinding(plan, transaction, grant) {
  if (!plainRecord(plan) || !plainRecord(transaction) || !plainRecord(grant) || !plainRecord(grant.payload)
    || transaction.schemaVersion !== "deviludo.runner-native-service-transaction.v1"
    || transaction.transactionDigest !== transactionDigest(transaction) || transaction.status !== "READY"
    || transaction.planDigest !== plan.planDigest || transaction.releaseId !== plan.releaseId
    || transaction.releaseDigest !== plan.releaseDigest || transaction.platform !== plan.platform
    || transaction.architecture !== plan.architecture || transaction.stagingReceiptDigest !== grant.payload.stagingReceiptDigest
    || grant.payload.planDigest !== plan.planDigest || grant.payload.releaseId !== plan.releaseId
    || grant.payload.releaseDigest !== plan.releaseDigest || grant.payload.platform !== plan.platform
    || grant.payload.architecture !== plan.architecture || grant.payload.targetRunnerId !== plan.machine.runnerId
    || grant.payload.targetSpiffeId !== plan.machine.runnerSpiffeId
    || grant.payload.targetCapabilityDigest !== plan.machine.capabilityDigest
    || plan.activation.mode !== "DRAINED_UPGRADE" || plan.rollback === null
    || transaction.activation?.mode !== "DRAINED_UPGRADE" || transaction.rollback === null) invalidInput();
}

export function assertRunnerNativeHostBinding(host, transaction) {
  if (!new Set(["linux", "macos"]).has(host.platform) || !new Set(["x86_64", "arm64"]).has(host.architecture)
    || host.platform !== transaction.platform || host.architecture !== transaction.architecture) invalidInput();
}

export function validateRunnerNativeDefinitions(transaction) {
  if (!Array.isArray(transaction.definitions) || transaction.definitions.length < 1 || transaction.definitions.length > 2
    || transaction.managerTool !== (transaction.platform === "linux" ? "/usr/bin/systemctl" : "/bin/launchctl")) {
    invalidInput();
  }
  const expectedIds = SERVICE_IDS[transaction.platform];
  for (const definition of transaction.definitions) {
    const serviceId = expectedIds?.[definition.component];
    const destination = transaction.platform === "linux" ? `/etc/systemd/system/${serviceId}`
      : `/Library/LaunchDaemons/${serviceId}.plist`;
    if (!serviceId || definition.serviceId !== serviceId || definition.destination !== destination
      || typeof definition.rendered !== "string" || definition.rendered.length < 1
      || Buffer.byteLength(definition.rendered) > MAX_DEFINITION_BYTES
      || createHash("sha256").update(definition.rendered).digest("hex") !== definition.renderedDigest
      || definition.targetExecutable !== null || definition.targetExecutableDigest !== null) invalidInput();
  }
  const components = transaction.definitions.map(({ component }) => component);
  const expected = transaction.definitions.length === 2
    ? ["steam-client-connector", "physical-runner"] : ["physical-runner"];
  if (JSON.stringify(components) !== JSON.stringify(expected)
    || JSON.stringify(transaction.activation.startOrder) !== JSON.stringify(expected)) invalidInput();
}

export async function preflightRunnerNativeLockedFiles(host, transaction) {
  for (const definition of transaction.definitions) {
    const [executableDigest, environmentDigest] = await Promise.all([
      host.digestFile(definition.executable, MAX_EXECUTABLE_BYTES),
      host.digestFile(definition.environmentSourcePath, MAX_ENVIRONMENT_BYTES),
    ]);
    if (executableDigest !== rawDigest(definition.executableDigest)
      || environmentDigest !== definition.environmentSourceDigest) invalidInput();
  }
}

export async function activateRunnerNativeDefinitions(host, transaction) {
  if (transaction.platform === "linux") {
    await host.run("/usr/bin/systemctl", ["daemon-reload"]);
    for (const definition of transaction.definitions) {
      await host.run("/usr/bin/systemctl", ["enable", definition.serviceId]);
      await host.run("/usr/bin/systemctl", ["restart", definition.serviceId]);
    }
    return;
  }
  for (const definition of transaction.definitions) {
    await host.run("/bin/launchctl", ["bootout", `system/${definition.serviceId}`], { allowFailure: true });
    await host.run("/bin/launchctl", ["bootstrap", "system", definition.destination]);
    await host.run("/bin/launchctl", ["kickstart", "-k", `system/${definition.serviceId}`]);
  }
}

export async function assertRunnerNativeDefinitionsRunning(host, transaction) {
  for (const definition of transaction.definitions) {
    let active = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = transaction.platform === "linux"
        ? await host.run("/usr/bin/systemctl", ["is-active", "--quiet", definition.serviceId], { allowFailure: true })
        : await host.run("/bin/launchctl", ["print", `system/${definition.serviceId}`], { allowFailure: true });
      if (result.exitCode === 0) { active = true; break; }
      await host.sleep(1_000);
    }
    if (!active) throw new Error("Runner native service did not become active");
  }
}

async function rollbackDefinitions(host, transaction, previousDefinitions) {
  for (const definition of [...transaction.definitions].reverse()) {
    if (transaction.platform === "linux") {
      await host.run("/usr/bin/systemctl", ["stop", definition.serviceId], { allowFailure: true });
    } else {
      await host.run("/bin/launchctl", ["bootout", `system/${definition.serviceId}`], { allowFailure: true });
    }
  }
  for (const previous of previousDefinitions) {
    const body = Buffer.from(previous.bodyBase64, "base64");
    if (body.length < 1 || body.length > MAX_DEFINITION_BYTES
      || createHash("sha256").update(body).digest("hex") !== previous.digest) invalidInput();
    await host.writeDefinition(previous.destination, body);
  }
  if (transaction.platform === "linux") {
    await host.run("/usr/bin/systemctl", ["daemon-reload"]);
    for (const definition of transaction.definitions) {
      await host.run("/usr/bin/systemctl", ["restart", definition.serviceId]);
    }
  } else {
    for (const definition of transaction.definitions) {
      await host.run("/bin/launchctl", ["bootstrap", "system", definition.destination]);
      await host.run("/bin/launchctl", ["kickstart", "-k", `system/${definition.serviceId}`]);
    }
  }
}

function createActuationJournal(transaction, previousDefinitions, preparedAt) {
  const core = Object.freeze({
    schemaVersion: "deviludo.runner-native-service-actuation-journal.v1",
    state: "PREPARED",
    transactionDigest: transaction.transactionDigest,
    platform: transaction.platform,
    architecture: transaction.architecture,
    preparedAt,
    previousDefinitions: Object.freeze(previousDefinitions.map((definition) => Object.freeze({ ...definition }))),
  });
  return deepFreeze({ ...core, journalDigest: sha256Canonical(core) });
}

function validateActuationJournal(value, transaction) {
  if (!plainRecord(value) || !exactKeys(value, [
    "architecture", "journalDigest", "platform", "preparedAt", "previousDefinitions", "schemaVersion", "state",
    "transactionDigest",
  ]) || value.schemaVersion !== "deviludo.runner-native-service-actuation-journal.v1" || value.state !== "PREPARED"
    || value.transactionDigest !== transaction.transactionDigest || value.platform !== transaction.platform
    || value.architecture !== transaction.architecture || !canonicalTimestamp(value.preparedAt)
    || !Array.isArray(value.previousDefinitions)
    || value.previousDefinitions.length !== transaction.definitions.length) invalidInput();
  const core = { ...value }; delete core.journalDigest;
  if (value.journalDigest !== sha256Canonical(core)) invalidInput();
  value.previousDefinitions.forEach((definition, index) => {
    if (!plainRecord(definition) || !exactKeys(definition, ["bodyBase64", "component", "destination", "digest"])
      || definition.component !== transaction.definitions[index].component
      || definition.destination !== transaction.definitions[index].destination || !SHA256.test(definition.digest)
      || typeof definition.bodyBase64 !== "string" || definition.bodyBase64.length > MAX_DEFINITION_BYTES * 2) invalidInput();
  });
  return value;
}

function createExecutionReceipt(transaction, grant, previousDefinitions, completedAt, failureDigest) {
  const state = failureDigest === null ? "SERVICES_STARTED" : "ROLLED_BACK";
  const core = Object.freeze({
    schemaVersion: "deviludo.runner-native-service-actuation-receipt.v1",
    state,
    operationId: grant.payload.operationId,
    transactionDigest: transaction.transactionDigest,
    planDigest: transaction.planDigest,
    stagingReceiptDigest: transaction.stagingReceiptDigest,
    releaseId: transaction.releaseId,
    platform: transaction.platform,
    architecture: transaction.architecture,
    previousDefinitionDigests: Object.freeze(previousDefinitions.map(({ component, digest }) =>
      Object.freeze({ component, digest }))),
    failureDigest,
    completedAt,
  });
  return deepFreeze({ ...core, receiptDigest: sha256Canonical(core) });
}

function validateExecutionReceipt(value, transaction, grant) {
  if (!plainRecord(value) || !exactKeys(value, [
    "architecture", "completedAt", "failureDigest", "operationId", "planDigest", "platform",
    "previousDefinitionDigests", "receiptDigest", "releaseId", "schemaVersion", "stagingReceiptDigest", "state",
    "transactionDigest",
  ]) || value.schemaVersion !== "deviludo.runner-native-service-actuation-receipt.v1"
    || !new Set(["SERVICES_STARTED", "ROLLED_BACK"]).has(value.state) || value.operationId !== grant.payload.operationId
    || value.transactionDigest !== transaction.transactionDigest || value.planDigest !== transaction.planDigest
    || value.stagingReceiptDigest !== transaction.stagingReceiptDigest || value.releaseId !== transaction.releaseId
    || value.platform !== transaction.platform || value.architecture !== transaction.architecture
    || !canonicalTimestamp(value.completedAt) || !Array.isArray(value.previousDefinitionDigests)
    || value.previousDefinitionDigests.length !== transaction.definitions.length
    || (value.state === "SERVICES_STARTED" ? value.failureDigest !== null : !SHA256.test(value.failureDigest))) invalidInput();
  value.previousDefinitionDigests.forEach((item, index) => {
    if (!plainRecord(item) || !exactKeys(item, ["component", "digest"])
      || item.component !== transaction.definitions[index].component || !SHA256.test(item.digest)) invalidInput();
  });
  const core = { ...value }; delete core.receiptDigest;
  if (value.receiptDigest !== sha256Canonical(core)) invalidInput();
  return deepFreeze({ ...value });
}

function createActuationFailure(transaction, step, failedAt) {
  const core = Object.freeze({
    schemaVersion: "deviludo.runner-native-service-actuation-failure.v1",
    transactionDigest: transaction.transactionDigest,
    code: "RUNNER_NATIVE_SERVICE_ACTIVATION_FAILED",
    step,
    failedAt,
  });
  return deepFreeze({ ...core, failureDigest: sha256Canonical(core) });
}

function validateActuationFailure(value, transaction) {
  if (!plainRecord(value) || !exactKeys(value, [
    "code", "failedAt", "failureDigest", "schemaVersion", "step", "transactionDigest",
  ]) || value.schemaVersion !== "deviludo.runner-native-service-actuation-failure.v1"
    || value.transactionDigest !== transaction.transactionDigest
    || value.code !== "RUNNER_NATIVE_SERVICE_ACTIVATION_FAILED"
    || typeof value.step !== "string" || !new Set([
      "INSTALL_DEFINITIONS", "ACTIVATE_SERVICES", "ASSERT_RUNNING", "RECOVER_INTERRUPTED_ACTUATION",
    ]).has(value.step) || !canonicalTimestamp(value.failedAt) || !SHA256.test(value.failureDigest)) invalidInput();
  const core = { ...value }; delete core.failureDigest;
  if (value.failureDigest !== sha256Canonical(core)) invalidInput();
  return deepFreeze({ ...value });
}

function executeFixed(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    const chunks = [];
    let length = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    const capture = (chunk) => {
      length += chunk.length;
      if (length > MAX_CAPTURE_BYTES) child.kill("SIGKILL");
      else chunks.push(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (length > MAX_CAPTURE_BYTES || signal !== null || !Number.isInteger(code)) {
        reject(new Error("Runner native fixed host action failed"));
      } else accept(Object.freeze({ exitCode: code, output: Buffer.concat(chunks).toString("utf8") }));
    });
  });
}

export async function runnerNativeTrustAnchorFromEnvironment(env = process.env) {
  if (typeof env.DEVILUDO_RUNNER_NATIVE_ACTUATOR_KEY_ID !== "string"
    || !SAFE_ID.test(env.DEVILUDO_RUNNER_NATIVE_ACTUATOR_KEY_ID)
    || !absoluteValue(env.DEVILUDO_RUNNER_NATIVE_ACTUATOR_PUBLIC_KEY_FILE)) invalidInput();
  const metadata = await lstat(env.DEVILUDO_RUNNER_NATIVE_ACTUATOR_PUBLIC_KEY_FILE);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 32 || metadata.size > 16 * 1024) invalidInput();
  let key;
  try { key = createPublicKey(await readFile(env.DEVILUDO_RUNNER_NATIVE_ACTUATOR_PUBLIC_KEY_FILE)); }
  catch { invalidInput(); }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") invalidInput();
  return Object.freeze({ keyId: env.DEVILUDO_RUNNER_NATIVE_ACTUATOR_KEY_ID, publicKey: key });
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
async function createOnlyJson(path, value) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) invalidInput();
  const body = `${canonicalJson(value)}\n`;
  try {
    const file = await open(path, "wx", 0o400);
    try { await file.writeFile(body, "utf8"); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readBoundedJson(path);
    if (canonicalJson(existing) !== canonicalJson(value)) invalidInput();
  }
}

function transactionDigest(value) {
  const core = { ...value }; delete core.transactionDigest;
  return sha256Canonical(core);
}
function rawDigest(value) {
  if (typeof value !== "string") invalidInput();
  if (SHA256.test(value)) return value;
  if (/^sha256:[a-f0-9]{64}$/.test(value)) return value.slice(7);
  invalidInput();
}
function targetPlatform(value) {
  if (value === "linux") return "linux";
  if (value === "darwin") return "macos";
  if (value === "win32") return "windows";
  invalidInput();
}
function targetArchitecture(value) {
  if (value === "x64") return "x86_64";
  if (value === "arm64") return "arm64";
  invalidInput();
}
function canonicalTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function exactKeys(value, expected) {
  const actual = Object.keys(value).sort(); const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
function absolute(value) { if (!absoluteValue(value)) invalidInput(); return value; }
function absoluteValue(value) {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096 && !/[\0\r\n]/.test(value);
}
function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  return value;
}
function invalidInput() { throw new Error("Runner native service actuation input is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production" || typeof process.getuid !== "function" || process.getuid() !== 0) invalidInput();
  const options = parseRunnerNativeServiceActuationArguments(process.argv.slice(2));
  const trust = await runnerNativeTrustAnchorFromEnvironment();
  const receipt = await applyRunnerNativeServiceTransaction({ ...options, ...trust });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.runner-native-service-actuation-result.v1",
    state: receipt.state,
    operationId: receipt.operationId,
    transactionDigest: receipt.transactionDigest,
    receiptDigest: receipt.receiptDigest,
  })}\n`);
  if (receipt.state !== "SERVICES_STARTED") process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[apply:runner-native-service-transaction] actuation failed\n");
    process.exitCode = 1;
  });
}
