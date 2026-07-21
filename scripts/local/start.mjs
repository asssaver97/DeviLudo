#!/usr/bin/env node

import { constants as osSignals } from "node:os";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_LOCAL_RUNTIME_PORT = 4311;
const DEFAULT_LOCAL_AGENT_RUNTIME_PORT = 4312;
const DEFAULT_LOCAL_SPEC_RUNTIME_PORT = 4313;
const FORCE_STOP_AFTER_MS = 5_000;
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

function usage() {
  console.log(`Usage: npm run local:dev -- [--port <port>]

Starts the DeviLudo vinext test site on the loopback interface only.

Options:
  -p, --port <port>  Listening port (default: ${DEFAULT_PORT})
  -h, --help         Show this help

Environment:
  DEVILUDO_LOCAL_PORT          Alternative way to select the Web port
  DEVILUDO_LOCAL_RUNTIME_PORT  Local Godot sidecar port (default: ${DEFAULT_LOCAL_RUNTIME_PORT})
  DEVILUDO_LOCAL_AGENT_RUNTIME_PORT  Local Agent readiness port (default: ${DEFAULT_LOCAL_AGENT_RUNTIME_PORT})
  DEVILUDO_LOCAL_SPEC_RUNTIME_PORT  Local specification dialogue port (default: ${DEFAULT_LOCAL_SPEC_RUNTIME_PORT})
  DEVILUDO_GODOT_BINARY        Absolute path to the Godot 4 executable`);
}

function fail(message) {
  console.error(`[local:dev] ${message}`);
  process.exitCode = 1;
}

function parsePort(argv) {
  let rawPort = process.env.DEVILUDO_LOCAL_PORT ?? String(DEFAULT_PORT);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      usage();
      return null;
    }

    if (argument === "--port" || argument === "-p") {
      rawPort = argv[index + 1];
      index += 1;
      if (rawPort === undefined) {
        throw new Error(`${argument} requires a value`);
      }
      continue;
    }

    if (argument.startsWith("--port=")) {
      rawPort = argument.slice("--port=".length);
      continue;
    }

    throw new Error(`unknown option: ${argument}`);
  }

  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`invalid port: ${rawPort}`);
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`port must be an integer between 1 and 65535: ${rawPort}`);
  }

  return port;
}

