import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const projectName = `deviludo-e2e-${process.pid}-${randomBytes(4).toString("hex")}`;
if (!/^deviludo-e2e-[a-z0-9-]+$/.test(projectName)) throw new Error("Unsafe E2E Compose project name");
await import("./local-identity.mjs");

const [webPort, corePort, minioPort] = await Promise.all([
  availablePort(), availablePort(), availablePort(),
]);
const dockerSocketGid = await resolveDockerSocketGid();
const composeFiles = ["infra/docker-compose.yml", "infra/docker-compose.e2e.yml"];
const compose = [
  "compose",
  "--project-name", projectName,
  ...composeFiles.flatMap(file => ["-f", file]),
];
const environment = {
  ...process.env,
  NODE_ENV: "test",
  DEVILUDO_WEB_HOST_PORT: String(webPort),
  DEVILUDO_CORE_HOST_PORT: String(corePort),
  DEVILUDO_MINIO_HOST_PORT: String(minioPort),
  DEVILUDO_E2E_PROJECT_NAME: projectName,
  DEVILUDO_E2E_WEB_URL: `http://127.0.0.1:${webPort}`,
  DEVILUDO_E2E_CORE_URL: `http://127.0.0.1:${corePort}`,
  DEVILUDO_PUBLIC_BASE_URL: `http://127.0.0.1:${webPort}`,
  DEVILUDO_WEB_CORE_TOKEN: "local-web-to-core-token-0000000000000001",
  DEVILUDO_E2E_NODE_TOKEN: "local-e2e-node-token",
  DEVILUDO_DOCKER_GID: dockerSocketGid,
  DEVILUDO_CORE_EXECUTOR_PUBLIC_KEY_FILE: resolve(root, ".deviludo/local/executor-ed25519.pub"),
  DEVILUDO_EXECUTOR_SOCKET_VOLUME: `${projectName}-executor-socket`,
  DEVILUDO_EXECUTOR_AGENT_NETWORK: `${projectName}-executor-agent`,
  DEVILUDO_EXECUTOR_STEAM_NETWORK: `${projectName}-executor-steam`,
  DEVILUDO_E2E_IDENTITY_KEY_FILE: resolve(root, ".deviludo/local/e2e-macos-ed25519.pem"),
  DEVILUDO_E2E_ISOLATION_EXECUTOR: resolve(root, "scripts/executors/local-macos-isolation.mjs"),
  DEVILUDO_E2E_TEST_EXECUTOR: resolve(root, "scripts/executors/e2e-fixture-job.mjs"),
  DEVILUDO_E2E_SIGN_EXECUTOR: resolve(root, "scripts/executors/e2e-fixture-job.mjs"),
  DEVILUDO_E2E_CLEAN_INSTALL_EXECUTOR: resolve(root, "scripts/executors/e2e-fixture-job.mjs"),
  DEVILUDO_E2E_JOB_ROOT: resolve(root, "test-results/e2e-jobs"),
};

let playwright = null;
let resultCode = 1;
let composeStarted = false;
let interrupted = false;

for (const event of ["SIGINT", "SIGTERM"]) {
  process.once(event, () => {
    interrupted = true;
    playwright?.kill(event);
  });
}

try {
  await runDocker([
    ...compose, "--profile", "images", "build",
    "agent-fixture-image", "e2e-macos-image",
  ], environment, 10 * 60_000);
  const [fixtureImage, e2eImage] = await Promise.all([
    inspectImage("deviludo-agent-fixture:local", environment),
    inspectImage("deviludo-e2e-macos:local", environment),
  ]);
  Object.assign(environment, {
    DEVILUDO_EXECUTOR_ALLOWED_IMAGES: [fixtureImage, e2eImage].join(","),
    DEVILUDO_EXECUTOR_FIXTURE_AGENT_IMAGE: fixtureImage,
    DEVILUDO_RUNTIME_IMAGES_JSON: JSON.stringify({
      AGENT_CLAUDE: fixtureImage,
      AGENT_CODEX: fixtureImage,
      GODOT_BUILDER: fixtureImage,
      STEAM_PUBLISHER: fixtureImage,
      E2E_LINUX: e2eImage,
      E2E_WINDOWS: e2eImage,
      E2E_MACOS: e2eImage,
    }),
  });
  await runDocker([...compose, "up", "-d", "--build", "--wait", "postgres"], environment, 10 * 60_000);
  composeStarted = true;
  await runDocker([...compose, "--profile", "init", "run", "--rm", "migrate"], environment, 2 * 60_000);
  await runDocker([
    ...compose, "--profile", "init", "run", "--rm",
    "-e", "DEVILUDO_RUNTIME_IMAGES_JSON", "bootstrap-instance",
  ], environment, 2 * 60_000);
  await runDocker([...compose, "up", "-d", "--build", "--wait"], environment, 10 * 60_000);
  await Promise.all([
    waitForJson(`${environment.DEVILUDO_E2E_WEB_URL}/api/health/live`),
    waitForJson(`${environment.DEVILUDO_E2E_CORE_URL}/health/live`),
  ]);
  resultCode = await runPlaywright(process.argv.slice(2), environment);
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  resultCode = 1;
} finally {
  if (composeStarted) await captureComposeLogs(compose, environment).catch(() => undefined);
  await runDocker([...compose, "down", "--volumes", "--remove-orphans"], environment, 2 * 60_000)
    .catch(error => console.error(`E2E cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
}

process.exitCode = interrupted ? 130 : resultCode;

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        return reject(new Error("Failed to allocate an E2E port"));
      }
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function resolveDockerSocketGid() {
  const { stdout } = await execute("docker", [
    "run", "--rm", "--entrypoint", "stat", "-v", "/var/run/docker.sock:/var/run/docker.sock:ro",
    "postgres:17.6-alpine", "-c", "%g", "/var/run/docker.sock",
  ], { timeout: 30_000, maxBuffer: 64 * 1024 });
  const gid = stdout.trim();
  if (!/^\d+$/.test(gid)) throw new Error("Docker socket group could not be determined");
  return gid;
}

async function runDocker(args, env, timeout) {
  return await execute("docker", args, {
    cwd: root,
    env,
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function inspectImage(reference, env) {
  const result = await runDocker(["image", "inspect", "--format", "{{.Id}}", reference], env, 30_000);
  const digest = result.stdout.trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`Image ${reference} does not have an immutable digest`);
  return digest;
}

async function waitForJson(url) {
  const deadline = Date.now() + 60_000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function runPlaywright(args, env) {
  return new Promise((resolveCode, reject) => {
    playwright = spawn(process.execPath, [
      resolve(root, "node_modules/@playwright/test/cli.js"),
      "test",
      ...args,
    ], {
      cwd: root,
      env,
      stdio: "inherit",
    });
    playwright.once("error", reject);
    playwright.once("close", code => resolveCode(code ?? 1));
  });
}

async function captureComposeLogs(composeArgs, env) {
  const result = await runDocker([...composeArgs, "logs", "--no-color", "--timestamps"], env, 60_000);
  const directory = resolve(root, "test-results");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "compose.log"), `${result.stdout}${result.stderr}`, "utf8");
}
