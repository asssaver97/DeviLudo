import { execFile } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = resolve(root, ".deviludo/local");
const pidFile = resolve(runtimeDirectory, "e2e-macos.pid");
const logFile = resolve(runtimeDirectory, "e2e-macos.log");
const entrypoint = "scripts/local-macos-e2e.mjs";

export async function startLocalE2e() {
  const current = await runningPid();
  if (current) return current;
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  const output = openSync(logFile, "a", 0o600);
  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
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
    return false;
  }
  const identity = await processIdentity(pid);
  if (identity !== "match") {
    throw new Error(`Refusing to stop PID ${pid}: local E2E process identity could not be verified`);
  }
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    if (await processIdentity(pid) === "missing") {
      removePidFile();
      return true;
    }
  }
  throw new Error(`macOS E2E node ${pid} did not stop after SIGTERM`);
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
