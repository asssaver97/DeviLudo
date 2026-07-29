#!/usr/bin/env node

import { constants as osSignals } from "node:os";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installLocalSidecarSession } from "./sidecar-credentials.mjs";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_LOCAL_RUNTIME_PORT = 4311;
const DEFAULT_LOCAL_AGENT_RUNTIME_PORT = 4312;
const DEFAULT_LOCAL_SPEC_RUNTIME_PORT = 4313;
const DEFAULT_LOCAL_INFERENCE_GATEWAY_PORT = 4314;
const DEFAULT_LOCAL_GITHUB_RUNTIME_PORT = 4315;
const DEFAULT_LOCAL_CLAUDE_VERSION = "2.1.201";
const DEFAULT_LOCAL_CODEX_VERSION = "0.146.0-alpha.3.1";
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
  DEVILUDO_LOCAL_INFERENCE_GATEWAY_PORT  Internal loopback inference Gateway port (default: ${DEFAULT_LOCAL_INFERENCE_GATEWAY_PORT})
  DEVILUDO_LOCAL_GITHUB_IMPORT  Set to 1 to enable real GitHub App import
  DEVILUDO_LOCAL_GITHUB_RUNTIME_PORT  Local GitHub sidecar port (default: ${DEFAULT_LOCAL_GITHUB_RUNTIME_PORT})
  DEVILUDO_LOCAL_GITHUB_CONFIG_FILE  Non-secret config path (default: .deviludo/github-app.json)
  DEVILUDO_LOCAL_CLAUDE_EXPECTED_VERSION  Exact trusted Claude Code version (default: ${DEFAULT_LOCAL_CLAUDE_VERSION})
  DEVILUDO_LOCAL_CODEX_EXPECTED_VERSION  Exact trusted Codex CLI version (default: ${DEFAULT_LOCAL_CODEX_VERSION})
  DEVILUDO_LOCAL_SUPERVISOR_PID  Optional parent PID; core shuts down if that launcher exits
  DEVILUDO_LOCAL_SPEC_STATE_FILE  Absolute durable specification state file (default: .deviludo/local-spec-state.json)
  DEVILUDO_GODOT_BINARY        Absolute path to the Godot 4 executable
  DEVILUDO_GODOT_EXPORT_TEMPLATES_ROOT  Verified export_templates root`);
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

function parseExactAgentVersion(name, fallback) {
  const value = process.env[name]?.trim() || fallback;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) || /latest|stable|default/i.test(value)) {
    throw new Error(`${name} must be an exact non-floating version`);
  }
  return value;
}

function parseOptionalSupervisorPid(value) {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) throw new Error("DEVILUDO_LOCAL_SUPERVISOR_PID must be an exact process ID");
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("DEVILUDO_LOCAL_SUPERVISOR_PID is invalid");
  return pid;
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
let localInferenceGatewayPort;
let localGitHubRuntimePort;
let localClaudeVersion;
let localCodexVersion;
let localSupervisorPid;
let localGitHubConfig;
const localGitHubImport = process.env.DEVILUDO_LOCAL_GITHUB_IMPORT === "1";
try {
  port = parsePort(process.argv.slice(2));
  if (port !== null) {
    localRuntimePort = parseEnvironmentPort("DEVILUDO_LOCAL_RUNTIME_PORT", DEFAULT_LOCAL_RUNTIME_PORT);
    localAgentRuntimePort = parseEnvironmentPort("DEVILUDO_LOCAL_AGENT_RUNTIME_PORT", DEFAULT_LOCAL_AGENT_RUNTIME_PORT);
    localSpecRuntimePort = parseEnvironmentPort("DEVILUDO_LOCAL_SPEC_RUNTIME_PORT", DEFAULT_LOCAL_SPEC_RUNTIME_PORT);
    localInferenceGatewayPort = parseEnvironmentPort("DEVILUDO_LOCAL_INFERENCE_GATEWAY_PORT", DEFAULT_LOCAL_INFERENCE_GATEWAY_PORT);
    localGitHubRuntimePort = localGitHubImport
      ? parseEnvironmentPort("DEVILUDO_LOCAL_GITHUB_RUNTIME_PORT", DEFAULT_LOCAL_GITHUB_RUNTIME_PORT)
      : undefined;
    localClaudeVersion = parseExactAgentVersion("DEVILUDO_LOCAL_CLAUDE_EXPECTED_VERSION", DEFAULT_LOCAL_CLAUDE_VERSION);
    localCodexVersion = parseExactAgentVersion("DEVILUDO_LOCAL_CODEX_EXPECTED_VERSION", DEFAULT_LOCAL_CODEX_VERSION);
    localSupervisorPid = parseOptionalSupervisorPid(process.env.DEVILUDO_LOCAL_SUPERVISOR_PID);
    const selectedPorts = [port, localRuntimePort, localAgentRuntimePort, localSpecRuntimePort, localInferenceGatewayPort,
      ...(localGitHubRuntimePort === undefined ? [] : [localGitHubRuntimePort])];
    if (new Set(selectedPorts).size !== selectedPorts.length) throw new Error("Web and local sidecar ports must be different");
  }
} catch (error) {
  port = undefined;
  localRuntimePort = undefined;
  localAgentRuntimePort = undefined;
  localSpecRuntimePort = undefined;
  localInferenceGatewayPort = undefined;
  localGitHubRuntimePort = undefined;
  localClaudeVersion = undefined;
  localCodexVersion = undefined;
  localSupervisorPid = undefined;
  fail(error instanceof Error ? error.message : String(error));
  usage();
}

if (port === null || port === undefined || localRuntimePort === undefined || localAgentRuntimePort === undefined
  || localSpecRuntimePort === undefined || localInferenceGatewayPort === undefined
  || localClaudeVersion === undefined || localCodexVersion === undefined) {
  process.exit();
}

const localRuntimeHmacKey = randomBytes(32).toString("base64url");
const localAgentRuntimeHmacKey = randomBytes(32).toString("base64url");
const localSpecRuntimeHmacKey = randomBytes(32).toString("base64url");
const localGitHubRuntimeHmacKey = localGitHubImport ? randomBytes(32).toString("base64url") : undefined;
const localSidecarCredentials = Object.freeze([
  Object.freeze({ file: path.join(workspaceRoot, ".deviludo", "local-runtime.hmac"), key: localRuntimeHmacKey }),
  Object.freeze({ file: path.join(workspaceRoot, ".deviludo", "local-agent-runtime.hmac"), key: localAgentRuntimeHmacKey }),
  Object.freeze({ file: path.join(workspaceRoot, ".deviludo", "local-spec-runtime.hmac"), key: localSpecRuntimeHmacKey }),
  ...(localGitHubRuntimeHmacKey ? [Object.freeze({ file: path.join(workspaceRoot, ".deviludo", "local-github-runtime.hmac"), key: localGitHubRuntimeHmacKey })] : []),
]);
const localDeploymentOwnerFile = path.join(workspaceRoot, ".deviludo", "local-deployment.json");
const localSpecStateFile = process.env.DEVILUDO_LOCAL_SPEC_STATE_FILE
  ? path.resolve(process.env.DEVILUDO_LOCAL_SPEC_STATE_FILE)
  : path.join(workspaceRoot, ".deviludo", "local-spec-state.json");
const localGitHubStateFile = path.join(workspaceRoot, ".deviludo", "local-github-state.json");
const localGitHubConfigFile = process.env.DEVILUDO_LOCAL_GITHUB_CONFIG_FILE
  ? path.resolve(process.env.DEVILUDO_LOCAL_GITHUB_CONFIG_FILE)
  : path.join(workspaceRoot, ".deviludo", "github-app.json");

let removeLocalSidecarKeys = () => {};
let localDeploymentId;

const vinextCli = path.join(workspaceRoot, "node_modules", "vinext", "dist", "cli.js");
const supervisedChildEntry = path.join(workspaceRoot, "scripts", "local", "supervised-child.mjs");
const localRuntimeEntry = path.join(workspaceRoot, "services", "local-runtime", "src", "server.ts");
const localAgentRuntimeEntry = path.join(workspaceRoot, "services", "local-agent-runtime", "src", "server.ts");
const localSpecRuntimeEntry = path.join(workspaceRoot, "services", "local-spec-runtime", "src", "server.ts");
const localGitHubRuntimeEntry = path.join(workspaceRoot, "services", "local-github-runtime", "src", "server.ts");
try {
  await access(vinextCli);
  await access(supervisedChildEntry);
  await access(localRuntimeEntry);
  await access(localAgentRuntimeEntry);
  await access(localSpecRuntimeEntry);
  if (localGitHubImport) {
    await access(localGitHubRuntimeEntry);
    localGitHubConfig = parseLocalGitHubConfig(JSON.parse(await readFile(localGitHubConfigFile, "utf8")));
    await access(localGitHubConfig.clientSecretFile);
    await access(localGitHubConfig.privateKeyFile);
  }
  await assertPortAvailable(port);
  await assertPortAvailable(localRuntimePort);
  await assertPortAvailable(localAgentRuntimePort);
  await assertPortAvailable(localSpecRuntimePort);
  await assertPortAvailable(localInferenceGatewayPort);
  if (localGitHubRuntimePort !== undefined) await assertPortAvailable(localGitHubRuntimePort);
  await mkdir(path.join(workspaceRoot, ".wrangler"), { recursive: true });
  await mkdir(path.join(workspaceRoot, ".deviludo"), { recursive: true, mode: 0o700 });
  const session = await installLocalSidecarSession({
    credentials: localSidecarCredentials,
    ownerFile: localDeploymentOwnerFile,
  });
  removeLocalSidecarKeys = session.cleanup;
  localDeploymentId = session.deploymentId;
} catch (error) {
  removeLocalSidecarKeys();
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
console.log(`[local:dev] Starting the internal inference Gateway at http://${HOST}:${localInferenceGatewayPort}/v1`);
if (localGitHubRuntimePort !== undefined) console.log(`[local:dev] Starting real GitHub App import at http://${HOST}:${localGitHubRuntimePort}`);
console.log("[local:dev] Press Ctrl-C to stop the server and its child processes.");

