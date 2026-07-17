import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { RunnerEvent } from "../../../lib/domain/e2e";
import type { TargetPlatform } from "../../../lib/domain/types";
import {
  RunnerMatrixCoordinator,
  createPlatformEvidenceManifest,
  createRunnerCapabilityDigest,
  verifyRunnerJob,
} from "../src/coordinator";
import type {
  MatrixAttemptSpec,
  PlatformEvidenceManifest,
  RunnerCapabilities,
  SignedRunnerJob,
  TlsRunnerIdentity,
} from "../src/contracts";
import { parseSpiffeId } from "../src/tls-identity";

const digest = (character: string) => character.repeat(64);
const commit = "8b7e4a2b7c9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f";
const issuedAt = "2030-01-01T00:00:00.000Z";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function identity(runnerId: string, character: string): TlsRunnerIdentity {
  return {
    spiffeId: `spiffe://deviludo.test/e2e-runner/${runnerId}`,
    certificateFingerprint: digest(character),
    certificateSerial: `serial-${runnerId}`,
    certificateNotAfter: "2031-01-01T00:00:00.000Z",
  };
}

function capabilities(runnerId: string, platform: TargetPlatform, character: string): RunnerCapabilities {
  const core = {
    runnerId,
    platform,
    architecture: platform === "macos" ? "arm64" as const : "x86_64" as const,
    osVersion: `${platform}-2030.1`,
    runnerImageDigest: digest(character),
    godotVersion: "4.6.2.stable.official.71f334935",
    godotBinaryDigest: digest("d"),
    exportTemplatesDigest: templates[platform],
    gpu: platform === "macos" ? "Apple M4" : "virtual-vulkan",
    display: "virtual" as const,
    audio: "virtual" as const,
    installedAutonomousAgents: [] as readonly string[],
  };
  return { ...core, capabilityDigest: createRunnerCapabilityDigest(core) };
}

const templates: Record<TargetPlatform, string> = {
  windows: digest("1"),
  linux: digest("2"),
  macos: digest("3"),
};

function attempt(attemptId = "attempt-matrix-1", matrix: readonly TargetPlatform[] = ["windows", "linux", "macos"]): MatrixAttemptSpec {
  return {
    attemptId,
    executionLockId: "99999999-9999-4999-8999-999999999999",
    executionLockDigest: digest("0"),
    tenantId: "tenant-1",
    projectId: "project-1",
    runId: "run-1",
    iterationId: "iteration-1",
    commitSha: commit,
    sourceDigest: digest("a"),
    sourceArtifact: { objectKey: `tenants/random/project-1/${attemptId}/source.tar.zst`, digest: digest("a") },
    specRevisionId: "spec-r7",
    specDigest: digest("b"),
    testPlanDigest: digest("c"),
    targetMatrix: matrix,
    requiredGodotVersion: "4.6.2.stable.official.71f334935",
    godotTestKitDigest: digest("4"),
    exportTemplates: templates,
    buildManifestDigest: digest("5"),
    sbomDigest: digest("6"),
    vulnerabilityScanDigest: digest("7"),
    assetLicenseLedgerDigest: digest("8"),
    leaseDurationSeconds: 60,
  };
}

function coordinator() {
  return new RunnerMatrixCoordinator({
    signer: { keyId: "runner-jobs-2030-q1", privateKey },
    admission: {
      async authorize({ identity: tlsIdentity, capabilities: runner }) {
        return tlsIdentity.spiffeId === `spiffe://deviludo.test/e2e-runner/${runner.runnerId}`;
      },
    },
  });
}

function started(job: SignedRunnerJob): RunnerEvent {
  return {
    attemptId: job.payload.attemptId,
    runnerId: job.payload.runnerId,
    fencingToken: job.payload.fencingToken,
    seqNo: 1,
    commitSha: job.payload.commitSha,
    sourceDigest: job.payload.sourceDigest,
    platform: job.payload.platform,
    type: "STARTED",
    status: "RUNNING",
    artifactDigest: null,
    occurredAt: "2030-01-01T00:00:01.000Z",
  };
}

