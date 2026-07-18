import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, sha256Canonical, signCanonical } from "../../runner-control/src/canonical";
import type { RunnerJobPayload, SignedRunnerJob } from "../../runner-control/src/contracts";
import { REQUIRED_RUNNER_EVIDENCE } from "../../runner-control/src/coordinator";
import type { GodotHarnessResult, GodotTestPlan } from "../../godot-testkit/src/contracts";
import type { GodotCommandEvidence } from "../../godot-testkit/src/godot-driver";
import {
  SteamClientConnectorService,
  type SteamClientNativeExecutionResult,
  type SteamClientNativeExecutor,
} from "../src/connector";
import { createSteamClientConnectorHandler, createSteamClientConnectorHttpsServer } from "../src/ingress-http";
import {
  MtlsSteamInstallGrantClient,
  type SteamInstallGrantRedemptionPort,
  type SteamInstallGrantRedemptionReceipt,
} from "../src/install-grant-client";
import { LockedNativeSteamClientExecutor } from "../src/locked-native-executor";

const keys = generateKeyPairSync("ed25519");
const sha = (character: string) => character.repeat(64);
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const now = "2030-01-01T00:00:00.000Z";
const identity = {
  spiffeId: "spiffe://deviludo.test/testkit/runner-linux-1",
  certificateFingerprint: sha("f"), certificateSerial: "01", certificateNotAfter: "2031-01-01T00:00:00.000Z",
};