function supervisedArguments(childArguments) {
  return [
    supervisedChildEntry,
    "--parent-pid", String(process.pid),
    "--owner-file", localDeploymentOwnerFile,
    "--deployment-id", localDeploymentId,
    "--",
    ...childArguments,
  ];
}

const localRuntimeChild = spawn(
  process.execPath,
  supervisedArguments(["--import", "tsx", localRuntimeEntry]),
  {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEVILUDO_LOCAL_TEST_MODE: "1",
      DEVILUDO_LOCAL_RUNTIME_PORT: String(localRuntimePort),
      DEVILUDO_LOCAL_RUNTIME_HMAC_KEY: localRuntimeHmacKey,
      DEVILUDO_LOCAL_AGENT_STORAGE_ROOT: path.join(workspaceRoot, ".deviludo", "local-agent-runtime"),
    },
    stdio: "inherit",
  },
);

const localAgentRuntimeChild = spawn(
  process.execPath,
  supervisedArguments(["--import", "tsx", localAgentRuntimeEntry]),
  {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEVILUDO_LOCAL_TEST_MODE: "1",
      DEVILUDO_LOCAL_AGENT_RUNTIME_PORT: String(localAgentRuntimePort),
      DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY: localAgentRuntimeHmacKey,
      DEVILUDO_LOCAL_CLAUDE_EXPECTED_VERSION: localClaudeVersion,
      DEVILUDO_LOCAL_CODEX_EXPECTED_VERSION: localCodexVersion,
      DEVILUDO_LOCAL_DETERMINISTIC_WORKER_ATTESTATION: "1",
      DEVILUDO_LOCAL_PROVIDER_CONTROL: "1",
      DEVILUDO_LOCAL_AGENT_EXECUTION: "1",
      DEVILUDO_LOCAL_INFERENCE_GATEWAY_URL: `http://${HOST}:${localInferenceGatewayPort}/v1`,
      DEVILUDO_LOCAL_AGENT_STORAGE_ROOT: path.join(workspaceRoot, ".deviludo", "local-agent-runtime"),
      DEVILUDO_LOCAL_AGENT_FIXTURE_ROOT: path.join(workspaceRoot, "fixtures", "godot-smoke"),
    },
    stdio: "inherit",
  },
);

