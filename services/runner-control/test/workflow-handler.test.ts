import assert from "node:assert/strict";
import test from "node:test";
import type { DeliverySnapshot } from "../../temporal/src/contracts";
import type { ClaimedWorkflowJob } from "../../temporal/src/postgres-queue";
import { RunnerControlWorkflowHandler, type RunnerWorkflowReceipt } from "../src/workflow-handler";

const base: DeliverySnapshot = Object.freeze({
  workflowId: "delivery-001", tenantId: "tenant-001", projectId: "project-001",
  state: "CROSS_PLATFORM_E2E", specRevisionId: "spec-r1", lockedRunConfigurationId: "lock-r1",
  runId: "run-001", candidateCommitSha: "a".repeat(40), draftPullRequest: 91, mainCommitSha: null,
  evidenceBundleId: null, candidateEvidenceBundleId: null, mainEvidenceBundleId: null,
  steamInstallEvidenceBundleId: null, mfaApprovalId: null, steamBuildId: null,
  steamReleaseId: null, defaultBranchBuildId: null,
  targetMatrix: Object.freeze(["linux", "macos", "windows"] as const), iteration: 1, repairAttempts: 0,
  waitingProviderRevisionId: null, externalGate: null, externalApprovals: Object.freeze([]), history: Object.freeze([]),
});

function job(snapshot: DeliverySnapshot, operation: "START_TARGET_MATRIX_E2E" | "START_MAIN_SHA_RELEASE_GATE" | "INSTALL_FROM_CLEAN_STEAM_CLIENT"): ClaimedWorkflowJob {
  const request = { kind: "COMMAND", destination: "runner-control", payload: {
    idempotencyKey: `delivery-001:1:${snapshot.state}:${operation}`, workflowId: snapshot.workflowId,
    tenantId: snapshot.tenantId, projectId: snapshot.projectId, destination: "runner-control", command: operation, snapshot,
  } } as const;
  return Object.freeze({
    id: "11111111-1111-4111-8111-111111111111", tenantId: snapshot.tenantId, projectId: snapshot.projectId,
    workflowId: snapshot.workflowId, destination: "runner-control", operation, requestDigest: "b".repeat(64), request,
    attempt: 1, claimToken: "22222222-2222-4222-8222-222222222222", claimExpiresAt: "2099-01-01T00:10:00.000Z",
  });
}

function receipt(overrides: Partial<RunnerWorkflowReceipt> = {}): RunnerWorkflowReceipt {
  return {
    receiptId: "runner-receipt-1", attemptId: "runner-attempt-1", mode: "CANDIDATE", status: "PASSED",
    commitSha: "a".repeat(40), steamBuildId: null, targetMatrix: base.targetMatrix,
    evidenceBundleId: "evidence-bundle-1", repairPromptId: null, ...overrides,
  };
}

test("Runner workflow handler turns candidate matrix evidence into pass or repair signals", async () => {
  let response = receipt();
  const handler = new RunnerControlWorkflowHandler({ async execute(input) {
    assert.equal(input.mode, "CANDIDATE");
    assert.equal(input.draftPullRequest, 91);
    return response;
  } });
  const passed = await handler.execute(job(base, "START_TARGET_MATRIX_E2E"), { async heartbeat() { return "ok"; }, async emitSignal() { return "unused"; } });
  assert.deepEqual(passed.signal, { type: "E2E_PASSED", evidenceBundleId: "evidence-bundle-1" });
  response = receipt({ status: "FAILED", evidenceBundleId: "failed-evidence-1", repairPromptId: "repair-prompt-1" });
  const failed = await handler.execute(job(base, "START_TARGET_MATRIX_E2E"), { async heartbeat() { return "ok"; }, async emitSignal() { return "unused"; } });
  assert.deepEqual(failed.signal, { type: "E2E_FAILED", evidenceBundleId: "failed-evidence-1", repairPromptId: "repair-prompt-1" });
});

test("Runner workflow handler gates main SHA and Steam clean-install evidence separately", async () => {
  const main = Object.freeze({ ...base, state: "MAIN_SHA_E2E" as const, mainCommitSha: "c".repeat(40) });
  const steam = Object.freeze({ ...main, state: "STEAM_INSTALL_E2E" as const, steamBuildId: "91234567" });
  const handler = new RunnerControlWorkflowHandler({ async execute(input) {
    return receipt({
      mode: input.mode, commitSha: input.commitSha, steamBuildId: input.steamBuildId,
      targetMatrix: input.targetMatrix, evidenceBundleId: `${input.mode.toLowerCase()}-evidence`,
    });
  } });
  const mainResult = await handler.execute(job(main, "START_MAIN_SHA_RELEASE_GATE"), { async heartbeat() { return "ok"; }, async emitSignal() { return "unused"; } });
  assert.deepEqual(mainResult.signal, { type: "E2E_PASSED", evidenceBundleId: "main_release_gate-evidence" });
  const steamResult = await handler.execute(job(steam, "INSTALL_FROM_CLEAN_STEAM_CLIENT"), { async heartbeat() { return "ok"; }, async emitSignal() { return "unused"; } });
  assert.deepEqual(steamResult.signal, { type: "STEAM_INSTALL_PASSED", evidenceBundleId: "steam_clean_install-evidence" });

  const failing = new RunnerControlWorkflowHandler({ async execute(input) {
    return receipt({ mode: input.mode, status: "FAILED", commitSha: input.commitSha, steamBuildId: input.steamBuildId,
      targetMatrix: input.targetMatrix, evidenceBundleId: "main-failed-evidence", repairPromptId: "main-failure-diagnostic" });
  } });
  await assert.rejects(failing.execute(job(main, "START_MAIN_SHA_RELEASE_GATE"), { async heartbeat() { return "ok"; }, async emitSignal() { return "unused"; } }), /MAIN_SHA_E2E_FAILED/);
});
