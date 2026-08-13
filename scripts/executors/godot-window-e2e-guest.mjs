#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  E2E_CLIENT_HEIGHT,
  E2E_CLIENT_WIDTH,
  E2E_EVIDENCE_PROTOCOL,
  GUEST_REPORT_PROTOCOL,
  compareScreenshots,
  createEvidenceBundle,
  godotErrorLines,
  inspectScreenshot,
} from "../e2e-evidence.mjs";
import { checkpointOutputSeen, interactionEventBatches } from "./gui-event-batches.mjs";

const execute = promisify(execFile);
const action = process.argv[2];
const artifact = process.argv[3];
const jsonOutput = process.argv.includes("--json");
const jobArgument = process.argv.indexOf("--job-id");
const jobId = jobArgument >= 0 ? process.argv[jobArgument + 1] : process.env.DEVILUDO_E2E_JOB_ID ?? randomUUID();
const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
const CHECKPOINT_OUTPUT_TIMEOUT_MS = 15_000;
const CHECKPOINT_VISUAL_SETTLE_MS = 1_500;
const MIN_STATE_TRANSITION_DIFFERENCE_RATIO = 0.001;
if (!["test", "clean-install"].includes(action) || !artifact || !isAbsolute(artifact)
  || !/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("Guest runner arguments are invalid");
const guiDriver = process.env.DEVILUDO_GUI_DRIVER ?? "";
if (action === "test" && !isAbsolute(guiDriver)) throw new Error("INFRASTRUCTURE: fixed GUI driver is required");

const workspace = await mkdtemp(join(process.env.DEVILUDO_GUEST_JOB_ROOT ?? tmpdir(), `deviludo-guest-${jobId}-`));
const evidenceRoot = resolve(process.env.DEVILUDO_GUEST_EVIDENCE_ROOT ?? dirname(artifact));
const stdoutLogs = [];
const stderrLogs = [];
const screenshots = [];
const diffs = [];
const baselines = [];
const checkpoints = [];
const executedChecks = new Set();
const failures = [];
let gameExitCode = 0;
const startedAt = Date.now();

try {
  await execute("tar", ["-xzf", artifact, "-C", workspace], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  if (platform === "macos") {
    const zip = (await readdir(workspace)).find(name => name.toLowerCase().endsWith(".zip"));
    if (zip) await execute("unzip", ["-q", join(workspace, zip), "-d", workspace], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  }
  const executable = await findGameExecutable(workspace, platform);
  const manifest = JSON.parse(await readFile(join(workspace, ".deviludo-e2e/manifest.json"), "utf8").catch(() => {
    throw productFailure("E2E_MANIFEST_MISSING", "构建制品缺少 deviludo.test-manifest.v2 测试清单");
  }));
  assertManifest(manifest);

  if (action === "clean-install") {
    const smoke = await runCaptured(
      executable,
      ["--headless", "--quit-after", "120"],
      180_000,
      await isolatedGameEnvironment("clean-install"),
    );
    stdoutLogs.push(smoke.stdout); stderrLogs.push(smoke.stderr); gameExitCode = smoke.code;
    const errors = godotErrorLines(smoke.stdout, smoke.stderr);
    if (smoke.code !== 0 || errors.length) throw productFailure("GODOT_RUNTIME_ERROR", errors[0] ?? `游戏退出码 ${smoke.code}`);
  } else {
    await runUnitTests(executable, manifest);
    for (const journey of manifest.features.filter(feature => feature.verificationMethod === "interactive")) {
      await runJourney(executable, journey);
    }
    for (const visual of manifest.features.filter(feature => feature.verificationMethod === "visual")) {
      await runVisualCheck(executable, visual);
    }
    const declaredChecks = new Set(manifest.features.flatMap(feature => {
      if (feature.verificationMethod === "unit") return feature.checkNames;
      if (["interactive", "visual"].includes(feature.verificationMethod)) return [feature.id];
      return [];
    }));
    const missingChecks = [...declaredChecks].filter(check => !executedChecks.has(check));
    if (missingChecks.length) throw productFailure("CHECKS_MISSING", `测试清单声明但未执行：${missingChecks.join(", ")}`);
    const declaredCheckpoints = manifest.features
      .filter(feature => feature.verificationMethod === "interactive")
      .flatMap(feature => feature.interactionScript.events.filter(event => event.type === "checkpoint").map(event => `${feature.id}:${event.id}`));
    const captured = new Set(checkpoints.map(checkpoint => `${checkpoint.journeyId}:${checkpoint.checkpointId}`));
    const missingCheckpoints = declaredCheckpoints.filter(checkpoint => !captured.has(checkpoint));
    if (missingCheckpoints.length) throw productFailure("CHECKPOINTS_MISSING", `未执行截图检查点：${missingCheckpoints.join(", ")}`);
  }
  await finish("PASSED", null, action === "test" ? "完整测试清单和真实窗口核心旅程均已通过" : "干净回装验证通过");
} catch (error) {
  if (!isProductFailure(error)) throw error;
  failures.push(`${error.code}: ${error.message}`);
  gameExitCode = gameExitCode || 1;
  await finish("FAILED", "PRODUCT", error.message);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function runUnitTests(executable, manifest) {
  const scripts = new Map();
  for (const feature of manifest.features.filter(item => item.verificationMethod === "unit")) {
    const checks = scripts.get(feature.gdsTestPath) ?? new Set();
    feature.checkNames.forEach(check => checks.add(check));
    scripts.set(feature.gdsTestPath, checks);
  }
  let unitIndex = 0;
  for (const [script, expectedChecks] of scripts) {
    unitIndex += 1;
    const result = await runCaptured(
      executable,
      ["--headless", "--script", script],
      300_000,
      await isolatedGameEnvironment(`unit-${unitIndex}`),
    );
    stdoutLogs.push(result.stdout); stderrLogs.push(result.stderr); gameExitCode = result.code;
    if (result.timedOut) throw productFailure("UNIT_TIMEOUT", `单元测试 ${script} 超过 300 秒硬超时`);
    const errors = godotErrorLines(result.stdout, result.stderr);
    if (errors.length) throw productFailure("GODOT_SCRIPT_ERROR", errors[0]);
    const marker = [...result.stdout.matchAll(/DEVILUDO_E2E_RESULT:(.+)$/gm)].at(-1)?.[1];
    if (!marker) throw productFailure("UNIT_RESULT_MISSING", `单元测试 ${script} 未输出 DEVILUDO_E2E_RESULT`);
    let details;
    try { details = JSON.parse(marker); } catch { throw productFailure("UNIT_RESULT_INVALID", `单元测试 ${script} 返回无效 JSON`); }
    if (!Array.isArray(details.checks) || !Array.isArray(details.failures)) throw productFailure("UNIT_RESULT_INVALID", `单元测试 ${script} 返回结构无效`);
    const localChecks = new Set(details.checks);
    details.checks.forEach(check => executedChecks.add(check));
    const missing = [...expectedChecks].filter(check => !localChecks.has(check));
    if (result.code !== 0 || details.failures.length || missing.length) {
      throw productFailure("UNIT_CHECK_FAILED", [...details.failures, ...missing.map(check => `missing:${check}`)].join(", ") || `退出码 ${result.code}`);
    }
  }
}

async function runJourney(executable, journey) {
  const gameLogPath = join(workspace, "game-logs", `journey-${journey.id}.log`);
  const checkpointOutputPath = join(workspace, "checkpoint-output", `journey-${journey.id}.log`);
  await Promise.all([
    mkdir(dirname(gameLogPath), { recursive: true }),
    mkdir(dirname(checkpointOutputPath), { recursive: true }),
  ]);
  const child = spawn(executable, gameWindowArguments(gameLogPath), {
    cwd: workspace,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: await isolatedGameEnvironment(`journey-${journey.id}`, {
      DEVILUDO_E2E_CHECKPOINT_FILE: checkpointOutputPath,
    }),
  });
  const journeyStdout = [];
  const journeyStderr = [];
  child.stdout.on("data", chunk => journeyStdout.push(Buffer.from(chunk)));
  child.stderr.on("data", chunk => journeyStderr.push(Buffer.from(chunk)));
  const processClosed = new Promise(resolvePromise => child.once("close", (code, signal) => resolvePromise({ code, signal })));
  const timeout = setTimeout(() => child.kill("SIGKILL"), journey.timeoutMs);
  try {
    await driver("wait", ["--pid", String(child.pid), "--width", String(E2E_CLIENT_WIDTH), "--height", String(E2E_CLIENT_HEIGHT)]);
    const priorInputs = [];
    let previousCheckpoint = null;
    for (const batch of interactionEventBatches(journey.interactionScript.events)) {
      if (child.exitCode !== null) throw productFailure("GAME_CRASHED", `真实窗口旅程 ${journey.id} 执行期间游戏退出`);
      if (batch.kind === "sequence") {
        await driver(
          "sequence",
          ["--pid", String(child.pid), "--events", JSON.stringify(batch.events)],
          journey.timeoutMs,
        );
        priorInputs.push(...batch.events.filter(event => event.type !== "wait"));
        if (child.exitCode !== null) throw productFailure("GAME_CRASHED", `真实窗口旅程 ${journey.id} 执行期间游戏退出`);
        continue;
      }
      const event = batch.event;
      if (event.delay_ms) await delay(event.delay_ms);
      if (event.expectedOutput) {
        const observed = await waitForCheckpointOutput(
          event.expectedOutput,
          journeyStdout,
          gameLogPath,
          checkpointOutputPath,
          Math.min(CHECKPOINT_OUTPUT_TIMEOUT_MS, journey.timeoutMs),
        );
        if (!observed) {
          throw productFailure("CHECKPOINT_ASSERTION_FAILED", `${journey.id}/${event.id} 未观察到运行时状态标记 ${event.expectedOutput}`);
        }
        // Godot can report _ready() while its startup splash still covers the
        // client area. Capture only after the proved semantic state has had
        // time to reach a presented frame.
        await delay(CHECKPOINT_VISUAL_SETTLE_MS);
      }
      const evidenceId = checkpointEvidenceId(journey.id, event.id);
      const screenshotPath = join(workspace, "evidence-screenshots", `${evidenceId}.png`);
      await mkdir(dirname(screenshotPath), { recursive: true });
      const capture = await driver("capture", ["--pid", String(child.pid), "--output", screenshotPath]);
      let screenshot;
      try { screenshot = await inspectScreenshot(screenshotPath); }
      catch (error) {
        screenshots.push({ id: evidenceId, path: screenshotPath });
        checkpoints.push({
          journeyId: journey.id, checkpointId: event.id, role: event.role, status: "FAILED",
          screenshot: `screenshots/${evidenceId}.png`, capturedAt: new Date().toISOString(),
          window: { pid: capture.pid, width: capture.width, height: capture.height }, priorInputs: [...priorInputs],
          screenshotValidation: { error: error instanceof Error ? error.message : String(error) }, visualComparison: null,
        });
        throw productFailure("SCREENSHOT_INVALID", `${journey.id}/${event.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      screenshots.push({ id: evidenceId, path: screenshotPath });
      let visualComparison = null;
      let stateTransition = null;
      if (previousCheckpoint && priorInputs.length > previousCheckpoint.inputCount) {
        const comparison = await compareScreenshots(screenshotPath, previousCheckpoint.path, null, 1);
        stateTransition = {
          previousCheckpointId: previousCheckpoint.id,
          differenceRatio: comparison.differenceRatio,
          minimumDifferenceRatio: MIN_STATE_TRANSITION_DIFFERENCE_RATIO,
          passed: comparison.differenceRatio >= MIN_STATE_TRANSITION_DIFFERENCE_RATIO,
        };
        if (!stateTransition.passed) {
          checkpoints.push(checkpointRecord(
            journey, event, capture, priorInputs, screenshot, visualComparison, null, "FAILED", stateTransition,
          ));
          throw productFailure(
            "CHECKPOINT_VISUAL_STATE_UNCHANGED",
            `${journey.id}/${event.id} 与 ${previousCheckpoint.id} 仅有 ${(comparison.differenceRatio * 100).toFixed(3)}% 像素变化，无法证明输入产生了可见状态变化`,
          );
        }
      }
      if (event.referenceImage) {
        const baselinePath = resolve(workspace, ".deviludo-e2e", event.referenceImage);
        if (!baselinePath.startsWith(resolve(workspace, ".deviludo-e2e") + "/")) throw productFailure("BASELINE_PATH_INVALID", event.referenceImage);
        await access(baselinePath).catch(() => { throw productFailure("BASELINE_MISSING", event.referenceImage); });
        const diffPath = join(workspace, "evidence-diff", `${evidenceId}.png`);
        visualComparison = await compareScreenshots(screenshotPath, baselinePath, diffPath, event.threshold ?? 0.01);
        baselines.push({ id: evidenceId, path: baselinePath });
        if (!visualComparison.passed) {
          diffs.push({ id: evidenceId, path: diffPath });
          checkpoints.push(checkpointRecord(journey, event, capture, priorInputs, screenshot, visualComparison, null, "FAILED", stateTransition));
          throw productFailure("VISUAL_DIFFERENCE", `${journey.id}/${event.id} 差异 ${(visualComparison.differenceRatio * 100).toFixed(3)}% 超过阈值`);
        }
      }
      const outputAssertion = event.expectedOutput ? { expectedOutput: event.expectedOutput, observed: true } : null;
      if (outputAssertion && !outputAssertion.observed) {
        checkpoints.push(checkpointRecord(journey, event, capture, priorInputs, screenshot, visualComparison, outputAssertion, "FAILED", stateTransition));
        throw productFailure("CHECKPOINT_ASSERTION_FAILED", `${journey.id}/${event.id} 未观察到运行时状态标记 ${event.expectedOutput}`);
      }
      checkpoints.push(checkpointRecord(journey, event, capture, priorInputs, screenshot, visualComparison, outputAssertion, "PASSED", stateTransition));
      previousCheckpoint = { id: event.id, path: screenshotPath, inputCount: priorInputs.length };
    }
    executedChecks.add(journey.id);
  } catch (error) {
    if (String(error?.message ?? error).startsWith("INFRASTRUCTURE:")) throw error;
    if (isProductFailure(error)) throw error;
    throw productFailure("INPUT_OR_WINDOW_FAILED", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGTERM");
    const closed = await Promise.race([processClosed, delay(5_000).then(() => null)]);
    if (!closed && child.exitCode === null) child.kill("SIGKILL");
    const gameLog = await readOptionalLog(gameLogPath);
    const checkpointOutput = await readOptionalLog(checkpointOutputPath);
    const stdout = [Buffer.concat(journeyStdout).toString("utf8"), gameLog.toString("utf8"), checkpointOutput.toString("utf8")]
      .filter(Boolean).join("\n");
    const stderr = Buffer.concat(journeyStderr).toString("utf8");
    stdoutLogs.push(stdout); stderrLogs.push(stderr);
    const errors = godotErrorLines(stdout, stderr);
    if (errors.length) failures.push(`GODOT_SCRIPT_ERROR: ${errors[0]}`);
  }
  if (failures.some(failure => failure.startsWith("GODOT_SCRIPT_ERROR"))) throw productFailure("GODOT_SCRIPT_ERROR", failures.at(-1));
}

async function runVisualCheck(executable, feature) {
  const gameLogPath = join(workspace, "game-logs", `visual-${feature.id}.log`);
  await mkdir(dirname(gameLogPath), { recursive: true });
  const child = spawn(executable, gameWindowArguments(gameLogPath), {
    cwd: workspace,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: await isolatedGameEnvironment(`visual-${feature.id}`),
  });
  const visualStdout = [];
  const visualStderr = [];
  child.stdout.on("data", chunk => visualStdout.push(Buffer.from(chunk)));
  child.stderr.on("data", chunk => visualStderr.push(Buffer.from(chunk)));
  const processClosed = new Promise(resolvePromise => child.once("close", code => resolvePromise(code)));
  try {
    await driver("wait", ["--pid", String(child.pid), "--width", String(E2E_CLIENT_WIDTH), "--height", String(E2E_CLIENT_HEIGHT)]);
    await delay(feature.expectedVisual.captureDelay ?? 1_000);
    const evidenceId = `visual-${feature.id}`;
    const screenshotPath = join(workspace, "evidence-screenshots", `${evidenceId}.png`);
    await mkdir(dirname(screenshotPath), { recursive: true });
    const capture = await driver("capture", ["--pid", String(child.pid), "--output", screenshotPath]);
    let screenshot;
    try { screenshot = await inspectScreenshot(screenshotPath); }
    catch (error) {
      screenshots.push({ id: evidenceId, path: screenshotPath });
      checkpoints.push({
        journeyId: feature.id, checkpointId: feature.id, role: "VISUAL", status: "FAILED",
        screenshot: `screenshots/${evidenceId}.png`, capturedAt: new Date().toISOString(),
        window: { pid: capture.pid, width: capture.width, height: capture.height }, priorInputs: [],
        screenshotValidation: { error: error instanceof Error ? error.message : String(error) }, visualComparison: null,
      });
      throw productFailure("SCREENSHOT_INVALID", `${feature.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const baselinePath = resolve(workspace, ".deviludo-e2e", feature.expectedVisual.referenceImage);
    const e2eRoot = `${resolve(workspace, ".deviludo-e2e")}/`;
    if (!baselinePath.startsWith(e2eRoot)) throw productFailure("BASELINE_PATH_INVALID", feature.expectedVisual.referenceImage);
    await access(baselinePath).catch(() => { throw productFailure("BASELINE_MISSING", feature.expectedVisual.referenceImage); });
    const diffPath = join(workspace, "evidence-diff", `${evidenceId}.png`);
    const comparison = await compareScreenshots(
      screenshotPath,
      baselinePath,
      diffPath,
      feature.expectedVisual.threshold ?? 0.01,
    );
    screenshots.push({ id: evidenceId, path: screenshotPath });
    baselines.push({ id: evidenceId, path: baselinePath });
    checkpoints.push({
      journeyId: feature.id,
      checkpointId: feature.id,
      role: "VISUAL",
      status: comparison.passed ? "PASSED" : "FAILED",
      screenshot: `screenshots/${evidenceId}.png`,
      capturedAt: new Date().toISOString(),
      window: { pid: capture.pid, width: capture.width, height: capture.height },
      priorInputs: [],
      screenshotValidation: screenshot,
      visualComparison: comparison,
    });
    if (!comparison.passed) {
      diffs.push({ id: evidenceId, path: diffPath });
      throw productFailure("VISUAL_DIFFERENCE", `${feature.id} 差异 ${(comparison.differenceRatio * 100).toFixed(3)}% 超过阈值`);
    }
    executedChecks.add(feature.id);
  } catch (error) {
    if (String(error?.message ?? error).startsWith("INFRASTRUCTURE:")) throw error;
    if (isProductFailure(error)) throw error;
    throw productFailure("VISUAL_CHECK_FAILED", error instanceof Error ? error.message : String(error));
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([processClosed, delay(5_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    const gameLog = await readOptionalLog(gameLogPath);
    const stdout = [Buffer.concat(visualStdout).toString("utf8"), gameLog.toString("utf8")].filter(Boolean).join("\n");
    const stderr = Buffer.concat(visualStderr).toString("utf8");
    stdoutLogs.push(stdout); stderrLogs.push(stderr);
    const errors = godotErrorLines(stdout, stderr);
    if (errors.length) failures.push(`GODOT_SCRIPT_ERROR: ${errors[0]}`);
  }
  if (failures.some(failure => failure.startsWith("GODOT_SCRIPT_ERROR"))) {
    throw productFailure("GODOT_SCRIPT_ERROR", failures.at(-1));
  }
}

function checkpointRecord(journey, event, capture, priorInputs, screenshot, visualComparison, outputAssertion, status, stateTransition = null) {
  return {
    journeyId: journey.id,
    checkpointId: event.id,
    role: event.role,
    status,
    screenshot: `screenshots/${checkpointEvidenceId(journey.id, event.id)}.png`,
    capturedAt: new Date().toISOString(),
    window: { pid: capture.pid, width: capture.width, height: capture.height },
    priorInputs: [...priorInputs],
    screenshotValidation: screenshot,
    visualComparison,
    stateTransition,
    outputAssertion,
  };
}

async function waitForCheckpointOutput(expectedOutput, stdoutChunks, gameLogPath, checkpointOutputPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (checkpointOutputSeen([
      ...stdoutChunks,
      await readOptionalLog(gameLogPath),
      await readOptionalLog(checkpointOutputPath),
    ], expectedOutput)) return true;
    await delay(50);
  }
  return false;
}

async function finish(outcome, failureDomain, summary) {
  const report = {
    schemaVersion: E2E_EVIDENCE_PROTOCOL,
    jobId,
    platform,
    action,
    outcome,
    failureDomain,
    summary,
    testDetails: {
      suite: "deviludo-real-window-e2e",
      checks: [...executedChecks],
      failures,
      duration_ms: Date.now() - startedAt,
    },
    checkpoints,
    screenshotCount: screenshots.length,
    visualDiff: diffs.length > 0,
  };
  const bundle = await createEvidenceBundle({ outputRoot: evidenceRoot, jobId, platform, report, stdout: stdoutLogs.join("\n"), stderr: stderrLogs.join("\n"), screenshots, diffs, baselines });
  const receipt = {
    schemaVersion: GUEST_REPORT_PROTOCOL,
    action,
    jobId,
    outcome,
    failureDomain,
    summary,
    guest: { executor: "real-window-godot", isolation: "EPHEMERAL_VM", exitCode: outcome === "PASSED" ? 0 : gameExitCode || 1 },
    testDetails: report.testDetails,
    evidence: { protocol: E2E_EVIDENCE_PROTOCOL, result: outcome, checkCount: executedChecks.size, screenshotCount: screenshots.length, hasVisualDiff: diffs.length > 0 },
    outputPath: bundle.outputPath,
    outputSha256: bundle.outputSha256,
    outputSizeBytes: bundle.outputSizeBytes,
  };
  process.stdout.write(jsonOutput ? JSON.stringify(receipt) : `${JSON.stringify(receipt, null, 2)}\n`);
}

async function driver(command, arguments_, timeout = 30_000) {
  try {
    const { stdout } = await execute(guiDriver, [command, ...arguments_], { timeout, maxBuffer: 1024 * 1024, env: safeEnvironment() });
    const value = JSON.parse(stdout);
    if (!value || value.ok !== true) throw new Error("GUI driver returned an invalid receipt");
    const pidIndex = arguments_.indexOf("--pid");
    const expectedPid = pidIndex >= 0 ? Number(arguments_[pidIndex + 1]) : 0;
    if (value.pid !== expectedPid || (["wait", "capture"].includes(command)
      && (value.width !== E2E_CLIENT_WIDTH || value.height !== E2E_CLIENT_HEIGHT))) {
      throw new Error("GUI driver did not lock the requested PID and 1280x720 client area");
    }
    return value;
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error);
    if (/permission|not authorized|display unavailable|capture backend|accessibility|unsupported (?:keyboard|mouse|input)|GUI driver/i.test(detail)) {
      throw new Error(`INFRASTRUCTURE: ${detail.slice(0, 500)}`);
    }
    throw new Error(detail.slice(0, 2_000), { cause: error });
  }
}

async function runCaptured(executable, arguments_, timeout, environment = safeEnvironment()) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, arguments_, { cwd: workspace, shell: false, stdio: ["ignore", "pipe", "pipe"], env: environment });
    const stdout = [], stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectPromise);
    child.once("close", code => { clearTimeout(timer); resolvePromise({ code: Number.isInteger(code) ? code : 124, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
  });
}

async function findGameExecutable(root, operatingSystem) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
  const selected = operatingSystem === "macos" ? files.find(path => path.includes(".app/Contents/MacOS/"))
    : operatingSystem === "windows" ? files.find(path => path.toLowerCase().endsWith(".exe"))
      : files.find(path => path.endsWith(".x86_64"));
  if (!selected) throw productFailure("EXECUTABLE_MISSING", `构建制品不包含 ${operatingSystem} 游戏可执行程序`);
  if (operatingSystem !== "windows") await chmod(selected, 0o700);
  return selected;
}

function assertManifest(value) {
  if (!value || value.schemaVersion !== "deviludo.test-manifest.v2" || !Array.isArray(value.requirements) || !value.requirements.length
    || value.requirements.length > 500 || !Array.isArray(value.features) || !value.features.length || value.features.length > 500) {
    throw productFailure("E2E_MANIFEST_INVALID", "测试清单结构无效");
  }
  const requirementIds = new Set();
  for (const requirement of value.requirements) {
    if (!requirement || typeof requirement.requirementId !== "string" || !stableId(requirement.requirementId)
      || requirementIds.has(requirement.requirementId) || typeof requirement.description !== "string"
      || !requirement.description.trim() || requirement.description.length > 2_000) {
      throw productFailure("E2E_MANIFEST_INVALID", "测试清单需求映射无效");
    }
    requirementIds.add(requirement.requirementId);
  }
  const featureIds = new Set();
  const checkNames = new Set();
  const automatedCoverage = new Set();
  let totalEvents = 0;
  let totalCheckpoints = 0;
  for (const feature of value.features) {
    if (!feature || typeof feature.id !== "string" || !stableId(feature.id) || featureIds.has(feature.id)
      || !Array.isArray(feature.requirementIds) || feature.requirementIds.length < 1
      || feature.requirementIds.some(id => !requirementIds.has(id))
      || !["unit", "interactive", "visual", "manual"].includes(feature.verificationMethod)) {
      throw productFailure("E2E_MANIFEST_INVALID", "测试清单测试项无效");
    }
    featureIds.add(feature.id);
    if (feature.verificationMethod !== "manual") feature.requirementIds.forEach(id => automatedCoverage.add(id));
    if (feature.verificationMethod === "unit") {
      if (typeof feature.gdsTestPath !== "string" || !safeGodotPath(feature.gdsTestPath)
        || !Array.isArray(feature.checkNames) || feature.checkNames.length < 1
        || feature.checkNames.some(check => typeof check !== "string" || !stableId(check) || checkNames.has(check))) {
        throw productFailure("E2E_MANIFEST_INVALID", `单元测试项 ${feature.id} 无效`);
      }
      feature.checkNames.forEach(check => checkNames.add(check));
    }
    if (feature.verificationMethod === "interactive") {
      if (!Number.isInteger(feature.timeoutMs) || feature.timeoutMs < 1 || feature.timeoutMs > 300_000
        || !validInteractionScript(feature.interactionScript)) {
        throw productFailure("E2E_MANIFEST_INVALID", `交互旅程 ${feature.id} 无效`);
      }
      totalEvents += feature.interactionScript.events.length;
      totalCheckpoints += feature.interactionScript.events.filter(event => event.type === "checkpoint").length;
    }
    if (feature.verificationMethod === "visual") {
      const expected = feature.expectedVisual;
      if (!expected || expected.version !== "1" || !safePngPath(expected.referenceImage)
        || (expected.threshold !== undefined && (!Number.isFinite(expected.threshold) || expected.threshold < 0 || expected.threshold > 1))
        || (expected.captureDelay !== undefined && (!Number.isInteger(expected.captureDelay) || expected.captureDelay < 0 || expected.captureDelay > 300_000))) {
        throw productFailure("E2E_MANIFEST_INVALID", `视觉测试项 ${feature.id} 无效`);
      }
      totalCheckpoints += 1;
    }
  }
  if ([...requirementIds].some(id => !automatedCoverage.has(id))) {
    throw productFailure("REQUIREMENT_COVERAGE_MISSING", "至少一条批准需求没有自动测试覆盖");
  }
  const journeys = value.features.filter(feature => feature.verificationMethod === "interactive");
  const core = journeys.find(feature => feature.coreJourney === true && feature.category === "core-loop");
  if (!core || journeys.length > 32 || totalEvents > 32 * 200 || totalCheckpoints < 3 || totalCheckpoints > 20) {
    throw productFailure("CORE_JOURNEY_MISSING", "测试清单缺少合规的核心循环真实交互旅程");
  }
  const roles = new Set(core.interactionScript?.events?.filter(event => event.type === "checkpoint").map(event => event.role));
  if (!["START", "KEY_STATE", "COMPLETION"].every(role => roles.has(role))) throw productFailure("CORE_CHECKPOINTS_MISSING", "核心旅程缺少启动、关键状态或完成检查点");
  if (!core.interactionScript.events.some(event => event.type === "key_press" || event.type === "mouse_click")) {
    throw productFailure("CORE_INPUT_MISSING", "核心旅程必须执行至少一次真实键盘或鼠标操作");
  }
  const coreCheckpoints = core.interactionScript.events.filter(event => event.type === "checkpoint");
  if (coreCheckpoints.some(event => !event.referenceImage && event.expectedOutput !== checkpointOutputMarker(event.id))) {
    throw productFailure("CORE_CHECKPOINT_ASSERTION_MISSING", "核心旅程的每个检查点必须声明视觉基线或运行时状态标记");
  }
}

function validInteractionScript(script) {
  if (!script || script.version !== "2" || !Array.isArray(script.events) || script.events.length < 1 || script.events.length > 200) return false;
  const checkpoints = new Set();
  return script.events.every(event => {
    if (!event || typeof event.type !== "string"
      || (event.delay_ms === undefined ? event.type === "wait" : !Number.isInteger(event.delay_ms) || event.delay_ms < 0 || event.delay_ms > 300_000)) return false;
    if (["key_press", "key_release"].includes(event.type)) return typeof event.key === "string" && /^[A-Z0-9_]{1,64}$/.test(event.key);
    if (event.type === "mouse_move") return Number.isInteger(event.x) && event.x >= 0 && event.x < 1280 && Number.isInteger(event.y) && event.y >= 0 && event.y < 720;
    if (event.type === "mouse_click") return ["LEFT", "RIGHT", "MIDDLE"].includes(event.button);
    if (event.type === "wait") return true;
    if (event.type !== "checkpoint" || typeof event.id !== "string" || !stableId(event.id) || checkpoints.has(event.id)
      || !["START", "KEY_STATE", "COMPLETION"].includes(event.role)
      || (event.referenceImage !== undefined && !safePngPath(event.referenceImage))
      || (event.expectedOutput !== undefined && event.expectedOutput !== checkpointOutputMarker(event.id))
      || (event.threshold !== undefined && (!Number.isFinite(event.threshold) || event.threshold < 0 || event.threshold > 1))) return false;
    checkpoints.add(event.id);
    return true;
  });
}

function checkpointOutputMarker(checkpointId) {
  return `DEVILUDO_E2E_CHECKPOINT:${checkpointId}`;
}

function stableId(value) { return /^[a-z0-9][a-z0-9-]{0,119}$/.test(value); }
function safeGodotPath(value) {
  return /^res:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,219}\.gd$/.test(value)
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value.slice(6));
}
function safePngPath(value) {
  return typeof value === "string" && value.length >= 5 && value.length <= 240 && value.toLowerCase().endsWith(".png")
    && !value.startsWith("/") && !value.startsWith("res://") && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value)
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*\.png$/i.test(value);
}

function productFailure(code, message) {
  return Object.assign(new Error(String(message).slice(0, 2000)), { code, productFailure: true });
}

function isProductFailure(error) {
  return Boolean(error && typeof error === "object" && error.productFailure === true);
}

function safeEnvironment(overrides = {}) {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    DISPLAY: process.env.DISPLAY ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    ...overrides,
  };
}

async function isolatedGameEnvironment(scope, overrides = {}) {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(scope)) throw new Error("Game user-data scope is invalid");
  const root = join(workspace, "game-user-data", scope);
  const xdgData = join(root, ".local", "share");
  const xdgConfig = join(root, ".config");
  const xdgCache = join(root, ".cache");
  const appData = join(root, "AppData", "Roaming");
  const localAppData = join(root, "AppData", "Local");
  await Promise.all([root, xdgData, xdgConfig, xdgCache, appData, localAppData].map(path => mkdir(path, { recursive: true })));
  return safeEnvironment({
    HOME: root,
    USERPROFILE: root,
    XDG_DATA_HOME: xdgData,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    ...overrides,
  });
}

function gameWindowArguments(logPath) {
  return ["--log-file", logPath, "--windowed", "--resolution", `${E2E_CLIENT_WIDTH}x${E2E_CLIENT_HEIGHT}`, "--position", "40,40"];
}

async function readOptionalLog(path) {
  return readFile(path).catch(() => Buffer.alloc(0));
}

function checkpointEvidenceId(journeyId, checkpointId) {
  return `journey-${journeyId.length}-${journeyId}-${checkpointId}`;
}

function delay(milliseconds) { return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds)); }