test("Connector verifies one signed BuildID, validates native evidence and replays idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-steam-connector-"));
  try {
    const fixture = await createFixture(root);
    const service = connector(root, fixture.executor);
    const first = await service.execute(fixture.request);
    const replay = await service.execute(fixture.request);
    assert.deepEqual(replay, first);
    assert.equal(fixture.calls.count, 1);
    assert.equal(first.buildId, "91234567");
    assert.equal(first.cleanClient, true);
    const core = { ...first } as Record<string, unknown>;
    delete core.receiptDigest;
    assert.equal(first.receiptDigest, sha256Canonical(core));
    assert.doesNotMatch(JSON.stringify(first), /config\.vdf|steam.?guard|password/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Connector redeems the exact grant before native execution and fails closed on grant drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-steam-connector-grant-"));
  try {
    const fixture = await createFixture(root);
    const order: string[] = [];
    let grantProbes = 0;
    let nativeProbes = 0;
    const grants: SteamInstallGrantRedemptionPort = {
      async probe() { grantProbes += 1; },
      async redeem(input) { order.push("grant"); return grantReceipt(input.signedJob, input.jobDigest); },
    };
    const executor: SteamClientNativeExecutor = {
      async probe() { nativeProbes += 1; },
      async execute() { order.push("native"); return fixture.result; },
    };
    const service = connector(root, executor, grants);
    await service.probe();
    await service.execute(fixture.request);
    assert.deepEqual({ order, grantProbes, nativeProbes }, { order: ["grant", "native"], grantProbes: 1, nativeProbes: 1 });

    let nativeCalls = 0;
    const neverNative: SteamClientNativeExecutor = {
      async probe() {},
      async execute() { nativeCalls += 1; return fixture.result; },
    };
    const rejected: SteamInstallGrantRedemptionPort = {
      async probe() {},
      async redeem() { throw new Error("grant rejected"); },
    };
    await assert.rejects(connector(root, neverNative, rejected).execute(fixture.request), /grant rejected/);
    const drifted: SteamInstallGrantRedemptionPort = {
      async probe() {},
      async redeem(input) { return { ...grantReceipt(input.signedJob, input.jobDigest), buildId: "999" }; },
    };
    await assert.rejects(connector(root, neverNative, drifted).execute(fixture.request), /install grant redemption/);
    assert.equal(nativeCalls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mTLS grant client sends only the signed job and accepts one exact redemption receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-steam-grant-client-"));
  try {
    const fixture = await createFixture(root);
    const tls = { key: Buffer.alloc(32, 1), certificate: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) };
    let probes = 0;
    let redemptions = 0;
    const client = new MtlsSteamInstallGrantClient({
      endpoint: "https://steam-install-grants.internal:4744",
      tls,
      timeoutMs: 5_000,
      async http(input) {
        assert.equal(input.timeoutMs, 5_000);
        if (input.method === "GET") {
          probes += 1;
          assert.equal(input.url.href, "https://steam-install-grants.internal:4744/healthz");
          return { statusCode: 200, payload: { status: "ok", service: "deviludo-steam-install-grants" } };
        }
        redemptions += 1;
        assert.equal(input.url.href, "https://steam-install-grants.internal:4744/v1/steam-install-grant-redemptions");
        const body = JSON.parse(input.body) as Record<string, unknown>;
        assert.deepEqual(body, {
          schemaVersion: "deviludo.steam-install-grant-redemption.v1",
          jobDigest: fixture.request.jobDigest,
          signedJob: fixture.request.signedJob,
        });
        assert.doesNotMatch(input.body, /password|config\.vdf|steam.?guard/i);
        return { statusCode: 200, payload: grantReceipt(fixture.request.signedJob, fixture.request.jobDigest) };
      },
    });
    await client.probe();
    const receipt = await client.redeem({ jobDigest: fixture.request.jobDigest, signedJob: fixture.request.signedJob });
    assert.equal(receipt.buildId, "91234567");
    assert.deepEqual({ probes, redemptions }, { probes: 1, redemptions: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mTLS grant client rejects unsafe endpoints, service errors and receipt drift", async () => {
  const tls = { key: Buffer.alloc(32, 1), certificate: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) };
  assert.throws(() => new MtlsSteamInstallGrantClient({ endpoint: "http://steam.internal", tls }), /URL is invalid/);
  const payload = jobPayload(sha("4"));
  const signedJob = signed(payload);
  const jobDigest = sha256Canonical(payload);
  const rejected = new MtlsSteamInstallGrantClient({
    endpoint: "https://steam.internal", tls, async http() { return { statusCode: 409, payload: {} }; },
  });
  await assert.rejects(rejected.redeem({ jobDigest, signedJob }), /redemption was rejected/);
  const drifted = new MtlsSteamInstallGrantClient({
    endpoint: "https://steam.internal", tls,
    async http() { return { statusCode: 200, payload: { ...grantReceipt(signedJob, jobDigest), betaBranch: "other_private" } }; },
  });
  await assert.rejects(drifted.redeem({ jobDigest, signedJob }), /receipt is invalid/);
});

test("Connector rejects signature, plan, mode, path and credential-log drift before receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-steam-connector-"));
  try {
    const fixture = await createFixture(root);
    const alteredSignature = {
      ...fixture.request,
      signedJob: { ...fixture.request.signedJob, signature: { ...fixture.request.signedJob.signature, value: "bad" } },
    };
    await assert.rejects(connector(root, fixture.executor).execute(alteredSignature), /signed Runner job/);
    await assert.rejects(connector(root, fixture.executor).execute({
      ...fixture.request,
      testPlan: { ...fixture.request.testPlan, requiredGodotVersion: "4.5.0-stable" },
    }), /test plan/);

    const sourcePayload = {
      ...fixture.request.signedJob.payload,
      execution: { kind: "SOURCE_ARTIFACT" as const, objectKey: "source/game.tar.zst", artifactDigest: sha("e") },
    };
    const sourceJob = signed(sourcePayload);
    await assert.rejects(connector(root, fixture.executor).execute({
      ...fixture.request,
      jobDigest: sha256Canonical(sourcePayload),
      signedJob: sourceJob,
    }), /execution mode/);

    const escaped: SteamClientNativeExecutor = {
      async probe() {},
      async execute() { return { ...fixture.result, installRoot: tmpdir() }; },
    };
    await assert.rejects(connector(root, escaped).execute(fixture.request), /staging boundary/);
    await writeFile(fixture.result.logsPath, "Steam Guard refresh token leaked\n");
    await assert.rejects(connector(root, fixture.executor).execute(fixture.request), /credential-free logs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mTLS handler admits one TestKit identity and fails closed on route, content and execution errors", async () => {
  const calls = { execute: 0, probe: 0 };
  const handler = createSteamClientConnectorHandler({
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => identity,
    service: {
      async probe() { calls.probe += 1; },
      async execute() { calls.execute += 1; return { receiptDigest: sha("1") } as never; },
    },
  });
  const health = await handler({ method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" });
  assert.equal(health.status, 200);
  const accepted = await handler({ method: "POST", path: "/v1/clean-install-executions", headers: { "content-type": "application/json" }, socket: {}, rawBody: "{}" });
  assert.equal(accepted.status, 200);
  assert.deepEqual(calls, { execute: 1, probe: 1 });
  assert.equal((await handler({ method: "POST", path: "/v1/clean-install-executions", headers: {}, socket: {}, rawBody: "{}" })).status, 415);
  assert.equal((await handler({ method: "GET", path: "/missing", headers: {}, socket: {}, rawBody: "" })).status, 404);

  const forbidden = createSteamClientConnectorHandler({
    allowedSpiffeIds: new Set(["spiffe://deviludo.test/other"]), extractIdentity: () => identity,
    service: { async probe() {}, async execute() { throw new Error("must not execute"); } },
  });
  assert.equal((await forbidden({ method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" })).status, 403);
  const missingIdentity = createSteamClientConnectorHandler({
    allowedSpiffeIds: new Set([identity.spiffeId]), extractIdentity: () => { throw new Error("no cert"); },
    service: { async probe() {}, async execute() { throw new Error("must not execute"); } },
  });
  assert.equal((await missingIdentity({ method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" })).status, 401);
});

test("HTTPS server requires complete TLS material and bounded execution settings", () => {
  assert.throws(() => createSteamClientConnectorHttpsServer({
    tls: { key: "", cert: "", ca: "" }, handler: async () => ({ status: 200, body: {} }),
  }), /TLS material/);
  assert.throws(() => createSteamClientConnectorHttpsServer({
    tls: { key: "key", cert: "cert", ca: "ca" }, handler: async () => ({ status: 200, body: {} }),
    maxBodyBytes: 9 * 1024 * 1024,
  }), /body limit/);
  assert.throws(() => createSteamClientConnectorHttpsServer({
    tls: { key: "key", cert: "cert", ca: "ca" }, handler: async () => ({ status: 200, body: {} }),
    requestTimeoutMs: 1_000,
  }), /timeout/);
});

test("locked native adapter pins binary, argv, child environment and durable response replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-native-steam-adapter-"));
  try {
    const fixture = await createFixture(root);
    const executable = join(root, "steam-client-bridge");
    const workRoot = join(root, "work");
    await Promise.all([writeFile(executable, "signed-native-bridge"), mkdir(workRoot)]);
    let probes = 0;
    let executions = 0;
    const adapter = new LockedNativeSteamClientExecutor({
      executable,
      executableDigest: digest("signed-native-bridge"),
      workRoot,
      process: async (receivedExecutable, args, options) => {
        assert.equal(receivedExecutable, executable);
        assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "NODE_ENV", "TEMP", "TMP", "TMPDIR", "USERPROFILE"]);
        assert.equal(options.env.STEAM_PASSWORD, undefined);
        if (args[0] === "probe") {
          probes += 1;
          assert.deepEqual(args, ["probe", "--json"]);
          return { exitCode: 0, stdout: JSON.stringify({ schemaVersion: "deviludo.native-steam-client-probe.v1", status: "READY" }), stderr: "" };
        }
        executions += 1;
        assert.deepEqual(args.slice(0, 2), ["execute", "--request-file"]);
        const requestPath = args[2]!;
        const responsePath = args[4]!;
        const stored = JSON.parse(await readFile(requestPath, "utf8")) as { executionId: string };
        assert.equal(stored.executionId, fixture.request.jobDigest);
        await writeFile(responsePath, JSON.stringify({ schemaVersion: "deviludo.native-steam-clean-install-result.v1", ...fixture.result }));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await adapter.probe();
    const nativeInput = {
      schemaVersion: "deviludo.native-steam-clean-install.v1" as const,
      executionId: fixture.request.jobDigest,
      stagingRoot: root,
      signedJob: fixture.request.signedJob,
      testPlan: fixture.request.testPlan,
    };
    assert.deepEqual(await adapter.execute(nativeInput), fixture.result);
    assert.deepEqual(await adapter.execute(nativeInput), fixture.result);
    assert.deepEqual({ probes, executions }, { probes: 1, executions: 1 });
    await writeFile(executable, "tampered-native-bridge");
    await assert.rejects(adapter.execute({ ...nativeInput, executionId: sha("d") }), /executable digest/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function connector(
  root: string,
  executor: SteamClientNativeExecutor,
  grants: SteamInstallGrantRedemptionPort = grantPort(),
): SteamClientConnectorService {
  return new SteamClientConnectorService({
    jobPublicKey: keys.publicKey,
    jobKeyId: "runner-job-key-01",
    runnerId: "runner-linux-1",
    platform: "linux",
    stagingRoot: root,
    executor,
    grants,
    now: () => new Date(now),
  });
}

function grantPort(): SteamInstallGrantRedemptionPort {
  return {
    async probe() {},
    async redeem(input) { return grantReceipt(input.signedJob, input.jobDigest); },
  };
}

function grantReceipt(signedJob: SignedRunnerJob, jobDigest: string): SteamInstallGrantRedemptionReceipt {
  const execution = signedJob.payload.execution;
  assert.equal(execution.kind, "STEAM_CLEAN_INSTALL");
  return Object.freeze({
    schemaVersion: "deviludo.steam-install-grant-redemption-receipt.v1",
    jobDigest,
    executionLockDigest: signedJob.payload.executionLockDigest,
    grantId: execution.installGrantId,
    platform: signedJob.payload.platform,
    steamAppId: execution.steamAppId,
    buildId: execution.buildId,
    betaBranch: execution.betaBranch,
    redeemedAt: now,
  });
}

async function createFixture(root: string) {
  const installRoot = join(root, "install");
  const harnessRoot = join(root, "harness");
  await Promise.all([mkdir(installRoot), mkdir(join(harnessRoot, "screenshots"), { recursive: true })]);
  const plan = testPlan();
  const payload = jobPayload(digest(Buffer.from(canonicalJson(plan))));
  const signedJob = signed(payload);
  const start = Buffer.from("start-png");
  const win = Buffer.from("win-png");
  const harness = harnessResult(plan, start, win);
  const harnessResultPath = join(harnessRoot, "result.json");
  const logsPath = join(harnessRoot, "connector.log");
  await Promise.all([
    writeFile(join(installRoot, "DeviLudo.x86_64"), "build-91234567"),
    writeFile(join(harnessRoot, "screenshots", "start.png"), start),
    writeFile(join(harnessRoot, "screenshots", "win.png"), win),
    writeFile(join(harnessRoot, "video.avi"), "video"),
    writeFile(harnessResultPath, JSON.stringify(harness)),
    writeFile(logsPath, "clean client installed BuildID 91234567\n"),
  ]);
  const commands = ["steam-client-reset", "steam-install", "production-boot", "platform-suite"].map((id) => ({
    id, status: "PASSED", durationMs: 10, code: "OK",
  })) as GodotCommandEvidence[];
  const result: SteamClientNativeExecutionResult = { installRoot, harnessRoot, harnessResultPath, logsPath, commands };
  const calls = { count: 0 };
  const executor: SteamClientNativeExecutor = {
    async probe() {},
    async execute(input) {
      calls.count += 1;
      assert.equal(input.executionId, sha256Canonical(payload));
      assert.equal(input.signedJob.payload.execution.kind, "STEAM_CLEAN_INSTALL");
      return result;
    },
  };
  return {
    result, executor, calls,
    request: { schemaVersion: "deviludo.steam-clean-install-execution.v1", jobDigest: sha256Canonical(payload), signedJob, testPlan: plan },
  };
}

function jobPayload(testPlanDigest: string): RunnerJobPayload {
  return {
    schemaVersion: "deviludo.runner-job.v2",
    attemptId: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    runId: "44444444-4444-4444-8444-444444444444",
    iterationId: "55555555-5555-4555-8555-555555555555",
    runnerId: "runner-linux-1", platform: "linux", fencingToken: 1,
    leaseExpiresAt: "2030-01-01T00:55:00.000Z",
    executionLockId: "66666666-6666-4666-8666-666666666666", executionLockDigest: sha("1"),
    commitSha: "a".repeat(40), sourceDigest: sha("2"),
    execution: { kind: "STEAM_CLEAN_INSTALL", steamAppId: "2841930", buildId: "91234567", betaBranch: "deviludo_private_9", installGrantId: "install-grant-9" },
    specRevisionId: "77777777-7777-4777-8777-777777777777", specDigest: sha("3"), testPlanDigest,
    runnerToolchainRevisionId: "88888888-8888-4888-8888-888888888888", runnerToolchainDigest: sha("5"),
    targetMatrix: ["linux"], requiredGodotVersion: "4.6.2-stable", godotTestKitDigest: sha("6"),
    exportTemplatesDigest: sha("7"), runnerCapabilityDigest: sha("8"), buildManifestDigest: sha("9"),
    sbomDigest: sha("a"), vulnerabilityScanDigest: sha("b"), assetLicenseLedgerDigest: sha("c"),
    requiredEvidence: REQUIRED_RUNNER_EVIDENCE,
  };
}

function signed(payload: RunnerJobPayload): SignedRunnerJob {
  return { payload, signature: { algorithm: "Ed25519", keyId: "runner-job-key-01", value: signCanonical(keys.privateKey, payload) } };
}

function testPlan(): GodotTestPlan {
  const outcomes = ["CORE_LOOP", "WIN", "LOSE", "PAUSE_SETTINGS", "SAVE_LOAD"] as const;
  return {
    schemaVersion: "deviludo.godot-test-plan.v2", engine: "godot-4", targetMatrix: ["linux"], requiredGodotVersion: "4.6.2-stable",
    timeouts: { importSeconds: 60, bootSeconds: 60, suiteSeconds: 300, exportSeconds: 600 },
    performance: { warmupFrames: 30, sampleFrames: 120, maximumAverageFrameMs: 16, maximumP95FrameMs: 32 },
    scenarios: outcomes.map((outcome, index) => ({
      id: `${String(index + 1).padStart(2, "0")}-${outcome.toLowerCase().replaceAll("_", "-")}`, outcome,
      steps: [{ kind: "WAIT_FRAMES" as const, frames: 2 }, ...(index < 2 ? [{ kind: "SCREENSHOT" as const, name: index ? "win" : "start" }] : [])],
    })),
  };
}

function harnessResult(plan: GodotTestPlan, start: Buffer, win: Buffer): GodotHarnessResult {
  return {
    schemaVersion: "deviludo.godot-harness-result.v1", status: "PASSED",
    checks: plan.scenarios.map((scenario) => ({ id: scenario.id, outcome: scenario.outcome, status: "PASSED", durationMs: 10, code: "OK" })),
    inputTimeline: plan.scenarios.flatMap((scenario) => scenario.steps.map((step, stepIndex) => ({ scenarioId: scenario.id, stepIndex, kind: step.kind, frame: stepIndex + 1 }))),
    screenshots: [
      { name: "start", file: "screenshots/start.png", sha256: digest(start), width: 640, height: 360 },
      { name: "win", file: "screenshots/win.png", sha256: digest(win), width: 640, height: 360 },
    ],
    performance: { averageFrameMs: 8, p95FrameMs: 12, sampledFrames: 120 },
    videoFile: "video.avi", createdAt: "2030-01-01T00:00:01.000Z",
  };
}
