import assert from "node:assert/strict";
import test from "node:test";
import { GameDeliveryWorkflow } from "../lib/orchestration/game-delivery.ts";

test("delivery workflow runs idea to Steam external gate and release", () => {
  const workflow = new GameDeliveryWorkflow({ workflowId: "delivery-1", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["windows", "linux", "macos"] });
  assert.equal(workflow.nextCommand(), "CONTINUE_IDEA_DIALOGUE");
  workflow.signal({ type: "SPEC_READY", specRevisionId: "SPEC-001" });
  workflow.signal({ type: "SPEC_APPROVED", lockedRunConfigurationId: "lock-1" });
  assert.equal(workflow.nextCommand(), "START_LOCKED_AGENT_RUN");
  workflow.signal({ type: "AGENT_STARTED", runId: "run-1" });
  workflow.signal({ type: "AGENT_COMPLETED", candidateCommitSha: "candidate-1", draftPullRequest: 18 });
  workflow.signal({ type: "E2E_PASSED", evidenceBundleId: "evidence-candidate" });
  workflow.signal({ type: "USER_ACCEPTED" });
  workflow.signal({ type: "MAIN_MERGED", mainCommitSha: "main-1" });
  workflow.signal({ type: "E2E_PASSED", evidenceBundleId: "evidence-main" });
  workflow.signal({ type: "MFA_APPROVED", approvalId: "mfa-1" });
  workflow.signal({ type: "BETA_ACTIVATED", buildId: "steam-build-1" });
  workflow.signal({ type: "STEAM_INSTALL_PASSED", evidenceBundleId: "evidence-steam-install" });
  assert.equal(workflow.current().state, "EXTERNAL_APPROVAL_REQUIRED");
  assert.equal(workflow.nextCommand(), "WAIT_FOR_EXTERNAL_APPROVAL");
  workflow.signal({ type: "EXTERNAL_APPROVED", approvalId: "valve-1" });
  assert.equal(workflow.current().state, "RELEASED");
  assert.equal(workflow.current().history.length, 12);
});

test("feedback invalidates evidence and provider outage resumes the locked Agent", () => {
  const workflow = new GameDeliveryWorkflow({ workflowId: "delivery-2", tenantId: "tenant-1", projectId: "project-1", targetMatrix: ["linux"] });
  workflow.signal({ type: "SPEC_READY", specRevisionId: "SPEC-001" });
  workflow.signal({ type: "SPEC_APPROVED", lockedRunConfigurationId: "lock-claude-r1" });
  workflow.signal({ type: "PROVIDER_UNAVAILABLE", providerRevisionId: "provider-claude-r1" });
  assert.equal(workflow.current().state, "WAITING_PROVIDER");
  assert.equal(workflow.current().lockedRunConfigurationId, "lock-claude-r1");
  workflow.signal({ type: "PROVIDER_RESTORED", providerRevisionId: "provider-claude-r1" });
  workflow.signal({ type: "AGENT_STARTED", runId: "run-1" });
  workflow.signal({ type: "AGENT_COMPLETED", candidateCommitSha: "candidate-1", draftPullRequest: 18 });
  workflow.signal({ type: "E2E_PASSED", evidenceBundleId: "evidence-1" });
  workflow.signal({ type: "USER_FEEDBACK", nextSpecRevisionId: "SPEC-002", evidenceInvalidationId: "invalidate-1" });
  assert.equal(workflow.current().state, "WAITING_SPEC_APPROVAL");
  assert.equal(workflow.current().evidenceBundleId, null);
  assert.equal(workflow.current().lockedRunConfigurationId, null);
  assert.equal(workflow.current().iteration, 2);
});
