#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  validateWindowsScmNativeActuatorTrustPolicy,
  windowsScmNativeActuatorTrustPolicyDigest,
} from "../../services/runner-control/src/windows-scm-native-actuator.ts";

const MAX_JSON_BYTES = 1024 * 1024;

export function parseWindowsScmNativeActuatorTrustInspectionArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--trust-policy") invalid();
  return Object.freeze({ trustPolicyPath: absolute(argv[1]) });
}

export function inspectWindowsScmNativeActuatorTrustPolicy(value) {
  const policy = validateWindowsScmNativeActuatorTrustPolicy(value);
  return Object.freeze({
    schemaVersion: "deviludo.windows-scm-native-actuator-trust-policy-inspection.v1",
    policyId: policy.policyId,
    policyRevision: policy.policyRevision,
    policyDigest: windowsScmNativeActuatorTrustPolicyDigest(policy),
    keys: Object.freeze(policy.keys.map(({ keyId, algorithm, notBefore, notAfter, status }) =>
      Object.freeze({ keyId, algorithm, notBefore, notAfter, status }))),
  });
}

async function main() {
  const options = parseWindowsScmNativeActuatorTrustInspectionArguments(process.argv.slice(2));
  const metadata = await lstat(options.trustPolicyPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_JSON_BYTES) invalid();
  let value;
  try { value = JSON.parse(await readFile(options.trustPolicyPath, "utf8")); } catch { invalid(); }
  process.stdout.write(`${JSON.stringify(inspectWindowsScmNativeActuatorTrustPolicy(value))}\n`);
}

function absolute(value) { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.length > 4_096) invalid(); return value; }
function invalid() { throw new Error("Windows SCM native actuator trust inspection input is invalid"); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[inspect:windows-scm-native-actuator-trust] inspection failed\n");
    process.exitCode = 1;
  });
}
