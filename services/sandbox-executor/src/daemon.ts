import { spawn } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { SandboxPlan, SandboxReceipt } from "@/services/core/src/sandbox";
import { executorReceiptSigningPayload, parseJobProtocolV4 } from "@/services/core/src/contracts";
import { ProjectSourceStore, type PublishedSourceRevision } from "@/services/core/src/project-sources";
import { createTarGzip } from "@/services/core/src/project-import";
import { decideAgentCheckpointRestore } from "./checkpoint-restore";
import { validateAgentBaselineSourceReference, validateAgentSourceReference } from "./source-revision";

const socketPath = process.env.DEVILUDO_EXECUTOR_SOCKET ?? "/run/deviludo-executor/executor.sock";
const executorId = process.env.DEVILUDO_EXECUTOR_ID ?? "";
const identityKeyFile = process.env.DEVILUDO_EXECUTOR_IDENTITY_KEY_FILE ?? "";
const allowlistedImages = new Set((process.env.DEVILUDO_EXECUTOR_ALLOWED_IMAGES ?? "").split(",").filter(Boolean));
const providerHosts = new Set((process.env.DEVILUDO_PROVIDER_ALLOWLIST ?? "api.anthropic.com,api.openai.com,chatgpt.com").split(",").map(value => value.trim()).filter(Boolean));
const workRoot = process.env.DEVILUDO_EXECUTOR_WORK_ROOT ?? "/var/lib/deviludo-executor";
const secretRoot = process.env.DEVILUDO_EXECUTOR_SECRET_ROOT ?? "/run/deviludo-secrets";
const projectsRoot = process.env.DEVILUDO_PROJECTS_ROOT ?? "/var/lib/deviludo-projects";
const projectSources = new ProjectSourceStore(projectsRoot);
const localProjectBridgeUrl = process.env.DEVILUDO_LOCAL_PROJECT_BRIDGE_INTERNAL_URL ?? "";
const localProjectBridgeToken = process.env.DEVILUDO_LOCAL_PROJECT_BRIDGE_TOKEN ?? "";
const microvmRuntime = process.env.DEVILUDO_EXECUTOR_MICROVM_RUNTIME ?? "";
const microvmSmokeImage = process.env.DEVILUDO_EXECUTOR_MICROVM_SMOKE_IMAGE ?? "";
const developmentContainersAllowed = process.env.NODE_ENV !== "production"
  && process.env.DEVILUDO_EXECUTOR_ALLOW_DEVELOPMENT_CONTAINER === "1";
const fixtureAgentImage = developmentContainersAllowed
  && allowlistedImages.has(process.env.DEVILUDO_EXECUTOR_FIXTURE_AGENT_IMAGE ?? "")
  ? process.env.DEVILUDO_EXECUTOR_FIXTURE_AGENT_IMAGE ?? ""
  : "";
const activeTasks = new Map<string, string>();
/**
 * In-flight executions, so a shutdown can abort them deliberately instead of
 * being killed with their task containers still running.
 */
