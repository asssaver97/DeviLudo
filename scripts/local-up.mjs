import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = new URL("..", import.meta.url);
const ciMode = process.env.DEVILUDO_LOCAL_CI === "1";
const webPort = process.env.DEVILUDO_WEB_HOST_PORT?.trim() || "3100";
if (!/^\d+$/.test(webPort) || Number(webPort) < 1 || Number(webPort) > 65535) {
  throw new Error("DEVILUDO_WEB_HOST_PORT must be a valid TCP port");
}
if (webPort === "3000") {
  throw new Error("Port 3000 is reserved; choose another DEVILUDO_WEB_HOST_PORT");
}
const [claudeVersion, codexVersion] = await Promise.all([
  detectLocalRuntime("claude"),
  detectLocalRuntime("codex"),
]);
await requireCommand("docker", ["version", "--format", "{{.Server.Version}}"]);
await requireCommand("docker", ["compose", "version"]);
if (!ciMode) await requireGodot();
if (!ciMode) {
  const { stopLocalE2e } = await import("./local-e2e-daemon.mjs");
  await stopLocalE2e();
}
const baseEnvironment = {
  ...process.env,
  DEVILUDO_WEB_HOST_PORT: webPort,
};
await execute("docker", [
  "compose", "-f", "infra/docker-compose.yml", "up", "-d", "--wait", "postgres",
], { cwd: root, env: baseEnvironment, maxBuffer: 10 * 1024 * 1024 });
const retainedJobRuntimeImages = await retainActiveJobRuntimeImages(baseEnvironment);
await execute("docker", [
  "compose", "-f", "infra/docker-compose.yml", "stop",
  "web", "core-api", "core-scheduler", "core-sandbox", "sandbox-executord",
], { cwd: root, env: baseEnvironment, maxBuffer: 2 * 1024 * 1024 });
await import("./local-identity.mjs");
await execute("docker", ["compose", "-f", "infra/docker-compose.yml", "--profile", "images", "build",
  "agent-claude-image", "agent-codex-image", "godot-builder-image", "steam-publisher-image", "e2e-macos-image",
  "agent-fixture-image", "sandbox-executor-init", "provider-proxy", "core-api", "web"], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
const imageIds = await Promise.all([
  "deviludo-agent-claude:local", "deviludo-agent-codex:local", "deviludo-godot-builder:local",
  "deviludo-steam-publisher:local", "deviludo-e2e-macos:local", "deviludo-agent-fixture:local",
].map(async image => (await execute("docker", ["image", "inspect", "--format", "{{.Id}}", image])).stdout.trim()));
const runtimeImages = JSON.stringify(Object.fromEntries([
  "AGENT_CLAUDE", "AGENT_CODEX", "GODOT_BUILDER", "STEAM_PUBLISHER", "E2E_MACOS",
].map((key, index) => [key, imageIds[index]])));
const dockerSocketGid = await resolveDockerSocketGid();
const environment = {
  ...baseEnvironment,
  DEVILUDO_AGENT_RUNTIME_DETECTION_SCOPE: "LOCAL_HOST",
  DEVILUDO_CLAUDE_CODE_VERSION: claudeVersion ?? "NOT_INSTALLED",
  DEVILUDO_CODEX_CLI_VERSION: codexVersion ?? "NOT_INSTALLED",
  DEVILUDO_EXECUTOR_ALLOWED_IMAGES: [...new Set([...imageIds, ...retainedJobRuntimeImages])].join(","),
  DEVILUDO_EXECUTOR_FIXTURE_AGENT_IMAGE: imageIds[5],
  DEVILUDO_DOCKER_GID: dockerSocketGid,
  DEVILUDO_RUNTIME_IMAGES_JSON: runtimeImages,
};
await execute("docker", [
  "compose", "-f", "infra/docker-compose.yml", "--profile", "init", "run", "--rm", "migrate",
], { cwd: root, env: environment, maxBuffer: 2 * 1024 * 1024 });
const bootstrap = await execute("docker", [
  "compose", "-f", "infra/docker-compose.yml", "--profile", "init", "run", "--rm",
  "-e", "DEVILUDO_RUNTIME_IMAGES_JSON", "bootstrap-instance",
], { cwd: root, env: environment, maxBuffer: 2 * 1024 * 1024 });
const initialized = JSON.parse(bootstrap.stdout);
await execute("docker", [
  "compose",
  "-f", "infra/docker-compose.yml",
  "up",
  "-d",
  "--wait",
], { cwd: root, env: environment, maxBuffer: 10 * 1024 * 1024 });
let e2ePid = null;
if (!ciMode) {
  if (!initialized.macNodeId) throw new Error("Local macOS E2E node initialization failed");
  await writeFile(new URL("../.deviludo/local/e2e-macos.json", import.meta.url), JSON.stringify({
    nodeId: initialized.macNodeId,
    poolKind: "E2E_MACOS",
    coreUrl: process.env.DEVILUDO_CORE_API_URL ?? "http://127.0.0.1:8080",
    token: process.env.DEVILUDO_E2E_NODE_TOKEN ?? "local-e2e-node-token",
    identityKeyFile: new URL("../.deviludo/local/e2e-macos-ed25519.pem", import.meta.url).pathname,
  }, null, 2), { mode: 0o600 });
  const { startLocalE2e } = await import("./local-e2e-daemon.mjs");
  e2ePid = await startLocalE2e();
}
console.log(JSON.stringify({
  ready: true,
  ciMode,
  webUrl: `http://127.0.0.1:${webPort}`,
  macE2ePid: e2ePid,
  runtimes: {
    claudeCode: claudeVersion,
    codexCli: codexVersion,
  },
}));

async function detectLocalRuntime(command) {
  try {
    const result = await execute(command, ["--version"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 2_500,
    });
    return `${result.stdout}\n${result.stderr}`.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function requireCommand(command, arguments_) {
  try {
    await execute(command, arguments_, { timeout: 10_000, maxBuffer: 64 * 1024 });
  } catch {
    throw new Error(`${command} 未就绪；请先显式运行 npm run local:bootstrap`);
  }
}

async function requireGodot() {
  const candidates = process.platform === "darwin"
    ? [["godot", ["--version"]], ["/Applications/Godot.app/Contents/MacOS/Godot", ["--version"]]]
    : [["godot", ["--version"]]];
  for (const [command, arguments_] of candidates) {
    try {
      await execute(command, arguments_, { timeout: 10_000, maxBuffer: 64 * 1024 });
      return;
    } catch { /* try the next supported installation path */ }
  }
  throw new Error("Godot 未就绪；请先显式运行 npm run local:bootstrap");
}

async function resolveDockerSocketGid() {
  const { stdout } = await execute("docker", [
    "run", "--rm", "--entrypoint", "stat", "-v", "/var/run/docker.sock:/var/run/docker.sock:ro",
    "deviludo-sandbox-executor:local", "-c", "%g", "/var/run/docker.sock",
  ], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const gid = stdout.trim();
  if (!/^\d+$/.test(gid)) throw new Error("Docker socket group could not be determined");
  return gid;
}

async function retainActiveJobRuntimeImages(environment) {
  try {
    const result = await execute("docker", [
      "compose", "-f", "infra/docker-compose.yml", "exec", "-T", "postgres",
      "psql", "-Atq", "-U", "deviludo", "-d", "deviludo", "-c",
      "SELECT DISTINCT runtime_image FROM deviludo.jobs WHERE state IN ('QUEUED', 'RETRY', 'RUNNING') ORDER BY runtime_image",
    ], { cwd: root, env: environment, maxBuffer: 256 * 1024 });
    const references = result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const retained = [];
    for (const reference of references) {
      const digest = reference.match(/sha256:([0-9a-f]{64})$/i)?.[1];
      if (!digest) continue;
      try {
        await execute("docker", ["image", "inspect", reference], { maxBuffer: 64 * 1024 });
        await execute("docker", ["image", "tag", reference, `deviludo-retained-job-runtime:${digest.slice(0, 16)}`], { maxBuffer: 64 * 1024 });
        retained.push(reference);
      } catch {
        console.warn(`活动作业引用的镜像已不存在，将在页面提供安全重试：${reference}`);
      }
    }
    return retained;
  } catch {
    return [];
  }
}
