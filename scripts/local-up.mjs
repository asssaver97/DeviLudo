import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = new URL("..", import.meta.url);
const ciMode = process.env.DEVILUDO_LOCAL_CI === "1";
const resetIncompatibleBaseline = process.argv.includes("--reset-incompatible-baseline");
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
const providerUpstreamProxy = await detectLocalProviderUpstreamProxy();
const baseEnvironment = {
  ...process.env,
  DEVILUDO_WEB_HOST_PORT: webPort,
  DEVILUDO_PROVIDER_UPSTREAM_PROXY: providerUpstreamProxy,
};
await execute("docker", [
  "compose", "-f", "infra/docker-compose.yml", "up", "-d", "--wait", "postgres", "vault",
], { cwd: root, env: baseEnvironment, maxBuffer: 10 * 1024 * 1024 });
await refreshLocalVaultTokens(baseEnvironment);
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
const runtimeImages = JSON.stringify({
  AGENT_CLAUDE: imageIds[0],
  AGENT_CODEX: imageIds[1],
  GODOT_BUILDER: imageIds[2],
  STEAM_PUBLISHER: imageIds[3],
  E2E_LINUX: imageIds[4],
  E2E_WINDOWS: imageIds[4],
  E2E_MACOS: imageIds[4],
});
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
await persistLocalComposeEnvironment(environment);
await refreshLocalExecutorSecrets(environment);
await migrateWithOptionalBaselineReset(environment);
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

async function persistLocalComposeEnvironment(environment) {
  const target = new URL("../.env", import.meta.url);
  const start = "# BEGIN DEVILUDO LOCAL RUNTIME (managed by npm run local:up)";
  const end = "# END DEVILUDO LOCAL RUNTIME";
  const keys = [
    "DEVILUDO_WEB_HOST_PORT",
    "DEVILUDO_AGENT_RUNTIME_DETECTION_SCOPE",
    "DEVILUDO_CLAUDE_CODE_VERSION",
    "DEVILUDO_CODEX_CLI_VERSION",
    "DEVILUDO_EXECUTOR_ALLOWED_IMAGES",
    "DEVILUDO_EXECUTOR_FIXTURE_AGENT_IMAGE",
    "DEVILUDO_DOCKER_GID",
    "DEVILUDO_PROVIDER_UPSTREAM_PROXY",
    "DEVILUDO_RUNTIME_IMAGES_JSON",
  ];
  let existing = "";
  try {
    existing = await readFile(target, "utf8");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  const retained = [];
  let managed = false;
  for (const line of existing.split(/\r?\n/)) {
    if (line === start) { managed = true; continue; }
    if (line === end) { managed = false; continue; }
    if (!managed) retained.push(line);
  }
  while (retained.at(-1) === "") retained.pop();
  const block = [
    start,
    ...keys.map(key => `${key}=${JSON.stringify(String(environment[key] ?? ""))}`),
    end,
  ];
  await writeFile(target, `${[...retained, ...(retained.length ? [""] : []), ...block].join("\n")}\n`, { mode: 0o600 });
}

async function detectLocalProviderUpstreamProxy() {
  const explicit = process.env.DEVILUDO_PROVIDER_UPSTREAM_PROXY?.trim();
  if (explicit) return normalizeLocalUpstreamProxy(explicit);
  if (process.platform !== "darwin") return "";
  const hosts = (process.env.DEVILUDO_PROVIDER_ALLOWLIST ?? "api.anthropic.com,api.openai.com,www.sotamodel.net")
    .split(",").map(value => value.trim()).filter(Boolean);
  let fakeIpDetected = false;
  for (const host of hosts) {
    try {
      const addresses = await lookup(host, { all: true });
      if (addresses.some(({ address }) => isFakeIp(address))) fakeIpDetected = true;
    } catch {
      // A later host may still prove that a local transparent proxy owns DNS.
    }
  }
  if (!fakeIpDetected) return "";
  const target = hosts.at(-1) ?? "api.anthropic.com";
  for (const port of [6152, 7890, 1087]) {
    if (await supportsHttpConnectProxy(port, target)) return `http://host.docker.internal:${port}`;
  }
  throw new Error([
    "检测到 Provider DNS 返回 198.18.0.0/15 Fake-IP，但 Docker 无法使用宿主机透明代理。",
    "请开启本机 HTTP 代理端口，并设置 DEVILUDO_PROVIDER_UPSTREAM_PROXY=http://host.docker.internal:<port> 后重试。",
  ].join("\n"));
}

function normalizeLocalUpstreamProxy(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("DEVILUDO_PROVIDER_UPSTREAM_PROXY is invalid"); }
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !["host.docker.internal", "127.0.0.1", "localhost"].includes(url.hostname)
    || !url.port || Number(url.port) < 1 || Number(url.port) > 65535) {
    throw new Error("DEVILUDO_PROVIDER_UPSTREAM_PROXY must be an unauthenticated local HTTP proxy URL with an explicit port");
  }
  return `http://host.docker.internal:${url.port}`;
}

