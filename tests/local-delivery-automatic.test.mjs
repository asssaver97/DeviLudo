import assert from "node:assert/strict";
import test from "node:test";

import { runLocalDeliveryUntilHumanGate } from "../lib/local-delivery/automatic.ts";
import { commandLocalDelivery, saveLocalAgentExecution, saveLocalMainValidation, saveLocalSteamReinstall, saveLocalValidation, startLocalDelivery } from "../lib/local-delivery/store.ts";

const macosBuild = Object.freeze({
  fileName: "DeviLudoLocal.zip", platform: "macos", contentType: "application/zip",
  sha256: "9".repeat(64), sizeBytes: 4096,
});

const macosMainBuild = Object.freeze({
  fileName: "DeviLudoMain.zip", platform: "macos", contentType: "application/zip",
  sha256: "8".repeat(64), sizeBytes: 8192,
});

function passingValidation(projectId, delivery, commandKey) {
  return saveLocalValidation(projectId, {
    schemaVersion: 4,
    evidenceId: "EV-LOCAL-AABBCCDDEEFF",
    status: "TESTS_PASSED",
    releaseGate: "LOCAL_VALIDATION_PASSED",
    candidateSha: "a".repeat(40),
    sourceDigest: "b".repeat(64),
    bundleDigest: "c".repeat(64),
    godotVersion: "4.6.2.stable",
    targetMatrix: delivery.targetMatrix,
    platform: "macos",
    fixtureOnly: true,
    buildArtifact: macosBuild,
    checks: [
      { name: "import", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "boot", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "core-loop", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "save-load", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "macos-export-boot", status: "PASSED", durationMs: 1, detail: "exported app booted" },
    ],
    createdAt: "2026-07-23T00:00:00.000Z",
  }, commandKey);
}

function agentReceipt(delivery) {
  const candidate = {
    scmProxy: "local-git-proxy-v1",
    branch: "deviludo/automatic/agent-candidate",
    baseCommitSha: "1".repeat(40),
    commitSha: "2".repeat(40),
    sourceDigest: "3".repeat(64),
    changedFiles: ["project.godot", "scripts/main.gd"],
    draftPullRequest: null,
  };
  return {
    schemaVersion: 1,
    tenantId: "tenant-local",
    projectId: delivery.projectId,
    runId: delivery.runId,
    attemptId: `ATT-${delivery.runId}`,
    specRevisionId: delivery.specRevisionId,
    testPlanRevisionId: delivery.lockedProfile.testPlanRevisionId,
    profileRevisionId: delivery.lockedProfile.profileRevisionId,
    installationId: delivery.lockedProfile.installationId,
    imageDigest: delivery.lockedProfile.imageDigest,
    adapterVersion: delivery.lockedProfile.adapterVersion,
    providerRevisionId: delivery.lockedProfile.providerRevisionId,
    credentialVersionId: delivery.lockedProfile.credentialVersionId,
    model: delivery.lockedProfile.model,
    modelRoles: delivery.lockedProfile.modelRoles,
    agent: delivery.lockedProfile.agent,
    budget: delivery.lockedProfile.budget,
    timeoutSeconds: delivery.lockedProfile.timeoutSeconds,
    promptDigest: "4".repeat(64),
    status: "completed",
    summary: "Implemented the exact approved specification.",
    usage: { inputTokens: 120, outputTokens: 40, costUsd: 0.2 },
    warnings: [],
    codeReviewReceipt: {
      schemaVersion: "deviludo.agent-code-review-receipt.v1", receiptId: `review-ATT-${delivery.runId}`,
      runId: delivery.runId, attemptId: `ATT-${delivery.runId}`,
      profileRevisionId: delivery.lockedProfile.profileRevisionId,
      installationId: delivery.lockedProfile.installationId,
      imageDigest: delivery.lockedProfile.imageDigest, model: delivery.lockedProfile.model,
      specRevisionId: delivery.specRevisionId, testPlanRevisionId: delivery.lockedProfile.testPlanRevisionId,
      sourceDigest: candidate.sourceDigest, verdict: "PASSED", reviewDigest: "5".repeat(64),
      findingCount: 0, warningCount: 0, reviewedAt: "2026-07-23T00:00:00.000Z",
    },
    candidate,
    completedAt: "2026-07-23T00:00:00.000Z",
  };
}

