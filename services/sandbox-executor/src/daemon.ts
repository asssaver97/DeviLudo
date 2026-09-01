import { spawn } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { SandboxPlan, SandboxReceipt } from "@/services/core/src/sandbox";
import { executorReceiptSigningPayload, parseJobProtocolV4 } from "@/services/core/src/contracts";
import { ProjectSourceStore } from "@/services/core/src/project-sources";
import { ProjectRuntimeSupervisor } from "./project-runtime-supervisor";

const socketPath = process.env.DEVILUDO_EXECUTOR_SOCKET ?? "/run/deviludo-executor/executor.sock";
const executorId = process.env.DEVILUDO_EXECUTOR_ID ?? "";
const identityKeyFile = process.env.DEVILUDO_EXECUTOR_IDENTITY_KEY_FILE ?? "";
const allowlistedImages = new Set((process.env.DEVILUDO_EXECUTOR_ALLOWED_IMAGES ?? "").split(",").filter(Boolean));
const workRoot = process.env.DEVILUDO_EXECUTOR_WORK_ROOT ?? "/var/lib/deviludo-executor";
const secretRoot = process.env.DEVILUDO_EXECUTOR_SECRET_ROOT ?? "/run/deviludo-secrets";
const projectsRoot = process.env.DEVILUDO_PROJECTS_ROOT ?? "/var/lib/deviludo-projects";
const projectsVolume = process.env.DEVILUDO_PROJECTS_VOLUME ?? "deviludo-projects";
const projectRuntimeMcpGateway = process.env.DEVILUDO_PROJECT_RUNTIME_MCP_GATEWAY ?? "http://core-api:8080";
const codexModelsCacheFile = process.env.DEVILUDO_CODEX_MODELS_CACHE_FILE?.trim() || undefined;
const projectSources = new ProjectSourceStore(projectsRoot);
const microvmRuntime = process.env.DEVILUDO_EXECUTOR_MICROVM_RUNTIME ?? "";
const microvmSmokeImage = process.env.DEVILUDO_EXECUTOR_MICROVM_SMOKE_IMAGE ?? "";
const developmentContainersAllowed = process.env.NODE_ENV !== "production"
  && process.env.DEVILUDO_EXECUTOR_ALLOW_DEVELOPMENT_CONTAINER === "1";
const fixtureAgentImage = developmentContainersAllowed
  && allowlistedImages.has(process.env.DEVILUDO_EXECUTOR_FIXTURE_AGENT_IMAGE ?? "")
  ? process.env.DEVILUDO_EXECUTOR_FIXTURE_AGENT_IMAGE ?? ""
  : "";
const projectRuntimes = new ProjectRuntimeSupervisor({
  docker,
  resolveSecret,
  executorId,
  projectsRoot,
  projectsVolume,
  agentNetwork: process.env.DEVILUDO_EXECUTOR_AGENT_NETWORK ?? "none",
  egressProxy: process.env.DEVILUDO_EXECUTOR_EGRESS_PROXY ?? "",
  mcpGateway: projectRuntimeMcpGateway,
  codexModelsCacheFile,
  allowlistedImages,
});
/**
 * In-flight executions, so a shutdown can abort them deliberately instead of
 * being killed with their task containers still running.
 */
type LiveExecution = Readonly<{ abort: () => void; settled: Promise<void> }>;
const liveExecutions = new Set<LiveExecution>();
let shuttingDown = false;
if (!executorId || !identityKeyFile || allowlistedImages.size < 1
  || !workRoot.startsWith("/var/lib/deviludo-executor") || secretRoot !== "/run/deviludo-secrets"
  || (codexModelsCacheFile !== undefined && !codexModelsCacheFile.startsWith("/"))) {
  throw new Error("Executor identity, allowlist, and fixed storage roots are required");
}
if (process.env.NODE_ENV === "production"
  && (!/^[A-Za-z0-9._-]{3,80}$/.test(microvmRuntime) || !allowlistedImages.has(microvmSmokeImage))) {
  throw new Error("Production executor requires a fixed microVM runtime and an allowlisted smoke image");
}

