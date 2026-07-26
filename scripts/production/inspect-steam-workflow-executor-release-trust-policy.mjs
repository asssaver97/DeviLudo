#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  steamWorkflowExecutorReleaseTrustPolicyDigest,
  validateSteamWorkflowExecutorReleaseTrustPolicy,
} from "./steam-workflow-executor-release-authorization.mjs";

export function inspectSteamWorkflowExecutorReleaseTrustPolicy(value) {
  const policy = validateSteamWorkflowExecutorReleaseTrustPolicy(value);
  return Object.freeze({
    schemaVersion: "deviludo.steam-workflow-executor-release-trust-inspection.v1",
    policyId: policy.policyId,
    policyRevision: policy.policyRevision,
    policyDigest: steamWorkflowExecutorReleaseTrustPolicyDigest(policy),
    keys: Object.freeze(policy.keys.map((key) => Object.freeze({
      keyId: key.keyId, algorithm: key.algorithm, notBefore: key.notBefore, notAfter: key.notAfter, status: key.status,
    }))),
  });
}
export function parseSteamWorkflowExecutorReleaseTrustInspectionArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--trust-policy") invalid();
  if (typeof argv[1] !== "string" || !isAbsolute(argv[1]) || resolve(argv[1]) !== argv[1]
    || argv[1].length > 4_096 || /[\0\r\n]/.test(argv[1])) invalid();
  return Object.freeze({ trustPolicyPath: argv[1] });
}
async function main() {
  const { trustPolicyPath } = parseSteamWorkflowExecutorReleaseTrustInspectionArguments(process.argv.slice(2));
  const metadata = await lstat(trustPolicyPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 1024 * 1024) invalid();
  let value; try { value = JSON.parse(await readFile(trustPolicyPath, "utf8")); } catch { invalid(); }
  process.stdout.write(`${JSON.stringify(inspectSteamWorkflowExecutorReleaseTrustPolicy(value))}\n`);
}
function invalid() { throw new Error("Steam workflow executor release trust inspection input is invalid"); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[inspect:steam-workflow-executor-release-trust] inspection failed\n"); process.exitCode = 1; });
}