function passingAgentValidation(projectId, delivery, commandKey) {
  const receipt = delivery.agentExecution;
  return saveLocalValidation(projectId, {
    schemaVersion: 4, evidenceId: "EV-LOCAL-AGENTABC1234",
    status: "TESTS_PASSED", releaseGate: "LOCAL_VALIDATION_PASSED",
    candidateSha: receipt.candidate.commitSha, sourceDigest: receipt.candidate.sourceDigest,
    bundleDigest: "6".repeat(64), godotVersion: "4.6.2.stable",
    targetMatrix: delivery.targetMatrix, platform: "macos", fixtureOnly: false,
    sourceAuthority: {
      kind: "AGENT_CANDIDATE", attemptId: receipt.attemptId, branch: receipt.candidate.branch,
      baseCommitSha: receipt.candidate.baseCommitSha, candidateSha: receipt.candidate.commitSha,
      sourceDigest: receipt.candidate.sourceDigest,
    },
    buildArtifact: macosBuild,
    checks: [{ name: "macos-export-boot", status: "PASSED", durationMs: 1, detail: "agent export booted" }],
    createdAt: "2026-07-23T00:01:00.000Z",
  }, commandKey);
}

function passingMainValidation(projectId, delivery, commandKey) {
  const candidate = delivery.localValidation;
  return saveLocalMainValidation(projectId, {
    schemaVersion: 1,
    evidenceId: "EV-MAIN-AABBCCDDEEFF",
    status: "TESTS_PASSED",
    releaseGate: "MAIN_VALIDATION_PASSED",
    candidateEvidenceId: candidate.evidenceId,
    candidateBundleDigest: candidate.bundleDigest,
    candidateSha: candidate.candidateSha,
    sourceDigest: candidate.sourceDigest,
    mainSha: candidate.candidateSha,
    mainSourceDigest: candidate.sourceDigest,
    bundleDigest: "d".repeat(64),
    godotVersion: "4.6.2.stable",
    targetMatrix: delivery.targetMatrix,
    platform: "macos",
    fixtureOnly: true,
    buildArtifact: macosMainBuild,
    checks: [{ name: "macos-export-boot", status: "PASSED", durationMs: 1, detail: "main export booted" }],
    createdAt: "2026-07-23T00:01:00.000Z",
  }, commandKey);
}

function passingSteamReinstall(projectId, delivery, commandKey) {
  const main = delivery.mainValidation;
  return saveLocalSteamReinstall(projectId, {
    schemaVersion: 1,
    evidenceId: "EV-STEAM-AABBCCDDEEFF",
    bundleDigest: "e".repeat(64),
    status: "TESTS_PASSED",
    releaseGate: "LOCAL_STEAM_REINSTALL_PASSED",
    localOnly: true,
    branch: "local-password-beta",
    buildId: "BUILD-LOCAL-AABBCCDDEEFF",
    mainEvidenceId: main.evidenceId,
    mainBundleDigest: main.bundleDigest,
    mainSha: main.mainSha,
    mainSourceDigest: main.mainSourceDigest,
    mainArtifactSha256: main.buildArtifact.sha256,
    mfaApprovalId: delivery.mfaApprovalId,
    targetMatrix: ["macos"],
    platform: "macos",
    checks: [
      { name: "beta-package-integrity", status: "PASSED", durationMs: 1, detail: "matched" },
      { name: "clean-reinstall-boot", status: "PASSED", durationMs: 1, detail: "booted" },
    ],
    betaArtifact: {
      fileName: "DeviLudoLocalBeta.zip", platform: "macos", contentType: "application/zip",
      sha256: main.buildArtifact.sha256, sizeBytes: main.buildArtifact.sizeBytes,
    },
    createdAt: "2026-07-23T00:02:00.000Z",
  }, commandKey);
}