const s3 = new S3Client({
  region: process.env.DEVILUDO_S3_REGION ?? "us-east-1",
  endpoint: process.env.DEVILUDO_S3_ENDPOINT,
  forcePathStyle: process.env.DEVILUDO_S3_PATH_STYLE === "1",
  credentials: process.env.DEVILUDO_S3_ACCESS_KEY_ID && process.env.DEVILUDO_S3_SECRET_ACCESS_KEY
    ? { accessKeyId: process.env.DEVILUDO_S3_ACCESS_KEY_ID, secretAccessKey: process.env.DEVILUDO_S3_SECRET_ACCESS_KEY }
    : undefined,
});

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/v2/live") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ schemaVersion: "deviludo.executor-live.v1", executorId }));
      return;
    }
    if (request.method === "POST" && request.url === "/v2/health") {
      const smoke = await executorSmoke();
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(smoke));
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/v2/runtime/")) {
      if (shuttingDown) throw new Error("Executor is shutting down");
      const body = request.url === "/v2/runtime/list"
        ? null
        : JSON.parse((await readRequestBody(request, 2 * 1024 * 1024)).toString("utf8"));
      if (request.url === "/v2/runtime/turn") {
        const execution = new AbortController();
        response.once("close", () => { if (!response.writableEnded) execution.abort(); });
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store, no-transform",
          "x-accel-buffering": "no",
        });
        const result = await projectRuntimes.turn(body, event => {
          if (!response.destroyed && !response.writableEnded) {
            response.write(`${JSON.stringify({ type: "progress", event })}\n`);
          }
        }, execution.signal);
        response.end(`${JSON.stringify({ type: "complete", result })}\n`);
        return;
      }
      const result = request.url === "/v2/runtime/ensure" ? await projectRuntimes.ensure(body)
        : request.url === "/v2/runtime/pause" ? await projectRuntimes.pause(body)
            : request.url === "/v2/runtime/resume" ? await projectRuntimes.resume(body)
              : request.url === "/v2/runtime/cancel" ? await projectRuntimes.cancel(body)
                : request.url === "/v2/runtime/destroy" ? await projectRuntimes.destroy(body)
                  : request.url === "/v2/runtime/status" ? await projectRuntimes.status(body)
                    : request.url === "/v2/runtime/list" ? await projectRuntimes.list()
                      : null;
      if (result === null) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(result));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v2/execute") {
      response.writeHead(404).end();
      return;
    }
    if (shuttingDown) throw new Error("Executor is shutting down");
    const plan = validatePlan(JSON.parse((await readRequestBody(request, 2 * 1024 * 1024)).toString("utf8")));
    const execution = new AbortController();
    response.once("close", () => { if (!response.writableEnded) execution.abort(); });
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    });
    const receipt = await trackedExecute(plan, execution, (kind, content) => {
      if (!response.destroyed && !response.writableEnded) {
        response.write(`${JSON.stringify({ type: "progress", event: { kind, content } })}\n`);
      }
    });
    response.end(`${JSON.stringify({ type: "complete", receipt })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Executor failed";
    if (response.headersSent) {
      if (!response.destroyed && !response.writableEnded) response.end(`${JSON.stringify({ type: "error", message })}\n`);
    } else {
      response.writeHead(422, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ code: "EXECUTOR_REJECTED", message }));
    }
  }
});
void start().catch(error => {
  console.error(JSON.stringify({ level: "fatal", event: "executor_start_failed", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});

async function start() {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o750 });
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  await mkdir(secretRoot, { recursive: true, mode: 0o700 });
  await cleanupOrphans();
  await rm(socketPath, { force: true });
  scheduleVaultTokenRenewal();
  installShutdownHandlers();
  server.listen(socketPath, () => void configureSocket());
}

/**
 * The daemon runs as PID 1, where the kernel drops signals that have no handler
 * installed. Without these, SIGTERM is ignored outright and every stop waits the
 * full grace period before Docker resorts to SIGKILL — which also means task
 * containers are abandoned rather than removed.
 */
function installShutdownHandlers() {
  for (const event of ["SIGTERM", "SIGINT"] as const) {
    process.once(event, () => void shutdown(event).catch(error => {
      console.error(JSON.stringify({
        level: "error",
        event: "executor_shutdown_failed",
        message: error instanceof Error ? error.message : "Executor shutdown failed",
      }));
      process.exit(1);
    }));
  }
}

async function shutdown(signalName: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Stop accepting work first so nothing new starts while we unwind.
  const serverClosed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeIdleConnections?.();
  // Aborting each execution removes its task container through the same finally
  // block a cancelled request uses, so no orphan survives the restart.
  for (const execution of liveExecutions) execution.abort();
  await Promise.allSettled([...liveExecutions].map(execution => execution.settled));
  server.closeAllConnections?.();
  await serverClosed;
  await rm(socketPath, { force: true }).catch(() => undefined);
  console.log(JSON.stringify({
    level: "info",
    event: "executor_stopped",
    signal: signalName,
    executorId,
  }));
  process.exit(0);
}

/**
 * Runs an execution while keeping it cancellable from the shutdown path.
 */
async function trackedExecute(
  plan: SandboxPlan,
  execution: AbortController,
  onProgress: (kind: "PHASE" | "AGENT_OUTPUT", content: string) => void,
): Promise<SandboxReceipt> {
  let settle = () => {};
  const entry: LiveExecution = Object.freeze({
    abort: () => execution.abort(),
    settled: new Promise<void>(resolve => { settle = resolve; }),
  });
  liveExecutions.add(entry);
  try {
    return await execute(plan, execution.signal, onProgress);
  } finally {
    liveExecutions.delete(entry);
    settle();
  }
}

function scheduleVaultTokenRenewal() {
  const value = process.env.DEVILUDO_VAULT_TOKEN_RENEW_INTERVAL_SECONDS;
  if (value === undefined || value === "") return;
  if (!/^\d+$/.test(value) || Number(value) < 60 || Number(value) > 86_400) {
    throw new Error("Vault token renewal interval is invalid");
  }
  const timer = setInterval(() => void renewVaultToken().catch(error => {
    console.error(JSON.stringify({
      level: "error",
      event: "vault_token_renewal_failed",
      message: error instanceof Error ? error.message : "Vault token renewal failed",
    }));
  }), Number(value) * 1_000);
  timer.unref();
}

async function renewVaultToken() {
  const vaultAddress = process.env.DEVILUDO_VAULT_ADDR ?? "";
  const tokenFile = process.env.DEVILUDO_VAULT_TOKEN_FILE ?? "";
  const vaultUrl = new URL(vaultAddress);
  if ((vaultUrl.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && vaultUrl.protocol === "http:"))
    || !tokenFile.startsWith("/")) throw new Error("Vault executor configuration is required");
  const token = (await readFile(tokenFile, "utf8")).trim();
  const response = await fetch(new URL("/v1/auth/token/renew-self", vaultUrl), {
    method: "POST",
    headers: { "x-vault-token": token },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Vault token renewal returned ${response.status}`);
}

