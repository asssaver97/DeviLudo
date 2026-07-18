import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Canonical } from "../../runner-control/src/canonical";
import type { RunnerJobPayload, SignedRunnerJob } from "../../runner-control/src/contracts";
import type { GodotHarnessResult, GodotTestKitRunRequest, GodotTestPlan } from "../src/contracts";
import { execGodotProcess, ExecFileGodotPlatformDriver, PLATFORM_HARNESS_GDSCRIPT, type GodotProcess } from "../src/godot-driver";

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const sha = (value: string) => value.repeat(64);

test("production driver uses fixed Godot commands, scrubs Broker credentials and verifies harness files", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-godot-driver-"));
  try {
    const workspace = join(root, "workspace");
    const runRoot = join(root, "execution");
    const godot = join(root, "godot");
    const planPath = join(root, "plan.json");
    await Promise.all([mkdir(workspace), mkdir(runRoot), writeFile(godot, "godot-binary"), writeFile(planPath, "{}")]);
    const plan = testPlan();
    const request = runRequest(godot);
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const process: GodotProcess = async (_executable, args, options) => {
      calls.push({ args, env: options.env });
      assert.equal(options.env.DEVILUDO_TESTKIT_ARTIFACT_TLS_KEY_FILE, undefined);
      if (args.includes("--script")) {
        const outputRoot = args[args.indexOf("--output") + 1]!;
        await mkdir(join(outputRoot, "screenshots"), { recursive: true });
        const frame = Buffer.from("png-frame");
        await Promise.all([
          writeFile(join(outputRoot, "screenshots", "start.png"), frame),
          writeFile(join(outputRoot, "screenshots", "win.png"), frame),
          writeFile(join(outputRoot, "video.avi"), "video"),
          writeFile(join(outputRoot, "result.json"), JSON.stringify(harness(plan, digest(frame)))),
        ]);
      }
      if (args.includes("--export-release")) await writeFile(args.at(-1)!, "export");
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 10 };
    };
    const result = await new ExecFileGodotPlatformDriver(process, {
      DISPLAY: ":91",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DEVILUDO_TESTKIT_ARTIFACT_TLS_KEY_FILE: "/must/not/leak",
      API_KEY: "must-not-leak",
    }).run({ request, plan, workspace, runRoot, planPath });
    assert.equal(result.harness?.status, "PASSED");
    assert.deepEqual(result.commands.map((command) => command.id), [
      "import", "boot", "platform-suite", "production-export", "production-boot",
    ]);
    assert.deepEqual(calls[0]!.args, ["--headless", "--path", workspace, "--editor", "--quit"]);
    assert.equal(calls[2]!.args.includes("--write-movie"), true);
    assert.deepEqual(calls[3]!.args.slice(0, 5), ["--headless", "--path", workspace, "--export-release", "DeviLudo Linux"]);
    assert.deepEqual(calls[4]!.args, ["--headless", "--quit-after", "120"]);
    assert.equal(calls[0]!.env.DISPLAY, ":91");
    assert.equal(calls[0]!.env.XDG_RUNTIME_DIR, "/run/user/1000");
    assert.equal(calls[0]!.env.API_KEY, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production driver retains valid failed harness evidence but rejects exit/result drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-godot-driver-"));
  try {
    const workspace = join(root, "workspace");
    const runRoot = join(root, "execution");
    const godot = join(root, "godot");
    const planPath = join(root, "plan.json");
    await Promise.all([mkdir(workspace), mkdir(runRoot), writeFile(godot, "godot-binary"), writeFile(planPath, "{}")]);
    const plan = testPlan();
    let suiteExit = 1;
    const process: GodotProcess = async (_executable, args) => {
      if (args.includes("--script")) {
        const outputRoot = args[args.indexOf("--output") + 1]!;
        await mkdir(join(outputRoot, "screenshots"), { recursive: true });
        const frame = Buffer.from("png-frame");
        await Promise.all([
          writeFile(join(outputRoot, "screenshots", "start.png"), frame),
          writeFile(join(outputRoot, "screenshots", "win.png"), frame),
          writeFile(join(outputRoot, "video.avi"), "video"),
          writeFile(join(outputRoot, "result.json"), JSON.stringify(harness(plan, digest(frame), "FAILED"))),
        ]);
        return { exitCode: suiteExit, stdout: "", stderr: "", durationMs: 10 };
      }
      if (args.includes("--export-release")) await writeFile(args.at(-1)!, "export");
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 10 };
    };
    const valid = await new ExecFileGodotPlatformDriver(process).run({ request: runRequest(godot), plan, workspace, runRoot, planPath });
    assert.equal(valid.harness?.status, "FAILED");

    const secondRoot = join(root, "second");
    await mkdir(secondRoot);
    suiteExit = 0;
    const drift = await new ExecFileGodotPlatformDriver(process).run({ request: runRequest(godot), plan, workspace, runRoot: secondRoot, planPath });
    assert.equal(drift.harness, null);
    assert.equal(drift.commands.find((command) => command.id === "platform-suite")?.code, "HARNESS_RESULT_INVALID");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("platform-owned harness executes real Godot scenarios and captures screenshots/video", async (context) => {
  const godot = "/Applications/Godot.app/Contents/MacOS/Godot";
  try { await access(godot); }
  catch { context.skip("Godot is not installed on this host"); return; }
  const root = await mkdtemp(join(tmpdir(), "deviludo-real-testkit-"));
  try {
    const workspace = join(root, "workspace");
    const runRoot = join(root, "execution");
    const planPath = join(root, "test-plan.json");
    await cp(fileURLToPath(new URL("../../../fixtures/godot-testkit-smoke", import.meta.url)), workspace, { recursive: true });
    await mkdir(runRoot);
    const plan = macosPlan();
    await writeFile(planPath, canonicalJson(plan));
    const base = runRequest(godot);
    const payload = { ...base.signedJob.payload, platform: "macos" as const, targetMatrix: ["macos"] as const };
    const request: GodotTestKitRunRequest = {
      ...base,
      jobDigest: sha256Canonical(payload),
      godot: { ...base.godot, binaryDigest: await fileDigest(godot) },
      signedJob: { ...base.signedJob, payload },
    };
    const result = await new ExecFileGodotPlatformDriver().run({ request, plan, workspace, runRoot, planPath });
    if (!result.harness) {
      context.skip("this host does not expose a graphical Godot movie-capture session");
      return;
    }
    assert.equal(result.commands.find((command) => command.id === "import")?.status, "PASSED");
    assert.equal(result.commands.find((command) => command.id === "boot")?.status, "PASSED");
    assert.equal(result.harness?.status, "PASSED", `${result.logs}\n${JSON.stringify(result.harness)}`);
    assert.equal(result.commands.find((command) => command.id === "platform-suite")?.status, "PASSED", result.logs);
    assert.equal(result.harness?.screenshots.length, 2);
    assert.equal(result.harness?.performance.sampledFrames, 30);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("platform-owned harness executes the real scenario DSL in headless Godot", async (context) => {
  const godot = "/Applications/Godot.app/Contents/MacOS/Godot";
  try { await access(godot); }
  catch { context.skip("Godot is not installed on this host"); return; }
  const root = await mkdtemp(join(tmpdir(), "deviludo-real-harness-"));
  try {
    const workspace = join(root, "workspace");
    const output = join(root, "output");
    const harnessPath = join(root, "platform-harness.gd");
    const planPath = join(root, "test-plan.json");
    await cp(fileURLToPath(new URL("../../../fixtures/godot-testkit-smoke", import.meta.url)), workspace, { recursive: true });
    await mkdir(join(output, "screenshots"), { recursive: true });
    const plan = {
      ...macosPlan(),
      scenarios: macosPlan().scenarios.map((scenario) => ({
        ...scenario,
        steps: scenario.steps.filter((step) => step.kind !== "SCREENSHOT"),
      })),
    };
    await Promise.all([writeFile(planPath, canonicalJson(plan)), writeFile(harnessPath, PLATFORM_HARNESS_GDSCRIPT)]);
    const result = await execGodotProcess(godot, [
      "--headless", "--path", workspace, "--script", harnessPath,
      "--", "--plan", planPath, "--output", output,
    ], {
      cwd: workspace,
      env: { NODE_ENV: "test", HOME: join(root, "home"), TMPDIR: root, LANG: "C.UTF-8" },
      timeoutMs: 60_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(await readFile(join(output, "result.json"), "utf8")) as { status: string; checks: unknown[] };
    assert.equal(parsed.status, "PASSED");
    assert.equal(parsed.checks.length, 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function testPlan(): GodotTestPlan {
  const outcomes = ["CORE_LOOP", "WIN", "LOSE", "PAUSE_SETTINGS", "SAVE_LOAD"] as const;
  return {
    schemaVersion: "deviludo.godot-test-plan.v2",
    engine: "godot-4",
    targetMatrix: ["linux"],
    requiredGodotVersion: "4.6.2-stable",
    timeouts: { importSeconds: 60, bootSeconds: 60, suiteSeconds: 300, exportSeconds: 600 },
    performance: { warmupFrames: 1, sampleFrames: 30, maximumAverageFrameMs: 16, maximumP95FrameMs: 32 },
    scenarios: outcomes.map((outcome, index) => ({
      id: `${index + 1}-${outcome.toLowerCase().replaceAll("_", "-")}`,
      outcome,
      steps: [{ kind: "WAIT_FRAMES" as const, frames: 1 }, ...(index < 2 ? [{ kind: "SCREENSHOT" as const, name: index ? "win" : "start" }] : [])],
    })),
  };
}

function macosPlan(): GodotTestPlan {
  return {
    schemaVersion: "deviludo.godot-test-plan.v2",
    engine: "godot-4",
    targetMatrix: ["macos"],
    requiredGodotVersion: "4.6.2-stable",
    timeouts: { importSeconds: 60, bootSeconds: 60, suiteSeconds: 120, exportSeconds: 300 },
    performance: { warmupFrames: 2, sampleFrames: 30, maximumAverageFrameMs: 100, maximumP95FrameMs: 200 },
    scenarios: [
      { id: "01-core-loop", outcome: "CORE_LOOP", steps: [
        { kind: "WAIT_FRAMES", frames: 2 },
        { kind: "ASSERT_GROUP_COUNT", group: "deviludo.core_loop", minimum: 1, maximum: 1 },
        { kind: "SCREENSHOT", name: "start" },
      ] },
      { id: "02-lose", outcome: "LOSE", steps: [
        { kind: "ACTION", action: "test_lose", pressed: true, framesAfter: 2 },
        { kind: "ASSERT_PROPERTY", nodePath: ".", property: "phase", equals: "lose" },
      ] },
      { id: "03-pause-settings", outcome: "PAUSE_SETTINGS", steps: [
        { kind: "ACTION", action: "test_pause", pressed: true, framesAfter: 2 },
        { kind: "ASSERT_PROPERTY", nodePath: ".", property: "paused", equals: true },
        { kind: "ASSERT_PROPERTY", nodePath: ".", property: "settings_open", equals: true },
      ] },
      { id: "04-save-load", outcome: "SAVE_LOAD", steps: [
        { kind: "ACTION", action: "test_save", pressed: true, framesAfter: 2 },
        { kind: "ACTION", action: "test_mutate", pressed: true, framesAfter: 2 },
        { kind: "ACTION", action: "test_load", pressed: true, framesAfter: 2 },
        { kind: "ASSERT_PROPERTY", nodePath: ".", property: "coins", equals: 7 },
      ] },
      { id: "05-win", outcome: "WIN", steps: [
        { kind: "ACTION", action: "test_win", pressed: true, framesAfter: 2 },
        { kind: "ASSERT_PROPERTY", nodePath: ".", property: "phase", equals: "win" },
        { kind: "SCREENSHOT", name: "win" },
      ] },
    ],
  };
}

function harness(plan: GodotTestPlan, frameDigest: string, status: "PASSED" | "FAILED" = "PASSED"): GodotHarnessResult {
  const inputTimeline = status === "PASSED"
    ? plan.scenarios.flatMap((scenario) => scenario.steps.map((step, stepIndex) => ({
      scenarioId: scenario.id,
      stepIndex,
      kind: step.kind,
      frame: stepIndex + 1,
    })))
    : [{ scenarioId: plan.scenarios[0]!.id, stepIndex: 0, kind: "WAIT_FRAMES" as const, frame: 1 }];
  const screenshots = status === "PASSED"
    ? [
      { name: "start", file: "screenshots/start.png", sha256: frameDigest, width: 640, height: 360 },
      { name: "win", file: "screenshots/win.png", sha256: frameDigest, width: 640, height: 360 },
    ]
    : [{ name: "start", file: "screenshots/start.png", sha256: frameDigest, width: 640, height: 360 }];
  return {
    schemaVersion: "deviludo.godot-harness-result.v1",
    status,
    checks: plan.scenarios.map((scenario, index) => ({
      id: scenario.id,
      outcome: scenario.outcome,
      status: status === "FAILED" && index === 0 ? "FAILED" : "PASSED",
      durationMs: 1,
      code: status === "FAILED" && index === 0 ? "STEP_ASSERTION_FAILED" : "OK",
    })),
    inputTimeline,
    screenshots,
    performance: { averageFrameMs: 8, p95FrameMs: 12, sampledFrames: 30 },
    videoFile: "video.avi",
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

function runRequest(godot: string): GodotTestKitRunRequest {
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
    leaseExpiresAt: "2030-01-01T00:10:00.000Z",
    executionLockId: "66666666-6666-4666-8666-666666666666",
    executionLockDigest: sha("1"),
    commitSha: "a".repeat(40), sourceDigest: sha("2"),
    execution: { kind: "SOURCE_ARTIFACT", objectKey: "source.tar.zst", artifactDigest: sha("3") },
    specRevisionId: "77777777-7777-4777-8777-777777777777",
    specDigest: sha("4"), testPlanDigest: sha("5"), targetMatrix: ["linux"],
    requiredGodotVersion: "4.6.2-stable", godotTestKitDigest: sha("6"), exportTemplatesDigest: sha("7"),
    runnerCapabilityDigest: sha("8"), buildManifestDigest: sha("9"), sbomDigest: sha("a"),
    vulnerabilityScanDigest: sha("b"), assetLicenseLedgerDigest: sha("c"),
    requiredEvidence: ["logs", "junit", "input-timeline", "screenshots", "video", "production-export"],
  };
  const signedJob: SignedRunnerJob = { payload, signature: { algorithm: "Ed25519", keyId: "key", value: "opaque" } };
  return {
    schemaVersion: "deviludo.testkit-run-request.v2",
    jobDigest: sha256Canonical(payload),
    testKitDigest: payload.godotTestKitDigest,
    godot: { executable: godot, binaryDigest: digest("godot-binary"), version: payload.requiredGodotVersion },
    signedJob,
  };
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
