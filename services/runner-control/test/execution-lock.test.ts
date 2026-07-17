import assert from "node:assert/strict";
import test from "node:test";
import { parseRunnerExecutionLock, runnerExecutionLockDigest, type RunnerExecutionLock } from "../src/execution-lock";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const sha = (value: string) => value.repeat(64);

function sourceLock(): RunnerExecutionLock {
  return {
    schemaVersion: "deviludo.runner-execution-lock.v1",
    tenantId,
    projectId,
    runId,
    mode: "MAIN_RELEASE_GATE",
    commitSha: "1".repeat(40),
    sourceDigest: sha("2"),
    steamBuildId: null,
    specRevisionId: "44444444-4444-4444-8444-444444444444",
    specDigest: sha("3"),
    testPlanDigest: sha("4"),
    targetMatrix: ["linux", "macos", "windows"],
    requiredGodotVersion: "4.6.2-stable",
    godotTestKitDigest: sha("5"),
    exportTemplates: { linux: sha("6"), macos: sha("7"), windows: sha("8") },
    buildManifestDigest: sha("9"),
    sbomDigest: sha("a"),
    vulnerabilityScanDigest: sha("b"),
    assetLicenseLedgerDigest: sha("c"),
    execution: {
      kind: "SOURCE_ARTIFACT",
      objectKey: `tenants/${tenantId}/projects/${projectId}/sources/main.tar.zst`,
      artifactDigest: sha("d"),
    },
    preparedAt: "2026-07-18T00:00:00.000Z",
  };
}

test("Runner execution lock accepts a content-bound source artifact and has a stable digest", () => {
  const parsed = parseRunnerExecutionLock(sourceLock());
  assert.equal(parsed.execution.kind, "SOURCE_ARTIFACT");
  assert.deepEqual(parsed.targetMatrix, ["linux", "macos", "windows"]);
  assert.equal(runnerExecutionLockDigest(parsed), runnerExecutionLockDigest(sourceLock()));
});

test("Runner execution lock accepts a BuildID-bound clean Steam install grant", () => {
  const source = sourceLock();
  const lock = {
    ...source,
    mode: "STEAM_CLEAN_INSTALL",
    steamBuildId: "123456789",
    execution: {
      kind: "STEAM_CLEAN_INSTALL",
      steamAppId: "480",
      buildId: "123456789",
      betaBranch: "deviludo_beta",
      installGrantId: "install-grant:2026-07-18:001",
    },
  };
  const parsed = parseRunnerExecutionLock(lock);
  assert.equal(parsed.execution.kind, "STEAM_CLEAN_INSTALL");
  assert.equal(parsed.steamBuildId, "123456789");
});

test("Runner execution lock rejects matrix, template, object scope and BuildID drift", () => {
  const source = sourceLock();
  assert.throws(() => parseRunnerExecutionLock({ ...source, targetMatrix: ["windows", "linux", "macos"] }), /target matrix order/);
  assert.throws(() => parseRunnerExecutionLock({ ...source, exportTemplates: { ...source.exportTemplates, android: sha("e") } }), /export template matrix/);
  assert.throws(() => parseRunnerExecutionLock({ ...source, execution: { ...source.execution, objectKey: "tenants/other/source.tar.zst" } }), /object key scope/);
  assert.throws(() => parseRunnerExecutionLock({
    ...source,
    mode: "STEAM_CLEAN_INSTALL",
    steamBuildId: "123",
    execution: { kind: "STEAM_CLEAN_INSTALL", steamAppId: "480", buildId: "124", betaBranch: "private_beta", installGrantId: "grant-1" },
  }), /BuildID binding/);
});

test("Runner execution lock rejects floating toolchains and unversioned payload extensions", () => {
  const source = sourceLock();
  assert.throws(() => parseRunnerExecutionLock({ ...source, requiredGodotVersion: "latest" }), /Godot version/);
  assert.throws(() => parseRunnerExecutionLock({ ...source, futureOverride: true }), /payload fields/);
});
