import assert from "node:assert/strict";
import test from "node:test";
import { pipelineStageFinishedAt } from "../components/ProjectStudio";
import type { ProductJob } from "../lib/product/contracts";

function job(state: string, updatedAt: string, targetOperatingSystem: string | null = null): ProductJob {
  return Object.freeze({
    id: `${state}-${targetOperatingSystem ?? "core"}`,
    kind: "E2E_TEST",
    poolKind: "E2E_MACOS",
    targetOperatingSystem,
    state,
    attempt: 1,
    lastError: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt,
  });
}

test("a completed pipeline stage displays the last platform finish time", () => {
  assert.equal(pipelineStageFinishedAt([
    job("SUCCEEDED", "2026-08-16T01:00:00.000Z", "linux"),
    job("SUCCEEDED", "2026-08-16T01:02:03.000Z", "macos"),
  ]), "2026-08-16T01:02:03.000Z");
});

test("a pipeline stage has no finish time while any platform is still active", () => {
  assert.equal(pipelineStageFinishedAt([
    job("SUCCEEDED", "2026-08-16T01:00:00.000Z", "linux"),
    job("RUNNING", "2026-08-16T01:02:03.000Z", "macos"),
  ]), null);
});

test("failed and cancelled terminal stages retain their finish time", () => {
  assert.equal(pipelineStageFinishedAt([
    job("FAILED", "2026-08-16T01:02:03.000Z"),
  ]), "2026-08-16T01:02:03.000Z");
  assert.equal(pipelineStageFinishedAt([
    job("CANCELLED", "2026-08-16T01:03:04.000Z"),
  ]), "2026-08-16T01:03:04.000Z");
});
