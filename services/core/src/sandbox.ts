import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  AGENT_RUNTIME_KINDS,
  type AgentModelConfiguration,
  type AgentRuntimeKind,
} from "@/lib/product/contracts";
import { normalizeAgentModels, normalizeBaseUrl } from "./agent-settings";
import type { CoreConfig } from "./config";
import type { JobProtocolV4, ObjectReference } from "./contracts";
import type { CoreRepository } from "./repository";
import { CoreObjectStore } from "./object-store";

export type SandboxMode = "MICROVM" | "RESTRICTED_CONTAINER";
export type SandboxPlan = Readonly<{
  schemaVersion: "deviludo.sandbox-plan.v2";
  mode: SandboxMode;
  job: JobProtocolV4;
  workspace: string;
  objectPrefix: string;
  vaultPath: string;
  agentConfiguration: Readonly<{
    runtime: AgentRuntimeKind;
    baseUrl: string;
    models: AgentModelConfiguration | null;
    credentialRef: string;
    credentialEnvironmentVariable: "ANTHROPIC_AUTH_TOKEN" | "CODEX_API_KEY";
    environment: Readonly<Record<string, string>>;
    revision: number;
  }> | null;
  networkPolicy: "AGENT_EGRESS_ALLOWLIST" | "BUILD_EGRESS_DENY" | "STEAM_ONLY";
}>;

export type SandboxReceipt = Readonly<{
  schemaVersion: "deviludo.executor-receipt.v2";
  executorId: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  simulated: false;
  outputObjects: readonly (ObjectReference & Readonly<{
    kind: string;
    targetPlatform?: "linux" | "windows" | "macos";
    metadata?: Readonly<Record<string, unknown>>;
  }>)[];
  signature: string;
  isolationProof: string;
  cleanupProof: string;
  details: Readonly<Record<string, unknown>>;
}>;

export interface SandboxBackend {
  execute(
    plan: SandboxPlan,
    signal: AbortSignal,
    onProgress?: (kind: "PHASE" | "AGENT_OUTPUT", content: string) => void,
  ): Promise<SandboxReceipt>;
  guide?(jobId: string, content: string, signal: AbortSignal): Promise<void>;
}

export class ProcessSandboxBackend implements SandboxBackend {
  constructor(
    private readonly executable = process.env.DEVILUDO_SANDBOX_EXECUTOR ?? "",
  ) {}

  async execute(
    plan: SandboxPlan,
    signal: AbortSignal,
    onProgress?: (kind: "PHASE" | "AGENT_OUTPUT", content: string) => void,
  ): Promise<SandboxReceipt> {
    if (!this.executable) throw new Error("A trusted sandbox executor is required");
    if (!isAbsolute(this.executable)) throw new Error("Sandbox executor path must be absolute");
    if (["AGENT_GENERATION", "PROJECT_DOCUMENT_MAINTENANCE"].includes(plan.job.jobKind) && !plan.agentConfiguration) {
      throw new Error("Instance Agent settings are required");
    }
    return await executeBackend(this.executable, plan, signal, onProgress);
  }

  async guide(jobId: string, content: string, signal: AbortSignal): Promise<void> {
    if (!this.executable || !isAbsolute(this.executable)) throw new Error("Sandbox executor path must be absolute");
    await guideBackend(this.executable, jobId, content, signal);
  }
}

