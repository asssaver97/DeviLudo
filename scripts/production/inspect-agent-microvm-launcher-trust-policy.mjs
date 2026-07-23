#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  agentMicrovmLauncherTrustPolicyDigest,
  validateAgentMicrovmLauncherTrustPolicy,
} from "../../services/agent-execution-broker/src/native-microvm-launcher-release.ts";

export function inspectAgentMicrovmLauncherTrustPolicy(value) {
  const policy = validateAgentMicrovmLauncherTrustPolicy(value);
  return Object.freeze({ schemaVersion: "deviludo.agent-microvm-launcher-trust-inspection.v1",
    policyId: policy.policyId, policyRevision: policy.policyRevision,
    policyDigest: agentMicrovmLauncherTrustPolicyDigest(policy), keys: Object.freeze(policy.keys.map((key) => Object.freeze({
      keyId: key.keyId, algorithm: key.algorithm, notBefore: key.notBefore, notAfter: key.notAfter, status: key.status,
    }))) });
}

export function parseAgentMicrovmLauncherTrustInspectionArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--trust-policy") invalid();
  return Object.freeze({ trustPolicyPath: absolute(argv[1]) });
}

async function main() {
  const { trustPolicyPath } = parseAgentMicrovmLauncherTrustInspectionArguments(process.argv.slice(2));
  const metadata = await lstat(trustPolicyPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 1024 * 1024) invalid();
  let value;
  try { value = JSON.parse(await readFile(trustPolicyPath, "utf8")); } catch { invalid(); }
  process.stdout.write(`${JSON.stringify(inspectAgentMicrovmLauncherTrustPolicy(value))}\n`);
}
function absolute(value) { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value
  || value.length > 4096 || /[\0\r\n]/.test(value)) invalid(); return value; }
function invalid() { throw new Error("Agent microVM launcher trust inspection input is invalid"); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[inspect:agent-microvm-launcher-trust] inspection failed\n"); process.exitCode = 1; });
}
