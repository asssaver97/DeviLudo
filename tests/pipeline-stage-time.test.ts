import assert from "node:assert/strict";
import test from "node:test";
import {
  currentPipelineJobs,
  pipelineJobsForStage,
  pipelineEventFinishedAt,
  pipelineStageFinishedAt,
  pipelineStageWaitsForPredecessor,
  runningAgentJobForConversation,
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
  assert.equal(pipelineStageWaitsForPredecessor("BUILD", "TEST_PLANNING"), false);
  assert.equal(pipelineStageWaitsForPredecessor("E2E_PLATFORM_RUN", "TEST_PLANNING"), false);
  assert.equal(pipelineStageWaitsForPredecessor("E2E_PLATFORM_RUN", "TESTING"), false);
  assert.equal(pipelineStageWaitsForPredecessor("E2E_PLATFORM_RUN", "FAILED"), false);
});

test("Design roles have dedicated nodes while Development and Test project onto their execution stages", () => {
  const design = { ...job("SUCCEEDED", "2026-08-16T01:00:00.000Z"), id: "design", kind: "AGENT_TURN", agentRole: "DESIGN" as const };
  const uiDesign = { ...job("SUCCEEDED", "2026-08-16T01:00:30.000Z"), id: "ui-design", kind: "AGENT_TURN", agentRole: "UI_DESIGN" as const };
  const development = { ...job("SUCCEEDED", "2026-08-16T01:01:00.000Z"), id: "development", kind: "AGENT_TURN", agentRole: "DEVELOPMENT" as const };
  const testPlan = { ...job("RUNNING", "2026-08-16T01:02:00.000Z"), id: "test-plan", kind: "AGENT_TURN", agentRole: "TEST" as const };
  const e2e = { ...job("QUEUED", "2026-08-16T01:03:00.000Z", "macos"), id: "e2e" };
  const jobs = [design, uiDesign, development, testPlan, e2e];

  assert.deepEqual(pipelineJobsForStage("GAME_DESIGN", jobs).map(item => item.id), ["design"]);
  assert.deepEqual(pipelineJobsForStage("UI_DESIGN", jobs).map(item => item.id), ["ui-design"]);
  assert.deepEqual(pipelineJobsForStage("AGENT_TURN", jobs).map(item => item.id), ["development"]);
  assert.deepEqual(pipelineJobsForStage("E2E_PLATFORM_RUN", jobs).map(item => item.id), ["test-plan", "e2e"]);
});

test("a started Agent remains visible while retrying or failed but a never-started queued Agent stays hidden", () => {
  const development = { ...job("RUNNING", "2026-08-16T01:01:00.000Z"), id: "development", kind: "AGENT_TURN", agentRole: "DEVELOPMENT" as const };
  const queuedTest = { ...job("QUEUED", "2026-08-16T01:02:00.000Z"), id: "test-plan", kind: "AGENT_TURN", agentRole: "TEST" as const };
  const retryTest = { ...job("RETRY", "2026-08-16T01:03:00.000Z"), id: "retry-test", kind: "AGENT_TURN", agentRole: "TEST" as const };
  const failedTest = { ...job("FAILED", "2026-08-16T01:04:00.000Z"), id: "failed-test", kind: "AGENT_TURN", agentRole: "TEST" as const };
  const succeededTest = { ...job("SUCCEEDED", "2026-08-16T01:05:00.000Z"), id: "succeeded-test", kind: "AGENT_TURN", agentRole: "TEST" as const };

  assert.equal(runningAgentJobForConversation([development, queuedTest])?.id, "development");
  assert.equal(runningAgentJobForConversation([retryTest])?.id, "retry-test");
  assert.equal(runningAgentJobForConversation([failedTest])?.id, "failed-test");
  assert.equal(runningAgentJobForConversation([failedTest, succeededTest]), null);
  assert.equal(runningAgentJobForConversation([queuedTest]), null);
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
