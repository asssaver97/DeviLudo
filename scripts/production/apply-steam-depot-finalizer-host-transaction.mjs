#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import {
  verifySteamDepotFinalizerHostActivationGrant,
} from "../../services/steam-depot-finalizer/src/host-activation.ts";
import {
  verifySteamDepotFinalizerNativeRuntime,
} from "../../services/steam-depot-finalizer/src/native-controller-release.ts";
import {
  verifySteamDepotFinalizerServiceRuntime,
} from "../../services/steam-depot-finalizer/src/native-service-release.ts";
import {
  createSteamDepotFinalizerHostTransaction,
  parseBoundSteamDepotFinalizerEnvironment,
  validateSteamDepotFinalizerHostTransaction,
} from "./compile-steam-depot-finalizer-host-transaction.mjs";
import { validateSteamDepotFinalizerHostInstallPlan } from "./plan-steam-depot-finalizer-host-install.mjs";
import { verifyStagedSteamDepotFinalizerHost } from "./stage-steam-depot-finalizer-host-install.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_DEFINITION_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export function parseSteamDepotFinalizerHostActuationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 12) invalid();
  const allowed = new Set([
    "--activation-grant", "--output", "--plan", "--plan-digest", "--transaction", "--transaction-digest",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (!SHA256.test(values.get("--plan-digest")) || !SHA256.test(values.get("--transaction-digest"))) invalid();
  return Object.freeze({
    activationGrantPath: requiredAbsolute(values.get("--activation-grant")),
    outputPath: requiredAbsolute(values.get("--output")),
    planPath: requiredAbsolute(values.get("--plan")),
    planDigest: values.get("--plan-digest"),
    transactionPath: requiredAbsolute(values.get("--transaction")),
    transactionDigest: values.get("--transaction-digest"),
  });
}

export async function verifySteamDepotFinalizerHostActuation(options, dependencies = {}) {
  const now = dependencies.now ?? new Date();
  if (!plainRecord(options) || !absolute(options.planPath) || !absolute(options.transactionPath)
    || !absolute(options.activationGrantPath) || !absolute(options.outputPath) || !SHA256.test(options.planDigest)
    || !SHA256.test(options.transactionDigest) || typeof options.keyId !== "string" || !SAFE_ID.test(options.keyId)
    || !options.publicKey || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(options.hostId)
    || !validSpiffeId(options.hostSpiffeId) || !SHA256.test(options.hostCertificateFingerprint)
    || !(now instanceof Date) || !Number.isFinite(now.valueOf())) invalid();
  const [planValue, transactionValue, grantValue, replayReceipt, journal, failure] = await Promise.all([
    readJson(options.planPath), readJson(options.transactionPath), readJson(options.activationGrantPath),
    readJsonIfPresent(options.outputPath), readJsonIfPresent(`${options.outputPath}.journal`),
    readJsonIfPresent(`${options.outputPath}.failure`),
  ]);
  const plan = validateSteamDepotFinalizerHostInstallPlan(planValue, options.planDigest);
  if (plan.platform === "windows") throw new Error("A separately signed Windows finalizer host actuator is required");
  const transaction = validateSteamDepotFinalizerHostTransaction(transactionValue, options.transactionDigest);
  const stagingReceipt = await verifyStagedSteamDepotFinalizerHost(plan, plan.releaseDirectory);
  const environmentBytes = await readBytes(artifact(plan, "environment").destinationPath, MAX_ENV_BYTES);
  const expected = createSteamDepotFinalizerHostTransaction({
    plan,
    planDigest: plan.planDigest,
    stagingReceipt,
    environment: environmentBytes,
    windowsBridgeAuthorization: null,
    windowsActuatorAuthorization: null,
  });
  if (canonicalJson(transaction) !== canonicalJson(expected) || transaction.status !== "READY") invalid();
  const grant = verifySteamDepotFinalizerHostActivationGrant(grantValue, {
    publicKey: options.publicKey,
    keyId: options.keyId,
    now,
    allowExpired: replayReceipt !== null || journal !== null || failure !== null,
  });
  if (grant.payload.hostId !== options.hostId || grant.payload.hostSpiffeId !== options.hostSpiffeId
    || grant.payload.hostCertificateFingerprint !== options.hostCertificateFingerprint) invalid();
  assertGrantBinding(plan, transaction, grant, options.outputPath);
  return deepFreeze({
    plan,
    transaction,
    grant,
    environment: parseBoundSteamDepotFinalizerEnvironment(environmentBytes, plan),
  });
}

export async function applySteamDepotFinalizerHostTransaction(options, dependencies = {}) {
  const authorization = await verifySteamDepotFinalizerHostActuation(options, dependencies);
  const host = dependencies.host ?? new NodePosixSteamDepotFinalizerHost();
  return executeSteamDepotFinalizerHostTransaction({ ...authorization, outputPath: options.outputPath }, {
    host,
    now: dependencies.now ?? new Date(),
    reportResult: dependencies.reportResult ?? (async () => undefined),
  });
}

export async function executeSteamDepotFinalizerHostTransaction(input, dependencies = {}) {
  const host = dependencies.host; const now = dependencies.now ?? new Date();
  const reportResult = dependencies.reportResult;
  if (!host || typeof host.readDefinition !== "function" || typeof host.writeDefinition !== "function"
    || typeof host.removeDefinition !== "function" || typeof host.digestFile !== "function"
    || typeof host.run !== "function" || typeof host.checkHealth !== "function" || typeof host.sleep !== "function"
    || typeof reportResult !== "function" || !(now instanceof Date) || !Number.isFinite(now.valueOf())
    || !absolute(input.outputPath)) invalid();
  const plan = validateSteamDepotFinalizerHostInstallPlan(input.plan, input.plan.planDigest);
  const transaction = validateSteamDepotFinalizerHostTransaction(input.transaction, input.transaction.transactionDigest);
  const grant = input.grant;
  assertGrantBinding(plan, transaction, grant, input.outputPath);
  assertHostBinding(host, transaction);
  validateDefinition(transaction);
  const journalPath = `${input.outputPath}.journal`; const failurePath = `${input.outputPath}.failure`;
  const existing = await readJsonIfPresent(input.outputPath);
  if (existing !== null) {
    const receipt = validateReceipt(existing, transaction, grant);
    await Promise.all([rm(journalPath, { force: true }), rm(failurePath, { force: true })]);
    return receipt;
  }
  const interrupted = await readJsonIfPresent(journalPath);
  if (interrupted !== null) {
    const journal = validateJournal(interrupted, transaction, grant);
    await rollback(host, transaction, journal.previousDefinition);
    let failure = await readJsonIfPresent(failurePath);
    if (failure === null) {
      failure = createFailure(transaction, "RECOVER_INTERRUPTED_ACTUATION", now.toISOString());
      await createOnlyJson(failurePath, failure);
    } else failure = validateFailure(failure, transaction);
    const receipt = createReceipt(transaction, grant, journal.previousDefinition, now.toISOString(), failure.failureDigest);
    await reportResult(receipt);
    await createOnlyJson(input.outputPath, receipt);
    await Promise.all([rm(journalPath, { force: true }), rm(failurePath, { force: true })]);
    return receipt;
  }
  if (await readJsonIfPresent(failurePath) !== null) invalid();
  await preflightLockedFiles(host, plan);
  const previousDefinition = await capturePreviousDefinition(host, transaction, grant);
  const journal = createJournal(transaction, grant, previousDefinition, now.toISOString());
  await createOnlyJson(journalPath, journal);
  let step = "INSTALL_DEFINITION"; let failure = null;
  try {
    await host.writeDefinition(transaction.definition.destination, Buffer.from(transaction.definition.rendered, "utf8"));
    step = "ACTIVATE_SERVICE";
    await activate(host, transaction);
    step = "VERIFY_HEALTH";
    for (const check of transaction.activation.healthChecks) {
      let healthy = false; const attempts = check === "MTLS_READY" ? 30 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try { await host.checkHealth(check, { plan, transaction, environment: input.environment, now }); healthy = true; break; }
        catch { if (attempt + 1 < attempts) await host.sleep(1_000); }
      }
      if (!healthy) throw new Error("Steam depot finalizer health gate failed");
    }
  } catch {
    try { await rollback(host, transaction, previousDefinition); }
    catch { throw new Error("Steam depot finalizer host rollback requires recovery"); }
    failure = createFailure(transaction, step, now.toISOString());
    await createOnlyJson(failurePath, failure);
  }
  const receipt = createReceipt(transaction, grant, previousDefinition, now.toISOString(), failure?.failureDigest ?? null);
  await reportResult(receipt);
  await createOnlyJson(input.outputPath, receipt);
  await Promise.all([rm(journalPath, { force: true }), rm(failurePath, { force: true })]);
  return receipt;
}

