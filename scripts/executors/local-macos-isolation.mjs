#!/usr/bin/env node
import { sign } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { readCliArgument } from "../../deploy/assets/e2e-process-lifecycle.mjs";

const action = process.argv[2];
const jobId = readCliArgument(process.argv, "--job-id");
const generation = readCliArgument(process.argv, "--generation");
const stage = readCliArgument(process.argv, "--stage");
if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^\d+$/.test(generation) || !["reimage", "cleanup"].includes(action)) throw new Error("Isolation request is invalid");
const workspace = `/tmp/deviludo-e2e/${jobId}`;
await rm(workspace, { recursive: true, force: true });
if (action === "reimage" && stage === "before") await mkdir(workspace, { recursive: true, mode: 0o700 });
const key = await readFile(process.env.DEVILUDO_E2E_IDENTITY_KEY_FILE, "utf8");
const payload = `${action}:${stage}:${jobId}:${generation}`;
process.stdout.write(`${action}:${stage}:development-native-ed25519:${sign(null, Buffer.from(payload), key).toString("base64url")}`);
