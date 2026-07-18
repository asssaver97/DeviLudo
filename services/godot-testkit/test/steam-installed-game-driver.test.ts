import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { RunnerJobPayload, SignedRunnerJob } from "../../runner-control/src/contracts";
import type { GodotHarnessResult, GodotTestKitRunRequest, GodotTestPlan } from "../src/contracts";
import {
  MtlsSteamInstalledGameDriver,
  testKitSteamProcessEnvironmentFromEnv,
} from "../src/steam-installed-game-driver";

const sha = (character: string) => character.repeat(64);
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

test("mTLS Steam installed-game driver binds a clean BuildID and returns validated product evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-steam-installed-game-"));
  try {
    const fixture = await installedFixture(root);
    const requests: Record<string, unknown>[] = [];
    const driver = new MtlsSteamInstalledGameDriver({
      endpoint: "https://steam-install.internal:4843",
      tls: { key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
      stagingRoot: root,
      http: async (input) => {
        assert.equal(input.url.href, "https://steam-install.internal:4843/v1/clean-install-executions");
        assert.equal(input.method, "POST");
        requests.push(JSON.parse(input.body) as Record<string, unknown>);
        return { statusCode: 200, payload: fixture.receipt };
      },
    });
    const result = await driver.run({
      request: fixture.request,
      plan: fixture.plan,
      runRoot: join(root, "unused-run-root"),
      planPath: join(root, "test-plan.json"),
    });
    assert.equal(result.exportRoot, await realpath(fixture.installRoot));
    assert.equal(result.harness?.status, "PASSED");
    assert.deepEqual(result.commands.map((command) => command.id), [
      "steam-client-reset", "steam-install", "production-boot", "platform-suite",
    ]);
    assert.equal((requests[0]?.signedJob as SignedRunnerJob).payload.execution.kind, "STEAM_CLEAN_INSTALL");
    assert.equal((requests[0]?.testPlan as GodotTestPlan).schemaVersion, "deviludo.godot-test-plan.v2");
    assert.doesNotMatch(JSON.stringify({ sent: requests[0], result }), /config\.vdf|steam.?guard|branch.?password|account.?password/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Steam installed-game driver readiness requires the exact authenticated Connector identity", async () => {
  const calls: string[] = [];
  const driver = new MtlsSteamInstalledGameDriver({
    endpoint: "https://steam-install.internal:4843",
    tls: { key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    stagingRoot: tmpdir(),
    http: async (input) => {
      calls.push(`${input.method} ${input.url.pathname}`);
      return { statusCode: 200, payload: { status: "ok", service: "deviludo-steam-client-connector" } };
    },
  });
  await driver.probe();
  assert.deepEqual(calls, ["GET /healthz"]);
  const drifted = new MtlsSteamInstalledGameDriver({
    endpoint: "https://steam-install.internal:4843",
    tls: { key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    stagingRoot: tmpdir(),
    http: async () => ({ statusCode: 200, payload: { status: "ok", service: "other" } }),
  });
  await assert.rejects(drifted.probe(), /not ready/);
});

test("Steam installed-game driver rejects BuildID drift, escaped paths and credential logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-steam-installed-game-"));
  try {
    const fixture = await installedFixture(root);
    const run = async (changed: Record<string, unknown>) => new MtlsSteamInstalledGameDriver({
      endpoint: "https://steam-install.internal",
      tls: { key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
      stagingRoot: root,
      http: async () => {
        const { receiptDigest: _ignored, ...receiptCore } = fixture.receipt;
        void _ignored;
        const core = { ...receiptCore, ...changed };
        return { statusCode: 200, payload: { ...core, receiptDigest: sha256Canonical(core) } };
      },
    }).run({ request: fixture.request, plan: fixture.plan, runRoot: root, planPath: join(root, "plan.json") });
    await assert.rejects(run({ buildId: "999" }), /receipt is invalid/);
    await assert.rejects(run({ installRoot: tmpdir() }), /escaped staging root/);
    await writeFile(fixture.logsPath, "config.vdf copied with Steam Guard secret\n");
    await assert.rejects(run({}), /forbidden credential material/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Steam installed-game child environment is complete, pinned and secret-free", () => {
  const env = testKitSteamProcessEnvironmentFromEnv({
    DEVILUDO_TESTKIT_STEAM_CONNECTOR_URL: "https://steam-install.internal:4843",
    DEVILUDO_TESTKIT_STEAM_TLS_KEY_FILE: "/run/secrets/steam/client.key",
    DEVILUDO_TESTKIT_STEAM_TLS_CERT_FILE: "/run/secrets/steam/client.crt",
    DEVILUDO_TESTKIT_STEAM_CA_FILE: "/run/secrets/steam/ca.crt",
    DEVILUDO_TESTKIT_STEAM_STAGING_ROOT: "/var/lib/deviludo/steam-installs",
    DEVILUDO_TESTKIT_STEAM_TIMEOUT_SECONDS: "3000",
    STEAM_PASSWORD: "must-not-leak",
  });
  assert.equal(env.DEVILUDO_TESTKIT_STEAM_CONNECTOR_URL, "https://steam-install.internal:4843");
  assert.equal(env.DEVILUDO_TESTKIT_STEAM_TIMEOUT_SECONDS, "3000");
  assert.equal(env.STEAM_PASSWORD, undefined);
  assert.throws(() => testKitSteamProcessEnvironmentFromEnv({
    DEVILUDO_TESTKIT_STEAM_CONNECTOR_URL: "http://localhost:4843",
  }), /URL|is required/);
});

async function installedFixture(root: string) {
  const installRoot = join(root, "install");
  const harnessRoot = join(root, "harness");
  const screenshotsRoot = join(harnessRoot, "screenshots");
  await Promise.all([mkdir(installRoot), mkdir(screenshotsRoot, { recursive: true })]);
  const plan = testPlan();
  const request = runRequest(steamJob());
  const start = Buffer.from("png-start");
  const win = Buffer.from("png-win");
  const harness = harnessResult(plan, start, win);
  const harnessResultPath = join(harnessRoot, "result.json");
  const logsPath = join(harnessRoot, "connector.log");
  await Promise.all([
    writeFile(join(installRoot, "DeviLudo.x86_64"), "installed-build-91234567"),
    writeFile(join(screenshotsRoot, "start.png"), start),
    writeFile(join(screenshotsRoot, "win.png"), win),
    writeFile(join(harnessRoot, "video.avi"), "installed-game-video"),
    writeFile(harnessResultPath, JSON.stringify(harness)),
    writeFile(logsPath, "clean client reset; BuildID 91234567 installed; suite completed\n"),
  ]);
  const commands = ["steam-client-reset", "steam-install", "production-boot", "platform-suite"].map((id) => ({
    id, status: "PASSED", durationMs: 10, code: "OK",
  }));
  const core = {
    schemaVersion: "deviludo.steam-clean-install-execution-receipt.v1",
    jobDigest: request.jobDigest,
    executionLockDigest: request.signedJob.payload.executionLockDigest,
    platform: "linux",
    steamAppId: "2841930",
    buildId: "91234567",
    betaBranch: "deviludo_private_9",
    installGrantId: "install-grant-9",
    cleanClient: true,
    installRoot,
    harnessRoot,
    harnessResultPath,
    logsPath,
    commands,
  };
  return { request, plan, installRoot, logsPath, receipt: { ...core, receiptDigest: sha256Canonical(core) } };
}

function steamJob(): SignedRunnerJob {
  const payload: RunnerJobPayload = {
    schemaVersion: "deviludo.runner-job.v2",
    attemptId: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    runId: "44444444-4444-4444-8444-444444444444",
    iterationId: "55555555-5555-4555-8555-555555555555",
    runnerId: "runner-linux-1",
    platform: "linux",
    fencingToken: 1,
    leaseExpiresAt: "2099-01-01T01:00:00.000Z",
    executionLockId: "66666666-6666-4666-8666-666666666666",
    executionLockDigest: sha("1"),
    commitSha: "a".repeat(40),
    sourceDigest: sha("2"),
    execution: {
      kind: "STEAM_CLEAN_INSTALL", steamAppId: "2841930", buildId: "91234567",
      betaBranch: "deviludo_private_9", installGrantId: "install-grant-9",
    },
    specRevisionId: "77777777-7777-4777-8777-777777777777",
    specDigest: sha("3"),
    testPlanDigest: sha("4"),
    runnerToolchainRevisionId: "88888888-8888-4888-8888-888888888888",
    runnerToolchainDigest: sha("5"),
    targetMatrix: ["linux"],
    requiredGodotVersion: "4.6.2-stable",
    godotTestKitDigest: sha("6"),
    exportTemplatesDigest: sha("7"),
    runnerCapabilityDigest: sha("8"),
    buildManifestDigest: sha("9"),
    sbomDigest: sha("a"),
    vulnerabilityScanDigest: sha("b"),
    assetLicenseLedgerDigest: sha("c"),
    requiredEvidence: ["logs", "junit", "input-timeline", "screenshots", "video", "production-export"],
  };
  return { payload, signature: { algorithm: "Ed25519", keyId: "runner-job-key-01", value: "opaque-signature" } };
}

function runRequest(job: SignedRunnerJob): GodotTestKitRunRequest {
  return {
    schemaVersion: "deviludo.testkit-run-request.v2",
    jobDigest: sha256Canonical(job.payload),
    testKitDigest: job.payload.godotTestKitDigest,
    godot: { executable: "/opt/godot/godot", binaryDigest: sha("d"), version: job.payload.requiredGodotVersion },
    signedJob: job,
  };
}

function testPlan(): GodotTestPlan {
  const outcomes = ["CORE_LOOP", "WIN", "LOSE", "PAUSE_SETTINGS", "SAVE_LOAD"] as const;
  return {
    schemaVersion: "deviludo.godot-test-plan.v2", engine: "godot-4", targetMatrix: ["linux"],
    requiredGodotVersion: "4.6.2-stable",
    timeouts: { importSeconds: 60, bootSeconds: 60, suiteSeconds: 300, exportSeconds: 600 },
    performance: { warmupFrames: 30, sampleFrames: 120, maximumAverageFrameMs: 16, maximumP95FrameMs: 32 },
    scenarios: outcomes.map((outcome, index) => ({
      id: `${String(index + 1).padStart(2, "0")}-${outcome.toLowerCase().replaceAll("_", "-")}`,
      outcome,
      steps: [
        { kind: "WAIT_FRAMES" as const, frames: 2 },
        ...(index < 2 ? [{ kind: "SCREENSHOT" as const, name: index === 0 ? "start" : "win" }] : []),
      ],
    })),
  };
}

function harnessResult(plan: GodotTestPlan, start: Buffer, win: Buffer): GodotHarnessResult {
  return {
    schemaVersion: "deviludo.godot-harness-result.v1", status: "PASSED",
    checks: plan.scenarios.map((scenario) => ({ id: scenario.id, outcome: scenario.outcome, status: "PASSED", durationMs: 10, code: "OK" })),
    inputTimeline: plan.scenarios.flatMap((scenario) => scenario.steps.map((step, stepIndex) => ({
      scenarioId: scenario.id, stepIndex, kind: step.kind, frame: stepIndex + 1,
    }))),
    screenshots: [
      { name: "start", file: "screenshots/start.png", sha256: digest(start), width: 640, height: 360 },
      { name: "win", file: "screenshots/win.png", sha256: digest(win), width: 640, height: 360 },
    ],
    performance: { averageFrameMs: 8, p95FrameMs: 12, sampledFrames: 120 },
    videoFile: "video.avi", createdAt: "2099-01-01T00:00:01.000Z",
  };
}
