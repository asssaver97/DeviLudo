#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  agentSupplyChainNativeTrustPolicyDigest,
  validateAgentSupplyChainNativeTrustPolicy,
} from "../../services/agent-supply-chain/src/native-release-manifest.ts";

const MAX_POLICY_BYTES = 1024 * 1024;

export function inspectAgentSupplyChainNativeTrustPolicy(policy) {
  const trusted = validateAgentSupplyChainNativeTrustPolicy(policy);
  return Object.freeze({
    schemaVersion: "deviludo.agent-supply-chain-native-trust-inspection.v1",
    policyId: trusted.policyId,
    policyRevision: trusted.policyRevision,
    policyDigest: agentSupplyChainNativeTrustPolicyDigest(trusted),
    keys: Object.freeze(trusted.keys.map((key) => Object.freeze({
      keyId: key.keyId,
      algorithm: key.algorithm,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
      status: key.status,
    }))),
  });
}

export function parseAgentSupplyChainNativeTrustInspectionArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--trust-policy") invalid();
  return Object.freeze({ trustPolicyPath: absolute(argv[1]) });
}

async function main() {
  const { trustPolicyPath } = parseAgentSupplyChainNativeTrustInspectionArguments(process.argv.slice(2));
  const metadata = await lstat(trustPolicyPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_POLICY_BYTES) invalid();
  let policy;
  try { policy = JSON.parse(await readFile(trustPolicyPath, "utf8")); } catch { invalid(); }
  process.stdout.write(`${JSON.stringify(inspectAgentSupplyChainNativeTrustPolicy(policy))}\n`);
}

function absolute(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value
    || value.length > 4096 || /[\0\r\n]/.test(value)) invalid();
  return value;
}

function invalid() { throw new Error("Agent supply-chain native trust inspection input is invalid"); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[inspect:agent-supply-chain-native-trust] inspection failed\n");
    process.exitCode = 1;
  });
}
