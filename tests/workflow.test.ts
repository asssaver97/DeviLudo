import assert from "node:assert/strict";
import test from "node:test";
import {
  initialWorkflowSnapshot,
  transitionWorkflow,
  type WorkflowSnapshot,
} from "@/services/core/src/workflow-state-machine";

const workflowId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const projectId = "10000000-0000-4000-8000-000000000003";

test("the deterministic workflow reaches a release decision and uploads Steam only when approved", () => {
  let snapshot: WorkflowSnapshot = initialWorkflowSnapshot(
    workflowId, workspaceId, projectId, "RELEASE", ["linux", "windows", "macos"],
  );
  let transition = transitionWorkflow(snapshot, { kind: "SPEC_APPROVED" });
  assert.deepEqual(transition.enqueue.map(command => command.jobKind), ["AGENT_GENERATION"]);
  snapshot = transition.snapshot;

  transition = transitionWorkflow(snapshot, {
    kind: "JOB_SUCCEEDED", jobId: "agent-job-1", jobKind: "AGENT_GENERATION", targetOperatingSystem: null,
    waitForAssets: true,
  });
  assert.equal(transition.snapshot.state, "ASSET_GENERATING");
  assert.deepEqual(transition.enqueue, []);
  transition = transitionWorkflow(transition.snapshot, {
    kind: "ASSETS_READY", predecessorJobId: "agent-job-1",
  });
  assert.deepEqual(transition.enqueue.map(command => command.jobKind), ["ARTIFACT_BUILD"]);
  snapshot = transition.snapshot;

  transition = transitionWorkflow(snapshot, {
    kind: "JOB_SUCCEEDED", jobId: "build-job-1", jobKind: "ARTIFACT_BUILD", targetOperatingSystem: null,
  });
  assert.deepEqual(transition.enqueue.map(command => command.poolKind), [
    "E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS",
  ]);
  snapshot = transition.snapshot;

  for (const operatingSystem of ["linux", "windows", "macos"] as const) {
    transition = transitionWorkflow(snapshot, {
      kind: "JOB_SUCCEEDED", jobId: `e2e-job-${operatingSystem}`, jobKind: "E2E_TEST", targetOperatingSystem: operatingSystem,
    });
    snapshot = transition.snapshot;
  }
  assert.equal(snapshot.state, "RELEASE_DECISION_PENDING");
  assert.deepEqual(transition.enqueue, []);

  transition = transitionWorkflow(snapshot, { kind: "RELEASE_APPROVED", approvalId: "approval-1" });
  snapshot = transition.snapshot;
  assert.equal(snapshot.state, "STEAM_PUBLISHING");
  assert.deepEqual(transition.enqueue.map(command => command.poolKind), ["CORE"]);
  assert.match(transition.enqueue[0].idempotencyKey, /:publish:approved:approval-1$/);

  transition = transitionWorkflow(snapshot, {
    kind: "JOB_SUCCEEDED", jobId: "publish-job-1", jobKind: "STEAM_PUBLISH", targetOperatingSystem: null,
  });
  assert.equal(transition.snapshot.state, "SUCCEEDED");
  assert.deepEqual(transition.enqueue, []);
});

test("local validation targets only macOS and can finish without publishing", () => {
  let snapshot = initialWorkflowSnapshot(workflowId, workspaceId, projectId, "VALIDATE", ["macos"]);
  snapshot = transitionWorkflow(snapshot, { kind: "SPEC_APPROVED" }).snapshot;
  snapshot = transitionWorkflow(snapshot, { kind: "JOB_SUCCEEDED", jobId: "agent-job-1", jobKind: "AGENT_GENERATION", targetOperatingSystem: null }).snapshot;
  const build = transitionWorkflow(snapshot, { kind: "JOB_SUCCEEDED", jobId: "build-job-1", jobKind: "ARTIFACT_BUILD", targetOperatingSystem: null });
  assert.deepEqual(build.enqueue.map(item => item.poolKind), ["E2E_MACOS"]);
  const complete = transitionWorkflow(build.snapshot, { kind: "JOB_SUCCEEDED", jobId: "e2e-job-macos", jobKind: "E2E_TEST", targetOperatingSystem: "macos" });
  assert.equal(complete.snapshot.state, "RELEASE_DECISION_PENDING");
  assert.deepEqual(complete.enqueue, []);
  const skipped = transitionWorkflow(complete.snapshot, { kind: "RELEASE_SKIPPED" });
  assert.equal(skipped.snapshot.state, "SUCCEEDED");
  assert.deepEqual(skipped.enqueue, []);
});

