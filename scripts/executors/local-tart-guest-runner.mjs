#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
const execute = promisify(execFile);
const action = process.argv[2];
const argument = name => process.argv[process.argv.indexOf(name) + 1] ?? "";
const jobId = argument("--job-id");
const artifact = argument("--artifact");
const regression = argument("--regression");
const hostOutput = process.env.DEVILUDO_E2E_HOST_OUTPUT ?? "";
const hostRegressionOutput = process.env.DEVILUDO_E2E_HOST_REGRESSION_OUTPUT ?? "";
if (!/^[0-9a-f-]{36}$/i.test(jobId) || !isAbsolute(artifact) || action !== "test") throw new Error("Local Tart guest request is invalid");
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
const remoteRegression = regression ? `/Users/Shared/deviludo-regression-${jobId}.json` : "";
if (regression) {
  if (!isAbsolute(regression)) throw new Error("Local regression path must be absolute");
  await execute("scp", [...ssh, regression, `${configuration.guestUser}@${ip}:${remoteRegression}`], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
}
const command = [
  "env", "DEVILUDO_GUI_DRIVER=/usr/local/bin/deviludo-gui-driver",
  "DEVILUDO_GAMEPAD_DRIVER=/usr/local/bin/deviludo-gamepad-driver",
  "DEVILUDO_GUEST_EVIDENCE_ROOT=/Users/Shared",
  "DEVILUDO_GUEST_JOB_ROOT=/Users/Shared",
  "DEVILUDO_E2E_STREAM_PROTOCOL=1",
  `DEVILUDO_E2E_PROJECT_ID=${process.env.DEVILUDO_E2E_PROJECT_ID ?? jobId}`,
  `DEVILUDO_E2E_FROZEN_TIMEOUT_SECONDS=${process.env.DEVILUDO_E2E_FROZEN_TIMEOUT_SECONDS ?? ""}`,
  `DEVILUDO_E2E_CONTRACT_DIGEST=${process.env.DEVILUDO_E2E_CONTRACT_DIGEST ?? ""}`,
  "/usr/local/bin/node", "/usr/local/lib/deviludo/executors/godot-window-e2e-guest.mjs",
  action, remoteArtifact, "--job-id", jobId, "--json",
  ...(remoteRegression ? ["--regression", remoteRegression] : []),
];
const remote = spawn("ssh", [...ssh, `${configuration.guestUser}@${ip}`, ...command], { stdio: ["pipe", "pipe", "pipe"], shell: false });
const remoteClosed = new Promise((resolvePromise, rejectPromise) => {
  remote.once("error", rejectPromise);
  remote.once("close", resolvePromise);
});
const parentLines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
const remoteLines = createInterface({ input: remote.stdout, crlfDelay: Infinity });
let receipt = null;
for await (const line of remoteLines) {
  const message = JSON.parse(line);
  if (message?.type === "policy_request" && typeof message.id === "string") {
    process.stdout.write(`${JSON.stringify(message)}\n`);
    const next = await parentLines.next();
    if (next.done) throw new Error("Player policy relay closed before responding");
    const response = JSON.parse(next.value);
    if (response?.type !== "policy_response" || response.id !== message.id) throw new Error("Player policy relay response is invalid");
    remote.stdin.write(`${JSON.stringify(response)}\n`);
  } else if (message?.type === "result" && message.value && typeof message.value === "object") receipt = message.value;
}
const remoteCode = await remoteClosed;
if (remoteCode !== 0 || !receipt) throw new Error("Tart guest runner failed or omitted its result");
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