type LiveExecution = Readonly<{ abort: () => void; settled: Promise<void> }>;
const liveExecutions = new Set<LiveExecution>();
let shuttingDown = false;
if (!executorId || !identityKeyFile || allowlistedImages.size < 1
  || !workRoot.startsWith("/var/lib/deviludo-executor") || secretRoot !== "/run/deviludo-secrets") {
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
    if (request.method === "POST" && request.url === "/v2/guidance") {
      const body = JSON.parse((await readRequestBody(request, 16 * 1024)).toString("utf8")) as Record<string, unknown>;
      const jobId = typeof body.jobId === "string" && /^[0-9a-f-]{36}$/i.test(body.jobId) ? body.jobId : "";
      const content = typeof body.content === "string" ? body.content.replaceAll(/\u0000/g, "").trim() : "";
      const taskName = activeTasks.get(jobId);
      if (!jobId || content.length < 2 || content.length > 4_000 || !taskName) {
        throw new Error("Active Agent task guidance is invalid");
      }
      await inject(taskName, "guidance", Buffer.from(`${JSON.stringify({ content, receivedAt: new Date().toISOString() })}\n`));
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ accepted: true }));
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
  await new Promise<void>(resolve => server.close(() => resolve()));
  // Aborting each execution removes its task container through the same finally
  // block a cancelled request uses, so no orphan survives the restart.
  for (const execution of liveExecutions) execution.abort();
  await Promise.allSettled([...liveExecutions].map(execution => execution.settled));
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
  const ids = (await docker(["ps", "-aq", "--filter", "label=deviludo.managed=true"], 30_000))
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
  let created = false;
  try {
    const arguments_ = [
      "create", "--name", name, "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--network=none", "--pids-limit=16",
      `--memory=${microvmRuntime ? "512m" : "64m"}`, "--cpus=0.10", "--entrypoint=/bin/true",
    ];
    if (microvmRuntime) arguments_.push(`--runtime=${microvmRuntime}`);
    arguments_.push(microvmSmokeImage || image);
    await docker(arguments_, 30_000);
    created = true;
    await docker(["start", "-a", name], 60_000);
    return Object.freeze({
      schemaVersion: "deviludo.executor-health.v1",
      executorId,
      isolation: microvmRuntime ? "microvm" : "development-container",
      disposableTask: "started-and-removed",
    });
  } finally {
    if (created) await docker(["rm", "-f", name], 30_000).catch(() => undefined);
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
  const secretFile = join(secretDirectory, "provider.key");
  const steamFile = join(secretDirectory, "steam.json");
  const readyFile = join(temporary, "ready");
  const collectedFile = join(temporary, "collected");
  const inputDirectory = join(temporary, "inputs");
  const sensitiveValues: Buffer[] = [];
  let containerCreated = false;
  let localDirectoryBaseDigest: string | null = null;
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
    if (plan.agentConfiguration && plan.job.runtimeImage !== fixtureAgentImage) {
      const providerSecret = Buffer.from(await resolveSecret(plan.agentConfiguration.credentialRef));
      sensitiveValues.push(providerSecret);
      await writeFile(secretFile, providerSecret, { mode: 0o600 });
    }
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
    const network = plan.job.runtimeImage === fixtureAgentImage ? "none" : plan.networkPolicy === "AGENT_EGRESS_ALLOWLIST"
      ? process.env.DEVILUDO_EXECUTOR_AGENT_NETWORK ?? "none"
      : plan.networkPolicy === "STEAM_ONLY" ? process.env.DEVILUDO_EXECUTOR_STEAM_NETWORK ?? "none" : "none";
    const createArguments = [
      "create", "--name", taskName, "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--pids-limit=256",
      `--memory=${Math.max(64 * 1024 * 1024, plan.job.budget.memoryBytes)}`,
      `--cpus=${Math.max(plan.job.jobKind === "AGENT_GENERATION" ? 0.5 : 0.1, plan.job.budget.cpuMillis / Math.max(1, plan.job.timeoutSeconds) / 1000).toFixed(2)}`,
      `--tmpfs=/run/deviludo:rw,noexec,nosuid,nodev,size=2m,mode=0700,uid=10001,gid=10001`,
      `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001`,
      `--tmpfs=/workspace:rw,nosuid,nodev,size=2147483648,mode=0700,uid=10001,gid=10001`,
      "--user=10001:10001",
      `--network=${network}`,
      "--label=deviludo.managed=true", `--label=deviludo.job=${plan.job.jobId}`,
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
    activeTasks.set(plan.job.jobId, taskName);
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
    const baselineSourceRelativePath = plan.job.jobKind === "AGENT_GENERATION"
      && typeof plan.job.payload.baselineSourceRelativePath === "string"
      ? plan.job.payload.baselineSourceRelativePath
      : null;
    const specificationDigest = plan.job.inputObjects.find(input => input.kind === "SPECIFICATION")?.sha256 ?? null;
    let inputSourceDigest = typeof plan.job.payload.sourceDigest === "string"
      ? plan.job.payload.sourceDigest
      : null;
    if (sourceRelativePath) {
      const localDirectoryBindingId = localBindingId(plan);
      if (localDirectoryBindingId) {
        const live = await readLocalProjectSource(localDirectoryBindingId);
        const files = parseSourceStream(live.source);
        localDirectoryBaseDigest = live.digest;
        inputSourceDigest = live.digest;
        await writeFile(join(inputDirectory, "source.tar.gz"), createTarGzip(files), { mode: 0o600 });
        onProgress("PHASE", `已读取绑定目录中的 ${files.length} 个最新源码文件`);
      } else {
        const source = await projectSources.archive(sourceRelativePath);
        if (source.digest !== plan.job.payload.sourceDigest) throw new Error("Source revision digest changed");
        await writeFile(join(inputDirectory, "source.tar.gz"), source.bytes, { mode: 0o600 });
      }
    }
    if (baselineSourceRelativePath) {
      const baseline = await projectSources.archive(baselineSourceRelativePath);
      if (baseline.digest !== plan.job.payload.baselineSourceDigest) throw new Error("Baseline source revision digest changed");
      await writeFile(join(inputDirectory, "baseline-source.tar.gz"), baseline.bytes, { mode: 0o600 });
    }
    let checkpoint = plan.job.jobKind === "AGENT_GENERATION"
      ? await projectSources.archiveCheckpoint(plan.job.workspaceId, plan.job.projectId, plan.job.workflowId)
      : null;
    if (checkpoint) {
      const restoreDecision = decideAgentCheckpointRestore({
        checkpoint,
        jobId: plan.job.jobId,
        specificationDigest,
        inputSourceDigest,
        localDirectoryBaseDigest,
      });
      if (restoreDecision.action === "REJECT_CURRENT_JOB") {
        throw new Error(restoreDecision.reason);
      }
      if (restoreDecision.action === "DISCARD_STALE") {
        await projectSources.deleteCheckpoint(plan.job.workspaceId, plan.job.projectId, plan.job.workflowId);
        onProgress("PHASE", "已丢弃输入不匹配的旧任务检查点，将从当前源码重新开始");
        checkpoint = null;
      }
    }
    if (checkpoint) {
      await writeFile(join(inputDirectory, "checkpoint.tar.gz"), checkpoint.bytes, { mode: 0o600 });
    }
    await docker(["start", taskName], 30_000);
    onProgress("PHASE", "隔离环境已启动，正在注入已批准的输入");
    await inject(taskName, "plan", await readFile(planFile));
    for (const input of plan.job.inputObjects) {
      const filename = inputFilename(input);
      await inject(taskName, `input:${filename}`, await readFile(join(inputDirectory, filename)));
    }
    if (sourceRelativePath) await inject(taskName, "input:source.tar.gz", await readFile(join(inputDirectory, "source.tar.gz")));
    if (baselineSourceRelativePath) {
      await inject(taskName, "input:baseline-source.tar.gz", await readFile(join(inputDirectory, "baseline-source.tar.gz")));
      onProgress("PHASE", "已提供工作流起点的只读源码基线，用于防止修复误删既有实现");
    }
    if (checkpoint) {
      await inject(taskName, "input:checkpoint.tar.gz", await readFile(join(inputDirectory, "checkpoint.tar.gz")));
      await inject(taskName, "input:checkpoint.json", Buffer.from(JSON.stringify({
        schemaVersion: "deviludo.source-checkpoint.v1",
        state: checkpoint.state,
        originJobId: checkpoint.originJobId,
        specificationDigest: checkpoint.specificationDigest,
        sourceDigest: checkpoint.sourceDigest,
        localDirectoryBaseDigest: checkpoint.localDirectoryBaseDigest,
      })));
      onProgress("PHASE", checkpoint.state === "AGENT_COMPLETE" && checkpoint.originJobId === plan.job.jobId
        ? `已恢复本任务完成的 ${checkpoint.fileCount} 个源码文件，将跳过重复生成`
        : `已恢复上次尝试保存的 ${checkpoint.fileCount} 个源码文件`);
    }
    if (plan.agentConfiguration && plan.job.runtimeImage !== fixtureAgentImage) {
      await inject(taskName, "provider", await readFile(secretFile));
    }
    if (plan.job.jobKind === "STEAM_PUBLISH" && plan.job.runtimeImage !== fixtureAgentImage) {
      await inject(taskName, "steam", await readFile(steamFile));
    }
    await inject(taskName, "ready", await readFile(readyFile));
    onProgress("PHASE", taskStartedMessage(plan.job.jobKind));
    let taskResult: Awaited<ReturnType<typeof waitForTaskResult>>;
    try {
      taskResult = await waitForTaskResult(taskName, plan.job.timeoutSeconds * 1000, onProgress);
    } catch (error) {
      if (plan.job.jobKind === "AGENT_GENERATION") {
        await saveAgentCheckpoint(taskName, plan, "PARTIAL", {
          specificationDigest,
          sourceDigest: inputSourceDigest,
          localDirectoryBaseDigest,
        }, onProgress).catch(() => undefined);
      }
      throw error;
    }
    if (!taskResult.ok) {
      if (plan.job.jobKind === "AGENT_GENERATION") {
        await saveAgentCheckpoint(taskName, plan, "PARTIAL", {
          specificationDigest,
          sourceDigest: inputSourceDigest,
          localDirectoryBaseDigest,
        }, onProgress).catch(() => undefined);
      }
      await acknowledgeCollection(taskName, collectedFile);
      await docker(["wait", taskName], 10_000).catch(() => undefined);
      throw new Error(taskResult.error || "Task container failed");
    }
    const manifestRaw = (await dockerRead(["exec", taskName, "/usr/local/bin/deviludo-task-io", "read-manifest"], 30_000, 2 * 1024 * 1024)).toString("utf8");
    const manifest = JSON.parse(manifestRaw) as { outputs?: unknown };
    let sourceRevision: PublishedSourceRevision | null = null;
    if (plan.job.jobKind === "AGENT_GENERATION") {
      const revision = Number(plan.job.payload.publishSourceRevision);
      if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Agent source publication revision is missing");
      const sourceStream = await dockerRead([
        "exec", taskName, "/usr/local/bin/deviludo-task-io", "read-source",
      ], 60_000, Number.MAX_SAFE_INTEGER);
      const generatedFiles = parseSourceStream(sourceStream);
      await projectSources.saveCheckpoint({
        workspaceId: plan.job.workspaceId,
        projectId: plan.job.projectId,
        workflowId: plan.job.workflowId,
        files: generatedFiles,
        state: "AGENT_COMPLETE",
        originJobId: plan.job.jobId,
        specificationDigest,
        sourceDigest: inputSourceDigest,
        localDirectoryBaseDigest,
      });
      onProgress("PHASE", `已保存 ${generatedFiles.length} 个完成态源码文件，正在安全登记结果`);
      const localDirectoryBindingId = localBindingId(plan);
      if (localDirectoryBindingId) {
        if (!localDirectoryBaseDigest) throw new Error("Local project directory baseline is missing");
        try {
          await syncLocalProjectSource(localDirectoryBindingId, localDirectoryBaseDigest, sourceStream);
          onProgress("PHASE", `Agent 修改已安全写回绑定的本地项目目录`);
        } catch (error) {
          throw error;
        }
      }
      sourceRevision = await projectSources.publishFiles({
        workspaceId: plan.job.workspaceId,
        projectId: plan.job.projectId,
        revision,
        files: generatedFiles,
      });
    }
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
      ...(sourceRevision ? { sourceRevision } : {}),
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
    activeTasks.delete(plan.job.jobId);
    signal.removeEventListener("abort", abortTask);
    if (containerCreated) await docker(["rm", "-f", taskName], 30_000).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
    await rm(secretDirectory, { recursive: true, force: true });
  }
}

