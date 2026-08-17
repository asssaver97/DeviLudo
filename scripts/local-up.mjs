import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readlink, readdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = new URL("..", import.meta.url);
const rootPath = fileURLToPath(root);
const composeProject = process.env.COMPOSE_PROJECT_NAME?.trim() || "deviludo-local";
const startupCacheFile = new URL("../.deviludo/local/startup-cache.json", import.meta.url);
const startupLockFile = fileURLToPath(new URL("../.deviludo/local/local-up.lock", import.meta.url));
const startupStartedAt = Date.now();
/**
 * Vault issues the service tokens with a 720h period and the services renew them
 * while they run, so a cache older than a fraction of that window is discarded: a
 * stack left down long enough for renewal to lapse must reissue rather than trust
 * a fingerprint that says nothing about the token's remaining life.
 */
const startupCacheMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const imageCacheMaxAgeMs = 24 * 60 * 60 * 1000;
const localImageBuilds = Object.freeze([
  { service: "agent-claude-image", image: "deviludo-agent-claude:local" },
  { service: "agent-codex-image", image: "deviludo-agent-codex:local" },
  { service: "godot-builder-image", image: "deviludo-godot-builder:local" },
  { service: "steam-publisher-image", image: "deviludo-steam-publisher:local" },
  { service: "e2e-macos-image", image: "deviludo-e2e-macos:local" },
  { service: "agent-fixture-image", image: "deviludo-agent-fixture:local" },
  { service: "sandbox-executor-init", image: "deviludo-sandbox-executor:local" },
  { service: "provider-proxy", image: "deviludo-provider-proxy:local" },
  { service: "core-api", image: "deviludo-core:local" },
  { service: "web", image: "deviludo-web:local" },
]);
const ciMode = process.env.DEVILUDO_LOCAL_CI === "1";
const resetIncompatibleBaseline = process.argv.includes("--reset-incompatible-baseline");
const refreshE2eVm = process.argv.includes("--refresh-e2e-vm");
const remoteE2eHost = optionValue("--remote-e2e") ?? process.env.DEVILUDO_LOCAL_REMOTE_E2E_HOST?.trim() ?? "";
if (remoteE2eHost && (!isPrivateNetworkIpv4(remoteE2eHost) || isIP(remoteE2eHost) !== 4)) {
  throw new Error("--remote-e2e must be a private IPv4 address reachable by the trusted LAN/VPN; use production HTTPS/mTLS for public networks");
}
if (remoteE2eHost && !isLocalInterfaceIpv4(remoteE2eHost)) {
  throw new Error(`--remote-e2e address ${remoteE2eHost} is not assigned to a local network interface`);
}
const releaseStartupLock = acquireStartupLock();
const webPort = process.env.DEVILUDO_WEB_HOST_PORT?.trim() || "3100";
const corePort = process.env.DEVILUDO_CORE_HOST_PORT?.trim() || "8080";
const gitImportPort = process.env.DEVILUDO_LOCAL_GIT_IMPORT_PORT?.trim() || "3199";
const artifactPort = process.env.DEVILUDO_MINIO_HOST_PORT?.trim() || "39000";
if (!/^\d+$/.test(webPort) || Number(webPort) < 1 || Number(webPort) > 65535) {
  throw new Error("DEVILUDO_WEB_HOST_PORT must be a valid TCP port");
}
if (webPort === "3000") {
  throw new Error("Port 3000 is reserved; choose another DEVILUDO_WEB_HOST_PORT");
}
if (!/^\d+$/.test(corePort) || Number(corePort) < 1 || Number(corePort) > 65535) {
  throw new Error("DEVILUDO_CORE_HOST_PORT must be a valid TCP port");
}
if (!/^\d+$/.test(gitImportPort) || Number(gitImportPort) < 1 || Number(gitImportPort) > 65535
  || [webPort, corePort].includes(gitImportPort)) {
  throw new Error("DEVILUDO_LOCAL_GIT_IMPORT_PORT must be a valid unused TCP port");
}
if (!/^\d+$/.test(artifactPort) || Number(artifactPort) < 1 || Number(artifactPort) > 65535) {
  throw new Error("DEVILUDO_MINIO_HOST_PORT must be a valid TCP port");
}
if ([webPort, corePort, gitImportPort].includes(artifactPort)) {
  throw new Error("Local Web, Core, project bridge, and artifact ports must be distinct");
}
const previousRemoteE2eConfiguration = await readLocalRemoteE2eConfiguration();
const e2eNodeToken = previousRemoteE2eConfiguration?.token ?? randomBytes(32).toString("base64url");
const remoteE2eConfiguration = {
  enabled: Boolean(remoteE2eHost),
  host: remoteE2eHost || null,
  coreUrl: remoteE2eHost ? `http://${remoteE2eHost}:${corePort}` : `http://127.0.0.1:${corePort}`,
  artifactUrl: remoteE2eHost ? `http://${remoteE2eHost}:${artifactPort}` : `http://127.0.0.1:${artifactPort}`,
  token: e2eNodeToken,
};
await writeFile(
  new URL("../.deviludo/local/remote-e2e.json", import.meta.url),
  `${JSON.stringify(remoteE2eConfiguration, null, 2)}\n`,
  { mode: 0o600 },
);
const previousGitImportConfiguration = await readLocalProjectBridgeConfiguration();
const gitImportConfiguration = {
  port: Number(gitImportPort),
  allowedOrigin: `http://127.0.0.1:${webPort}`,
  artifactOrigin: `http://127.0.0.1:${artifactPort}`,
  internalToken: previousGitImportConfiguration?.internalToken ?? randomBytes(32).toString("base64url"),
};
await writeFile(
  new URL("../.deviludo/local/git-import.json", import.meta.url),
  `${JSON.stringify(gitImportConfiguration, null, 2)}\n`,
  { mode: 0o600 },
);
const [claudeVersion, codexVersion, codexLoginMethod] = await Promise.all([
  detectLocalRuntime("claude"),
  detectLocalRuntime("codex"),
  detectLocalCodexAuthentication(),
]);
await prepareLocalCodexOfficialLogin(codexLoginMethod);
await requireCommand("docker", ["version", "--format", "{{.Server.Version}}"]);
await requireCommand("docker", ["compose", "version"]);
await requireCommand("git", ["--version"]);
const tartE2e = ciMode ? null : await import("./local-tart-prepare.mjs")
  .then(module => module.prepareLocalTartE2e({ refresh: refreshE2eVm }));
