#!/usr/bin/env node

import { constants as osSignals } from "node:os";
import { access, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const FORCE_STOP_AFTER_MS = 5_000;
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

function usage() {
  console.log(`Usage: npm run local:dev -- [--port <port>]

Starts the DeviLudo vinext test site on the loopback interface only.

Options:
  -p, --port <port>  Listening port (default: ${DEFAULT_PORT})
  -h, --help         Show this help

Environment:
  DEVILUDO_LOCAL_PORT  Alternative way to select the port`);
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
try {
  port = parsePort(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  usage();
}

if (port === null || port === undefined) {
  process.exit();
}

const vinextCli = path.join(workspaceRoot, "node_modules", "vinext", "dist", "cli.js");
try {
  await access(vinextCli);
  await assertPortAvailable(port);
  await mkdir(path.join(workspaceRoot, ".wrangler"), { recursive: true });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  if (error?.code === "ENOENT") {
    console.error("[local:dev] Run `npm install` before starting the local site.");
  }
  process.exit();
}

console.log(`[local:dev] Starting DeviLudo at http://${HOST}:${port}`);
console.log("[local:dev] Press Ctrl-C to stop the server and its child processes.");

const child = spawn(
  process.execPath,
  [vinextCli, "dev", "--hostname", HOST, "--port", String(port)],
  {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "development",
      WRANGLER_LOG_PATH: path.join(workspaceRoot, ".wrangler", "wrangler-local.log"),
    },
    stdio: "inherit",
  },
);

let stopping = false;
let requestedSignal;
let forceStopTimer;
let shutdownStartedAt = 0;

function killProcessTree(signal) {
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

function beginShutdown(signal) {
  if (stopping) {
    // npm can forward the same terminal signal immediately after the parent
    // process receives it. Treat only a later signal as an intentional force-stop.
    if (Date.now() - shutdownStartedAt < 500) {
      return;
    }
    console.error("\n[local:dev] Second stop request received; forcing shutdown.");
    killProcessTree("SIGKILL");
    return;
  }

  stopping = true;
  shutdownStartedAt = Date.now();
  requestedSignal = signal;
  console.log(`\n[local:dev] ${signal} received; stopping the local site...`);
  killProcessTree("SIGTERM");
  forceStopTimer = setTimeout(() => {
    console.error(`[local:dev] Server did not stop within ${FORCE_STOP_AFTER_MS / 1_000}s; forcing shutdown.`);
    killProcessTree("SIGKILL");
  }, FORCE_STOP_AFTER_MS);
}

const handledSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of handledSignals) {
  process.on(signal, () => beginShutdown(signal));
}

child.once("error", (error) => {
  console.error(`[local:dev] Could not start vinext: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  clearTimeout(forceStopTimer);
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

process.once("exit", () => killProcessTree("SIGKILL"));