async function saveAgentCheckpoint(
  taskName: string,
  plan: SandboxPlan,
  state: "PARTIAL" | "AGENT_COMPLETE",
  metadata: Readonly<{
    specificationDigest: string | null;
    sourceDigest: string | null;
    localDirectoryBaseDigest: string | null;
  }>,
  onProgress: (kind: "PHASE" | "AGENT_OUTPUT", content: string) => void,
) {
  const sourceStream = await dockerRead([
    "exec", taskName, "/usr/local/bin/deviludo-task-io", "read-source",
  ], 60_000, Number.MAX_SAFE_INTEGER);
  const saved = await projectSources.saveCheckpoint({
    workspaceId: plan.job.workspaceId,
    projectId: plan.job.projectId,
    workflowId: plan.job.workflowId,
    files: parseSourceStream(sourceStream),
    state,
    originJobId: plan.job.jobId,
    ...metadata,
  });
  onProgress("PHASE", state === "AGENT_COMPLETE"
    ? `已保存 ${saved.fileCount} 个完成态源码文件，重试不会再次调用模型`
    : `本次已保存 ${saved.fileCount} 个源码文件；重试将从检查点继续`);
  return saved;
}

function taskStartedMessage(kind: SandboxPlan["job"]["jobKind"]): string {
  if (kind === "ARTIFACT_BUILD") return "Builder 已开始验证并构建项目";
  if (kind === "STEAM_PUBLISH") return "Steam Publisher 已开始执行已登记的发布操作";
  if (kind === "PROJECT_DOCUMENT_MAINTENANCE") return "Agent 已开始维护项目说明";
  return "Agent 已开始生成项目";
}

