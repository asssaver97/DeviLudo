import assert from "node:assert/strict";
import test from "node:test";
import { GameDeliveryWorkflow } from "../lib/orchestration/game-delivery.ts";

const candidateSha = "a".repeat(40);
const mainSha = "b".repeat(40);
const codeReview = Object.freeze({ codeReviewReceiptId: "review-receipt-0001", codeReviewDigest: "f".repeat(64) });

function workflowAtMainGate(id) {
  const workflow = new GameDeliveryWorkflow({ workflowId: id, tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["linux"] });
  workflow.signal({ signalId: `${id}-ready`, type: "SPEC_READY", specRevisionId: "SPEC-DRAFT-001" });
  workflow.signal({ signalId: `${id}-approved`, type: "SPEC_APPROVED", approvedSpecRevisionId: "SPEC-APPROVED-001", testPlanRevisionId: "PLAN-001", approvalReceiptId: "approval-001" });
  workflow.signal({ signalId: `${id}-locked`, type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: "run-config-001" });
  workflow.signal({ signalId: `${id}-started`, type: "AGENT_STARTED", runId: "run-001" });
  workflow.signal({ signalId: `${id}-completed`, type: "AGENT_COMPLETED", candidateCommitSha: candidateSha, draftPullRequest: 18, ...codeReview });
  workflow.signal({ signalId: `${id}-candidate-e2e`, type: "E2E_PASSED", evidenceBundleId: "candidate-evidence-001" });
  workflow.signal({ signalId: `${id}-accepted`, type: "USER_ACCEPTED" });
  workflow.signal({ signalId: `${id}-merged`, type: "MAIN_MERGED", mainCommitSha: mainSha });
  return workflow;
}