async function cleanupOrphans() {
  // Project Runtime containers survive executor restarts and are reconciled by
  // generation/fencing. Only disposable task containers are unconditional
  // orphans here.
  const ids = (await docker(["ps", "-aq", "--filter", "label=deviludo.managed=true", "--filter", "label=deviludo.kind=task"], 30_000))
    .split("\n").map(value => value.trim()).filter(Boolean);
  for (const id of ids) await docker(["rm", "-f", id], 30_000);
  for (const root of [workRoot, secretRoot]) {
    for (const entry of await readdir(root)) {
      if (entry.startsWith("job-")) await rm(join(root, entry), { recursive: true, force: true });
    }
  }
}

async function configureSocket() {
  await chmod(socketPath, 0o660);
}

async function executorSmoke() {
  const image = allowlistedImages.values().next().value as string | undefined;
  if (!image) throw new Error("Executor image allowlist is empty");
  const name = `deviludo-smoke-${process.pid}-${Date.now()}`;
  const prepareName = `${name}-volume`;
  const volumeName = `${name}-runtime`;
  let created = false;
  let prepareCreated = false;
  let volumeCreated = false;
  try {
    await docker(["volume", "create", volumeName], 30_000);
    volumeCreated = true;
    await docker([
      "create", "--name", prepareName, "--network=none",
      "--mount", `type=volume,src=${volumeName},dst=/probe-root`,
      "--entrypoint=/bin/mkdir", image, "-p", "/probe-root/runtime-smoke",
    ], 30_000);
    prepareCreated = true;
    await docker(["start", "-a", prepareName], 60_000);
    await docker(["rm", "-f", prepareName], 30_000);
    prepareCreated = false;
    const arguments_ = [
      "create", "--name", name, "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--network=none", "--pids-limit=16",
      `--memory=${microvmRuntime ? "512m" : "64m"}`, "--cpus=0.10", "--entrypoint=/bin/sleep",
      "--mount", `type=volume,src=${volumeName},dst=/runtime-probe,volume-subpath=runtime-smoke`,
    ];
    if (microvmRuntime) arguments_.push(`--runtime=${microvmRuntime}`);
    arguments_.push(microvmSmokeImage || image, "30");
    await docker(arguments_, 30_000);
    created = true;
    await docker(["start", name], 60_000);
    await docker(["pause", name], 30_000);
    await docker(["unpause", name], 30_000);
    return Object.freeze({
      schemaVersion: "deviludo.executor-health.v1",
      executorId,
      isolation: microvmRuntime ? "microvm" : "development-container",
      disposableTask: "started-and-removed",
      projectRuntimePause: "supported",
      projectRuntimeVolumeSubpath: "supported",
    });
  } finally {
    if (created) await docker(["rm", "-f", name], 30_000).catch(() => undefined);
    if (prepareCreated) await docker(["rm", "-f", prepareName], 30_000).catch(() => undefined);
    if (volumeCreated) await docker(["volume", "rm", "-f", volumeName], 30_000).catch(() => undefined);
  }
}

