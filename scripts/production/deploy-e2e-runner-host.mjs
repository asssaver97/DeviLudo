#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { physicalRunnerIngressClientFromEnv } from "../../services/runner-control/src/runner-ingress-client.ts";
import { applyInitialRunnerNativeServiceTransaction } from "./apply-initial-runner-native-service-transaction.mjs";
import {
  applyRunnerNativeServiceTransaction,
  runnerNativeTrustAnchorFromEnvironment,
} from "./apply-runner-native-service-transaction.mjs";
import { compileRunnerNativeServiceTransaction } from "./compile-runner-native-service-transaction.mjs";
import { compileWindowsScmActuationRequest } from "./compile-windows-scm-actuation-request.mjs";
import {
  parseEnvironmentLock,
  planRunnerNativeInstallation,
  validateRunnerNativeInstallPlan,
} from "./plan-runner-native-install.mjs";
import { stageRunnerNativeInstallation } from "./stage-runner-native-install.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA256 = /^[a-f0-9]{64}$/;
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_JSON_BYTES = 1024 * 1024;
const CONFIG_KEYS = Object.freeze([
  "artifactDirectory", "buildReceiptPath", "connectorEnvFile", "installRoot", "machineConfigPath",
  "operationId", "planPath", "previousPlanPath", "receiptPath", "releasePath", "runnerEnvFile",
  "schemaVersion", "transactionPath", "trustPolicyDigest", "trustPolicyPath", "windows",
]);

export function parseE2EHostDeploymentArguments(argv) {
  if (!Array.isArray(argv) || !new Set([4, 5]).has(argv.length)) invalid();
  const applyIndex = argv.indexOf("--apply");
  const filtered = applyIndex < 0 ? argv : argv.filter((_, index) => index !== applyIndex);
  if (filtered.length !== 4 || filtered[0] !== "--config" || filtered[2] !== "--config-digest"
    || !SHA256.test(filtered[3])) invalid();
  return Object.freeze({ apply: applyIndex >= 0, configPath: absolute(filtered[1]), configDigest: filtered[3] });
}

export function validateE2EHostDeploymentConfig(value) {
  if (!record(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...CONFIG_KEYS].sort())
    || value.schemaVersion !== "deviludo.e2e-host-deployment.v1") invalid();
  for (const name of ["artifactDirectory", "buildReceiptPath", "installRoot", "machineConfigPath", "planPath",
    "receiptPath", "releasePath", "runnerEnvFile", "transactionPath", "trustPolicyPath"]) absolute(value[name]);
  for (const name of ["connectorEnvFile", "previousPlanPath"]) if (value[name] !== null) absolute(value[name]);
  if (!PREFIXED_SHA256.test(value.trustPolicyDigest)
    || (value.previousPlanPath === null ? value.operationId !== null : !UUID.test(value.operationId))) invalid();
  if (value.windows !== null) {
    const keys = ["actuationRequestPath", "actuatorManifestPath", "actuatorPath", "actuatorTrustPolicyDigest",
      "actuatorTrustPolicyPath", "bridgeManifestPath", "bridgePath", "bridgeTrustPolicyDigest", "bridgeTrustPolicyPath"];
    if (!record(value.windows) || JSON.stringify(Object.keys(value.windows).sort()) !== JSON.stringify(keys.sort())) invalid();
    for (const name of keys.filter((name) => !name.endsWith("Digest"))) absolute(value.windows[name]);
    if (!SHA256.test(value.windows.actuatorTrustPolicyDigest) || !SHA256.test(value.windows.bridgeTrustPolicyDigest)) invalid();
  }
  return Object.freeze(structuredClone(value));
}

