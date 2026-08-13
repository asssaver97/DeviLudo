#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  E2E_CLIENT_HEIGHT,
  E2E_CLIENT_WIDTH,
  E2E_EVIDENCE_PROTOCOL,
  GUEST_REPORT_PROTOCOL,
  compareScreenshots,
  compareScreenshotRegion,
  createEvidenceBundle,
  godotErrorLines,
  inspectScreenshot,
} from "../e2e-evidence.mjs";
import {
  evaluateProbeAssertions,
  probeStateDigest,
  resolveProbeControl,
  waitForProbeSnapshot,
} from "../e2e-ui-probe.mjs";
import { checkpointOutputSeen } from "./gui-event-batches.mjs";

const execute = promisify(execFile);
const action = process.argv[2];
const artifact = process.argv[3];
const jsonOutput = process.argv.includes("--json");
const jobArgument = process.argv.indexOf("--job-id");
const jobId = jobArgument >= 0 ? process.argv[jobArgument + 1] : process.env.DEVILUDO_E2E_JOB_ID ?? randomUUID();
const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
const CHECKPOINT_OUTPUT_TIMEOUT_MS = 15_000;
const CHECKPOINT_VISUAL_SETTLE_MS = 1_500;
const PROBE_TIMEOUT_MS = 15_000;
const MIN_STATE_TRANSITION_DIFFERENCE_RATIO = 0.001;
const PLATFORM_TIMEOUT_MS = 30 * 60_000;
const MAX_SCREENSHOTS = 64;

