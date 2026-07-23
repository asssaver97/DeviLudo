import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLocalDeliveryAction,
  approveLocalSpec,
  createLocalDelivery,
  invalidateLocalDelivery,
  normalizeLocalDeliverySnapshot,
  recordLocalAgentExecution,
  recordLocalMainValidation,
  recordLocalValidation,
} from "../lib/local-delivery/model.ts";

const macosBuild = Object.freeze({
  fileName: "DeviLudoLocal.zip", platform: "macos", contentType: "application/zip",
  sha256: "9".repeat(64), sizeBytes: 4096,
});

const macosMainBuild = Object.freeze({
  fileName: "DeviLudoMain.zip", platform: "macos", contentType: "application/zip",
  sha256: "8".repeat(64), sizeBytes: 8192,
});

function passingCandidate(state) {
  return recordLocalValidation(state, {
    schemaVersion: 4, evidenceId: "EV-LOCAL-AABBCCDDEEFF",
    status: "TESTS_PASSED", releaseGate: "LOCAL_VALIDATION_PASSED",
    candidateSha: "a".repeat(40), sourceDigest: "b".repeat(64), bundleDigest: "c".repeat(64),
    godotVersion: "4.6.2.stable", targetMatrix: state.targetMatrix,
    platform: "macos", fixtureOnly: true, buildArtifact: macosBuild,
    checks: [
      { name: "core-loop", status: "PASSED", durationMs: 4, detail: "fixture" },
      { name: "macos-export-boot", status: "PASSED", durationMs: 1, detail: "exported app booted" },
    ],
    createdAt: "2026-07-23T00:00:00.000Z",
  });
}

function mainEvidence(state, status = "passed") {
  const candidate = state.localValidation;
  const passed = status === "passed";
  return {
    schemaVersion: 1,
    evidenceId: passed ? "EV-MAIN-AABBCCDDEEFF" : "EV-MAIN-112233445566",
    status: passed ? "TESTS_PASSED" : "WAITING_DEPENDENCY",
    releaseGate: passed ? "MAIN_VALIDATION_PASSED" : "WAITING_EXPORT_TEMPLATES",
    candidateEvidenceId: candidate.evidenceId, candidateBundleDigest: candidate.bundleDigest,
    candidateSha: candidate.candidateSha, sourceDigest: candidate.sourceDigest,
    mainSha: candidate.candidateSha, mainSourceDigest: candidate.sourceDigest,
    bundleDigest: "d".repeat(64), godotVersion: "4.6.2.stable", targetMatrix: state.targetMatrix,
    platform: "macos", fixtureOnly: true, buildArtifact: passed ? macosMainBuild : null,
    checks: passed
      ? [{ name: "macos-export-boot", status: "PASSED", durationMs: 1, detail: "main export booted" }]
      : [{ name: "macos-export", status: "WAITING_DEPENDENCY", durationMs: 1, detail: "templates missing" }],
    createdAt: "2026-07-23T00:01:00.000Z",
  };
}

function localDeliveryAtAcceptedCandidate(projectId) {
  const initial = createLocalDelivery(projectId);
  let state = approveLocalSpec(initial, "SPEC-POST-MERGE-001", `RUN-${projectId}`, initial.lockedProfile, ["macos"]);
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  state = passingCandidate(state);
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  return applyLocalDeliveryAction(state, "accept");
}

