import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateGuestInteractionScript } from "../scripts/e2e-interaction-contract.mjs";
import {
  closeChildPipesAfterExit,
  forwardTerminationSignals,
  readCliArgument,
  readProtocolLineWithTimeout,
  settleChildAfterProtocolResult,
  startChildProtocolWatchdog,
  waitForChildWithHardTimeout,
} from "../deploy/assets/e2e-process-lifecycle.mjs";
import { GameTestEnvironment } from "../scripts/executors/game-test-environment.mjs";
import { parseE2eExecutorProtocolChunk } from "../services/e2e-node/src/executor";

test("the guest accepts a semantic mouse journey with post-action Oracle evidence", () => {
  const changed = Object.freeze({ source: "STATE", key: "session.started", operator: "CHANGED" });
  const script = {
    events: [
      { type: "checkpoint", id: "start", role: "START", visualMode: "STABLE_REPLAY",
        assertions: [{ source: "SCENE", operator: "EXISTS" }] },
      { type: "click", stepId: "start-game", intent: "START_SESSION", targetId: "new-game",
        button: "LEFT", coversRequirementIds: ["req-new-game"], postconditions: [changed] },
      { type: "checkpoint", id: "complete", role: "COMPLETION", visualMode: "DYNAMIC",
        changeTargetId: "game-viewport", assertions: [{ source: "STATE", key: "session.started", operator: "EQUALS", value: true }] },
    ],
  };
  assert.equal(validateGuestInteractionScript(script, ["req-new-game"], new Set(["req-new-game"])), true);
});

test("an omitted optional regression argument stays empty instead of reading argv[0]", () => {
  const argv = ["/usr/local/bin/node", "/opt/deviludo/local-tart-guest-runner.mjs", "test", "--artifact", "/tmp/build.tar.gz"];
  assert.equal(readCliArgument(argv, "--regression"), "");
  assert.equal(readCliArgument(argv, "--artifact"), "/tmp/build.tar.gz");
  assert.equal(readCliArgument([...argv, "--regression", "--job-id", "job"], "--regression"), "");
});

test("a framed runner exits after returning its result even while the parent stdin remains open", async () => {
  const child = spawn(process.execPath, [new URL("./fixtures/e2e-result-exit-child.mjs", import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
  child.stdin.write(`${JSON.stringify({ type: "execute" })}\n`);
  const [code] = await Promise.race([
    once(child, "close"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("result child did not exit")), 1_000)),
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /"type":"result"/);
});

test("the hard deadline terminates a stuck process group", async () => {
  const killProcessGroup = process.platform !== "win32";
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: killProcessGroup,
  });
  const pid = child.pid;
  assert.ok(pid);
  const startedAt = Date.now();
  const result = await waitForChildWithHardTimeout(child, {
    timeoutMs: 50,
    terminateGraceMs: 50,
    killProcessGroup,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 1_000);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.throws(() => process.kill(pid, 0));
});

test("an exited child cannot hang forever when a grandchild inherits its pipes", async () => {
  const killProcessGroup = process.platform !== "win32";
  const child = spawn(process.execPath, ["-e", [
    "const { spawn } = require('node:child_process');",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
    "grandchild.unref();",
  ].join("\n")], { stdio: ["ignore", "pipe", "pipe"], detached: killProcessGroup });
  const pid = child.pid;
  assert.ok(pid);
  const stopClosing = closeChildPipesAfterExit(child, 50);
  const startedAt = Date.now();
  const result = await waitForChildWithHardTimeout(child, {
    timeoutMs: 1_000,
    terminateGraceMs: 50,
    killProcessGroup,
  });
  stopClosing();
  assert.equal(result.timedOut, false);
  assert.ok(Date.now() - startedAt < 500);
  if (killProcessGroup) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* The group already exited. */ }
  }
});