test("delivery workflow requires every Steam external gate and release receipt", () => {
  const workflow = new GameDeliveryWorkflow({ workflowId: "delivery-1", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["windows", "linux", "macos"] });
  assert.equal(workflow.nextCommand(), "CONTINUE_IDEA_DIALOGUE");
  workflow.signal({ signalId: "signal-001", type: "SPEC_READY", specRevisionId: "SPEC-001" });
  workflow.signal({ signalId: "signal-002", type: "SPEC_APPROVED", approvedSpecRevisionId: "SPEC-APPROVED-001", testPlanRevisionId: "PLAN-001", approvalReceiptId: "approval-001" });
  assert.equal(workflow.nextCommand(), "RESOLVE_AGENT_RUN_CONFIGURATION");
  workflow.signal({ signalId: "signal-002-lock", type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: "lock-1" });
  assert.equal(workflow.nextCommand(), "START_LOCKED_AGENT_RUN");
  workflow.signal({ signalId: "signal-003", type: "AGENT_STARTED", runId: "run-1" });
  assert.throws(() => workflow.signal({ signalId: "signal-missing-review", type: "AGENT_COMPLETED",
    candidateCommitSha: candidateSha, draftPullRequest: 18 }), /invalid while delivery is DEVELOPING/);
  workflow.signal({ signalId: "signal-004", type: "AGENT_COMPLETED", candidateCommitSha: candidateSha, draftPullRequest: 18, ...codeReview });
  assert.equal(workflow.current().draftPullRequest, 18);
  assert.equal(workflow.current().codeReviewReceiptId, codeReview.codeReviewReceiptId);
  assert.equal(workflow.current().codeReviewDigest, codeReview.codeReviewDigest);
  workflow.signal({ signalId: "signal-005", type: "E2E_PASSED", evidenceBundleId: "evidence-candidate" });
  workflow.signal({ signalId: "signal-006", type: "USER_ACCEPTED" });
  workflow.signal({ signalId: "signal-007", type: "MAIN_MERGED", mainCommitSha: mainSha });
  workflow.signal({ signalId: "signal-008", type: "E2E_PASSED", evidenceBundleId: "evidence-main" });
  assert.equal(workflow.nextCommand(), "REQUEST_FRESH_MFA");
  workflow.signal({ signalId: "signal-release-prepared", type: "RELEASE_PREPARED", releaseId: "release-1" });
  assert.equal(workflow.current().steamReleaseId, "release-1");
  assert.equal(workflow.nextCommand(), "NONE");
  workflow.signal({ signalId: "signal-009", type: "MFA_APPROVED", approvalId: "mfa-1" });
  workflow.signal({ signalId: "signal-010", type: "BETA_ACTIVATED", buildId: "1001" });
  workflow.signal({ signalId: "signal-011", type: "STEAM_INSTALL_PASSED", evidenceBundleId: "evidence-steam-install" });
  assert.equal(workflow.current().state, "EXTERNAL_APPROVAL_REQUIRED");
  assert.equal(workflow.current().externalGate, "VALVE_REVIEW");
  assert.equal(workflow.current().mfaApprovalId, "mfa-1");
  assert.equal(workflow.current().steamBuildId, "1001");
  assert.equal(workflow.nextCommand(), "WAIT_FOR_EXTERNAL_APPROVAL");
  const valveApproval = { signalId: "signal-012", type: "EXTERNAL_APPROVED", gate: "VALVE_REVIEW", approvalId: "valve-1" };
  workflow.signal(valveApproval);
  assert.equal(workflow.current().state, "EXTERNAL_APPROVAL_REQUIRED");
  assert.equal(workflow.current().externalGate, "FIRST_RELEASE");
  workflow.signal(valveApproval);
  assert.equal(workflow.current().externalGate, "FIRST_RELEASE");
  assert.throws(
    () => workflow.signal({ signalId: "signal-wrong-gate", type: "EXTERNAL_APPROVED", gate: "DEFAULT_BRANCH_CONFIRMATION", approvalId: "wrong-gate-1" }),
    /invalid while delivery is EXTERNAL_APPROVAL_REQUIRED/,
  );
  workflow.signal({ signalId: "signal-013", type: "EXTERNAL_APPROVED", gate: "FIRST_RELEASE", approvalId: "first-release-1" });
  assert.equal(workflow.current().externalGate, "DEFAULT_BRANCH_CONFIRMATION");
  workflow.signal({ signalId: "signal-014", type: "EXTERNAL_APPROVED", gate: "DEFAULT_BRANCH_CONFIRMATION", approvalId: "mobile-confirmation-1" });
  assert.equal(workflow.current().state, "READY_TO_PUBLISH");
  assert.equal(workflow.nextCommand(), "PUBLISH_STEAM_DEFAULT_BRANCH");
  assert.equal(workflow.current().externalApprovals.length, 3);
  assert.throws(
    () => workflow.signal({
      signalId: "signal-too-late-cancel", type: "CANCEL", reason: "publish already authorized",
      expectedState: workflow.current().state, expectedHistoryLength: workflow.current().history.length,
    }),
    /invalid while delivery is READY_TO_PUBLISH/,
  );
  assert.throws(
    () => workflow.signal({ signalId: "signal-wrong-release", type: "STEAM_RELEASED", releaseId: "release-other", defaultBranchBuildId: "1001" }),
    /invalid while delivery is READY_TO_PUBLISH/,
  );
  workflow.signal({ signalId: "signal-015", type: "STEAM_RELEASED", releaseId: "release-1", defaultBranchBuildId: "1001" });
  assert.equal(workflow.current().state, "RELEASED");
  assert.equal(workflow.nextCommand(), "NONE");
  assert.equal(workflow.current().steamReleaseId, "release-1");
  assert.equal(workflow.current().history.length, 17);
  assert.throws(
    () => workflow.signal({
      signalId: "signal-post-release-cancel", type: "CANCEL", reason: "release already public",
      expectedState: workflow.current().state, expectedHistoryLength: workflow.current().history.length,
    }),
    /invalid while delivery is RELEASED/,
  );
});