// Each one-shot initialisation step below is guarded by a fingerprint of the
// inputs that could change its answer, because a repeat start otherwise pays a
// full container creation per step to redo work that is already done. A guard
// that cannot prove the inputs are unchanged re-runs its step, so the cache only
// ever costs time, never correctness.
const dockerIdentity = await resolveDockerIdentity();
const startupCache = await readStartupCache(dockerIdentity);
// A baseline reset destroys every volume, including the ones the fingerprints
// below describe, so it suppresses the cache write and the next start redoes the
// initialisation from scratch.
let baselineReset = false;
const providerUpstreamProxy = await detectLocalProviderUpstreamProxy();
const baseEnvironment = {
  ...process.env,
  DEVILUDO_WEB_HOST_PORT: webPort,
  DEVILUDO_CORE_HOST_PORT: corePort,
  DEVILUDO_CORE_BIND_ADDRESS: remoteE2eHost ? "0.0.0.0" : "127.0.0.1",
  DEVILUDO_ARTIFACT_BIND_ADDRESS: remoteE2eHost ? "0.0.0.0" : "127.0.0.1",
  DEVILUDO_S3_PUBLIC_ENDPOINT: remoteE2eConfiguration.artifactUrl,
  DEVILUDO_E2E_NODE_TOKEN: e2eNodeToken,
  DEVILUDO_LOCAL_GIT_IMPORT_PORT: gitImportPort,
  DEVILUDO_LOCAL_GIT_IMPORT_PUBLIC_URL: `http://127.0.0.1:${gitImportPort}`,
  DEVILUDO_LOCAL_PROJECT_BRIDGE_INTERNAL_URL: `http://local-project-bridge-proxy:${gitImportPort}`,
  DEVILUDO_LOCAL_PROJECT_BRIDGE_HOST_URL: `http://host.docker.internal:${gitImportPort}`,
  DEVILUDO_LOCAL_PROJECT_BRIDGE_TOKEN: gitImportConfiguration.internalToken,
  DEVILUDO_LOCAL_DIRECTORY_BINDINGS: "1",
  DEVILUDO_PROVIDER_UPSTREAM_PROXY: providerUpstreamProxy,
};
await execute("docker", [
  "compose", "-f", "infra/docker-compose.yml", "up", "-d", "--wait", "postgres", "vault",
], { cwd: root, env: baseEnvironment, maxBuffer: 10 * 1024 * 1024 });
// Vault stores its data on a file volume, so a restarted Vault comes back sealed
// and its service tokens have to be reissued. Both facts follow from the container
// start time, which is why the fingerprint is built from it.
const vaultFingerprint = await fingerprintVaultInit();
let credentialConsumersStopped = false;
if (!matchesStartupCache("vaultInit", vaultFingerprint)) {
  await stopCredentialConsumers(baseEnvironment);
  credentialConsumersStopped = true;
  await refreshLocalVaultTokens(baseEnvironment);
}
const retainedJobRuntimeImages = await retainActiveJobRuntimeImages(baseEnvironment);
await import("./local-identity.mjs");
// Buildx stamps a fresh provenance attestation into the image config on every
// build, so an entirely cached rebuild still mints a new image id. Nothing here
// consumes that provenance, and the churn would re-register every runtime digest
// and rewrite the executor's allowlist on each start, so it is turned off to keep
// an unchanged source tree producing an unchanged image.
const imageInputFingerprint = await fingerprintLocalImageInputs();
let imageIds = await reusableLocalImageIds(imageInputFingerprint);
let imagesBuilt = false;
let imageBuiltAt = startupCache.imageBuiltAt;
if (!imageIds) {
  const imageBuildStartedAt = Date.now();
  console.log(JSON.stringify({ event: "local_up_stage", stage: "building_images", message: "源码或镜像基线已变化，正在构建本地运行镜像" }));
  await executeVisible("docker", ["compose", "-f", "infra/docker-compose.yml", "--profile", "images", "build",
    ...localImageBuilds.map(entry => entry.service)], {
    cwd: root,
    env: { ...process.env, BUILDX_NO_DEFAULT_ATTESTATIONS: "1" },
  });
  imageIds = await inspectLocalImageIds();
  imagesBuilt = true;
  imageBuiltAt = new Date().toISOString();
  console.log(JSON.stringify({ event: "local_up_stage", stage: "images_ready", durationMs: Date.now() - imageBuildStartedAt }));
} else {
  console.log(JSON.stringify({ event: "local_up_stage", stage: "images_reused", message: "源码未变化，复用已验证镜像" }));
}
const runtimeImages = JSON.stringify({
  AGENT_CLAUDE: imageIds["deviludo-agent-claude:local"],
  AGENT_CODEX: imageIds["deviludo-agent-codex:local"],
  GODOT_BUILDER: imageIds["deviludo-godot-builder:local"],
  STEAM_PUBLISHER: imageIds["deviludo-steam-publisher:local"],
  E2E_LINUX: imageIds["deviludo-e2e-macos:local"],
  E2E_WINDOWS: imageIds["deviludo-e2e-macos:local"],
  E2E_MACOS: imageIds["deviludo-e2e-macos:local"],
});
// Reading the socket group means starting a container purely to stat one file,
// which is the most expensive probe here. The group belongs to the daemon, so the
// answer only changes when the daemon does.
const dockerSocketGid = cachedStartupValue("dockerSocketGid", dockerIdentity, /^\d+$/)
  ?? await resolveDockerSocketGid();
