#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import {
  createWindowsScmActuationRequest,
  decodeWindowsScmActuationRequest,
  windowsScmActuationRequestDigest,
} from "../../services/runner-control/src/windows-scm-actuation-request.ts";
import {
  validateSteamDepotFinalizerHostActuationReceipt,
  verifySteamDepotFinalizerHostActivationGrant,
} from "../../services/steam-depot-finalizer/src/host-activation.ts";
import {
  parseBoundSteamDepotFinalizerEnvironment,
  validateSteamDepotFinalizerHostTransaction,
} from "./compile-steam-depot-finalizer-host-transaction.mjs";
import { validateSteamDepotFinalizerHostInstallPlan } from "./plan-steam-depot-finalizer-host-install.mjs";
import { probeSteamDepotFinalizerMtlsHealth } from "./apply-steam-depot-finalizer-host-transaction.mjs";
import {
  createOnlyCanonicalJson,
  readSecureFile,
  readSecureJson,
  requiredEnvironment,
  steamDepotFinalizerHostActivationTrustFromEnv,
} from "./steam-depot-finalizer-host-activation-client.mjs";
import { verifyStagedSteamDepotFinalizerHost } from "./stage-steam-depot-finalizer-host-install.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const MAX_CAPTURE_BYTES = 64 * 1024;

