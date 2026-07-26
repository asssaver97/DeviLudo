#!/usr/bin/env node

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  steamDepotFinalizerServiceTrustPolicyDigest,
  validateSteamDepotFinalizerServiceTrustPolicy,
} from "../../services/steam-depot-finalizer/src/native-service-release.ts";

const MAX_BYTES = 1024 * 1024;

export function parseSteamDepotFinalizerServiceTrustArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--trust-policy"
    || typeof argv[1] !== "string" || !isAbsolute(argv[1]) || resolve(argv[1]) !== argv[1]
    || argv[1].length > 4_096 || /[\0\r\n]/.test(argv[1])) invalid();
  return Object.freeze({ trustPolicyPath: argv[1] });
}

export async function inspectSteamDepotFinalizerServiceTrustPolicy(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_BYTES || (before.mode & 0o022) !== 0) invalid();
    const bytes = await file.readFile(); const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    let parsed; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
    const policy = validateSteamDepotFinalizerServiceTrustPolicy(parsed);
    return Object.freeze({
      schemaVersion: "deviludo.steam-depot-finalizer-service-trust-inspection.v1",
      policyId: policy.policyId,
      policyRevision: policy.policyRevision,
      trustPolicyDigest: steamDepotFinalizerServiceTrustPolicyDigest(policy),
      keys: policy.keys.map(({ keyId, algorithm, notBefore, notAfter, status }) => Object.freeze({
        keyId, algorithm, notBefore, notAfter, status,
      })),
    });
  } finally { await file.close(); }
}

function invalid() { throw new Error("Steam depot finalizer service trust inspection input is invalid"); }

async function main() {
  const result = await inspectSteamDepotFinalizerServiceTrustPolicy(
    parseSteamDepotFinalizerServiceTrustArguments(process.argv.slice(2)).trustPolicyPath,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[inspect:steam-depot-finalizer-service-trust] inspection failed\n"); process.exitCode = 1; });
}