const environment = {
  ...baseEnvironment,
  DEVILUDO_AGENT_RUNTIME_DETECTION_SCOPE: "LOCAL_HOST",
  DEVILUDO_CLAUDE_CODE_VERSION: claudeVersion ?? "NOT_INSTALLED",
  DEVILUDO_CODEX_CLI_VERSION: codexVersion ?? "NOT_INSTALLED",
  DEVILUDO_CODEX_LOGIN_METHOD: codexVersion ? codexLoginMethod : "SIGNED_OUT",
  DEVILUDO_EXECUTOR_ALLOWED_IMAGES: [...new Set([
    ...Object.values(JSON.parse(runtimeImages)), imageIds["deviludo-agent-fixture:local"], ...retainedJobRuntimeImages,
  ])].join(","),
  DEVILUDO_EXECUTOR_FIXTURE_AGENT_IMAGE: imageIds["deviludo-agent-fixture:local"],
  DEVILUDO_DOCKER_GID: dockerSocketGid,
  DEVILUDO_RUNTIME_IMAGES_JSON: runtimeImages,
};
await persistLocalComposeEnvironment(environment);
// The init container installs the executor's secrets into a volume from files on
// the host, so it has to re-run when either side changes: the volume identity, or
// the bytes it copies in.
const executorSecretsFingerprint = await fingerprintExecutorSecrets();
if (!matchesStartupCache("executorSecrets", executorSecretsFingerprint)) {
  if (!credentialConsumersStopped) {
    await stopCredentialConsumers(environment);
    credentialConsumersStopped = true;
  }
  await refreshLocalExecutorSecrets(environment);
}
// Both remaining init containers are reachable only through the init profile, so
// nothing else runs them and a skip has to be justified by the committed database
// state rather than a recorded fingerprint. One query reads everything the two
// containers would write, for a fraction of the cost of starting either.
const instanceState = await readLocalInstanceState(environment);
const expectedMigrationLedger = await readExpectedMigrationLedger();
const migrationRan = await migrateWithOptionalBaselineReset(environment, instanceState, expectedMigrationLedger);
const initialized = await bootstrapInstance(environment, runtimeImages, instanceState, migrationRan);
await execute("docker", [
  "compose",
  "-f", "infra/docker-compose.yml",
  "up",
  "-d",
  "--wait",
], { cwd: root, env: environment, maxBuffer: 10 * 1024 * 1024 });
const gitImportConfigurationFingerprint = digest([
  "git-import", imageInputFingerprint, JSON.stringify(gitImportConfiguration),
]);
const { runningGitImportPid, startLocalGitImport, stopLocalGitImport } = await import("./local-git-import-daemon.mjs");
const previousGitImportPid = await runningGitImportPid();
if (previousGitImportPid && !matchesStartupCache("gitImportConfiguration", gitImportConfigurationFingerprint)) {
  await stopLocalGitImport();
}
const gitImportPid = await startLocalGitImport();
let e2ePid = null;
let e2eConfigurationFingerprint = null;
if (!ciMode) {
  if (!initialized.macNodeId) throw new Error("Local macOS E2E node initialization failed");
  const e2eConfiguration = {
    nodeId: initialized.macNodeId,
    poolKind: "E2E_MACOS",
    coreUrl: process.env.DEVILUDO_CORE_API_URL?.trim() || remoteE2eConfiguration.coreUrl,
    token: e2eNodeToken,
    identityKeyFile: new URL("../.deviludo/local/e2e-macos-ed25519.pem", import.meta.url).pathname,
    jobRoot: new URL("../.deviludo/local/tart-host-jobs", import.meta.url).pathname,
    tartFingerprint: tartE2e?.fingerprint,
  };
  mkdirSync(e2eConfiguration.jobRoot, { recursive: true, mode: 0o700 });
  await writeFile(new URL("../.deviludo/local/e2e-macos.json", import.meta.url), JSON.stringify(e2eConfiguration, null, 2), { mode: 0o600 });
  e2eConfigurationFingerprint = digest([
    "e2e-macos", imageInputFingerprint, JSON.stringify(e2eConfiguration),
    await readOptionalFile(new URL("../.deviludo/local/e2e-macos-ed25519.pem", import.meta.url)),
  ]);
  const { runningPid, startLocalE2e, stopLocalE2e } = await import("./local-e2e-daemon.mjs");
  const previousE2ePid = await runningPid();
  if (previousE2ePid && !matchesStartupCache("e2eConfiguration", e2eConfigurationFingerprint)) {
    await stopLocalE2e();
  }
  e2ePid = await startLocalE2e();
}
// Recorded only once the complete stack is up, so a start that fails midway
// leaves the previous fingerprints in place and the next attempt redoes work.
if (!baselineReset) {
  await writeStartupCache({
    dockerIdentity,
    recordedAt: new Date().toISOString(),
    dockerSocketGid,
    vaultInit: vaultFingerprint,
    executorSecrets: executorSecretsFingerprint,
    imageInputFingerprint,
    imageIds,
    imageBuiltAt,
    gitImportConfiguration: gitImportConfigurationFingerprint,
    e2eConfiguration: e2eConfigurationFingerprint,
  });
}
console.log(JSON.stringify({
  ready: true,
  ciMode,
  webUrl: `http://127.0.0.1:${webPort}`,
  gitImportPid,
  macE2ePid: e2ePid,
  remoteE2e: remoteE2eHost ? {
    coreUrl: remoteE2eConfiguration.coreUrl,
    artifactUrl: remoteE2eConfiguration.artifactUrl,
    enrollment: "Open Runtime and create a one-time E2E enrollment token",
  } : null,
  startupMs: Date.now() - startupStartedAt,
  images: imagesBuilt ? "built" : "reused",
  migrations: migrationRan ? "applied" : "verified",
  bootstrap: initialized.reused ? "reused" : "refreshed",
  runtimes: {
    claudeCode: claudeVersion,
    codexCli: codexVersion,
    e2eVm: tartE2e ? (tartE2e.reused ? "reused" : "initialized") : "ci-skipped",
  },
}));
releaseStartupLock();