test("local delivery fixture exercises the complete gated chain without external calls", () => {
  const initial = createLocalDelivery("project-local");
  let state = approveLocalSpec(initial, "SPEC-004", "RUN-LOCAL-1", initial.lockedProfile, ["macos"]);
  assert.equal(state.stage, "AGENT_QUEUED");
  assert.equal(state.lockedProfile.agent, "claude-code");

  state = applyLocalDeliveryAction(state, "provider-fail");
  assert.equal(state.stage, "WAITING_PROVIDER");
  state = applyLocalDeliveryAction(state, "provider-resume");
  assert.equal(state.stage, "AGENT_QUEUED");

  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "CANDIDATE_READY");
  state = passingCandidate(state);
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.targetResults.macos, "RUNNING");

  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "AWAITING_ACCEPTANCE");
  assert.deepEqual(state.targetResults, { macos: "PASSED" });
  assert.equal(state.evidenceValid, true);

  state = applyLocalDeliveryAction(state, "accept");
  assert.throws(() => applyLocalDeliveryAction(state, "advance"), /本机执行服务/);
  state = recordLocalMainValidation(state, mainEvidence(state));
  assert.equal(state.stage, "MFA_REQUIRED");
  assert.equal(state.mainSha, "a".repeat(40));
  assert.match(state.steamReleaseId, /^RELEASE-LOCAL-/);
  state = applyLocalDeliveryAction(state, "confirm-mfa");
  assert.match(state.mfaApprovalId, /^MFA-LOCAL-/);
  state = applyLocalDeliveryAction(state, "advance");
  assert.match(state.steamBuildId, /^BUILD-LOCAL-/);
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "EXTERNAL_APPROVAL_REQUIRED");
  assert.equal(state.externalGate, "VALVE_REVIEW");
  state = applyLocalDeliveryAction(state, "external-approve");
  assert.equal(state.stage, "EXTERNAL_APPROVAL_REQUIRED");
  assert.equal(state.externalGate, "FIRST_RELEASE");
  assert.deepEqual(state.externalApprovals, ["LOCAL_VALVE_REVIEW_APPROVED"]);
  state = applyLocalDeliveryAction(state, "external-approve");
  assert.equal(state.stage, "EXTERNAL_APPROVAL_REQUIRED");
  assert.equal(state.externalGate, "DEFAULT_BRANCH_CONFIRMATION");
  assert.deepEqual(state.externalApprovals, ["LOCAL_VALVE_REVIEW_APPROVED", "LOCAL_FIRST_RELEASE_COMPLETED"]);
  state = applyLocalDeliveryAction(state, "external-approve");
  assert.equal(state.stage, "RELEASED");
  assert.equal(state.externalGate, null);
  assert.deepEqual(state.externalApprovals, [
    "LOCAL_VALVE_REVIEW_APPROVED", "LOCAL_FIRST_RELEASE_COMPLETED", "LOCAL_DEFAULT_BRANCH_CONFIRMED",
  ]);
  assert.match(state.events[0].message, /未调用真实 Steam/);
});

test("a one-platform local run completes E2E without inventing unselected gates", () => {
  const initial = createLocalDelivery("project-windows-only");
  let state = approveLocalSpec(
    initial,
    "SPEC-WINDOWS-001",
    "RUN-WINDOWS-001",
    initial.lockedProfile,
    ["windows"],
  );
  assert.deepEqual(state.targetMatrix, ["windows"]);
  assert.deepEqual(state.targetResults, { windows: "QUEUED" });
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  assert.deepEqual(state.targetResults, { windows: "RUNNING" });
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "AWAITING_ACCEPTANCE");
  assert.deepEqual(state.targetResults, { windows: "PASSED" });
  state = invalidateLocalDelivery(state, "SPEC-WINDOWS-002");
  assert.deepEqual(state.targetMatrix, ["windows"]);
  assert.deepEqual(state.targetResults, { windows: "INVALIDATED" });
});