export async function deployE2ERunnerHost(options, dependencies = {}) {
  const bytes = await boundedFile(options.configPath);
  if (sha256(bytes) !== options.configDigest) throw new Error("E2E deployment configuration digest does not match");
  let parsed; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
  const config = validateE2EHostDeploymentConfig(parsed);
  const planRunner = dependencies.planRunner ?? planRunnerNativeInstallation;
  const stageRunner = dependencies.stageRunner ?? stageRunnerNativeInstallation;
  const compile = dependencies.compile ?? compileRunnerNativeServiceTransaction;
  const initialApply = dependencies.initialApply ?? applyInitialRunnerNativeServiceTransaction;
  const upgradeApply = dependencies.upgradeApply ?? applyRunnerNativeServiceTransaction;
  const trust = dependencies.trust ?? runnerNativeTrustAnchorFromEnvironment;
  const run = dependencies.run ?? runFixed;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((accept) => setTimeout(accept, ms)));
  let plan;
  try { plan = validateRunnerNativeInstallPlan(await readJson(config.planPath)); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    plan = await planRunner({
      artifactDirectory: config.artifactDirectory, buildReceiptPath: config.buildReceiptPath,
      connectorEnvFile: config.connectorEnvFile, installRoot: config.installRoot,
      machineConfigPath: config.machineConfigPath, outputPath: config.planPath,
      previousPlanPath: config.previousPlanPath, releasePath: config.releasePath,
      runnerEnvFile: config.runnerEnvFile, trustPolicyDigest: config.trustPolicyDigest,
      trustPolicyPath: config.trustPolicyPath,
    });
  }
  const staged = await stageRunner(plan, plan.planDigest);
  const windowsOptions = config.windows === null ? {} : {
    windowsBridgePath: config.windows.bridgePath,
    windowsBridgeManifestPath: config.windows.bridgeManifestPath,
    windowsBridgeTrustPolicyPath: config.windows.bridgeTrustPolicyPath,
    windowsBridgeTrustPolicyDigest: config.windows.bridgeTrustPolicyDigest,
    windowsActuatorPath: config.windows.actuatorPath,
    windowsActuatorManifestPath: config.windows.actuatorManifestPath,
    windowsActuatorTrustPolicyPath: config.windows.actuatorTrustPolicyPath,
    windowsActuatorTrustPolicyDigest: config.windows.actuatorTrustPolicyDigest,
  };
  const transaction = await compile({
    planPath: config.planPath, planDigest: plan.planDigest, outputPath: config.transactionPath, ...windowsOptions,
  });
  const result = Object.freeze({
    schemaVersion: "deviludo.e2e-host-deployment-result.v1", applied: options.apply,
    activationMode: plan.activation.mode, platform: plan.platform, architecture: plan.architecture,
    releaseId: plan.releaseId, planDigest: plan.planDigest, stagingReceiptDigest: staged.receipt.receiptDigest,
    transactionDigest: transaction.transactionDigest,
  });
  if (!options.apply) return result;
  const runnerEnv = plan.activation.mode === "DRAINED_UPGRADE"
    ? parseEnvironmentLock(await boundedFile(config.runnerEnvFile)) : null;
  if (runnerEnv !== null) await requestActivationUntilReady(config, plan, runnerEnv, run, sleep);
  if (plan.platform === "windows") {
    if (config.windows === null || transaction.status !== "READY") invalid();
    const programData = process.env.ProgramData;
    if (typeof programData !== "string" || !programData || !isAbsolute(programData)
      || resolve(config.windows.actuationRequestPath).toLowerCase()
        !== resolve(programData, "DeviLudo", "NativeActuator", "actuation-request.v1.bin").toLowerCase()) invalid();
    const request = await compileWindowsScmActuationRequest({
      outputPath: config.windows.actuationRequestPath,
      transactionPath: config.transactionPath,
      transactionDigest: transaction.transactionDigest,
    });
    const actuation = await run(config.windows.actuatorPath, ["--apply"]);
    if (actuation.exitCode !== 0) throw new Error("Signed Windows Runner actuator failed");
    const probe = await run(config.windows.actuatorPath, ["--probe"]);
    if (probe.exitCode !== 0) throw new Error("Windows Runner services did not become healthy");
    return Object.freeze({ ...result, windowsRequestDigest: request.requestDigest });
  }
  if (config.windows !== null) invalid();
  const actuationOptions = {
    outputPath: config.receiptPath, planPath: config.planPath, planDigest: plan.planDigest,
    transactionPath: config.transactionPath, transactionDigest: transaction.transactionDigest,
    windowsBridgePath: null, windowsBridgeManifestPath: null,
    windowsBridgeTrustPolicyPath: null, windowsBridgeTrustPolicyDigest: null,
  };
  let receipt;
  if (plan.activation.mode === "INITIAL_ENROLLMENT") receipt = await initialApply(actuationOptions);
  else {
    const anchor = await trust(runnerEnv);
    const ingress = dependencies.ingress ?? await physicalRunnerIngressClientFromEnv(runnerEnv);
    receipt = await upgradeApply({ ...actuationOptions, activationGrantPath: plan.activation.activationGrantFile, ...anchor }, {
      reportRollback: (grant, failureDigest) => ingress.rollbackNativeInstall(grant, failureDigest),
    });
  }
  if (receipt.state !== "SERVICES_STARTED") throw new Error("E2E host deployment rolled back");
  return Object.freeze({ ...result, actuationReceiptDigest: receipt.receiptDigest });
}

