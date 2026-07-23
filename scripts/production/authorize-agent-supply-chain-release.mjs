#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  agentSupplyChainReleaseSignerFromEnvironment,
  agentSupplyChainReleaseTrustPolicyDigest,
  createAgentSupplyChainReleaseClaims,
  validateAgentSupplyChainReleaseTrustPolicy,
} from "./agent-supply-chain-release-authorization.mjs";
import { validateAgentSupplyChainImageReceipt } from "./build-agent-supply-chain-image.mjs";
import { renderAgentSupplyChainRelease } from "./deploy-agent-supply-chain.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_JSON_BYTES = 1024 * 1024;

export function parseAgentSupplyChainReleaseAuthorizationArguments(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) invalid();
  const allowed = new Set([
    "--authorization-id", "--context", "--namespace", "--receipt", "--replicas", "--runtime-lock",
    "--trust-policy", "--trust-policy-digest", "--ttl-seconds",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  const receiptPath = values.get("--receipt");
  const runtimeLockPath = values.get("--runtime-lock");
  const trustPolicyPath = values.get("--trust-policy");
  const trustPolicyDigest = values.get("--trust-policy-digest");
  const clusterContext = values.get("--context");
  const namespace = values.get("--namespace") ?? "deviludo-agent-supply-chain";
  const replicas = integer(values.get("--replicas") ?? "1", 1, 3);
  const ttlSeconds = integer(values.get("--ttl-seconds") ?? "900", 60, 1_800);
  const authorizationId = values.get("--authorization-id");
  if (!absolutePath(receiptPath) || !absolutePath(runtimeLockPath) || !absolutePath(trustPolicyPath)
    || typeof trustPolicyDigest !== "string" || !SHA256.test(trustPolicyDigest)
    || typeof clusterContext !== "string" || !CONTEXT.test(clusterContext)
    || typeof namespace !== "string" || namespace.length > 63 || !NAMESPACE.test(namespace)
    || (authorizationId !== undefined && !UUID.test(authorizationId))) invalid();
  return Object.freeze({
    authorizationId,
    clusterContext,
    namespace,
    receiptPath,
    replicas,
    runtimeLockPath,
    trustPolicyDigest,
    trustPolicyPath,
    ttlSeconds,
  });
}

async function main() {
  if (process.env.NODE_ENV !== "production") {
    throw new Error("Agent supply-chain release authorization requires production mode");
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const options = parseAgentSupplyChainReleaseAuthorizationArguments(process.argv.slice(2));
  const packageJson = await readJson(resolve(root, "package.json"));
  const receipt = validateAgentSupplyChainImageReceipt(await readJson(options.receiptPath), {
    platformVersion: packageJson.version,
    dockerfileDigest: await digestFile(resolve(root, "Dockerfile.agent-supply-chain")),
    packageLockDigest: await digestFile(resolve(root, "package-lock.json")),
  });
  const policy = validateAgentSupplyChainReleaseTrustPolicy(
    await readJson(options.trustPolicyPath),
    options.trustPolicyDigest,
  );
  if (agentSupplyChainReleaseTrustPolicyDigest(policy) !== options.trustPolicyDigest) invalid();
  const bundle = renderAgentSupplyChainRelease(receipt, {
    namespace: options.namespace,
    replicas: options.replicas,
    runtimeLock: await readJson(options.runtimeLockPath),
  });
  if (bundle.runtimeLock.clusterContext !== options.clusterContext) invalid();
  const claims = createAgentSupplyChainReleaseClaims(bundle, options.clusterContext, {
    ...(options.authorizationId === undefined ? {} : { authorizationId: options.authorizationId }),
    ttlSeconds: options.ttlSeconds,
  });
  const signer = await agentSupplyChainReleaseSignerFromEnvironment();
  const authorization = await signer.sign(bundle, claims, policy, options.trustPolicyDigest);
  process.stdout.write(`${JSON.stringify(authorization)}\n`);
}

async function readJson(path) {
  const source = await readFile(path);
  if (source.length < 2 || source.length > MAX_JSON_BYTES || source.includes(0)) invalid();
  try { return JSON.parse(source.toString("utf8")); } catch { invalid(); }
}
async function digestFile(path) { return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`; }
function absolutePath(value) { return typeof value === "string" && isAbsolute(value); }
function integer(value, minimum, maximum) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || String(result) !== value || result < minimum || result > maximum) invalid();
  return result;
}
function invalid() { throw new Error("Agent supply-chain release authorization input is invalid"); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[authorize:agent-supply-chain] authorization failed\n");
    process.exitCode = 1;
  });
}
