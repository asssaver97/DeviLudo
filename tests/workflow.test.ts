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

test("the workflow runs Design, Development, Build, Test plan, every platform and Test verdict", () => {
  const snapshot = initialWorkflowSnapshot(
    workflowId, workspaceId, projectId, "RELEASE", ["linux", "windows", "macos"],
  );
  let transition = transitionWorkflow(snapshot, { kind: "SPEC_APPROVED" });
  assert.deepEqual(transition.enqueue.map(job => [job.agentRole, job.purpose]), [["DESIGN", "DESIGN"]]);

  transition = transitionWorkflow(transition.snapshot, agentSuccess("design-1", "DESIGN", "DESIGN"));
  assert.equal(transition.snapshot.state, "DEVELOPING");
  assert.deepEqual(transition.enqueue.map(job => [job.agentRole, job.purpose]), [["DEVELOPMENT", "DEVELOPMENT"]]);

  transition = transitionWorkflow(transition.snapshot, agentSuccess("development-1", "DEVELOPMENT", "DEVELOPMENT"));
  assert.equal(transition.snapshot.state, "BUILDING");
  assert.deepEqual(transition.enqueue.map(job => job.jobKind), ["BUILD"]);

  transition = transitionWorkflow(transition.snapshot, jobSuccess("build-1", "BUILD"));
  assert.equal(transition.snapshot.state, "TEST_PLANNING");
  assert.deepEqual(transition.enqueue.map(job => [job.agentRole, job.purpose]), [["TEST", "TEST_PLAN"]]);

  transition = transitionWorkflow(transition.snapshot, agentSuccess("test-plan-1", "TEST", "TEST_PLAN"));
  assert.equal(transition.snapshot.state, "TESTING");
  assert.deepEqual(transition.enqueue.map(job => job.poolKind), ["E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS"]);

  for (const platform of ["linux", "windows", "macos"] as const) {
    transition = transitionWorkflow(transition.snapshot, {
      kind: "JOB_SUCCEEDED",
      jobId: `e2e-${platform}`,
      jobKind: "E2E_PLATFORM_RUN",
      targetOperatingSystem: platform,
    });
  }
  assert.equal(transition.snapshot.state, "TEST_PLANNING");
  assert.deepEqual(transition.enqueue.map(job => [job.agentRole, job.purpose]), [["TEST", "TEST_VERDICT"]]);

  transition = transitionWorkflow(transition.snapshot, agentSuccess("test-verdict-1", "TEST", "TEST_VERDICT"));
  assert.equal(transition.snapshot.state, "RELEASE_APPROVAL_PENDING");
  assert.deepEqual(transition.enqueue, []);

  transition = transitionWorkflow(transition.snapshot, { kind: "RELEASE_APPROVED", approvalId: "approval-1" });
  assert.equal(transition.snapshot.state, "STEAM_PUBLISHING");
  assert.deepEqual(transition.enqueue.map(job => job.jobKind), ["STEAM_PUBLISH"]);

  transition = transitionWorkflow(transition.snapshot, jobSuccess("publish-1", "STEAM_PUBLISH"));
  assert.equal(transition.snapshot.state, "SUCCEEDED");
});

test("validation can stop at manual release approval without publishing", () => {
  const releasePending = reachReleasePending(
    initialWorkflowSnapshot(workflowId, workspaceId, projectId, "VALIDATE", ["macos"]),
  );
  const skipped = transitionWorkflow(releasePending, { kind: "RELEASE_SKIPPED" });
  assert.equal(skipped.snapshot.state, "SUCCEEDED");
  assert.deepEqual(skipped.enqueue, []);
});

test("rerunning Build invalidates platform results and returns through Test planning", () => {
  const succeeded = transitionWorkflow(
    reachReleasePending(initialWorkflowSnapshot(workflowId, workspaceId, projectId, "VALIDATE", ["macos"])),
    { kind: "RELEASE_SKIPPED" },
  ).snapshot;
  assert.deepEqual(succeeded.completedE2e, ["macos"]);

  let transition = transitionWorkflow(succeeded, {
    kind: "STAGE_RERUN_REQUESTED", stage: "BUILD", signalId: "signal-1",
  });
  assert.equal(transition.snapshot.state, "BUILDING");
  assert.deepEqual(transition.snapshot.completedE2e, []);
  assert.deepEqual(transition.enqueue.map(job => job.jobKind), ["BUILD"]);

  transition = transitionWorkflow(transition.snapshot, jobSuccess("build-rerun", "BUILD"));
  assert.equal(transition.snapshot.state, "TEST_PLANNING");
  assert.deepEqual(transition.enqueue.map(job => job.purpose), ["TEST_PLAN"]);

  transition = transitionWorkflow(transition.snapshot, agentSuccess("plan-rerun", "TEST", "TEST_PLAN"));
  assert.deepEqual(transition.enqueue.map(job => job.poolKind), ["E2E_MACOS"]);
});

