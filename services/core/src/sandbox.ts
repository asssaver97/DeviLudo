import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CoreConfig } from "./config";
import type { JobProtocolV4, ObjectReference } from "./contracts";
import type { CoreRepository } from "./repository";
import { CoreObjectStore } from "./object-store";
import { ProjectSourceStore } from "./project-sources";
import type { CoreHostServices } from "./access";
import type { ProjectRuntimeService } from "./project-runtime-service";
import type { ProjectRuntimeRole } from "@/lib/product/contracts";
import { resolveAgentModel } from "./agent-settings";

export type SandboxMode = "MICROVM" | "RESTRICTED_CONTAINER";
export type SandboxPlan = Readonly<{
  schemaVersion: "deviludo.sandbox-plan.v2";
  mode: SandboxMode;
  job: JobProtocolV4;
  workspace: string;
  objectPrefix: string;
  vaultPath: string;
  networkPolicy: "BUILD_EGRESS_DENY" | "STEAM_ONLY";
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
  probe?(signal: AbortSignal): Promise<void>;
  execute(
    plan: SandboxPlan,
    signal: AbortSignal,
    onProgress?: (kind: "PHASE" | "AGENT_OUTPUT", content: string) => void,
  ): Promise<SandboxReceipt>;
}

export class ProcessSandboxBackend implements SandboxBackend {
  private probeValidUntil = 0;
  private probeError: Error | null = null;

  constructor(
    private readonly executable = process.env.DEVILUDO_SANDBOX_EXECUTOR ?? "",
  ) {}

  async probe(signal: AbortSignal): Promise<void> {
    if (!this.executable) throw new Error("A trusted sandbox executor is required");
    if (!isAbsolute(this.executable)) throw new Error("Sandbox executor path must be absolute");
    if (Date.now() < this.probeValidUntil) {
      if (this.probeError) throw this.probeError;
      return;
    }
    try {
      await probeBackend(this.executable, signal);
      this.probeError = null;
    } catch (error) {
      this.probeError = error instanceof Error ? error : new Error("Sandbox executor is unavailable");
      throw this.probeError;
    } finally {
      this.probeValidUntil = Date.now() + 2_000;
    }
  }

  async execute(
    plan: SandboxPlan,
    signal: AbortSignal,
    onProgress?: (kind: "PHASE" | "AGENT_OUTPUT", content: string) => void,
  ): Promise<SandboxReceipt> {
    if (!this.executable) throw new Error("A trusted sandbox executor is required");
    if (!isAbsolute(this.executable)) throw new Error("Sandbox executor path must be absolute");
    return await executeBackend(this.executable, plan, signal, onProgress);
  }

}