test("local automation runs selected-target E2E and stops at every human authority gate", async () => {
  const projectId = `auto-gates-${crypto.randomUUID()}`;
  const initial = await startLocalDelivery(
    projectId,
    "SPEC-AUTO-001",
    "RUN-AUTO-001",
    `start:${projectId}`,
    undefined,
    ["macos"],
  );
  assert.equal(initial.snapshot.stage, "AGENT_QUEUED");

  const candidate = await runLocalDeliveryUntilHumanGate(projectId, `auto:${projectId}:candidate`, passingValidation);
  assert.equal(candidate.stopReason, "USER_ACCEPTANCE_REQUIRED");
  assert.equal(candidate.snapshot.stage, "AWAITING_ACCEPTANCE");
  assert.equal(candidate.validationExecuted, true);
  assert.equal(candidate.automaticTransitions, 4);
  assert.deepEqual(candidate.snapshot.targetResults, { macos: "PASSED" });
  assert.equal(candidate.snapshot.evidenceValid, true);

  const replayAtGate = await runLocalDeliveryUntilHumanGate(projectId, `auto:${projectId}:candidate`, passingValidation);
  assert.equal(replayAtGate.snapshot.revision, candidate.snapshot.revision);
  assert.equal(replayAtGate.automaticTransitions, 0);
  assert.equal(replayAtGate.validationExecuted, false);

  await commandLocalDelivery(projectId, "accept", `accept:${projectId}`);
  const releaseCandidate = await runLocalDeliveryUntilHumanGate(projectId, `auto:${projectId}:main`, passingValidation, passingMainValidation);
  assert.equal(releaseCandidate.stopReason, "MFA_REQUIRED");
  assert.equal(releaseCandidate.snapshot.stage, "MFA_REQUIRED");
  assert.equal(releaseCandidate.automaticTransitions, 0);
  assert.equal(releaseCandidate.mainValidationExecuted, true);
  assert.equal(releaseCandidate.snapshot.mainSha, "a".repeat(40));
  assert.equal(releaseCandidate.snapshot.mfaApprovalId, null);

  await commandLocalDelivery(projectId, "confirm-mfa", `mfa:${projectId}`);
  const beta = await runLocalDeliveryUntilHumanGate(
    projectId, `auto:${projectId}:beta`, passingValidation, passingMainValidation, passingSteamReinstall,
  );
  assert.equal(beta.stopReason, "EXTERNAL_APPROVAL_REQUIRED");
  assert.equal(beta.snapshot.stage, "EXTERNAL_APPROVAL_REQUIRED");
  assert.equal(beta.automaticTransitions, 1);
  assert.equal(beta.steamReinstallExecuted, true);
  assert.equal(beta.snapshot.steamReinstall.releaseGate, "LOCAL_STEAM_REINSTALL_PASSED");
  assert.equal(beta.snapshot.externalGate, "VALVE_REVIEW");
  assert.deepEqual(beta.snapshot.externalApprovals, []);
});