function parseEnvironmentPort(name, fallback) {
  const rawPort = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(rawPort)) throw new Error(`${name} is not a valid port: ${rawPort}`);
  const value = Number(rawPort);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535: ${rawPort}`);
  }
  return value;
}

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`http://${HOST}:${port} is already in use`));
        return;
      }
      reject(error);
    });
    probe.listen({ host: HOST, port, exclusive: true }, () => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

function signalExitCode(signal) {
  const signalNumber = osSignals.signals[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

let port;
let localRuntimePort;
let localAgentRuntimePort;
let localSpecRuntimePort;
try {
  port = parsePort(process.argv.slice(2));
  if (port !== null) {
    localRuntimePort = parseEnvironmentPort("DEVILUDO_LOCAL_RUNTIME_PORT", DEFAULT_LOCAL_RUNTIME_PORT);
    localAgentRuntimePort = parseEnvironmentPort("DEVILUDO_LOCAL_AGENT_RUNTIME_PORT", DEFAULT_LOCAL_AGENT_RUNTIME_PORT);
    localSpecRuntimePort = parseEnvironmentPort("DEVILUDO_LOCAL_SPEC_RUNTIME_PORT", DEFAULT_LOCAL_SPEC_RUNTIME_PORT);
    if (new Set([port, localRuntimePort, localAgentRuntimePort, localSpecRuntimePort]).size !== 4) throw new Error("Web and local sidecar ports must be different");
  }
} catch (error) {
  port = undefined;
  localRuntimePort = undefined;
  localAgentRuntimePort = undefined;
  localSpecRuntimePort = undefined;
  fail(error instanceof Error ? error.message : String(error));
  usage();
}

if (port === null || port === undefined || localRuntimePort === undefined || localAgentRuntimePort === undefined || localSpecRuntimePort === undefined) {
  process.exit();
}

const localAgentRuntimeHmacKey = randomBytes(32).toString("base64url");
const localAgentRuntimeHmacKeyFile = path.join(workspaceRoot, ".deviludo", "local-agent-runtime.hmac");
const vinextCli = path.join(workspaceRoot, "node_modules", "vinext", "dist", "cli.js");
const localRuntimeEntry = path.join(workspaceRoot, "services", "local-runtime", "src", "server.ts");
const localAgentRuntimeEntry = path.join(workspaceRoot, "services", "local-agent-runtime", "src", "server.ts");
const localSpecRuntimeEntry = path.join(workspaceRoot, "services", "local-spec-runtime", "src", "server.ts");
try {
  await access(vinextCli);
  await access(localRuntimeEntry);
  await access(localAgentRuntimeEntry);
  await access(localSpecRuntimeEntry);
  await assertPortAvailable(port);
  await assertPortAvailable(localRuntimePort);
  await assertPortAvailable(localAgentRuntimePort);
  await assertPortAvailable(localSpecRuntimePort);
  await mkdir(path.join(workspaceRoot, ".wrangler"), { recursive: true });
  await mkdir(path.dirname(localAgentRuntimeHmacKeyFile), { recursive: true, mode: 0o700 });
  await writeFile(localAgentRuntimeHmacKeyFile, `${localAgentRuntimeHmacKey}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(localAgentRuntimeHmacKeyFile, 0o600);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  if (error?.code === "ENOENT") {
    console.error("[local:dev] Run `npm install` before starting the local site.");
  }
  process.exit();
}

console.log(`[local:dev] Starting DeviLudo at http://${HOST}:${port}`);
console.log(`[local:dev] Starting the constrained local runtime at http://${HOST}:${localRuntimePort}`);
console.log(`[local:dev] Starting Agent readiness at http://${HOST}:${localAgentRuntimePort}`);
console.log(`[local:dev] Starting specification dialogue at http://${HOST}:${localSpecRuntimePort}`);
console.log("[local:dev] Press Ctrl-C to stop the server and its child processes.");

const localRuntimeChild = spawn(
  process.execPath,
  ["--import", "tsx", localRuntimeEntry],
  {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEVILUDO_LOCAL_TEST_MODE: "1",
      DEVILUDO_LOCAL_RUNTIME_PORT: String(localRuntimePort),
    },
    stdio: "inherit",
  },
);

const localAgentRuntimeChild = spawn(
  process.execPath,
  ["--import", "tsx", localAgentRuntimeEntry],
  {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEVILUDO_LOCAL_TEST_MODE: "1",
      DEVILUDO_LOCAL_AGENT_RUNTIME_PORT: String(localAgentRuntimePort),
      DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY: localAgentRuntimeHmacKey,
    },
    stdio: "inherit",
  },
);

const localSpecRuntimeChild = spawn(
  process.execPath,
  ["--import", "tsx", localSpecRuntimeEntry],
  {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEVILUDO_LOCAL_TEST_MODE: "1",
      DEVILUDO_LOCAL_SPEC_RUNTIME_PORT: String(localSpecRuntimePort),
    },
    stdio: "inherit",
  },
);

const siteChild = spawn(
  process.execPath,
  [vinextCli, "dev", "--hostname", HOST, "--port", String(port)],
  {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEVILUDO_LOCAL_TEST_MODE: "1",
      DEVILUDO_LOCAL_RUNTIME_URL: `http://${HOST}:${localRuntimePort}`,
      DEVILUDO_LOCAL_AGENT_RUNTIME_URL: `http://${HOST}:${localAgentRuntimePort}`,
      DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY: localAgentRuntimeHmacKey,
      DEVILUDO_LOCAL_SPEC_RUNTIME_URL: `http://${HOST}:${localSpecRuntimePort}`,
      WRANGLER_LOG_PATH: path.join(workspaceRoot, ".wrangler", "wrangler-local.log"),
    },
    stdio: "inherit",
  },
);

let stopping = false;
let requestedSignal;
let forceStopTimer;
let shutdownStartedAt = 0;

function killProcessTree(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", signal === "SIGKILL" ? "/F" : ""].filter(Boolean), {
        stdio: "ignore",
      });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") {
      console.error(`[local:dev] Failed to stop child processes: ${error.message}`);
    }
  }
}

function killAll(signal) {
  killProcessTree(siteChild, signal);
  killProcessTree(localRuntimeChild, signal);
  killProcessTree(localAgentRuntimeChild, signal);
  killProcessTree(localSpecRuntimeChild, signal);
}