test("a protocol result terminates a transport that remains alive after the remote job finished", async () => {
  const killProcessGroup = process.platform !== "win32";
  const child = spawn(process.execPath, ["-e", [
    "process.stdout.write(JSON.stringify({ type: 'result', value: { outcome: 'FAILED' } }) + '\\n');",
    "setInterval(() => {}, 1000);",
  ].join("\n")], { stdio: ["pipe", "pipe", "pipe"], detached: killProcessGroup });
  const pid = child.pid;
  assert.ok(pid);
  const stopClosing = closeChildPipesAfterExit(child, 50);
  const childClosed = waitForChildWithHardTimeout(child, {
    timeoutMs: 1_000,
    terminateGraceMs: 50,
    killProcessGroup,
  });
  await once(child.stdout, "data");
  const startedAt = Date.now();
  const settlement = await settleChildAfterProtocolResult(child, childClosed, {
    graceMs: 50,
    killProcessGroup,
  });
  stopClosing();
  assert.equal(settlement.transportTerminated, true);
  assert.equal(settlement.result.timedOut, false);
  assert.ok(Date.now() - startedAt < 500);
  assert.throws(() => process.kill(pid, 0));
});

test("a silent guest transport is killed before the frozen platform deadline", async () => {
  const killProcessGroup = process.platform !== "win32";
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: killProcessGroup,
  });
  const pid = child.pid;
  assert.ok(pid);
  const stopClosing = closeChildPipesAfterExit(child, 25);
  const watchdog = startChildProtocolWatchdog(child, {
    idleMs: 50,
    checkMs: 10,
    terminateGraceMs: 25,
    killProcessGroup,
  });
  const result = await waitForChildWithHardTimeout(child, {
    timeoutMs: 1_000,
    terminateGraceMs: 25,
    killProcessGroup,
  });
  watchdog.stop();
  stopClosing();
  assert.equal(watchdog.expired(), true);
  assert.equal(result.timedOut, false);
  assert.throws(() => process.kill(pid, 0));
});

test("a policy relay stops waiting when its guest transport closes", async () => {
  const killProcessGroup = process.platform !== "win32";
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20)"], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: killProcessGroup,
  });
  const childClosed = waitForChildWithHardTimeout(child, {
    timeoutMs: 1_000,
    terminateGraceMs: 25,
    killProcessGroup,
  });
  const neverResponds = { next: () => new Promise<IteratorResult<string>>(() => undefined) };
  await assert.rejects(
    readProtocolLineWithTimeout(neverResponds, childClosed, 1_000),
    /Protocol transport closed before responding/,
  );
});

test("player-policy screenshots are bounded per frame instead of across the whole E2E stream", () => {
  let remainder = "";
  let totalBytes = 0;
  for (let index = 0; index < 8; index += 1) {
    const frame = `${JSON.stringify({
      type: "policy_request",
      id: `decision-${index}`,
      request: { screenshotBase64: "a".repeat(700_000) },
    })}\n`;
    totalBytes += Buffer.byteLength(frame);
    const parsed = parseE2eExecutorProtocolChunk(remainder, frame);
    remainder = parsed.remainder;
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0]?.id, `decision-${index}`);
  }
  assert.ok(totalBytes > 4 * 1024 * 1024);
  assert.equal(remainder, "");
  assert.throws(
    () => parseE2eExecutorProtocolChunk("", "a".repeat(6 * 1024 * 1024 + 1)),
    /frame exceeds/,
  );
});

test("termination forwarding stops a detached child group and can be removed", async () => {
  const killProcessGroup = process.platform !== "win32";
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: killProcessGroup,
  });
  const pid = child.pid;
  assert.ok(pid);
  const stopForwarding = forwardTerminationSignals(child, killProcessGroup);
  process.emit("SIGTERM");
  await Promise.race([
    once(child, "close"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("forwarded termination did not stop child")), 1_000)),
  ]);
  stopForwarding();
  assert.throws(() => process.kill(pid, 0));
});