export class NodePosixSteamDepotFinalizerHost {
  constructor(runtime = process) {
    this.platform = targetPlatform(runtime.platform); this.architecture = targetArchitecture(runtime.arch);
    if (this.platform === "windows") throw new Error("A separately signed Windows finalizer host actuator is required");
  }
  async readDefinition(path) {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_DEFINITION_BYTES) invalid();
      return readFile(path);
    } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }
  async writeDefinition(path, body) {
    if (!Buffer.isBuffer(body) || body.byteLength < 1 || body.byteLength > MAX_DEFINITION_BYTES) invalid();
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
    const temporary = `${path}.deviludo-actuator-${process.pid}.tmp`; let created = false;
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
      created = true;
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      await chmod(temporary, 0o444); await rename(temporary, path); created = false;
    } finally { if (created) await rm(temporary, { force: true }); }
  }
  async removeDefinition(path) {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) invalid();
      await unlink(path);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  async digestFile(path, maximum = MAX_ARTIFACT_BYTES) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size < 1 || before.size > maximum) invalid();
      const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0;
      while (position < before.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (bytesRead < 1) invalid(); hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      const after = await file.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
      return hash.digest("hex");
    } finally { await file.close(); }
  }
  async run(command, args, { allowFailure = false } = {}) {
    if (!absolute(command) || !Array.isArray(args) || args.some((value) => typeof value !== "string"
      || !value || value.length > 4_096 || /[\0\r\n]/.test(value))) invalid();
    const result = await executeFixed(command, args);
    if (!allowFailure && result.exitCode !== 0) throw new Error("Steam depot finalizer fixed host action failed");
    return result;
  }
  async checkHealth(check, context) {
    if (check === "SIGNED_RELEASES") {
      await Promise.all([
        verifySteamDepotFinalizerServiceRuntime(context.environment, {
          executedPath: artifact(context.plan, "serviceArtifact").destinationPath, now: context.now,
        }),
        verifySteamDepotFinalizerNativeRuntime(context.environment, { now: context.now }),
      ]);
      return;
    }
    if (check === "NATIVE_IDENTITY") {
      const result = await this.run(artifact(context.plan, "nativeArtifact").destinationPath, ["--identity"]);
      let identity; try { identity = JSON.parse(result.output); } catch { invalid(); }
      if (sha256Canonical(identity) !== context.plan.nativeIdentityDigest) invalid();
      return;
    }
    if (check === "NATIVE_PROBE") {
      const result = await this.run(artifact(context.plan, "nativeArtifact").destinationPath,
        ["probe", "--policy-file", artifact(context.plan, "nativePolicy").destinationPath, "--json"]);
      let probe; try { probe = JSON.parse(result.output); } catch { invalid(); }
      const scheme = context.plan.platform === "linux" ? "LINUX_SIGSTORE"
        : context.plan.platform === "macos" ? "MACOS_DEVELOPER_ID" : "WINDOWS_AUTHENTICODE";
      if (!plainRecord(probe) || probe.schemaVersion !== "deviludo.native-steam-depot-finalizer-probe.v1"
        || probe.status !== "READY" || probe.policyDigest !== artifact(context.plan, "nativePolicy").digest
        || JSON.stringify(probe.supportedSchemes) !== JSON.stringify([scheme])) invalid();
      return;
    }
    if (check === "MTLS_READY") { await probeMtlsHealth(context.environment); return; }
    invalid();
  }
  async sleep(milliseconds) { await new Promise((accept) => setTimeout(accept, milliseconds)); }
}

