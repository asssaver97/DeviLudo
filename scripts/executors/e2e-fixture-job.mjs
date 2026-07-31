#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const action = process.argv[2];
if (!["test", "clean-install", "sign"].includes(action)) throw new Error("Unsupported fixture E2E action");

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (!/^[0-9a-f-]{36}$/i.test(request.jobId ?? "") || !Array.isArray(request.inputs) || request.inputs.length < 1) {
  throw new Error("Fixture E2E request is invalid");
}
const input = request.inputs.at(-1);
if (!input?.object || !/^sha256:[0-9a-f]{64}$/.test(input.object.sha256 ?? "")) {
  throw new Error("Fixture E2E input is invalid");
}

if (action !== "sign") {
  process.stdout.write(JSON.stringify({
    schemaVersion: "deviludo.godot-guest-report.v1",
    action,
    jobId: request.jobId,
    inputDigest: input.object.sha256,
    outcome: "PASSED",
    failureDomain: null,
    summary: action === "test" ? "Fixed E2E guest validation passed" : "Fixed clean-install validation passed",
    guest: {
      executor: "playwright-e2e-fixture",
      isolation: "TEST_FIXED",
      exitCode: 0,
      stdout: "",
      stderr: "",
    },
  }));
  process.exit(0);
}

if (!["linux", "windows", "macos"].includes(request.operatingSystem)) {
  throw new Error("Fixture signing platform is invalid");
}
const jobRoot = process.env.DEVILUDO_E2E_JOB_ROOT ?? "";
if (!isAbsolute(jobRoot)) throw new Error("DEVILUDO_E2E_JOB_ROOT must be absolute");
const response = await fetch(input.url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`Fixture signing input returned ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const inputDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
if (inputDigest !== input.object.sha256 || bytes.length !== input.object.sizeBytes) {
  throw new Error("Fixture signing input does not match its registered object");
}
const directory = resolve(jobRoot, request.jobId);
const outputPath = resolve(directory, `signed-build-${request.operatingSystem}.tar.gz`);
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(outputPath, bytes, { mode: 0o600 });
process.stdout.write(JSON.stringify({
  schemaVersion: "deviludo.platform-sign-receipt.v1",
  jobId: request.jobId,
  inputDigest,
  targetPlatform: request.operatingSystem,
  outputPath,
  outputSha256: inputDigest,
  outputSizeBytes: bytes.length,
}));