test("local automation executes a READY Agent candidate before Godot E2E", async () => {
  const projectId = `auto-real-agent-${crypto.randomUUID()}`;
  await startLocalDelivery(projectId, "SPEC-040", "RUN-AUTO-REAL-AGENT", `start:${projectId}`, undefined, ["macos"]);
  let agentCalls = 0;
  const agentRunner = async (id, delivery, commandKey) => {
    agentCalls += 1;
    const receipt = agentReceipt(delivery);
    const saved = await saveLocalAgentExecution(id, receipt, commandKey);
    return { kind: "COMPLETED", receipt, snapshot: saved.snapshot, replayed: saved.replayed };
  };
  const result = await runLocalDeliveryUntilHumanGate(
    projectId,
    `auto:${projectId}`,
    passingAgentValidation,
    undefined,
    undefined,
    agentRunner,
  );
  assert.equal(agentCalls, 1);
  assert.equal(result.stopReason, "USER_ACCEPTANCE_REQUIRED");
  assert.equal(result.snapshot.stage, "AWAITING_ACCEPTANCE");
  assert.equal(result.agentExecutionAttempted, true);
  assert.equal(result.developmentMode, "REAL_AGENT");
  assert.equal(result.fixtureFallbackCode, null);
  assert.equal(result.snapshot.agentExecution.valid, true);
  assert.equal(result.snapshot.localValidation.fixtureOnly, false);
  assert.equal(result.snapshot.localValidation.sourceAuthority.kind, "AGENT_CANDIDATE");
});

test("local automation waits for the locked Provider and refuses a silent Fixture fallback", async () => {
  const projectId = `auto-provider-probe-${crypto.randomUUID()}`;
  const started = await startLocalDelivery(projectId, "SPEC-041", "RUN-AUTO-PROVIDER-PROBE", `start:${projectId}`);
  const result = await runLocalDeliveryUntilHumanGate(
    projectId,
    `auto:${projectId}`,
    passingValidation,
    undefined,
    undefined,
    async () => ({ kind: "BLOCKED", code: "WAITING_PROVIDER", message: "provider unavailable", status: 409 }),
  );
  assert.equal(result.stopReason, "WAITING_PROVIDER");
  assert.equal(result.snapshot.stage, "WAITING_PROVIDER");
  assert.equal(result.snapshot.runId, started.snapshot.runId);
  assert.equal(result.developmentMode, null);
  assert.equal(result.fixtureFallbackCode, "WAITING_PROVIDER");
});

test("local automation refuses Fixture fallback after a READY preflight without an executor", async () => {
  const projectId = `auto-executor-gate-${crypto.randomUUID()}`;
  await startLocalDelivery(projectId, "SPEC-042", "RUN-AUTO-EXECUTOR-GATE", `start:${projectId}`);
  const result = await runLocalDeliveryUntilHumanGate(
    projectId,
    `auto:${projectId}`,
    passingValidation,
    undefined,
    undefined,
    async () => ({
      kind: "BLOCKED", code: "LOCAL_AGENT_EXECUTOR_NOT_CONFIGURED",
      message: "executor unavailable", status: 503,
    }),
  );
  assert.equal(result.stopReason, "LOCAL_AGENT_EXECUTOR_REQUIRED");
  assert.equal(result.snapshot.stage, "AGENT_QUEUED");
  assert.equal(result.automaticTransitions, 0);
  assert.equal(result.fixtureFallbackCode, "LOCAL_AGENT_EXECUTOR_NOT_CONFIGURED");
});

test("local automation converges to the authoritative cancelled state when an active Agent is stopped", async () => {
  const projectId = `auto-agent-cancel-${crypto.randomUUID()}`;
  await startLocalDelivery(projectId, "SPEC-043", "RUN-AUTO-AGENT-CANCEL", `start:${projectId}`);
  const result = await runLocalDeliveryUntilHumanGate(
    projectId,
    `auto:${projectId}`,
    passingValidation,
    undefined,
    undefined,
    async () => {
      await commandLocalDelivery(projectId, "cancel", `cancel:${projectId}`);
      return {
        kind: "BLOCKED",
        code: "LOCAL_AGENT_RUN_CANCELLED",
        message: "active Agent stopped",
        status: 409,
      };
    },
  );
  assert.equal(result.stopReason, "TERMINAL");
  assert.equal(result.snapshot.stage, "CANCELLED");
  assert.equal(result.developmentMode, null);
  assert.equal(result.fixtureFallbackCode, "LOCAL_AGENT_RUN_CANCELLED");
});

