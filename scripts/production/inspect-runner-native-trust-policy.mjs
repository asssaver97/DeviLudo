#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  runnerNativeTrustPolicyDigest,
  validateRunnerNativeTrustPolicy,
} from "./runner-native-release.mjs";

const MAX_POLICY_BYTES = 1024 * 1024;

export function inspectRunnerNativeTrustPolicy(policy) {
  const validated = validateRunnerNativeTrustPolicy(policy);
  return Object.freeze({
    schemaVersion: "deviludo.runner-native-trust-inspection.v1",
    policyId: validated.policyId,
    policyRevision: validated.policyRevision,
    policyDigest: runnerNativeTrustPolicyDigest(validated),
    keys: Object.freeze(validated.keys.map((key) => Object.freeze({
      keyId: key.keyId,
      algorithm: key.algorithm,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
      status: key.status,
    }))),
  });
}

export function parseRunnerNativeTrustInspectionArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--trust-policy") invalid();
  return Object.freeze({ trustPolicyPath: absolute(argv[1]) });
}

async function main() {
  const { trustPolicyPath } = parseRunnerNativeTrustInspectionArguments(process.argv.slice(2));
  const metadata = await lstat(trustPolicyPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_POLICY_BYTES) invalid();
  let policy;
  try { policy = JSON.parse(await readFile(trustPolicyPath, "utf8")); } catch { invalid(); }
  process.stdout.write(`${JSON.stringify(inspectRunnerNativeTrustPolicy(policy))}\n`);
}

function absolute(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value
    || value.length > 4_096 || /[\0\r\n]/.test(value)) invalid();
  return value;
}

function invalid() {
  throw new Error("Runner native trust inspection input is invalid");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[inspect:runner-native-trust] inspection failed\n");
    process.exitCode = 1;
  });
}
