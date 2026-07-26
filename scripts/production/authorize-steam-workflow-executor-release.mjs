#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createSteamWorkflowExecutorReleaseClaims,
  steamWorkflowExecutorReleaseSignerFromEnvironment,
  steamWorkflowExecutorReleaseTrustPolicyDigest,
  validateSteamWorkflowExecutorReleaseTrustPolicy,
} from "./steam-workflow-executor-release-authorization.mjs";
import { validateSteamWorkflowExecutorImageReceipt } from "./build-steam-workflow-executor-image.mjs";
import { renderSteamWorkflowExecutorRelease } from "./deploy-steam-workflow-executor.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_JSON_BYTES = 1024 * 1024;

export function parseSteamWorkflowExecutorReleaseAuthorizationArguments(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) invalid();
  const allowed = new Set([
    "--authorization-id", "--context", "--namespace", "--receipt", "--replicas", "--runtime-lock",
    "--timeout-seconds", "--trust-policy", "--trust-policy-digest", "--ttl-seconds",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  const receiptPath = values.get("--receipt"); const runtimeLockPath = values.get("--runtime-lock");
  const trustPolicyPath = values.get("--trust-policy"); const trustPolicyDigest = values.get("--trust-policy-digest");
  const clusterContext = values.get("--context"); const namespace = values.get("--namespace") ?? "deviludo-steam-release";
  const replicas = integer(values.get("--replicas") ?? "1", 1, 10);
  const timeoutSeconds = integer(values.get("--timeout-seconds") ?? "900", 60, 3_600);
  const ttlSeconds = integer(values.get("--ttl-seconds") ?? "900", 60, 1_800);
  const authorizationId = values.get("--authorization-id");
  if (!absolute(receiptPath) || !absolute(runtimeLockPath) || !absolute(trustPolicyPath) || !SHA256.test(trustPolicyDigest)
    || typeof clusterContext !== "string" || !CONTEXT.test(clusterContext) || !NAMESPACE.test(namespace)
    || (authorizationId !== undefined && !UUID.test(authorizationId))) invalid();
  return Object.freeze({
    authorizationId, clusterContext, namespace, receiptPath, replicas, runtimeLockPath,
    timeoutSeconds, trustPolicyDigest, trustPolicyPath, ttlSeconds,
  });
}

async function main() {
  if (process.env.NODE_ENV !== "production") invalid();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const options = parseSteamWorkflowExecutorReleaseAuthorizationArguments(process.argv.slice(2));
  const packageJson = await readJson(resolve(root, "package.json"));
  const receipt = validateSteamWorkflowExecutorImageReceipt(await readJson(options.receiptPath), {
    platformVersion: packageJson.version,
    dockerfileDigest: await digestFile(resolve(root, "Dockerfile.steam-workflow-executor")),
    packageLockDigest: await digestFile(resolve(root, "package-lock.json")),
  });
  const policy = validateSteamWorkflowExecutorReleaseTrustPolicy(
    await readJson(options.trustPolicyPath), options.trustPolicyDigest);
  if (steamWorkflowExecutorReleaseTrustPolicyDigest(policy) !== options.trustPolicyDigest) invalid();
  const bundle = renderSteamWorkflowExecutorRelease(receipt, {
    namespace: options.namespace, replicas: options.replicas, timeoutSeconds: options.timeoutSeconds,
    runtimeLock: await readJson(options.runtimeLockPath),
  });
  if (bundle.runtimeLock.clusterContext !== options.clusterContext) invalid();
  const claims = createSteamWorkflowExecutorReleaseClaims(bundle, options.clusterContext, {
    ...(options.authorizationId === undefined ? {} : { authorizationId: options.authorizationId }),
    ttlSeconds: options.ttlSeconds,
  });
  const signer = await steamWorkflowExecutorReleaseSignerFromEnvironment();
  process.stdout.write(`${JSON.stringify(await signer.sign(bundle, claims, policy, options.trustPolicyDigest))}\n`);
}
async function readJson(path) { const bytes = await readFile(path);
  if (bytes.length < 2 || bytes.length > MAX_JSON_BYTES || bytes.includes(0)) invalid();
  try { return JSON.parse(bytes.toString("utf8")); } catch { invalid(); } }
async function digestFile(path) { return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`; }
function absolute(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value; }
function integer(value, minimum, maximum) { const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value || parsed < minimum || parsed > maximum) invalid(); return parsed; }
function invalid() { throw new Error("Steam workflow executor release authorization input is invalid"); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[authorize:steam-workflow-executor] authorization failed\n"); process.exitCode = 1; });
}