function isFakeIp(address) {
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

function supportsHttpConnectProxy(port, target) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const call = request({
      host: "127.0.0.1",
      port,
      method: "CONNECT",
      path: `${target}:443`,
    });
    call.once("connect", (response, socket) => {
      socket.destroy();
      finish(response.statusCode === 200);
    });
    call.once("response", response => {
      response.resume();
      finish(false);
    });
    call.once("error", () => finish(false));
    call.setTimeout(1_500, () => {
      call.destroy();
      finish(false);
    });
    call.end();
  });
}

async function refreshLocalVaultTokens(environment) {
  await execute("docker", [
    "compose", "-f", "infra/docker-compose.yml", "run", "--rm", "--no-deps", "vault-init",
  ], { cwd: root, env: environment, maxBuffer: 2 * 1024 * 1024 });
}

async function refreshLocalExecutorSecrets(environment) {
  await execute("docker", [
    "compose", "-f", "infra/docker-compose.yml", "run", "--rm", "--no-deps", "sandbox-executor-init",
  ], { cwd: root, env: environment, maxBuffer: 2 * 1024 * 1024 });
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

async function migrateWithOptionalBaselineReset(environment) {
  try {
    await runMigration(environment);
  } catch (error) {
    if (!isIncompatibleBaselineError(error)) throw error;
    if (!resetIncompatibleBaseline) {
      throw Object.assign(new Error([
        "检测到不兼容的旧版 DeviLudo 本地数据基线。持久源码 v1 不支持原地迁移。",
        "如确认删除本地 PostgreSQL、MinIO 制品、项目源码目录和 Vault 数据，请运行：",
        "  npm run local:reset:source-v1",
        "任何远端服务的数据都不会被删除。",
      ].join("\n")), { code: "INCOMPATIBLE_BASELINE_RESET_REQUIRED" });
    }

    console.warn("正在重置不兼容的本地 PostgreSQL、MinIO、项目源码和 Vault 数据；不会删除任何远端数据。");
    await execute("docker", [
      "compose", "-f", "infra/docker-compose.yml", "down", "--volumes", "--remove-orphans",
    ], { cwd: root, env: environment, maxBuffer: 10 * 1024 * 1024 });
    await execute("docker", [
      "compose", "-f", "infra/docker-compose.yml", "up", "-d", "--wait", "postgres",
    ], { cwd: root, env: environment, maxBuffer: 10 * 1024 * 1024 });
    await runMigration(environment);
    console.warn("持久源码 v1 本地数据基线已重建，继续启动服务。");
  }
}

async function runMigration(environment) {
  await execute("docker", [
    "compose", "-f", "infra/docker-compose.yml", "--profile", "init", "run", "--rm", "migrate",
  ], { cwd: root, env: environment, maxBuffer: 2 * 1024 * 1024 });
}

function isIncompatibleBaselineError(error) {
  if (!(error instanceof Error)) return false;
  const details = `${error.message}\n${typeof error.stderr === "string" ? error.stderr : ""}`;
  return details.includes("INCOMPATIBLE_BASELINE_RESET_REQUIRED");
}