function evidence(job: SignedRunnerJob, status: "PASSED" | "FAILED" = "PASSED"): PlatformEvidenceManifest {
  return createPlatformEvidenceManifest({
    schemaVersion: "deviludo.platform-evidence.v1",
    attemptId: job.payload.attemptId,
    fencingToken: job.payload.fencingToken,
    commitSha: job.payload.commitSha,
    sourceDigest: job.payload.sourceDigest,
    specRevisionId: job.payload.specRevisionId,
    specDigest: job.payload.specDigest,
    testPlanDigest: job.payload.testPlanDigest,
    targetMatrix: job.payload.targetMatrix,
    godotTestKitDigest: job.payload.godotTestKitDigest,
    exportTemplatesDigest: job.payload.exportTemplatesDigest,
    platform: job.payload.platform,
    runnerId: job.payload.runnerId,
    runnerCapabilityDigest: job.payload.runnerCapabilityDigest,
    exportDigest: digest(job.payload.platform === "windows" ? "9" : job.payload.platform === "linux" ? "e" : "f"),
    logsDigest: digest("1"),
    junitDigest: digest("2"),
    inputTimelineDigest: digest("3"),
    screenshotManifestDigest: digest("4"),
    videoManifestDigest: digest("5"),
    status,
    createdAt: "2030-01-01T00:00:02.000Z",
  });
}

function completed(job: SignedRunnerJob, manifest: PlatformEvidenceManifest): RunnerEvent {
  return {
    ...started(job),
    seqNo: 2,
    type: "PLATFORM_COMPLETED",
    status: manifest.status,
    artifactDigest: manifest.manifestDigest,
    occurredAt: "2030-01-01T00:00:03.000Z",
  };
}

test("registers only admitted mTLS identities and issues exact signed platform jobs", async () => {
  const control = coordinator();
  const runner = capabilities("runner-win-1", "windows", "a");
  const tlsIdentity = identity(runner.runnerId, "a");
  const registered = await control.register(tlsIdentity, runner, issuedAt);
  assert.equal(registered.platform, "windows");
  assert.deepEqual(registered.installedAutonomousAgents, []);

  await assert.rejects(
    control.register(identity("runner-other", "b"), capabilities("runner-win-2", "windows", "b"), issuedAt),
    /admission policy rejected/,
  );
  const unsafeCore = { ...runner, runnerId: "runner-win-bad", installedAutonomousAgents: ["claude-code"] };
  await assert.rejects(
    control.register(identity("runner-win-bad", "c"), { ...unsafeCore, capabilityDigest: createRunnerCapabilityDigest(unsafeCore) }, issuedAt),
    /forbidden/,
  );

  control.createAttempt(attempt("attempt-win", ["windows"]), issuedAt);
  const job = control.lease(tlsIdentity, runner.runnerId, "attempt-win", issuedAt);
  assert.equal(job.payload.platform, "windows");
  assert.equal(job.payload.targetMatrix[0], "windows");
  assert.equal(job.payload.exportTemplatesDigest, templates.windows);
  const verification = { keyId: "runner-jobs-2030-q1", runnerId: runner.runnerId, platform: "windows" as const, now: issuedAt };
  assert.equal(verifyRunnerJob(job, publicKey, verification), true);
  assert.equal(verifyRunnerJob({ ...job, payload: { ...job.payload, commitSha: "f".repeat(40) } }, publicKey, verification), false);
  assert.equal(verifyRunnerJob(job, publicKey, { ...verification, runnerId: "runner-win-other" }), false);
  assert.equal(verifyRunnerJob(job, publicKey, { ...verification, now: "2030-01-01T00:01:01.000Z" }), false);
  assert.equal(parseSpiffeId("DNS:runner.invalid, URI:spiffe://deviludo.test/e2e-runner/runner-win-1"), tlsIdentity.spiffeId);
  assert.throws(() => parseSpiffeId("URI:spiffe://one/x, URI:spiffe://two/x"), /exactly one/);
});