test("a selected matrix keeps its frozen order and rejects evidence from another matrix", () => {
  const initial = createLocalDelivery("project-ordered-matrix");
  let state = approveLocalSpec(
    initial,
    "SPEC-MATRIX-001",
    "RUN-MATRIX-001",
    initial.lockedProfile,
    ["macos", "linux"],
  );
  assert.deepEqual(state.targetMatrix, ["macos", "linux"]);
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  assert.throws(() => recordLocalValidation(state, {
    schemaVersion: 4,
    evidenceId: "EV-LOCAL-WRONG-MATRIX",
    status: "TESTS_PASSED",
    releaseGate: "LOCAL_VALIDATION_PASSED",
    candidateSha: "a".repeat(40),
    sourceDigest: "b".repeat(64),
    bundleDigest: "c".repeat(64),
    godotVersion: "4.6.2.stable",
    targetMatrix: ["linux", "macos"],
    platform: "macos",
    fixtureOnly: true,
    buildArtifact: macosBuild,
    checks: [{ name: "core-loop", status: "PASSED", durationMs: 4, detail: "fixture" }],
    createdAt: "2026-07-23T00:00:00.000Z",
  }), /目标矩阵不一致/);
  state = applyLocalDeliveryAction(state, "advance");
  assert.deepEqual(state.targetResults, { linux: "QUEUED", macos: "RUNNING" });
  state = applyLocalDeliveryAction(state, "advance");
  assert.deepEqual(state.targetResults, { linux: "RUNNING", macos: "PASSED" });
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "AWAITING_ACCEPTANCE");
  assert.deepEqual(state.targetResults, { linux: "PASSED", macos: "PASSED" });
});

test("feedback invalidates all local evidence and requires a new immutable approval", () => {
  let state = approveLocalSpec(createLocalDelivery("project-feedback"), "SPEC-008", "RUN-LOCAL-2");
  state = recordLocalValidation(state, {
    schemaVersion: 4,
    evidenceId: "EV-LOCAL-TEST",
    status: "TESTS_PASSED",
    releaseGate: "LOCAL_VALIDATION_PASSED",
    candidateSha: "a".repeat(40),
    sourceDigest: "b".repeat(64),
    bundleDigest: "c".repeat(64),
    godotVersion: "4.6.2.stable",
    targetMatrix: state.targetMatrix,
    platform: "macos",
    fixtureOnly: true,
    buildArtifact: macosBuild,
    checks: [
      { name: "core-loop", status: "PASSED", durationMs: 4, detail: "fixture" },
      { name: "macos-export-boot", status: "PASSED", durationMs: 1, detail: "exported app booted" },
    ],
    createdAt: "2026-07-18T00:00:00.000Z",
  });
  assert.equal(state.stage, "CANDIDATE_READY");
  assert.equal(state.localValidation.valid, true);
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "AWAITING_ACCEPTANCE");
  state = invalidateLocalDelivery(state, "SPEC-009");
  assert.equal(state.stage, "AWAITING_SPEC_APPROVAL");
  assert.equal(state.evidenceValid, false);
  assert.deepEqual(state.targetResults, { linux: "INVALIDATED", windows: "INVALIDATED", macos: "INVALIDATED" });
  assert.equal(state.runId, null);
  assert.equal(state.candidateSha, null);
  assert.equal(state.candidatePr, null);
  assert.equal(state.localValidation.valid, false);
  assert.throws(() => applyLocalDeliveryAction(state, "advance"), /先批准/);
});

test("local main-gate failure freezes evidence, revokes release authority and requires a new spec", () => {
  const originalRunId = "RUN-project-main-failure";
  let state = localDeliveryAtAcceptedCandidate("project-main-failure");
  state = recordLocalMainValidation(state, mainEvidence(state, "waiting"));
  assert.equal(state.stage, "MAIN_GATE_RUNNING");
  assert.equal(state.mainSha, "a".repeat(40));

  state = applyLocalDeliveryAction(state, "main-gate-fail");
  assert.equal(state.stage, "AWAITING_SPEC_APPROVAL");
  assert.equal(state.runId, null);
  assert.equal(state.mainSha, null);
  assert.equal(state.candidateSha, null);
  assert.equal(state.steamBranch, null);
  assert.equal(state.evidenceValid, false);
  assert.deepEqual(state.targetResults, { macos: "INVALIDATED" });
  assert.equal(state.repairHandoff.reason, "MAIN_GATE_FAILURE");
  assert.equal(state.repairHandoff.baselineMainSha, "a".repeat(40));
  assert.equal(state.repairHandoff.previousRunId, originalRunId);
  assert.deepEqual(state.repairHandoff.revokedAuthorities, [
    "MAIN_SHA", "MFA", "STEAM_BUILD", "STEAM_RELEASE", "EXTERNAL_APPROVALS",
  ]);
  assert.throws(() => applyLocalDeliveryAction(state, "advance"), /先批准/);

  state = invalidateLocalDelivery(state, "SPEC-POST-MERGE-002");
  assert.equal(state.repairHandoff, null);
  state = approveLocalSpec(state, "SPEC-POST-MERGE-002", "RUN-project-main-failure-2");
  assert.equal(state.stage, "AGENT_QUEUED");
  assert.equal(state.runId, "RUN-project-main-failure-2");
});

