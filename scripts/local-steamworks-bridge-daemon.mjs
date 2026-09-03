import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { get } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = resolve(root, ".deviludo/local");
const pidFile = resolve(runtime, "steamworks-bridge.pid");
const logFile = resolve(runtime, "steamworks-bridge.log");
const entrypoint = "scripts/local-steamworks-bridge-server.mjs";

export async function startLocalSteamworksBridge(configuration) {
  const current = await runningLocalSteamworksBridgePid();
  if (current) return current;
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const output = openSync(logFile, "a", 0o600);
  const child = spawn(process.execPath, [entrypoint], {
    cwd: root, detached: true, stdio: ["ignore", output, output],
    env: { ...process.env, NODE_ENV: "development", DEVILUDO_STEAMWORKS_BRIDGE_PORT: String(configuration.port), DEVILUDO_STEAMWORKS_BRIDGE_TOKEN: configuration.internalToken },
  });
  closeSync(output);
  if (!child.pid) throw new Error("Failed to start the local Steamworks bridge");
  await import("node:fs/promises").then(fs => fs.writeFile(pidFile, `${child.pid}\n`, { mode: 0o600 }));
  child.unref();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    if (!await runningLocalSteamworksBridgePid()) throw new Error(`Steamworks bridge exited; inspect ${logFile}`);
    if (await healthReady(configuration.port)) return child.pid;
  }
  await stopLocalSteamworksBridge();
  throw new Error(`Steamworks bridge did not become ready; inspect ${logFile}`);
}

export async function stopLocalSteamworksBridge() {
  const pid = await runningLocalSteamworksBridgePid();
  if (!pid) return false;
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    if (!await runningLocalSteamworksBridgePid()) return true;
  }
  process.kill(-pid, "SIGKILL"); removePid(); return true;
}

export async function runningLocalSteamworksBridgePid() {
  let pid;
  try { pid = Number(readFileSync(pidFile, "utf8").trim()); } catch { return null; }
  if (!Number.isSafeInteger(pid) || pid < 2) { removePid(); return null; }
  try {
    const { stdout } = await execute("ps", ["-p", String(pid), "-o", "command="]);
    if (stdout.includes(entrypoint)) return pid;
  } catch { /* missing */ }
  removePid(); return null;
}

function healthReady(port) {
  return new Promise(resolveReady => {
    const request = get({ hostname: "127.0.0.1", port, path: "/health", timeout: 250 }, response => { response.resume(); resolveReady(response.statusCode === 200); });
    request.once("timeout", () => request.destroy()); request.once("error", () => resolveReady(false));
  });
}
function removePid() { try { unlinkSync(pidFile); } catch { /* absent */ } }

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] ?? "status";
  if (action === "stop") console.log(JSON.stringify({ stopped: await stopLocalSteamworksBridge() }));
  else if (action === "status") console.log(JSON.stringify({ running: Boolean(await runningLocalSteamworksBridgePid()) }));
  else throw new Error("Use local-up to start the Steamworks bridge");
}