async function execute(
  plan: SandboxPlan,
  signal: AbortSignal,
  onProgress: (kind: "PHASE" | "AGENT_OUTPUT", content: string) => void,
): Promise<SandboxReceipt> {
  const startedAt = new Date().toISOString();
  const taskName = `deviludo-${plan.job.jobId}`;
  const temporary = await mkdtemp(join(workRoot, "job-"));
  const secretDirectory = await mkdtemp(join(secretRoot, "job-"));
  const planFile = join(temporary, "plan.json");
  const steamFile = join(secretDirectory, "steam.json");
  const readyFile = join(temporary, "ready");
  const collectedFile = join(temporary, "collected");
  const inputDirectory = join(temporary, "inputs");
  const sensitiveValues: Buffer[] = [];
  let containerCreated = false;
  const abortTask = () => {
    if (containerCreated) void docker(["rm", "-f", taskName], 30_000).catch(() => undefined);
  };
  signal.addEventListener("abort", abortTask, { once: true });
  try {
    if (signal.aborted) throw new Error("Task execution was cancelled");
    onProgress("PHASE", "正在创建任务级隔离环境");
    await mkdir(inputDirectory, { mode: 0o700 });
    await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });
    await writeFile(readyFile, "ready\n", { mode: 0o600 });
    if (plan.job.jobKind === "STEAM_PUBLISH" && plan.job.runtimeImage !== fixtureAgentImage) {
      const steamConfiguration = await resolveSteamConfiguration(plan);
      const steamSecret = Buffer.from(JSON.stringify(steamConfiguration));
      sensitiveValues.push(
        steamSecret,
        Buffer.from(String(steamConfiguration.username)),
        Buffer.from(String(steamConfiguration.loginToken)),
      );
      await writeFile(steamFile, steamSecret, { mode: 0o600 });
    }
    const network = plan.job.runtimeImage === fixtureAgentImage ? "none"
      : plan.networkPolicy === "STEAM_ONLY" ? process.env.DEVILUDO_EXECUTOR_STEAM_NETWORK ?? "none" : "none";
    const createArguments = [
      "create", "--name", taskName, "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--pids-limit=256",
      `--memory=${Math.max(64 * 1024 * 1024, plan.job.budget.memoryBytes)}`,
      `--cpus=${Math.max(0.1, plan.job.budget.cpuMillis / Math.max(1, plan.job.timeoutSeconds) / 1000).toFixed(2)}`,
      `--tmpfs=/run/deviludo:rw,noexec,nosuid,nodev,size=2m,mode=0700,uid=10001,gid=10001`,
      `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001`,
      `--tmpfs=/workspace:rw,nosuid,nodev,size=2147483648,mode=0700,uid=10001,gid=10001`,
      "--user=10001:10001",
      `--network=${network}`,
      "--label=deviludo.managed=true", `--label=deviludo.executor=${executorId}`,
      "--label=deviludo.kind=task",
      `--label=deviludo.job=${plan.job.jobId}`,
    ];
    if (plan.mode === "MICROVM") createArguments.push(`--runtime=${microvmRuntime}`);
    createArguments.push(plan.job.runtimeImage);
    if (network !== "none") {
      const proxy = plan.networkPolicy === "STEAM_ONLY"
        ? process.env.DEVILUDO_EXECUTOR_STEAM_PROXY ?? ""
        : process.env.DEVILUDO_EXECUTOR_EGRESS_PROXY ?? "";
      if (!proxy.startsWith("http://")) throw new Error("Executor egress proxy is required");
      createArguments.splice(createArguments.length - 1, 0, "--env", `HTTPS_PROXY=${proxy}`, "--env", `HTTP_PROXY=${proxy}`);
    }
    await docker(createArguments, 60_000);
    containerCreated = true;
    if (signal.aborted) throw new Error("Task execution was cancelled");
    for (const input of plan.job.inputObjects) {
      const destination = join(inputDirectory, inputFilename(input));
      const result = await s3.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key }));
      if (!result.Body) throw new Error(`Artifact body is missing: ${input.key}`);
      const content = await streamBuffer(result.Body as Readable, input.sizeBytes);
      if (content.length !== input.sizeBytes) throw new Error(`Artifact size mismatch: ${input.key}`);
      if (`sha256:${createHash("sha256").update(content).digest("hex")}` !== input.sha256) throw new Error(`Artifact digest mismatch: ${input.key}`);
      await writeFile(destination, content, { mode: 0o600 });
    }
    const sourceRelativePath = typeof plan.job.payload.sourceRelativePath === "string"
      ? plan.job.payload.sourceRelativePath
      : null;
    if (sourceRelativePath) {
      const source = await projectSources.archive(sourceRelativePath);
      if (source.digest !== plan.job.payload.sourceDigest) throw new Error("Source revision digest changed");
      await writeFile(join(inputDirectory, "source.tar.gz"), source.bytes, { mode: 0o600 });
    }
    await docker(["start", taskName], 30_000);
    onProgress("PHASE", "隔离环境已启动，正在注入已批准的输入");
    await inject(taskName, "plan", await readFile(planFile));
    for (const input of plan.job.inputObjects) {
      const filename = inputFilename(input);
      await inject(taskName, `input:${filename}`, await readFile(join(inputDirectory, filename)));
    }
    if (sourceRelativePath) await inject(taskName, "input:source.tar.gz", await readFile(join(inputDirectory, "source.tar.gz")));
    if (plan.job.jobKind === "STEAM_PUBLISH" && plan.job.runtimeImage !== fixtureAgentImage) {
      await inject(taskName, "steam", await readFile(steamFile));
    }
    await inject(taskName, "ready", await readFile(readyFile));
    onProgress("PHASE", taskStartedMessage(plan.job.jobKind));
    const taskResult = await waitForTaskResult(taskName, plan.job.timeoutSeconds * 1000, onProgress);
    if (!taskResult.ok) {
      await acknowledgeCollection(taskName, collectedFile);
      await docker(["wait", taskName], 10_000).catch(() => undefined);
      throw new Error(taskResult.error || "Task container failed");
    }
    const manifestRaw = (await dockerRead(["exec", taskName, "/usr/local/bin/deviludo-task-io", "read-manifest"], 30_000, 2 * 1024 * 1024)).toString("utf8");
    const manifest = JSON.parse(manifestRaw) as { outputs?: unknown };
    const steamPublishResult = plan.job.jobKind === "STEAM_PUBLISH"
      ? JSON.parse((await dockerRead([
          "exec", taskName, "/usr/local/bin/deviludo-task-io", "read-output:steam-publish.json",
        ], 5_000, 256 * 1024)).toString("utf8")) as Record<string, unknown>
      : null;
    if (steamPublishResult && !/^\d+$/.test(String(steamPublishResult.buildId ?? ""))) {
      throw new Error("Steam publisher result is invalid");
    }
    const outputObjects = await uploadOutputs(plan, taskName, manifest.outputs, sensitiveValues);
    onProgress("PHASE", taskOutputMessage(plan.job.jobKind));
    await acknowledgeCollection(taskName, collectedFile);
    const wait = await docker(["wait", taskName], 10_000);
    const exitCode = Number(wait.trim());
    if (exitCode !== 0) throw new Error(`Task container exited with ${exitCode}`);
    const finishedAt = new Date().toISOString();
    const identity = await readFile(identityKeyFile, "utf8");
    const isolationProof = signedProof(identity, plan, "isolated");
    const cleanupProof = signedProof(identity, plan, "cleaned");
    const details = Object.freeze({
      taskName,
      runtimeImage: plan.job.runtimeImage,
      outputCount: outputObjects.length,
      ...(steamPublishResult ? {
        steamBuildId: String(steamPublishResult.buildId),
        steamReleaseState: steamPublishResult.state,
        steamReleaseId: steamPublishResult.releaseId,
      } : {}),
    });
    const unsigned = {
      schemaVersion: "deviludo.executor-receipt.v2" as const,
      executorId,
      startedAt,
      finishedAt,
      exitCode,
      simulated: false as const,
      outputObjects,
      details,
      isolationProof,
      cleanupProof,
    };
    const signature = sign(null, executorReceiptSigningPayload(unsigned), identity).toString("base64url");
    return Object.freeze({ ...unsigned, signature });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Executor task failed";
    throw new Error(redactSensitive(message, sensitiveValues));
  } finally {
    signal.removeEventListener("abort", abortTask);
    if (containerCreated) await docker(["rm", "-f", taskName], 30_000).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
    await rm(secretDirectory, { recursive: true, force: true });
  }
}