test("video frames, evidence screenshots and desktop input never overlap the GUI driver", async () => {
  let active = 0;
  let maximum = 0;
  const driver = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    return { ok: true };
  };
  const environment = new GameTestEnvironment({
    pid: 42,
    runId: "serialized-desktop",
    workspace: "/tmp/deviludo-serialized-desktop",
    driver,
  });
  await Promise.all([
    environment.capture("/tmp/deviludo-evidence.png"),
    environment.capture("/tmp/deviludo-video-frame.png"),
    environment.sequence([{ type: "click" }], 1_000),
  ]);
  assert.equal(maximum, 1);
});

test("a transient native screenshot failure is retried before failing the E2E node", async () => {
  let captures = 0;
  const environment = new GameTestEnvironment({
    pid: 42,
    runId: "capture-retry",
    workspace: "/tmp/deviludo-capture-retry",
    driver: async command => {
      captures += 1;
      if (command === "capture" && captures < 3) throw new Error("capture backend is temporarily unavailable");
      return { ok: true };
    },
  });
  await environment.capture("/tmp/deviludo-capture-retry.png");
  assert.equal(captures, 3);
});

test("the production Guest, relay, executor and node all wire the lifecycle guards", async () => {
  const [guest, tartRelay, executor, node, release, lifecycle] = await Promise.all([
    readFile(new URL("../scripts/executors/godot-window-e2e-guest.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/executors/local-tart-guest-runner.mjs", import.meta.url), "utf8"),
    readFile(new URL("../deploy/assets/e2e-job-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/e2e-node/src/executor.ts", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
    readFile(new URL("../deploy/assets/e2e-process-lifecycle.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(guest, /validateGuestInteractionScript as validInteractionScript/);
  assert.match(guest, /await runConsumerPackageSmoke\(gamePackage\)/);
  assert.match(guest, /const environment = await isolatedGameEnvironment\(runId\);[\s\S]*uninstrumented: true/);
  assert.match(guest, /PACKAGE_NOT_PLAYABLE/);
  assert.match(guest, /driver\("find-pid", \["--executable", executable\]/);
  assert.doesNotMatch(guest, /execute\("ps", \["-ax", "-o", "pid=,command="\]/);
  assert.match(guest, /POSTCONDITION_TRANSITION_MISSING/);
  assert.match(guest, /!transitionProven\) throw configurationFailure\([\s\S]*POSTCONDITION_TRANSITION_MISSING/);
  assert.match(guest, /missingChangedAssertionReferences\(event\.postconditions, before\)[\s\S]*TEST_PLAN_REFERENCE_MISSING/);
  assert.match(guest, /Project Runtime is completing a lifecycle transition/);
  assert.match(guest, /let executionError = null;[\s\S]*failures\.some\(failure => failure\.startsWith\("GODOT_SCRIPT_ERROR"\)\)[\s\S]*if \(executionError\) throw executionError/);
  assert.match(guest, /decision\.screenIntegrity === "PRODUCT_DEFECT"[\s\S]*VISUAL_INTEGRITY_DEFECT/);
  assert.match(guest, /if \(rollout\.failureCode === "VISUAL_INTEGRITY_DEFECT"\) break/);
  assert.match(guest, /adaptiveRollouts\.find\(rollout => rollout\.failureCode === "VISUAL_INTEGRITY_DEFECT"\)[\s\S]*throw productFailure\([\s\S]*"VISUAL_INTEGRITY_DEFECT"/);
  assert.match(guest, /relativePointForTarget\(target, action\.x, action\.y\)[\s\S]*basis-point offsets inside the stable target/);
  assert.match(guest, /materializeRelativePoint\(resolved, action\.relativeX, action\.relativeY\)/);
  assert.match(guest, /if \(action\.type === "wait"\) return Number\.isInteger\(action\.duration_ms\)/);
  assert.match(guest, /if \(decision\.stateChanged !== true\) continue;/);
  assert.match(guest, /const visitedProbeDigests = new Set\(\);[\s\S]*reachedNewState = changed && !visitedProbeDigests\.has\(afterDigest\)[\s\S]*returned to a previously observed state; no verified progress/);
  assert.match(guest, /let gameplayBaselineProbe = null;[\s\S]*Starting a session establishes the gameplay baseline/);
  assert.match(guest, /evaluateProbeAssertions\(contract\.successAssertions, gameplayBaselineProbe \?\? initialProbe, currentProbe\)/);
  assert.match(guest, /gameplayProgressTransitionCount >= MIN_ADAPTIVE_GAMEPLAY_PROGRESS_TRANSITIONS/);
  assert.match(guest, /postEntryActions\.length >= 3[\s\S]*intents\.has\("FEATURE_ACTION"\)/);
  assert.match(guest, /if \(decisionIndex > 0\) await delay\(ADAPTIVE_VISUAL_SETTLE_MS\)/);
  assert.match(guest, /materializeRegressionActionWhenReady\([\s\S]*afterSequence: probe\.sequence[\s\S]*Math\.min\(1_000, remaining\)/);
  assert.match(guest, /isRegressionTargetUnavailable\(error\)[\s\S]*E2E control \..+is missing or duplicated/);
  assert.match(guest, /if \(!isRegressionReplayMismatch\(error\)\) throw error;[\s\S]*replayMismatch = error;[\s\S]*return false/);
  assert.match(guest, /if \(replayMismatch\) await delay\(500\);[\s\S]*await testEnvironment\.close\(\)/);
  assert.match(guest, /catch \(error\) \{[\s\S]*cleanupError = error;[\s\S]*finally \{[\s\S]*await launched\.terminate\(\)/);
  assert.match(guest, /if \(cleanupError && !executionError\) throw cleanupError/);
  assert.match(guest, /error\.message\.startsWith\("INFRASTRUCTURE:"\)\) return false/);
  assert.match(guest, /policyInput\?\.close\(\)/);
  assert.match(guest, /type: "heartbeat"/);
  assert.match(guest, /const measuredStutter = performanceSummary\.failures\.find\(item => item\.code === "GAME_STUTTER_DETECTED"\)/);
  assert.match(guest, /if \(measuredStutter && error\.code !== measuredStutter\.code\)[\s\S]*primaryFailure = productFailure\(measuredStutter\.code, measuredStutter\.message\)/);
  assert.match(guest, /const summary = productFailureMessage\(primaryFailure\.code, primaryFailure\.message\)/);
  assert.match(guest, /detail \|\| `\$\{code\} 未提供详细错误`/);
  assert.match(guest, /const failures = \[\];[\s\S]*failures\.push\(\{[\s\S]*continue;/);
  assert.match(guest, /if \(failures\.length > 0\)[\s\S]*`\$\{journeyId\}\/\$\{checkpointId\}:[\s\S]*failures\.map\(failure => `\$\{failure\.code\} \$\{failure\.detail\}`\)\.join\(", "\)/);
  assert.match(guest, /finish\("FAILED", "PRODUCT", summary, activeManifest\)/);
  assert.match(guest, /finish\("FAILED", "CONFIGURATION", summary, activeManifest\)/);
  assert.match(guest, /Buffer\.isBuffer\(error\?\.stderr\)[\s\S]*error\.stderr\.toString\("utf8"\)\.trim\(\)/);
  assert.match(guest, /const detail = stderr \|\| message \|\| String\(error \?\? ""\)\.trim\(\) \|\| `GUI driver \$\{command\} failed without diagnostics`/);
  assert.match(guest, /throw new Error\(`INFRASTRUCTURE: GUI driver \$\{command\} failed:/);
  assert.match(guest, /captureFailedActionEvidence\(\{[\s\S]*testEnvironment, journey,[\s\S]*await testEnvironment\.capture\(screenshotPath\)/);
  assert.match(guest, /failureCode: "ACTION_TARGET_UNAVAILABLE"[\s\S]*`\$\{journey\.id\}\/\$\{event\.stepId\}: \$\{detail\}`/);
  assert.match(guest, /failureCode: "PROBE_NOT_UPDATED"[\s\S]*await captureFailedActionEvidence\(\{/);
  assert.match(guest, /failureDetail: detail/);
  assert.doesNotMatch(guest, /drawgrid=|playerObservationPath/);
  assert.match(guest, /const screenshotBytes = await readFile\(screenshotPath\)/);
  assert.doesNotMatch(guest, /scale=960:540|adaptive-policy-observations|policyScreenshot/);
  assert.match(guest, /if \(action\.type === "wait"\) return \[\{ type: "wait", delay_ms: action\.duration_ms \}\]/);
  assert.match(tartRelay, /readCliArgument\(process\.argv, name\)/);
  assert.match(tartRelay, /PATH=\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin/);
  assert.match(tartRelay, /waitForChildWithHardTimeout\(remote/);
  assert.match(tartRelay, /remote\.stderr\.on\("data"/);
  assert.match(tartRelay, /remoteStderrLimit = 64 \* 1024/);
  assert.match(tartRelay, /const reason = protocolWatchdog\.expired\(\)[\s\S]*Tart guest runner failed or omitted its result/);
  assert.match(tartRelay, /const remoteKillProcessGroup = false/);
  assert.match(tartRelay, /detached: false/);
  assert.match(tartRelay, /forwardTerminationSignals\(remote, remoteKillProcessGroup\)/);
  assert.match(tartRelay, /settleChildAfterProtocolResult\(remote, remoteClosed/);
  assert.match(tartRelay, /startChildProtocolWatchdog\(remote/);
  assert.match(tartRelay, /const policyResponseTimeoutMs = 490_000/);
  assert.match(tartRelay, /const protocolIdleTimeoutMs = policyResponseTimeoutMs \+ 10_000/);
  assert.match(tartRelay, /idleMs: protocolIdleTimeoutMs/);
  assert.match(tartRelay, /readProtocolLineWithTimeout\(parentLines, remoteClosed, policyResponseTimeoutMs\)/);
  assert.match(executor, /waitForChildWithHardTimeout\(child/);
  assert.match(executor, /readProtocolLineWithTimeout\(parentIterator, childClosed, 490_000\)/);
  assert.match(guest, /delay\(490_000\).*Test Agent player policy timed out/s);
  assert.match(guest, /type: "mouse_click", button: "LEFT", x: action\.x, y: action\.y/);
  assert.match(lifecycle, /idleMs > 600_000/);
  assert.match(lifecycle, /timeoutMs > 600_000/);
  assert.match(guest, /for \(let attempt = 0; attempt < 3; attempt \+= 1\)[\s\S]*requestPlayerPolicyOnce\(request\)/);
  assert.match(guest, /PLAYER_POLICY_PROVIDER\|PLAYER_POLICY_VISION_UNAVAILABLE\|player policy timed out/);
  assert.match(guest, /let policyWaitMs = 0/);
  assert.match(guest, /activeRolloutMs = \(\) => Date\.now\(\) - rolloutStartedAt - policyWaitMs/);
  assert.match(guest, /policyWaitMs \+= Date\.now\(\) - policyStartedAt/);
  assert.match(guest, /successes \+ remaining < ADAPTIVE_REQUIRED_SUCCESSES\) break/);
  assert.doesNotMatch(guest, /Date\.now\(\) - lastProgressAt/);
  assert.match(executor, /closeChildPipesAfterExit\(child\)/);
  assert.match(executor, /forwardTerminationSignals\(child, killProcessGroup\)/);
  assert.match(node, /waitForChildWithHardTimeout\(child/);
  assert.match(release, /E2E_MACOS\.tar\.gz[^\n]+e2e-process-lifecycle\.mjs/);
});