export async function runSandbox(
  repository: CoreRepository,
  config: CoreConfig,
  signal: AbortSignal,
  backend: SandboxBackend = new ProcessSandboxBackend(),
): Promise<void> {
  const workerId = process.env.DEVILUDO_SANDBOX_ID ?? `sandbox-${process.pid}`;
  const objectStore = new CoreObjectStore();
  while (!signal.aborted) {
    let job: JobProtocolV4 | null = null;
    try {
      job = await repository.claimJob({ workerId, poolKind: "CORE", leaseSeconds: 60 });
      if (!job) {
        await delay(config.pollMilliseconds, signal);
        continue;
      }
      const jobController = new AbortController();
      const abortJob = () => jobController.abort();
      signal.addEventListener("abort", abortJob, { once: true });
      const heartbeat = setInterval(() => {
        void repository.heartbeat(job as JobProtocolV4)
          .then(accepted => { if (!accepted) jobController.abort(); })
          .catch(() => jobController.abort());
      }, 20_000);
      let progressWrites = Promise.resolve();
      let deliveringGuidance = false;
      const guidance = backend.guide && job.jobKind === "AGENT_GENERATION"
        ? setInterval(() => {
          if (deliveringGuidance || jobController.signal.aborted) return;
          deliveringGuidance = true;
          void repository.readPendingAgentGuidance(job as JobProtocolV4)
            .then(async messages => {
              for (const message of messages) {
                await backend.guide?.((job as JobProtocolV4).jobId, message.content, jobController.signal);
                await repository.markAgentGuidanceDelivered(job as JobProtocolV4, message.id);
              }
            })
            .catch(error => {
              console.error(JSON.stringify({
                level: "error",
                event: "sandbox_guidance_delivery_failed",
                jobId: (job as JobProtocolV4).jobId,
                message: error instanceof Error ? error.message : String(error),
              }));
            })
            .finally(() => { deliveringGuidance = false; });
        }, 500)
        : null;
      try {
        if (job.jobKind === "AGENT_GENERATION") {
          await repository.appendJobProgress(job, "PHASE", "Agent 任务已领取，正在准备隔离环境");
        }
        const operationId = job.jobKind === "STEAM_PUBLISH"
          ? await repository.beginOperation(job, "STEAM_UPLOAD")
          : null;
        const receipt = await backend.execute(
          sandboxPlan(job, operationId),
          jobController.signal,
          (kind, content) => {
            progressWrites = progressWrites
              .then(() => repository.appendJobProgress(job as JobProtocolV4, kind, content))
              .then(() => undefined)
              .catch(() => undefined);
          },
        );
        await progressWrites;
        await objectStore.verifyOutputs(job, receipt.outputObjects);
        const projectDocument = job.jobKind === "PROJECT_DOCUMENT_MAINTENANCE"
          ? await objectStore.readProjectDocument(job, receipt.outputObjects)
          : null;
        if (operationId) await repository.finishOperation(job, operationId, receipt.details);
        if (job.jobKind === "AGENT_GENERATION") {
          await repository.appendJobProgress(job, "COMPLETED", "Agent 生成完成，正在登记源码制品");
        }
        const completed = await repository.complete(job, {
          leaseToken: job.lease.token,
          fencingToken: job.lease.fencingToken,
          isolationGeneration: job.isolationGeneration,
          receipt: projectDocument
            ? Object.freeze({ ...receipt.details, projectDocument })
            : receipt.details,
          executorReceipt: receipt,
        });
        if (!completed) throw new Error("Sandbox completion was rejected by fencing");
      } finally {
        clearInterval(heartbeat);
        if (guidance) clearInterval(guidance);
        signal.removeEventListener("abort", abortJob);
        jobController.abort();
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "sandbox_job_failed",
        jobId: job?.jobId,
        workspaceId: job?.workspaceId,
        projectId: job?.projectId,
        message: error instanceof Error ? error.message : String(error),
      }));
      if (job) {
        const message = error instanceof Error ? error.message : String(error);
        if (job.jobKind === "AGENT_GENERATION") {
          await repository.appendJobProgress(job, "FAILED", message).catch(() => undefined);
        }
        await repository.fail(job, message).catch(() => undefined);
      }
    }
  }
}

export function sandboxPlan(job: JobProtocolV4, operationId: string | null = null): SandboxPlan {
  if (job.poolKind !== "CORE" || job.exclusive) throw new Error("Sandbox only accepts non-exclusive Core jobs");
  const developmentContainer = (process.env.NODE_ENV ?? "development") !== "production"
    && process.env.DEVILUDO_SANDBOX_ISOLATION_MODE === "RESTRICTED_CONTAINER";
  const agentJob = job.jobKind === "AGENT_GENERATION" || job.jobKind === "PROJECT_DOCUMENT_MAINTENANCE";
  const mode: SandboxMode = agentJob && !developmentContainer
    ? "MICROVM"
    : "RESTRICTED_CONTAINER";
  const networkPolicy = agentJob
    ? "AGENT_EGRESS_ALLOWLIST"
    : job.jobKind === "STEAM_PUBLISH" ? "STEAM_ONLY" : "BUILD_EGRESS_DENY";
  return Object.freeze({
    schemaVersion: "deviludo.sandbox-plan.v2",
    mode,
    job: operationId ? Object.freeze({ ...job, payload: Object.freeze({ ...job.payload, operation: Object.freeze({ id: operationId }) }) }) : job,
    workspace: `/var/lib/deviludo/workspaces/${job.workspaceId}/${job.projectId}/${job.jobId}/g${job.isolationGeneration}`,
    objectPrefix: `workspaces/${job.workspaceId}/projects/${job.projectId}/jobs/${job.jobId}`,
    vaultPath: `workspaces/${job.workspaceId}/projects/${job.projectId}/jobs/${job.jobId}`,
    agentConfiguration: agentJob
      ? agentConfigurationFromPayload(job.payload)
      : null,
    networkPolicy,
  });
}

function agentConfigurationFromPayload(
  payload: Readonly<Record<string, unknown>>,
): SandboxPlan["agentConfiguration"] {
  const value = payload.agentConfiguration;
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent configuration lock is invalid");
  }
  const input = value as Record<string, unknown>;
  const baseUrl = typeof input.baseUrl === "string"
    ? normalizeBaseUrl(input.baseUrl, process.env.NODE_ENV ?? "development")
    : "";
  const models = normalizeAgentModels(input.models);
  if (!(AGENT_RUNTIME_KINDS as readonly unknown[]).includes(input.runtime)
    || !baseUrl
    || typeof input.credentialRef !== "string"
    || !input.credentialRef.startsWith("vault://instance/agent-runtime/api-key/versions/")
    || !Number.isSafeInteger(input.revision)
    || Number(input.revision) < 1) {
    throw new Error("Agent configuration lock is invalid");
  }
  return Object.freeze({
    runtime: input.runtime as AgentRuntimeKind,
    baseUrl,
    models,
    credentialRef: input.credentialRef,
    credentialEnvironmentVariable: input.runtime === "CLAUDE_CODE" ? "ANTHROPIC_AUTH_TOKEN" : "CODEX_API_KEY",
    environment: input.runtime === "CLAUDE_CODE"
      ? claudeCodeEnvironment(baseUrl, models)
      : Object.freeze({ DEVILUDO_CODEX_BASE_URL: baseUrl }),
    revision: Number(input.revision),
  });
}

