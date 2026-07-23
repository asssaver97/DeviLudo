import assert from "node:assert/strict";
import test from "node:test";

import { runLocalDeliveryUntilHumanGate } from "../lib/local-delivery/automatic.ts";
import { commandLocalDelivery, saveLocalMainValidation, saveLocalSteamReinstall, saveLocalValidation, startLocalDelivery } from "../lib/local-delivery/store.ts";

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