function taskStartedMessage(kind: SandboxPlan["job"]["jobKind"]): string {
  if (kind === "BUILD") return "Builder 已开始验证并构建项目";
  if (kind === "STEAM_PUBLISH") return "Steam Publisher 已开始执行已登记的发布操作";
  return "任务已开始";
}

function taskOutputMessage(kind: SandboxPlan["job"]["jobKind"]): string {
  if (kind === "BUILD") return "构建结果已完成，正在上传并校验制品";
  if (kind === "STEAM_PUBLISH") return "发布回执已生成，正在上传并校验";
  return "任务结果已完成，正在上传并校验";
}

async function waitForTaskResult(
  taskName: string,
  timeout: number,
  onProgress: (kind: "PHASE" | "AGENT_OUTPUT", content: string) => void,
) {
  const deadline = Date.now() + timeout;
  let progressBytes = 0;
  let progressLineBuffer = "";
  while (Date.now() < deadline) {
    try {
      const progress = await dockerRead(
        ["exec", taskName, "/usr/local/bin/deviludo-task-io", "read-progress"],
        5_000,
        1024 * 1024,
      );
      if (progress.length > progressBytes) {
        const appended = progress.subarray(progressBytes).toString("utf8");
        progressBytes = progress.length;
        const lines = `${progressLineBuffer}${appended}`.split(/\r?\n/);
        progressLineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { kind?: unknown; content?: unknown };
          if ((event.kind === "PHASE" || event.kind === "AGENT_OUTPUT") && typeof event.content === "string") {
            onProgress(event.kind, event.content.slice(0, 4_000));
          }
        }
      }
    } catch {
      // The task creates its progress file after startup.
    }
    try {
      const content = await dockerRead(["exec", taskName, "/usr/local/bin/deviludo-task-io", "read-result"], 5_000, 4 * 1024);
      const parsed = JSON.parse(content.toString("utf8")) as { ok?: unknown; error?: unknown };
      if (typeof parsed.ok !== "boolean" || (parsed.error !== null && typeof parsed.error !== "string")) {
        throw new Error("Task result is malformed");
      }
      return { ok: parsed.ok, error: typeof parsed.error === "string" ? parsed.error : null };
    } catch (error) {
      if (error instanceof Error && error.message === "Task result is malformed") throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error("Task container exceeded its timeout");
}

async function readRequestBody(request: import("node:http").IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Executor request is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function acknowledgeCollection(taskName: string, collectedFile: string) {
  await writeFile(collectedFile, "collected\n", { mode: 0o600 });
  await inject(taskName, "collected", await readFile(collectedFile));
}

async function inject(taskName: string, target: string, content: Buffer) {
  await docker(["exec", "-i", taskName, "/usr/local/bin/deviludo-task-io", target], 60_000, content);
}

async function uploadOutputs(plan: SandboxPlan, taskName: string, raw: unknown, sensitiveValues: readonly Buffer[]) {
  if (!Array.isArray(raw) || raw.length < 1) throw new Error("Task output manifest is empty");
  const outputs = [];
  let total = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Task output manifest is invalid");
    const item = entry as Record<string, unknown>;
    const file = typeof item.file === "string" && /^[A-Za-z0-9._-]+$/.test(item.file) ? item.file : "";
    const kind = typeof item.kind === "string" ? item.kind : "";
    if (!file || !kind) throw new Error("Task output file or kind is invalid");
    if (!plan.job.outputContract.kinds.includes(kind)) throw new Error(`Task output kind is not allowed: ${kind}`);
    const remaining = plan.job.outputContract.maxBytes - total;
    const content = await dockerRead(["exec", taskName, "/usr/local/bin/deviludo-task-io", `read-output:${file}`], 60_000, remaining);
    if (sensitiveValues.some(secret => secret.length >= 8 && content.includes(secret))) {
      throw new Error("Task output contains injected credentials");
    }
    total += content.length;
    if (total > plan.job.outputContract.maxBytes) throw new Error("Task outputs exceed the contract budget");
    const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}` as const;
    const key = `${plan.objectPrefix}/${file}`;
    const bucket = process.env.DEVILUDO_ARTIFACT_BUCKET ?? "deviludo-artifacts";
    const contentType = outputContentType(kind);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: content,
      ContentType: contentType,
      Metadata: { sha256 },
    }));
    outputs.push(Object.freeze({
      kind,
      ...(typeof item.targetPlatform === "string"
        ? { targetPlatform: item.targetPlatform as "linux" | "windows" | "macos" }
        : {}),
      bucket,
      key,
      sha256,
      sizeBytes: content.length,
      metadata: Object.freeze({ contentType }),
    }));
  }
  return Object.freeze(outputs);
}

function outputContentType(kind: string): string {
  if (kind === "BUILD" || kind === "SIGNED_BUILD") return "application/gzip";
  if (kind === "E2E_REPORT") return "application/zip";
  return "application/json";
}

function validatePlan(value: unknown): SandboxPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sandbox plan must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== "deviludo.sandbox-plan.v2" || !raw.job) throw new Error("Unsupported sandbox protocol");
  const job = parseJobProtocolV4(raw.job);
  const plan = Object.freeze({ ...raw, job }) as unknown as SandboxPlan;
  if (job.poolKind !== "CORE" || job.exclusive
    || !["BUILD", "STEAM_PUBLISH"].includes(job.jobKind)) {
    throw new Error("Executor accepts only non-exclusive Core jobs");
  }
  if (!allowlistedImages.has(plan.job.runtimeImage)) throw new Error("Runtime image is not in the signed release allowlist");
  const expectedMode = "RESTRICTED_CONTAINER";
  if (plan.mode !== expectedMode) {
    throw new Error("Sandbox isolation mode does not satisfy the job contract");
  }
  const expectedNetwork = job.jobKind === "STEAM_PUBLISH" ? "STEAM_ONLY" : "BUILD_EGRESS_DENY";
  if (plan.networkPolicy !== expectedNetwork) throw new Error("Sandbox network policy does not satisfy the job contract");
  const objectPrefix = `workspaces/${job.workspaceId}/projects/${job.projectId}/`;
  if (plan.objectPrefix !== `${objectPrefix}jobs/${job.jobId}`
    || plan.workspace !== `/var/lib/deviludo/workspaces/${job.workspaceId}/${job.projectId}/${job.jobId}/g${job.isolationGeneration}`
    || plan.vaultPath !== `workspaces/${job.workspaceId}/projects/${job.projectId}/jobs/${job.jobId}`) {
    throw new Error("Sandbox paths escape the workspace/project boundary");
  }
  const bucket = process.env.DEVILUDO_ARTIFACT_BUCKET ?? "deviludo-artifacts";
  if (job.inputObjects.some(input => input.bucket !== bucket || !input.key.startsWith(objectPrefix))) {
    throw new Error("Input object escapes the executor artifact boundary");
  }
  if (new Set(job.inputObjects.map(inputFilename)).size !== job.inputObjects.length) {
    throw new Error("Input object filenames collide inside the task workspace");
  }
  const assetInputs = job.inputObjects.filter(input => input.kind === "ASSET");
  if ((job.jobKind !== "BUILD" && assetInputs.length > 0)
    || job.inputObjects.some(input => input.kind !== "ASSET" && input.assetKey !== undefined)
    || assetInputs.some(input => typeof input.assetKey !== "string"
      || !input.key.startsWith(`${objectPrefix}assets/`)
      || !/\.(?:png|jpg|webp|mp3|ogg|wav)$/.test(input.key))
    || new Set(assetInputs.map(input => input.assetKey)).size !== assetInputs.length) {
    throw new Error("Build asset inputs do not satisfy the fixed materialization contract");
  }
  const bindingId = job.payload.localDirectoryBindingId;
  if (bindingId !== undefined && bindingId !== null) {
    throw new Error("Local project bindings are mounted only into persistent Project Runtimes");
  }
  if (job.inputObjects.reduce((sum, input) => sum + input.sizeBytes, 0) > 2_147_483_648) {
    throw new Error("Task inputs exceed the fixed executor limit");
  }
  if (job.jobKind === "STEAM_PUBLISH") {
    const operation = job.payload.operation;
    if (!operation || typeof operation !== "object" || Array.isArray(operation)
      || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String((operation as Record<string, unknown>).id ?? ""))) {
      throw new Error("Steam publish operation registration is required");
    }
  }
  if (Date.parse(job.lease.expiresAt) <= Date.now()) throw new Error("Job lease expired before execution");
  return plan;
}

function inputFilename(input: SandboxPlan["job"]["inputObjects"][number]): string {
  if (input.kind !== "ASSET") return basename(input.key);
  const extension = input.key.match(/\.(png|jpg|webp|mp3|ogg|wav)$/)?.[1];
  if (!extension) throw new Error("Build asset object extension is invalid");
  return `asset-${createHash("sha256").update(input.key).digest("hex")}.${extension}`;
}

async function resolveSecret(reference: string): Promise<string> {
  const prefix = "vault://instance/agent-runtime/api-key/versions/";
  if (!reference.startsWith(prefix)) throw new Error("Executor secret reference is invalid");
  const version = reference.slice(prefix.length);
  if (!/^[0-9a-f-]{36}$/i.test(version)) throw new Error("Executor secret version is invalid");
  const localRoot = process.env.DEVILUDO_AGENT_SECRET_ROOT;
  if (localRoot) return readFile(join(localRoot, "instance", "agent-runtime", "api-key", "versions", `${version}.key`), "utf8");
  const vaultAddress = process.env.DEVILUDO_VAULT_ADDR ?? "";
  const tokenFile = process.env.DEVILUDO_VAULT_TOKEN_FILE ?? "";
  const vaultUrl = new URL(vaultAddress);
  if ((vaultUrl.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && vaultUrl.protocol === "http:"))
    || !tokenFile.startsWith("/")) throw new Error("Vault executor configuration is required");
  const token = (await readFile(tokenFile, "utf8")).trim();
  const response = await fetch(new URL(`/v1/secret/data/deviludo/instance/agent-runtime/api-key/versions/${version}`, vaultAddress), {
    headers: { "x-vault-token": token }, signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Vault returned ${response.status}`);
  const body = await response.json() as { data?: { data?: { value?: unknown } } };
  if (typeof body.data?.data?.value !== "string") throw new Error("Vault secret payload is invalid");
  return body.data.data.value;
}

