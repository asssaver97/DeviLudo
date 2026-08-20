import { execFile } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { cleanupLocalTartOrphans } from "./local-tart-orphans.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = resolve(root, ".deviludo/local");
const pidFile = resolve(runtimeDirectory, "e2e-macos.pid");
const logFile = resolve(runtimeDirectory, "e2e-macos.log");
const entrypoint = "scripts/local-macos-e2e.mjs";
const guestRunnerPath = resolve(root, "scripts/executors/local-tart-guest-runner.mjs");

export async function startLocalE2e({ refresh = false } = {}) {
  const current = await runningPid();
  if (current) return current;
  await stopManagedGuestRunners();
  await cleanupLocalTartOrphans();
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  const output = openSync(logFile, "a", 0o600);
  const arguments_ = ["--import", "tsx", entrypoint];
  if (refresh) arguments_.push("--refresh-e2e-vm");
  const child = spawn(process.execPath, arguments_, {
    cwd: root,
    detached: true,
    stdio: ["ignore", output, output],
    env: { ...process.env, NODE_ENV: "development" },
  });
  closeSync(output);
  if (!child.pid) throw new Error("Failed to start the local macOS E2E node");
  writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
  child.unref();
  await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  const started = await runningPid();
  if (!started) throw new Error(`macOS E2E node exited during startup; inspect ${logFile}`);
  return started;
}

export async function stopLocalE2e() {
  const pid = await runningPid();
  if (!pid) {
    removePidFile();
    const guestRunners = await stopManagedGuestRunners();
    const virtualMachines = await cleanupLocalTartOrphans();
    return guestRunners > 0 || virtualMachines.length > 0;
  }
  const identity = await processIdentity(pid);
  if (identity !== "match") {
    throw new Error(`Refusing to stop PID ${pid}: local E2E process identity could not be verified`);
  }
  process.kill(pid, "SIGTERM");
  let stopped = await waitForProcessExit(pid, 120_000);
  if (!stopped) {
    signalProcessGroup(pid, "SIGKILL");
    stopped = await waitForProcessExit(pid, 5_000);
  }
  if (stopped) removePidFile();
  await stopManagedGuestRunners();
  await cleanupLocalTartOrphans();
  if (!stopped) throw new Error(`macOS E2E node ${pid} did not stop after SIGKILL`);
  return true;
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await processIdentity(pid) === "missing") return true;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  return await processIdentity(pid) === "missing";
}

async function stopManagedGuestRunners() {
  const { stdout } = await execute("ps", ["-ax", "-o", "pid=,ppid=,command="]);
  const pids = parseManagedGuestRunnerPids(stdout);
  for (const pid of pids) signalProcess(pid, "SIGTERM");
  for (let attempt = 0; attempt < 30 && (await matchingGuestRunners(pids)).length; attempt += 1) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  const survivors = await matchingGuestRunners(pids);
  for (const pid of survivors) signalProcess(pid, "SIGKILL");
  if (survivors.length) await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  const remaining = await matchingGuestRunners(survivors);
  if (remaining.length) throw new Error(`Local E2E guest runners did not stop: ${remaining.join(", ")}`);
  return pids.length;
}

export function parseManagedGuestRunnerPids(output) {
  const marker = ` ${guestRunnerPath} test `;
  return output.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+\d+\s+(.+)$/);
    return match && match[2].includes(marker) ? [Number(match[1])] : [];
  }).filter(pid => Number.isSafeInteger(pid) && pid > 1);
}

async function matchingGuestRunners(pids) {
  const matches = [];
  for (const pid of pids) {
    try {
      const { stdout } = await execute("ps", ["-p", String(pid), "-o", "command="]);
      if (stdout.includes(` ${guestRunnerPath} test `)) matches.push(pid);
    } catch { /* The process has already exited. */ }
  }
  return matches;
}

function signalProcess(pid, signal) {
  try { process.kill(pid, signal); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

function signalProcessGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") signalProcess(pid, signal);
  }
}

export async function runningPid() {
  let pid;
  try {
    pid = Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(pid) || pid < 2) {
    removePidFile();
    return null;
  }
  const identity = await processIdentity(pid);
  if (identity === "missing" || identity === "mismatch") {
    removePidFile();
    return null;
  }
  return pid;
}

async function processIdentity(pid) {
  try {
    const { stdout } = await execute("ps", ["-p", String(pid), "-o", "command="]);
    return stdout.includes(entrypoint) ? "match" : stdout.trim() ? "mismatch" : "missing";
  } catch {
    try {
      process.kill(pid, 0);
      return "unknown";
    } catch (error) {
      return error && typeof error === "object" && "code" in error && error.code === "ESRCH"
        ? "missing"
        : "unknown";
    }
  }
}

function removePidFile() {
  try { unlinkSync(pidFile); } catch { /* already absent */ }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] ?? "status";
  if (action === "start") console.log(JSON.stringify({ running: true, pid: await startLocalE2e() }));
  else if (action === "stop") console.log(JSON.stringify({ stopped: await stopLocalE2e() }));
  else if (action === "status") console.log(JSON.stringify({ running: Boolean(await runningPid()), pid: await runningPid() }));
  else throw new Error("Usage: local-e2e-daemon.mjs start|stop|status");
}
