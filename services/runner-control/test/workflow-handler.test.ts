import assert from "node:assert/strict";
import test from "node:test";
import type { DeliverySnapshot } from "../../temporal/src/contracts";
import type { ClaimedWorkflowJob } from "../../temporal/src/postgres-queue";
import { RunnerControlWorkflowHandler, type RunnerWorkflowReceipt } from "../src/workflow-handler";

const base: DeliverySnapshot = Object.freeze({
  workflowId: "delivery-001", tenantId: "tenant-001", projectId: "project-001",
  state: "CROSS_PLATFORM_E2E", specRevisionId: "spec-r1", lockedRunConfigurationId: "lock-r1",
  testPlanRevisionId: "plan-r1", specApprovalReceiptId: "spec-approval-r1",
  runId: "run-001", candidateCommitSha: "a".repeat(40), draftPullRequest: 91, mainCommitSha: null,
  evidenceBundleId: null, candidateEvidenceBundleId: null, mainEvidenceBundleId: null,
  steamInstallEvidenceBundleId: null, mfaApprovalId: null, steamBuildId: null,
  steamReleaseId: null, defaultBranchBuildId: null,
  targetMatrix: Object.freeze(["linux", "macos", "windows"] as const), iteration: 1, repairAttempts: 0,
  waitingProviderRevisionId: null, externalGate: null, externalApprovals: Object.freeze([]), history: Object.freeze([]),
  repairContext: null,
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

function preparationPort(observed: Array<Record<string, unknown>> = []) {
  return {
    async prepare(input: Record<string, unknown>) {
      observed.push(input);
      const sourceArtifactDigest = "5".repeat(64);
      const testPlanDigest = "6".repeat(64);
      return {
        executionLockId: "33333333-3333-4333-8333-333333333333",
        executionLockDigest: "3".repeat(64),
        sourceDigest: "4".repeat(64),
        sourceArtifactDigest,
        sourceObjectKey: `tenants/${String(input.tenantId)}/projects/${String(input.projectId)}/sources/${sourceArtifactDigest}.tar.zst`,
        testPlanDigest,
        testPlanObjectKey: `tenants/${String(input.tenantId)}/projects/${String(input.projectId)}/test-plans/${testPlanDigest}.json`,
        created: true,
      };
    },
  };
}

function steamPreparationPort(observed: Array<Record<string, unknown>> = []) {
  return {
    async prepare(input: Record<string, unknown>) {
      observed.push(input);
      return {
        executionLockId: "44444444-4444-4444-8444-444444444444",
        executionLockDigest: "7".repeat(64),
        sourceDigest: "8".repeat(64),
        steamAppId: "480",
        buildId: String(input.steamBuildId),
        betaBranch: "private_beta",
        installGrantId: "steam-install-grant-001",
        targetMatrix: input.targetMatrix as readonly ("windows" | "linux" | "macos")[],
        created: true,
      };
    },
  };
}

test("Runner workflow handler turns candidate matrix evidence into pass or repair signals", async () => {
  let response = receipt();
  const preparations: Array<Record<string, unknown>> = [];
  const handler = new RunnerControlWorkflowHandler({ async execute(input) {
    assert.equal(input.mode, "CANDIDATE");
    assert.equal(input.draftPullRequest, 91);
    assert.equal(input.runId, "run-001");
    return response;
  } }, preparationPort(preparations), steamPreparationPort());
  const passed = await handler.execute(job(base, "START_TARGET_MATRIX_E2E"), { async heartbeat() { return "ok"; }, async emitSignal() { return "unused"; } });
  assert.deepEqual(passed.signal, { type: "E2E_PASSED", evidenceBundleId: "evidence-bundle-1" });
  response = receipt({ status: "FAILED", evidenceBundleId: "failed-evidence-1", repairPromptId: "repair-prompt-1" });
  const failed = await handler.execute(job(base, "START_TARGET_MATRIX_E2E"), { async heartbeat() { return "ok"; }, async emitSignal() { return "unused"; } });
  assert.deepEqual(failed.signal, { type: "E2E_FAILED", evidenceBundleId: "failed-evidence-1", repairPromptId: "repair-prompt-1" });
  assert.equal(preparations.length, 2);
  assert.equal(preparations[0]?.lockKey, "b".repeat(64));
  assert.equal(preparations[0]?.mode, "CANDIDATE");
});

test("Runner workflow handler gates main SHA and Steam clean-install evidence separately", async () => {
  const main = Object.freeze({ ...base, state: "MAIN_SHA_E2E" as const, mainCommitSha: "c".repeat(40) });
  const steam = Object.freeze({ ...main, state: "STEAM_INSTALL_E2E" as const, steamBuildId: "91234567" });
  const preparations: Array<Record<string, unknown>> = [];
  const steamPreparations: Array<Record<string, unknown>> = [];
  const handler = new RunnerControlWorkflowHandler({ async execute(input) {
    return receipt({
      mode: input.mode, commitSha: input.commitSha, steamBuildId: input.steamBuildId,
      targetMatrix: input.targetMatrix, evidenceBundleId: `${input.mode.toLowerCase()}-evidence`,
    });
  } }, preparationPort(preparations), steamPreparationPort(steamPreparations));
  const mainResult = await handler.execute(job(main, "START_MAIN_SHA_RELEASE_GATE"), { async heartbeat() { return "ok"; }, async emitSignal() { return "unused"; } });
  assert.deepEqual(mainResult.signal, { type: "E2E_PASSED", evidenceBundleId: "main_release_gate-evidence" });
  const steamResult = await handler.execute(job(steam, "INSTALL_FROM_CLEAN_STEAM_CLIENT"), { async heartbeat() { return "ok"; }, async emitSignal() { return "unused"; } });
  assert.deepEqual(steamResult.signal, { type: "STEAM_INSTALL_PASSED", evidenceBundleId: "steam_clean_install-evidence" });
  assert.equal(preparations.length, 1);
  assert.equal(preparations[0]?.mode, "MAIN_RELEASE_GATE");
  assert.equal(steamPreparations.length, 1);
  assert.equal(steamPreparations[0]?.steamBuildId, "91234567");

  const failing = new RunnerControlWorkflowHandler({ async execute(input) {
    return receipt({ mode: input.mode, status: "FAILED", commitSha: input.commitSha, steamBuildId: input.steamBuildId,
      targetMatrix: input.targetMatrix, evidenceBundleId: `${input.mode.toLowerCase()}-failed-evidence`, repairPromptId: `${input.mode.toLowerCase()}-repair-prompt` });
  } }, preparationPort(), steamPreparationPort());
  const mainFailure = await failing.execute(job(main, "START_MAIN_SHA_RELEASE_GATE"), { async heartbeat() { return "ok"; }, async emitSignal() { return "unused"; } });
  assert.deepEqual(mainFailure.signal, {
    type: "MAIN_E2E_FAILED", evidenceBundleId: "main_release_gate-failed-evidence",
    repairPromptId: "main_release_gate-repair-prompt",
  });
  const steamFailure = await failing.execute(job(steam, "INSTALL_FROM_CLEAN_STEAM_CLIENT"), { async heartbeat() { return "ok"; }, async emitSignal() { return "unused"; } });
  assert.deepEqual(steamFailure.signal, {
    type: "STEAM_INSTALL_FAILED", evidenceBundleId: "steam_clean_install-failed-evidence",
    repairPromptId: "steam_clean_install-repair-prompt",
  });
});