export function parseWindowsSteamDepotFinalizerHostActuationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 16) invalid();
  const allowed = new Set([
    "--activation-grant", "--actuation-request", "--actuation-request-digest", "--output",
    "--plan", "--plan-digest", "--transaction", "--transaction-digest",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  for (const name of ["--actuation-request-digest", "--plan-digest", "--transaction-digest"]) {
    if (!SHA256.test(values.get(name))) invalid();
  }
  return Object.freeze({
    activationGrantPath: windowsAbsolute(values.get("--activation-grant")),
    actuationRequestPath: windowsAbsolute(values.get("--actuation-request")),
    actuationRequestDigest: values.get("--actuation-request-digest"),
    outputPath: windowsAbsolute(values.get("--output")),
    planPath: windowsAbsolute(values.get("--plan")),
    planDigest: values.get("--plan-digest"),
    transactionPath: windowsAbsolute(values.get("--transaction")),
    transactionDigest: values.get("--transaction-digest"),
  });
}

export function verifyWindowsSteamDepotFinalizerHostActuation(input) {
  const plan = validateSteamDepotFinalizerHostInstallPlan(input.plan, input.planDigest);
  const transaction = validateSteamDepotFinalizerHostTransaction(input.transaction, input.transactionDigest);
  if (plan.platform !== "windows" || transaction.status !== "READY" || transaction.platform !== "windows"
    || transaction.planDigest !== plan.planDigest || transaction.releaseId !== plan.releaseId
    || transaction.serviceReleaseDigest !== plan.serviceReleaseDigest
    || transaction.nativeReleaseDigest !== plan.nativeReleaseDigest || transaction.architecture !== plan.architecture
    || !Buffer.isBuffer(input.actuationRequestBytes)
    || windowsScmActuationRequestDigest(input.actuationRequestBytes) !== input.actuationRequestDigest
    || canonicalJson(decodeWindowsScmActuationRequest(input.actuationRequestBytes))
      !== canonicalJson(createWindowsScmActuationRequest(transaction))
    || transaction.windowsActuator?.binaryDigest !== input.actuatorDigest
    || !SHA256.test(input.actuatorDigest) || input.outputPath !== input.grantValue?.payload?.receiptPath
    || !input.publicKey || !SAFE_ID.test(input.keyId) || !hostIdentity(input.identity)) invalid();
  const grant = verifySteamDepotFinalizerHostActivationGrant(input.grantValue, {
    publicKey: input.publicKey, keyId: input.keyId, now: input.now,
  });
  const upgrading = plan.activation.mode === "DRAINED_UPGRADE";
  const active = bindingFromActiveRequest(input.activeRequestBytes);
  const committedRecovery = active !== null && active.transactionDigest === transaction.transactionDigest
    && active.definitionDigest === grant.payload.definitionDigest;
  const previousDefinitionDigest = committedRecovery ? grant.payload.previousDefinitionDigest : active?.definitionDigest ?? null;
  if (grant.payload.hostId !== input.identity.hostId || grant.payload.hostSpiffeId !== input.identity.hostSpiffeId
    || grant.payload.hostCertificateFingerprint !== input.identity.hostCertificateFingerprint
    || grant.payload.planDigest !== plan.planDigest || grant.payload.transactionDigest !== transaction.transactionDigest
    || grant.payload.stagingReceiptDigest !== transaction.stagingReceiptDigest || grant.payload.releaseId !== plan.releaseId
    || grant.payload.serviceReleaseDigest !== plan.serviceReleaseDigest
    || grant.payload.nativeReleaseDigest !== plan.nativeReleaseDigest || grant.payload.platform !== "windows"
    || grant.payload.architecture !== plan.architecture || grant.payload.activeOperationCount !== 0
    || grant.payload.operationState !== (upgrading ? "DRAINING" : "INITIALIZING")
    || grant.payload.previousPlanDigest !== (upgrading ? plan.rollback.previousPlanDigest : null)
    || grant.payload.previousDefinitionDigest !== previousDefinitionDigest
    || (!committedRecovery && upgrading !== (previousDefinitionDigest !== null))
    || grant.payload.definitionDigest !== transaction.definition.renderedDigest) invalid();
  return deepFreeze({ plan, transaction, grant, outputPath: input.outputPath,
    recoveryState: committedRecovery ? "COMMITTED" : "PENDING" });
}

export async function executeWindowsSteamDepotFinalizerHostActuation(input, dependencies) {
  const now = dependencies.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf()) || !dependencies.host
    || typeof dependencies.host.prepare !== "function" || typeof dependencies.host.probePending !== "function"
    || typeof dependencies.host.commit !== "function" || typeof dependencies.host.rollback !== "function"
    || typeof dependencies.host.probeActive !== "function"
    || typeof dependencies.host.checkHealth !== "function") invalid();
  const grant = input.grant;
  if (input.recoveryState === "COMMITTED") {
    try { await dependencies.host.probeActive(); await dependencies.host.checkHealth(); }
    catch { throw new Error("Committed Windows Finalizer activation requires recovery"); }
    return activatedReceipt(grant, now.toISOString());
  }
  if (input.recoveryState !== undefined && input.recoveryState !== "PENDING") invalid();
  let failureDigest = null;
  let step = "PREPARE_NATIVE_ACTUATION";
  try {
    await dependencies.host.prepare();
    step = "PROBE_PENDING_ACTUATION";
    await dependencies.host.probePending();
    step = "VERIFY_MTLS_HEALTH";
    await dependencies.host.checkHealth();
    step = "COMMIT_NATIVE_ACTUATION";
    await dependencies.host.commit();
  } catch {
    await dependencies.host.rollback().catch(() => { throw new Error("Windows Finalizer rollback requires recovery"); });
    failureDigest = sha256Canonical({
      schemaVersion: "deviludo.windows-steam-depot-finalizer-host-actuation-failure.v1",
      code: "WINDOWS_STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_FAILED",
      operationId: grant.payload.operationId,
      transactionDigest: grant.payload.transactionDigest,
      step,
      failedAt: now.toISOString(),
    });
  }
  return actuationReceipt(grant, now.toISOString(), failureDigest);
}

function activatedReceipt(grant, completedAt) { return actuationReceipt(grant, completedAt, null); }
function actuationReceipt(grant, completedAt, failureDigest) {
  const core = {
    schemaVersion: "deviludo.steam-depot-finalizer-host-actuation-receipt.v1",
    state: failureDigest === null ? "ACTIVATED" : "ROLLED_BACK",
    operationId: grant.payload.operationId,
    grantSequence: grant.payload.grantSequence,
    hostId: grant.payload.hostId,
    hostSpiffeId: grant.payload.hostSpiffeId,
    hostCertificateFingerprint: grant.payload.hostCertificateFingerprint,
    transactionDigest: grant.payload.transactionDigest,
    planDigest: grant.payload.planDigest,
    stagingReceiptDigest: grant.payload.stagingReceiptDigest,
    releaseId: grant.payload.releaseId,
    platform: "windows",
    architecture: grant.payload.architecture,
    previousDefinitionDigest: grant.payload.previousDefinitionDigest,
    failureDigest,
    completedAt,
  };
  return validateSteamDepotFinalizerHostActuationReceipt({ ...core, receiptDigest: sha256Canonical(core) }, grant);
}

