import assert from "node:assert/strict";
import test from "node:test";
import {
  currentPipelineJobs,
  pipelineEventFinishedAt,
  pipelineStageFinishedAt,
  pipelineStageWaitsForPredecessor,
} from "../components/ProjectStudio";
import type { ProductEvent, ProductJob } from "../lib/product/contracts";

function job(state: string, updatedAt: string, targetOperatingSystem: string | null = null): ProductJob {
  return Object.freeze({
    id: `${state}-${targetOperatingSystem ?? "core"}`,
    kind: "E2E_PLATFORM_RUN",
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

test("superseded attempts are excluded from the current pipeline stage", () => {
  const superseded = {
    ...job("CANCELLED", "2026-08-16T01:03:04.000Z", "macos"),
    lastError: "superseded by stage rerun from BUILD",
  };
  const explicitlyCancelled = job("CANCELLED", "2026-08-16T01:04:05.000Z", "linux");
  assert.deepEqual(currentPipelineJobs([superseded, explicitlyCancelled]), [explicitlyCancelled]);
});

test("stages after the active delivery stage wait for their predecessor", () => {
  assert.equal(pipelineStageWaitsForPredecessor("E2E_PLATFORM_RUN", "BUILDING"), true);
  assert.equal(pipelineStageWaitsForPredecessor("STEAM_PUBLISH", "BUILDING"), true);
  assert.equal(pipelineStageWaitsForPredecessor("BUILD", "BUILDING"), false);
  assert.equal(pipelineStageWaitsForPredecessor("E2E_PLATFORM_RUN", "TESTING"), false);
  assert.equal(pipelineStageWaitsForPredecessor("E2E_PLATFORM_RUN", "FAILED"), false);
});

test("the requirements or analysis node uses the latest approval event as its finish time", () => {
  const events: ProductEvent[] = [
    { id: "linked", kind: "PROJECT_LINKED", data: {}, createdAt: "2026-08-16T00:00:00.000Z" },
    { id: "approved-1", kind: "SPEC_APPROVED", data: {}, createdAt: "2026-08-16T01:00:00.000Z" },
    { id: "approved-2", kind: "SPEC_APPROVED", data: {}, createdAt: "2026-08-16T01:03:04.000Z" },
  ];
  assert.equal(pipelineEventFinishedAt(events, "SPEC_APPROVED"), "2026-08-16T01:03:04.000Z");
  assert.equal(pipelineEventFinishedAt(events, "JOB_SUCCEEDED"), null);
});
