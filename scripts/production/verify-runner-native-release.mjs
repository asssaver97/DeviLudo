#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { verifyRunnerNativeRelease } from "./runner-native-release.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 1024 * 1024;

export function parseRunnerNativeVerificationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 10) invalidInput();
  const allowed = new Set(["--artifacts", "--build-receipt", "--release", "--trust-policy", "--trust-policy-digest"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || values.has(name) || /[\0\r\n]/.test(value)) invalidInput();
    values.set(name, value);
  }
  const artifacts = absolute(values.get("--artifacts"));
  const buildReceipt = absolute(values.get("--build-receipt"));
  const release = absolute(values.get("--release"));
  const trustPolicy = absolute(values.get("--trust-policy"));
  const trustPolicyDigest = values.get("--trust-policy-digest");
  if (!SHA256.test(trustPolicyDigest)) invalidInput();
  return Object.freeze({ artifacts, buildReceipt, release, trustPolicy, trustPolicyDigest });
}

async function readBoundedJson(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_JSON_BYTES) invalidInput();
  return JSON.parse(await readFile(path, "utf8"));
}

function absolute(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.length > 4_096) invalidInput();
  return value;
}

function invalidInput() {
  throw new Error("Runner native verification input is invalid");
}

async function main() {
  if (process.env.NODE_ENV !== "production") invalidInput();
  const options = parseRunnerNativeVerificationArguments(process.argv.slice(2));
  const [buildReceipt, release, trustPolicy] = await Promise.all([
    readBoundedJson(options.buildReceipt),
    readBoundedJson(options.release),
    readBoundedJson(options.trustPolicy),
  ]);
  const authorization = await verifyRunnerNativeRelease(release, buildReceipt, trustPolicy, options.trustPolicyDigest, {
    artifactDirectory: options.artifacts,
  });
  process.stdout.write(`${JSON.stringify(authorization)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[verify:runner-native] verification failed\n");
    process.exitCode = 1;
  });
}