function taskOutputMessage(kind: SandboxPlan["job"]["jobKind"]): string {
  if (kind === "ARTIFACT_BUILD") return "构建结果已完成，正在上传并校验制品";
  if (kind === "STEAM_PUBLISH") return "发布回执已生成，正在上传并校验";
  if (kind === "PROJECT_DOCUMENT_MAINTENANCE") return "项目说明已更新，正在上传并校验";
  return "生成结果已完成，正在上传并校验制品";
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
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content, Metadata: { sha256 } }));
    outputs.push(Object.freeze({
      kind,
      ...(typeof item.targetPlatform === "string"
        ? { targetPlatform: item.targetPlatform as "linux" | "windows" | "macos" }
        : {}),
      bucket,
      key,
      sha256,
      sizeBytes: content.length,
      metadata: Object.freeze({ contentType: typeof item.contentType === "string" ? item.contentType : "application/octet-stream" }),
    }));
  }
  return Object.freeze(outputs);
}

function validatePlan(value: unknown): SandboxPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sandbox plan must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== "deviludo.sandbox-plan.v2" || !raw.job) throw new Error("Unsupported sandbox protocol");
  const job = parseJobProtocolV4(raw.job);
  const plan = Object.freeze({ ...raw, job }) as unknown as SandboxPlan;
  if (job.poolKind !== "CORE" || job.exclusive
    || !["AGENT_GENERATION", "PROJECT_DOCUMENT_MAINTENANCE", "ARTIFACT_BUILD", "STEAM_PUBLISH"].includes(job.jobKind)) {
    throw new Error("Executor accepts only non-exclusive Core jobs");
  }
  if (!allowlistedImages.has(plan.job.runtimeImage)) throw new Error("Runtime image is not in the signed release allowlist");
  const agentJob = job.jobKind === "AGENT_GENERATION" || job.jobKind === "PROJECT_DOCUMENT_MAINTENANCE";
  const expectedMode = agentJob && !developmentContainersAllowed
    ? "MICROVM"
    : "RESTRICTED_CONTAINER";
  if (plan.mode !== expectedMode || (plan.mode === "MICROVM" && !microvmRuntime)) {
    throw new Error("Sandbox isolation mode does not satisfy the job contract");
  }
  const expectedNetwork = agentJob
    ? "AGENT_EGRESS_ALLOWLIST"
    : job.jobKind === "STEAM_PUBLISH" ? "STEAM_ONLY" : "BUILD_EGRESS_DENY";
  if (plan.networkPolicy !== expectedNetwork) throw new Error("Sandbox network policy does not satisfy the job contract");
  if (agentJob) {
    if (!plan.agentConfiguration) throw new Error("Agent configuration is required");
    const providerUrl = new URL(plan.agentConfiguration.baseUrl);
    if (providerUrl.protocol !== "https:"
      || (job.runtimeImage !== fixtureAgentImage && !providerHosts.has(providerUrl.hostname))) {
      throw new Error("Provider host is not in the executor egress allowlist");
    }
    validateAgentConfiguration(plan.agentConfiguration);
  } else if (plan.agentConfiguration !== null) {
    throw new Error("Agent credentials cannot be exposed to non-Agent jobs");
  }
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
  if ((job.jobKind !== "ARTIFACT_BUILD" && assetInputs.length > 0)
    || job.inputObjects.some(input => input.kind !== "ASSET" && input.assetKey !== undefined)
    || assetInputs.some(input => typeof input.assetKey !== "string"
      || !input.key.startsWith(`${objectPrefix}assets/`)
      || !/\.(?:png|jpg|webp)$/.test(input.key))
    || new Set(assetInputs.map(input => input.assetKey)).size !== assetInputs.length) {
    throw new Error("Build asset inputs do not satisfy the fixed materialization contract");
  }
  if (job.jobKind === "AGENT_GENERATION" && job.runtimeImage !== fixtureAgentImage) {
    const specifications = job.inputObjects.filter(input => input.kind === "SPECIFICATION"
      && basename(input.key) === "specification.json");
    if (specifications.length !== 1) throw new Error("Agent requires exactly one approved specification input");
    validateAgentSourceReference(job.payload, job.workspaceId, job.projectId);
    validateAgentBaselineSourceReference(job.payload, job.workspaceId, job.projectId);
  }
  const bindingId = job.payload.localDirectoryBindingId;
  if (bindingId !== undefined && bindingId !== null) {
    if (job.jobKind !== "AGENT_GENERATION"
      || typeof bindingId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bindingId)
      || !developmentContainersAllowed
      || !localProjectBridgeUrl
      || !/^[A-Za-z0-9_-]{40,200}$/.test(localProjectBridgeToken)) {
      throw new Error("Local project directory binding is not available to this executor");
    }
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
  const extension = input.key.match(/\.(png|jpg|webp)$/)?.[1];
  if (!extension) throw new Error("Build asset object extension is invalid");
  return `asset-${createHash("sha256").update(input.key).digest("hex")}.${extension}`;
}