export async function runSandbox(
  repository: CoreRepository,
  config: CoreConfig,
  signal: AbortSignal,
  backend: SandboxBackend = new ProcessSandboxBackend(),
  requestedWorkerId?: string,
  _hostServices?: CoreHostServices,
  projectRuntime?: ProjectRuntimeService,
): Promise<void> {
  const hostServices = _hostServices;
  const workerId = requestedWorkerId ?? process.env.DEVILUDO_SANDBOX_ID ?? `sandbox-${process.pid}`;
  const objectStore = new CoreObjectStore();
  const projectSources = new ProjectSourceStore(config.projectsRoot);
  let executorAvailable: boolean | null = null;
  while (!signal.aborted) {
    let job: JobProtocolV4 | null = null;
    let admissionReservationId: string | null = null;
    try {
      if (backend.probe) {
        try {
          await backend.probe(signal);
          if (executorAvailable === false) {
            console.info(JSON.stringify({ level: "info", event: "sandbox_executor_recovered" }));
          }
          executorAvailable = true;
        } catch (error) {
          if (executorAvailable !== false) {
            console.error(JSON.stringify({
              level: "error",
              event: "sandbox_executor_unavailable",
              message: error instanceof Error ? error.message : String(error),
            }));
          }
          executorAvailable = false;
          await delay(Math.max(config.pollMilliseconds, 1_000), signal);
          continue;
        }
      }
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
      }, 2_000);
      let progressWrites = Promise.resolve();
      try {
        if (hostServices) {
          const estimatedUnits = admissionEstimatedUnits(job);
          const actorId = typeof job.payload.requestedByActorId === "string"
            ? job.payload.requestedByActorId
            : "00000000-0000-4000-8000-000000000000";
          const admission = await hostServices.admission.reserve({
            principal: Object.freeze({
              actorId,
              actorLabel: "Workflow actor",
              workspace: Object.freeze({ id: job.workspaceId, name: "Managed workspace", createdAt: "" }),
              capabilities: Object.freeze([]),
            }),
            operation: admissionOperation(job.jobKind),
            operationId: `${job.workflowId}:${job.jobId}`,
            estimatedUnits,
            resource: job.targetOperatingSystem,
          });
          admissionReservationId = admission.reservationId;
          if (admissionReservationId) {
            const attached = await repository.attachHostAdmission(job, admissionReservationId, estimatedUnits);
            if (!attached) throw new Error("Host admission reservation attachment was rejected by fencing");
            // Terminal job state is reconciled to the durable host-admission
            // outbox by the scheduler. From this point the process must not
            // settle or cancel directly, even if it crashes or loses its lease.
            admissionReservationId = null;
          }
        }
        if (job.jobKind === "AGENT_TURN") {
          if (!projectRuntime) throw new Error("Persistent Project Runtime service is unavailable");
          const [project, settings] = await Promise.all([
            projectRuntime.readProjectInput(job.workspaceId, job.projectId),
            repository.readAgentSettings(),
          ]);
          if (!project || !settings) throw new Error("Project or Agent Runtime settings are unavailable");
          const role = runtimeJobRole(job.payload);
          await repository.appendJobProgress(job, "PHASE", `${role} Agent is resuming its persistent project session`);
          const initializedContext = await projectRuntime.initialize({
            workspaceId: job.workspaceId, projectId: job.projectId,
            language: responseLanguageFromJob(job), concept: project.concept, settings,
            source: project.source ? {
              revision: project.source.revision, digest: project.source.digest,
              relativePath: project.source.relativePath,
            } : null,
          });
          const responseLanguage = responseLanguageFromJob(job, initializedContext.language);
          const runtimeResult = await projectRuntime.turn({
            workspaceId: job.workspaceId, projectId: job.projectId, role, mode: "PRIMARY",
            prompt: runtimeJobPrompt(job, role), responseLanguage, settings,
            sourceRevision: project.source?.revision ?? null,
            sourceRelativePath: project.source?.relativePath ?? null,
            onEvent: event => {
              progressWrites = progressWrites
                .then(() => repository.appendJobProgress(job as JobProtocolV4, "AGENT_OUTPUT", event.content))
                .then(() => undefined)
                .catch(() => undefined);
            },
          });
          await progressWrites;
          await repository.appendJobProgress(job, "AGENT_OUTPUT", runtimeResult.content);
          const context = await projectRuntime.readContext(job.workspaceId, job.projectId);
          if (role === "DEVELOPMENT") {
            const inputRevision = Number(job.payload.sourceRevision ?? 0);
            if (!context.source || context.source.revision <= inputRevision) {
              throw new Error("Development Agent completed without creating a new source checkpoint");
            }
            if (context.workflow.buildRequestedByTurnId !== runtimeResult.turnId) {
              throw new Error("Development Agent completed without requesting the controlled build");
            }
          }
          if (role === "TEST" && job.payload.purpose === "TEST_PLAN"
            && (!context.e2e.planRevision || !context.e2e.plan)) {
            throw new Error("Test Agent completed without persisting a complete test plan");
          }
          const completed = await repository.completePersistentAgentTurn(job, Object.freeze({
            turnId: runtimeResult.turnId,
            sessionId: runtimeResult.sessionId,
            role,
            purpose: typeof job.payload.purpose === "string" ? job.payload.purpose : null,
            content: runtimeResult.content,
            structured: runtimeResult.structured,
            contextRevision: context.revision,
            sourceRevision: context.source?.revision ?? null,
            planRevision: context.e2e.planRevision ?? null,
            verdict: runtimeResult.structured.verdict ?? null,
            handoff: runtimeResult.structured.handoff ?? null,
            responseLanguage,
            agentRuntime: settings.agentRuntime,
            model: resolveAgentModel(
              settings.primaryModel,
              settings.modelOverrides,
              role.toLowerCase() as "design" | "development" | "test",
            ),
            settingsRevision: settings.revision,
          }));
          if (!completed) throw new Error("Persistent Agent turn completion was rejected by fencing");
          await projectRuntime.recordWorkflowJobResult({
            workspaceId: job.workspaceId,
            projectId: job.projectId,
            jobId: job.jobId,
            jobKind: job.jobKind,
          });
          await repository.appendJobProgress(job, "COMPLETED", `${role} Agent completed the persistent turn`).catch(() => undefined);
          continue;
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
        if (operationId) await repository.finishOperation(job, operationId, receipt.details);
        const completed = await repository.complete(job, {
          leaseToken: job.lease.token,
          fencingToken: job.lease.fencingToken,
          isolationGeneration: job.isolationGeneration,
          receipt: Object.freeze({
            ...receipt.details,
          }),
          executorReceipt: receipt,
        });
        if (!completed) throw new Error("Sandbox completion was rejected by fencing");
        if (projectRuntime) {
          await projectRuntime.recordWorkflowJobResult({
            workspaceId: job.workspaceId,
            projectId: job.projectId,
            jobId: job.jobId,
            jobKind: job.jobKind,
            outputCount: receipt.outputObjects.length,
          });
        }
      } finally {
        clearInterval(heartbeat);
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
        // A reservation that was created but could not be durably attached has
        // no database event that can clean it up. Attached reservations are
        // deliberately left to the scheduler outbox.
        if (hostServices && admissionReservationId) {
          await hostServices.admission.cancel({ reservationId: admissionReservationId }).catch(() => undefined);
          admissionReservationId = null;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (job.jobKind === "AGENT_TURN") {
          await discardOrphanedAgentSource(repository, projectSources, job).catch(cleanupError => {
            console.error(JSON.stringify({
              level: "error",
              event: "sandbox_orphan_source_cleanup_failed",
              jobId: job?.jobId,
              message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            }));
          });
          await repository.appendJobProgress(job, "FAILED", message).catch(() => undefined);
        }
        await repository.fail(job, message).catch(() => undefined);
        if (projectRuntime) {
          await projectRuntime.recordWorkflowJobFailure({
            workspaceId: job.workspaceId,
            projectId: job.projectId,
            jobId: job.jobId,
            jobKind: job.jobKind,
            error: message,
          }).catch(() => undefined);
        }
      }
    }
  }
}