test("local Steam reinstall failure clears Beta authority before human revision", () => {
  let state = localDeliveryAtAcceptedCandidate("project-steam-failure");
  state = recordLocalMainValidation(state, mainEvidence(state));
  state = applyLocalDeliveryAction(state, "confirm-mfa");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "STEAM_REINSTALL_E2E");
  assert.equal(state.steamBranch, "local-password-beta");
  assert.match(state.mfaApprovalId, /^MFA-LOCAL-/);
  assert.match(state.steamBuildId, /^BUILD-LOCAL-/);
  assert.match(state.steamReleaseId, /^RELEASE-LOCAL-/);

  state = applyLocalDeliveryAction(state, "steam-reinstall-fail");
  assert.equal(state.stage, "AWAITING_SPEC_APPROVAL");
  assert.equal(state.repairHandoff.reason, "STEAM_INSTALL_FAILURE");
  assert.equal(state.repairHandoff.baselineMainSha, "a".repeat(40));
  assert.equal(state.steamBranch, null);
  assert.equal(state.mfaApprovalId, null);
  assert.equal(state.steamBuildId, null);
  assert.equal(state.steamReleaseId, null);
  assert.deepEqual(state.externalApprovals, []);
  assert.equal(state.events[0].type, "STEAM_REINSTALL_FAILED");
  assert.match(state.events[0].message, /旧发布权限已撤销/);
});

test("failed local validation is auditable but cannot advance the candidate gate", () => {
  let state = approveLocalSpec(createLocalDelivery("project-failed"), "SPEC-010", "RUN-LOCAL-FAILED");
  state = recordLocalValidation(state, {
    schemaVersion: 4,
    evidenceId: "EV-LOCAL-FAILED",
    status: "FAILED",
    releaseGate: "TESTS_FAILED",
    candidateSha: "d".repeat(40),
    sourceDigest: "e".repeat(64),
    bundleDigest: "f".repeat(64),
    godotVersion: "4.6.2.stable",
    targetMatrix: state.targetMatrix,
    platform: "macos",
    fixtureOnly: true,
    buildArtifact: null,
    checks: [{ name: "macos-export", status: "FAILED", durationMs: 3, detail: "configuration error" }],
    createdAt: "2026-07-18T00:00:00.000Z",
  });
  assert.equal(state.stage, "CANDIDATE_READY");
  assert.equal(state.localValidation.valid, true);
  assert.equal(state.events[0].type, "LOCAL_GODOT_VALIDATION_FAILED");
  assert.throws(() => applyLocalDeliveryAction(state, "advance"), /验证失败/);
});

test("local validation without an explicit execution-platform binding fails closed", () => {
  const state = approveLocalSpec(createLocalDelivery("project-missing-platform"), "SPEC-011", "RUN-MISSING-PLATFORM");
  assert.throws(() => recordLocalValidation(state, {
    schemaVersion: 4,
    evidenceId: "EV-LOCAL-MISSING-PLATFORM",
    status: "TESTS_PASSED",
    releaseGate: "LOCAL_VALIDATION_PASSED",
    candidateSha: "a".repeat(40),
    sourceDigest: "b".repeat(64),
    bundleDigest: "c".repeat(64),
    godotVersion: "4.6.2.stable",
    targetMatrix: state.targetMatrix,
    checks: [{ name: "core-loop", status: "PASSED", durationMs: 3, detail: "unbound fixture" }],
    createdAt: "2026-07-23T00:00:00.000Z",
  }), /缺少真实执行平台绑定/);
});