function validateAgentConfiguration(configuration: NonNullable<SandboxPlan["agentConfiguration"]>) {
  const credentialReference = /^vault:\/\/instance\/agent-runtime\/api-key\/versions\/[0-9a-f]{8}-[0-9a-f-]{27}$/i;
  if (!Number.isSafeInteger(configuration.revision) || configuration.revision < 1
    || !credentialReference.test(configuration.credentialRef)) {
    throw new Error("Agent configuration reference is invalid");
  }
  const environment = configuration.environment;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)
    || Object.values(environment).some(value => typeof value !== "string" || value.length > 512 || /[\r\n\0]/.test(value))) {
    throw new Error("Agent environment is invalid");
  }
  if (configuration.runtime === "CLAUDE_CODE") {
    const allowed = new Set([
      "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
    ]);
    if (configuration.credentialEnvironmentVariable !== "ANTHROPIC_AUTH_TOKEN"
      || environment.ANTHROPIC_BASE_URL !== configuration.baseUrl
      || Object.keys(environment).some(key => !allowed.has(key))) {
      throw new Error("Claude Code environment is invalid");
    }
  } else if (configuration.runtime === "CODEX_CLI") {
    if (configuration.credentialEnvironmentVariable !== "CODEX_AUTH_JSON"
      || Object.keys(environment).some(key => key !== "DEVILUDO_CODEX_MODEL")) {
      throw new Error("Codex environment is invalid");
    }
  } else {
    throw new Error("Agent runtime is invalid");
  }
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