test("delivery cancellation is terminal before the irreversible publish boundary", () => {
  const workflow = new GameDeliveryWorkflow({
    workflowId: "delivery-cancel", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["linux"],
  });
  workflow.signal({ signalId: "cancel-ready", type: "SPEC_READY", specRevisionId: "SPEC-001" });
  workflow.signal({
    signalId: "cancel-signal", type: "CANCEL", reason: "user withdrew the game",
    expectedState: "WAITING_SPEC_APPROVAL", expectedHistoryLength: 1,
  });
  assert.equal(workflow.current().state, "CANCELLED");
  assert.equal(workflow.nextCommand(), "NONE");
  assert.throws(
    () => workflow.signal({ signalId: "cancel-after-terminal", type: "SPEC_READY", specRevisionId: "SPEC-002" }),
    /Cancelled workflows are terminal/,
  );
});

test("a stale cancellation is a safe no-op after a concurrent projection transition", () => {
  const workflow = new GameDeliveryWorkflow({
    workflowId: "delivery-stale-cancel", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["linux"],
  });
  workflow.signal({ signalId: "stale-ready", type: "SPEC_READY", specRevisionId: "SPEC-001" });
  workflow.signal({
    signalId: "stale-approved", type: "SPEC_APPROVED", approvedSpecRevisionId: "SPEC-001",
    testPlanRevisionId: "PLAN-001", approvalReceiptId: "approval-001",
  });
  const historyLength = workflow.current().history.length;
  const snapshot = workflow.signal({
    signalId: "stale-cancel-signal", type: "CANCEL", reason: "based on an old projection",
    expectedState: "WAITING_SPEC_APPROVAL", expectedHistoryLength: 1,
  });
  assert.equal(snapshot.state, "RESOLVING_AGENT_CONFIGURATION");
  assert.equal(snapshot.history.length, historyLength);
});

test("feedback invalidates evidence and the approved second iteration returns through development and E2E", () => {
  const workflow = new GameDeliveryWorkflow({ workflowId: "delivery-2", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["linux"] });
  workflow.signal({ signalId: "signal-101", type: "SPEC_READY", specRevisionId: "SPEC-001" });
  workflow.signal({ signalId: "signal-102", type: "SPEC_APPROVED", approvedSpecRevisionId: "SPEC-APPROVED-001", testPlanRevisionId: "PLAN-001", approvalReceiptId: "approval-101" });
  workflow.signal({ signalId: "signal-102-lock", type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: "lock-claude-r1" });
  workflow.signal({ signalId: "signal-103", type: "PROVIDER_UNAVAILABLE", providerRevisionId: "provider-claude-r1" });
  assert.equal(workflow.current().state, "WAITING_PROVIDER");
  assert.equal(workflow.current().lockedRunConfigurationId, "lock-claude-r1");
  workflow.signal({ signalId: "signal-104", type: "PROVIDER_RESTORED", providerRevisionId: "provider-claude-r1" });
  workflow.signal({ signalId: "signal-105", type: "AGENT_STARTED", runId: "run-1" });
  workflow.signal({ signalId: "signal-106", type: "AGENT_COMPLETED", candidateCommitSha: candidateSha, draftPullRequest: 18, ...codeReview });
  workflow.signal({ signalId: "signal-107", type: "E2E_PASSED", evidenceBundleId: "evidence-1" });
  workflow.signal({ signalId: "signal-108", type: "USER_FEEDBACK", nextSpecRevisionId: "SPEC-002", evidenceInvalidationId: "invalidate-1" });
  assert.equal(workflow.current().state, "WAITING_SPEC_APPROVAL");
  assert.equal(workflow.current().evidenceBundleId, null);
  assert.equal(workflow.current().candidateCommitSha, null);
  assert.equal(workflow.current().draftPullRequest, null);
  assert.equal(workflow.current().lockedRunConfigurationId, null);
  assert.equal(workflow.current().testPlanRevisionId, null);
  assert.equal(workflow.current().specApprovalReceiptId, null);
  assert.equal(workflow.current().iteration, 2);
  assert.equal(workflow.nextCommand(), "REQUEST_SPEC_APPROVAL");

  workflow.signal({
    signalId: "signal-109",
    type: "SPEC_APPROVED",
    approvedSpecRevisionId: "SPEC-APPROVED-002",
    testPlanRevisionId: "PLAN-002",
    approvalReceiptId: "approval-102",
  });
  assert.equal(workflow.nextCommand(), "RESOLVE_AGENT_RUN_CONFIGURATION");
  workflow.signal({ signalId: "signal-110", type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: "lock-claude-r2" });
  workflow.signal({ signalId: "signal-111", type: "AGENT_STARTED", runId: "run-2" });
  workflow.signal({ signalId: "signal-112", type: "AGENT_COMPLETED", candidateCommitSha: "c".repeat(40), draftPullRequest: 19, ...codeReview });
  assert.equal(workflow.nextCommand(), "START_TARGET_MATRIX_E2E");
  workflow.signal({ signalId: "signal-113", type: "E2E_PASSED", evidenceBundleId: "evidence-2" });
  assert.equal(workflow.current().state, "WAITING_USER_ACCEPTANCE");
  assert.equal(workflow.current().iteration, 2);
  assert.equal(workflow.current().specRevisionId, "SPEC-APPROVED-002");
  assert.equal(workflow.current().candidateCommitSha, "c".repeat(40));
  assert.equal(workflow.current().draftPullRequest, 19);
  assert.equal(workflow.current().candidateEvidenceBundleId, "evidence-2");
});

