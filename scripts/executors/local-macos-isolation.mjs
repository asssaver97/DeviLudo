#!/usr/bin/env node
import { sign } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";

const action = process.argv[2];
const readArgument = name => process.argv[process.argv.indexOf(name) + 1] ?? "";
const jobId = readArgument("--job-id");
const generation = readArgument("--generation");
const stage = readArgument("--stage");
if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^\d+$/.test(generation) || !["reimage", "cleanup"].includes(action)) throw new Error("Isolation request is invalid");
const workspace = `/tmp/deviludo-e2e/${jobId}`;
await rm(workspace, { recursive: true, force: true });
if (action === "reimage" && stage === "before") await mkdir(workspace, { recursive: true, mode: 0o700 });
const key = await readFile(process.env.DEVILUDO_E2E_IDENTITY_KEY_FILE, "utf8");
const payload = `${action}:${stage}:${jobId}:${generation}`;
process.stdout.write(`${action}:${stage}:development-native-ed25519:${sign(null, Buffer.from(payload), key).toString("base64url")}`);
