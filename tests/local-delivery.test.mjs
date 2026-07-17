import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLocalDeliveryAction,
  approveLocalSpec,
  createLocalDelivery,
  invalidateLocalDelivery,
  recordLocalAgentExecution,
  recordLocalValidation,
} from "../lib/local-delivery/model.ts";

test("local delivery fixture exercises the complete gated chain without external calls", () => {
  let state = approveLocalSpec(createLocalDelivery("project-local"), "SPEC-004", "RUN-LOCAL-1");
  assert.equal(state.stage, "AGENT_QUEUED");
  assert.equal(state.lockedProfile.agent, "claude-code");

  state = applyLocalDeliveryAction(state, "provider-fail");
  assert.equal(state.stage, "WAITING_PROVIDER");
  state = applyLocalDeliveryAction(state, "provider-resume");
  assert.equal(state.stage, "AGENT_QUEUED");

  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "CANDIDATE_READY");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.targetResults.linux, "RUNNING");

  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "AWAITING_ACCEPTANCE");
  assert.deepEqual(state.targetResults, { linux: "PASSED", windows: "PASSED", macos: "PASSED" });
  assert.equal(state.evidenceValid, true);

  state = applyLocalDeliveryAction(state, "accept");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "MAIN_GATE_RUNNING");
  assert.equal(state.mainSha, "f21c0de");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "MFA_REQUIRED");
  state = applyLocalDeliveryAction(state, "confirm-mfa");
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "EXTERNAL_APPROVAL_REQUIRED");
  state = applyLocalDeliveryAction(state, "external-approve");
  assert.equal(state.stage, "RELEASED");
  assert.match(state.events[0].message, /未调用真实 Steam/);
});

test("feedback invalidates all local evidence and requires a new immutable approval", () => {
  let state = approveLocalSpec(createLocalDelivery("project-feedback"), "SPEC-008", "RUN-LOCAL-2");
  state = recordLocalValidation(state, {
    evidenceId: "EV-LOCAL-TEST",
    status: "TESTS_PASSED",
    releaseGate: "WAITING_EXPORT_TEMPLATES",
    candidateSha: "a".repeat(40),
    sourceDigest: "b".repeat(64),
    bundleDigest: "c".repeat(64),
    godotVersion: "4.6.2.stable",
    checks: [{ name: "core-loop", status: "PASSED", durationMs: 4, detail: "fixture" }],
    createdAt: "2026-07-18T00:00:00.000Z",
  });
  assert.equal(state.stage, "CANDIDATE_READY");
  assert.equal(state.localValidation.valid, true);
  state = { ...state, evidenceValid: true, targetResults: { linux: "PASSED", windows: "PASSED", macos: "PASSED" } };
  state = invalidateLocalDelivery(state, "SPEC-009");
  assert.equal(state.stage, "AWAITING_SPEC_APPROVAL");
  assert.equal(state.evidenceValid, false);
  assert.deepEqual(state.targetResults, { linux: "INVALIDATED", windows: "INVALIDATED", macos: "INVALIDATED" });
  assert.equal(state.localValidation.valid, false);
  assert.throws(() => applyLocalDeliveryAction(state, "advance"), /先批准/);
});

test("failed local validation is auditable but cannot advance the candidate gate", () => {
  let state = approveLocalSpec(createLocalDelivery("project-failed"), "SPEC-010", "RUN-LOCAL-FAILED");
  state = recordLocalValidation(state, {
    evidenceId: "EV-LOCAL-FAILED",
    status: "FAILED",
    releaseGate: "TESTS_FAILED",
    candidateSha: "d".repeat(40),
    sourceDigest: "e".repeat(64),
    bundleDigest: "f".repeat(64),
    godotVersion: "4.6.2.stable",
    checks: [{ name: "macos-export", status: "FAILED", durationMs: 3, detail: "configuration error" }],
    createdAt: "2026-07-18T00:00:00.000Z",
  });
  assert.equal(state.stage, "AGENT_QUEUED");
  assert.equal(state.localValidation.valid, true);
  assert.equal(state.events[0].type, "LOCAL_GODOT_VALIDATION_FAILED");
});

test("reset keeps event revisions monotonic for the persistent D1 audit log", () => {
  let state = approveLocalSpec(createLocalDelivery("project-reset"), "SPEC-011", "RUN-RESET-001");
  const previousRevision = state.revision;
  state = applyLocalDeliveryAction(state, "reset");
  assert.equal(state.stage, "AWAITING_SPEC_APPROVAL");
  assert.equal(state.revision, previousRevision + 1);
  assert.equal(state.events[0].id, `LOCAL-EVT-${String(state.revision).padStart(4, "0")}`);
  assert.equal(state.events[0].type, "DELIVERY_RESET");
  assert.equal(state.events[1].type, "SPEC_APPROVED");
});

test("a completed Agent receipt must match every immutable lock before becoming a candidate", () => {
  let state = approveLocalSpec(createLocalDelivery("project-agent"), "SPEC-012", "RUN-AGENT-001");
  const receipt = {
    schemaVersion: 1,
    tenantId: "tenant-local",
    projectId: state.projectId,
    runId: state.runId,
    attemptId: "ATT-RUN-AGENT-001",
    specRevisionId: state.specRevisionId,
    testPlanRevisionId: state.lockedProfile.testPlanRevisionId,
    profileRevisionId: state.lockedProfile.profileRevisionId,
    installationId: state.lockedProfile.installationId,
    imageDigest: state.lockedProfile.imageDigest,
    adapterVersion: state.lockedProfile.adapterVersion,
    providerRevisionId: state.lockedProfile.providerRevisionId,
    credentialVersionId: state.lockedProfile.credentialVersionId,
    model: state.lockedProfile.model,
    agent: state.lockedProfile.agent,
    budget: state.lockedProfile.budget,
    timeoutSeconds: state.lockedProfile.timeoutSeconds,
    status: "completed",
    summary: "Implemented the approved immutable specification.",
    usage: { inputTokens: 400, outputTokens: 120, costUsd: 0.42 },
    warnings: [],
    candidate: {
      scmProxy: "local-git-proxy-v1",
      branch: "deviludo/run-agent-001",
      baseCommitSha: "c".repeat(40),
      commitSha: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      changedFiles: ["scripts/game_state.gd"],
      draftPullRequest: null,
    },
    completedAt: "2026-07-18T00:00:00.000Z",
  };
  assert.throws(
    () => recordLocalAgentExecution(state, { ...receipt, credentialVersionId: "credential-other-v2" }),
    /不可变任务锁/,
  );
  state = recordLocalAgentExecution(state, receipt);
  assert.equal(state.stage, "CANDIDATE_READY");
  assert.equal(state.candidateSha, receipt.candidate.commitSha);
  assert.equal(state.agentExecution.valid, true);
  assert.equal(state.events[0].type, "AGENT_CANDIDATE_RECORDED");
  state = invalidateLocalDelivery(state, "SPEC-013");
  assert.equal(state.agentExecution.valid, false);
});