test("a passed local validation without a manifest-bound build cannot authorize delivery", () => {
  const state = approveLocalSpec(createLocalDelivery("project-missing-build"), "SPEC-012", "RUN-MISSING-BUILD");
  assert.throws(() => recordLocalValidation(state, {
    schemaVersion: 4,
    evidenceId: "EV-LOCAL-MISSING-BUILD",
    status: "TESTS_PASSED",
    releaseGate: "LOCAL_VALIDATION_PASSED",
    candidateSha: "a".repeat(40), sourceDigest: "b".repeat(64), bundleDigest: "c".repeat(64),
    godotVersion: "4.6.2.stable", targetMatrix: state.targetMatrix,
    platform: "macos", fixtureOnly: true, buildArtifact: null,
    checks: [{ name: "macos-export", status: "PASSED", durationMs: 3, detail: "unbound export" }],
    createdAt: "2026-07-23T00:00:00.000Z",
  }), /缺少绑定的 macOS 构建物/);
});

test("a passed v4 validation without an exported-app boot result cannot authorize delivery", () => {
  const state = approveLocalSpec(createLocalDelivery("project-missing-export-boot"), "SPEC-013", "RUN-MISSING-EXPORT-BOOT");
  assert.throws(() => recordLocalValidation(state, {
    schemaVersion: 4,
    evidenceId: "EV-LOCAL-MISSING-EXPORT-BOOT",
    status: "TESTS_PASSED",
    releaseGate: "LOCAL_VALIDATION_PASSED",
    candidateSha: "a".repeat(40), sourceDigest: "b".repeat(64), bundleDigest: "c".repeat(64),
    godotVersion: "4.6.2.stable", targetMatrix: state.targetMatrix,
    platform: "macos", fixtureOnly: true, buildArtifact: macosBuild,
    checks: [{ name: "macos-export", status: "PASSED", durationMs: 3, detail: "archive created" }],
    createdAt: "2026-07-23T00:00:00.000Z",
  }), /缺少导出交付包的启动与退出证据/);
});