async function docker(arguments_: readonly string[], timeout: number, input?: Buffer): Promise<string> {
  const child = spawn("docker", arguments_, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: process.env.NODE_ENV ?? "production" },
  });
  child.stdin.end(input);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
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

function parseSourceStream(value: Buffer): readonly Readonly<{ path: string; bytes: Buffer }>[] {
  const magic = Buffer.from("DEVILUDO_SOURCE_V1\0");
  if (value.length < magic.length || !value.subarray(0, magic.length).equals(magic)) {
    throw new Error("Task source stream protocol is invalid");
  }
  const files: Readonly<{ path: string; bytes: Buffer }>[] = [];
  let offset = magic.length;
  while (offset < value.length) {
    if (offset + 12 > value.length) throw new Error("Task source stream is truncated");
    const pathBytesLength = value.readUInt32BE(offset);
    const contentBytes = value.readBigUInt64BE(offset + 4);
    offset += 12;
    if (pathBytesLength < 1 || pathBytesLength > 4096 || contentBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Task source stream entry is invalid");
    }
    const contentLength = Number(contentBytes);
    if (offset + pathBytesLength + contentLength > value.length) throw new Error("Task source stream is truncated");
    const encodedPath = value.subarray(offset, offset + pathBytesLength);
    const path = encodedPath.toString("utf8");
    if (!Buffer.from(path, "utf8").equals(encodedPath)) throw new Error("Task source path is not valid UTF-8");
    offset += pathBytesLength;
    const bytes = Buffer.from(value.subarray(offset, offset + contentLength));
    offset += contentLength;
    files.push(Object.freeze({ path, bytes }));
  }
  if (files.length < 1) throw new Error("Task source file count is invalid");
  return Object.freeze(files);
}