function assertGrantBinding(plan, transaction, grant, outputPath) {
  const payload = grant?.payload;
  const upgrading = plan.activation.mode === "DRAINED_UPGRADE";
  if (!plainRecord(payload) || transaction.planDigest !== plan.planDigest || transaction.releaseId !== plan.releaseId
    || transaction.platform !== plan.platform || transaction.architecture !== plan.architecture
    || transaction.serviceReleaseDigest !== plan.serviceReleaseDigest
    || transaction.nativeReleaseDigest !== plan.nativeReleaseDigest
    || transaction.nativeIdentityDigest !== plan.nativeIdentityDigest || transaction.status !== "READY"
    || payload.planDigest !== plan.planDigest || payload.transactionDigest !== transaction.transactionDigest
    || payload.stagingReceiptDigest !== transaction.stagingReceiptDigest || payload.releaseId !== plan.releaseId
    || payload.serviceReleaseDigest !== plan.serviceReleaseDigest || payload.nativeReleaseDigest !== plan.nativeReleaseDigest
    || payload.platform !== plan.platform || payload.architecture !== plan.architecture
    || payload.definitionDigest !== transaction.definition.renderedDigest || payload.receiptPath !== outputPath
    || payload.activeOperationCount !== 0 || payload.operationState !== (upgrading ? "DRAINING" : "INITIALIZING")
    || payload.previousPlanDigest !== (upgrading ? plan.rollback.previousPlanDigest : null)
    || upgrading !== (payload.previousDefinitionDigest !== null)) invalid();
}