const localSpecRuntimeChild = spawn(
  process.execPath,
  supervisedArguments(["--import", "tsx", localSpecRuntimeEntry]),
  {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEVILUDO_LOCAL_TEST_MODE: "1",
      DEVILUDO_LOCAL_SPEC_RUNTIME_PORT: String(localSpecRuntimePort),
      DEVILUDO_LOCAL_SPEC_RUNTIME_HMAC_KEY: localSpecRuntimeHmacKey,
      DEVILUDO_LOCAL_SPEC_STATE_FILE: localSpecStateFile,
    },
    stdio: "inherit",
  },
);

const localGitHubRuntimeChild = localGitHubRuntimePort === undefined || !localGitHubRuntimeHmacKey ? null : spawn(
  process.execPath,
  supervisedArguments(["--import", "tsx", localGitHubRuntimeEntry]),
  {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEVILUDO_LOCAL_TEST_MODE: "1",
      DEVILUDO_LOCAL_GITHUB_IMPORT: "1",
      DEVILUDO_LOCAL_GITHUB_RUNTIME_PORT: String(localGitHubRuntimePort),
      DEVILUDO_LOCAL_GITHUB_RUNTIME_HMAC_KEY: localGitHubRuntimeHmacKey,
      DEVILUDO_LOCAL_GITHUB_REDIRECT_URI: `http://${HOST}:${port}/api/connections/github/callback`,
      DEVILUDO_LOCAL_GITHUB_STATE_FILE: localGitHubStateFile,
      DEVILUDO_LOCAL_GITHUB_APP_ID: localGitHubConfig.appId,
      DEVILUDO_LOCAL_GITHUB_APP_SLUG: localGitHubConfig.appSlug,
      DEVILUDO_LOCAL_GITHUB_CLIENT_ID: localGitHubConfig.clientId,
      DEVILUDO_LOCAL_GITHUB_USER_ID: String(localGitHubConfig.githubUserId),
      DEVILUDO_LOCAL_GITHUB_CLIENT_SECRET_FILE: localGitHubConfig.clientSecretFile,
      DEVILUDO_LOCAL_GITHUB_PRIVATE_KEY_FILE: localGitHubConfig.privateKeyFile,
    },
    stdio: "inherit",
  },
);