class NodeWindowsSteamDepotFinalizerHost {
  constructor(options) {
    if (process.platform !== "win32" || !canonicalActivePath(options.activeRequestPath)
      || win32.dirname(options.actuationRequestPath).toLowerCase() !== win32.dirname(options.activeRequestPath).toLowerCase()
      || win32.basename(options.actuationRequestPath).toLowerCase() !== "actuation-request.v1.bin"
      || !windowsAbsolute(options.actuatorPath) || !plainRecord(options.environment)) invalid();
    this.activeRequestPath = options.activeRequestPath;
    this.actuationRequestPath = options.actuationRequestPath;
    this.actuatorPath = options.actuatorPath;
    this.environment = options.environment;
  }
  async prepare() { await executeFixed(this.actuatorPath, ["--prepare"]); }
  async probePending() { await executeFixed(this.actuatorPath, ["--probe-pending"]); }
  async commit() { await executeFixed(this.actuatorPath, ["--commit"]); }
  async rollback() { await executeFixed(this.actuatorPath, ["--rollback"]); }
  async probeActive() { await executeFixed(this.actuatorPath, ["--probe"]); }
  async checkHealth() { await probeSteamDepotFinalizerMtlsHealth(this.environment); }
}

async function main() {
  if (process.env.NODE_ENV !== "production" || process.platform !== "win32") invalid();
  const options = parseWindowsSteamDepotFinalizerHostActuationArguments(process.argv.slice(2));
  const activeRequestPath = requiredEnvironment(process.env,
    "DEVILUDO_STEAM_DEPOT_FINALIZER_WINDOWS_ACTIVE_REQUEST_FILE");
  if (!canonicalActivePath(activeRequestPath)
    || options.actuationRequestPath.toLowerCase() !== win32.join(win32.dirname(activeRequestPath),
      "actuation-request.v1.bin").toLowerCase()) invalid();
  const [grantValue, trust] = await Promise.all([
    readSecureJson(options.activationGrantPath), steamDepotFinalizerHostActivationTrustFromEnv(),
  ]);
  const identity = hostIdentityFromEnvironment();
  let existing = null;
  try { existing = await readSecureJson(options.outputPath); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (existing !== null) {
    const grant = verifySteamDepotFinalizerHostActivationGrant(grantValue, {
      publicKey: trust.publicKey, keyId: trust.keyId, now: new Date(), allowExpired: true,
    });
    if (grant.payload.receiptPath !== options.outputPath || grant.payload.hostId !== identity.hostId
      || grant.payload.hostSpiffeId !== identity.hostSpiffeId
      || grant.payload.hostCertificateFingerprint !== identity.hostCertificateFingerprint) invalid();
    const receipt = validateSteamDepotFinalizerHostActuationReceipt(existing, grant);
    process.stdout.write(`${JSON.stringify(resultProjection(receipt, true))}\n`);
    return;
  }
  const [planValue, transactionValue] = await Promise.all([
    readSecureJson(options.planPath), readSecureJson(options.transactionPath),
  ]);
  const plan = validateSteamDepotFinalizerHostInstallPlan(planValue, options.planDigest);
  if (plan.architecture !== targetArchitecture(process.arch)) invalid();
  const transaction = validateSteamDepotFinalizerHostTransaction(transactionValue, options.transactionDigest);
  const [stagingReceipt, actuatorDigest, activeRequestBytes, compiledRequestBytes, environmentBytes] = await Promise.all([
    verifyStagedSteamDepotFinalizerHost(plan, plan.releaseDirectory),
    digestFile(transaction.managerTool, 512 * 1024 * 1024),
    optionalSecureFile(activeRequestPath, 256 * 1024),
    optionalSecureFile(options.actuationRequestPath, 256 * 1024),
    readSecureFile(plan.artifacts.find(({ component }) => component === "environment")?.destinationPath, 256 * 1024),
  ]);
  if (stagingReceipt.receiptDigest !== transaction.stagingReceiptDigest) invalid();
  const verified = verifyWindowsSteamDepotFinalizerHostActuation({
    ...options, plan, transaction, grantValue, actuationRequestBytes: compiledRequestBytes ?? activeRequestBytes,
    actuatorDigest, activeRequestBytes,
    publicKey: trust.publicKey, keyId: trust.keyId, identity, now: new Date(),
  });
  if (verified.recoveryState === "PENDING" && compiledRequestBytes === null) invalid();
  const environment = parseBoundSteamDepotFinalizerEnvironment(environmentBytes, plan);
  const host = new NodeWindowsSteamDepotFinalizerHost({
    activeRequestPath, actuationRequestPath: options.actuationRequestPath,
    actuatorPath: transaction.managerTool, environment,
  });
  const receipt = await executeWindowsSteamDepotFinalizerHostActuation(verified, { host, now: new Date() });
  await createOnlyCanonicalJson(options.outputPath, receipt);
  process.stdout.write(`${JSON.stringify(resultProjection(receipt, false))}\n`);
  if (receipt.state !== "ACTIVATED") process.exitCode = 2;
}

function bindingFromActiveRequest(bytes) {
  if (bytes === null || bytes === undefined) return null;
  const request = decodeWindowsScmActuationRequest(bytes);
  const service = request.services.find(({ component }) => component === "steam-depot-finalizer");
  if (!service || request.services.length !== 1) invalid();
  return Object.freeze({ transactionDigest: request.transactionDigest, definitionDigest: service.descriptorDigest });
}
async function optionalSecureFile(path, maximum) {
  try { return await readSecureFile(path, maximum); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
async function digestFile(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum) invalid();
    const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead < 1) invalid(); hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return hash.digest("hex");
  } finally { await file.close(); }
}
function executeFixed(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: {},
    });
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => child.kill(), 60_000);
    const capture = (chunk) => { bytes += chunk.length; if (bytes > MAX_CAPTURE_BYTES) child.kill(); else chunks.push(chunk); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal !== null || bytes > MAX_CAPTURE_BYTES) { reject(new Error("Windows native actuation failed")); return; }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reject(new Error("Windows native actuation failed")); return; }
      if (!plainRecord(result) || result.schemaVersion !== "deviludo.windows-scm-native-actuation-result.v1"
        || result.status !== "SUCCEEDED") { reject(new Error("Windows native actuation failed")); return; }
      accept(result);
    });
  });
}
function hostIdentityFromEnvironment() {
  const value = {
    hostId: requiredEnvironment(process.env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_ID"),
    hostSpiffeId: requiredEnvironment(process.env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_SPIFFE_ID"),
    hostCertificateFingerprint: requiredEnvironment(process.env,
      "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_CERTIFICATE_FINGERPRINT"),
  };
  if (!hostIdentity(value)) invalid();
  return Object.freeze(value);
}
function hostIdentity(value) {
  if (!plainRecord(value) || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(value.hostId)
    || typeof value.hostSpiffeId !== "string" || !SHA256.test(value.hostCertificateFingerprint)) return false;
  try { const url = new URL(value.hostSpiffeId); return url.protocol === "spiffe:" && Boolean(url.hostname)
    && url.pathname !== "/" && !url.username && !url.password && !url.port && !url.search && !url.hash
    && url.toString() === value.hostSpiffeId; } catch { return false; }
}
function canonicalActivePath(value) {
  return typeof value === "string" && win32.isAbsolute(value) && win32.normalize(value) === value
    && win32.basename(value).toLowerCase() === "active-request.v1.bin"
    && win32.basename(win32.dirname(value)).toLowerCase() === "nativeactuator" && !/[\0\r\n]/.test(value);
}
function windowsAbsolute(value) {
  if (typeof value !== "string" || !win32.isAbsolute(value) || win32.normalize(value) !== value
    || value.length > 4_096 || /[\0\r\n]/.test(value)) invalid();
  return value;
}
function targetArchitecture(value) { if (value === "x64") return "x86_64"; if (value === "arm64") return "arm64"; invalid(); }
function resultProjection(receipt, replayed) {
  return { schemaVersion: "deviludo.windows-steam-depot-finalizer-host-actuation-result.v1",
    state: receipt.state, operationId: receipt.operationId, transactionDigest: receipt.transactionDigest,
    receiptDigest: receipt.receiptDigest, replayed };
}
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
function invalid() { throw new Error("Windows Steam depot Finalizer host actuation input is invalid"); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[apply:windows-steam-depot-finalizer-host] actuation failed\n");
    process.exitCode = 1;
  });
}