function assertHostBinding(host, transaction) {
  if (!new Set(["linux", "macos"]).has(host.platform) || !new Set(["x86_64", "arm64"]).has(host.architecture)
    || host.platform !== transaction.platform || host.architecture !== transaction.architecture) invalid();
}
function validateDefinition(transaction) {
  const definition = transaction.definition;
  const expectedManager = transaction.platform === "linux" ? "SYSTEMD" : "LAUNCHD";
  const expectedTool = transaction.platform === "linux" ? "/usr/bin/systemctl" : "/bin/launchctl";
  if (!plainRecord(definition) || transaction.manager !== expectedManager || transaction.managerTool !== expectedTool
    || typeof definition.rendered !== "string" || Buffer.byteLength(definition.rendered) < 1
    || Buffer.byteLength(definition.rendered) > MAX_DEFINITION_BYTES
    || createHash("sha256").update(definition.rendered).digest("hex") !== definition.renderedDigest) invalid();
}
async function preflightLockedFiles(host, plan) {
  for (const entry of plan.artifacts) {
    if (await host.digestFile(entry.destinationPath, entry.component === "environment" ? MAX_ENV_BYTES : MAX_ARTIFACT_BYTES)
      !== entry.digest) invalid();
  }
  if (await host.digestFile(plan.nodeRuntime.path, MAX_ARTIFACT_BYTES) !== plan.nodeRuntime.digest) invalid();
}
async function capturePreviousDefinition(host, transaction, grant) {
  const body = await host.readDefinition(transaction.definition.destination);
  if (body === null) {
    if (grant.payload.previousDefinitionDigest !== null) invalid();
    return null;
  }
  if (!Buffer.isBuffer(body) || body.byteLength < 1 || body.byteLength > MAX_DEFINITION_BYTES) invalid();
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== grant.payload.previousDefinitionDigest) invalid();
  return Object.freeze({
    destination: transaction.definition.destination,
    bodyBase64: body.toString("base64"),
    digest,
  });
}
async function activate(host, transaction) {
  if (transaction.platform === "linux") {
    await host.run("/usr/bin/systemctl", ["daemon-reload"]);
    await host.run("/usr/bin/systemctl", ["enable", transaction.definition.serviceId]);
    await host.run("/usr/bin/systemctl", ["restart", transaction.definition.serviceId]);
    return;
  }
  await host.run("/bin/launchctl", ["bootout", `system/${transaction.definition.serviceId}`], { allowFailure: true });
  await host.run("/bin/launchctl", ["bootstrap", "system", transaction.definition.destination]);
  await host.run("/bin/launchctl", ["kickstart", "-k", `system/${transaction.definition.serviceId}`]);
}
async function rollback(host, transaction, previous) {
  if (transaction.platform === "linux") {
    await host.run("/usr/bin/systemctl", ["stop", transaction.definition.serviceId], { allowFailure: true });
  } else await host.run("/bin/launchctl", ["bootout", `system/${transaction.definition.serviceId}`], { allowFailure: true });
  if (previous === null) await host.removeDefinition(transaction.definition.destination);
  else {
    const body = Buffer.from(previous.bodyBase64, "base64");
    if (body.byteLength < 1 || body.byteLength > MAX_DEFINITION_BYTES
      || createHash("sha256").update(body).digest("hex") !== previous.digest) invalid();
    await host.writeDefinition(previous.destination, body);
  }
  if (transaction.platform === "linux") {
    await host.run("/usr/bin/systemctl", ["daemon-reload"]);
    if (previous !== null) await host.run("/usr/bin/systemctl", ["restart", transaction.definition.serviceId]);
  } else if (previous !== null) {
    await host.run("/bin/launchctl", ["bootstrap", "system", transaction.definition.destination]);
    await host.run("/bin/launchctl", ["kickstart", "-k", `system/${transaction.definition.serviceId}`]);
  }
}