if (!["test", "clean-install"].includes(action) || !artifact || !isAbsolute(artifact)
  || !/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("Guest runner arguments are invalid");
const guiDriver = process.env.DEVILUDO_GUI_DRIVER ?? "";
if (!isAbsolute(guiDriver)) throw new Error("INFRASTRUCTURE: fixed GUI driver is required");

const workspace = await mkdtemp(join(process.env.DEVILUDO_GUEST_JOB_ROOT ?? tmpdir(), `deviludo-guest-${jobId}-`));
const evidenceRoot = resolve(process.env.DEVILUDO_GUEST_EVIDENCE_ROOT ?? dirname(artifact));
const stdoutLogs = [];
const stderrLogs = [];
const screenshots = [];
const diffs = [];
const baselines = [];
const checkpoints = [];
const steps = [];
const headlessChecks = new Set();
const interactiveJourneys = new Set();
const coveredPlayerRequirements = new Set();
const failures = [];
const launchRecords = [];
let gameExitCode = 0;
let activeManifest = null;
const startedAt = Date.now();
const platformDeadline = startedAt + PLATFORM_TIMEOUT_MS;

try {
  await prepareInstalledArtifact();
  const gamePackage = await findGamePackage(workspace, platform);
  const manifest = JSON.parse(await readFile(join(workspace, ".deviludo-e2e/manifest.json"), "utf8").catch(() => {
    throw productFailure("E2E_MANIFEST_MISSING", "构建制品缺少 deviludo.test-manifest.v3 测试清单");
  }));
  assertManifest(manifest);
  activeManifest = manifest;

  if (action === "test") await runUnitTests(gamePackage.executable, manifest);
  const journeys = manifest.features.filter(feature => feature.verificationMethod === "interactive"
    && (action === "test" || feature.coreJourney === true));
  for (const journey of journeys) {
    assertPlatformBudget();
    await runJourney(gamePackage, journey);
  }
  if (action === "test") {
    for (const visual of manifest.features.filter(feature => feature.verificationMethod === "visual")) {
      assertPlatformBudget();
      await runVisualCheck(gamePackage, visual);
    }
  }

  const declaredUnitChecks = new Set((action === "test" ? manifest.features : [])
    .filter(feature => feature.verificationMethod === "unit").flatMap(feature => feature.checkNames));
  const missingUnitChecks = [...declaredUnitChecks].filter(check => !headlessChecks.has(check));
  if (missingUnitChecks.length) throw productFailure("CHECKS_MISSING", `测试清单声明但未执行：${missingUnitChecks.join(", ")}`);
  const declaredJourneys = new Set(journeys.map(journey => journey.id));
  const missingJourneys = [...declaredJourneys].filter(id => !interactiveJourneys.has(id));
  if (missingJourneys.length) throw productFailure("JOURNEYS_MISSING", `真实操作旅程未执行：${missingJourneys.join(", ")}`);
  const journeyRequirementIds = new Set(journeys.flatMap(journey => journey.interactionScript.events
    .filter(isActionEvent).flatMap(event => event.coversRequirementIds)));
  const playerRequirements = manifest.requirements.filter(requirement => requirement.verificationClass === "PLAYER_INTERACTION"
    && (action === "test" || journeyRequirementIds.has(requirement.requirementId)));
  const missingCoverage = playerRequirements.filter(requirement => !coveredPlayerRequirements.has(requirement.requirementId));
  if (missingCoverage.length) throw productFailure("PLAYER_REQUIREMENT_COVERAGE_MISSING", `玩家需求未由真实输入验证：${missingCoverage.map(item => item.requirementId).join(", ")}`);
  if (screenshots.length < 3 || screenshots.length > MAX_SCREENSHOTS) throw productFailure("SCREENSHOT_COUNT_INVALID", "E2E 截图数量不满足 3-64 张证据门禁");

  await finish("PASSED", null, action === "test"
    ? "玩家需求、原生包启动和真实键鼠旅程均已通过"
    : "已安装游戏的原生启动与核心真实操作旅程已通过", manifest);
} catch (error) {
  if (!isProductFailure(error)) throw error;
  failures.push(`${error.code}: ${error.message}`);
  gameExitCode = gameExitCode || 1;
  await finish("FAILED", "PRODUCT", error.message, activeManifest);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function prepareInstalledArtifact() {
  if (action === "clean-install") await installFromSteamReceipt();
  else await execute("tar", ["-xzf", artifact, "-C", workspace], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })
    .catch(error => { throw productFailure("ARTIFACT_INVALID", `构建制品无法安全展开：${error.message}`); });
  if (platform === "macos") {
    const zip = (await readdir(workspace)).find(name => name.toLowerCase().endsWith(".zip"));
    if (zip) await execute("unzip", ["-q", join(workspace, zip), "-d", workspace], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  }
}

async function installFromSteamReceipt() {
  let receipt;
  try { receipt = JSON.parse(await readFile(artifact, "utf8")); }
  catch { throw new Error("INFRASTRUCTURE: Steam 发布回执无法读取"); }
  if (receipt?.published !== true || !/^\d{2,12}$/.test(String(receipt.appId ?? ""))
    || !/^\d+$/.test(String(receipt.buildId ?? "")) || !/^\d{2,12}$/.test(String(receipt.depots?.[platform] ?? ""))) {
    throw new Error("INFRASTRUCTURE: Steam 发布回执缺少目标平台的 App/Build/Depot 标识");
  }
  const installer = process.env.DEVILUDO_STEAM_CLEAN_INSTALLER ?? "";
  if (!isAbsolute(installer)) throw new Error("INFRASTRUCTURE: fixed Steam clean-install client is required");
  const installRoot = join(workspace, "steam-installed-game");
  await mkdir(installRoot, { recursive: true });
  const result = await runCaptured(installer, [
    "--receipt", artifact, "--app-id", String(receipt.appId), "--build-id", String(receipt.buildId),
    "--depot-id", String(receipt.depots[platform]), "--platform", platform, "--destination", installRoot,
  ], Math.min(15 * 60_000, remainingPlatformBudget()), safeEnvironment({
    DEVILUDO_STEAMCMD: process.env.DEVILUDO_STEAMCMD ?? "",
    DEVILUDO_STEAM_INSTALL_USERNAME: process.env.DEVILUDO_STEAM_INSTALL_USERNAME ?? "",
    DEVILUDO_STEAM_INSTALL_TOKEN: process.env.DEVILUDO_STEAM_INSTALL_TOKEN ?? "",
  }));
  stdoutLogs.push(result.stdout); stderrLogs.push(result.stderr);
  if (result.timedOut || result.code !== 0) throw new Error(`INFRASTRUCTURE: Steam clean install failed (${result.code})`);
  let installerReceipt;
  try { installerReceipt = JSON.parse([...result.stdout.matchAll(/DEVILUDO_STEAM_INSTALL_RESULT:(.+)$/gm)].at(-1)?.[1] ?? ""); }
  catch { throw new Error("INFRASTRUCTURE: Steam installer did not return a trusted receipt"); }
  if (installerReceipt?.installed !== true || String(installerReceipt.appId) !== String(receipt.appId)
    || String(installerReceipt.buildId) !== String(receipt.buildId)
    || resolve(installerReceipt.destination ?? "") !== resolve(installRoot)) {
    throw new Error("INFRASTRUCTURE: Steam installer receipt does not match the published build");
  }
  const installedEntries = await readdir(installRoot, { recursive: true, withFileTypes: true });
  for (const entry of installedEntries) {
    const source = join(entry.parentPath, entry.name);
    const relativePath = source.slice(installRoot.length + 1);
    const target = join(workspace, relativePath);
    if (entry.isDirectory()) await mkdir(target, { recursive: true });
    else if (entry.isFile()) { await mkdir(dirname(target), { recursive: true }); await copyFile(source, target); }
  }
  launchRecords.push({ journeyId: null, runLabel: "steam-clean-install", mode: "STEAM_CLIENT_INSTALL",
    appId: String(receipt.appId), buildId: String(receipt.buildId), depotId: String(receipt.depots[platform]) });
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
    assertPlatformBudget();
    unitIndex += 1;
    const result = await runCaptured(
      executable,
      ["--headless", "--script", script],
      Math.min(300_000, remainingPlatformBudget()),
      await isolatedGameEnvironment(`unit-${unitIndex}`),
    );
    stdoutLogs.push(result.stdout); stderrLogs.push(result.stderr); gameExitCode = result.code;
    if (result.timedOut) throw productFailure("UNIT_TIMEOUT", `单元测试 ${script} 超过硬超时`);
    const errors = godotErrorLines(result.stdout, result.stderr);
    if (errors.length) throw productFailure("GODOT_SCRIPT_ERROR", errors[0]);
    const marker = [...result.stdout.matchAll(/DEVILUDO_E2E_RESULT:(.+)$/gm)].at(-1)?.[1];
    if (!marker) throw productFailure("UNIT_RESULT_MISSING", `单元测试 ${script} 未输出 DEVILUDO_E2E_RESULT`);
    let details;
    try { details = JSON.parse(marker); } catch { throw productFailure("UNIT_RESULT_INVALID", `单元测试 ${script} 返回无效 JSON`); }
    if (!Array.isArray(details.checks) || !Array.isArray(details.failures)) throw productFailure("UNIT_RESULT_INVALID", `单元测试 ${script} 返回结构无效`);
    const actualChecks = new Set(details.checks);
    const missing = [...expectedChecks].filter(check => !actualChecks.has(check));
    const duplicates = details.checks.filter((check, index) => details.checks.indexOf(check) !== index);
    if (result.code !== 0 || details.failures.length || missing.length || duplicates.length) {
      throw productFailure("UNIT_CHECK_FAILED", [...details.failures, ...missing.map(check => `missing:${check}`), ...duplicates.map(check => `duplicate:${check}`)].join(", ") || `退出码 ${result.code}`);
    }
    expectedChecks.forEach(check => headlessChecks.add(check));
  }
}

async function runJourney(gamePackage, journey, countAsInteractiveJourney = true) {
  const first = await executeJourney(gamePackage, journey, "primary", true);
  const stableEvents = journey.interactionScript.events.filter(event => event.type === "checkpoint" && event.visualMode === "STABLE_REPLAY");
  if (stableEvents.length) {
    const replay = await executeJourney(gamePackage, journey, "stable-replay", false);
    for (const event of stableEvents) {
      const primary = first.captures.get(event.id);
      const baseline = replay.captures.get(event.id);
      if (!primary || !baseline) throw productFailure("STABLE_REPLAY_MISSING", `${journey.id}/${event.id} 缺少稳定重放截图`);
      const diffPath = join(workspace, "evidence-diff", `${checkpointEvidenceId(journey.id, event.id)}.png`);
      const comparison = await compareScreenshots(primary, baseline, diffPath, event.threshold ?? 0.01);
      baselines.push({ id: checkpointEvidenceId(journey.id, event.id), path: baseline });
      const record = checkpoints.find(item => item.journeyId === journey.id && item.checkpointId === event.id);
      if (record) record.stableReplayComparison = comparison;
      if (!comparison.passed) {
        diffs.push({ id: checkpointEvidenceId(journey.id, event.id), path: diffPath });
        throw productFailure("STABLE_REPLAY_DIFFERENCE", `${journey.id}/${event.id} 稳定重放差异 ${(comparison.differenceRatio * 100).toFixed(3)}% 超过阈值`);
      }
    }
  }
  if (countAsInteractiveJourney) interactiveJourneys.add(journey.id);
}

async function executeJourney(gamePackage, journey, runLabel, recordEvidence) {
  const runId = `${journey.id}-${runLabel}`;
  const gameLogPath = join(workspace, "game-logs", `${runId}.log`);
  const checkpointOutputPath = join(workspace, "checkpoint-output", `${runId}.log`);
  const probePath = join(workspace, "ui-probe", `${runId}.json`);
  await Promise.all([gameLogPath, checkpointOutputPath, probePath].map(path => mkdir(dirname(path), { recursive: true })));
  const sessionNonce = randomBytes(32).toString("hex");
  const environment = await isolatedGameEnvironment(runId, {
    DEVILUDO_E2E_CHECKPOINT_FILE: checkpointOutputPath,
    DEVILUDO_E2E_UI_PROBE_FILE: probePath,
    DEVILUDO_E2E_SESSION_NONCE: sessionNonce,
    ...(journey.launchProfile.type === "SCENARIO" ? { DEVILUDO_E2E_SCENARIO: journey.launchProfile.scenarioId } : {}),
  });
  const launched = await launchNativeGame(gamePackage, gameWindowArguments(gameLogPath), environment);
  launchRecords.push({ journeyId: journey.id, runLabel, ...launched.record });
  const captures = new Map();
  const priorInputs = [];
  let previousCheckpoint = null;
  let currentProbe;
  const journeyStarted = Date.now();
  try {
    await driver("wait", ["--pid", String(launched.pid), "--width", String(E2E_CLIENT_WIDTH), "--height", String(E2E_CLIENT_HEIGHT)]);
    currentProbe = await waitForProbeSnapshot(probePath, { sessionNonce, pid: launched.pid }, PROBE_TIMEOUT_MS);
    for (const event of journey.interactionScript.events) {
      assertPlatformBudget();
      if (Date.now() - journeyStarted > journey.timeoutMs) throw productFailure("JOURNEY_TIMEOUT", `${journey.id} 超过 ${journey.timeoutMs}ms`);
      if (!await processAlive(launched.pid)) throw productFailure("GAME_CRASHED", `真实窗口旅程 ${journey.id} 执行期间游戏退出`);
      if (event.delay_ms) await delay(event.delay_ms);
      if (event.type === "wait") continue;
      if (event.type !== "checkpoint") {
        const before = currentProbe;
        const targetRecord = actionTargetRecord(event, before);
        const nativeEvents = nativeInputEvents(event, before);
        await driver("sequence", ["--pid", String(launched.pid), "--events", JSON.stringify(nativeEvents)], Math.min(journey.timeoutMs, remainingPlatformBudget()));
        priorInputs.push({ stepId: event.stepId, type: event.type, intent: event.intent, ...targetRecord });
        const after = await waitForProbeSnapshot(probePath, {
          sessionNonce, pid: launched.pid, afterSequence: before.sequence,
        }, PROBE_TIMEOUT_MS).catch(error => { throw productFailure("PROBE_NOT_UPDATED", `${journey.id}/${event.stepId}: ${error.message}`); });
        const assertions = evaluateProbeAssertions(event.postconditions, before, after);
        const beforeDigest = probeStateDigest(before);
        const afterDigest = probeStateDigest(after);
        const assertionsPassed = assertions.every(assertion => assertion.passed);
        const stateChanged = beforeDigest !== afterDigest;
        if (recordEvidence) {
          steps.push({
            journeyId: journey.id, stepId: event.stepId, type: event.type, intent: event.intent,
            coversRequirementIds: event.coversRequirementIds, target: targetRecord,
            before: { sequence: before.sequence, sceneId: before.sceneId, digest: beforeDigest },
            after: { sequence: after.sequence, sceneId: after.sceneId, digest: afterDigest },
            assertions, status: assertionsPassed && stateChanged ? "PASSED" : "FAILED",
          });
        }
        if (!assertionsPassed || !stateChanged) {
          if (recordEvidence) {
            await captureFailedActionEvidence({
              launched, journey, event, probe: after, assertions, priorInputs,
              failureCode: assertionsPassed ? "ACTION_STATE_UNCHANGED" : "POSTCONDITION_FAILED",
            });
          }
          if (!assertionsPassed) throw productFailure("POSTCONDITION_FAILED", `${journey.id}/${event.stepId} 操作后状态断言失败`);
          throw productFailure("ACTION_STATE_UNCHANGED", `${journey.id}/${event.stepId} 未产生可验证状态变化`);
        }
        if (recordEvidence) event.coversRequirementIds.forEach(id => coveredPlayerRequirements.add(id));
        currentProbe = after;
        continue;
      }

      if (event.expectedOutput) {
        const observed = await waitForCheckpointOutput(event.expectedOutput, gameLogPath, checkpointOutputPath, CHECKPOINT_OUTPUT_TIMEOUT_MS);
        if (!observed) throw productFailure("CHECKPOINT_ASSERTION_FAILED", `${journey.id}/${event.id} 未观察到辅助标记 ${event.expectedOutput}`);
        await delay(CHECKPOINT_VISUAL_SETTLE_MS);
      }
      currentProbe = await waitForProbeSnapshot(probePath, { sessionNonce, pid: launched.pid }, PROBE_TIMEOUT_MS);
      const checkpointAssertions = evaluateProbeAssertions(event.assertions, previousCheckpoint?.probe ?? currentProbe, currentProbe);
      if (checkpointAssertions.some(assertion => !assertion.passed)) {
        throw productFailure("CHECKPOINT_PROBE_FAILED", `${journey.id}/${event.id} Probe 状态断言失败`);
      }
      const evidenceId = `${checkpointEvidenceId(journey.id, event.id)}${recordEvidence ? "" : "-replay"}`;
      const screenshotPath = join(workspace, "evidence-screenshots", `${evidenceId}.png`);
      await mkdir(dirname(screenshotPath), { recursive: true });
      const capture = await driver("capture", ["--pid", String(launched.pid), "--output", screenshotPath]);
      let screenshot;
      try { screenshot = await inspectScreenshot(screenshotPath); }
      catch (error) { throw productFailure("SCREENSHOT_INVALID", `${journey.id}/${event.id}: ${error.message}`); }
      captures.set(event.id, screenshotPath);
      let stateTransition = null;
      if (previousCheckpoint && priorInputs.length > previousCheckpoint.inputCount) {
        const changeRegion = event.changeTargetId
          ? resolveProbeControl(currentProbe, event.changeTargetId, { requireEnabled: false }).control.rect
          : null;
        const comparison = changeRegion
          ? await compareScreenshotRegion(screenshotPath, previousCheckpoint.path, changeRegion)
          : await compareScreenshots(screenshotPath, previousCheckpoint.path, null, 1);
        stateTransition = {
          previousCheckpointId: previousCheckpoint.id,
          differenceRatio: comparison.differenceRatio,
          minimumDifferenceRatio: MIN_STATE_TRANSITION_DIFFERENCE_RATIO,
          ...(changeRegion ? { changeTargetId: event.changeTargetId, region: changeRegion } : {}),
          passed: comparison.differenceRatio >= MIN_STATE_TRANSITION_DIFFERENCE_RATIO,
        };
        if (!stateTransition.passed) {
          const diffPath = join(workspace, "evidence-diff", `${evidenceId}-state.png`);
          if (changeRegion) await compareScreenshotRegion(screenshotPath, previousCheckpoint.path, changeRegion, diffPath);
          else await compareScreenshots(screenshotPath, previousCheckpoint.path, diffPath, 0);
          diffs.push({ id: `${evidenceId}-state`, path: diffPath });
        }
      }
      let visualComparison = null;
      let checkpointRecord = null;
      if (recordEvidence) {
        if (screenshots.length >= MAX_SCREENSHOTS) throw productFailure("SCREENSHOT_LIMIT_EXCEEDED", "E2E 截图超过 64 张");
        screenshots.push({ id: evidenceId, path: screenshotPath });
        checkpointRecord = {
          journeyId: journey.id, checkpointId: event.id, role: event.role, status: "PASSED",
          screenshot: `screenshots/${evidenceId}.png`, capturedAt: new Date().toISOString(),
          window: { pid: capture.pid, width: capture.width, height: capture.height }, priorInputs: [...priorInputs],
          probe: { sequence: currentProbe.sequence, sceneId: currentProbe.sceneId, digest: probeStateDigest(currentProbe) },
          assertions: checkpointAssertions, screenshotValidation: screenshot, visualComparison: null, stateTransition,
          outputAssertion: event.expectedOutput ? { expectedOutput: event.expectedOutput, observed: true, auxiliary: true } : null,
        };
        checkpoints.push(checkpointRecord);
      }
      if (event.referenceImage) {
        const baselinePath = resolve(workspace, ".deviludo-e2e", event.referenceImage);
        if (!baselinePath.startsWith(resolve(workspace, ".deviludo-e2e") + "/")) throw productFailure("BASELINE_PATH_INVALID", event.referenceImage);
        await access(baselinePath).catch(() => { throw productFailure("BASELINE_MISSING", event.referenceImage); });
        const diffPath = join(workspace, "evidence-diff", `${evidenceId}.png`);
        visualComparison = await compareScreenshots(screenshotPath, baselinePath, diffPath, event.threshold ?? 0.01);
        if (checkpointRecord) checkpointRecord.visualComparison = visualComparison;
        if (!visualComparison.passed) {
          diffs.push({ id: evidenceId, path: diffPath });
          if (checkpointRecord) checkpointRecord.status = "FAILED";
          throw productFailure("VISUAL_DIFFERENCE", `${journey.id}/${event.id} 差异超出阈值`);
        }
      }
      if (stateTransition && !stateTransition.passed) {
        if (checkpointRecord) checkpointRecord.status = "FAILED";
        throw productFailure("CHECKPOINT_VISUAL_STATE_UNCHANGED", `${journey.id}/${event.id} 指定语义区域在输入后未产生足够变化`);
      }
      previousCheckpoint = { id: event.id, path: screenshotPath, inputCount: priorInputs.length, probe: currentProbe };
    }
  } catch (error) {
    if (String(error?.message ?? error).startsWith("INFRASTRUCTURE:")) throw error;
    if (isProductFailure(error)) throw error;
    throw productFailure("INPUT_OR_WINDOW_FAILED", error instanceof Error ? error.message : String(error));
  } finally {
    await launched.terminate();
    const logs = await launched.logs();
    const gameLog = await readOptionalLog(gameLogPath);
    const checkpointOutput = await readOptionalLog(checkpointOutputPath);
    const stdout = [logs.stdout, gameLog.toString("utf8"), checkpointOutput.toString("utf8")].filter(Boolean).join("\n");
    stdoutLogs.push(stdout); stderrLogs.push(logs.stderr);
    const errors = godotErrorLines(stdout, logs.stderr);
    if (errors.length) failures.push(`GODOT_SCRIPT_ERROR: ${errors[0]}`);
  }
  if (failures.some(failure => failure.startsWith("GODOT_SCRIPT_ERROR"))) throw productFailure("GODOT_SCRIPT_ERROR", failures.at(-1));
  return { captures };
}

async function captureFailedActionEvidence({ launched, journey, event, probe, assertions, priorInputs, failureCode }) {
  if (screenshots.length >= MAX_SCREENSHOTS) throw productFailure("SCREENSHOT_LIMIT_EXCEEDED", "E2E 截图超过 64 张");
  const checkpointId = `failed-${event.stepId}`;
  const evidenceId = checkpointEvidenceId(journey.id, checkpointId);
  const screenshotPath = join(workspace, "evidence-screenshots", `${evidenceId}.png`);
  await mkdir(dirname(screenshotPath), { recursive: true });
  const capture = await driver("capture", ["--pid", String(launched.pid), "--output", screenshotPath]);
  let screenshot;
  try { screenshot = await inspectScreenshot(screenshotPath); }
  catch (error) { throw productFailure("SCREENSHOT_INVALID", `${journey.id}/${event.stepId} 失败现场截图无效：${error.message}`); }
  screenshots.push({ id: evidenceId, path: screenshotPath });
  checkpoints.push({
    journeyId: journey.id, checkpointId, role: "ACTION", status: "FAILED",
    screenshot: `screenshots/${evidenceId}.png`, capturedAt: new Date().toISOString(),
    window: { pid: capture.pid, width: capture.width, height: capture.height }, priorInputs: [...priorInputs],
    probe: { sequence: probe.sequence, sceneId: probe.sceneId, digest: probeStateDigest(probe) },
    assertions, screenshotValidation: screenshot, failureCode,
  });
}

async function runVisualCheck(gamePackage, feature) {
  const journey = {
    id: feature.id,
    timeoutMs: Math.min(300_000, feature.expectedVisual.captureDelay ?? 1_000 + 30_000),
    launchProfile: { type: "FRESH" },
    interactionScript: {
      events: [{
        type: "checkpoint", id: feature.id, role: "ACTION", assertions: [{ source: "SCENE", operator: "EXISTS" }],
        visualMode: "STABLE_REPLAY", referenceImage: feature.expectedVisual.referenceImage,
        threshold: feature.expectedVisual.threshold, delay_ms: feature.expectedVisual.captureDelay ?? 1_000,
      }],
    },
  };
  await runJourney(gamePackage, journey, false);
}

function nativeInputEvents(event, snapshot) {
  const targetCenter = id => resolveProbeControl(snapshot, id).center;
  const move = point => ({ type: "mouse_move", ...point, delay_ms: 0 });
  // OS cursor motion is asynchronous (notably for CGEvent on Retina guests).
  // A real user cannot press the mouse at the exact same monotonic instant as
  // the cursor teleports, so leave one short dispatch interval before the
  // dependent button, wheel, or text event.
  const click = (button, delay_ms = 80) => ({ type: "mouse_click", button: button ?? "LEFT", delay_ms });
  switch (event.type) {
    case "key_tap": return [
      { type: "key_press", key: event.key, delay_ms: 0 },
      { type: "key_release", key: event.key, delay_ms: 80 },
    ];
    case "key_hold": return [
      { type: "key_press", key: event.key, delay_ms: 0 },
      { type: "wait", delay_ms: event.duration_ms },
      { type: "key_release", key: event.key, delay_ms: 0 },
    ];
    case "click": return [move(targetCenter(event.targetId)), click(event.button)];
    case "double_click": return [move(targetCenter(event.targetId)), click(event.button), click(event.button, 80)];
    case "drag": return [
      move(targetCenter(event.fromTargetId)), { type: "mouse_down", button: "LEFT", delay_ms: 80 },
      { type: "wait", delay_ms: event.duration_ms }, move(targetCenter(event.toTargetId)),
      { type: "mouse_up", button: "LEFT", delay_ms: 80 },
    ];
    case "scroll": return [move(targetCenter(event.targetId)), { type: "scroll", deltaY: event.deltaY, delay_ms: 80 }];
    case "text_input": return [move(targetCenter(event.targetId)), click("LEFT"), { type: "text_input", text: event.text, delay_ms: 80 }];
    default: throw productFailure("INPUT_EVENT_INVALID", `不支持的 v3 输入事件 ${event.type}`);
  }
}

function actionTargetRecord(event, snapshot) {
  const ids = event.type === "drag" ? [event.fromTargetId, event.toTargetId]
    : ["click", "double_click", "scroll", "text_input"].includes(event.type) ? [event.targetId] : [];
  return { controls: ids.map(id => {
    const resolved = resolveProbeControl(snapshot, id);
    return { id, rect: resolved.control.rect, center: resolved.center };
  }) };
}

async function launchNativeGame(gamePackage, arguments_, environment) {
  if (platform === "macos") return launchMacosApp(gamePackage, arguments_, environment);
  const stdout = [], stderr = [];
  const child = spawn(gamePackage.executable, arguments_, { cwd: workspace, shell: false, stdio: ["ignore", "pipe", "pipe"], env: environment });
  child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
  await new Promise((resolvePromise, rejectPromise) => {
    child.once("spawn", resolvePromise);
    child.once("error", rejectPromise);
  });
  return {
    pid: child.pid,
    record: { mode: platform === "windows" ? "WINDOWS_FINAL_EXE" : "LINUX_RELEASE_EXECUTABLE", packagePath: gamePackage.packagePath },
    terminate: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([new Promise(resolvePromise => child.once("close", resolvePromise)), delay(5_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
    logs: async () => ({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }),
  };
}

async function launchMacosApp(gamePackage, arguments_, environment) {
  const exported = Object.entries(environment).filter(([key]) => key.startsWith("DEVILUDO_") || ["HOME", "TMPDIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"].includes(key));
  const launchArguments = ["-n"];
  for (const [key, value] of exported) {
    const text = String(value);
    if (text.includes("\0") || text.includes("\n") || !/^[A-Z0-9_]+$/.test(key)) {
      throw new Error("INFRASTRUCTURE: macOS native launch environment is invalid");
    }
    launchArguments.push("--env", `${key}=${text}`);
  }
  launchArguments.push(gamePackage.packagePath, "--args", ...arguments_);
  await execute("/usr/bin/open", launchArguments, { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const pid = await waitForExecutablePid(gamePackage.executable, 30_000);
  return {
    pid,
    record: { mode: "MACOS_LAUNCH_SERVICES", packagePath: gamePackage.packagePath },
    terminate: async () => { try { process.kill(pid, "SIGTERM"); } catch {} await delay(1_000); },
    logs: async () => ({ stdout: "", stderr: "" }),
  };
}

async function waitForExecutablePid(executable, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = await execute("ps", ["-ax", "-o", "pid=,command="], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (match && (match[2] === executable || match[2].startsWith(`${executable} `))) return Number(match[1]);
    }
    await delay(100);
  }
  throw productFailure("PACKAGE_LAUNCH_FAILED", "macOS LaunchServices 未启动交付包中的游戏进程");
}

async function findGamePackage(root, operatingSystem) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
  const executable = operatingSystem === "macos" ? files.find(path => path.includes(".app/Contents/MacOS/"))
    : operatingSystem === "windows" ? files.find(path => path.toLowerCase().endsWith(".exe"))
      : files.find(path => path.endsWith(".x86_64"));
  if (!executable) throw productFailure("EXECUTABLE_MISSING", `构建制品不包含 ${operatingSystem} 游戏可执行程序`);
  if (operatingSystem !== "windows") await chmod(executable, 0o700);
  if (operatingSystem === "macos") {
    const marker = executable.indexOf(".app/Contents/MacOS/");
    return { executable, packagePath: executable.slice(0, marker + 4) };
  }
  return { executable, packagePath: executable };
}

function assertManifest(value) {
  if (!value || value.schemaVersion !== "deviludo.test-manifest.v3" || !Array.isArray(value.requirements) || !value.requirements.length
    || value.requirements.length > 500 || !Array.isArray(value.features) || !value.features.length || value.features.length > 500) {
    throw productFailure("E2E_MANIFEST_INVALID", "测试清单结构无效");
  }
  const requirementIds = new Set();
  const playerRequirements = new Set();
  for (const requirement of value.requirements) {
    if (!requirement || !stableId(requirement.requirementId) || requirementIds.has(requirement.requirementId)
      || typeof requirement.description !== "string" || !requirement.description.trim()
      || !["CORE_LOOP", "ACCEPTANCE"].includes(requirement.source)
      || !["PLAYER_INTERACTION", "SYSTEM"].includes(requirement.verificationClass)
      || (requirement.source === "CORE_LOOP" && requirement.verificationClass !== "PLAYER_INTERACTION")) {
      throw productFailure("E2E_MANIFEST_INVALID", "测试清单需求映射无效");
    }
    if (requirement.verificationClass === "SYSTEM" && (requirement.source !== "ACCEPTANCE"
      || !["DATA", "RUNTIME", "NETWORK"].includes(requirement.systemCategory)
      || typeof requirement.exemptionReason !== "string" || requirement.exemptionReason.trim().length < 10)) {
      throw productFailure("SYSTEM_EXEMPTION_INVALID", `系统需求豁免无效：${requirement.requirementId}`);
    }
    if (requirement.verificationClass === "PLAYER_INTERACTION"
      && (requirement.systemCategory !== undefined || requirement.exemptionReason !== undefined)) {
      throw productFailure("E2E_MANIFEST_INVALID", `玩家需求不能声明系统豁免：${requirement.requirementId}`);
    }
    requirementIds.add(requirement.requirementId);
    if (requirement.verificationClass === "PLAYER_INTERACTION") playerRequirements.add(requirement.requirementId);
  }
  const featureIds = new Set();
  const unitNames = new Set();
  const automatedCoverage = new Set();
  const interactiveCoverage = new Set();
  let journeys = 0;
  let checkpointCount = 0;
  let hasCore = false;
  for (const feature of value.features) {
    if (!feature || !stableId(feature.id) || featureIds.has(feature.id)
      || !["core-loop", "player-control", "data-integrity", "runtime-quality", "ui", "audio", "network"].includes(feature.category)
      || typeof feature.description !== "string" || !feature.description.trim()
      || !["unit", "interactive", "visual", "manual"].includes(feature.verificationMethod)
      || !Array.isArray(feature.requirementIds) || !feature.requirementIds.length
      || feature.requirementIds.some(id => !requirementIds.has(id))) throw productFailure("E2E_MANIFEST_INVALID", `测试项无效：${feature?.id ?? "unknown"}`);
    featureIds.add(feature.id);
    if (feature.verificationMethod !== "manual") feature.requirementIds.forEach(id => automatedCoverage.add(id));
    if (feature.verificationMethod === "unit") {
      if (!safeGodotPath(feature.gdsTestPath) || !Array.isArray(feature.checkNames) || !feature.checkNames.length
        || feature.checkNames.some(name => !stableId(name) || unitNames.has(name))) throw productFailure("E2E_MANIFEST_INVALID", `单元测试项无效：${feature.id}`);
      feature.checkNames.forEach(name => unitNames.add(name));
    } else if (feature.verificationMethod === "interactive") {
      if (!validLaunchProfile(feature.launchProfile) || !Number.isInteger(feature.timeoutMs) || feature.timeoutMs < 1 || feature.timeoutMs > 300_000
        || !validInteractionScript(feature.interactionScript, feature.requirementIds, playerRequirements)) throw productFailure("E2E_MANIFEST_INVALID", `真实操作旅程无效：${feature.id}`);
      journeys += 1;
      const events = feature.interactionScript.events;
      const journeyCheckpoints = events.filter(event => event.type === "checkpoint");
      checkpointCount += journeyCheckpoints.length;
      if (feature.launchProfile.type === "SCENARIO"
        && !journeyCheckpoints.some(event => event.visualMode === "STABLE_REPLAY")) {
        throw productFailure("E2E_MANIFEST_INVALID", `确定性场景旅程缺少稳定重放检查点：${feature.id}`);
      }
      events.filter(isActionEvent).forEach(event => event.coversRequirementIds.forEach(id => interactiveCoverage.add(id)));
      if (feature.coreJourney === true && feature.category === "core-loop" && feature.launchProfile.type === "FRESH") {
        const checkpoints = events.filter(event => event.type === "checkpoint");
        const roles = new Set(checkpoints.map(event => event.role));
        const intents = new Set(events.filter(isActionEvent).map(event => event.intent));
        if (["START", "READY", "PROGRESS", "COMPLETION"].every(role => roles.has(role))
          && checkpoints.some(event => event.visualMode === "STABLE_REPLAY")
          && intents.has("PRIMARY_ACTION") && intents.has("COMPLETE_LOOP")) hasCore = true;
      }
    } else if (feature.verificationMethod === "visual") {
      if (!feature.expectedVisual || feature.expectedVisual.version !== "1" || !safePngPath(feature.expectedVisual.referenceImage)) {
        throw productFailure("E2E_MANIFEST_INVALID", `视觉测试项无效：${feature.id}`);
      }
      checkpointCount += 1;
    }
  }
  if (journeys < 1 || journeys > 32 || checkpointCount < 3 || checkpointCount > MAX_SCREENSHOTS || !hasCore) {
    throw productFailure("CORE_JOURNEY_MISSING", "测试清单缺少合规的干净核心循环真实操作旅程");
  }
  if ([...requirementIds].some(id => !automatedCoverage.has(id))) throw productFailure("REQUIREMENT_COVERAGE_MISSING", "批准需求缺少自动化覆盖");
  if ([...playerRequirements].some(id => !interactiveCoverage.has(id))) throw productFailure("PLAYER_REQUIREMENT_COVERAGE_MISSING", "玩家需求没有映射到真实输入步骤");
}

function validInteractionScript(value, journeyRequirements, playerRequirements) {
  if (!value || value.version !== "3" || !Array.isArray(value.events) || !value.events.length || value.events.length > 200) return false;
  const steps = new Set(), checkpoints_ = new Set();
  return value.events.every(event => {
    if (!event || typeof event !== "object" || !validDelay(event.delay_ms, event.type === "wait")) return false;
    if (event.type === "wait") return true;
      if (event.type === "checkpoint") {
      if (!stableId(event.id) || checkpoints_.has(event.id) || !["START", "READY", "ACTION", "PROGRESS", "COMPLETION"].includes(event.role)
        || !Array.isArray(event.assertions) || !event.assertions.length || !event.assertions.every(validProbeAssertion)
        || !["DYNAMIC", "STABLE_REPLAY"].includes(event.visualMode)
        || (event.changeTargetId !== undefined && !stableId(event.changeTargetId))
        || (event.visualMode === "DYNAMIC" && ["ACTION", "PROGRESS", "COMPLETION"].includes(event.role)
          && !stableId(event.changeTargetId))
        || (event.referenceImage !== undefined && !safePngPath(event.referenceImage))
        || (event.expectedOutput !== undefined && event.expectedOutput !== checkpointOutputMarker(event.id))) return false;
      checkpoints_.add(event.id); return true;
    }
    if (!isActionEvent(event) || !stableId(event.stepId) || steps.has(event.stepId)
      || !["START_SESSION", "NAVIGATION", "PRIMARY_ACTION", "FEATURE_ACTION", "COMPLETE_LOOP"].includes(event.intent)
      || !Array.isArray(event.coversRequirementIds)
      || event.coversRequirementIds.some(id => !journeyRequirements.includes(id) || !playerRequirements.has(id))
      || !Array.isArray(event.postconditions) || !event.postconditions.length || !event.postconditions.every(validProbeAssertion)) return false;
    steps.add(event.stepId);
    if (["click", "double_click", "scroll", "text_input"].includes(event.type) && !stableId(event.targetId)) return false;
    if (event.type === "drag" && (!stableId(event.fromTargetId) || !stableId(event.toTargetId) || !validDuration(event.duration_ms))) return false;
    if (["key_tap", "key_hold"].includes(event.type) && !supportedKey(event.key)) return false;
    if (event.type === "key_hold" && !validDuration(event.duration_ms)) return false;
    if (event.type === "scroll" && (!Number.isInteger(event.deltaY) || !event.deltaY || Math.abs(event.deltaY) > 10_000)) return false;
    return event.type !== "text_input" || (typeof event.text === "string" && event.text.length >= 1 && event.text.length <= 1_000);
  });
}

function validProbeAssertion(value) {
  if (!value || typeof value !== "object" || !["STATE", "PROGRESS", "CONTROL", "SCENE"].includes(value.source)
    || !["EQUALS", "NOT_EQUALS", "GREATER_THAN", "GREATER_THAN_OR_EQUALS", "LESS_THAN", "LESS_THAN_OR_EQUALS", "CONTAINS", "EXISTS", "CHANGED"].includes(value.operator)) return false;
  if (["STATE", "PROGRESS"].includes(value.source) && (typeof value.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value.key))) return false;
  if (value.source === "CONTROL" && (!stableId(value.targetId) || !["visible", "enabled", "text", "value"].includes(value.property))) return false;
  const requiresValue = !["EXISTS", "CHANGED"].includes(value.operator);
  return requiresValue === Object.hasOwn(value, "value");
}

function validLaunchProfile(value) { return value?.type === "FRESH" || (value?.type === "SCENARIO" && stableId(value.scenarioId)); }
function isActionEvent(event) { return ["key_tap", "key_hold", "click", "double_click", "drag", "scroll", "text_input"].includes(event?.type); }
function supportedKey(value) { return typeof value === "string" && /^(?:KEY_)?(?:[A-Z0-9]|SPACE|ENTER|TAB|ESCAPE|LEFT|RIGHT|UP|DOWN|MINUS|EQUAL)$/.test(value); }
function validDuration(value) { return Number.isInteger(value) && value >= 1 && value <= 300_000; }
function validDelay(value, required) { return value === undefined ? !required : Number.isInteger(value) && value >= 0 && value <= 300_000; }
function checkpointOutputMarker(id) { return `DEVILUDO_E2E_CHECKPOINT:${id}`; }

async function finish(outcome, failureDomain, summary, manifest) {
  const cleanInstallRequirementIds = new Set((manifest?.features ?? [])
    .filter(feature => feature.verificationMethod === "interactive" && feature.coreJourney === true)
    .flatMap(feature => feature.interactionScript.events.filter(isActionEvent).flatMap(event => event.coversRequirementIds)));
  const scopedRequirements = (manifest?.requirements ?? []).filter(item => action === "test"
    || cleanInstallRequirementIds.has(item.requirementId));
  const playerRequirementCount = scopedRequirements.filter(item => item.verificationClass === "PLAYER_INTERACTION"
    && (action === "test" || cleanInstallRequirementIds.has(item.requirementId))).length ?? 0;
  const report = {
    schemaVersion: E2E_EVIDENCE_PROTOCOL, jobId, platform, action, outcome, failureDomain, summary,
    packageLaunches: launchRecords,
    coverage: {
      headlessCheckCount: headlessChecks.size,
      interactiveJourneyCount: interactiveJourneys.size,
      realInputCount: steps.length,
      coveredPlayerRequirementCount: coveredPlayerRequirements.size,
      playerRequirementCount,
      visualBaselineCount: baselines.length,
    },
    testDetails: {
      suite: "deviludo-real-window-e2e-v3",
      checks: [...headlessChecks], interactiveJourneys: [...interactiveJourneys], failures,
      duration_ms: Date.now() - startedAt,
    },
    requirementCoverage: scopedRequirements.map(requirement => {
      const evidenceSteps = steps.filter(step => step.status === "PASSED"
        && step.coversRequirementIds.includes(requirement.requirementId))
        .map(step => `${step.journeyId}/${step.stepId}`);
      return {
        requirementId: requirement.requirementId, source: requirement.source,
        verificationClass: requirement.verificationClass,
        status: requirement.verificationClass === "SYSTEM" ? "SYSTEM_EXEMPT" : evidenceSteps.length ? "COVERED" : "NOT_COVERED",
        evidenceSteps, ...(requirement.exemptionReason ? { exemptionReason: requirement.exemptionReason } : {}),
      };
    }),
    steps, checkpoints, screenshotCount: screenshots.length, visualDiff: diffs.length > 0,
  };
  const bundle = await createEvidenceBundle({ outputRoot: evidenceRoot, jobId, platform, report, stdout: stdoutLogs.join("\n"), stderr: stderrLogs.join("\n"), screenshots, diffs, baselines });
  const receipt = {
    schemaVersion: GUEST_REPORT_PROTOCOL, action, jobId, outcome, failureDomain, summary,
    guest: { executor: "real-window-godot-v3", isolation: "EPHEMERAL_VM", exitCode: outcome === "PASSED" ? 0 : gameExitCode || 1 },
    testDetails: report.testDetails,
    evidence: {
      protocol: E2E_EVIDENCE_PROTOCOL, result: outcome,
      headlessCheckCount: headlessChecks.size, interactiveJourneyCount: interactiveJourneys.size,
      realInputCount: steps.length, coveredPlayerRequirementCount: coveredPlayerRequirements.size,
      playerRequirementCount, screenshotCount: screenshots.length, visualBaselineCount: baselines.length,
      hasVisualDiff: diffs.length > 0, packageLaunchMode: launchRecords.find(record => record.packagePath)?.mode ?? null,
    },
    outputPath: bundle.outputPath, outputSha256: bundle.outputSha256, outputSizeBytes: bundle.outputSizeBytes,
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

async function waitForCheckpointOutput(expectedOutput, gameLogPath, checkpointOutputPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (checkpointOutputSeen([await readOptionalLog(gameLogPath), await readOptionalLog(checkpointOutputPath)], expectedOutput)) return true;
    await delay(50);
  }
  return false;
}

async function runCaptured(executable, arguments_, timeout, environment = safeEnvironment()) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, arguments_, { cwd: workspace, shell: false, stdio: ["ignore", "pipe", "pipe"], env: environment });
    const stdout = [], stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectPromise);
    child.once("close", code => { clearTimeout(timer); resolvePromise({ code: Number.isInteger(code) ? code : 124, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
  });
}

function assertPlatformBudget() { if (Date.now() >= platformDeadline) throw productFailure("PLATFORM_TIMEOUT", "单个平台 E2E 超过 30 分钟总预算"); }
function remainingPlatformBudget() { return Math.max(1, platformDeadline - Date.now()); }
async function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function readOptionalLog(path) { return readFile(path).catch(() => Buffer.alloc(0)); }
function gameWindowArguments(logPath) { return ["--log-file", logPath, "--windowed", "--resolution", `${E2E_CLIENT_WIDTH}x${E2E_CLIENT_HEIGHT}`, "--position", "40,40"]; }
function checkpointEvidenceId(journeyId, checkpointId) { return `journey-${journeyId.length}-${journeyId}-${checkpointId}`; }
function stableId(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,119}$/.test(value); }
function safeGodotPath(value) { return typeof value === "string" && /^res:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,219}\.gd$/.test(value) && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value.slice(6)); }
function safePngPath(value) { return typeof value === "string" && value.length >= 5 && value.length <= 240 && value.toLowerCase().endsWith(".png") && !value.startsWith("/") && !value.startsWith("res://") && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value) && /^[A-Za-z0-9][A-Za-z0-9._/-]*\.png$/i.test(value); }
function productFailure(code, message) { return Object.assign(new Error(String(message).slice(0, 2_000)), { code, productFailure: true }); }
function isProductFailure(error) { return Boolean(error && typeof error === "object" && error.productFailure === true); }
function safeEnvironment(overrides = {}) { return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", DISPLAY: process.env.DISPLAY ?? "", HOME: process.env.HOME ?? tmpdir(), ...overrides }; }
async function isolatedGameEnvironment(scope, overrides = {}) {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(scope)) throw new Error("Game user-data scope is invalid");
  const root = join(workspace, "game-user-data", scope);
  const xdgData = join(root, ".local", "share"), xdgConfig = join(root, ".config"), xdgCache = join(root, ".cache");
  const appData = join(root, "AppData", "Roaming"), localAppData = join(root, "AppData", "Local");
  await Promise.all([root, xdgData, xdgConfig, xdgCache, appData, localAppData].map(path => mkdir(path, { recursive: true })));
  return safeEnvironment({ HOME: root, USERPROFILE: root, XDG_DATA_HOME: xdgData, XDG_CONFIG_HOME: xdgConfig, XDG_CACHE_HOME: xdgCache, APPDATA: appData, LOCALAPPDATA: localAppData, ...overrides });
}
function delay(milliseconds) { return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds)); }