async function resolveSteamConfiguration(plan: SandboxPlan) {
  const raw = plan.job.payload.steamRelease;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Steam release snapshot is missing");
  }
  const release = raw as Record<string, unknown>;
  const credentialRef = String(release.credentialRef ?? "");
  const prefix = `vault://workspaces/${plan.job.workspaceId}/steam/build-token/versions/`;
  if (!credentialRef.startsWith(prefix) || !/^[0-9a-f-]{36}$/i.test(credentialRef.slice(prefix.length))) {
    throw new Error("Steam credential reference is invalid");
  }
  const loginToken = await resolveWorkspaceSteamSecret(plan.job.workspaceId, credentialRef);
  const rawDepots = release.depots && typeof release.depots === "object" && !Array.isArray(release.depots)
    ? release.depots as Record<string, unknown>
    : {};
  const configuration = {
    username: release.builderUsername,
    loginToken,
    appId: String(release.appId ?? ""),
    depots: {
      linux: rawDepots.linux === null || rawDepots.linux === undefined ? undefined : String(rawDepots.linux),
      windows: rawDepots.windows === null || rawDepots.windows === undefined ? undefined : String(rawDepots.windows),
      macos: rawDepots.macos === null || rawDepots.macos === undefined ? undefined : String(rawDepots.macos),
    },
    releaseId: String(release.releaseId ?? ""),
    version: String(release.version ?? ""),
    releaseNumber: Number(release.releaseNumber),
    channel: release.channel,
    targetBranch: release.targetBranch,
  };
  const requiredPlatforms = Array.isArray(plan.job.payload.targetPlatforms)
    ? plan.job.payload.targetPlatforms.map(String)
    : [];
  if (typeof configuration.username !== "string" || typeof configuration.loginToken !== "string"
    || !/^\d{1,12}$/.test(configuration.appId ?? "")
    || requiredPlatforms.length < 1
    || requiredPlatforms.some(platform => !/^\d{1,12}$/.test(configuration.depots[platform as keyof typeof configuration.depots] ?? ""))
    || !/^[0-9a-f-]{36}$/i.test(configuration.releaseId)
    || !Number.isSafeInteger(configuration.releaseNumber) || configuration.releaseNumber < 1
    || !["TEST", "DEFAULT"].includes(String(configuration.channel))
    || typeof configuration.targetBranch !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(configuration.targetBranch)) {
    throw new Error("Steam publisher credentials or depot configuration is invalid");
  }
  return Object.freeze(configuration);
}