function claudeCodeEnvironment(
  baseUrl: string,
  models: AgentModelConfiguration | null,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ANTHROPIC_BASE_URL: baseUrl,
    ...(models ? {
      ANTHROPIC_MODEL: models.primary,
      ANTHROPIC_DEFAULT_OPUS_MODEL: models.opus,
      ANTHROPIC_DEFAULT_SONNET_MODEL: models.sonnet,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: models.haiku,
      CLAUDE_CODE_SUBAGENT_MODEL: models.subagent,
    } : {}),
  });
}

async function executeBackend(
  executable: string,
  plan: SandboxPlan,
  signal: AbortSignal,
  onProgress?: (kind: "PHASE" | "AGENT_OUTPUT", content: string) => void,
): Promise<SandboxReceipt> {
  const child = spawn(executable, ["execute"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    signal,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      NODE_ENV: process.env.NODE_ENV ?? "production",
    },
  });
  child.stdin.end(JSON.stringify(plan));
  const stdout: Buffer[] = [];
  const stderrDecoder = new StringDecoder("utf8");
  let stderrBuffer = "";
  let executorDiagnostics = "";
  let stdoutBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 1_048_576) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += stderrDecoder.write(chunk);
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const record = parseExecutorStderrLine(line);
      if (record.progress) onProgress?.(record.progress.kind, record.progress.content);
      else if (record.diagnostic) executorDiagnostics = boundedDiagnosticTail(executorDiagnostics, record.diagnostic);
    }
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  stderrBuffer += stderrDecoder.end();
  if (stderrBuffer.length > 0) {
    const record = parseExecutorStderrLine(stderrBuffer);
    if (record.progress) onProgress?.(record.progress.kind, record.progress.content);
    else if (record.diagnostic) executorDiagnostics = boundedDiagnosticTail(executorDiagnostics, record.diagnostic);
  }
  if (stdoutBytes > 1_048_576) {
    throw new Error("Sandbox executor failed: receipt exceeded the 1 MiB response limit");
  }
  if (code !== 0) {
    const detail = executorDiagnostics.trim() || `executor exited with code ${code ?? "unknown"} without diagnostic output`;
    throw new Error(`Sandbox executor failed: ${detail.slice(-4_000)}`);
  }
  const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as Partial<SandboxReceipt>;
  if (parsed.schemaVersion !== "deviludo.executor-receipt.v2"
    || typeof parsed.executorId !== "string"
    || parsed.simulated !== false
    || !Array.isArray(parsed.outputObjects)
    || typeof parsed.signature !== "string" || parsed.signature.length < 32
    || typeof parsed.isolationProof !== "string"
    || typeof parsed.cleanupProof !== "string"
    || !parsed.details || typeof parsed.details !== "object") {
    throw new Error("Sandbox receipt is invalid");
  }
  return Object.freeze(parsed as SandboxReceipt);
}

const EXECUTOR_PROGRESS_PREFIX = "DEVILUDO_PROGRESS:";

export type ExecutorStderrRecord = Readonly<{
  progress: Readonly<{ kind: "PHASE" | "AGENT_OUTPUT"; content: string }> | null;
  diagnostic: string | null;
}>;

export function parseExecutorStderrLine(line: string): ExecutorStderrRecord {
  if (!line.startsWith(EXECUTOR_PROGRESS_PREFIX)) {
    return Object.freeze({ progress: null, diagnostic: line });
  }
  try {
    const event = JSON.parse(line.slice(EXECUTOR_PROGRESS_PREFIX.length)) as { kind?: unknown; content?: unknown };
    if ((event.kind === "PHASE" || event.kind === "AGENT_OUTPUT") && typeof event.content === "string") {
      return Object.freeze({
        progress: Object.freeze({ kind: event.kind, content: event.content }),
        diagnostic: null,
      });
    }
  } catch { /* report a bounded protocol error below */ }
  return Object.freeze({
    progress: null,
    diagnostic: "Executor emitted a malformed progress event",
  });
}

function boundedDiagnosticTail(current: string, line: string): string {
  return `${current}${line}\n`.slice(-65_536);
}

async function guideBackend(
  executable: string,
  jobId: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  const child = spawn(executable, ["guidance"], {
    stdio: ["pipe", "ignore", "pipe"],
    shell: false,
    signal,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      NODE_ENV: process.env.NODE_ENV ?? "production",
    },
  });
  child.stdin.end(JSON.stringify({ jobId, content }));
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`Sandbox guidance failed: ${Buffer.concat(stderr).toString("utf8").slice(0, 2_000)}`);
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
