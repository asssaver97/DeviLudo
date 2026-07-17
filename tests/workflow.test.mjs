import assert from "node:assert/strict";
import test from "node:test";
import { GameDeliveryWorkflow } from "../lib/orchestration/game-delivery.ts";

const candidateSha = "a".repeat(40);
const mainSha = "b".repeat(40);

test("delivery workflow requires every Steam external gate and release receipt", () => {
  const workflow = new GameDeliveryWorkflow({ workflowId: "delivery-1", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["windows", "linux", "macos"] });
  assert.equal(workflow.nextCommand(), "CONTINUE_IDEA_DIALOGUE");
  workflow.signal({ signalId: "signal-001", type: "SPEC_READY", specRevisionId: "SPEC-001" });
  workflow.signal({ signalId: "signal-002", type: "SPEC_APPROVED", lockedRunConfigurationId: "lock-1" });
  assert.equal(workflow.nextCommand(), "START_LOCKED_AGENT_RUN");
  workflow.signal({ signalId: "signal-003", type: "AGENT_STARTED", runId: "run-1" });
  workflow.signal({ signalId: "signal-004", type: "AGENT_COMPLETED", candidateCommitSha: candidateSha, draftPullRequest: 18 });
  assert.equal(workflow.current().draftPullRequest, 18);
  workflow.signal({ signalId: "signal-005", type: "E2E_PASSED", evidenceBundleId: "evidence-candidate" });
  workflow.signal({ signalId: "signal-006", type: "USER_ACCEPTED" });
  workflow.signal({ signalId: "signal-007", type: "MAIN_MERGED", mainCommitSha: mainSha });
  workflow.signal({ signalId: "signal-008", type: "E2E_PASSED", evidenceBundleId: "evidence-main" });
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
  workflow.signal({ signalId: "signal-015", type: "STEAM_RELEASED", releaseId: "release-1", defaultBranchBuildId: "1001" });
  assert.equal(workflow.current().state, "RELEASED");
  assert.equal(workflow.nextCommand(), "NONE");
  assert.equal(workflow.current().steamReleaseId, "release-1");
  assert.equal(workflow.current().history.length, 15);
});

test("feedback invalidates evidence and provider outage resumes the locked Agent", () => {
  const workflow = new GameDeliveryWorkflow({ workflowId: "delivery-2", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["linux"] });
  workflow.signal({ signalId: "signal-101", type: "SPEC_READY", specRevisionId: "SPEC-001" });
  workflow.signal({ signalId: "signal-102", type: "SPEC_APPROVED", lockedRunConfigurationId: "lock-claude-r1" });
  workflow.signal({ signalId: "signal-103", type: "PROVIDER_UNAVAILABLE", providerRevisionId: "provider-claude-r1" });
  assert.equal(workflow.current().state, "WAITING_PROVIDER");
  assert.equal(workflow.current().lockedRunConfigurationId, "lock-claude-r1");
  workflow.signal({ signalId: "signal-104", type: "PROVIDER_RESTORED", providerRevisionId: "provider-claude-r1" });
  workflow.signal({ signalId: "signal-105", type: "AGENT_STARTED", runId: "run-1" });
  workflow.signal({ signalId: "signal-106", type: "AGENT_COMPLETED", candidateCommitSha: candidateSha, draftPullRequest: 18 });
  workflow.signal({ signalId: "signal-107", type: "E2E_PASSED", evidenceBundleId: "evidence-1" });
  workflow.signal({ signalId: "signal-108", type: "USER_FEEDBACK", nextSpecRevisionId: "SPEC-002", evidenceInvalidationId: "invalidate-1" });
  assert.equal(workflow.current().state, "WAITING_SPEC_APPROVAL");
  assert.equal(workflow.current().evidenceBundleId, null);
  assert.equal(workflow.current().candidateCommitSha, null);
  assert.equal(workflow.current().draftPullRequest, null);
  assert.equal(workflow.current().lockedRunConfigurationId, null);
  assert.equal(workflow.current().iteration, 2);
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
});
