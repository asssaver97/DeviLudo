#!/usr/bin/env node

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  steamDepotFinalizerNativeTrustPolicyDigest,
  validateSteamDepotFinalizerNativeTrustPolicy,
} from "../../services/steam-depot-finalizer/src/native-controller-release.ts";

const MAX_BYTES = 1024 * 1024;

export async function inspectSteamDepotFinalizerNativeTrustPolicy(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path.length > 4_096) invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_BYTES || (before.mode & 0o022) !== 0) invalid();
    const bytes = await file.readFile(); const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    let parsed; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
    const policy = validateSteamDepotFinalizerNativeTrustPolicy(parsed);
    return Object.freeze({
      schemaVersion: "deviludo.steam-depot-finalizer-native-trust-inspection.v1",
      policyId: policy.policyId,
      policyRevision: policy.policyRevision,
      trustPolicyDigest: steamDepotFinalizerNativeTrustPolicyDigest(policy),
      keys: policy.keys.map(({ keyId, algorithm, notBefore, notAfter, status }) => Object.freeze({
        keyId, algorithm, notBefore, notAfter, status,
      })),
    });
  } finally { await file.close(); }
}

function invalid() { throw new Error("Steam depot finalizer native trust inspection input is invalid"); }

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== "--trust-policy") invalid();
  process.stdout.write(`${JSON.stringify(await inspectSteamDepotFinalizerNativeTrustPolicy(argv[1]))}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[inspect:steam-depot-finalizer-native-trust] inspection failed\n");
    process.exitCode = 1;
  });
}
