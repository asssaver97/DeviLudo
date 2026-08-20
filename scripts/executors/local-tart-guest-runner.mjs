#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import {
  closeChildPipesAfterExit,
  closeLineInput,
  forwardTerminationSignals,
  readCliArgument,
  readProtocolLineWithTimeout,
  settleChildAfterProtocolResult,
  startChildProtocolWatchdog,
  terminateChildProcess,
  waitForChildWithHardTimeout,
} from "../../deploy/assets/e2e-process-lifecycle.mjs";
const execute = promisify(execFile);
const action = process.argv[2];
const argument = name => readCliArgument(process.argv, name);
const jobId = argument("--job-id");
const artifact = argument("--artifact");
const testPlan = argument("--test-plan");
const regression = argument("--regression");
const hostOutput = process.env.DEVILUDO_E2E_HOST_OUTPUT ?? "";
const hostRegressionOutput = process.env.DEVILUDO_E2E_HOST_REGRESSION_OUTPUT ?? "";
if (!/^[0-9a-f-]{36}$/i.test(jobId) || !isAbsolute(artifact) || !isAbsolute(testPlan) || action !== "test") throw new Error("Local Tart guest request is invalid");
const configuration = JSON.parse(await readFile(new URL("../../.deviludo/local/tart-e2e.json", import.meta.url), "utf8"));
const vmName = `deviludo-${jobId}`;
let ip = "";
for (let attempt = 0; attempt < 180; attempt += 1) {
  ip = (await execute("tart", ["ip", vmName], { timeout: 5_000 }).then(result => result.stdout.trim()).catch(() => ""));
  if (ip) break;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1000));
}
if (!ip) throw new Error("Tart guest did not report an address");
const ssh = ["-i", configuration.keyFile, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "HostKeyAlias=deviludo-tart-guest", "-o", `UserKnownHostsFile=${configuration.knownHostsFile}`];
const remoteArtifact = `/Users/Shared/deviludo-artifact-${jobId}`;
await execute("scp", [...ssh, artifact, `${configuration.guestUser}@${ip}:${remoteArtifact}`], { timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 });
const remoteTestPlan = `/Users/Shared/deviludo-test-plan-${jobId}.json`;
await execute("scp", [...ssh, testPlan, `${configuration.guestUser}@${ip}:${remoteTestPlan}`], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
const remoteRegression = regression ? `/Users/Shared/deviludo-regression-${jobId}.json` : "";
if (regression) {
  if (!isAbsolute(regression)) throw new Error("Local regression path must be absolute");
  await execute("scp", [...ssh, regression, `${configuration.guestUser}@${ip}:${remoteRegression}`], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
}
const command = [
  "env", "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  "DEVILUDO_GUI_DRIVER=/usr/local/bin/deviludo-gui-driver",
  `DEVILUDO_GAMEPAD_DRIVER=${configuration.gamepadAvailable === true ? "/usr/local/bin/deviludo-gamepad-driver" : ""}`,
  "DEVILUDO_GUEST_EVIDENCE_ROOT=/Users/Shared",
  "DEVILUDO_GUEST_JOB_ROOT=/Users/Shared",
  "DEVILUDO_E2E_STREAM_PROTOCOL=1",
  `DEVILUDO_E2E_PROJECT_ID=${process.env.DEVILUDO_E2E_PROJECT_ID ?? jobId}`,
  `DEVILUDO_E2E_FROZEN_TIMEOUT_SECONDS=${process.env.DEVILUDO_E2E_FROZEN_TIMEOUT_SECONDS ?? ""}`,
  `DEVILUDO_E2E_CONTRACT_DIGEST=${process.env.DEVILUDO_E2E_CONTRACT_DIGEST ?? ""}`,
  "/usr/local/bin/node", "/usr/local/lib/deviludo/executors/godot-window-e2e-guest.mjs",
  action, remoteArtifact, "--job-id", jobId, "--test-plan", remoteTestPlan, "--json",
  ...(remoteRegression ? ["--regression", remoteRegression] : []),
];
// A Test Agent decision is allowed up to 160 seconds end-to-end. The SSH
// transport watchdog must therefore stay strictly outside that window: while
// this relay is awaiting its parent response it cannot consume guest heartbeat
// frames, so a shorter idle deadline would kill a healthy guest mid-decision.
const policyResponseTimeoutMs = 490_000;
const protocolIdleTimeoutMs = policyResponseTimeoutMs + 10_000;
// This runner is already launched as its own process group by the framed job
// executor. Keep ssh in that group instead of creating a nested group: if the
// executor has to force-kill the runner, the transport must die with it.
const remoteKillProcessGroup = false;
const remote = spawn("ssh", [...ssh, `${configuration.guestUser}@${ip}`, ...command], {
  stdio: ["pipe", "pipe", "pipe"], shell: false, detached: false,
});
const stopForwardingTermination = forwardTerminationSignals(remote, remoteKillProcessGroup);
const stopClosingRemotePipes = closeChildPipesAfterExit(remote);
const protocolWatchdog = startChildProtocolWatchdog(remote, {
  idleMs: protocolIdleTimeoutMs,
  checkMs: 1_000,
  terminateGraceMs: 2_000,
  killProcessGroup: remoteKillProcessGroup,
});
const remoteStderrChunks = [];
const remoteStderrLimit = 64 * 1024;
let remoteStderrBytes = 0;
remote.stderr.on("data", chunk => {
  if (remoteStderrBytes >= remoteStderrLimit) return;
  const remaining = remoteStderrLimit - remoteStderrBytes;
  const captured = Buffer.from(chunk).subarray(0, remaining);
  remoteStderrChunks.push(captured);
  remoteStderrBytes += captured.length;
});
const frozenTimeoutSeconds = Number(process.env.DEVILUDO_E2E_FROZEN_TIMEOUT_SECONDS);
if (!Number.isSafeInteger(frozenTimeoutSeconds) || frozenTimeoutSeconds < 1800 || frozenTimeoutSeconds > 5400) {
  terminateChildProcess(remote, "SIGKILL", remoteKillProcessGroup);
  throw new Error("Local Tart guest hard timeout is invalid");
}
const remoteClosed = waitForChildWithHardTimeout(remote, {
  timeoutMs: frozenTimeoutSeconds * 1_000 + 60_000,
  terminateGraceMs: 2_000,
  killProcessGroup: remoteKillProcessGroup,
});
void remoteClosed.catch(() => undefined);
const parentInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
const parentLines = parentInput[Symbol.asyncIterator]();
const remoteLines = createInterface({ input: remote.stdout, crlfDelay: Infinity });
let receipt = null;
try {
  for await (const line of remoteLines) {
    protocolWatchdog.touch();
    const message = JSON.parse(line);
    if (message?.type === "policy_request" && typeof message.id === "string") {
      process.stdout.write(`${JSON.stringify(message)}\n`);
      const next = await readProtocolLineWithTimeout(parentLines, remoteClosed, policyResponseTimeoutMs);
      if (next.done) throw new Error("Player policy relay closed before responding");
      const response = JSON.parse(next.value);
      if (response?.type !== "policy_response" || response.id !== message.id) throw new Error("Player policy relay response is invalid");
      remote.stdin.write(`${JSON.stringify(response)}\n`);
    } else if (message?.type === "result" && message.value && typeof message.value === "object") {
      receipt = message.value;
      break;
    }
  }
  const remoteSettlement = receipt
    ? await settleChildAfterProtocolResult(remote, remoteClosed, { graceMs: 500, killProcessGroup: remoteKillProcessGroup })
    : { result: await remoteClosed, transportTerminated: false };
  const remoteExit = remoteSettlement.result;
  if (remoteExit.timedOut) throw new Error("Tart guest exceeded its frozen E2E hard deadline and was terminated");
  if ((!remoteSettlement.transportTerminated && remoteExit.code !== 0) || !receipt) {
    const remoteError = Buffer.concat(remoteStderrChunks)
      .toString("utf8")
      .replace(/[\r\n\t ]+/g, " ")
      .trim()
      .slice(0, 4_000);
    const reason = protocolWatchdog.expired()
      ? "Tart guest protocol stream became idle and was terminated"
      : "Tart guest runner failed or omitted its result";
    throw new Error(`${reason}${remoteError ? `: ${remoteError}` : ""}`);
  }
  if (action === "test") {
    if (!isAbsolute(hostOutput) || typeof receipt.outputPath !== "string" || !receipt.outputPath.startsWith("/Users/Shared/")) throw new Error("Tart guest evidence path is invalid");
    await execute("scp", [...ssh, `${configuration.guestUser}@${ip}:${receipt.outputPath}`, hostOutput], { timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 });
    receipt.outputPath = hostOutput;
    if (typeof receipt.regressionOutputPath === "string") {
      if (!isAbsolute(hostRegressionOutput) || !receipt.regressionOutputPath.startsWith("/Users/Shared/")) throw new Error("Tart guest regression path is invalid");
      await execute("scp", [...ssh, `${configuration.guestUser}@${ip}:${receipt.regressionOutputPath}`, hostRegressionOutput], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
      receipt.regressionOutputPath = hostRegressionOutput;
    }
  }
  process.stdout.write(`${JSON.stringify({ type: "result", value: receipt })}\n`);
} finally {
  protocolWatchdog.stop();
  stopClosingRemotePipes();
  stopForwardingTermination();
  remoteLines.close();
  closeLineInput(parentInput, process.stdin);
  remote.stdin.end();
  terminateChildProcess(remote, "SIGKILL", remoteKillProcessGroup);
}