test("delivery signals are idempotent and gate-bound", () => {
  const workflow = new GameDeliveryWorkflow({ workflowId: "delivery-3", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["linux"] });
  const ready = { signalId: "signal-201", type: "SPEC_READY", specRevisionId: "SPEC-001" };
  workflow.signal(ready);
  const historyLength = workflow.current().history.length;
  workflow.signal({ specRevisionId: "SPEC-001", type: "SPEC_READY", signalId: "signal-201" });
  assert.equal(workflow.current().history.length, historyLength);
  assert.throws(
    () => workflow.signal({ signalId: "signal-201", type: "SPEC_READY", specRevisionId: "SPEC-OTHER" }),
    /reused with different content/,
  );
});

test("delivery workflow rejects an unknown runtime signal type", () => {
  const workflow = new GameDeliveryWorkflow({
    workflowId: "delivery-unknown-signal", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["linux"],
  });
  assert.throws(
    () => workflow.signal({ signalId: "signal-unknown-001", type: "UNKNOWN" }),
    /Delivery signal type is invalid/,
  );
  assert.throws(
    () => workflow.signal({ signalId: "signal-approved-malformed", type: "SPEC_APPROVED" }),
    /Approved specification revision identifier is invalid/,
  );
});

test("an in-flight Provider recovery queues a fresh command for the same recorded run", () => {
  const workflow = new GameDeliveryWorkflow({
    workflowId: "delivery-provider-resume", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["linux"],
  });
  workflow.signal({ signalId: "resume-signal-001", type: "SPEC_READY", specRevisionId: "SPEC-001" });
  workflow.signal({ signalId: "resume-signal-002", type: "SPEC_APPROVED", approvedSpecRevisionId: "SPEC-APPROVED-001", testPlanRevisionId: "PLAN-001", approvalReceiptId: "approval-resume-001" });
  workflow.signal({ signalId: "resume-signal-002-lock", type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: "lock-001" });
  workflow.signal({ signalId: "resume-signal-003", type: "AGENT_STARTED", runId: "run-001" });
  workflow.signal({ signalId: "resume-signal-004", type: "PROVIDER_UNAVAILABLE", providerRevisionId: "provider-001" });
  workflow.signal({ signalId: "resume-signal-005", type: "PROVIDER_RESTORED", providerRevisionId: "provider-001" });
  assert.equal(workflow.current().state, "DEVELOPMENT_QUEUED");
  assert.equal(workflow.current().runId, "run-001");
  assert.equal(workflow.nextCommand(), "START_LOCKED_AGENT_RUN");
});

