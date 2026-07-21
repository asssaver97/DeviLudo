#!/usr/bin/env node

import { lstat, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createWindowsScmActuationRequest,
  encodeWindowsScmActuationRequest,
  windowsScmActuationRequestDigest,
} from "../../services/runner-control/src/windows-scm-actuation-request.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;

export function parseWindowsScmActuationRequestArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) invalid();
  const allowed = new Set(["--output", "--transaction", "--transaction-digest"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (!SHA256.test(values.get("--transaction-digest"))) invalid();
  return Object.freeze({
    outputPath: absolute(values.get("--output")),
    transactionPath: absolute(values.get("--transaction")),
    transactionDigest: values.get("--transaction-digest"),
  });
}

export async function compileWindowsScmActuationRequest(options) {
  if (!plainRecord(options) || !absoluteValue(options.outputPath) || !absoluteValue(options.transactionPath)
    || !SHA256.test(options.transactionDigest)) invalid();
  const transaction = await readBoundedJson(options.transactionPath);
  if (transaction.transactionDigest !== options.transactionDigest) invalid();
  const request = createWindowsScmActuationRequest(transaction);
  const bytes = encodeWindowsScmActuationRequest(request);
  if (bytes.length < 128 || bytes.length > MAX_REQUEST_BYTES) invalid();
  const replayed = await createOnlyBytes(options.outputPath, bytes);
  return Object.freeze({ request, requestDigest: windowsScmActuationRequestDigest(bytes), sizeBytes: bytes.length, replayed });
}

async function readBoundedJson(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_JSON_BYTES) invalid();
  try { return JSON.parse(await readFile(path, "utf8")); } catch { invalid(); }
}

async function createOnlyBytes(path, bytes) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  try {
    const file = await open(path, "wx", 0o400);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    return false;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== bytes.length
      || !Buffer.from(await readFile(path)).equals(bytes)) invalid();
    return true;
  }
}

function absolute(value) { if (!absoluteValue(value)) invalid(); return value; }
function absoluteValue(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096; }
function plainRecord(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function invalid() { throw new Error("Windows SCM actuation request compilation input is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production") invalid();
  const result = await compileWindowsScmActuationRequest(
    parseWindowsScmActuationRequestArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.windows-scm-actuation-request-compilation-result.v1",
    transactionDigest: result.request.transactionDigest,
    requestDigest: result.requestDigest,
    sizeBytes: result.sizeBytes,
    replayed: result.replayed,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[compile:windows-scm-actuation-request] compilation failed\n");
    process.exitCode = 1;
  });
}
