#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import {
  E2E_CLIENT_HEIGHT,
  E2E_CLIENT_WIDTH,
  E2E_EVIDENCE_SCHEMA,
  GUEST_REPORT_SCHEMA,
  captureAndInspectScreenshot,
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
  waitForProbePostconditions,
  waitForProbeSnapshot,
} from "../e2e-ui-probe.mjs";
import {
  isInteractionAction as isActionEvent,
  isSafeProjectPngPath as safePngPath,
  isStableId as stableId,
  validLaunchProfile,
  validateGuestInteractionScript as validInteractionScript,
  validateProbeAssertion as validProbeAssertion,
} from "../e2e-interaction-contract.mjs";
import { checkpointOutputSeen } from "./gui-event-batches.mjs";
import { GameTestEnvironment, gamepadEventCount } from "./game-test-environment.mjs";

const execute = promisify(execFile);
const action = process.argv[2];
const artifact = process.argv[3];
const jsonOutput = process.argv.includes("--json");
const jobArgument = process.argv.indexOf("--job-id");
const jobId = jobArgument >= 0 ? process.argv[jobArgument + 1] : process.env.DEVILUDO_E2E_JOB_ID ?? randomUUID();
const regressionArgument = process.argv.indexOf("--regression");
const currentRegressionPath = regressionArgument >= 0 ? process.argv[regressionArgument + 1] : "";
const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
const CHECKPOINT_OUTPUT_TIMEOUT_MS = 15_000;
const CHECKPOINT_VISUAL_SETTLE_MS = 1_500;
const PROBE_TIMEOUT_MS = 15_000;
const MIN_STATE_TRANSITION_DIFFERENCE_RATIO = 0.001;
const MAX_SCREENSHOTS = 64;
const ADAPTIVE_ROLLOUT_COUNT = 3;
const ADAPTIVE_REQUIRED_SUCCESSES = 2;
const streamProtocol = process.env.DEVILUDO_E2E_STREAM_PROTOCOL === "1";
const policyInput = streamProtocol ? createInterface({ input: process.stdin, crlfDelay: Infinity }) : null;
const policyLines = policyInput?.[Symbol.asyncIterator]() ?? null;
const streamHeartbeat = streamProtocol ? setInterval(() => {
  process.stdout.write(`${JSON.stringify({ type: "heartbeat", at: new Date().toISOString() })}\n`);
}, 5_000) : null;
streamHeartbeat?.unref?.();
const frozenTimeoutSeconds = Number(process.env.DEVILUDO_E2E_FROZEN_TIMEOUT_SECONDS);
const frozenContractDigest = process.env.DEVILUDO_E2E_CONTRACT_DIGEST ?? "";

