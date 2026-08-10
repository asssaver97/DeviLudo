import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = resolve(root, ".deviludo/local");
const pidFile = resolve(runtimeDirectory, "git-import.pid");
const logFile = resolve(runtimeDirectory, "git-import.log");
const entrypoint = "scripts/local-git-import-server.mjs";

export async function startLocalGitImport() {
  const current = await runningGitImportPid();
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
  if (!child.pid) throw new Error("Failed to start the local Git import bridge");
  writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
  child.unref();
  const { port } = JSON.parse(readFileSync(resolve(runtimeDirectory, "git-import.json"), "utf8"));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    const started = await runningGitImportPid();
    if (!started) throw new Error(`Local Git import bridge exited during startup; inspect ${logFile}`);
    if (await healthReady(port)) return started;
  }
  process.kill(child.pid, "SIGTERM");
  removePidFile();
  throw new Error(`Local Git import bridge did not become ready; inspect ${logFile}`);
}

export async function stopLocalGitImport() {
  const pid = await runningGitImportPid();
  if (!pid) {
    removePidFile();
    return false;
  }
  const identity = await processIdentity(pid);
  if (identity !== "match") throw new Error(`Refusing to stop PID ${pid}: local Git import process identity could not be verified`);
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    if (await processIdentity(pid) === "missing") {
      removePidFile();
      return true;
    }
  }
  throw new Error(`Local Git import bridge ${pid} did not stop after SIGTERM`);
}

export async function runningGitImportPid() {
  let pid;
  try { pid = Number(readFileSync(pidFile, "utf8").trim()); } catch { return null; }
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
      return error && typeof error === "object" && "code" in error && error.code === "ESRCH" ? "missing" : "unknown";
    }
  }
}

function healthReady(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return Promise.resolve(false);
  return new Promise(resolveReady => {
    const request = get({ hostname: "127.0.0.1", port, path: "/health", timeout: 250 }, response => {
      response.resume();
      resolveReady(response.statusCode === 200);
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolveReady(false));
  });
}

function removePidFile() {
  try { unlinkSync(pidFile); } catch { /* already absent */ }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] ?? "status";
  if (action === "start") console.log(JSON.stringify({ running: true, pid: await startLocalGitImport() }));
  else if (action === "stop") console.log(JSON.stringify({ stopped: await stopLocalGitImport() }));
  else if (action === "status") console.log(JSON.stringify({ running: Boolean(await runningGitImportPid()), pid: await runningGitImportPid() }));
  else throw new Error("Usage: local-git-import-daemon.mjs start|stop|status");
}