test("aggregates three independently fenced platform streams into one immutable evidence bundle", async () => {
  const control = coordinator();
  const platforms: readonly TargetPlatform[] = ["windows", "linux", "macos"];
  const jobs: SignedRunnerJob[] = [];
  for (const [index, platform] of platforms.entries()) {
    const runnerId = `runner-${platform}-1`;
    const tlsIdentity = identity(runnerId, String(index + 1));
    await control.register(tlsIdentity, capabilities(runnerId, platform, String(index + 1)), issuedAt);
  }
  control.createAttempt(attempt(), issuedAt);
  for (const [index, platform] of platforms.entries()) {
    const runnerId = `runner-${platform}-1`;
    jobs.push(control.lease(identity(runnerId, String(index + 1)), runnerId, "attempt-matrix-1", issuedAt));
  }

  for (const [index, job] of jobs.entries()) {
    const tlsIdentity = identity(job.payload.runnerId, String(index + 1));
    const startReceipt = control.acceptEvent(tlsIdentity, started(job), "2030-01-01T00:00:01.500Z");
    assert.equal(startReceipt.attemptState, "RUNNING");
    const manifest = evidence(job);
    control.submitEvidence(tlsIdentity, manifest, "2030-01-01T00:00:02.500Z");
    const replay = control.submitEvidence(tlsIdentity, manifest, "2030-01-01T00:00:02.600Z");
    assert.equal(replay.manifestDigest, manifest.manifestDigest);
    const receipt = control.acceptEvent(tlsIdentity, completed(job, manifest), "2030-01-01T00:00:03.500Z");
    assert.equal(receipt.attemptState, index === jobs.length - 1 ? "PASSED" : "RUNNING");
  }

  const state = control.getAttempt("attempt-matrix-1");
  assert.equal(state?.state, "PASSED");
  assert.equal(state?.evidenceBundle?.platformEvidence.length, 3);
  assert.equal(state?.evidenceBundle?.targetMatrix.join(","), "linux,macos,windows");
  assert.equal(state?.evidenceBundle?.commitSha, commit);
  assert.equal(control.events("attempt-matrix-1").length, 6);
  assert.throws(() => control.lease(identity("runner-windows-1", "1"), "runner-windows-1", "attempt-matrix-1", "2030-01-01T00:00:04.000Z"), /terminal/);
});

test("rejects late fencing tokens, runner-level matrix completion and terminal events without evidence", async () => {
  const control = coordinator();
  const runnerId = "runner-linux-2";
  const tlsIdentity = identity(runnerId, "d");
  await control.register(tlsIdentity, capabilities(runnerId, "linux", "d"), issuedAt);
  control.createAttempt(attempt("attempt-released", ["linux"]), issuedAt);
  const oldJob = control.lease(tlsIdentity, runnerId, "attempt-released", issuedAt);
  const newJob = control.lease(tlsIdentity, runnerId, "attempt-released", "2030-01-01T00:01:01.000Z");
  assert.equal(oldJob.payload.fencingToken, 1);
  assert.equal(newJob.payload.fencingToken, 2);
  assert.throws(
    () => control.acceptEvent(tlsIdentity, { ...started(oldJob), occurredAt: "2030-01-01T00:01:01.000Z" }, "2030-01-01T00:01:01.500Z"),
    /STALE_FENCING_TOKEN/,
  );
  const newStart = { ...started(newJob), occurredAt: "2030-01-01T00:01:02.000Z" };
  control.acceptEvent(tlsIdentity, newStart, "2030-01-01T00:01:02.500Z");
  assert.throws(
    () => control.acceptEvent(tlsIdentity, { ...newStart, seqNo: 2, type: "ATTEMPT_COMPLETED", status: "PASSED" }, "2030-01-01T00:01:03.000Z"),
    /RUNNER_ATTEMPT_COMPLETION_FORBIDDEN/,
  );
  assert.throws(
    () => control.acceptEvent(tlsIdentity, { ...newStart, seqNo: 2, type: "PLATFORM_COMPLETED", status: "PASSED", artifactDigest: digest("e") }, "2030-01-01T00:01:03.000Z"),
    /requires a validated evidence manifest/,
  );
});
