import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGodotFpsSamples, summarizeE2ePerformance } from "../scripts/e2e-performance.mjs";

const responses = [
  { runId: "core", stepId: "start", source: "DETERMINISTIC", latencyMs: 90 },
  { runId: "core", stepId: "finish", source: "DETERMINISTIC", latencyMs: 140 },
];

test("parses Godot release --print-fps output", () => {
  assert.deepEqual(parseGodotFpsSamples([
    "Godot Engine v4",
    "Project FPS: 60 (16.67 mspf)",
    "FPS: 47",
    "Project FPS: invalid",
  ].join("\n")), [
    { fps: 60, mspf: 16.67 },
    { fps: 47, mspf: null },
  ]);
});

test("smooth exported gameplay passes the fixed performance gate after warmup", () => {
  const result = summarizeE2ePerformance({
    frameRateRuns: [
      { runId: "core-primary", samples: [2, 60, 59, 58] },
      { runId: "adaptive-1", samples: [5, 60, 55, 58] },
    ],
    inputResponses: responses,
  });
  assert.equal(result.passed, true);
  assert.equal(result.frameRate.sampleCount, 6);
  assert.equal(result.frameRate.minimumFps, 55);
});

test("sustained low frame rate is a product stutter failure", () => {
  const result = summarizeE2ePerformance({
    frameRateRuns: [{ runId: "core", samples: [60, 18, 17, 19, 16, 18, 17] }],
    inputResponses: responses,
  });
  assert.equal(result.passed, false);
  assert.equal(result.failures[0].code, "GAME_STUTTER_DETECTED");
  assert.equal(result.frameRate.medianFps, 17);
});

test("slow native-input response is a product stutter failure", () => {
  const result = summarizeE2ePerformance({
    frameRateRuns: [{ runId: "core", samples: [60, 60, 60, 60, 60, 60] }],
    inputResponses: [responses[0], { ...responses[1], latencyMs: 3_100 }],
  });
  assert.equal(result.passed, false);
  assert.equal(result.failures[0].code, "GAME_STUTTER_DETECTED");
  assert.equal(result.inputResponse.maximumMs, 3_100);
});

test("missing real runtime samples fails closed", () => {
  const result = summarizeE2ePerformance({
    frameRateRuns: [{ runId: "too-short", samples: [60, 60] }],
    inputResponses: responses.slice(0, 1),
  });
  assert.equal(result.passed, false);
  assert.equal(result.failures[0].code, "PERFORMANCE_EVIDENCE_MISSING");
});
