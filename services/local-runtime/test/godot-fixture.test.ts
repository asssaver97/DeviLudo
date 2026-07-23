import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LocalFixtureRunner } from "../src/fixture-runner";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const godotBinary = "/Applications/Godot.app/Contents/MacOS/Godot";

test("creates a real macOS Godot evidence bundle and retries dependency waits", async (context) => {
  try {
    await access(godotBinary);
  } catch {
    context.skip("Godot is not installed on this runner");
    return;
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), "deviludo-local-runtime-"));
  try {
    const runner = new LocalFixtureRunner({ repositoryRoot, storageRoot: temporary, godotBinary });
    const request = {
      projectId: "test-project",
      runId: "RUN-INTEGRATION-001",
      specRevisionId: "SPEC-TEST-001",
      targetMatrix: ["macos"] as const,
    };
    const result = await runner.run(request);
    assert.equal(
      result.status,
      result.releaseGate === "WAITING_EXPORT_TEMPLATES" ? "WAITING_DEPENDENCY" : "TESTS_PASSED",
    );
    assert.equal(result.platform, "macos");
    assert.deepEqual(result.targetMatrix, request.targetMatrix);
    assert.equal(result.candidateSha.length, 40);
    assert.equal(result.sourceDigest.length, 64);
    assert.equal(result.bundleDigest.length, 64);
    assert.equal(result.fixtureOnly, true);
    assert.equal(result.checks.find((check) => check.name === "core-loop")?.status, "PASSED");
    assert.equal(result.checks.find((check) => check.name === "save-load")?.status, "PASSED");
    assert.ok(["WAITING_EXPORT_TEMPLATES", "LOCAL_VALIDATION_PASSED"].includes(result.releaseGate));

    const evidenceDirectory = runner.evidenceDirectory(request);
    const manifest = JSON.parse(await readFile(path.join(evidenceDirectory, "manifest.json"), "utf8"));
    assert.equal(manifest.evidenceId, result.evidenceId);
    assert.match(await readFile(path.join(evidenceDirectory, "junit.xml"), "utf8"), /tests="9" failures="0"/);
    const log = await readFile(path.join(evidenceDirectory, "godot.log"), "utf8");
    assert.match(log, /DEVILUDO_E2E_RESULT/);
    assert.doesNotMatch(log, new RegExp(temporary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.artifactDigests["junit.xml"], /^[a-f0-9]{64}$/);
    assert.match(result.artifactDigests["godot.log"], /^[a-f0-9]{64}$/);
    if (result.releaseGate === "LOCAL_VALIDATION_PASSED") {
      assert.equal(result.schemaVersion, 4);
      assert.equal(result.checks.find((check) => check.name === "macos-export-boot")?.status, "PASSED");
      assert.match(log, /\$ <exported-app> --headless --quit-after 120/);
      assert.match(log, /DEVILUDO_FIXTURE_BOOT:/);
      assert.equal(result.buildArtifact?.fileName, "DeviLudoLocal.zip");
      assert.equal(result.buildArtifact?.platform, "macos");
      assert.equal(result.buildArtifact?.contentType, "application/zip");
      assert.match(result.buildArtifact?.sha256 ?? "", /^[a-f0-9]{64}$/);
      assert.ok((result.buildArtifact?.sizeBytes ?? 0) > 0);
      const artifact = await runner.readBuildArtifact(request, "DeviLudoLocal.zip");
      assert.equal(artifact.bytes.byteLength, result.buildArtifact?.sizeBytes);
      assert.equal(artifact.evidence.bundleDigest, result.bundleDigest);
      const main = await runner.runMainGate({
        ...request,
        candidateEvidenceId: result.evidenceId,
        candidateBundleDigest: result.bundleDigest,
        candidateSha: result.candidateSha,
        sourceDigest: result.sourceDigest,
      });
      assert.equal(main.phase, "MAIN_SHA_GATE");
      assert.equal(main.releaseGate, "MAIN_VALIDATION_PASSED");
      assert.equal(main.mainSha, result.candidateSha);
      assert.equal(main.mainSourceDigest, result.sourceDigest);
      assert.equal(main.mergeReceipt.mainCommitSha, main.mainSha);
      assert.equal(main.checks.find((check) => check.name === "macos-export-boot")?.status, "PASSED");
      assert.equal(main.buildArtifact?.fileName, "DeviLudoMain.zip");
      const mainArtifact = await runner.readMainBuildArtifact(request, "DeviLudoMain.zip");
      assert.equal(mainArtifact.bytes.byteLength, main.buildArtifact?.sizeBytes);
      const reinstall = await runner.runSteamReinstall({
        ...request,
        mainEvidenceId: main.evidenceId,
        mainBundleDigest: main.bundleDigest,
        mainSha: main.mainSha,
        mainSourceDigest: main.mainSourceDigest,
        mainArtifactSha256: main.buildArtifact!.sha256,
        mfaApprovalId: "MFA-LOCAL-0012",
      });
      assert.equal(reinstall.phase, "LOCAL_STEAM_REINSTALL");
      assert.equal(reinstall.localOnly, true);
      assert.equal(reinstall.releaseGate, "LOCAL_STEAM_REINSTALL_PASSED");
      assert.equal(reinstall.mainEvidenceId, main.evidenceId);
      assert.equal(reinstall.mainArtifactSha256, main.buildArtifact?.sha256);
      assert.equal(reinstall.betaArtifact?.sha256, main.buildArtifact?.sha256);
      assert.equal(reinstall.checks.find((check) => check.name === "clean-reinstall-boot")?.status, "PASSED");
      const betaArtifact = await runner.readSteamBetaArtifact(request, "DeviLudoLocalBeta.zip");
      assert.equal(betaArtifact.bytes.byteLength, mainArtifact.bytes.byteLength);
      assert.equal(betaArtifact.evidence.evidenceId, reinstall.evidenceId);
      const reinstallLog = await readFile(path.join(runner.steamReinstallEvidenceDirectory(request), "reinstall.log"), "utf8");
      assert.match(reinstallLog, /No Steam endpoint or credential was used/);
      assert.match(reinstallLog, /\$ <exported-app> --headless --quit-after 120/);
      assert.equal((await runner.runSteamReinstall({
        ...request,
        mainEvidenceId: main.evidenceId,
        mainBundleDigest: main.bundleDigest,
        mainSha: main.mainSha,
        mainSourceDigest: main.mainSourceDigest,
        mainArtifactSha256: main.buildArtifact!.sha256,
        mfaApprovalId: "MFA-LOCAL-0012",
      })).evidenceId, reinstall.evidenceId);
      assert.equal((await runner.runMainGate({
        ...request,
        candidateEvidenceId: result.evidenceId,
        candidateBundleDigest: result.bundleDigest,
        candidateSha: result.candidateSha,
        sourceDigest: result.sourceDigest,
      })).evidenceId, main.evidenceId);
    } else {
      assert.equal(result.buildArtifact, null);
    }
    await assert.rejects(
      runner.run({ ...request, targetMatrix: ["linux"] }),
      /immutable run lock/,
    );

    const successor = await runner.run({
      projectId: request.projectId,
      runId: "RUN-INTEGRATION-002",
      specRevisionId: "SPEC-TEST-002",
      targetMatrix: ["linux"] as const,
    });
    assert.equal(
      successor.status,
      successor.releaseGate === "WAITING_EXPORT_TEMPLATES" ? "WAITING_DEPENDENCY" : "TESTS_PASSED",
    );
    assert.notEqual(successor.runId, result.runId);
    assert.notEqual(successor.candidateSha, result.candidateSha);
    assert.notEqual(successor.bundleDigest, result.bundleDigest);
    assert.deepEqual(successor.targetMatrix, ["linux"]);
    const successorLog = await readFile(path.join(
      runner.evidenceDirectory({ projectId: request.projectId, runId: successor.runId }),
      "godot.log",
    ), "utf8");
    assert.doesNotMatch(successorLog, new RegExp(temporary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const replay = await runner.run(request);
    if (result.releaseGate === "WAITING_EXPORT_TEMPLATES") {
      assert.equal(replay.status, "WAITING_DEPENDENCY");
      assert.equal(replay.releaseGate, "WAITING_EXPORT_TEMPLATES");
      assert.equal(replay.runId, result.runId);
    } else {
      assert.equal(replay.evidenceId, result.evidenceId);
      assert.equal(replay.candidateSha, result.candidateSha);
      const artifactPath = path.join(runner.artifactDirectory(request), "DeviLudoLocal.zip");
      await writeFile(artifactPath, "tampered build bytes", "utf8");
      await assert.rejects(runner.readBuildArtifact(request, "DeviLudoLocal.zip"), /does not match/);
      await assert.rejects(runner.run(request), /does not match/);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