function runtimeJobRole(payload: Readonly<Record<string, unknown>>): ProjectRuntimeRole {
  const role = payload.role ?? "DEVELOPMENT";
  if (!["DESIGN", "DEVELOPMENT", "TEST"].includes(String(role))) {
    throw new Error("AGENT_TURN job role is invalid");
  }
  return role as ProjectRuntimeRole;
}

function responseLanguageFromJob(job: JobProtocolV4, fallback: "en" | "zh" = "en"): "en" | "zh" {
  if (job.payload.responseLanguage === "zh" || job.payload.responseLanguage === "en") {
    return job.payload.responseLanguage;
  }
  return fallback;
}

function runtimeJobPrompt(job: JobProtocolV4, role: ProjectRuntimeRole): string {
  const purpose = typeof job.payload.purpose === "string" ? job.payload.purpose : role;
  const handoff = job.payload.testHandoff ?? job.payload.implementationBrief ?? null;
  if (role === "DESIGN") {
    return [
      `Apply the approved requirement revision and create a complete DEVELOPMENT handoff. Purpose: ${purpose}.`,
      handoff ? `Approved design brief: ${JSON.stringify(handoff).slice(0, 40_000)}` : "",
    ].filter(Boolean).join("\n");
  }
  if (role === "DEVELOPMENT") {
    return [
      "Implement the complete current requirement and E2E goal snapshot in the project worktree.",
      "Run source checks, checkpoint the resulting source, and request a controlled build.",
      handoff ? `Handoff: ${JSON.stringify(handoff).slice(0, 40_000)}` : "",
    ].filter(Boolean).join("\n");
  }
  if (purpose === "TEST_VERDICT") {
    return "Read all platform evidence for the current source and plan revisions. Return PASS only if every deterministic, visual, performance, crash, input-response, requirement, and asset-binding gate passes. Otherwise return FAIL with one structured DEVELOPMENT handoff, or BLOCKED only for unrecoverable configuration.";
  }
  return "Create and persist the complete test plan for the current requirement and source revisions, covering every target platform, real input, planned asset binding, screenshots, video, crashes, and performance. Start all platform runs with the identical frozen plan.";
}

