#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createEvidenceBundle, encodeRgbaPng } from "../e2e-evidence.mjs";

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
  const base = {
    schemaVersion: "deviludo.godot-guest-report.v2",
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
  };
  if (action === "test") {
    const jobRoot = process.env.DEVILUDO_E2E_JOB_ROOT ?? "";
    if (!isAbsolute(jobRoot)) throw new Error("DEVILUDO_E2E_JOB_ROOT must be absolute");
    const directory = resolve(jobRoot, request.jobId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const screenshots = [];
    for (const id of ["game-start", "key-state", "game-complete"]) {
      const path = join(directory, `${id}.png`);
      const pixels = Buffer.alloc(1280 * 720 * 4);
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const pixel = offset / 4;
        pixels[offset] = pixel % 251; pixels[offset + 1] = Math.floor(pixel / 1280) % 251; pixels[offset + 2] = id.length * 17; pixels[offset + 3] = 255;
      }
      await writeFile(path, encodeRgbaPng(1280, 720, pixels));
      screenshots.push({ id, path });
    }
    const report = { schemaVersion: "deviludo.e2e-evidence.v1", jobId: request.jobId, platform: request.operatingSystem ?? "macos", outcome: "PASSED", failureDomain: null, summary: base.summary,
      checkpoints: screenshots.map(item => ({ journeyId: "fixture-core-loop", checkpointId: item.id, status: "PASSED", screenshot: `screenshots/${item.id}.png` })) };
    const bundle = await createEvidenceBundle({ outputRoot: directory, jobId: request.jobId, platform: request.operatingSystem ?? "macos", report, screenshots });
    Object.assign(base, {
      evidence: { protocol: "deviludo.e2e-evidence.v1", result: "PASSED", checkCount: 1, screenshotCount: 3, hasVisualDiff: false },
      outputPath: bundle.outputPath,
      outputSha256: bundle.outputSha256,
      outputSizeBytes: bundle.outputSizeBytes,
    });
  }
  process.stdout.write(JSON.stringify(base));
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