function localBindingId(plan: SandboxPlan): string | null {
  const value = plan.job.payload.localDirectoryBindingId;
  return typeof value === "string" ? value : null;
}

async function readLocalProjectSource(bindingId: string): Promise<Readonly<{ source: Buffer; digest: string }>> {
  const response = await localProjectBridgeRequest("/internal/directory/source", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bindingId }),
    timeout: 60_000,
  });
  const length = Number(response.headers.get("content-length") ?? "0");
  if (!response.ok) throw new Error(await localProjectBridgeError(response));
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new Error("Local project source length is invalid");
  }
  const source = Buffer.from(await response.arrayBuffer());
  if (source.length !== length) throw new Error("Local project source was truncated");
  const digest = response.headers.get("x-deviludo-source-digest") ?? "";
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("Local project source digest is invalid");
  return Object.freeze({ source, digest });
}

async function syncLocalProjectSource(bindingId: string, baseDigest: string, source: Buffer): Promise<void> {
  const response = await localProjectBridgeRequest("/internal/directory/sync", {
    headers: {
      "content-type": "application/x-deviludo-source-v1",
      "x-deviludo-directory-binding": bindingId,
      "x-deviludo-base-digest": baseDigest,
    },
    body: source,
    timeout: 120_000,
  });
  if (!response.ok) throw new Error(await localProjectBridgeError(response));
  await response.arrayBuffer();
}

async function localProjectBridgeRequest(
  path: string,
  input: Readonly<{ headers: Record<string, string>; body: string | Buffer; timeout: number }>,
): Promise<Response> {
  const base = new URL(localProjectBridgeUrl);
  if (base.protocol !== "http:" || base.hostname !== "local-project-bridge-proxy"
    || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Local project bridge URL is invalid");
  }
  return fetch(new URL(path, base), {
    method: "POST",
    headers: { ...input.headers, "x-deviludo-bridge-token": localProjectBridgeToken },
    body: typeof input.body === "string" ? input.body : Uint8Array.from(input.body).buffer,
    signal: AbortSignal.timeout(input.timeout),
  });
}

async function localProjectBridgeError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { message?: unknown };
    if (typeof payload.message === "string") return payload.message.slice(0, 2_000);
  } catch { /* use the bounded status fallback */ }
  return `Local project bridge returned ${response.status}`;
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