async function requestActivationUntilReady(config, plan, runnerEnv, run, sleep) {
  const args = ["--import", "tsx", resolve(ROOT, "scripts/production/request-runner-native-activation.mjs"),
    "--plan", config.planPath, "--plan-digest", plan.planDigest, "--current-plan", config.previousPlanPath,
    "--operation-id", config.operationId, "--output", plan.activation.activationGrantFile];
  for (let attempt = 0; attempt < 720; attempt += 1) {
    const result = await run(process.execPath, args, { env: runnerEnv });
    if (result.exitCode !== 0) throw new Error("Runner drain authorization failed");
    let body; try { body = JSON.parse(result.stdout.trim()); } catch { throw new Error("Runner drain response is invalid"); }
    if (body.state === "ACTIVATION_AUTHORIZED") return;
    if (body.state !== "DRAINING" || !Number.isSafeInteger(body.retryAfterSeconds)
      || body.retryAfterSeconds < 1 || body.retryAfterSeconds > 300) invalid();
    await sleep(body.retryAfterSeconds * 1_000);
  }
  throw new Error("Runner did not drain before the one-hour deployment deadline");
}

function runFixed(command, args, { env = {} } = {}) {
  if (!absolute(command) || !Array.isArray(args) || args.some((value) => typeof value !== "string" || /[\0\r\n]/.test(value))) invalid();
  return new Promise((accept, reject) => execFile(command, args, {
    shell: false, windowsHide: true, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: MAX_JSON_BYTES,
    env: { ...process.env, ...env, NODE_ENV: "production" },
  }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") reject(error);
    else accept(Object.freeze({ exitCode: typeof error?.code === "number" ? error.code : 0, stdout, stderr }));
  }));
}
async function boundedFile(path) { const metadata = await lstat(path); if (!metadata.isFile() || metadata.isSymbolicLink()
  || metadata.size < 2 || metadata.size > MAX_JSON_BYTES || (metadata.mode & 0o022) !== 0) invalid(); return readFile(path); }
async function readJson(path) { const bytes = await boundedFile(path); try { return JSON.parse(bytes.toString("utf8")); } catch { invalid(); } }
function absolute(value) { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/.test(value)) invalid(); return value; }
function record(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function invalid() { throw new Error("E2E Runner host deployment input is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production") invalid();
  if (process.argv.includes("--apply") && process.platform !== "win32"
    && (typeof process.getuid !== "function" || process.getuid() !== 0)) throw new Error("E2E host apply requires root");
  const result = await deployE2ERunnerHost(parseE2EHostDeploymentArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`[deploy:e2e-host] ${error instanceof Error ? error.message : "deployment failed"}\n`); process.exitCode = 1; });
}