const siteChild = spawn(
  process.execPath,
  supervisedArguments([vinextCli, "dev", "--hostname", HOST, "--port", String(port)]),
  {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEVILUDO_LOCAL_TEST_MODE: "1",
      DEVILUDO_LOCAL_RUNTIME_URL: `http://${HOST}:${localRuntimePort}`,
      DEVILUDO_LOCAL_RUNTIME_HMAC_KEY: localRuntimeHmacKey,
      DEVILUDO_LOCAL_AGENT_RUNTIME_URL: `http://${HOST}:${localAgentRuntimePort}`,
      DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY: localAgentRuntimeHmacKey,
      DEVILUDO_LOCAL_PROVIDER_CONTROL_REQUIRED: "1",
      DEVILUDO_LOCAL_SPEC_RUNTIME_URL: `http://${HOST}:${localSpecRuntimePort}`,
      DEVILUDO_LOCAL_SPEC_RUNTIME_HMAC_KEY: localSpecRuntimeHmacKey,
      ...(localGitHubRuntimePort === undefined || !localGitHubRuntimeHmacKey ? {} : {
        DEVILUDO_LOCAL_GITHUB_IMPORT: "1",
        DEVILUDO_LOCAL_GITHUB_RUNTIME_URL: `http://${HOST}:${localGitHubRuntimePort}`,
        DEVILUDO_LOCAL_GITHUB_RUNTIME_HMAC_KEY: localGitHubRuntimeHmacKey,
      }),
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
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) {
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
  killProcessTree(localGitHubRuntimeChild, signal);
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

const supervisorTimer = localSupervisorPid === undefined ? null : setInterval(() => {
  try { process.kill(localSupervisorPid, 0); }
  catch {
    console.error("[local:dev] Parent launcher exited; stopping the local core.");
    beginShutdown("SIGTERM");
  }
}, 500);
supervisorTimer?.unref();

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

localGitHubRuntimeChild?.once("error", (error) => {
  console.error(`[local:dev] Could not start real GitHub import: ${error.message}`);
  killAll("SIGTERM");
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

localGitHubRuntimeChild?.once("exit", (code, signal) => {
  if (stopping) return;
  console.error(`[local:dev] Real GitHub import exited unexpectedly (${signal ?? code ?? "unknown"}).`);
  killProcessTree(siteChild, "SIGTERM");
  killProcessTree(localRuntimeChild, "SIGTERM");
  killProcessTree(localAgentRuntimeChild, "SIGTERM");
  killProcessTree(localSpecRuntimeChild, "SIGTERM");
  process.exitCode = code ?? 1;
});

siteChild.once("exit", (code, signal) => {
  clearTimeout(forceStopTimer);
  if (supervisorTimer) clearInterval(supervisorTimer);
  killProcessTree(localRuntimeChild, "SIGTERM");
  killProcessTree(localAgentRuntimeChild, "SIGTERM");
  killProcessTree(localSpecRuntimeChild, "SIGTERM");
  killProcessTree(localGitHubRuntimeChild, "SIGTERM");
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
  if (supervisorTimer) clearInterval(supervisorTimer);
  killAll("SIGKILL");
  try { removeLocalSidecarKeys(); }
  catch { console.error("[local:dev] Could not remove a sidecar session key."); }
});

function parseLocalGitHubConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Local GitHub config is invalid");
  const keys = ["appId", "appSlug", "clientId", "clientSecretFile", "githubUserId", "privateKeyFile", "schema"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())
    || value.schema !== "deviludo.local-github-config.v1"
    || typeof value.appId !== "string" || !/^\d{1,20}$/.test(value.appId) || value.appId === "0"
    || typeof value.appSlug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(value.appSlug)
    || typeof value.clientId !== "string" || !/^(?:Iv1\.[A-Za-z0-9]{16,}|Ov23li[A-Za-z0-9]{10,})$/.test(value.clientId)
    || !Number.isSafeInteger(value.githubUserId) || value.githubUserId < 1
    || typeof value.clientSecretFile !== "string" || !path.isAbsolute(value.clientSecretFile) || path.resolve(value.clientSecretFile) !== value.clientSecretFile
    || typeof value.privateKeyFile !== "string" || !path.isAbsolute(value.privateKeyFile) || path.resolve(value.privateKeyFile) !== value.privateKeyFile) {
    throw new Error("Local GitHub config is invalid");
  }
  return Object.freeze({ ...value });
}