async function resolveWorkspaceSteamSecret(workspaceId: string, reference: string): Promise<string> {
  const prefix = `vault://workspaces/${workspaceId}/steam/build-token/versions/`;
  const version = reference.slice(prefix.length);
  const localRoot = process.env.DEVILUDO_AGENT_SECRET_ROOT;
  if (localRoot) {
    return readFile(join(localRoot, "workspaces", workspaceId, "steam", "build-token", "versions", `${version}.key`), "utf8");
  }
  const value = await readVaultSecret(`secret/data/deviludo/workspaces/${workspaceId}/steam/build-token/versions/${version}`);
  if (typeof value.value !== "string") throw new Error("Vault Steam credential payload is invalid");
  return value.value;
}

async function readVaultSecret(path: string): Promise<Record<string, unknown>> {
  const vaultAddress = process.env.DEVILUDO_VAULT_ADDR ?? "";
  const tokenFile = process.env.DEVILUDO_VAULT_TOKEN_FILE ?? "";
  const vaultUrl = new URL(vaultAddress);
  if ((vaultUrl.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && vaultUrl.protocol === "http:"))
    || !tokenFile.startsWith("/") || !/^secret\/data\/deviludo\/[A-Za-z0-9/_-]+$/.test(path)) {
    throw new Error("Vault executor configuration is required");
  }
  const token = (await readFile(tokenFile, "utf8")).trim();
  const response = await fetch(new URL(`/v1/${path}`, vaultAddress), {
    headers: { "x-vault-token": token }, signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Vault returned ${response.status}`);
  const body = await response.json() as { data?: { data?: Record<string, unknown> } };
  if (!body.data?.data) throw new Error("Vault secret payload is invalid");
  return body.data.data;
}

async function docker(
  arguments_: readonly string[],
  timeout: number,
  input?: Buffer,
  options: Readonly<{ signal?: AbortSignal; onStderr?: (chunk: string) => void }> = {},
): Promise<string> {
  const child = spawn("docker", arguments_, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    signal: options.signal,
    env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: process.env.NODE_ENV ?? "production" },
  });
  child.stdin.end(input);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", chunk => {
    const value = Buffer.from(chunk);
    stderr.push(value);
    options.onStderr?.(value.toString("utf8"));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  if (code !== 0) {
    const diagnostic = Buffer.concat(stderr).toString("utf8").trim()
      || Buffer.concat(stdout).toString("utf8").trim()
      || "Docker CLI returned no diagnostic output";
    throw new Error(`Docker executor operation failed (exit ${code ?? "signal"}): ${diagnostic.slice(0, 2000)}`);
  }
  return Buffer.concat(stdout).toString("utf8");
}

async function dockerRead(arguments_: readonly string[], timeout: number, maxBytes: number): Promise<Buffer> {
  const child = spawn("docker", arguments_, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: process.env.NODE_ENV ?? "production" },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let exceeded = false;
  child.stdout.on("data", chunk => {
    bytes += chunk.length;
    if (bytes <= maxBytes) stdout.push(Buffer.from(chunk));
    else { exceeded = true; child.kill("SIGKILL"); }
  });
  child.stderr.on("data", chunk => {
    if (Buffer.concat(stderr).length < 65_536) stderr.push(Buffer.from(chunk));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  if (exceeded) throw new Error("Task output exceeds its fixed limit");
  if (code !== 0) throw new Error(`Docker executor read failed: ${Buffer.concat(stderr).toString("utf8").slice(0, 2000)}`);
  return Buffer.concat(stdout);
}

async function streamBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("Artifact exceeds its declared size or job budget");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function redactSensitive(message: string, sensitiveValues: readonly Buffer[]): string {
  let safe = message;
  for (const value of sensitiveValues) {
    const secret = value.toString("utf8");
    if (secret.length >= 4) safe = safe.replaceAll(secret, "[REDACTED]");
  }
  return safe
    .replace(/\b(sk|key|token)-[A-Za-z0-9._-]{8,}\b/gi, "$1-[REDACTED]")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[REDACTED]")
    .slice(0, 2_000);
}

function signedProof(identity: string, plan: SandboxPlan, stage: string): string {
  const payload = `${stage}:${plan.job.jobId}:${plan.job.isolationGeneration}:${plan.job.lease.fencingToken}`;
  return `${stage}:ed25519:${sign(null, Buffer.from(payload), identity).toString("base64url")}`;
}
