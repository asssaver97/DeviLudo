import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { AGENT_RUNTIME_KINDS, type AgentRuntimeKind } from "@/lib/product/contracts";
import { normalizeBaseUrl } from "./agent-settings";
import type { CoreConfig } from "./config";
import type { JobProtocolV3 } from "./contracts";
import type { CoreRepository } from "./repository";

export type SandboxMode = "MICROVM" | "RESTRICTED_CONTAINER";
export type SandboxPlan = Readonly<{
  schemaVersion: "deviludo.sandbox-plan.v1";
  mode: SandboxMode;
  job: JobProtocolV3;
  workspace: string;
  objectPrefix: string;
  vaultPath: string;
  agentConfiguration: Readonly<{
    runtime: AgentRuntimeKind;
    baseUrl: string;
    credentialRef: string;
    revision: number;
  }> | null;
  networkPolicy: "AGENT_EGRESS_ALLOWLIST" | "BUILD_EGRESS_DENY" | "STEAM_ONLY";
}>;

export type SandboxReceipt = Readonly<{
  executor: string;
  isolationProof: string;
  cleanupProof: string;
  outputs: Readonly<Record<string, unknown>>;
}>;

export interface SandboxBackend {
  execute(plan: SandboxPlan, signal: AbortSignal): Promise<SandboxReceipt>;
}

export class ProcessSandboxBackend implements SandboxBackend {
  constructor(
    private readonly executable = process.env.DEVILUDO_SANDBOX_EXECUTOR ?? "",
    private readonly production = process.env.NODE_ENV === "production",
  ) {}

  async execute(plan: SandboxPlan, signal: AbortSignal): Promise<SandboxReceipt> {
    if (!this.executable) {
      if (this.production) throw new Error("A trusted sandbox executor is required in production");
      return Object.freeze({
        executor: "development-simulator",
        isolationProof: `simulated:${plan.job.jobId}:${plan.job.isolationGeneration}`,
        cleanupProof: `simulated-cleanup:${plan.job.jobId}:${plan.job.isolationGeneration}`,
        outputs: Object.freeze({ simulated: true }),
      });
    }
    if (!isAbsolute(this.executable)) throw new Error("Sandbox executor path must be absolute");
    if (this.production && plan.job.jobKind === "AGENT_GENERATION" && !plan.agentConfiguration) {
      throw new Error("Tenant Agent settings are required in production");
    }
    return await executeBackend(this.executable, plan, signal);
  }
}

export async function runSandbox(
  repository: CoreRepository,
  config: CoreConfig,
  signal: AbortSignal,
  backend: SandboxBackend = new ProcessSandboxBackend(),
): Promise<void> {
  const workerId = process.env.DEVILUDO_SANDBOX_ID ?? `sandbox-${process.pid}`;
  while (!signal.aborted) {
    let job: JobProtocolV3 | null = null;
    try {
      job = await repository.claimJob({ workerId, poolKind: "CORE", leaseSeconds: 60 });
      if (!job) {
        await delay(config.pollMilliseconds, signal);
        continue;
      }
      const heartbeat = setInterval(() => {
        void repository.heartbeat(job as JobProtocolV3).catch(() => undefined);
      }, 20_000);
      try {
        const operationId = job.jobKind === "STEAM_PUBLISH"
          ? await repository.registerOperation(job, "STEAM_UPLOAD")
          : null;
        const receipt = await backend.execute(sandboxPlan(job), signal);
        if (operationId) await repository.finishOperation(job, operationId, receipt.outputs);
        const completed = await repository.complete(job, {
          leaseToken: job.lease.token,
          fencingToken: job.lease.fencingToken,
          isolationGeneration: job.isolationGeneration,
          receipt,
        });
        if (!completed) throw new Error("Sandbox completion was rejected by fencing");
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "sandbox_job_failed",
        jobId: job?.jobId,
        tenantId: job?.tenantId,
        projectId: job?.projectId,
        message: error instanceof Error ? error.message : String(error),
      }));
      if (job) await repository.fail(job, error instanceof Error ? error.message : String(error)).catch(() => undefined);
    }
  }
}

export function sandboxPlan(job: JobProtocolV3): SandboxPlan {
  if (job.poolKind !== "CORE" || job.exclusive) throw new Error("Sandbox only accepts non-exclusive Core jobs");
  const mode: SandboxMode = job.jobKind === "AGENT_GENERATION" ? "MICROVM" : "RESTRICTED_CONTAINER";
  const networkPolicy = job.jobKind === "AGENT_GENERATION"
    ? "AGENT_EGRESS_ALLOWLIST"
    : job.jobKind === "STEAM_PUBLISH" ? "STEAM_ONLY" : "BUILD_EGRESS_DENY";
  return Object.freeze({
    schemaVersion: "deviludo.sandbox-plan.v1",
    mode,
    job,
    workspace: `/var/lib/deviludo/workspaces/${job.tenantId}/${job.projectId}/${job.jobId}/g${job.isolationGeneration}`,
    objectPrefix: `tenants/${job.tenantId}/projects/${job.projectId}/jobs/${job.jobId}`,
    vaultPath: `tenants/${job.tenantId}/projects/${job.projectId}/jobs/${job.jobId}`,
    agentConfiguration: job.jobKind === "AGENT_GENERATION"
      ? agentConfigurationFromPayload(job.payload, job.tenantId)
      : null,
    networkPolicy,
  });
}

function agentConfigurationFromPayload(
  payload: Readonly<Record<string, unknown>>,
  tenantId: string,
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
  if (!(AGENT_RUNTIME_KINDS as readonly unknown[]).includes(input.runtime)
    || !baseUrl
    || typeof input.credentialRef !== "string"
    || !input.credentialRef.startsWith(`vault://tenants/${tenantId}/`)
    || !Number.isSafeInteger(input.revision)
    || Number(input.revision) < 1) {
    throw new Error("Agent configuration lock is invalid");
  }
  return Object.freeze({
    runtime: input.runtime as AgentRuntimeKind,
    baseUrl,
    credentialRef: input.credentialRef,
    revision: Number(input.revision),
  });
}

async function executeBackend(
  executable: string,
  plan: SandboxPlan,
  signal: AbortSignal,
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
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 1_048_576) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 65_536) stderr.push(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0 || stdoutBytes > 1_048_576) {
    throw new Error(`Sandbox executor failed: ${Buffer.concat(stderr).toString("utf8").slice(0, 2_000)}`);
  }
  const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as Partial<SandboxReceipt>;
  if (typeof parsed.executor !== "string"
    || typeof parsed.isolationProof !== "string"
    || typeof parsed.cleanupProof !== "string"
    || !parsed.outputs || typeof parsed.outputs !== "object") {
    throw new Error("Sandbox receipt is invalid");
  }
  return Object.freeze(parsed as SandboxReceipt);
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