test("asset readiness feeds Builder and then a new complete Test plan", () => {
  const succeeded: WorkflowSnapshot = Object.freeze({
    ...initialWorkflowSnapshot(workflowId, workspaceId, projectId, "VALIDATE", ["macos"]),
    state: "SUCCEEDED",
    completedE2e: Object.freeze(["macos"] as const),
  });
  let transition = transitionWorkflow(succeeded, { kind: "ASSET_RERUN_REQUESTED" });
  assert.equal(transition.snapshot.state, "DEVELOPING");
  assert.deepEqual(transition.snapshot.completedE2e, []);

  transition = transitionWorkflow(transition.snapshot, {
    kind: "ASSETS_READY", predecessorJobId: "assets-1",
  });
  assert.equal(transition.snapshot.state, "BUILDING");

  transition = transitionWorkflow(transition.snapshot, jobSuccess("build-assets", "BUILD"));
  assert.equal(transition.snapshot.state, "TEST_PLANNING");
  assert.deepEqual(transition.enqueue.map(job => [job.agentRole, job.purpose]), [["TEST", "TEST_PLAN"]]);
});

test("an E2E rerun fans out to every configured platform", () => {
  const failed = transitionWorkflow(
    initialWorkflowSnapshot(workflowId, workspaceId, projectId, "RELEASE", ["linux", "windows", "macos"]),
    { kind: "JOB_FAILED", jobKind: "BUILD", reason: "failed" },
  ).snapshot;
  const rerun = transitionWorkflow(failed, {
    kind: "STAGE_RERUN_REQUESTED", stage: "E2E_PLATFORM_RUN", signalId: "signal-2",
  });
  assert.equal(rerun.snapshot.state, "TESTING");
  assert.deepEqual(rerun.enqueue.map(job => job.poolKind), ["E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS"]);
  assert.equal(new Set(rerun.enqueue.map(job => job.idempotencyKey)).size, 3);
});

test("stage reruns require a valid stage and terminal workflow", () => {
  const failed = transitionWorkflow(
    initialWorkflowSnapshot(workflowId, workspaceId, projectId, "VALIDATE", ["macos"]),
    { kind: "JOB_FAILED", jobKind: "BUILD", reason: "failed" },
  ).snapshot;
  assert.throws(
    () => transitionWorkflow(failed, { kind: "STAGE_RERUN_REQUESTED", stage: "UNKNOWN" as never, signalId: "s" }),
    /not part of the VALIDATE delivery chain/,
  );
  const running = transitionWorkflow(
    initialWorkflowSnapshot(workflowId, workspaceId, projectId, "VALIDATE", ["macos"]),
    { kind: "SPEC_APPROVED" },
  ).snapshot;
  assert.throws(
    () => transitionWorkflow(running, { kind: "STAGE_RERUN_REQUESTED", stage: "AGENT_TURN", signalId: "s" }),
    /requires a terminal workflow/,
  );
  const blocked = Object.freeze({ ...running, state: "BLOCKED" as const });
  const restarted = transitionWorkflow(blocked, {
    kind: "STAGE_RERUN_REQUESTED", stage: "E2E_PLATFORM_RUN", signalId: "blocked-rerun",
  });
  assert.equal(restarted.snapshot.state, "TESTING");
  assert.equal(restarted.enqueue.length, 1);
});

test("cancellation is terminal and enqueues no work", () => {
  const running = transitionWorkflow(
    initialWorkflowSnapshot(workflowId, workspaceId, projectId),
    { kind: "SPEC_APPROVED" },
  ).snapshot;
  const cancelled = transitionWorkflow(running, { kind: "CANCEL_REQUESTED" });
  assert.equal(cancelled.snapshot.state, "CANCELLED");
  assert.deepEqual(cancelled.enqueue, []);
});

function reachReleasePending(initial: WorkflowSnapshot): WorkflowSnapshot {
  let transition = transitionWorkflow(initial, { kind: "SPEC_APPROVED" });
  transition = transitionWorkflow(transition.snapshot, agentSuccess("design", "DESIGN", "DESIGN"));
  transition = transitionWorkflow(transition.snapshot, agentSuccess("development", "DEVELOPMENT", "DEVELOPMENT"));
  transition = transitionWorkflow(transition.snapshot, jobSuccess("build", "BUILD"));
  transition = transitionWorkflow(transition.snapshot, agentSuccess("plan", "TEST", "TEST_PLAN"));
  for (const platform of initial.targetPlatforms) {
    transition = transitionWorkflow(transition.snapshot, {
      kind: "JOB_SUCCEEDED", jobId: `e2e-${platform}`,
      jobKind: "E2E_PLATFORM_RUN", targetOperatingSystem: platform,
    });
  }
  transition = transitionWorkflow(transition.snapshot, agentSuccess("verdict", "TEST", "TEST_VERDICT"));
  return transition.snapshot;
}

function agentSuccess(
  jobId: string,
  agentRole: "DESIGN" | "DEVELOPMENT" | "TEST",
  purpose: "DESIGN" | "DEVELOPMENT" | "TEST_PLAN" | "TEST_VERDICT",
) {
  return {
    kind: "JOB_SUCCEEDED" as const,
    jobId,
    jobKind: "AGENT_TURN" as const,
    agentRole,
    purpose,
    targetOperatingSystem: null,
  };
}

function jobSuccess(jobId: string, jobKind: "BUILD" | "STEAM_PUBLISH") {
  return { kind: "JOB_SUCCEEDED" as const, jobId, jobKind, targetOperatingSystem: null };
}