test("failed candidate E2E creates a new immutable repair run bound to the failed evidence", () => {
  const workflow = new GameDeliveryWorkflow({
    workflowId: "delivery-e2e-repair", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["linux", "windows"],
  });
  workflow.signal({ signalId: "repair-001", type: "SPEC_READY", specRevisionId: "SPEC-001" });
  workflow.signal({ signalId: "repair-002", type: "SPEC_APPROVED", approvedSpecRevisionId: "SPEC-APPROVED-001", testPlanRevisionId: "PLAN-001", approvalReceiptId: "approval-001" });
  workflow.signal({ signalId: "repair-003", type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: "run-config-original" });
  workflow.signal({ signalId: "repair-004", type: "AGENT_STARTED", runId: "run-original" });
  workflow.signal({ signalId: "repair-005", type: "AGENT_COMPLETED", candidateCommitSha: candidateSha, draftPullRequest: 41, ...codeReview });
  workflow.signal({ signalId: "repair-006", type: "E2E_FAILED", evidenceBundleId: "evidence-failed-001", repairPromptId: "repair:failed-bundle-001" });

  assert.equal(workflow.current().state, "RESOLVING_AGENT_CONFIGURATION");
  assert.equal(workflow.nextCommand(), "RESOLVE_AGENT_RUN_CONFIGURATION");
  assert.equal(workflow.current().lockedRunConfigurationId, null);
  assert.equal(workflow.current().runId, null);
  assert.equal(workflow.current().repairAttempts, 1);
  assert.deepEqual(workflow.current().repairContext, {
    attempt: 1,
    reason: "E2E_FAILURE",
    fromRunConfigurationId: "run-config-original",
    diagnosticId: null,
    evidenceBundleId: "evidence-failed-001",
    repairPromptId: "repair:failed-bundle-001",
    candidateCommitSha: candidateSha,
    draftPullRequest: 41,
  });

  workflow.signal({ signalId: "repair-007", type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: "run-config-repair-001" });
  assert.equal(workflow.current().lockedRunConfigurationId, "run-config-repair-001");
  assert.equal(workflow.nextCommand(), "START_LOCKED_AGENT_RUN");
  workflow.signal({ signalId: "repair-008", type: "AGENT_STARTED", runId: "run-repair-001" });
  assert.equal(workflow.current().state, "DEVELOPING");
});

test("terminal Agent failure also resolves a fresh run instead of reusing the failed operation", () => {
  const workflow = new GameDeliveryWorkflow({
    workflowId: "delivery-agent-repair", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["linux"],
  });
  workflow.signal({ signalId: "agent-repair-001", type: "SPEC_READY", specRevisionId: "SPEC-001" });
  workflow.signal({ signalId: "agent-repair-002", type: "SPEC_APPROVED", approvedSpecRevisionId: "SPEC-APPROVED-001", testPlanRevisionId: "PLAN-001", approvalReceiptId: "approval-001" });
  workflow.signal({ signalId: "agent-repair-003", type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: "run-config-failed" });
  workflow.signal({ signalId: "agent-repair-004", type: "AGENT_STARTED", runId: "run-failed" });
  workflow.signal({ signalId: "agent-repair-005", type: "AGENT_FAILED", diagnosticId: "diagnostic-failed-001" });

  assert.equal(workflow.current().state, "RESOLVING_AGENT_CONFIGURATION");
  assert.equal(workflow.current().lockedRunConfigurationId, null);
  assert.equal(workflow.current().runId, null);
  assert.deepEqual(workflow.current().repairContext, {
    attempt: 1,
    reason: "AGENT_FAILURE",
    fromRunConfigurationId: "run-config-failed",
    diagnosticId: "diagnostic-failed-001",
    evidenceBundleId: null,
    repairPromptId: null,
    candidateCommitSha: null,
    draftPullRequest: null,
  });
});