/** Stream long-running BuildKit output so local startup never looks frozen. */
function executeVisible(command, arguments_, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, { ...options, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

/**
 * Serialises local startup. Two concurrent BuildKit graphs compete for the same
 * cache and can turn a warm start into several minutes of duplicate work.
 */
function acquireStartupLock() {
  mkdirSync(resolve(rootPath, ".deviludo/local"), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    try {
      const descriptor = openSync(startupLockFile, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`);
      closeSync(descriptor);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(readFileSync(startupLockFile, "utf8"));
          if (current?.token === token) unlinkSync(startupLockFile);
        } catch { /* already removed or replaced */ }
      };
      process.once("exit", release);
      return release;
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "EEXIST")) throw error;
      let owner = null;
      try { owner = JSON.parse(readFileSync(startupLockFile, "utf8")); } catch { /* stale malformed lock */ }
      const age = Date.now() - Date.parse(owner?.createdAt ?? "");
      let running = false;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 1) {
        try {
          process.kill(owner.pid, 0);
          running = true;
        } catch (error) {
          if (error && typeof error === "object" && error.code === "EPERM") running = true;
        }
      }
      if (running && Number.isFinite(age) && age >= 0 && age < 12 * 60 * 60 * 1000) {
        throw Object.assign(new Error(`LOCAL_UP_ALREADY_RUNNING: PID ${owner.pid} 正在启动本地服务`), {
          code: "LOCAL_UP_ALREADY_RUNNING",
        });
      }
      try { unlinkSync(startupLockFile); } catch { /* another starter won the race */ }
    }
  }
  throw new Error("LOCAL_UP_LOCK_UNAVAILABLE: 无法获取本地启动锁");
}

/**
 * Hashes every tracked or new repository file that survives .dockerignore. The
 * same context drives every local Dockerfile, so docs and test-only changes no
 * longer trigger a rebuild while a new COPY input is picked up automatically.
 */
async function fingerprintLocalImageInputs() {
  let stdout;
  try {
    ({ stdout } = await execute("git", [
      "ls-files", "--cached", "--others", "--exclude-standard", "-z",
    ], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    // Source archives without Git metadata remain supported; they simply use
    // Docker's own cache validation on every start.
    return null;
  }
  const dockerIgnore = await readFile(resolve(rootPath, ".dockerignore"), "utf8");
  const ignoreRules = dockerIgnore.split(/\r?\n/)
    .map(rule => rule.trim())
    .filter(rule => rule && !rule.startsWith("#"));
  const paths = stdout.split("\0")
    .filter(path => path && (path === ".dockerignore" || !isDockerIgnored(path, ignoreRules)))
    .sort();
  if (paths.length === 0) return null;
  const hash = createHash("sha256");
  hash.update("deviludo-local-images-v1\0", "utf8");
  for (const relativePath of paths) {
    const absolutePath = resolve(rootPath, relativePath);
    const bounded = relative(rootPath, absolutePath);
    if (!bounded || bounded === ".." || bounded.startsWith(`..${sep}`)) {
      throw new Error(`Image input escapes the repository: ${relativePath}`);
    }
    hash.update(`${Buffer.byteLength(relativePath)}:${relativePath}:`, "utf8");
    let entry;
    try {
      entry = await lstat(absolutePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      // `git ls-files --cached` intentionally includes tracked deletions in a
      // dirty worktree. Keep the deletion in the fingerprint so it invalidates
      // an image built from the formerly present file.
      hash.update("missing", "utf8");
      continue;
    }
    if (entry.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      hash.update(`link:${Buffer.byteLength(target)}:${target}`, "utf8");
    } else if (entry.isFile()) {
      const content = await readFile(absolutePath);
      hash.update(`file:${content.length}:`, "utf8");
      hash.update(content);
    } else {
      throw new Error(`Unsupported image input: ${relativePath}`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function isDockerIgnored(path, rules) {
  let ignored = false;
  for (const sourceRule of rules) {
    const negated = sourceRule.startsWith("!");
    const rule = (negated ? sourceRule.slice(1) : sourceRule).replace(/^\/+|\/+$/g, "");
    if (!rule) continue;
    const expression = globExpression(rule);
    const matched = rule.includes("/")
      ? expression.test(path) || expression.test(path.split("/").slice(0, -1).join("/"))
      : path.split("/").some(segment => expression.test(segment));
    if (matched) ignored = !negated;
  }
  return ignored;
}

function globExpression(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.-]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

async function reusableLocalImageIds(inputFingerprint) {
  if (typeof inputFingerprint !== "string" || startupCache.imageInputFingerprint !== inputFingerprint) return null;
  const builtAt = Date.parse(startupCache.imageBuiltAt ?? "");
  const age = Date.now() - builtAt;
  if (!Number.isFinite(builtAt) || age < 0 || age >= imageCacheMaxAgeMs) return null;
  if (!startupCache.imageIds || typeof startupCache.imageIds !== "object" || Array.isArray(startupCache.imageIds)) return null;
  try {
    const current = await inspectLocalImageIds();
    return localImageBuilds.every(({ image }) => current[image] === startupCache.imageIds[image]) ? current : null;
  } catch {
    return null;
  }
}

async function inspectLocalImageIds() {
  const pairs = await Promise.all(localImageBuilds.map(async ({ image }) => {
    const { stdout } = await execute("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    const id = stdout.trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error(`Local image has an invalid id: ${image}`);
    return [image, id];
  }));
  return Object.freeze(Object.fromEntries(pairs));
}

/**
 * Reads the recorded fingerprints of the previous successful start. Anything
 * unreadable, malformed, or belonging to a different Docker daemon is discarded,
 * so a stale or foreign cache degrades into re-running every step.
 */
async function readStartupCache(identity) {
  if (!identity) return {};
  try {
    const parsed = JSON.parse(await readFile(startupCacheFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    if (parsed.dockerIdentity !== identity) return {};
    const recordedAt = Date.parse(parsed.recordedAt ?? "");
    if (!Number.isFinite(recordedAt)) return {};
    const age = Date.now() - recordedAt;
    return age >= 0 && age < startupCacheMaxAgeMs ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Compares a freshly computed fingerprint against the recorded one. A fingerprint
 * that could not be computed never matches, so an unreadable input re-runs its step
 * instead of silently skipping it.
 */
function matchesStartupCache(key, fingerprint) {
  return typeof fingerprint === "string" && startupCache[key] === fingerprint;
}

async function writeStartupCache(state) {
  try {
    await writeFile(startupCacheFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // The cache is an optimisation; failing to persist it only costs the next
    // start the work it would otherwise have skipped.
  }
}

/**
 * Returns a cached value only when it was recorded against the same signal and
 * still has the shape the caller requires.
 */
function cachedStartupValue(key, signal, shape) {
  if (startupCache.dockerIdentity !== signal) return null;
  const value = startupCache[key];
  return typeof value === "string" && shape.test(value) ? value : null;
}

/**
 * Identifies the daemon the cache was built against. A different daemon means
 * different volumes, images and socket ownership, so every fingerprint recorded
 * under the previous one has to be treated as unrelated.
 */
async function resolveDockerIdentity() {
  try {
    const { stdout } = await execute("docker", ["info", "--format", "{{.ID}}"], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Vault keeps its data on a volume but comes back sealed after a restart, and the
 * service tokens live on a second volume. Recreating either, or restarting the
 * server, has to reissue the tokens — all three show up in this fingerprint.
 */
async function fingerprintVaultInit() {
  const [containerStart, volumes] = await Promise.all([
    inspectFormat(["container", `${composeProject}-vault-1`], "{{.State.StartedAt}}"),
    inspectFormat(["volume", `${composeProject}_vault-data`, `${composeProject}_vault-tokens`], "{{.CreatedAt}}"),
  ]);
  if (!containerStart || !volumes) return null;
  return digest(["vault", containerStart, volumes, await readLocalPolicySources()]);
}

/**
 * The executor init container copies host key material into its volumes, so the
 * fingerprint covers both the volume identities and the bytes being installed.
 */
async function fingerprintExecutorSecrets() {
  const volumes = await inspectFormat([
    "volume",
    `${composeProject}_vault-tokens`,
    `${composeProject}_executor-work`,
    `${composeProject}_executor-service-secrets`,
    process.env.DEVILUDO_EXECUTOR_SOCKET_VOLUME ?? "deviludo-executor-socket",
  ], "{{.CreatedAt}}");
  if (!volumes) return null;
  const sources = await Promise.all([
    "executor-ed25519.pem",
    "s3.credentials",
  ].map(name => readOptionalFile(new URL(`../.deviludo/local/${name}`, import.meta.url))));
  if (sources.some(content => content === null)) return null;
  // The token this step installs is reissued whenever vault-init runs, so that
  // fingerprint has to invalidate this one too — including when it is unknown,
  // which digest() propagates as an unusable fingerprint.
  return digest(["executor-secrets", volumes, vaultFingerprint, ...sources]);
}

async function readLocalPolicySources() {
  const sources = await Promise.all([
    "local-init.sh",
    "api.hcl",
    "executor.hcl",
  ].map(name => readOptionalFile(new URL(`../infra/vault/${name}`, import.meta.url))));
  return sources.some(content => content === null) ? null : sources.join("\0");
}

async function readOptionalFile(target) {
  try {
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
}

/**
 * Formats one or more Docker objects, treating a missing object as "unknown"
 * rather than an error so callers fall back to re-running their step.
 */
async function inspectFormat(target, format) {
  const [type, ...names] = target;
  try {
    const { stdout } = await execute("docker", [
      "inspect", "--type", type, "--format", format, ...names,
    ], { timeout: 15_000, maxBuffer: 256 * 1024 });
    const values = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    return values.length === names.length ? values.join("|") : null;
  } catch {
    return null;
  }
}

/**
 * Hashes the parts of a fingerprint, or returns null when any of them is unknown so
 * the caller cannot mistake a partial answer for a match. Each part is length-prefixed
 * so two different part lists can never hash the same way.
 */
function digest(parts) {
  if (parts.some(part => part === null || part === undefined)) return null;
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = String(part);
    hash.update(`${value.length}:`, "utf8");
    hash.update(value, "utf8");
  }
  return hash.digest("hex");
}

/** Digest of the bytes alone, to compare against a hash computed in SQL. */
function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Reads an installed CLI's version. These are Node programs whose first run after a
 * cold page cache can take several seconds, and a timeout here is indistinguishable
 * from "not installed" — it would record the runtime as NOT_INSTALLED even though it
 * is present. A missing command still fails immediately, so the wait only applies to
 * one that exists and is slow to answer.
 */
async function detectLocalRuntime(command) {
  try {
    const result = await execute(command, ["--version"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 30_000,
    });
    return `${result.stdout}\n${result.stderr}`.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function detectLocalCodexAuthentication() {
  try {
    const result = await execute("codex", ["login", "status"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 30_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (/Logged in using ChatGPT/i.test(output)) return "CHATGPT";
    if (/Logged in using (?:an )?API key/i.test(output)) return "API_KEY";
    return "SIGNED_OUT";
  } catch {
    return "SIGNED_OUT";
  }
}

async function prepareLocalCodexOfficialLogin(loginMethod) {
  const target = fileURLToPath(new URL("../.deviludo/local/codex-auth.json", import.meta.url));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (loginMethod !== "CHATGPT") {
    await writeFile(target, "{}\n", { mode: 0o600 });
    await chmod(target, 0o600);
    return;
  }
  const configuredRoot = process.env.CODEX_HOME?.trim();
  const source = configuredRoot && isAbsolute(configuredRoot)
    ? join(configuredRoot, "auth.json")
    : join(homedir(), ".codex", "auth.json");
  const parsed = JSON.parse(await readFile(source, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex CLI auth.json is invalid; run codex login again");
  }
  await writeFile(target, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
}

async function requireCommand(command, arguments_) {
  try {
    await execute(command, arguments_, { timeout: 10_000, maxBuffer: 64 * 1024 });
  } catch {
    throw new Error(`${command} 未就绪；请先显式运行 npm run local:bootstrap`);
  }
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
    "DEVILUDO_CORE_HOST_PORT",
    "DEVILUDO_CORE_BIND_ADDRESS",
    "DEVILUDO_ARTIFACT_BIND_ADDRESS",
    "DEVILUDO_S3_PUBLIC_ENDPOINT",
    "DEVILUDO_E2E_NODE_TOKEN",
    "DEVILUDO_AGENT_RUNTIME_DETECTION_SCOPE",
    "DEVILUDO_CLAUDE_CODE_VERSION",
    "DEVILUDO_CODEX_CLI_VERSION",
    "DEVILUDO_CODEX_LOGIN_METHOD",
    "DEVILUDO_EXECUTOR_ALLOWED_IMAGES",
    "DEVILUDO_EXECUTOR_FIXTURE_AGENT_IMAGE",
    "DEVILUDO_DOCKER_GID",
    "DEVILUDO_PROVIDER_UPSTREAM_PROXY",
    "DEVILUDO_RUNTIME_IMAGES_JSON",
    "DEVILUDO_LOCAL_PROJECT_BRIDGE_INTERNAL_URL",
    "DEVILUDO_LOCAL_PROJECT_BRIDGE_HOST_URL",
    "DEVILUDO_LOCAL_PROJECT_BRIDGE_TOKEN",
    "DEVILUDO_LOCAL_DIRECTORY_BINDINGS",
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

async function readLocalProjectBridgeConfiguration() {
  try {
    const value = JSON.parse(await readFile(new URL("../.deviludo/local/git-import.json", import.meta.url), "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)
      && typeof value.internalToken === "string"
      && /^[A-Za-z0-9_-]{40,200}$/.test(value.internalToken)) {
      return Object.freeze({ internalToken: value.internalToken });
    }
  } catch { /* first start or an obsolete local bridge configuration */ }
  return null;
}

async function readLocalRemoteE2eConfiguration() {
  try {
    const value = JSON.parse(await readFile(new URL("../.deviludo/local/remote-e2e.json", import.meta.url), "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)
      && typeof value.token === "string" && /^[A-Za-z0-9_-]{40,200}$/.test(value.token)) {
      return Object.freeze({ token: value.token });
    }
  } catch { /* first start */ }
  return null;
}

function optionValue(name) {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) {
    const value = process.argv[exact + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    return value.trim();
  }
  const prefix = `${name}=`;
  const inline = process.argv.find(argument => argument.startsWith(prefix));
  return inline ? inline.slice(prefix.length).trim() : null;
}

function isPrivateNetworkIpv4(value) {
  if (isIP(value) !== 4) return false;
  const [first, second] = value.split(".").map(Number);
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

function isLocalInterfaceIpv4(value) {
  return Object.values(networkInterfaces()).some(addresses =>
    addresses?.some(address => address.family === "IPv4" && address.address === value),
  );
}

async function detectLocalProviderUpstreamProxy() {
  const explicit = process.env.DEVILUDO_PROVIDER_UPSTREAM_PROXY?.trim();
  if (explicit) return normalizeLocalUpstreamProxy(explicit);
  if (process.platform !== "darwin") return "";
  const hosts = (process.env.DEVILUDO_PROVIDER_ALLOWLIST ?? "api.anthropic.com,api.openai.com,chatgpt.com")
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

async function stopCredentialConsumers(environment) {
  await execute("docker", [
    "compose", "-f", "infra/docker-compose.yml", "stop",
    "web", "core-api", "core-scheduler", "core-sandbox", "sandbox-executord",
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

/**
 * Runs the idempotent migration ledger on every start. Baseline compatibility is
 * not enough to prove that all later migrations are present, and skipping on that
 * signal was exactly how a persistent local volume could keep stale functions.
 */
async function migrateWithOptionalBaselineReset(environment, state, expectedLedger) {
  // This is still a full immutable-ledger verification on every start. It avoids
  // creating a migration container only when the database reports exactly the
  // versions and checksums present in this checkout.
  if (state?.baseline === "001 deviludo-self-hosted-v1" && state.migrations === expectedLedger) {
    return false;
  }
  try {
    await runMigration(environment);
    return true;
  } catch (error) {
    if (!isIncompatibleBaselineError(error)) throw error;
    if (!resetIncompatibleBaseline) {
      throw Object.assign(new Error([
        "检测到包含旧托管平台或账号模型的不兼容 DeviLudo 数据基线。自建版不支持原地迁移。",
        "如确认删除本地 PostgreSQL、MinIO 制品、项目源码目录和 Vault 数据，请运行：",
        "  npm run local:reset:self-hosted",
        "已绑定的外部本地项目目录不会被此操作删除。",
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
    // Every volume the fingerprints describe has just been destroyed, so nothing
    // recorded from this start may be reused by the next one.
    baselineReset = true;
    console.warn("自建版本地数据基线已重建，继续启动服务。");
    return true;
  }
}

async function runMigration(environment) {
  await execute("docker", [
    "compose", "-f", "infra/docker-compose.yml", "--profile", "init", "run", "--rm", "migrate",
  ], { cwd: root, env: environment, maxBuffer: 2 * 1024 * 1024 });
}

/**
 * Registers the runtime images, the local server pools and the executor identities,
 * unless the database already describes exactly that. The comparison covers the
 * image digests, the seeded pools, and a digest of each stored public key, so a
 * regenerated host keypair still forces the step to run.
 */
async function bootstrapInstance(environment, runtimeImages, state, migrationRan) {
  if (!migrationRan && !baselineReset) {
    const macNodeId = await matchesBootstrappedInstance(runtimeImages, state);
    if (macNodeId) return { initialized: true, macNodeId, reused: true };
  }
  const bootstrap = await execute("docker", [
    "compose", "-f", "infra/docker-compose.yml", "--profile", "init", "run", "--rm",
    "-e", "DEVILUDO_RUNTIME_IMAGES_JSON", "bootstrap-instance",
  ], { cwd: root, env: environment, maxBuffer: 2 * 1024 * 1024 });
  return { ...JSON.parse(bootstrap.stdout), reused: false };
}

async function readExpectedMigrationLedger() {
  const migrations = new URL("../infra/postgres/migrations/", import.meta.url);
  const names = (await readdir(migrations))
    .filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (names.length === 0) throw new Error("No versioned database migrations were found");
  const rows = await Promise.all(names.map(async name => {
    const source = await readFile(new URL(name, migrations), "utf8");
    const checksum = `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
    return `${name.slice(0, -4)}=${checksum}`;
  }));
  return rows.join(",");
}

/**
 * Returns the recorded macOS node id when the stored instance matches what
 * bootstrapping would write, and null when anything differs or cannot be read.
 */
async function matchesBootstrappedInstance(runtimeImages, state) {
  if (!state?.macNodeId) return null;
  const expectedImages = Object.entries(JSON.parse(runtimeImages))
    .map(([key, digest]) => `${key}=${digest}`)
    .sort()
    .join(",");
  if (state.runtimeImages !== expectedImages) return null;
  if (state.pools !== "CORE,E2E_MACOS,WEB") return null;
  const [coreKey, e2eKey] = await Promise.all([
    readOptionalFile(new URL("../.deviludo/local/executor-ed25519.pub", import.meta.url)),
    readOptionalFile(new URL("../.deviludo/local/e2e-macos-ed25519.pub", import.meta.url)),
  ]);
  if (coreKey === null || e2eKey === null) return null;
  // These hashes are compared against sha256(public_key_pem) computed in SQL, so
  // they have to be plain digests of the key bytes. Ordering matches the query's
  // C collation, which sorts the same way as the default string comparison here.
  const expectedIdentities = [
    `local-core-executor:${sha256Hex(coreKey)}`,
    `${state.macNodeId}:${sha256Hex(e2eKey)}`,
  ].sort().join(",");
  return state.identities === expectedIdentities ? state.macNodeId : null;
}

/**
 * Reads everything the migration and bootstrap steps would write, in one query
 * against the already-running Postgres container. Ordering is forced to the C
 * collation so the comparison does not depend on the database's locale, and the
 * tables are probed through the catalog first because a missing table would
 * otherwise fail the statement at parse time.
 */
async function readLocalInstanceState(environment) {
  const tables = ["schema_metadata", "schema_migrations", "runtime_images", "server_nodes", "executor_identities"];
  const present = await queryPostgres(environment, `SELECT ${
    tables.map(table => `to_regclass('deviludo.${table}') IS NOT NULL`).join(" AND ")
  }`);
  if (present !== "t") return null;
  const recorded = await queryPostgres(environment, [
    "SELECT (SELECT baseline || ' ' || compatibility FROM deviludo.schema_metadata WHERE singleton = true)",
    "|| '|' || (SELECT coalesce(string_agg(runtime_key || '=' || image_reference, ',' ORDER BY runtime_key COLLATE \"C\"), '')",
    "FROM deviludo.runtime_images)",
    "|| '|' || coalesce((SELECT string_agg(kind, ',' ORDER BY kind) FROM",
    "(SELECT DISTINCT pool_kind::text COLLATE \"C\" AS kind FROM deviludo.server_nodes WHERE state = 'ACTIVE') pools), '')",
    "|| '|' || (SELECT coalesce(string_agg(executor_id || ':' || encode(sha256(convert_to(public_key_pem, 'UTF8')), 'hex'),",
    "',' ORDER BY executor_id COLLATE \"C\"), '') FROM deviludo.executor_identities WHERE enabled)",
    "|| '|' || coalesce((SELECT id::text FROM deviludo.server_nodes WHERE pool_kind = 'E2E_MACOS'",
    "ORDER BY created_at LIMIT 1), '')",
    "|| '|' || (SELECT coalesce(string_agg(version || '=' || checksum, ',' ORDER BY version COLLATE \"C\"), '')",
    "FROM deviludo.schema_migrations)",
  ].join(" "));
  const fields = recorded?.split("|");
  if (fields?.length !== 6) return null;
  const [baseline, images, pools, identities, macNodeId, migrations] = fields;
  return { baseline, runtimeImages: images, pools, identities, macNodeId, migrations };
}

/**
 * Runs a single-value query through the already-running Postgres container. A
 * failure or an unexpected shape returns null so the caller performs its step.
 */
async function queryPostgres(environment, sql) {
  try {
    const { stdout } = await execute("docker", [
      "compose", "-f", "infra/docker-compose.yml", "exec", "-T", "postgres",
      "psql", "-Atq", "-v", "ON_ERROR_STOP=1", "-U", "deviludo", "-d", "deviludo", "-c", sql,
    ], { cwd: root, env: environment, timeout: 20_000, maxBuffer: 256 * 1024 });
    const rows = stdout.split(/\r?\n/).filter(line => line.length > 0);
    return rows.length === 1 ? rows[0].trim() : null;
  } catch {
    return null;
  }
}

function isIncompatibleBaselineError(error) {
  if (!(error instanceof Error)) return false;
  const details = `${error.message}\n${typeof error.stderr === "string" ? error.stderr : ""}`;
  return details.includes("INCOMPATIBLE_BASELINE_RESET_REQUIRED");
}
