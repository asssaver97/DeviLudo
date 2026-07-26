#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../services/runner-control/src/canonical.ts";
import { decodeWindowsScmActuationRequest } from "../../services/runner-control/src/windows-scm-actuation-request.ts";
import {
  validateSteamDepotFinalizerHostActivationRequest,
  validateSteamDepotFinalizerHostDrainReceipt,
  verifySteamDepotFinalizerHostActivationGrant,
} from "../../services/steam-depot-finalizer/src/host-activation.ts";
import { validateSteamDepotFinalizerHostTransaction } from "./compile-steam-depot-finalizer-host-transaction.mjs";
import { validateSteamDepotFinalizerHostInstallPlan } from "./plan-steam-depot-finalizer-host-install.mjs";
import {
  absolute,
  createOnlyCanonicalJson,
  readSecureFile,
  readSecureJson,
  requiredEnvironment,
  steamDepotFinalizerHostActivationClientFromEnv,
} from "./steam-depot-finalizer-host-activation-client.mjs";
import {
  validateSteamDepotFinalizerHostStagingReceipt,
  verifyStagedSteamDepotFinalizerHost,
} from "./stage-steam-depot-finalizer-host-install.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function parseSteamDepotFinalizerHostActivationRequestArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 14) invalid();
  const allowed = new Set([
    "--grant-output", "--operation-id", "--plan", "--plan-digest", "--receipt-output", "--transaction",
    "--transaction-digest",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (!UUID_V4.test(values.get("--operation-id")) || !SHA256.test(values.get("--plan-digest"))
    || !SHA256.test(values.get("--transaction-digest"))) invalid();
  return Object.freeze({
    grantOutputPath: requiredAbsolute(values.get("--grant-output")),
    operationId: values.get("--operation-id"),
    planPath: requiredAbsolute(values.get("--plan")),
    planDigest: values.get("--plan-digest"),
    receiptOutputPath: requiredAbsolute(values.get("--receipt-output")),
    transactionPath: requiredAbsolute(values.get("--transaction")),
    transactionDigest: values.get("--transaction-digest"),
  });
}

export function createSteamDepotFinalizerHostActivationRequest(input) {
  const plan = validateSteamDepotFinalizerHostInstallPlan(input.plan, input.planDigest);
  const transaction = validateSteamDepotFinalizerHostTransaction(input.transaction, input.transactionDigest);
  const planFileDigest = createHash("sha256").update(`${canonicalJson(plan)}\n`).digest("hex");
  const stagingReceipt = validateSteamDepotFinalizerHostStagingReceipt(input.stagingReceipt, plan, planFileDigest);
  const upgrading = plan.activation.mode === "DRAINED_UPGRADE";
  if (!UUID_V4.test(input.operationId) || !absoluteForPlatform(input.receiptOutputPath, plan.platform)
    || !hostIdentity(input.identity, plan.platform) || transaction.status !== "READY"
    || transaction.planDigest !== plan.planDigest || transaction.stagingReceiptDigest !== stagingReceipt.receiptDigest
    || transaction.releaseId !== plan.releaseId || transaction.serviceReleaseDigest !== plan.serviceReleaseDigest
    || transaction.nativeReleaseDigest !== plan.nativeReleaseDigest || transaction.platform !== plan.platform
    || transaction.architecture !== plan.architecture || transaction.manager !== plan.service.manager
    || !plainRecord(transaction.definition) || !SHA256.test(transaction.definition.renderedDigest)
    || upgrading !== (input.previousDefinitionDigest !== null)
    || input.previousDefinitionDigest !== null && !SHA256.test(input.previousDefinitionDigest)) invalid();
  return validateSteamDepotFinalizerHostActivationRequest({
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-request.v1",
    operationId: input.operationId,
    hostId: input.identity.hostId,
    hostSpiffeId: input.identity.hostSpiffeId,
    hostCertificateFingerprint: input.identity.hostCertificateFingerprint,
    planDigest: plan.planDigest,
    transactionDigest: transaction.transactionDigest,
    stagingReceiptDigest: stagingReceipt.receiptDigest,
    releaseId: plan.releaseId,
    serviceReleaseDigest: plan.serviceReleaseDigest,
    nativeReleaseDigest: plan.nativeReleaseDigest,
    platform: plan.platform,
    architecture: plan.architecture,
    operationState: upgrading ? "DRAINING" : "INITIALIZING",
    previousPlanDigest: upgrading ? plan.rollback.previousPlanDigest : null,
    previousDefinitionDigest: input.previousDefinitionDigest,
    definitionDigest: transaction.definition.renderedDigest,
    receiptPath: input.receiptOutputPath,
  });
}

export async function requestSteamDepotFinalizerHostActivation(input, dependencies) {
  const request = createSteamDepotFinalizerHostActivationRequest(input);
  const now = dependencies.now ?? new Date();
  const result = await dependencies.client.authorize(request, now);
  if (result.schemaVersion === "deviludo.steam-depot-finalizer-host-drain-receipt.v1") {
    return Object.freeze({ request, result: validateSteamDepotFinalizerHostDrainReceipt(result, request), authorized: false });
  }
  const grant = verifySteamDepotFinalizerHostActivationGrant(result, {
    publicKey: dependencies.publicKey,
    keyId: dependencies.keyId,
    request,
    now,
  });
  return Object.freeze({ request, result: grant, authorized: true });
}

export async function previousSteamDepotFinalizerDefinitionDigest(plan, transaction, env = process.env) {
  const upgrading = plan.activation.mode === "DRAINED_UPGRADE";
  let digest = null;
  if (plan.platform === "windows") {
    const path = requiredEnvironment(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_WINDOWS_ACTIVE_REQUEST_FILE");
    if (!canonicalWindowsActiveRequestPath(path)) invalid();
    try {
      const request = decodeWindowsScmActuationRequest(await readSecureFile(path, 256 * 1024));
      const service = request.services.find(({ component }) => component === "steam-depot-finalizer");
      if (!service || request.services.length !== 1) invalid();
      digest = service.descriptorDigest;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } else {
    const path = transaction.definition.destination;
    if (!absolute(path)) invalid();
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 1024 * 1024) invalid();
      digest = createHash("sha256").update(await readSecureFile(path, 1024 * 1024)).digest("hex");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (upgrading !== (digest !== null)) invalid();
  return digest;
}

async function main() {
  if (process.env.NODE_ENV !== "production") invalid();
  const options = parseSteamDepotFinalizerHostActivationRequestArguments(process.argv.slice(2));
  const [planValue, transactionValue] = await Promise.all([
    readSecureJson(options.planPath), readSecureJson(options.transactionPath),
  ]);
  const plan = validateSteamDepotFinalizerHostInstallPlan(planValue, options.planDigest);
  const transaction = validateSteamDepotFinalizerHostTransaction(transactionValue, options.transactionDigest);
  if (plan.platform !== targetPlatform(process.platform) || plan.architecture !== targetArchitecture(process.arch)) invalid();
  const stagingReceipt = await verifyStagedSteamDepotFinalizerHost(plan, plan.releaseDirectory);
  const previousDefinitionDigest = await previousSteamDepotFinalizerDefinitionDigest(plan, transaction);
  const identity = hostIdentityFromEnvironment(process.env);
  const client = await steamDepotFinalizerHostActivationClientFromEnv();
  const result = await client.authorize(createSteamDepotFinalizerHostActivationRequest({
    ...options, plan, transaction, stagingReceipt, previousDefinitionDigest, identity,
  }), new Date());
  if (result.schemaVersion !== "deviludo.steam-depot-finalizer-host-drain-receipt.v1") {
    await createOnlyCanonicalJson(options.grantOutputPath, result);
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-request-result.v1",
    operationId: options.operationId,
    state: result.schemaVersion === "deviludo.steam-depot-finalizer-host-drain-receipt.v1"
      ? "DRAINING" : "ACTIVATION_AUTHORIZED",
    planDigest: plan.planDigest,
    grantSequence: "payload" in result ? result.payload.grantSequence : null,
    expiresAt: "payload" in result ? result.payload.expiresAt : null,
    retryAfterSeconds: "retryAfterSeconds" in result ? result.retryAfterSeconds : null,
  })}\n`);
}

function hostIdentityFromEnvironment(env) {
  const identity = {
    hostId: requiredEnvironment(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_ID"),
    hostSpiffeId: requiredEnvironment(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_SPIFFE_ID"),
    hostCertificateFingerprint: requiredEnvironment(env,
      "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_CERTIFICATE_FINGERPRINT"),
  };
  if (!hostIdentity(identity)) invalid();
  return Object.freeze(identity);
}
function hostIdentity(value) {
  if (!plainRecord(value) || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(value.hostId)
    || !validSpiffeId(value.hostSpiffeId) || !SHA256.test(value.hostCertificateFingerprint)) return false;
  return true;
}
function validSpiffeId(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 512 || /[?#\0\s]/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === "spiffe:" && Boolean(url.hostname)
    && url.pathname !== "/" && !url.username && !url.password && !url.port; } catch { return false; }
}
function canonicalWindowsActiveRequestPath(value) {
  return typeof value === "string" && win32.isAbsolute(value) && win32.normalize(value) === value
    && win32.basename(value).toLowerCase() === "active-request.v1.bin"
    && win32.basename(win32.dirname(value)).toLowerCase() === "nativeactuator"
    && !/[\0\r\n]/.test(value);
}
function targetPlatform(value) { if (value === "win32") return "windows"; if (value === "linux") return "linux"; if (value === "darwin") return "macos"; invalid(); }
function targetArchitecture(value) { if (value === "x64") return "x86_64"; if (value === "arm64") return "arm64"; invalid(); }
function absoluteForPlatform(value, platform) { return platform === "windows" ? win32.isAbsolute(value) : absolute(value); }
function requiredAbsolute(value) { if (!absolute(value)) invalid(); return value; }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function invalid() { throw new Error("Steam depot Finalizer host activation request input is invalid"); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[request:steam-depot-finalizer-host-activation] request failed\n");
    process.exitCode = 1;
  });
}
