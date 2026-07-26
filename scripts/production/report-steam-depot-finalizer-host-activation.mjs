#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  absolute,
  readSecureJson,
  steamDepotFinalizerHostActivationClientFromEnv,
} from "./steam-depot-finalizer-host-activation-client.mjs";

export function parseSteamDepotFinalizerHostActivationReportArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) invalid();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!new Set(["--activation-grant", "--receipt"]).has(name) || typeof value !== "string" || !value
      || values.has(name) || /[\0\r\n]/.test(value) || !absolute(value)) invalid();
    values.set(name, value);
  }
  return Object.freeze({ activationGrantPath: values.get("--activation-grant"), receiptPath: values.get("--receipt") });
}

export async function reportSteamDepotFinalizerHostActivation(options, dependencies) {
  if (!options || !absolute(options.activationGrantPath) || !absolute(options.receiptPath)
    || !dependencies?.client || typeof dependencies.client.complete !== "function") invalid();
  const [grant, receipt] = await Promise.all([
    readSecureJson(options.activationGrantPath), readSecureJson(options.receiptPath),
  ]);
  return dependencies.client.complete(grant, receipt, dependencies.now ?? new Date());
}

async function main() {
  if (process.env.NODE_ENV !== "production") invalid();
  const options = parseSteamDepotFinalizerHostActivationReportArguments(process.argv.slice(2));
  const receipt = await reportSteamDepotFinalizerHostActivation(options, {
    client: await steamDepotFinalizerHostActivationClientFromEnv(),
    now: new Date(),
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-report-result.v1",
    state: receipt.state,
    operationId: receipt.operationId,
    grantSequence: receipt.grantSequence,
    receiptDigest: receipt.receiptDigest,
  })}\n`);
}

function invalid() { throw new Error("Steam depot Finalizer host activation report input is invalid"); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[report:steam-depot-finalizer-host-activation] report failed\n");
    process.exitCode = 1;
  });
}
