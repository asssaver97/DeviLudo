import assert from "node:assert/strict";
import test from "node:test";
import type { DeliverySnapshot } from "../../temporal/src/contracts";
import type { ClaimedWorkflowJob } from "../../temporal/src/postgres-queue";
import { SteamPublisherWorkflowHandler } from "../src/workflow-handler";

const baseSnapshot: DeliverySnapshot = Object.freeze({
  workflowId: "delivery-release-9",
  tenantId: "tenant-north-dock",
  projectId: "project-ember",
  state: "STEAM_PRIVATE_BETA",
  specRevisionId: "spec-9",
  testPlanRevisionId: "plan-9",
  specApprovalReceiptId: "spec-approval-9",
  lockedRunConfigurationId: "lock-9",
  runId: "run-9",
  candidateCommitSha: "1".repeat(40),
  draftPullRequest: 91,
  mainCommitSha: "a".repeat(40),
  evidenceBundleId: "main-evidence-9",
  candidateEvidenceBundleId: "candidate-evidence-9",
  mainEvidenceBundleId: "main-evidence-9",
  steamInstallEvidenceBundleId: null,
  mfaApprovalId: "mfa-approval-9",
  steamBuildId: null,
  steamReleaseId: null,
  defaultBranchBuildId: null,
  targetMatrix: Object.freeze(["windows", "linux", "macos"] as const),
  iteration: 1,
  repairAttempts: 0,
  waitingProviderRevisionId: null,
  externalGate: null,
  externalApprovals: Object.freeze([]),
  history: Object.freeze([]),
});

function job(snapshot: DeliverySnapshot, operation: "UPLOAD_AND_ACTIVATE_PRIVATE_BETA" | "PUBLISH_STEAM_DEFAULT_BRANCH"): ClaimedWorkflowJob {
  const request = { kind: "COMMAND", destination: "steam-publisher", payload: {
    idempotencyKey: `${snapshot.workflowId}:9:${snapshot.state}:${operation}`,
    workflowId: snapshot.workflowId,
    tenantId: snapshot.tenantId,
    projectId: snapshot.projectId,
    destination: "steam-publisher",
    command: operation,
    snapshot,
  } } as const;
  return Object.freeze({
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: snapshot.tenantId,
    projectId: snapshot.projectId,
    workflowId: snapshot.workflowId,
    destination: "steam-publisher",
    operation,
    requestDigest: "b".repeat(64),
    request,
    attempt: 1,
    claimToken: "22222222-2222-4222-8222-222222222222",
    claimExpiresAt: "2099-01-01T00:10:00.000Z",
  });
}

test("Steam workflow handler resolves private Beta inputs from the bound snapshot and emits BuildID", async () => {
  let heartbeats = 0;
  const handler = new SteamPublisherWorkflowHandler({
    async upload(input) {
      assert.equal(input.operationKey, "workflow-job:11111111-1111-4111-8111-111111111111");
      assert.equal(input.mainCommitSha, baseSnapshot.mainCommitSha);
      assert.equal(input.mfaApprovalId, baseSnapshot.mfaApprovalId);
      return { buildId: "91234567", receiptId: "steam-beta-receipt-9", runId: input.runId,
        mainCommitSha: input.mainCommitSha, mainEvidenceBundleId: input.mainEvidenceBundleId,
        mfaApprovalId: input.mfaApprovalId, targetMatrix: input.targetMatrix };
    },
  }, { async publish() { throw new Error("must not publish"); } });
  const outcome = await handler.execute(job(baseSnapshot, "UPLOAD_AND_ACTIVATE_PRIVATE_BETA"), { async heartbeat() { heartbeats += 1; return "2099-01-01T00:10:00.000Z"; } });
  assert.deepEqual(outcome.signal, { type: "BETA_ACTIVATED", buildId: "91234567" });
  assert.equal(heartbeats, 1);
});

test("Steam workflow handler promotes only the same fully approved and install-tested BuildID", async () => {
  const ready: DeliverySnapshot = Object.freeze({
    ...baseSnapshot,
    state: "READY_TO_PUBLISH",
    steamBuildId: "91234567",
    steamInstallEvidenceBundleId: "steam-install-evidence-9",
    externalApprovals: Object.freeze([
      { gate: "VALVE_REVIEW", approvalId: "approval-valve-9" },
      { gate: "FIRST_RELEASE", approvalId: "approval-first-9" },
      { gate: "DEFAULT_BRANCH_CONFIRMATION", approvalId: "approval-default-9" },
    ] as const),
  });
  const handler = new SteamPublisherWorkflowHandler({ async upload() { throw new Error("must not upload"); } }, {
    async publish(input) {
      assert.equal(input.betaBuildId, ready.steamBuildId);
      assert.deepEqual(input.externalApprovalIds, ["approval-valve-9", "approval-first-9", "approval-default-9"]);
      return { releaseId: "steam-release-9", runId: input.runId, betaBuildId: input.betaBuildId,
        defaultBranchBuildId: "91234567", receiptId: "steam-release-receipt-9",
        externalApprovalIds: input.externalApprovalIds };
    },
  });
  const outcome = await handler.execute(job(ready, "PUBLISH_STEAM_DEFAULT_BRANCH"), { async heartbeat() { return "2099-01-01T00:10:00.000Z"; } });
  assert.deepEqual(outcome.signal, { type: "STEAM_RELEASED", releaseId: "steam-release-9", defaultBranchBuildId: "91234567" });

  const drifted = new SteamPublisherWorkflowHandler({ async upload() { throw new Error("must not upload"); } }, {
    async publish(input) { return { releaseId: "steam-release-10", runId: input.runId, betaBuildId: input.betaBuildId,
      defaultBranchBuildId: "99999999", receiptId: "steam-release-receipt-10",
      externalApprovalIds: input.externalApprovalIds }; },
  });
  await assert.rejects(drifted.execute(job(ready, "PUBLISH_STEAM_DEFAULT_BRANCH"), { async heartbeat() { return "2099-01-01T00:10:00.000Z"; } }), /tested BuildID/);
});