if (action !== "test" || !artifact || !isAbsolute(artifact)
  || !/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("Guest runner arguments are invalid");
if (!Number.isSafeInteger(frozenTimeoutSeconds) || frozenTimeoutSeconds < 1800 || frozenTimeoutSeconds > 5400
  || !/^sha256:[0-9a-f]{64}$/.test(frozenContractDigest)) throw new Error("INFRASTRUCTURE: frozen E2E execution plan is invalid");
const guiDriver = process.env.DEVILUDO_GUI_DRIVER ?? "";
if (!isAbsolute(guiDriver)) throw new Error("INFRASTRUCTURE: fixed GUI driver is required");

const workspace = await mkdtemp(join(process.env.DEVILUDO_GUEST_JOB_ROOT ?? tmpdir(), `deviludo-guest-${jobId}-`));
const evidenceRoot = resolve(process.env.DEVILUDO_GUEST_EVIDENCE_ROOT ?? dirname(artifact));
const stdoutLogs = [];
const stderrLogs = [];
const screenshots = [];
const diffs = [];
const baselines = [];
const videos = [];
const trajectories = [];
const regressions = [];
const checkpoints = [];
const steps = [];
const headlessChecks = new Set();
const interactiveJourneys = new Set();
const coveredPlayerRequirements = new Set();
const failures = [];
const launchRecords = [];
const adaptiveRollouts = [];
let currentRegressionResult = null;
let keyboardMouseInputCount = 0;
let gamepadInputCount = 0;
let playerPolicy = null;
let gameExitCode = 0;
let activeManifest = null;
const startedAt = Date.now();
let platformDeadline = startedAt + 90 * 60_000;

try {
  await prepareInstalledArtifact();
  const gamePackage = await findGamePackage(workspace, platform);
  const manifest = JSON.parse(await readFile(join(workspace, ".deviludo-e2e/manifest.json"), "utf8").catch(() => {
    throw productFailure("E2E_MANIFEST_MISSING", "构建制品缺少 deviludo.test-manifest 测试清单");
  }));
  assertManifest(manifest);
  activeManifest = manifest;
  if (jsonDigest({ testManifest: manifest, runner: "adaptive-real-input" }) !== frozenContractDigest) {
    throw new Error("INFRASTRUCTURE: built test contract does not match the frozen source revision");
  }
  const currentRegression = await readCurrentRegression(manifest);
  const executionPlan = planExecution(manifest, currentRegression?.estimatedDurationMs ?? 0);
  if (executionPlan.plannedTimeoutMs > frozenTimeoutSeconds * 1_000) {
    throw new Error("INFRASTRUCTURE: frozen E2E budget is smaller than the current execution plan");
  }
  platformDeadline = startedAt + frozenTimeoutSeconds * 1_000;

  await runUnitTests(gamePackage, manifest);
  const journeys = manifest.features.filter(feature => feature.verificationMethod === "interactive");
  for (const journey of journeys) {
    assertPlatformBudget();
    await runJourney(gamePackage, journey);
  }
  for (const visual of manifest.features.filter(feature => feature.verificationMethod === "visual")) {
    assertPlatformBudget();
    await runVisualCheck(gamePackage, visual);
  }
  assertDeterministicCompletion(manifest, journeys);
  if (currentRegression) {
    try {
      const passed = await replayRegression(gamePackage, currentRegression, "current");
      currentRegressionResult = { status: passed ? "PASSED" : "FAILED", digest: jsonDigest(currentRegression) };
    } catch (error) {
      currentRegressionResult = { status: "FAILED", digest: jsonDigest(currentRegression), reason: error instanceof Error ? error.message : String(error) };
    }
  }
  for (let rolloutIndex = 0; rolloutIndex < ADAPTIVE_ROLLOUT_COUNT; rolloutIndex += 1) {
    assertPlatformBudget();
    adaptiveRollouts.push(await runAdaptiveRollout(gamePackage, manifest, rolloutIndex));
  }
  const adaptiveSuccesses = adaptiveRollouts.filter(rollout => rollout.outcome === "PASSED");
  if (adaptiveSuccesses.length < ADAPTIVE_REQUIRED_SUCCESSES) {
    throw productFailure("ADAPTIVE_PLAYABILITY_FAILED", `Test Agent 仅有 ${adaptiveSuccesses.length}/${ADAPTIVE_ROLLOUT_COUNT} 次完成核心循环`);
  }
  await solidifyRegression(gamePackage, manifest, adaptiveSuccesses);

  await finish("PASSED", null, "玩家需求、原生包启动、确定性真实输入和自适应游玩均已通过", manifest);
} catch (error) {
  if (!isProductFailure(error)) throw error;
  const summary = productFailureMessage(error.code, error.message);
  failures.push(`${error.code}: ${summary}`);
  gameExitCode = gameExitCode || 1;
  await finish("FAILED", "PRODUCT", summary, activeManifest);
} finally {
  if (streamHeartbeat) clearInterval(streamHeartbeat);
  policyInput?.close();
  process.stdin.pause();
  process.stdin.unref?.();
  await rm(workspace, { recursive: true, force: true });
}

function assertDeterministicCompletion(manifest, journeys) {
  const declaredUnitChecks = new Set(manifest.features
    .filter(feature => feature.verificationMethod === "unit").flatMap(feature => feature.checkNames));
  const missingUnitChecks = [...declaredUnitChecks].filter(check => !headlessChecks.has(check));
  if (missingUnitChecks.length) throw productFailure("CHECKS_MISSING", `测试清单声明但未执行：${missingUnitChecks.join(", ")}`);
  const declaredJourneys = new Set(journeys.map(journey => journey.id));
  const missingJourneys = [...declaredJourneys].filter(id => !interactiveJourneys.has(id));
  if (missingJourneys.length) throw productFailure("JOURNEYS_MISSING", `真实操作旅程未执行：${missingJourneys.join(", ")}`);
  const journeyRequirementIds = new Set(journeys.flatMap(journey => journey.interactionScript.events
    .filter(isActionEvent).flatMap(event => event.coversRequirementIds)));
  const playerRequirements = manifest.requirements.filter(requirement => requirement.verificationClass === "PLAYER_INTERACTION"
    && journeyRequirementIds.has(requirement.requirementId));
  const missingCoverage = playerRequirements.filter(requirement => !coveredPlayerRequirements.has(requirement.requirementId));
  if (missingCoverage.length) throw productFailure("PLAYER_REQUIREMENT_COVERAGE_MISSING", `玩家需求未由真实输入验证：${missingCoverage.map(item => item.requirementId).join(", ")}`);
  if (screenshots.length < 3 || screenshots.length > MAX_SCREENSHOTS) throw productFailure("SCREENSHOT_COUNT_INVALID", "E2E 截图数量不满足 3-64 张证据门禁");
}

async function prepareInstalledArtifact() {
  await execute("tar", ["-xzf", artifact, "-C", workspace], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })
    .catch(error => { throw productFailure("ARTIFACT_INVALID", `构建制品无法安全展开：${error.message}`); });
  if (platform === "macos") {
    const zip = (await readdir(workspace)).find(name => name.toLowerCase().endsWith(".zip"));
    if (zip) await execute("unzip", ["-q", join(workspace, zip), "-d", workspace], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  }
}

async function readCurrentRegression(manifest) {
  if (!currentRegressionPath) return null;
  if (!isAbsolute(currentRegressionPath)) throw new Error("INFRASTRUCTURE: regression trace path must be absolute");
  let trace;
  try { trace = JSON.parse(await readFile(currentRegressionPath, "utf8")); }
  catch { throw new Error("INFRASTRUCTURE: current regression trace cannot be decoded"); }
  const expectedContract = jsonDigest({ testManifest: manifest, runner: "adaptive-real-input" });
  if (!trace || typeof trace !== "object" || Array.isArray(trace)
    || trace.schema !== "deviludo.e2e-regression" || trace.contractDigest !== expectedContract
    || !["KEYBOARD_MOUSE", "GAMEPAD"].includes(trace.inputProfile)
    || !Number.isInteger(trace.estimatedDurationMs) || trace.estimatedDurationMs < 1 || trace.estimatedDurationMs > 300_000
    || !Array.isArray(trace.actions) || trace.actions.length < 1 || trace.actions.length > 160
    || !Array.isArray(trace.successAssertions) || trace.successAssertions.length < 1) {
    currentRegressionResult = { status: "STALE", reason: "contract digest or trace structure changed" };
    return null;
  }
  return trace;
}

async function runUnitTests(gamePackage, manifest) {
  const runtime = godotUnitRuntime();
  await access(runtime).catch(() => {
    throw new Error(`INFRASTRUCTURE: fixed Godot unit-test runtime is unavailable at ${runtime}`);
  });
  const scripts = new Map();
  for (const feature of manifest.features.filter(item => item.verificationMethod === "unit")) {
    const entry = scripts.get(feature.gdsTestPath) ?? { checks: new Set(), timeoutMs: 0 };
    feature.checkNames.forEach(check => entry.checks.add(check));
    entry.timeoutMs = Math.max(entry.timeoutMs, feature.timeoutMs);
    scripts.set(feature.gdsTestPath, entry);
  }
  let unitIndex = 0;
  for (const [script, entry] of scripts) {
    const expectedChecks = entry.checks;
    assertPlatformBudget();
    unitIndex += 1;
    const result = await runCaptured(
      runtime,
      ["--headless", "--main-pack", gamePackage.projectPack, "--script", script],
      Math.min(entry.timeoutMs, remainingPlatformBudget()),
      await isolatedGameEnvironment(`unit-${unitIndex}`),
    );
    stdoutLogs.push(result.stdout); stderrLogs.push(result.stderr); gameExitCode = result.code;
    if (result.timedOut) throw productFailure("UNIT_TIMEOUT", `单元测试 ${script} 超过硬超时`);
    const errors = godotErrorLines(result.stdout, result.stderr);
    if (errors.length) throw productFailure("GODOT_SCRIPT_ERROR", errors[0]);
    const marker = [...result.stdout.matchAll(/DEVILUDO_E2E_RESULT:(.+)$/gm)].at(-1)?.[1];
    if (!marker) {
      const termination = result.signal
        ? `被信号 ${result.signal} 终止`
        : `退出码 ${result.code}`;
      throw productFailure("UNIT_RESULT_MISSING", `单元测试 ${script} 未输出 DEVILUDO_E2E_RESULT（${termination}）`);
    }
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
  const { launched, testEnvironment } = await launchManagedGame(
    gamePackage, gameWindowArguments(gameLogPath), environment, runId,
    journey.interactionScript.events.some(event => String(event.type).startsWith("gamepad_")),
  );
  launchRecords.push({ journeyId: journey.id, runLabel, ...launched.record });
  const captures = new Map();
  const priorInputs = [];
  let previousCheckpoint = null;
  let currentProbe;
  const journeyStarted = Date.now();
  try {
    await testEnvironment.prepare();
    currentProbe = await waitForProbeSnapshot(probePath, { sessionNonce, pid: launched.pid }, PROBE_TIMEOUT_MS);
    for (const event of journey.interactionScript.events) {
      assertPlatformBudget();
      if (Date.now() - journeyStarted > journey.timeoutMs) throw productFailure("JOURNEY_TIMEOUT", `${journey.id} 超过 ${journey.timeoutMs}ms`);
      if (!await processAlive(launched.pid)) throw productFailure("GAME_CRASHED", `真实窗口旅程 ${journey.id} 执行期间游戏退出`);
      if (event.delay_ms) await delay(event.delay_ms);
      if (event.type === "wait") continue;
      if (event.type !== "checkpoint") {
        const before = currentProbe;
        let targetRecord;
        let nativeEvents;
        try {
          targetRecord = actionTargetRecord(event, before);
          nativeEvents = nativeInputEvents(event, before);
        } catch (error) {
          if (recordEvidence) {
            await captureFailedActionEvidence({
              testEnvironment, journey, event, probe: before, assertions: [], priorInputs,
              failureCode: "ACTION_TARGET_UNAVAILABLE",
            });
          }
          const detail = error instanceof Error ? error.message : String(error);
          throw productFailure("ACTION_TARGET_UNAVAILABLE", `${journey.id}/${event.stepId}: ${detail}`);
        }
        await testEnvironment.sequence(nativeEvents, Math.min(journey.timeoutMs, remainingPlatformBudget()));
        const gamepadCount = gamepadEventCount(nativeEvents);
        gamepadInputCount += gamepadCount;
        keyboardMouseInputCount += nativeEvents.length - gamepadCount;
        priorInputs.push({ stepId: event.stepId, type: event.type, intent: event.intent, ...targetRecord });
        let postconditionResult;
        try {
          postconditionResult = await waitForProbePostconditions(probePath, {
            sessionNonce, pid: launched.pid, afterSequence: before.sequence,
          }, before, event.postconditions, PROBE_TIMEOUT_MS);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const assertions = evaluateProbeAssertions(event.postconditions, before, before);
          if (recordEvidence) {
            const digest = probeStateDigest(before);
            steps.push({
              journeyId: journey.id, stepId: event.stepId, type: event.type, intent: event.intent,
              coversRequirementIds: event.coversRequirementIds, target: targetRecord,
              before: { sequence: before.sequence, sceneId: before.sceneId, digest },
              after: { sequence: before.sequence, sceneId: before.sceneId, digest },
              assertions, status: "FAILED", failureCode: "PROBE_NOT_UPDATED", failureDetail: detail,
            });
            await captureFailedActionEvidence({
              testEnvironment, journey, event, probe: before, assertions, priorInputs,
              failureCode: "PROBE_NOT_UPDATED",
            });
          }
          throw productFailure("PROBE_NOT_UPDATED", `${journey.id}/${event.stepId}: ${detail}`);
        }
        const after = postconditionResult.snapshot;
        const assertions = postconditionResult.assertions;
        const beforeDigest = probeStateDigest(before);
        const afterDigest = probeStateDigest(after);
        const assertionsPassed = assertions.every(assertion => assertion.passed);
        const stateChanged = postconditionResult.stateChanged;
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
              testEnvironment, journey, event, probe: after, assertions, priorInputs,
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
      const capture = await testEnvironment.capture(screenshotPath);
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
    const video = await testEnvironment.close();
    if (video) videos.push(video);
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

async function captureFailedActionEvidence({ testEnvironment, journey, event, probe, assertions, priorInputs, failureCode }) {
  if (screenshots.length >= MAX_SCREENSHOTS) throw productFailure("SCREENSHOT_LIMIT_EXCEEDED", "E2E 截图超过 64 张");
  const checkpointId = `failed-${event.stepId}`;
  const evidenceId = checkpointEvidenceId(journey.id, checkpointId);
  const screenshotPath = join(workspace, "evidence-screenshots", `${evidenceId}.png`);
  await mkdir(dirname(screenshotPath), { recursive: true });
  // Failure evidence shares the same serialized desktop queue as video frames,
  // regular checkpoints and native input. Calling the GUI driver directly here
  // allowed ScreenCaptureKit requests to overlap and intermittently rejected
  // the diagnostic screenshot, masking the original product assertion.
  const capture = await testEnvironment.capture(screenshotPath);
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

async function runAdaptiveRollout(gamePackage, manifest, rolloutIndex) {
  const contract = manifest.adaptivePlayer;
  const runId = `adaptive-${rolloutIndex + 1}`;
  const gameLogPath = join(workspace, "game-logs", `${runId}.log`);
  const probePath = join(workspace, "ui-probe", `${runId}.json`);
  const trajectoryPath = join(workspace, "evidence-trajectories", `${runId}.jsonl`);
  await Promise.all([gameLogPath, probePath, trajectoryPath].map(path => mkdir(dirname(path), { recursive: true })));
  const sessionNonce = randomBytes(32).toString("hex");
  const seed = stableRolloutSeed(manifest, rolloutIndex);
  const environment = await isolatedGameEnvironment(runId, {
    DEVILUDO_E2E_UI_PROBE_FILE: probePath,
    DEVILUDO_E2E_SESSION_NONCE: sessionNonce,
    DEVILUDO_E2E_SEED: String(seed),
  });
  const { launched, testEnvironment } = await launchManagedGame(
    gamePackage, gameWindowArguments(gameLogPath), environment, runId,
    contract.allowedActions.includes("GAMEPAD"),
  );
  launchRecords.push({ journeyId: runId, runLabel: "adaptive", seed, ...launched.record });
  const history = [];
  const decisions = [];
  const loopSignatures = new Map();
  let currentProbe;
  let initialProbe;
  let madeVerifiedProgress = false;
  let noProgressDecisions = 0;
  let lastProgressAt = Date.now();
  let recoveryStartedAt = null;
  let recoveryDecisionIndex = null;
  let recovery = false;
  let outcome = "FAILED";
  let failureCode = "MAX_DECISIONS";
  const rolloutStartedAt = Date.now();
  try {
    await testEnvironment.prepare();
    currentProbe = await waitForProbeSnapshot(probePath, { sessionNonce, pid: launched.pid }, PROBE_TIMEOUT_MS);
    initialProbe = currentProbe;
    for (let decisionIndex = 0; decisionIndex < contract.maxDecisions; decisionIndex += 1) {
      assertPlatformBudget();
      if (Date.now() - rolloutStartedAt > contract.rolloutTimeoutMs) { failureCode = "ADAPTIVE_TIMEOUT"; break; }
      if (!await processAlive(launched.pid)) { failureCode = "GAME_CRASHED"; break; }
      const success = evaluateProbeAssertions(contract.successAssertions, initialProbe, currentProbe);
      if (decisions.length > 0 && madeVerifiedProgress && success.every(assertion => assertion.passed)) {
        outcome = "PASSED"; failureCode = null; break;
      }
      const failed = evaluateProbeAssertions(contract.failureAssertions, null, currentProbe);
      if (failed.every(assertion => assertion.passed)) { failureCode = "ORACLE_FAILURE"; break; }

      const screenshotPath = join(workspace, "adaptive-observations", `${runId}-${String(decisionIndex).padStart(2, "0")}.png`);
      await mkdir(dirname(screenshotPath), { recursive: true });
      const screenshot = await captureAndInspectScreenshot(
        screenshotPath,
        path => testEnvironment.capture(path),
      );
      const playerObservationPath = join(workspace, "adaptive-player-observations", `${runId}-${String(decisionIndex).padStart(2, "0")}.png`);
      await mkdir(dirname(playerObservationPath), { recursive: true });
      await execute("ffmpeg", [
        "-nostdin", "-loglevel", "error", "-i", screenshotPath,
        "-vf", "drawgrid=width=80:height=80:thickness=1:color=cyan@0.45",
        "-frames:v", "1", "-y", playerObservationPath,
      ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      const screenshotBytes = await readFile(playerObservationPath);
      const playerObservationSha256 = `sha256:${createHash("sha256").update(screenshotBytes).digest("hex")}`;
      const policyRequest = {
        rolloutIndex, decisionIndex, screenshotBase64: screenshotBytes.toString("base64"), screenshotSha256: playerObservationSha256,
        goal: contract.goal, allowedActions: contract.allowedActions, history: history.slice(-6), recovery,
      };
      const policyResponse = await requestPlayerPolicy(policyRequest);
      playerPolicy = policyResponse.policy;
      const decision = policyResponse.decision;
      const beforeDigest = probeStateDigest(currentProbe);
      const nativeEvents = policyNativeEvents(decision.actions);
      const signature = jsonDigest({ screenshot: screenshot.sha256, actions: decision.actions });
      const seen = (loopSignatures.get(signature) ?? 0) + 1;
      loopSignatures.set(signature, seen);
      if (seen >= 3) { failureCode = "PLAYER_ACTION_LOOP"; break; }
      if (nativeEvents.length > 0) {
        await testEnvironment.sequence(nativeEvents, Math.min(30_000, remainingPlatformBudget()));
        const gamepadCount = gamepadEventCount(nativeEvents);
        gamepadInputCount += gamepadCount;
        keyboardMouseInputCount += nativeEvents.length - gamepadCount;
      }
      let after = currentProbe;
      if (nativeEvents.length > 0) {
        after = await waitForProbeSnapshot(probePath, { sessionNonce, pid: launched.pid, afterSequence: currentProbe.sequence }, PROBE_TIMEOUT_MS)
          .catch(() => currentProbe);
      }
      const afterDigest = probeStateDigest(after);
      const changed = after.sequence > currentProbe.sequence && beforeDigest !== afterDigest;
      if (changed) {
        madeVerifiedProgress = true;
        noProgressDecisions = 0;
        lastProgressAt = Date.now();
        recovery = false;
        recoveryStartedAt = null;
        recoveryDecisionIndex = null;
      } else {
        noProgressDecisions += 1;
        if (!recovery && (noProgressDecisions >= 5 || Date.now() - lastProgressAt >= 30_000)) {
          recovery = true;
          recoveryStartedAt = Date.now();
          recoveryDecisionIndex = decisionIndex;
        }
      }
      const successOracle = evaluateProbeAssertions(contract.successAssertions, initialProbe, after);
      const failureOracle = evaluateProbeAssertions(contract.failureAssertions, null, after);
      const record = {
        schema: "deviludo.e2e-trajectory-event", rolloutIndex, decisionIndex, seed,
        observedAt: new Date().toISOString(), screenshotSha256: screenshot.sha256,
        status: decision.status, observation: decision.observation, rationale: decision.rationale,
        actions: decision.actions, semanticActions: semanticizePolicyActions(decision.actions, currentProbe),
        before: { sequence: currentProbe.sequence, sceneId: currentProbe.sceneId, digest: beforeDigest },
        after: { sequence: after.sequence, sceneId: after.sceneId, digest: afterDigest },
        stateChanged: changed, recovery,
        oracle: { success: successOracle, failure: failureOracle }, policy: policyResponse.policy,
      };
      await appendFile(trajectoryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      decisions.push(record);
      history.push({ decisionIndex, observation: decision.observation, actions: decision.actions, result: changed ? "state changed" : "no verified progress" });
      currentProbe = after;
      if (decision.status === "UNRECOVERABLE") { failureCode = "PLAYER_UNRECOVERABLE"; break; }
      if (decision.status === "GOAL_REACHED"
        && (!madeVerifiedProgress
          || !evaluateProbeAssertions(contract.successAssertions, initialProbe, currentProbe).every(assertion => assertion.passed))) {
        failureCode = "ORACLE_REJECTED_GOAL";
        break;
      }
      if (recovery && recoveryStartedAt !== null && recoveryDecisionIndex !== null
        && (decisionIndex - recoveryDecisionIndex >= 3 || Date.now() - recoveryStartedAt >= 20_000)) {
        failureCode = "PLAYER_STUCK";
        break;
      }
    }
    const finalSuccess = evaluateProbeAssertions(contract.successAssertions, initialProbe, currentProbe);
    if (decisions.length > 0 && madeVerifiedProgress && finalSuccess.every(assertion => assertion.passed)) {
      outcome = "PASSED"; failureCode = null;
    }
    const finalScreenshot = join(workspace, "evidence-screenshots", `${runId}-final.png`);
    await mkdir(dirname(finalScreenshot), { recursive: true });
    await captureAndInspectScreenshot(finalScreenshot, path => testEnvironment.capture(path));
    if (screenshots.length < MAX_SCREENSHOTS) screenshots.push({ id: `${runId}-final`, path: finalScreenshot });
  } finally {
    const video = await testEnvironment.close();
    if (video) videos.push(video);
    await launched.terminate();
    const logs = await launched.logs();
    const gameLog = await readOptionalLog(gameLogPath);
    const stdout = [logs.stdout, gameLog.toString("utf8")].filter(Boolean).join("\n");
    stdoutLogs.push(stdout); stderrLogs.push(logs.stderr);
    const errors = godotErrorLines(stdout, logs.stderr);
    if (errors.length) throw productFailure("GODOT_SCRIPT_ERROR", errors[0]);
  }
  trajectories.push({ id: runId, path: trajectoryPath });
  return Object.freeze({
    rolloutIndex, seed, outcome, failureCode, decisionCount: decisions.length,
    durationMs: Date.now() - rolloutStartedAt, decisions: Object.freeze(decisions),
  });
}

async function solidifyRegression(gamePackage, manifest, successfulRollouts) {
  const candidate = [...successfulRollouts]
    .sort((left, right) => left.decisionCount - right.decisionCount || left.durationMs - right.durationMs)
    .find(rollout => rollout.decisions.flatMap(decision => decision.semanticActions)
      .every(action => action.type === "drag" ? typeof action.fromTargetId === "string" && typeof action.toTargetId === "string"
        : !["click", "double_click", "scroll"].includes(action.type) || typeof action.targetId === "string"));
  if (!candidate) throw productFailure("REGRESSION_CANDIDATE_MISSING", "没有可固化的成功玩家轨迹");
  const actions = candidate.decisions.flatMap(decision => decision.semanticActions).filter(action => action.type !== "wait");
  if (!actions.length) throw productFailure("REGRESSION_CANDIDATE_INVALID", "成功轨迹不包含可回放的真实输入");
  const trace = {
    schema: "deviludo.e2e-regression", contractDigest: jsonDigest({ testManifest: manifest, runner: "adaptive-real-input" }),
    inputProfile: manifest.primaryInputProfile, estimatedDurationMs: Math.min(300_000, Math.max(1, candidate.durationMs)),
    goal: manifest.adaptivePlayer.goal, actions, successAssertions: manifest.adaptivePlayer.successAssertions,
  };
  for (let replayIndex = 0; replayIndex < 2; replayIndex += 1) {
    const passed = await replayRegression(gamePackage, trace, replayIndex);
    if (!passed) throw productFailure("REGRESSION_REPLAY_FAILED", `候选回归轨迹第 ${replayIndex + 1} 次干净回放失败`);
  }
  const path = join(workspace, "evidence-regression", "current.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
  regressions.push({ id: "current", path });
}

async function replayRegression(gamePackage, trace, replayIndex) {
  const runId = replayIndex === "current" ? "regression-current" : `regression-replay-${replayIndex + 1}`;
  const probePath = join(workspace, "ui-probe", `${runId}.json`);
  const gameLogPath = join(workspace, "game-logs", `${runId}.log`);
  await Promise.all([probePath, gameLogPath].map(path => mkdir(dirname(path), { recursive: true })));
  const sessionNonce = randomBytes(32).toString("hex");
  const { launched, testEnvironment } = await launchManagedGame(
    gamePackage, gameWindowArguments(gameLogPath), await isolatedGameEnvironment(runId, {
      DEVILUDO_E2E_UI_PROBE_FILE: probePath, DEVILUDO_E2E_SESSION_NONCE: sessionNonce,
    }), runId, trace.inputProfile === "GAMEPAD",
  );
  try {
    await testEnvironment.prepare();
    let probe = await waitForProbeSnapshot(probePath, { sessionNonce, pid: launched.pid }, PROBE_TIMEOUT_MS);
    for (const action of trace.actions) {
      const concrete = materializeRegressionAction(action, probe);
      await testEnvironment.sequence(policyNativeEvents([concrete]), Math.min(30_000, remainingPlatformBudget()));
      probe = await waitForProbeSnapshot(probePath, { sessionNonce, pid: launched.pid, afterSequence: probe.sequence }, PROBE_TIMEOUT_MS);
    }
    return evaluateProbeAssertions(trace.successAssertions, null, probe).every(assertion => assertion.passed);
  } finally {
    const video = await testEnvironment.close();
    if (video) videos.push(video);
    await launched.terminate();
  }
}

function semanticizePolicyActions(actions, probe) {
  return actions.map(action => {
    const targetAt = (x, y) => {
      const matches = probe.controls.filter(control => control.visible && control.enabled
        && Number(x) >= control.rect.x && Number(x) < control.rect.x + control.rect.width
        && Number(y) >= control.rect.y && Number(y) < control.rect.y + control.rect.height);
      return matches.length === 1 ? matches[0].id : null;
    };
    if (["click", "double_click", "scroll"].includes(action.type)) {
      const targetId = targetAt(action.x, action.y);
      if (!targetId) return action;
      const rest = { ...action };
      delete rest.x;
      delete rest.y;
      return { ...rest, targetId };
    }
    if (action.type === "drag") {
      const fromTargetId = targetAt(action.fromX, action.fromY);
      const toTargetId = targetAt(action.toX, action.toY);
      if (!fromTargetId || !toTargetId) return action;
      const rest = { ...action };
      delete rest.fromX;
      delete rest.fromY;
      delete rest.toX;
      delete rest.toY;
      return { ...rest, fromTargetId, toTargetId };
    }
    return action;
  });
}

function materializeRegressionAction(action, probe) {
  if (action.fromTargetId && action.toTargetId) {
    const from = resolveProbeControl(probe, action.fromTargetId).center;
    const to = resolveProbeControl(probe, action.toTargetId).center;
    const rest = { ...action };
    delete rest.fromTargetId;
    delete rest.toTargetId;
    return { ...rest, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
  }
  if (!action.targetId) return action;
  const center = resolveProbeControl(probe, action.targetId).center;
  const rest = { ...action };
  delete rest.targetId;
  return { ...rest, ...center };
}

function policyNativeEvents(actions) {
  return actions.flatMap(action => {
    if (action.type === "wait") return [{ type: "wait", delay_ms: action.duration_ms }];
    if (action.type === "key_tap") return [{ type: "key_press", key: action.key, delay_ms: 0 }, { type: "key_release", key: action.key, delay_ms: 80 }];
    if (action.type === "key_hold") return [{ type: "key_press", key: action.key, delay_ms: 0 }, { type: "wait", delay_ms: action.duration_ms }, { type: "key_release", key: action.key, delay_ms: 0 }];
    if (action.type === "text_input") return [{ type: "text_input", text: action.text, delay_ms: 0 }];
    if (["click", "double_click"].includes(action.type)) return [
      { type: "mouse_move", x: action.x, y: action.y, delay_ms: 0 },
      { type: "mouse_click", button: "LEFT", delay_ms: 80 },
      ...(action.type === "double_click" ? [{ type: "mouse_click", button: "LEFT", delay_ms: 80 }] : []),
    ];
    if (action.type === "scroll") return [{ type: "mouse_move", x: action.x, y: action.y, delay_ms: 0 }, { type: "scroll", deltaY: action.deltaY, delay_ms: 80 }];
    if (action.type === "drag") return [
      { type: "mouse_move", x: action.fromX, y: action.fromY, delay_ms: 0 },
      { type: "mouse_down", button: "LEFT", delay_ms: 80 },
      { type: "wait", delay_ms: action.duration_ms },
      { type: "mouse_move", x: action.toX, y: action.toY, delay_ms: 0 },
      { type: "mouse_up", button: "LEFT", delay_ms: 80 },
    ];
    if (String(action.type).startsWith("gamepad_")) return [{ ...action, delay_ms: 0 }];
    throw productFailure("PLAYER_POLICY_ACTION_INVALID", `Test Agent 返回了不安全输入 ${action.type}`);
  });
}

async function requestPlayerPolicy(request) {
  if (!streamProtocol || !policyLines) throw new Error("INFRASTRUCTURE: Test Agent player policy relay is unavailable");
  const id = randomUUID();
  process.stdout.write(`${JSON.stringify({ type: "policy_request", id, request })}\n`);
  const responseLine = await Promise.race([
    policyLines.next(),
    delay(65_000).then(() => { throw new Error("INFRASTRUCTURE: Test Agent player policy timed out"); }),
  ]);
  if (responseLine.done) throw new Error("INFRASTRUCTURE: Test Agent player policy relay closed");
  const message = JSON.parse(responseLine.value);
  if (message?.type !== "policy_response" || message.id !== id) throw new Error("INFRASTRUCTURE: Test Agent player policy response is invalid");
  if (typeof message.error === "string") throw new Error(`INFRASTRUCTURE: ${message.error.slice(0, 1_000)}`);
  if (!message.response?.decision || !message.response?.policy) throw new Error("INFRASTRUCTURE: Test Agent player policy omitted its decision");
  return message.response;
}

function stableRolloutSeed(manifest, rolloutIndex) {
  const project = process.env.DEVILUDO_E2E_PROJECT_ID ?? jobId;
  return createHash("sha256").update(`${project}\0${platform}\0${jsonDigest(manifest)}\0${rolloutIndex}`).digest().readUInt32BE(0);
}

function planExecution(manifest, currentRegressionMs) {
  const unitByPath = new Map();
  for (const feature of manifest.features.filter(item => item.verificationMethod === "unit")) {
    unitByPath.set(feature.gdsTestPath, Math.max(unitByPath.get(feature.gdsTestPath) ?? 0, feature.timeoutMs));
  }
  const unitMs = [...unitByPath.values()].reduce((sum, value) => sum + value, 0);
  const deterministicMs = manifest.features.filter(item => item.verificationMethod === "interactive").reduce((sum, item) => sum + item.timeoutMs, 0);
  const visualMs = manifest.features.filter(item => item.verificationMethod === "visual").reduce((sum, item) => sum + (item.expectedVisual.captureDelay ?? 1000) + 30000, 0);
  const raw = Math.ceil(1.25 * (180000 + unitMs + deterministicMs + visualMs + currentRegressionMs
    + 3 * manifest.adaptivePlayer.rolloutTimeoutMs + 2 * manifest.adaptivePlayer.rolloutTimeoutMs + 180000));
  const plannedTimeoutMs = Math.ceil(Math.max(30 * 60000, raw) / 60000) * 60000;
  if (plannedTimeoutMs > 90 * 60000) throw productFailure("E2E_PLAN_EXCEEDS_LIMIT", "冻结的单平台 E2E 计划超过 90 分钟");
  return { plannedTimeoutMs, unitMs, deterministicMs, visualMs, currentRegressionMs };
}

function jsonDigest(value) {
  const stable = input => Array.isArray(input) ? `[${input.map(stable).join(",")}]`
    : input && typeof input === "object" ? `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${stable(input[key])}`).join(",")}}`
      : JSON.stringify(input);
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
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
    case "gamepad_button_tap": return [{ type: event.type, button: event.button, delay_ms: 0 }];
    case "gamepad_button_hold": return [{ type: event.type, button: event.button, duration_ms: event.duration_ms, delay_ms: 0 }];
    case "gamepad_axis": return [{ type: event.type, axis: event.axis, value: event.value, duration_ms: event.duration_ms ?? 0, delay_ms: 0 }];
    case "gamepad_trigger": return [{ type: event.type, trigger: event.trigger, value: event.value, duration_ms: event.duration_ms ?? 0, delay_ms: 0 }];
    case "gamepad_release_all": return [{ type: event.type, delay_ms: 0 }];
    default: throw productFailure("INPUT_EVENT_INVALID", `不支持的输入事件 ${event.type}`);
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

async function launchManagedGame(gamePackage, arguments_, environment, runId, useGamepad) {
  const testEnvironment = new GameTestEnvironment({
    pid: null, runId, workspace, driver,
    gamepadDriver: process.env.DEVILUDO_GAMEPAD_DRIVER ?? "", useGamepad,
  });
  await testEnvironment.prepareInputDevices();
  try {
    const launched = await launchNativeGame(gamePackage, arguments_, environment);
    testEnvironment.attach(launched.pid);
    return { launched, testEnvironment };
  } catch (error) {
    await testEnvironment.close().catch(() => undefined);
    throw error;
  }
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
  const projectPacks = files.filter(path => path.toLowerCase().endsWith(".pck"));
  if (projectPacks.length !== 1) {
    throw productFailure("PROJECT_PACK_INVALID", `构建制品必须包含且只包含一个 Godot PCK，实际为 ${projectPacks.length} 个`);
  }
  const executable = operatingSystem === "macos" ? files.find(path => path.includes(".app/Contents/MacOS/"))
    : operatingSystem === "windows" ? files.find(path => path.toLowerCase().endsWith(".exe"))
      : files.find(path => path.endsWith(".x86_64"));
  if (!executable) throw productFailure("EXECUTABLE_MISSING", `构建制品不包含 ${operatingSystem} 游戏可执行程序`);
  if (operatingSystem !== "windows") await chmod(executable, 0o700);
  if (operatingSystem === "macos") {
    const marker = executable.indexOf(".app/Contents/MacOS/");
    return { executable, packagePath: executable.slice(0, marker + 4), projectPack: projectPacks[0] };
  }
  return { executable, packagePath: executable, projectPack: projectPacks[0] };
}

function godotUnitRuntime() {
  const configured = process.env.DEVILUDO_GODOT_RUNTIME ?? (platform === "macos"
    ? "/Applications/Godot.app/Contents/MacOS/Godot"
    : platform === "windows" ? "C:\\Program Files\\Godot\\Godot.exe" : "/usr/bin/godot");
  if (!isAbsolute(configured)) throw new Error("INFRASTRUCTURE: fixed Godot unit-test runtime path must be absolute");
  return configured;
}

function assertManifest(value) {
  if (!value || value.schema !== "deviludo.test-manifest" || Object.hasOwn(value, "schemaVersion")
    || Object.hasOwn(value, "version")
    || !Array.isArray(value.inputProfiles) || !value.inputProfiles.length || value.inputProfiles.length > 2
    || value.inputProfiles.some(profile => !["KEYBOARD_MOUSE", "GAMEPAD"].includes(profile))
    || new Set(value.inputProfiles).size !== value.inputProfiles.length || !value.inputProfiles.includes(value.primaryInputProfile)
    || !Array.isArray(value.requirements) || !value.requirements.length
    || value.requirements.length > 500 || !Array.isArray(value.features) || !value.features.length || value.features.length > 500) {
    throw productFailure("E2E_MANIFEST_INVALID", "测试清单结构无效");
  }
  const requirementIds = new Set();
  const playerRequirements = new Set();
  const coreRequirements = new Set();
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
    if (requirement.source === "CORE_LOOP") coreRequirements.add(requirement.requirementId);
  }
  const adaptive = value.adaptivePlayer;
  if (!adaptive || typeof adaptive !== "object" || Array.isArray(adaptive)
    || typeof adaptive.goal !== "string" || adaptive.goal.trim().length < 10 || adaptive.goal.length > 4000
    || !Array.isArray(adaptive.requirementIds) || !adaptive.requirementIds.length
    || adaptive.requirementIds.some(id => !playerRequirements.has(id))
    || [...coreRequirements].some(id => !adaptive.requirementIds.includes(id))
    || !Array.isArray(adaptive.allowedActions) || !adaptive.allowedActions.length
    || adaptive.allowedActions.some(item => !["KEYBOARD", "POINTER", "GAMEPAD"].includes(item))
    || adaptive.allowedActions.includes("GAMEPAD") !== value.inputProfiles.includes("GAMEPAD")
    || (adaptive.allowedActions.includes("KEYBOARD") || adaptive.allowedActions.includes("POINTER")) !== value.inputProfiles.includes("KEYBOARD_MOUSE")
    || !Array.isArray(adaptive.successAssertions) || !adaptive.successAssertions.length || !adaptive.successAssertions.every(validProbeAssertion)
    || !adaptive.successAssertions.some(assertion => assertion && assertion.source === "PROGRESS"
      && ["CHANGED", "NOT_EQUALS", "GREATER_THAN", "GREATER_THAN_OR_EQUALS"].includes(assertion.operator))
    || !Array.isArray(adaptive.failureAssertions) || !adaptive.failureAssertions.length || !adaptive.failureAssertions.every(validProbeAssertion)
    || !Number.isInteger(adaptive.rolloutTimeoutMs) || adaptive.rolloutTimeoutMs < 240000 || adaptive.rolloutTimeoutMs > 300000
    || !Number.isInteger(adaptive.maxDecisions) || adaptive.maxDecisions < 8 || adaptive.maxDecisions > 40
    || adaptive.seedStrategy !== "STABLE_PROJECT_PLATFORM") throw productFailure("ADAPTIVE_CONTRACT_INVALID", "自适应玩家测试合同无效");
  const featureIds = new Set();
  const unitNames = new Set();
  const automatedCoverage = new Set();
  const interactiveCoverage = new Set();
  let journeys = 0;
  let checkpointCount = 0;
  let hasCore = false;
  const exercisedInputProfiles = new Set();
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
        || !Number.isInteger(feature.timeoutMs) || feature.timeoutMs < 1 || feature.timeoutMs > 300_000
        || feature.checkNames.some(name => !stableId(name) || unitNames.has(name))) throw productFailure("E2E_MANIFEST_INVALID", `单元测试项无效：${feature.id}`);
      feature.checkNames.forEach(name => unitNames.add(name));
    } else if (feature.verificationMethod === "interactive") {
      if (!validLaunchProfile(feature.launchProfile) || !Number.isInteger(feature.timeoutMs) || feature.timeoutMs < 1 || feature.timeoutMs > 300_000
        || !validInteractionScript(feature.interactionScript, feature.requirementIds, playerRequirements)) throw productFailure("E2E_MANIFEST_INVALID", `真实操作旅程无效：${feature.id}`);
      journeys += 1;
      const events = feature.interactionScript.events;
      events.filter(isActionEvent).forEach(event => exercisedInputProfiles.add(String(event.type).startsWith("gamepad_") ? "GAMEPAD" : "KEYBOARD_MOUSE"));
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
      if (!feature.expectedVisual || Object.hasOwn(feature.expectedVisual, "version") || !safePngPath(feature.expectedVisual.referenceImage)) {
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
  if (value.inputProfiles.some(profile => !exercisedInputProfiles.has(profile))) throw productFailure("INPUT_PROFILE_COVERAGE_MISSING", "声明的输入方式没有确定性真实操作覆盖");
}

async function finish(outcome, failureDomain, summary, manifest) {
  const scopedRequirements = manifest?.requirements ?? [];
  const playerRequirementCount = scopedRequirements.filter(item => item.verificationClass === "PLAYER_INTERACTION").length;
  const report = {
    schema: E2E_EVIDENCE_SCHEMA, jobId, platform, action, outcome, failureDomain, summary,
    packageLaunches: launchRecords,
    coverage: {
      headlessCheckCount: headlessChecks.size,
      interactiveJourneyCount: interactiveJourneys.size,
      deterministicInputCount: steps.length,
      realInputCount: keyboardMouseInputCount + gamepadInputCount,
      keyboardMouseInputCount,
      gamepadInputCount,
      adaptiveRolloutCount: adaptiveRollouts.length,
      adaptiveSuccessCount: adaptiveRollouts.filter(item => item.outcome === "PASSED").length,
      adaptiveDecisionCount: adaptiveRollouts.reduce((sum, item) => sum + item.decisionCount, 0),
      coveredPlayerRequirementCount: coveredPlayerRequirements.size,
      playerRequirementCount,
      visualBaselineCount: baselines.length,
    },
    testDetails: {
      suite: "deviludo-real-window-e2e",
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
    steps, checkpoints, adaptiveRollouts, playerPolicy,
    regression: {
      currentReplay: currentRegressionResult,
      replacement: outcome === "PASSED" && regressions[0]
        ? { stored: true, filename: "regression/current.json" }
        : { stored: false },
    },
    screenshotCount: screenshots.length, videoCount: videos.length, visualDiff: diffs.length > 0,
  };
  const bundle = await createEvidenceBundle({
    outputRoot: evidenceRoot, jobId, platform, report,
    stdout: stdoutLogs.join("\n"), stderr: stderrLogs.join("\n"), screenshots, diffs, baselines,
    videos, trajectories, regressions,
  });
  const regressionBytes = outcome === "PASSED" && regressions[0] ? await readFile(regressions[0].path) : null;
  const regressionTrace = regressionBytes ? JSON.parse(regressionBytes.toString("utf8")) : null;
  const regressionOutputPath = regressionBytes ? join(evidenceRoot, `e2e-regression-${platform}-${jobId}.json`) : null;
  if (regressionBytes && regressionOutputPath) await writeFile(regressionOutputPath, regressionBytes, { mode: 0o600 });
  const receipt = {
    schema: GUEST_REPORT_SCHEMA, action, jobId, outcome, failureDomain, summary,
    guest: { executor: "real-window-godot", isolation: "EPHEMERAL_VM", exitCode: outcome === "PASSED" ? 0 : gameExitCode || 1 },
    testDetails: report.testDetails,
    evidence: {
      schema: E2E_EVIDENCE_SCHEMA, result: outcome,
      headlessCheckCount: headlessChecks.size, interactiveJourneyCount: interactiveJourneys.size,
      deterministicInputCount: steps.length,
      realInputCount: keyboardMouseInputCount + gamepadInputCount,
      keyboardMouseInputCount, gamepadInputCount,
      adaptiveRolloutCount: adaptiveRollouts.length,
      adaptiveSuccessCount: adaptiveRollouts.filter(item => item.outcome === "PASSED").length,
      adaptiveDecisionCount: adaptiveRollouts.reduce((sum, item) => sum + item.decisionCount, 0),
      coveredPlayerRequirementCount: coveredPlayerRequirements.size,
      playerRequirementCount, screenshotCount: screenshots.length, visualBaselineCount: baselines.length,
      videoCount: videos.length, hasVisualDiff: diffs.length > 0,
      regressionTraceDigest: regressionBytes ? `sha256:${createHash("sha256").update(regressionBytes).digest("hex")}` : null,
      regressionContractDigest: regressionTrace?.contractDigest ?? null,
      regressionInputProfile: regressionTrace?.inputProfile ?? null,
      regressionEstimatedDurationMs: regressionTrace?.estimatedDurationMs ?? null,
      packageLaunchMode: launchRecords.find(record => record.packagePath)?.mode ?? null,
    },
    outputPath: bundle.outputPath, outputSha256: bundle.outputSha256, outputSizeBytes: bundle.outputSizeBytes,
    ...(regressions[0] && regressionBytes ? {
      regressionOutputPath,
      regressionOutputSha256: `sha256:${createHash("sha256").update(regressionBytes).digest("hex")}`,
      regressionOutputSizeBytes: regressionBytes.length,
    } : {}),
  };
  process.stdout.write(streamProtocol
    ? `${JSON.stringify({ type: "result", value: receipt })}\n`
    : jsonOutput ? JSON.stringify(receipt) : `${JSON.stringify(receipt, null, 2)}\n`);
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
    const stderr = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString("utf8").trim()
      : typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const message = error instanceof Error ? error.message.trim() : "";
    const detail = stderr || message || String(error ?? "").trim() || `GUI driver ${command} failed without diagnostics`;
    throw new Error(`INFRASTRUCTURE: GUI driver ${command} failed: ${detail.slice(0, 1_900)}`, { cause: error });
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
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        code: Number.isInteger(code) ? code : 124,
        signal: typeof signal === "string" ? signal : null,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function assertPlatformBudget() { if (Date.now() >= platformDeadline) throw productFailure("PLATFORM_TIMEOUT", "单个平台 E2E 超过冻结的动态总预算"); }
function remainingPlatformBudget() { return Math.max(1, platformDeadline - Date.now()); }
async function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function readOptionalLog(path) { return readFile(path).catch(() => Buffer.alloc(0)); }
function gameWindowArguments(logPath) { return ["--log-file", logPath, "--windowed", "--resolution", `${E2E_CLIENT_WIDTH}x${E2E_CLIENT_HEIGHT}`, "--position", "40,40"]; }
function checkpointEvidenceId(journeyId, checkpointId) { return `journey-${journeyId.length}-${journeyId}-${checkpointId}`; }
function safeGodotPath(value) { return typeof value === "string" && /^res:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,219}\.gd$/.test(value) && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value.slice(6)); }
function productFailureMessage(code, message) {
  const detail = String(message ?? "").trim();
  return (detail || `${code} 未提供详细错误`).slice(0, 2_000);
}
function productFailure(code, message) { return Object.assign(new Error(productFailureMessage(code, message)), { code, productFailure: true }); }
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