test("rerunning a stage reopens a terminal workflow and enqueues only that stage", () => {
  let snapshot = initialWorkflowSnapshot(workflowId, workspaceId, projectId, "VALIDATE", ["macos"]);
  snapshot = transitionWorkflow(snapshot, { kind: "SPEC_APPROVED" }).snapshot;
  snapshot = transitionWorkflow(snapshot, { kind: "JOB_SUCCEEDED", jobId: "agent-job-1", jobKind: "AGENT_GENERATION", targetOperatingSystem: null }).snapshot;
  snapshot = transitionWorkflow(snapshot, { kind: "JOB_SUCCEEDED", jobId: "build-job-1", jobKind: "ARTIFACT_BUILD", targetOperatingSystem: null }).snapshot;
  snapshot = transitionWorkflow(snapshot, { kind: "JOB_SUCCEEDED", jobId: "e2e-job-macos", jobKind: "E2E_TEST", targetOperatingSystem: "macos" }).snapshot;
  snapshot = transitionWorkflow(snapshot, { kind: "RELEASE_SKIPPED" }).snapshot;
  assert.equal(snapshot.state, "SUCCEEDED");
  assert.deepEqual(snapshot.completedE2e, ["macos"]);

  // A succeeded run is rerunnable: this is how uploaded assets get built in.
  const rerun = transitionWorkflow(snapshot, {
    kind: "STAGE_RERUN_REQUESTED", stage: "ARTIFACT_BUILD", signalId: "signal-1",
  });
  assert.equal(rerun.snapshot.state, "ARTIFACT_BUILDING");
  assert.deepEqual(rerun.enqueue.map(command => command.jobKind), ["ARTIFACT_BUILD"]);
  // E2E is downstream of the build, so its platform progress is invalidated.
  assert.deepEqual(rerun.snapshot.completedE2e, []);
  assert.match(rerun.enqueue[0].idempotencyKey, /:rerun:ARTIFACT_BUILD:all:signal-1$/);

  // The chain then advances normally from the rerun point.
  const advanced = transitionWorkflow(rerun.snapshot, {
    kind: "JOB_SUCCEEDED", jobId: "rerun-build-job", jobKind: "ARTIFACT_BUILD", targetOperatingSystem: null,
  });
  assert.deepEqual(advanced.enqueue.map(command => command.poolKind), ["E2E_MACOS"]);
  assert.match(advanced.enqueue[0].idempotencyKey, /:e2e:macos:after:rerun-build-job$/);
});

test("rerunning unresolved assets reopens the gate and resumes through build and E2E", () => {
  const succeeded: WorkflowSnapshot = Object.freeze({
    ...initialWorkflowSnapshot(workflowId, workspaceId, projectId, "VALIDATE", ["macos"]),
    state: "SUCCEEDED",
    completedE2e: Object.freeze(["macos"] as const),
  });
  const assets = transitionWorkflow(succeeded, { kind: "ASSET_RERUN_REQUESTED" });
  assert.equal(assets.snapshot.state, "ASSET_GENERATING");
  assert.deepEqual(assets.snapshot.completedE2e, []);
  assert.deepEqual(assets.enqueue, []);

  const build = transitionWorkflow(assets.snapshot, {
    kind: "ASSETS_READY", predecessorJobId: "asset-rerun-signal-1",
  });
  assert.equal(build.snapshot.state, "ARTIFACT_BUILDING");
  assert.deepEqual(build.enqueue.map(command => command.jobKind), ["ARTIFACT_BUILD"]);
  const e2e = transitionWorkflow(build.snapshot, {
    kind: "JOB_SUCCEEDED", jobId: "rebuilt-with-assets", jobKind: "ARTIFACT_BUILD", targetOperatingSystem: null,
  });
  assert.equal(e2e.snapshot.state, "E2E_TESTING");
  assert.deepEqual(e2e.enqueue.map(command => command.jobKind), ["E2E_TEST"]);
});

test("rerunning a per-platform stage fans out across every target platform", () => {
  let snapshot = initialWorkflowSnapshot(workflowId, workspaceId, projectId, "RELEASE", ["linux", "windows", "macos"]);
  snapshot = transitionWorkflow(snapshot, { kind: "SPEC_APPROVED" }).snapshot;
  snapshot = transitionWorkflow(snapshot, { kind: "JOB_FAILED", jobKind: "AGENT_GENERATION", reason: "boom" }).snapshot;
  assert.equal(snapshot.state, "FAILED");

  const rerun = transitionWorkflow(snapshot, {
    kind: "STAGE_RERUN_REQUESTED", stage: "E2E_TEST", signalId: "signal-2",
  });
  assert.equal(rerun.snapshot.state, "E2E_TESTING");
  assert.deepEqual(rerun.enqueue.map(command => command.poolKind), ["E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS"]);
  assert.equal(new Set(rerun.enqueue.map(command => command.idempotencyKey)).size, 3);
});

test("stage rerun rejects retired stages and non-terminal workflows", () => {
  const validating = transitionWorkflow(
    initialWorkflowSnapshot(workflowId, workspaceId, projectId, "VALIDATE", ["macos"]),
    { kind: "JOB_FAILED", jobKind: "AGENT_GENERATION", reason: "boom" },
  ).snapshot;
  assert.throws(
    () => transitionWorkflow(validating, { kind: "STAGE_RERUN_REQUESTED", stage: "ARTIFACT_SIGN" as never, signalId: "s" }),
    /not part of the VALIDATE delivery chain/,
  );

  const running = transitionWorkflow(
    initialWorkflowSnapshot(workflowId, workspaceId, projectId, "VALIDATE", ["macos"]),
    { kind: "SPEC_APPROVED" },
  ).snapshot;
  assert.equal(running.state, "AGENT_RUNNING");
  assert.throws(
    () => transitionWorkflow(running, { kind: "STAGE_RERUN_REQUESTED", stage: "AGENT_GENERATION", signalId: "s" }),
    /requires a terminal workflow/,
  );
});

test("cancellation is terminal and does not enqueue more work", () => {
  const snapshot = transitionWorkflow(
    initialWorkflowSnapshot(workflowId, workspaceId, projectId),
    { kind: "SPEC_APPROVED" },
  ).snapshot;
  const cancelled = transitionWorkflow(snapshot, { kind: "CANCEL_REQUESTED" });
  assert.equal(cancelled.snapshot.state, "CANCELLED");
  assert.deepEqual(cancelled.enqueue, []);
});