test("local automation persists a dependency wait and cannot bypass it", async () => {
  const projectId = `auto-wait-${crypto.randomUUID()}`;
  await startLocalDelivery(projectId, "SPEC-AUTO-WAIT", "RUN-AUTO-WAIT", `start:${projectId}`);
  const waitingValidation = (id, delivery, commandKey) => saveLocalValidation(id, {
    schemaVersion: 4,
    evidenceId: "EV-LOCAL-112233445566",
    status: "WAITING_DEPENDENCY",
    releaseGate: "WAITING_EXPORT_TEMPLATES",
    candidateSha: "d".repeat(40),
    sourceDigest: "e".repeat(64),
    bundleDigest: "f".repeat(64),
    godotVersion: "4.6.2.stable",
    targetMatrix: delivery.targetMatrix,
    platform: "macos",
    fixtureOnly: true,
    buildArtifact: null,
    checks: [
      { name: "import", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "boot", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "core-loop", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "macos-export", status: "WAITING_DEPENDENCY", durationMs: 1, detail: "templates missing" },
    ],
    createdAt: "2026-07-23T00:00:00.000Z",
  }, commandKey);

  const result = await runLocalDeliveryUntilHumanGate(projectId, `auto:${projectId}`, waitingValidation);
  assert.equal(result.stopReason, "LOCAL_EXPORT_TEMPLATES_REQUIRED");
  assert.equal(result.snapshot.stage, "CANDIDATE_READY");
  assert.equal(result.snapshot.evidenceValid, false);
  assert.equal(result.snapshot.localValidation.releaseGate, "WAITING_EXPORT_TEMPLATES");
  assert.ok(Object.values(result.snapshot.targetResults).every((status) => status === "INVALIDATED"));
});

test("local automation never converts macOS fixture evidence into Linux or Windows passes", async () => {
  const projectId = `auto-physical-runner-${crypto.randomUUID()}`;
  await startLocalDelivery(
    projectId,
    "SPEC-AUTO-PHYSICAL",
    "RUN-AUTO-PHYSICAL",
    `start:${projectId}`,
    undefined,
    ["linux", "macos", "windows"],
  );
  const result = await runLocalDeliveryUntilHumanGate(projectId, `auto:${projectId}`, passingValidation);
  assert.equal(result.stopReason, "PHYSICAL_RUNNERS_REQUIRED");
  assert.equal(result.snapshot.stage, "CANDIDATE_READY");
  assert.deepEqual(result.requiredPhysicalPlatforms, ["linux", "windows"]);
  assert.deepEqual(result.snapshot.targetResults, {
    linux: "QUEUED",
    macos: "QUEUED",
    windows: "QUEUED",
  });
  assert.equal(result.snapshot.evidenceValid, false);
  assert.equal(result.snapshot.localValidation.platform, "macos");
});

test("local automation preserves the locked run while its Provider is waiting", async () => {
  const projectId = `auto-provider-${crypto.randomUUID()}`;
  const started = await startLocalDelivery(projectId, "SPEC-AUTO-PROVIDER", "RUN-AUTO-PROVIDER", `start:${projectId}`);
  await commandLocalDelivery(projectId, "provider-fail", `provider-fail:${projectId}`);
  const result = await runLocalDeliveryUntilHumanGate(projectId, `auto:${projectId}`, passingValidation);
  assert.equal(result.stopReason, "WAITING_PROVIDER");
  assert.equal(result.snapshot.stage, "WAITING_PROVIDER");
  assert.equal(result.snapshot.runId, started.snapshot.runId);
  assert.deepEqual(result.snapshot.lockedProfile, started.snapshot.lockedProfile);
  assert.equal(result.automaticTransitions, 0);
  assert.equal(result.validationExecuted, false);
});