function createJournal(transaction, grant, previousDefinition, preparedAt) {
  const core = {
    schemaVersion: "deviludo.steam-depot-finalizer-host-actuation-journal.v1",
    state: "PREPARED",
    operationId: grant.payload.operationId,
    transactionDigest: transaction.transactionDigest,
    previousDefinition,
    preparedAt,
  };
  return deepFreeze({ ...core, journalDigest: sha256Canonical(core) });
}
function validateJournal(value, transaction, grant) {
  if (!plainRecord(value) || !exactKeys(value, [
    "journalDigest", "operationId", "preparedAt", "previousDefinition", "schemaVersion", "state", "transactionDigest",
  ]) || value.schemaVersion !== "deviludo.steam-depot-finalizer-host-actuation-journal.v1" || value.state !== "PREPARED"
    || value.operationId !== grant.payload.operationId || value.transactionDigest !== transaction.transactionDigest
    || !canonicalTimestamp(value.preparedAt) || value.journalDigest !== sha256Canonical(without(value, "journalDigest"))) invalid();
  validatePreviousDefinition(value.previousDefinition, transaction, grant);
  return value;
}
function createFailure(transaction, step, failedAt) {
  const core = {
    schemaVersion: "deviludo.steam-depot-finalizer-host-actuation-failure.v1",
    code: "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_FAILED",
    transactionDigest: transaction.transactionDigest,
    step,
    failedAt,
  };
  return deepFreeze({ ...core, failureDigest: sha256Canonical(core) });
}
function validateFailure(value, transaction) {
  if (!plainRecord(value) || !exactKeys(value, [
    "code", "failedAt", "failureDigest", "schemaVersion", "step", "transactionDigest",
  ]) || value.schemaVersion !== "deviludo.steam-depot-finalizer-host-actuation-failure.v1"
    || value.code !== "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_FAILED"
    || value.transactionDigest !== transaction.transactionDigest || !new Set([
      "INSTALL_DEFINITION", "ACTIVATE_SERVICE", "VERIFY_HEALTH", "RECOVER_INTERRUPTED_ACTUATION",
    ]).has(value.step) || !canonicalTimestamp(value.failedAt)
    || value.failureDigest !== sha256Canonical(without(value, "failureDigest"))) invalid();
  return value;
}
function createReceipt(transaction, grant, previousDefinition, completedAt, failureDigest) {
  const core = {
    schemaVersion: "deviludo.steam-depot-finalizer-host-actuation-receipt.v1",
    state: failureDigest === null ? "ACTIVATED" : "ROLLED_BACK",
    operationId: grant.payload.operationId,
    grantSequence: grant.payload.grantSequence,
    hostId: grant.payload.hostId,
    hostSpiffeId: grant.payload.hostSpiffeId,
    hostCertificateFingerprint: grant.payload.hostCertificateFingerprint,
    transactionDigest: transaction.transactionDigest,
    planDigest: transaction.planDigest,
    stagingReceiptDigest: transaction.stagingReceiptDigest,
    releaseId: transaction.releaseId,
    platform: transaction.platform,
    architecture: transaction.architecture,
    previousDefinitionDigest: previousDefinition?.digest ?? null,
    failureDigest,
    completedAt,
  };
  return deepFreeze({ ...core, receiptDigest: sha256Canonical(core) });
}
function validateReceipt(value, transaction, grant) {
  if (!plainRecord(value) || !exactKeys(value, [
    "architecture", "completedAt", "failureDigest", "grantSequence", "hostCertificateFingerprint", "hostId",
    "hostSpiffeId", "operationId", "planDigest", "platform", "previousDefinitionDigest", "receiptDigest",
    "releaseId", "schemaVersion", "stagingReceiptDigest", "state", "transactionDigest",
  ]) || value.schemaVersion !== "deviludo.steam-depot-finalizer-host-actuation-receipt.v1"
    || value.state !== "ACTIVATED" && value.state !== "ROLLED_BACK" || value.operationId !== grant.payload.operationId
    || value.grantSequence !== grant.payload.grantSequence || value.transactionDigest !== transaction.transactionDigest
    || value.hostId !== grant.payload.hostId || value.hostSpiffeId !== grant.payload.hostSpiffeId
    || value.hostCertificateFingerprint !== grant.payload.hostCertificateFingerprint
    || value.planDigest !== transaction.planDigest || value.stagingReceiptDigest !== transaction.stagingReceiptDigest
    || value.releaseId !== transaction.releaseId || value.platform !== transaction.platform
    || value.architecture !== transaction.architecture || !nullableDigest(value.previousDefinitionDigest)
    || value.previousDefinitionDigest !== grant.payload.previousDefinitionDigest || !canonicalTimestamp(value.completedAt)
    || value.state === "ACTIVATED" && value.failureDigest !== null
    || value.state === "ROLLED_BACK" && !SHA256.test(value.failureDigest)
    || value.receiptDigest !== sha256Canonical(without(value, "receiptDigest"))) invalid();
  return deepFreeze({ ...value });
}
function validatePreviousDefinition(value, transaction, grant) {
  if (value === null) { if (grant.payload.previousDefinitionDigest !== null) invalid(); return; }
  if (!plainRecord(value) || !exactKeys(value, ["bodyBase64", "destination", "digest"])
    || value.destination !== transaction.definition.destination || value.digest !== grant.payload.previousDefinitionDigest
    || !SHA256.test(value.digest) || typeof value.bodyBase64 !== "string"
    || value.bodyBase64.length > MAX_DEFINITION_BYTES * 2) invalid();
  const body = Buffer.from(value.bodyBase64, "base64");
  if (body.byteLength < 1 || body.byteLength > MAX_DEFINITION_BYTES
    || body.toString("base64") !== value.bodyBase64 || createHash("sha256").update(body).digest("hex") !== value.digest) invalid();
}

