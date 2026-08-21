#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createEvidenceBundle, encodeRgbaPng } from "../e2e-evidence.mjs";

if (process.argv[2] !== "test") throw new Error("Unsupported fixture E2E action");
const protocolInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = protocolInput[Symbol.asyncIterator]();
const initial = await lines.next();
// This deterministic fixture never asks Core for an adaptive policy response.
// Release stdin after its single execute frame so the process can exit while
// the parent keeps the bidirectional protocol pipe open for real executors.
protocolInput.close();
const envelope = initial.done ? null : JSON.parse(initial.value);
const request = envelope?.type === "execute" ? envelope.request : null;
if (!/^[0-9a-f-]{36}$/i.test(request?.jobId ?? "") || !Array.isArray(request.inputs) || request.inputs.length < 1) {
  throw new Error("Fixture E2E request is invalid");
}
const input = [...request.inputs].reverse().find(item => item?.object?.kind === "BUILD") ?? request.inputs.at(-1);
if (!input?.object || !/^sha256:[0-9a-f]{64}$/.test(input.object.sha256 ?? "")) throw new Error("Fixture E2E input is invalid");
const jobRoot = process.env.DEVILUDO_E2E_JOB_ROOT ?? "";
if (!isAbsolute(jobRoot)) throw new Error("DEVILUDO_E2E_JOB_ROOT must be absolute");
const directory = resolve(jobRoot, request.jobId);
await mkdir(directory, { recursive: true, mode: 0o700 });
const screenshots = [];
for (const id of ["game-start", "game-progress", "game-complete"]) {
  const path = join(directory, `${id}.png`);
  const pixels = Buffer.alloc(1280 * 720 * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const pixel = offset / 4;
    pixels[offset] = pixel % 251; pixels[offset + 1] = Math.floor(pixel / 1280) % 251;
    pixels[offset + 2] = id.length * 17; pixels[offset + 3] = 255;
  }
  await writeFile(path, encodeRgbaPng(1280, 720, pixels));
  screenshots.push({ id, path });
}
const videoPath = join(directory, "fixture-gameplay.mp4");
await writeFile(videoPath, Buffer.from("fixture-h264-video"));
const trajectoryPath = join(directory, "adaptive-1.jsonl");
await writeFile(trajectoryPath, `${JSON.stringify({ schema: "deviludo.e2e-trajectory-event", stateChanged: true })}\n`);
const regressionPath = join(directory, "current.json");
const regression = {
  schema: "deviludo.e2e-regression",
  contractDigest: request.testPlan?.contractDigest ?? `sha256:${"1".repeat(64)}`,
  inputProfile: "KEYBOARD_MOUSE", estimatedDurationMs: 5_000,
  goal: "Complete the fixture core loop", actions: [{ type: "key_tap", key: "SPACE" }],
  successAssertions: [{ source: "PROGRESS", key: "turn", operator: "CHANGED" }],
};
const regressionBytes = Buffer.from(`${JSON.stringify(regression)}\n`);
await writeFile(regressionPath, regressionBytes);
const platform = request.operatingSystem ?? "macos";
const summary = "Deterministic checks and two of three adaptive rollouts passed";
const report = {
  schema: "deviludo.e2e-evidence", jobId: request.jobId, platform, action: "test",
  outcome: "PASSED", failureDomain: null, summary,
  coverage: { headlessCheckCount: 1, interactiveJourneyCount: 1, deterministicInputCount: 2,
    realInputCount: 8, keyboardMouseInputCount: 8, gamepadInputCount: 0,
    adaptiveRolloutCount: 3, adaptiveSuccessCount: 2, adaptiveDecisionCount: 6,
    coveredPlayerRequirementCount: 1, playerRequirementCount: 1, visualBaselineCount: 1 },
  performance: { schema: "deviludo.e2e-performance.v1", passed: true, thresholds: {},
    environment: { softwareRenderer: true, softwareRendererRunCount: 1, frameRateEnforced: false,
      inputResponseThresholds: { maximumP95Ms: 4_000, maximumMs: 6_000 } },
    frameRate: { sampleCount: 6, minimumFps: 60, p10Fps: 60, medianFps: 60,
      slowSampleCount: 0, slowSampleRatio: 0, runs: [] },
    inputResponse: { sampleCount: 2, p95Ms: 100, maximumMs: 100, samples: [] }, failures: [] },
  checkpoints: screenshots.map(item => ({ journeyId: "fixture-core-loop", checkpointId: item.id, status: "PASSED", screenshot: `screenshots/${item.id}.png` })),
};
const bundle = await createEvidenceBundle({
  outputRoot: directory, jobId: request.jobId, platform, report, screenshots,
  videos: [{ id: "fixture-gameplay", path: videoPath }], trajectories: [{ id: "adaptive-1", path: trajectoryPath }],
  regressions: [{ id: "current", path: regressionPath }],
});
const receipt = {
  schema: "deviludo.godot-guest-report", action: "test", jobId: request.jobId,
  inputDigest: input.object.sha256, outcome: "PASSED", failureDomain: null, summary,
  guest: { executor: "adaptive-e2e-fixture", isolation: "TEST_FIXED", exitCode: 0 },
  evidence: { schema: "deviludo.e2e-evidence", result: "PASSED", headlessCheckCount: 1,
    interactiveJourneyCount: 1, deterministicInputCount: 2, realInputCount: 8,
    keyboardMouseInputCount: 8, gamepadInputCount: 0, adaptiveRolloutCount: 3,
    adaptiveSuccessCount: 2, adaptiveDecisionCount: 6, coveredPlayerRequirementCount: 1,
    playerRequirementCount: 1, screenshotCount: 3, visualBaselineCount: 1, videoCount: 1,
    hasVisualDiff: false, regressionTraceDigest: `sha256:${createHash("sha256").update(regressionBytes).digest("hex")}`,
    frameRateSampleCount: 6, minimumFps: 60, p10Fps: 60, medianFps: 60,
    inputResponseSampleCount: 2, p95InputResponseMs: 100, maxInputResponseMs: 100,
    softwareRenderer: true, frameRateEnforced: false, performancePassed: true,
    testManifestDigest: request.testPlan?.testManifestDigest ?? `sha256:${"2".repeat(64)}`,
    regressionContractDigest: regression.contractDigest, regressionInputProfile: regression.inputProfile,
    regressionEstimatedDurationMs: regression.estimatedDurationMs,
    packageLaunchMode: platform === "macos" ? "MACOS_LAUNCH_SERVICES" : platform === "windows" ? "WINDOWS_FINAL_EXE" : "LINUX_RELEASE_EXECUTABLE" },
  outputPath: bundle.outputPath, outputSha256: bundle.outputSha256, outputSizeBytes: bundle.outputSizeBytes,
  regressionOutputPath: regressionPath,
  regressionOutputSha256: `sha256:${createHash("sha256").update(regressionBytes).digest("hex")}`,
  regressionOutputSizeBytes: regressionBytes.length,
};
process.stdout.write(`${JSON.stringify({ type: "result", value: receipt })}\n`);
