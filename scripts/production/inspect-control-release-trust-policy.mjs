#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import {
  controlReleaseTrustPolicyDigest,
  validateControlReleaseTrustPolicy,
} from "./control-release-authorization.mjs";

const MAX_POLICY_BYTES = 1024 * 1024;

export function inspectControlReleaseTrustPolicy(policy) {
  const validated = validateControlReleaseTrustPolicy(policy);
  return Object.freeze({
    schemaVersion: "deviludo.control-release-trust-inspection.v1",
    policyId: validated.policyId,
    policyRevision: validated.policyRevision,
    policyDigest: controlReleaseTrustPolicyDigest(validated),
    keys: Object.freeze(validated.keys.map((key) => Object.freeze({
      keyId: key.keyId,
      algorithm: key.algorithm,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
      status: key.status,
    }))),
  });
}

export function parseControlReleaseTrustInspectionArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--trust-policy"
    || typeof argv[1] !== "string" || !isAbsolute(argv[1]) || /[\0\r\n]/.test(argv[1])) invalid();
  return Object.freeze({ trustPolicyPath: argv[1] });
}

async function main() {
  const { trustPolicyPath } = parseControlReleaseTrustInspectionArguments(process.argv.slice(2));
  const source = await readFile(trustPolicyPath);
  if (source.length < 2 || source.length > MAX_POLICY_BYTES || source.includes(0)) invalid();
  let policy;
  try { policy = JSON.parse(source.toString("utf8")); } catch { invalid(); }
  process.stdout.write(`${JSON.stringify(inspectControlReleaseTrustPolicy(policy))}\n`);
}

function invalid() {
  throw new Error("Control release trust inspection input is invalid");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[inspect:control-trust] inspection failed\n");
    process.exitCode = 1;
  });
}