async function probeMtlsHealth(environment) {
  const key = await readBytes(requiredAbsoluteEnvironment(environment,
    "DEVILUDO_STEAM_DEPOT_FINALIZER_HEALTH_TLS_KEY_FILE"), MAX_JSON_BYTES);
  const cert = await readBytes(requiredAbsoluteEnvironment(environment,
    "DEVILUDO_STEAM_DEPOT_FINALIZER_HEALTH_TLS_CERT_FILE"), MAX_JSON_BYTES);
  const ca = await readBytes(requiredAbsoluteEnvironment(environment,
    "DEVILUDO_STEAM_DEPOT_FINALIZER_HEALTH_TLS_CA_FILE"), MAX_JSON_BYTES);
  const servername = requiredEnvironment(environment, "DEVILUDO_STEAM_DEPOT_FINALIZER_HEALTH_SERVER_NAME");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(servername)) invalid();
  const port = boundedInteger(environment.DEVILUDO_STEAM_DEPOT_FINALIZER_PORT ?? "4855", 1_024, 65_535);
  const body = Buffer.from("{}");
  const response = await new Promise((accept, reject) => {
    const request = httpsRequest({
      hostname: "127.0.0.1", servername, port, path: "/healthz", method: "POST", key, cert, ca,
      rejectUnauthorized: true, minVersion: "TLSv1.3", timeout: 5_000,
      headers: { "content-type": "application/json", "content-length": String(body.byteLength) },
    }, (result) => {
      const chunks = []; let length = 0;
      result.on("data", (chunk) => { length += chunk.length; if (length > MAX_CAPTURE_BYTES) result.destroy(); else chunks.push(chunk); });
      result.once("end", () => accept({ statusCode: result.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      result.once("error", reject);
    });
    request.once("timeout", () => request.destroy(new Error("Steam depot finalizer mTLS probe timed out")));
    request.once("error", reject); request.end(body);
  });
  let value; try { value = JSON.parse(response.body); } catch { invalid(); }
  if (response.statusCode !== 200 || !plainRecord(value)
    || value.schemaVersion !== "deviludo.steam-depot-finalizer-health.v1"
    || value.status !== "ok" || value.service !== "deviludo-steam-depot-finalizer") invalid();
}

function executeFixed(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      shell: false, stdio: ["ignore", "pipe", "pipe"],
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    const chunks = []; let length = 0; const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    const capture = (chunk) => { length += chunk.length; if (length > MAX_CAPTURE_BYTES) child.kill("SIGKILL"); else chunks.push(chunk); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (length > MAX_CAPTURE_BYTES || signal !== null || !Number.isInteger(code)) reject(new Error("Fixed host action failed"));
      else accept(Object.freeze({ exitCode: code, output: Buffer.concat(chunks).toString("utf8") }));
    });
  });
}
async function trustAnchorFromEnvironment(env = process.env) {
  const keyId = requiredEnvironment(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_KEY_ID");
  if (!SAFE_ID.test(keyId)) invalid();
  const path = requiredAbsoluteEnvironment(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_PUBLIC_KEY_FILE");
  const bytes = await readBytes(path, 16 * 1024); let publicKey;
  try { publicKey = createPublicKey(bytes); } catch { invalid(); }
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") invalid();
  const hostId = requiredEnvironment(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_ID");
  const hostSpiffeId = requiredEnvironment(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_SPIFFE_ID");
  const hostCertificateFingerprint = requiredEnvironment(
    env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_CERTIFICATE_FINGERPRINT",
  );
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(hostId) || !validSpiffeId(hostSpiffeId)
    || !SHA256.test(hostCertificateFingerprint)) invalid();
  return Object.freeze({ keyId, publicKey, hostId, hostSpiffeId, hostCertificateFingerprint });
}
async function readBytes(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat(); if (!before.isFile() || before.size < 2 || before.size > maximum) invalid();
    const body = await file.readFile(); const after = await file.stat();
    if (body.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return body;
  } finally { await file.close(); }
}
async function readJson(path) {
  const body = await readBytes(path, MAX_JSON_BYTES);
  try { return JSON.parse(body.toString("utf8")); } catch { invalid(); }
}
async function readJsonIfPresent(path) { try { return await readJson(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function createOnlyJson(path, value) {
  const parent = await lstat(dirname(path)); if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  const body = `${canonicalJson(value)}\n`;
  try {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
    try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (canonicalJson(await readJson(path)) !== canonicalJson(value)) invalid();
  }
}
function artifact(plan, component) { const value = plan.artifacts.find((entry) => entry.component === component); if (!value) invalid(); return value; }
function targetPlatform(value) { if (value === "linux") return "linux"; if (value === "darwin") return "macos"; if (value === "win32") return "windows"; invalid(); }
function targetArchitecture(value) { if (value === "x64") return "x86_64"; if (value === "arm64") return "arm64"; invalid(); }
function boundedInteger(value, minimum, maximum) { const parsed = Number.parseInt(value, 10); if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) invalid(); return parsed; }
function requiredEnvironment(env, name) { const value = env[name]?.trim(); if (!value || /[\0\r\n]/.test(value)) invalid(); return value; }
function requiredAbsoluteEnvironment(env, name) { const value = requiredEnvironment(env, name); if (!absolute(value)) invalid(); return value; }
function without(value, key) { const result = { ...value }; delete result[key]; return result; }
function nullableDigest(value) { return value === null || typeof value === "string" && SHA256.test(value); }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function validSpiffeId(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 512 || /[?#\0\s]/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === "spiffe:" && Boolean(url.hostname) && url.pathname !== "/"
    && !url.username && !url.password && !url.port; } catch { return false; }
}
function exactKeys(value, expected) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }
function absolute(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096 && !/[\0\r\n]/.test(value); }
function requiredAbsolute(value) { if (!absolute(value)) invalid(); return value; }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
function invalid() { throw new Error("Steam depot finalizer host actuation input is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production" || typeof process.getuid !== "function" || process.getuid() !== 0) invalid();
  const options = parseSteamDepotFinalizerHostActuationArguments(process.argv.slice(2));
  const trust = await trustAnchorFromEnvironment();
  const receipt = await applySteamDepotFinalizerHostTransaction({ ...options, ...trust });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.steam-depot-finalizer-host-actuation-result.v1",
    state: receipt.state,
    operationId: receipt.operationId,
    transactionDigest: receipt.transactionDigest,
    receiptDigest: receipt.receiptDigest,
  })}\n`);
  if (receipt.state !== "ACTIVATED") process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[apply:steam-depot-finalizer-host] actuation failed\n"); process.exitCode = 1; });
}