test("automatic repair budget stops after three failures and requires a human specification revision", () => {
  const workflow = new GameDeliveryWorkflow({
    workflowId: "delivery-repair-budget", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["linux"],
  });
  workflow.signal({ signalId: "budget-signal-001", type: "SPEC_READY", specRevisionId: "SPEC-DRAFT-001" });
  workflow.signal({
    signalId: "budget-signal-002", type: "SPEC_APPROVED", approvedSpecRevisionId: "SPEC-APPROVED-001",
    testPlanRevisionId: "PLAN-001", approvalReceiptId: "approval-budget-001",
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    workflow.signal({
      signalId: `budget-lock-${attempt.toString().padStart(3, "0")}`,
      type: "RUN_CONFIGURATION_LOCKED",
      lockedRunConfigurationId: `run-config-budget-${attempt}`,
    });
    workflow.signal({
      signalId: `budget-start-${attempt.toString().padStart(3, "0")}`,
      type: "AGENT_STARTED",
      runId: `run-budget-${attempt}`,
    });
    workflow.signal({
      signalId: `budget-failed-${attempt.toString().padStart(3, "0")}`,
      type: "AGENT_FAILED",
      diagnosticId: `diagnostic-budget-${attempt}`,
    });
    assert.equal(workflow.current().repairAttempts, attempt);
    assert.equal(workflow.current().state, attempt < 3 ? "RESOLVING_AGENT_CONFIGURATION" : "WAITING_SPEC_APPROVAL");
  }

  assert.equal(workflow.nextCommand(), "REQUEST_SPEC_APPROVAL");
  assert.equal(workflow.current().repairContext.attempt, 3);
  assert.equal(workflow.current().lockedRunConfigurationId, null);
  assert.equal(workflow.current().runId, null);
  assert.throws(() => workflow.signal({
    signalId: "budget-reapprove-old", type: "SPEC_APPROVED", approvedSpecRevisionId: "SPEC-APPROVED-001",
    testPlanRevisionId: "PLAN-001", approvalReceiptId: "approval-budget-old",
  }), /invalid while delivery is WAITING_SPEC_APPROVAL/);
  assert.throws(() => workflow.signal({
    signalId: "budget-same-draft", type: "USER_FEEDBACK", nextSpecRevisionId: "SPEC-APPROVED-001",
    evidenceInvalidationId: "human-revision-receipt-001",
  }), /invalid while delivery is WAITING_SPEC_APPROVAL/);

  workflow.signal({
    signalId: "budget-human-draft", type: "USER_FEEDBACK", nextSpecRevisionId: "SPEC-DRAFT-002",
    evidenceInvalidationId: "human-revision-receipt-002",
  });
  assert.equal(workflow.current().state, "WAITING_SPEC_APPROVAL");
  assert.equal(workflow.current().specRevisionId, "SPEC-DRAFT-002");
  assert.equal(workflow.current().repairAttempts, 0);
  assert.equal(workflow.current().repairContext, null);
  assert.equal(workflow.current().iteration, 2);

  workflow.signal({
    signalId: "budget-approve-new", type: "SPEC_APPROVED", approvedSpecRevisionId: "SPEC-APPROVED-002",
    testPlanRevisionId: "PLAN-002", approvalReceiptId: "approval-budget-002",
  });
  assert.equal(workflow.current().state, "RESOLVING_AGENT_CONFIGURATION");
  assert.equal(workflow.current().specRevisionId, "SPEC-APPROVED-002");
});

test("an exhausted E2E repair budget preserves failed lineage but clears stale candidate authority", () => {
  const workflow = new GameDeliveryWorkflow({
    workflowId: "delivery-e2e-budget", tenantId: "tenant-1", projectId: "project-1",
    targetMatrix: ["linux"], automaticRepairLimit: 1,
  });
  workflow.signal({ signalId: "e2e-budget-ready", type: "SPEC_READY", specRevisionId: "SPEC-DRAFT-001" });
  workflow.signal({
    signalId: "e2e-budget-approved", type: "SPEC_APPROVED", approvedSpecRevisionId: "SPEC-APPROVED-001",
    testPlanRevisionId: "PLAN-001", approvalReceiptId: "approval-e2e-budget",
  });
  workflow.signal({ signalId: "e2e-budget-locked", type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: "run-config-e2e-budget" });
  workflow.signal({ signalId: "e2e-budget-started", type: "AGENT_STARTED", runId: "run-e2e-budget" });
  workflow.signal({ signalId: "e2e-budget-complete", type: "AGENT_COMPLETED", candidateCommitSha: candidateSha, draftPullRequest: 71, ...codeReview });
  workflow.signal({
    signalId: "e2e-budget-failed", type: "E2E_FAILED", evidenceBundleId: "evidence-e2e-budget",
    repairPromptId: "repair-prompt-e2e-budget",
  });

  assert.equal(workflow.current().state, "WAITING_SPEC_APPROVAL");
  assert.equal(workflow.current().candidateCommitSha, null);
  assert.equal(workflow.current().draftPullRequest, null);
  assert.equal(workflow.current().candidateEvidenceBundleId, null);
  assert.equal(workflow.current().repairContext.candidateCommitSha, candidateSha);
  assert.equal(workflow.current().repairContext.draftPullRequest, 71);
  assert.equal(workflow.current().repairContext.evidenceBundleId, "evidence-e2e-budget");
});

test("main and Steam reinstall failures revoke release authority and require a new human-approved revision", () => {
  const mainFailure = workflowAtMainGate("delivery-main-gate-failure");
  mainFailure.signal({
    signalId: "main-gate-failure-signal", type: "MAIN_E2E_FAILED",
    evidenceBundleId: "main-failed-evidence", repairPromptId: "repair-main-failed-evidence",
  });
  assert.equal(mainFailure.current().state, "WAITING_SPEC_APPROVAL");
  assert.equal(mainFailure.current().mainCommitSha, null);
  assert.equal(mainFailure.current().mainEvidenceBundleId, null);
  assert.equal(mainFailure.current().repairContext.reason, "MAIN_GATE_FAILURE");
  assert.equal(mainFailure.current().repairContext.candidateCommitSha, mainSha);
  assert.equal(mainFailure.current().repairContext.draftPullRequest, null);
  mainFailure.signal({
    signalId: "main-gate-human-draft", type: "USER_FEEDBACK", nextSpecRevisionId: "SPEC-DRAFT-002",
    evidenceInvalidationId: "main-gate-revision-receipt",
  });
  assert.equal(mainFailure.current().repairContext, null);
  assert.equal(mainFailure.current().repairAttempts, 0);
  assert.equal(mainFailure.current().iteration, 2);

  const steamFailure = workflowAtMainGate("delivery-steam-install-failure");
  steamFailure.signal({ signalId: "steam-main-e2e-pass", type: "E2E_PASSED", evidenceBundleId: "main-evidence-001" });
  steamFailure.signal({ signalId: "steam-release-prepared", type: "RELEASE_PREPARED", releaseId: "release-001" });
  steamFailure.signal({ signalId: "steam-mfa-approved", type: "MFA_APPROVED", approvalId: "mfa-001" });
  steamFailure.signal({ signalId: "steam-beta-active", type: "BETA_ACTIVATED", buildId: "91234567" });
  steamFailure.signal({
    signalId: "steam-install-failure-signal", type: "STEAM_INSTALL_FAILED",
    evidenceBundleId: "steam-failed-evidence", repairPromptId: "repair-steam-failed-evidence",
  });
  assert.equal(steamFailure.current().state, "WAITING_SPEC_APPROVAL");
  assert.equal(steamFailure.current().repairContext.reason, "STEAM_INSTALL_FAILURE");
  assert.equal(steamFailure.current().steamBuildId, null);
  assert.equal(steamFailure.current().steamReleaseId, null);
  assert.equal(steamFailure.current().mfaApprovalId, null);
  assert.deepEqual(steamFailure.current().externalApprovals, []);
});