test("missing export templates remain auditable but cannot authorize target E2E", () => {
  let state = approveLocalSpec(createLocalDelivery("project-export-wait"), "SPEC-EXPORT-001", "RUN-EXPORT-WAIT");
  state = recordLocalValidation(state, {
    schemaVersion: 4,
    evidenceId: "EV-LOCAL-WAITING",
    status: "WAITING_DEPENDENCY",
    releaseGate: "WAITING_EXPORT_TEMPLATES",
    candidateSha: "1".repeat(40),
    sourceDigest: "2".repeat(64),
    bundleDigest: "3".repeat(64),
    godotVersion: "4.6.2.stable",
    targetMatrix: state.targetMatrix,
    platform: "macos",
    fixtureOnly: true,
    buildArtifact: null,
    checks: [{ name: "macos-export", status: "WAITING_DEPENDENCY", durationMs: 3, detail: "templates missing" }],
    createdAt: "2026-07-18T00:00:00.000Z",
  });
  assert.equal(state.stage, "CANDIDATE_READY");
  assert.equal(state.localValidation.valid, true);
  assert.equal(state.evidenceValid, false);
  assert.deepEqual(state.targetResults, { linux: "INVALIDATED", windows: "INVALIDATED", macos: "INVALIDATED" });
  assert.equal(state.events[0].type, "LOCAL_GODOT_DEPENDENCY_WAIT");
  assert.throws(
    () => applyLocalDeliveryAction(state, "advance"),
    (error) => error?.code === "LOCAL_EXPORT_TEMPLATES_REQUIRED" && /不能启动目标矩阵/.test(error.message),
  );
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

test("local cancellation invalidates evidence and revokes unreleased authority", () => {
  let state = approveLocalSpec(createLocalDelivery("project-cancel"), "SPEC-CANCEL-001", "RUN-CANCEL-001");
  state = applyLocalDeliveryAction(state, "advance");
  state = { ...state, evidenceValid: true, mainSha: "f21c0de", steamBranch: "local-password-beta" };
  state = applyLocalDeliveryAction(state, "cancel");
  assert.equal(state.stage, "CANCELLED");
  assert.equal(state.evidenceValid, false);
  assert.equal(state.steamBranch, null);
  assert.deepEqual(state.targetResults, { linux: "INVALIDATED", windows: "INVALIDATED", macos: "INVALIDATED" });
  assert.equal(state.events[0].type, "DELIVERY_CANCELLED");
  assert.throws(() => applyLocalDeliveryAction(state, "advance"), /已取消/);
  assert.throws(() => applyLocalDeliveryAction(state, "cancel"), /越过可取消边界/);
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
    modelRoles: state.lockedProfile.modelRoles,
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
  assert.throws(
    () => recordLocalAgentExecution({
      ...state,
      lockedProfile: { ...state.lockedProfile, agentVersionAttestation: null },
    }, receipt),
    /不可变任务锁/,
  );
  assert.throws(
    () => recordLocalAgentExecution({
      ...state,
      lockedProfile: {
        ...state.lockedProfile,
        agentVersionAttestation: {
          ...state.lockedProfile.agentVersionAttestation,
          validationReceiptDigest: "sha256:truncated",
        },
      },
    }, receipt),
    /不可变任务锁/,
  );
  state = recordLocalAgentExecution(state, receipt);
  assert.equal(state.stage, "CANDIDATE_READY");
  assert.equal(state.candidateSha, receipt.candidate.commitSha);
  assert.equal(state.agentExecution.valid, true);
  assert.equal(state.events[0].type, "AGENT_CANDIDATE_RECORDED");
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  state = invalidateLocalDelivery(state, "SPEC-013");
  assert.equal(state.agentExecution.valid, false);
});

test("legacy Agent evidence without a complete model-role lock fails closed", () => {
  const state = approveLocalSpec(createLocalDelivery("project-legacy-agent"), "SPEC-LEGACY-001", "RUN-LEGACY-001");
  const legacy = {
    ...state,
    agentExecution: {
      schemaVersion: 1,
      valid: true,
      tenantId: "tenant-local",
      projectId: state.projectId,
      runId: state.runId,
      model: state.lockedProfile.model,
    },
  };

  const normalized = normalizeLocalDeliverySnapshot(legacy);
  assert.equal(normalized.agentExecution.valid, false);
  assert.deepEqual(normalized.agentExecution.modelRoles, state.lockedProfile.modelRoles);
});

test("historical delivery snapshots derive the legacy matrix but fail old evidence closed", () => {
  const current = approveLocalSpec(createLocalDelivery("project-legacy-matrix"), "SPEC-LEGACY-002", "RUN-LEGACY-002");
  const legacy = {
    ...current,
    targetMatrix: undefined,
    localValidation: {
      evidenceId: "EV-LOCAL-LEGACY",
      status: "TESTS_PASSED",
      releaseGate: "LOCAL_VALIDATION_PASSED",
      candidateSha: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      bundleDigest: "c".repeat(64),
      godotVersion: "4.6.2.stable",
      checks: [{ name: "core-loop", status: "PASSED", durationMs: 4, detail: "legacy fixture" }],
      createdAt: "2026-07-18T00:00:00.000Z",
      valid: true,
    },
  };

  const normalized = normalizeLocalDeliverySnapshot(legacy);
  assert.deepEqual(normalized.targetMatrix, ["linux", "windows", "macos"]);
  assert.deepEqual(normalized.localValidation.targetMatrix, normalized.targetMatrix);
  assert.equal(normalized.localValidation.valid, false);
});

test("a pre-v4 passed snapshot rewinds to candidate validation instead of retaining acceptance authority", () => {
  let candidate = approveLocalSpec(createLocalDelivery("project-legacy-build"), "SPEC-LEGACY-BUILD", "RUN-LEGACY-BUILD", undefined, ["macos"]);
  for (let index = 0; index < 4; index += 1) candidate = applyLocalDeliveryAction(candidate, "advance");
  assert.equal(candidate.stage, "AWAITING_ACCEPTANCE");
  const normalized = normalizeLocalDeliverySnapshot({
    ...candidate,
    localValidation: {
      evidenceId: "EV-LOCAL-LEGACY-BUILD", status: "TESTS_PASSED", releaseGate: "LOCAL_VALIDATION_PASSED",
      candidateSha: "a".repeat(40), sourceDigest: "b".repeat(64), bundleDigest: "c".repeat(64),
      godotVersion: "4.6.2.stable", targetMatrix: ["macos"], platform: "macos", fixtureOnly: true,
      checks: [{ name: "macos-export", status: "PASSED", durationMs: 4, detail: "legacy export" }],
      createdAt: "2026-07-22T00:00:00.000Z", valid: true,
    },
  });
  assert.equal(normalized.stage, "CANDIDATE_READY");
  assert.equal(normalized.evidenceValid, false);
  assert.equal(normalized.localValidation.valid, false);
  assert.equal(normalized.localValidation.buildArtifact, null);
  assert.deepEqual(normalized.targetResults, { macos: "QUEUED" });
  assert.throws(() => applyLocalDeliveryAction(normalized, "accept"), /缺少可验收/);
});

test("feedback cannot bypass candidate E2E or invent an early revision", () => {
  const queued = approveLocalSpec(createLocalDelivery("project-feedback-gate"), "SPEC-001", "RUN-FEEDBACK-GATE");
  assert.throws(
    () => invalidateLocalDelivery(queued, "SPEC-002"),
    /等待用户验收.*人工修复接管/,
  );
  const candidate = applyLocalDeliveryAction(applyLocalDeliveryAction(queued, "advance"), "advance");
  assert.equal(candidate.stage, "CANDIDATE_READY");
  assert.throws(
    () => invalidateLocalDelivery(candidate, "SPEC-002"),
    /等待用户验收.*人工修复接管/,
  );
});

test("candidate acceptance revalidates the PR, commit and complete target evidence", () => {
  let candidate = approveLocalSpec(createLocalDelivery("project-acceptance-gate"), "SPEC-001", "RUN-ACCEPTANCE-GATE");
  for (let index = 0; index < 6; index += 1) candidate = applyLocalDeliveryAction(candidate, "advance");
  assert.equal(candidate.stage, "AWAITING_ACCEPTANCE");
  assert.equal(applyLocalDeliveryAction(candidate, "accept").stage, "MERGING");
  assert.throws(
    () => applyLocalDeliveryAction({ ...candidate, evidenceValid: false }, "accept"),
    /缺少可验收的提交、PR 或完整目标矩阵证据/,
  );
  assert.throws(
    () => applyLocalDeliveryAction({ ...candidate, candidatePr: null }, "accept"),
    /缺少可验收的提交、PR 或完整目标矩阵证据/,
  );
  assert.throws(
    () => applyLocalDeliveryAction({ ...candidate, candidateSha: null }, "accept"),
    /缺少可验收的提交、PR 或完整目标矩阵证据/,
  );
  assert.throws(
    () => applyLocalDeliveryAction({
      ...candidate,
      targetResults: { ...candidate.targetResults, windows: "INVALIDATED" },
    }, "accept"),
    /缺少可验收的提交、PR 或完整目标矩阵证据/,
  );
});