function beginShutdown(signal) {
  if (stopping) {
    // npm can forward the same terminal signal immediately after the parent
    // process receives it. Treat only a later signal as an intentional force-stop.
    if (Date.now() - shutdownStartedAt < 500) {
      return;
    }
    console.error("\n[local:dev] Second stop request received; forcing shutdown.");
    killAll("SIGKILL");
    return;
  }

  stopping = true;
  shutdownStartedAt = Date.now();
  requestedSignal = signal;
  console.log(`\n[local:dev] ${signal} received; stopping the local site...`);
  killAll("SIGTERM");
  forceStopTimer = setTimeout(() => {
    console.error(`[local:dev] Server did not stop within ${FORCE_STOP_AFTER_MS / 1_000}s; forcing shutdown.`);
    killAll("SIGKILL");
  }, FORCE_STOP_AFTER_MS);
}

const handledSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of handledSignals) {
  process.on(signal, () => beginShutdown(signal));
}

siteChild.once("error", (error) => {
  console.error(`[local:dev] Could not start vinext: ${error.message}`);
  process.exitCode = 1;
});

localRuntimeChild.once("error", (error) => {
  console.error(`[local:dev] Could not start the local runtime: ${error.message}`);
  killProcessTree(siteChild, "SIGTERM");
  process.exitCode = 1;
});

localAgentRuntimeChild.once("error", (error) => {
  console.error(`[local:dev] Could not start Agent readiness: ${error.message}`);
  killProcessTree(siteChild, "SIGTERM");
  killProcessTree(localRuntimeChild, "SIGTERM");
  process.exitCode = 1;
});

localSpecRuntimeChild.once("error", (error) => {
  console.error(`[local:dev] Could not start specification dialogue: ${error.message}`);
  killProcessTree(siteChild, "SIGTERM");
  killProcessTree(localRuntimeChild, "SIGTERM");
  killProcessTree(localAgentRuntimeChild, "SIGTERM");
  process.exitCode = 1;
});

localRuntimeChild.once("exit", (code, signal) => {
  if (stopping) return;
  console.error(`[local:dev] Local runtime exited unexpectedly (${signal ?? code ?? "unknown"}).`);
  killProcessTree(siteChild, "SIGTERM");
  killProcessTree(localAgentRuntimeChild, "SIGTERM");
  killProcessTree(localSpecRuntimeChild, "SIGTERM");
  process.exitCode = code ?? 1;
});

localAgentRuntimeChild.once("exit", (code, signal) => {
  if (stopping) return;
  console.error(`[local:dev] Agent readiness exited unexpectedly (${signal ?? code ?? "unknown"}).`);
  killProcessTree(siteChild, "SIGTERM");
  killProcessTree(localRuntimeChild, "SIGTERM");
  killProcessTree(localSpecRuntimeChild, "SIGTERM");
  process.exitCode = code ?? 1;
});

localSpecRuntimeChild.once("exit", (code, signal) => {
  if (stopping) return;
  console.error(`[local:dev] Specification dialogue exited unexpectedly (${signal ?? code ?? "unknown"}).`);
  killProcessTree(siteChild, "SIGTERM");
  killProcessTree(localRuntimeChild, "SIGTERM");
  killProcessTree(localAgentRuntimeChild, "SIGTERM");
  process.exitCode = code ?? 1;
});

siteChild.once("exit", (code, signal) => {
  clearTimeout(forceStopTimer);
  killProcessTree(localRuntimeChild, "SIGTERM");
  killProcessTree(localAgentRuntimeChild, "SIGTERM");
  killProcessTree(localSpecRuntimeChild, "SIGTERM");
  for (const handledSignal of handledSignals) {
    process.removeAllListeners(handledSignal);
  }

  if (requestedSignal) {
    process.exitCode = signalExitCode(requestedSignal);
    console.log("[local:dev] Local site stopped.");
    return;
  }

  if (signal) {
    console.error(`[local:dev] vinext exited after ${signal}.`);
    process.exitCode = signalExitCode(signal);
    return;
  }

  process.exitCode = code ?? 1;
});

process.once("exit", () => {
  killAll("SIGKILL");
  try { unlinkSync(localAgentRuntimeHmacKeyFile); }
  catch (error) { if (error?.code !== "ENOENT") console.error("[local:dev] Could not remove the Agent sidecar key."); }
});
