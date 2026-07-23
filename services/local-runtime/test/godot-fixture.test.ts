import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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
      targetMatrix: ["macos", "windows"] as const,
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
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
