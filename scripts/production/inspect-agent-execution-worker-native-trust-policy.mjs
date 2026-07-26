#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  agentExecutionWorkerNativeTrustPolicyDigest,
  validateAgentExecutionWorkerNativeTrustPolicy,
} from "../../services/agent-execution-broker/src/native-worker-release.ts";

export function inspectAgentExecutionWorkerNativeTrustPolicy(value) {
  const policy = validateAgentExecutionWorkerNativeTrustPolicy(value);
  return Object.freeze({
    schemaVersion: "deviludo.agent-execution-worker-native-trust-inspection.v1",
    policyId: policy.policyId,
    policyRevision: policy.policyRevision,
    policyDigest: agentExecutionWorkerNativeTrustPolicyDigest(policy),
    keys: Object.freeze(policy.keys.map((key) => Object.freeze({
      keyId: key.keyId,
      algorithm: key.algorithm,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
      status: key.status,
    }))),
  });
}
export function parseAgentExecutionWorkerNativeTrustInspectionArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--trust-policy") invalid();
  return Object.freeze({ trustPolicyPath: absolute(argv[1]) });
}
function absolute(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /[\0\r\n]/.test(value)) invalid();
  return value;
}
function invalid() { throw new Error("Agent execution Worker native trust inspection input is invalid"); }
async function main() {
  const { trustPolicyPath } = parseAgentExecutionWorkerNativeTrustInspectionArguments(process.argv.slice(2));
  const metadata = await lstat(trustPolicyPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 1024 * 1024) invalid();
  let value; try { value = JSON.parse(await readFile(trustPolicyPath, "utf8")); } catch { invalid(); }
  process.stdout.write(`${JSON.stringify(inspectAgentExecutionWorkerNativeTrustPolicy(value))}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[inspect:agent-execution-worker-native-trust] inspection failed\n"); process.exitCode = 1; });
}