function admissionOperation(jobKind:JobProtocolV4["jobKind"]):"AGENT"|"SANDBOX"|"E2E"|"BUILD"|"STEAM_PUBLISH"{
  if(jobKind==="AGENT_TURN")return"AGENT";
  if(jobKind==="BUILD")return"BUILD";
  if(jobKind==="STEAM_PUBLISH")return"STEAM_PUBLISH";
  if(jobKind==="E2E_PLATFORM_RUN")return"E2E";
  return"SANDBOX";
}

function admissionEstimatedUnits(job: JobProtocolV4): number {
  return job.jobKind === "AGENT_TURN" && job.timeoutSeconds < 5_400
    ? 5_400
    : job.timeoutSeconds;
}

async function discardOrphanedAgentSource(
  repository: CoreRepository,
  projectSources: ProjectSourceStore,
  job: JobProtocolV4,
): Promise<boolean> {
  if (job.jobKind !== "AGENT_TURN") return false;
  const revision = Number(job.payload.publishSourceRevision);
  if (!Number.isSafeInteger(revision) || revision < 1) return false;
  const registered = await repository.projectSourceRevisionExists(job.workspaceId, job.projectId, revision);
  return registered
    ? false
    : projectSources.discardUnregisteredRevision(job.workspaceId, job.projectId, revision);
}

export function sandboxPlan(job: JobProtocolV4, operationId: string | null = null): SandboxPlan {
  if (job.poolKind !== "CORE" || job.exclusive) throw new Error("Sandbox only accepts non-exclusive Core jobs");
  if (job.jobKind === "AGENT_TURN") {
    throw new Error("AGENT_TURN jobs must use the persistent Project Runtime");
  }
  const effectiveJob = job;
  const plannedJob = operationId
    ? Object.freeze({ ...effectiveJob, payload: Object.freeze({ ...effectiveJob.payload, operation: Object.freeze({ id: operationId }) }) })
    : effectiveJob;
  const mode: SandboxMode = "RESTRICTED_CONTAINER";
  const networkPolicy = job.jobKind === "STEAM_PUBLISH" ? "STEAM_ONLY" : "BUILD_EGRESS_DENY";
  return Object.freeze({
    schemaVersion: "deviludo.sandbox-plan.v2",
    mode,
    job: plannedJob,
    workspace: `/var/lib/deviludo/workspaces/${job.workspaceId}/${job.projectId}/${job.jobId}/g${job.isolationGeneration}`,
    objectPrefix: `workspaces/${job.workspaceId}/projects/${job.projectId}/jobs/${job.jobId}`,
    vaultPath: `workspaces/${job.workspaceId}/projects/${job.projectId}/jobs/${job.jobId}`,
    networkPolicy,
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

async function probeBackend(executable: string, signal: AbortSignal): Promise<void> {
  const child = spawn(executable, ["live"], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false,
    signal,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      NODE_ENV: process.env.NODE_ENV ?? "production",
    },
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) {
    const detail = Buffer.concat(stderr).toString("utf8").trim() || "executor live probe failed without a diagnostic";
    throw new Error(`Sandbox executor unavailable: ${detail.slice(-2_000)}`);
  }
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
