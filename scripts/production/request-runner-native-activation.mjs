#!/usr/bin/env node

import { createPublicKey } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "../../services/runner-control/src/canonical.ts";
import {
  runnerNativeInstallRequestDigest,
  validateRunnerNativeInstallAuthorizationRequest,
  verifyRunnerNativeInstallActivationGrant,
} from "../../services/runner-control/src/native-install.ts";
import { physicalRunnerIngressClientFromEnv } from "../../services/runner-control/src/runner-ingress-client.ts";
import { validateRunnerNativeInstallPlan } from "./plan-runner-native-install.mjs";
import { validateStagingReceipt, verifyStagedRunnerNativeInstallation } from "./stage-runner-native-install.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_JSON_BYTES = 1024 * 1024;

export function parseRunnerNativeActivationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 10) invalid();
  const allowed = new Set(["--current-plan", "--operation-id", "--output", "--plan", "--plan-digest"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (!SHA256.test(values.get("--plan-digest")) || !UUID_V4.test(values.get("--operation-id"))) invalid();
  return Object.freeze({
    currentPlanPath: absolute(values.get("--current-plan")),
    operationId: values.get("--operation-id"),
    outputPath: absolute(values.get("--output")),
    planPath: absolute(values.get("--plan")),
    planDigest: values.get("--plan-digest"),
  });
}

export function createRunnerNativeActivationAuthorizationRequest(input) {
  const plan = validateRunnerNativeInstallPlan(input.plan, input.planDigest);
  const current = validateRunnerNativeInstallPlan(input.currentPlan);
  if (!plainRecord(input.stagingReceipt) || !SHA256.test(input.stagingReceipt.planFileDigest)) invalid();
  const receipt = validateStagingReceipt(input.stagingReceipt, plan, input.stagingReceipt.planFileDigest);
  if (!plan.rollback
    || plan.rollback.previousPlanDigest !== current.planDigest
    || plan.rollback.previousPlanPath !== input.currentPlanPath
    || plan.rollback.previousRunnerId !== current.machine.runnerId
    || plan.rollback.previousCapabilityDigest !== current.machine.capabilityDigest
    || current.platform !== plan.platform || current.architecture !== plan.architecture
    || input.outputPath !== plan.activation.activationGrantFile
    || !UUID_V4.test(input.operationId)) invalid();
  return validateRunnerNativeInstallAuthorizationRequest({
    schemaVersion: "deviludo.runner-native-install-authorization-request.v1",
    operationId: input.operationId,
    currentRunnerId: current.machine.runnerId,
    currentCapabilityDigest: current.machine.capabilityDigest,
    targetRunnerId: plan.machine.runnerId,
    targetSpiffeId: plan.machine.runnerSpiffeId,
    targetCapabilityDigest: plan.machine.capabilityDigest,
    platform: plan.platform,
    architecture: plan.architecture,
    planDigest: plan.planDigest,
    stagingReceiptDigest: receipt.receiptDigest,
    releaseId: plan.releaseId,
    releaseDigest: plan.releaseDigest,
  });
}

export async function requestRunnerNativeActivation(input, dependencies) {
  const request = createRunnerNativeActivationAuthorizationRequest(input);
  const result = await dependencies.ingress.authorizeNativeInstall(request);
  if (plainRecord(result) && result.schemaVersion === "deviludo.runner-native-install-drain-receipt.v1") {
    if (result.operationId !== request.operationId || result.currentRunnerId !== request.currentRunnerId
      || result.planDigest !== request.planDigest || result.state !== "DRAINING"
      || !Number.isSafeInteger(result.activeLeaseCount) || result.activeLeaseCount < 1
      || !Number.isSafeInteger(result.retryAfterSeconds) || result.retryAfterSeconds < 1) invalid();
    return Object.freeze({ request, result: Object.freeze({ ...result }), authorized: false });
  }
  const grant = verifyRunnerNativeInstallActivationGrant(result, {
    publicKey: dependencies.publicKey,
    keyId: dependencies.keyId,
    request,
    now: dependencies.now.toISOString(),
  });
  return Object.freeze({ request, result: grant, authorized: true });
}

async function main() {
  if (process.env.NODE_ENV !== "production") invalid();
  const options = parseRunnerNativeActivationArguments(process.argv.slice(2));
  const [plan, currentPlan, publicKeyBytes] = await Promise.all([
    readBoundedJson(options.planPath),
    readBoundedJson(options.currentPlanPath),
    readBoundedFile(requiredAbsoluteEnvironment("DEVILUDO_RUNNER_JOB_VERIFY_PUBLIC_KEY_FILE"), MAX_JSON_BYTES),
  ]);
  const validatedPlan = validateRunnerNativeInstallPlan(plan, options.planDigest);
  const stagingReceipt = await verifyStagedRunnerNativeInstallation(validatedPlan, validatedPlan.releaseDirectory);
  const result = await requestRunnerNativeActivation({
    plan: validatedPlan,
    planDigest: options.planDigest,
    currentPlan,
    currentPlanPath: options.currentPlanPath,
    stagingReceipt,
    operationId: options.operationId,
    outputPath: options.outputPath,
  }, {
    ingress: await physicalRunnerIngressClientFromEnv(),
    publicKey: createPublicKey(publicKeyBytes),
    keyId: requiredEnvironment("DEVILUDO_RUNNER_JOB_VERIFY_KEY_ID"),
    now: new Date(),
  });
  if (result.authorized) await createOnlyJson(options.outputPath, result.result);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.runner-native-activation-request-result.v1",
    operationId: result.request.operationId,
    requestDigest: runnerNativeInstallRequestDigest(result.request),
    state: result.authorized ? "ACTIVATION_AUTHORIZED" : "DRAINING",
    planDigest: result.request.planDigest,
    grantSequence: result.authorized ? result.result.payload.grantSequence : null,
    expiresAt: result.authorized ? result.result.payload.expiresAt : null,
    retryAfterSeconds: result.authorized ? null : result.result.retryAfterSeconds,
  })}\n`);
}

async function createOnlyJson(path, value) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  const body = `${canonicalJson(value)}\n`;
  try {
    const file = await open(path, "wx", 0o400);
    try { await file.writeFile(body, "utf8"); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readBoundedJson(path);
    if (canonicalJson(existing) !== canonicalJson(value)) invalid();
  }
}

async function readBoundedJson(path) {
  const body = await readBoundedFile(path, MAX_JSON_BYTES);
  try { return JSON.parse(body.toString("utf8")); } catch { invalid(); }
}
async function readBoundedFile(path, maximum) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximum) invalid();
  return readFile(path);
}
function requiredEnvironment(name) { const value = process.env[name]?.trim(); if (!value || /[\0\r\n]/.test(value)) invalid(); return value; }
function requiredAbsoluteEnvironment(name) { return absolute(requiredEnvironment(name)); }
function absolute(value) { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.length > 4_096) invalid(); return value; }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function invalid() { throw new Error("Runner native activation request is invalid"); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[request:runner-native-activation] request failed\n");
    process.exitCode = 1;
  });
}
