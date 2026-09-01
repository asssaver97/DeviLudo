import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { PROJECT_RUNTIME_ROLES, type E2eGoal, type ProjectRuntimeRole } from "@/lib/product/contracts";
import { parseProjectDocumentContent, type ProjectDocumentContent } from "@/lib/product/project-document";
import {
  PROJECT_RUNTIME_SCHEMA,
  type ProjectRuntimeControlRequest,
  type ProjectRuntimeProgressEvent,
  type ProjectRuntimeTurnMode,
  type ProjectRuntimeTurnResult,
} from "@/lib/product/project-runtime";
import { normalizeProjectPath } from "@/lib/product/source-archive";
import { planE2eExecution, testManifestValidationError, validateTestManifest } from "@/lib/product/test-manifest";
import { resolveAgentModel } from "./agent-settings";
import { normalizeImportedProjectAnalysisReport } from "./project-import";
import {
  createProjectContext,
  ProjectContextStore,
  type ProjectContext,
  type StoredProjectContext,
  updateProjectContext,
} from "./project-context";
import { ProcessProjectRuntimeBackend, type ProjectRuntimeBackend } from "./project-runtime-backend";
import {
  ProjectRuntimeRepository,
  runtimeContainerStateForTurn,
  type ProjectContextSeed,
} from "./project-runtime-repository";
import { ProjectSourceStore } from "./project-sources";
import type { StoredInstanceAgentSettings } from "./repository";
import { extractAndValidateEvidenceBundle } from "@/scripts/e2e-evidence.mjs";

const ROLE_TO_MODEL = Object.freeze({
  INTENT: "intent",
  ANALYSIS: "analysis",
  DESIGN: "design",
  UI_DESIGN: "uiDesign",
  DEVELOPMENT: "development",
  TEST: "test",
} as const);

const ROLE_TOOLS = Object.freeze({
  INTENT: new Set(["context.read", "conversation.reply", "workflow.intent_decision", "workflow.stop", "workflow.continue"]),
  ANALYSIS: new Set(["context.read", "source.list", "source.read", "diagnostics.run", "context.update_analysis", "conversation.reply"]),
  DESIGN: new Set(["context.read", "requirements.update", "project_document.update", "e2e_goals.update", "conversation.reply", "handoff.create"]),
  UI_DESIGN: new Set(["context.read", "source.list", "source.read", "evidence.read", "project_document.update", "e2e_goals.update", "conversation.reply", "handoff.create"]),
  DEVELOPMENT: new Set(["context.read", "source.list", "source.read", "evidence.read", "source.checkpoint", "assets.plan", "assets.cleanup", "build.request", "conversation.reply", "handoff.create"]),
  TEST: new Set(["context.read", "source.list", "source.read", "test_plan.replace", "test_plan.revise_timeout", "e2e.start", "e2e.observe", "evidence.read", "test.verdict", "conversation.reply", "handoff.create"]),
});
const READ_ONLY_TOOLS = new Set([
  "context.read", "source.list", "source.read", "evidence.read", "conversation.reply",
]);
const LIFECYCLE_RETRY_INTERVAL_MS = 1_000;
// Match the scheduler's bounded lifecycle lease. A workflow attempt must not
// be consumed while another owner can still be legitimately compacting it.
const LIFECYCLE_RETRY_LIMIT = 900;
// Long authored journeys can legitimately contain dozens of lossless 1280x720
// checkpoints plus the run video. Keep this below the producer's 1 GiB hard
// limit, but large enough for Test and repair Agents to inspect those reports.
export const AGENT_EVIDENCE_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
const AGENT_EVIDENCE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const AGENT_EVIDENCE_ROLES = Object.freeze(["START", "READY", "ACTION", "PROGRESS", "COMPLETION"] as const);
const AGENT_EVIDENCE_IMAGE_LIMIT = 64;
const AGENT_EVIDENCE_PAGE_LIMIT = 6;

type ProjectArtifactReader = Readonly<{
  readProjectArtifact(input: Readonly<{
    workspaceId: string;
    projectId: string;
    bucket: string;
    key: string;
    sha256: string;
    sizeBytes: number;
    maximumBytes: number;
  }>): Promise<Buffer>;
}>;

type ProjectRuntimeTurnInput = Readonly<{
  workspaceId: string;
  projectId: string;
  workflowJobId?: string;
  role: ProjectRuntimeRole;
  mode: ProjectRuntimeTurnMode;
  prompt: string;
  responseLanguage: "en" | "zh";
  settings: StoredInstanceAgentSettings;
  sourceRevision: number | null;
  sourceRelativePath: string | null;
  lifecycleLeaseToken?: string;
  attachments?: readonly Readonly<{ content: Buffer; extension: "png" | "jpg" | "webp" }>[];
  onEvent?: (event: ProjectRuntimeProgressEvent) => void;
}>;

export class ProjectRuntimeService {
  private readonly contexts: ProjectContextStore;
  private readonly sources: ProjectSourceStore;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly rejectedNarrativeSourceDigests = new Map<string, string>();

  constructor(
    private readonly repository: ProjectRuntimeRepository,
    private readonly projectsRoot: string,
    private readonly backend: ProjectRuntimeBackend = new ProcessProjectRuntimeBackend(),
    private readonly artifactReader?: ProjectArtifactReader,
  ) {
    this.contexts = new ProjectContextStore(projectsRoot);
    this.sources = new ProjectSourceStore(projectsRoot);
  }

  async initialize(input: Readonly<{
    workspaceId: string;
    projectId: string;
    language: "en" | "zh";
    concept: string;
    settings: StoredInstanceAgentSettings;
    source: Readonly<{ revision: number; digest: string; relativePath: string }> | null;
  }>): Promise<ProjectContext> {
    const seed = await this.repository.readProjectContextSeed(input.workspaceId, input.projectId);
    if (!seed) throw new Error("Project Runtime cannot initialize without a durable project seed");
    const context = await this.withProjectLock(input.workspaceId, input.projectId, () => this.repository.updateContext(
      input.workspaceId,
      input.projectId,
      async existing => {
        if (existing) {
          const current = (await this.contexts.read(input.workspaceId, input.projectId, existing.sha256)).context;
          const synchronized = contextFromSeed(current, seed);
          if (synchronized === current) return Object.freeze({ stored: null, result: current });
          const stored = await this.contexts.write(synchronized);
          return Object.freeze({ stored, result: synchronized });
        }
        let created = createProjectContext(input);
        created = contextFromSeed(created, seed, true);
        if (input.source) created = updateProjectContext(created, { source: {
          revision: input.source.revision, sha256: input.source.digest, relativePath: input.source.relativePath,
        } });
        const stored = await this.contexts.write(created);
        return Object.freeze({ stored, result: created });
      },
    ));
    await this.repository.ensureContainer(input.workspaceId, input.projectId, input.settings.agentRuntime);
    return context;
  }

  turn(input: ProjectRuntimeTurnInput): Promise<ProjectRuntimeTurnResult> {
    return retryProjectRuntimeLifecycle(
      () => this.runTurn(input),
      { retryLimit: input.lifecycleLeaseToken ? 0 : LIFECYCLE_RETRY_LIMIT },
    );
  }

  readLatestTestPlan(workspaceId: string, projectId: string): Promise<Readonly<Record<string, unknown>> | null> {
    return this.repository.readLatestTestPlan(workspaceId, projectId);
  }

  private async runTurn(input: ProjectRuntimeTurnInput): Promise<ProjectRuntimeTurnResult> {
    if (!input.lifecycleLeaseToken) {
      const interrupted = await this.repository.interruptIdleCompaction(
        input.workspaceId,
        input.projectId,
        input.settings.agentRuntime,
      );
      if (interrupted?.containerId) {
        await this.backend.cancel({
          schemaVersion: PROJECT_RUNTIME_SCHEMA,
          workspaceId: interrupted.workspaceId,
          projectId: interrupted.projectId,
          generation: interrupted.generation,
          fencingToken: interrupted.fencingToken,
          runtime: interrupted.runtime,
        });
      }
    }
    const registered = await this.readRegisteredContext(input.workspaceId, input.projectId);
    let metadata = registered.metadata;
    let context = registered.context;
    const runtime = await this.repository.ensureContainer(input.workspaceId, input.projectId, input.settings.agentRuntime)
      .catch(async error => {
        const current = await this.repository.readContainer(input.workspaceId, input.projectId);
        if (!current || current.runtime === input.settings.agentRuntime) throw error;
        const claim = await this.waitForRuntimeSwitchClaim(
          input.workspaceId, input.projectId, input.settings.agentRuntime,
        );
        try {
          await this.compactForRuntimeSwitch(input, claim.runtime, claim.generation, claim.leaseToken);
          const switched = await this.repository.switchContainerRuntime(
            input.workspaceId, input.projectId, input.settings.agentRuntime, claim.leaseToken,
          );
          await this.backend.destroy({
            schemaVersion: PROJECT_RUNTIME_SCHEMA,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            generation: claim.generation,
            fencingToken: claim.fencingToken,
            runtime: claim.runtime,
          }).catch(() => undefined);
          return switched;
        } catch (switchError) {
          await this.repository.failLifecycle({ ...claim, action: "PAUSE" }).catch(() => undefined);
          throw switchError;
        }
      });
    const latestRegistered = await this.readRegisteredContext(input.workspaceId, input.projectId);
    const latestMetadata = latestRegistered.metadata;
    if (latestMetadata.revision !== metadata.revision) {
      metadata = latestMetadata;
      context = latestRegistered.context;
    }
    const runtimeImage = await this.repository.runtimeImage(input.settings.agentRuntime);
    const ensured = await this.backend.ensure({
      schemaVersion: PROJECT_RUNTIME_SCHEMA,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      generation: runtime.generation,
      fencingToken: runtime.fencingToken,
      runtime: input.settings.agentRuntime,
      runtimeImage,
      sourceRelativePath: input.sourceRelativePath,
      contextRelativePath: metadata.relativePath,
    });
    const marked = await this.repository.markContainer(input.workspaceId, input.projectId, {
      generation: runtime.generation,
      fencingToken: runtime.fencingToken,
      state: runtimeContainerStateForTurn(input.mode, input.lifecycleLeaseToken),
      containerId: ensured.containerId,
      lifecycleLeaseToken: input.lifecycleLeaseToken,
    });
    if (!marked) throw new Error("Project Runtime lifecycle transition changed before the turn started");
    const started = await this.repository.startTurn({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      workflowJobId: input.workflowJobId,
      role: input.role,
      mode: input.mode,
      runtime: input.settings.agentRuntime,
      contextRevision: context.revision,
      sourceRevision: input.sourceRevision,
      responseLanguage: input.responseLanguage,
      lifecycleLeaseToken: input.lifecycleLeaseToken,
    });
    const stagedAttachments = await this.stageAttachments(
      input.workspaceId,
      input.projectId,
      started.id,
      input.attachments ?? Object.freeze([]),
    );
    try {
      const result = await this.backend.turn({
        schemaVersion: PROJECT_RUNTIME_SCHEMA,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        generation: started.generation,
        fencingToken: started.fencingToken,
        turnId: started.id,
        role: input.role,
        mode: input.mode,
        runtime: input.settings.agentRuntime,
        runtimeImage,
        baseUrl: input.settings.baseUrl,
        model: resolveAgentModel(input.settings.primaryModel, input.settings.modelOverrides, ROLE_TO_MODEL[input.role]),
        sourceRevision: input.sourceRevision,
        sourceRelativePath: input.sourceRelativePath,
        contextRevision: context.revision,
        responseLanguage: input.responseLanguage,
        prompt: input.prompt,
        attachmentPaths: stagedAttachments.paths,
        credentialRef: input.settings.credentialSecretRef,
        mcpToken: started.mcpToken,
        leaseToken: started.leaseToken,
        leaseExpiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      }, undefined, input.onEvent);
      if (input.role === "ANALYSIS" && input.mode === "PRIMARY") {
        const durable = await this.readContext(input.workspaceId, input.projectId);
        if (durable.workflow.analysisTurnId !== result.turnId) {
          throw new Error("Project Analysis Agent did not persist its report through context_update_analysis");
        }
      }
      if (input.role === "DESIGN" && input.mode === "PRIMARY") {
        const durable = await this.readContext(input.workspaceId, input.projectId);
        if (!runtimeTurnHandoff(durable, result.turnId, "DESIGN", "UI_DESIGN")) {
          throw new Error("Design Agent completed without creating a UI_DESIGN handoff");
        }
      }
      if (input.role === "UI_DESIGN" && input.mode === "PRIMARY") {
        const durable = await this.readContext(input.workspaceId, input.projectId);
        if (!runtimeTurnHandoff(durable, result.turnId, "UI_DESIGN", "DEVELOPMENT")) {
          throw new Error("UI Design Agent completed without creating a DEVELOPMENT handoff");
        }
      }
      const toolSummaries = summarizeRuntimeToolCalls(result.toolCalls);
      const completed = await this.repository.completeTurn({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        turnId: started.id,
        leaseToken: started.leaseToken,
        fencingToken: started.fencingToken,
        nativeSessionId: result.sessionId,
        outputSummary: result.content,
        structuredOutput: result.structured,
        toolSummary: toolSummaries,
      });
      if (!completed) throw new Error("Project Runtime turn completion was rejected by fencing");
      await this.mutateContext(input.workspaceId, input.projectId, current => updateProjectContext(current, {
        roles: Object.freeze({ ...current.roles, [input.role]: Object.freeze({
          sessionId: input.mode === "READ_ONLY_BRANCH"
            ? (current.roles[input.role]?.sessionId ?? null)
            : result.sessionId,
          summary: result.content.slice(0, 64_000),
          lastTurnId: input.mode === "READ_ONLY_BRANCH"
            ? (current.roles[input.role]?.lastTurnId ?? null)
            : result.turnId,
          updatedAt: result.completedAt,
        }) }),
        recentConversation: Object.freeze([...current.recentConversation, Object.freeze({
          role: input.role, mode: input.mode, summary: result.content.slice(0, 4_000), completedAt: result.completedAt,
        })].slice(-40)),
        recentTools: Object.freeze([...current.recentTools, ...toolSummaries].slice(-100)),
      }));
      return result;
    } catch (error) {
      await this.repository.failTurn({
        workspaceId: input.workspaceId, projectId: input.projectId,
        turnId: started.id, leaseToken: started.leaseToken,
        fencingToken: started.fencingToken,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      throw error;
    } finally {
      this.rejectedNarrativeSourceDigests.delete(started.id);
      await rm(stagedAttachments.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async readContext(workspaceId: string, projectId: string): Promise<ProjectContext> {
    return (await this.readRegisteredContext(workspaceId, projectId)).context;
  }

  readProjectInput(workspaceId: string, projectId: string) {
    return this.repository.readProjectInput(workspaceId, projectId);
  }

  recordSourceRevision(input: Readonly<{
    workspaceId: string;
    projectId: string;
    revision: number;
    relativePath: string;
    digest: string;
    fileCount: number;
    totalBytes: number;
  }>): Promise<void> {
    return this.repository.recordSourceRevision(input);
  }

  async recordWorkflowJobResult(input: Readonly<{
    workspaceId: string;
    projectId: string;
    jobId: string;
    jobKind: "AGENT_TURN" | "BUILD" | "E2E_PLATFORM_RUN" | "STEAM_PUBLISH";
    outputCount?: number;
  }>): Promise<ProjectContext> {
    const workflowState = await this.repository.readWorkflowState(input.workspaceId, input.projectId);
    const testRuns = input.jobKind === "E2E_PLATFORM_RUN"
      ? (await this.repository.readTestEvidence(input.workspaceId, input.projectId)).map(run => Object.freeze({
          id: run.id, targetPlatform: run.targetPlatform, sourceRevision: run.sourceRevision,
          planRevision: run.planRevision, verdict: run.verdict, failureClass: run.failureClass,
          completedAt: run.completedAt,
        }))
      : null;
    const completedAt = new Date().toISOString();
    return this.mutateContext(input.workspaceId, input.projectId, current => updateProjectContext(current, {
      workflow: Object.freeze({ ...current.workflow, ...(workflowState ? { state: workflowState } : {}),
        lastCompletedJobId: input.jobId, lastCompletedJobKind: input.jobKind, updatedAt: completedAt }),
      ...(input.jobKind === "BUILD" ? { buildSummary: Object.freeze({
        jobId: input.jobId, outcome: "SUCCEEDED", sourceRevision: current.source?.revision ?? null,
        outputCount: input.outputCount ?? 0, completedAt,
      }) } : {}),
      ...(input.jobKind === "E2E_PLATFORM_RUN" ? { testSummary: Object.freeze({
        lastPlatformRunJobId: input.jobId, outcome: "RECORDED", runs: testRuns, completedAt,
      }) } : {}),
    }));
  }

  async recordWorkflowJobFailure(input: Readonly<{
    workspaceId: string;
    projectId: string;
    jobId: string;
    jobKind: "AGENT_TURN" | "BUILD" | "E2E_PLATFORM_RUN" | "STEAM_PUBLISH";
    error: string;
  }>): Promise<ProjectContext> {
    const workflowState = await this.repository.readWorkflowState(input.workspaceId, input.projectId);
    const failedAt = new Date().toISOString();
    const failure = Object.freeze({ jobId: input.jobId, jobKind: input.jobKind,
      outcome: "FAILED", error: input.error.slice(0, 2_000), failedAt });
    return this.mutateContext(input.workspaceId, input.projectId, current => updateProjectContext(current, {
      workflow: Object.freeze({ ...current.workflow, ...(workflowState ? { state: workflowState } : {}),
        lastFailure: failure, updatedAt: failedAt }),
      ...(input.jobKind === "BUILD" ? { buildSummary: failure } : {}),
      ...(input.jobKind === "E2E_PLATFORM_RUN" ? { testSummary: failure } : {}),
    }));
  }

  private async compactForRuntimeSwitch(
    input: Readonly<{
      workspaceId: string;
      projectId: string;
      responseLanguage: "en" | "zh";
      settings: StoredInstanceAgentSettings;
      sourceRevision: number | null;
      sourceRelativePath: string | null;
    }>,
    runtime: StoredInstanceAgentSettings["agentRuntime"],
    generation: number,
    lifecycleLeaseToken: string,
  ): Promise<void> {
    const roles = await this.repository.sessionRoles(input.workspaceId, input.projectId, generation);
    const settings = Object.freeze({ ...input.settings, agentRuntime: runtime });
    for (const role of roles) {
      await this.turn({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        role,
        mode: "COMPACT",
        prompt: "Summarize this role session for a Runtime switch. Preserve decisions, open work, source checkpoints, test evidence, and handoffs. Do not change the project or start work.",
        responseLanguage: input.responseLanguage,
        settings,
        sourceRevision: input.sourceRevision,
        sourceRelativePath: input.sourceRelativePath,
        lifecycleLeaseToken,
      });
    }
  }

  private async waitForRuntimeSwitchClaim(
    workspaceId: string,
    projectId: string,
    runtime: StoredInstanceAgentSettings["agentRuntime"],
  ) {
    const deadline = Date.now() + 24 * 60 * 60_000;
    while (Date.now() < deadline) {
      const current = await this.repository.readContainer(workspaceId, projectId);
      if (!current) throw new Error("Project Runtime disappeared while waiting for a safe point");
      if (current.runtime === runtime) {
        throw new Error("Project Runtime selection was switched by another request; retry the turn");
      }
      const claim = await this.repository.claimRuntimeSwitch(workspaceId, projectId, runtime);
      if (claim) return claim;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("Project Runtime did not reach a safe point before the active turn deadline");
  }

  pauseRuntime(request: ProjectRuntimeControlRequest) {
    return this.backend.pause(request);
  }

  destroyRuntime(request: ProjectRuntimeControlRequest) {
    return this.backend.destroy(request);
  }

  async reconcileRuntimes(): Promise<Readonly<{ attached: number; destroyed: number; missing: number }>> {
    const [databaseRecords, physicalRecords] = await Promise.all([
      this.repository.listContainers(),
      this.backend.list(),
    ]);
    const databaseByProject = new Map(databaseRecords.map(record => [
      `${record.workspaceId}:${record.projectId}`,
      record,
    ]));
    const present = new Set<string>();
    let attached = 0;
    let destroyed = 0;
    let missing = 0;
    for (const physical of physicalRecords) {
      const identity = physicalIdentity(physical);
      if (!identity) continue;
      const key = `${identity.workspaceId}:${identity.projectId}`;
      const database = databaseByProject.get(key);
      const current = database
        && database.generation === identity.generation
        && database.fencingToken === identity.fencingToken
        && database.runtime === identity.runtime
        && !["DESTROYED", "STOPPED"].includes(database.state);
      if (!current) {
        await this.backend.destroy(controlFromPhysical(identity)).catch(() => undefined);
        destroyed += 1;
        continue;
      }
      present.add(key);
      if (!["COMPACTING", "PAUSING"].includes(database.state)) {
        await this.repository.markContainer(identity.workspaceId, identity.projectId, {
          generation: identity.generation,
          fencingToken: identity.fencingToken,
          state: identity.state,
          containerId: identity.containerId,
        });
      }
      attached += 1;
    }
    for (const record of databaseRecords) {
      const key = `${record.workspaceId}:${record.projectId}`;
      if (!record.containerId || present.has(key)
        || !["RUNNING", "PAUSED", "PAUSING", "COMPACTING", "FAILED"].includes(record.state)) continue;
      await this.repository.markContainer(record.workspaceId, record.projectId, {
        generation: record.generation,
        fencingToken: record.fencingToken,
        state: "DESTROYED",
        containerId: null,
      });
      missing += 1;
    }
    return Object.freeze({ attached, destroyed, missing });
  }

  setWorkflowStopped(workspaceId: string, projectId: string, stopped: boolean) {
    return this.controlWorkflow(workspaceId, projectId, stopped);
  }

  private async controlWorkflow(workspaceId: string, projectId: string, stopped: boolean) {
    const current = await this.repository.readContainer(workspaceId, projectId);
    if (current?.containerId) {
      await this.backend.destroy({
        schemaVersion: PROJECT_RUNTIME_SCHEMA,
        workspaceId,
        projectId,
        generation: current.generation,
        fencingToken: current.fencingToken,
        runtime: current.runtime,
      }).catch(() => undefined);
    }
    const runtime = await this.repository.setStopped(workspaceId, projectId, stopped);
    const workflowState = stopped
      ? "STOPPED"
      : await this.repository.readWorkflowState(workspaceId, projectId) ?? "DEVELOPING";
    const context = await this.updateWorkflow(workspaceId, projectId, {
      state: workflowState,
      stopped,
    });
    return Object.freeze({ ...context, runtime });
  }

  private async stageAttachments(
    workspaceId: string,
    projectId: string,
    turnId: string,
    attachments: readonly Readonly<{ content: Buffer; extension: "png" | "jpg" | "webp" }>[],
  ): Promise<Readonly<{ directory: string; paths: readonly string[] }>> {
    const project = resolve(this.projectsRoot, "workspaces", workspaceId, "projects", projectId);
    const directory = join(project, "runtime", "attachments", turnId);
    if (attachments.length === 0) return Object.freeze({ directory, paths: Object.freeze([]) });
    await mkdir(directory, { recursive: true, mode: 0o2750 });
    const paths: string[] = [];
    for (const attachment of attachments) {
      const name = `${randomUUID()}.${attachment.extension}`;
      await writeFile(join(directory, name), attachment.content, { mode: 0o640 });
      paths.push(`/workspace/project/runtime/attachments/${turnId}/${name}`);
    }
    return Object.freeze({ directory, paths: Object.freeze(paths) });
  }

  async callTool(input: Readonly<{
    workspaceId: string;
    projectId: string;
    turnId: string;
    role: ProjectRuntimeRole;
    name: string;
    token: string;
    arguments: Readonly<Record<string, unknown>>;
  }>): Promise<Readonly<Record<string, unknown>>> {
    if (!ROLE_TOOLS[input.role]?.has(input.name)) throw new Error(`${input.name} is not authorized for ${input.role}`);
    const authorization = await this.repository.authorizeTool(input);
    if (!authorization) throw new Error("Project MCP token, turn, or fencing token is invalid");
    if (authorization.mode !== "PRIMARY" && !READ_ONLY_TOOLS.has(input.name)) {
      throw new Error(`${input.name} is not authorized in ${authorization.mode} mode`);
    }
    const validatedArguments = boundedObject(input.arguments, projectRuntimeToolArgumentLimit(input.name));
    const callId = await this.repository.beginToolCall({
      ...input,
      sessionId: authorization.sessionId,
      arguments: summarizeToolAuditValue(validatedArguments),
    });
    try {
      const result = await this.executeTool({ ...input, arguments: validatedArguments });
      await this.repository.finishToolCall(input.workspaceId, callId, summarizeToolAuditValue(result));
      return result;
    } catch (error) {
      await this.repository.finishToolCall(input.workspaceId, callId, {
        error: error instanceof Error ? error.message.slice(0, 2_000) : "Tool failed",
      }, true).catch(() => undefined);
      throw error;
    }
  }

  private async executeTool(input: Readonly<{
    workspaceId: string; projectId: string; turnId: string; role: ProjectRuntimeRole;
    name: string; arguments: Readonly<Record<string, unknown>>;
  }>): Promise<Readonly<Record<string, unknown>>> {
    if (input.name === "context.read") {
      const context = await this.readContext(input.workspaceId, input.projectId);
      return Object.freeze({ context: projectRuntimeContextView(context, input.role) });
    }
    if (input.name === "source.list") return Object.freeze({ paths: await this.listSource(input.workspaceId, input.projectId) });
    if (input.name === "source.read") {
      return this.readSource(input.workspaceId, input.projectId, String(input.arguments.path ?? ""), {
        startLine: input.arguments.startLine,
        endLine: input.arguments.endLine,
      });
    }
    if (["conversation.reply", "workflow.intent_decision"].includes(input.name)) return Object.freeze({ accepted: true });
    if (input.name === "workflow.stop") return this.updateWorkflow(input.workspaceId, input.projectId, { state: "STOPPED", stopped: true });
    if (input.name === "workflow.continue") return this.updateWorkflow(input.workspaceId, input.projectId, { state: "DEVELOPING", stopped: false });
    if (input.name === "context.update_analysis") {
      const analysis = normalizeImportedProjectAnalysisReport(input.arguments.analysis);
      return this.updateWorkflow(input.workspaceId, input.projectId, { analysis, analysisTurnId: input.turnId });
    }
    if (input.name === "requirements.update") {
      return this.confirmApprovedField(input.workspaceId, input.projectId,
        "requirements", arrayOfObjects(input.arguments.requirements));
    }
    if (input.name === "project_document.update") {
      const document = parseProjectDocumentContent(input.arguments.document);
      if (input.role === "UI_DESIGN") {
        return this.updateUiDesignDocument(input.workspaceId, input.projectId, document);
      }
      return this.confirmApprovedField(input.workspaceId, input.projectId,
        "projectDocument", document);
    }
    if (input.name === "e2e_goals.update") {
      const goals = normalizeRuntimeE2eGoals(input.arguments.goals);
      if (input.role === "UI_DESIGN") {
        return this.replaceUiDesignGoals(input.workspaceId, input.projectId, goals);
      }
      const current = await this.readContext(input.workspaceId, input.projectId);
      if (!sameJson(goals, current.e2e.goals)) {
        throw new Error(`${input.role} Agent cannot change the approved E2E goal snapshot during execution`);
      }
      return Object.freeze({ accepted: true, contextRevision: current.revision,
        goalRevision: current.e2e.goalRevision });
    }
    if (input.name === "assets.plan") {
      return this.replaceAssetPlan(input.workspaceId, input.projectId, arrayOfObjects(input.arguments.assets));
    }
    if (input.name === "assets.cleanup") {
      const retained = new Set(arrayOfStrings(input.arguments.retainedKeys));
      const context = await this.readContext(input.workspaceId, input.projectId);
      return this.replaceAssetPlan(input.workspaceId, input.projectId,
        context.assetPlan.filter(asset => retained.has(String(asset.key ?? ""))));
    }
    if (input.name === "handoff.create") {
      const handoff = boundedObject(input.arguments);
      const toRole = String(handoff.toRole ?? "");
      const summary = typeof handoff.summary === "string" ? handoff.summary.trim() : "";
      if (!PROJECT_RUNTIME_ROLES.includes(toRole as ProjectRuntimeRole) || toRole === input.role || !summary) {
        throw new Error("Agent handoff requires a different valid role and a non-empty summary");
      }
      const uiSpecification = input.role === "UI_DESIGN" && toRole === "DEVELOPMENT"
        ? normalizeUiSpecification(handoff.uiSpecification)
        : null;
      if (handoff.uiSpecification !== undefined && !uiSpecification) {
        throw new Error("Only UI Design may attach a UI specification to its Development handoff");
      }
      return this.mutateResult(input.workspaceId, input.projectId, current => updateProjectContext(current, {
        handoffs: Object.freeze([...current.handoffs, Object.freeze({
          id: input.turnId, fromRole: input.role, toRole,
          summary, ...(uiSpecification ? { uiSpecification } : {}), createdAt: new Date().toISOString(),
        })].slice(-20)),
      }));
    }
    if (input.name === "source.checkpoint") {
      return this.checkpointSource(
        input.workspaceId,
        input.projectId,
        input.turnId,
        input.arguments.narrativeProof,
      );
    }
    if (input.name === "build.request") {
      return this.requestBuildAfterCurrentTurnCheckpoint(input.workspaceId, input.projectId, input.turnId);
    }
    if (input.name === "test_plan.replace") {
      const draftPlan = boundedObject(input.arguments.plan, MAX_TEST_PLAN_TOOL_ARGUMENT_BYTES);
      const before = await this.readContext(input.workspaceId, input.projectId);
      if (!before.source) throw new Error("A test plan requires a published source revision");
      const candidatePlan = freezeTestPlan(draftPlan, before);
      await this.validatePublishedProbeReferences(input.workspaceId, input.projectId, candidatePlan);
      const context = await this.mutateContext(input.workspaceId, input.projectId, current => {
        if (!current.source) throw new Error("A test plan requires a published source revision");
        if (current.source.revision !== before.source!.revision || current.e2e.goalRevision !== before.e2e.goalRevision) {
          throw new Error("The source or E2E goals changed while the Test Agent was authoring its plan");
        }
        return updateProjectContext(current, { e2e: Object.freeze({
          ...current.e2e,
          planRevision: (current.e2e.planRevision ?? 0) + 1,
          plan: candidatePlan,
        }) });
      });
      const stored = await this.repository.recordTestPlan({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        turnId: input.turnId,
        requirementRevision: Math.max(1, context.e2e.goalRevision),
        sourceRevision: context.source!.revision,
        planRevision: context.e2e.planRevision!,
        plan: context.e2e.plan!,
      });
      return Object.freeze({
        accepted: true,
        contextRevision: context.revision,
        planId: stored.id,
        planRevision: context.e2e.planRevision,
        planSha256: stored.sha256,
      });
    }
    if (input.name === "test_plan.revise_timeout") {
      const before = await this.readContext(input.workspaceId, input.projectId);
      if (!before.source) throw new Error("A test plan requires a published source revision");
      const basePlanRevision = Number(input.arguments.basePlanRevision);
      const timeoutMs = Number(input.arguments.timeoutMs);
      if (!Number.isInteger(basePlanRevision) || basePlanRevision < 1
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) {
        throw new Error("A test plan timeout revision requires a valid basePlanRevision and timeoutMs");
      }
      const storedBase = await this.repository.readTestPlanRevision(
        input.workspaceId,
        input.projectId,
        before.source.revision,
        basePlanRevision,
      );
      if (!storedBase) throw new Error("The requested base Test plan does not exist for the current source revision");
      const candidatePlan = freezeTestPlan(
        reviseTestPlanTimeout(boundedObject(storedBase.plan, MAX_TEST_PLAN_TOOL_ARGUMENT_BYTES), timeoutMs),
        before,
      );
      await this.validatePublishedProbeReferences(input.workspaceId, input.projectId, candidatePlan);
      const context = await this.mutateContext(input.workspaceId, input.projectId, current => {
        if (!current.source || current.source.revision !== before.source!.revision
          || current.e2e.goalRevision !== before.e2e.goalRevision) {
          throw new Error("The source or E2E goals changed while the Test Agent was revising its plan timeout");
        }
        return updateProjectContext(current, { e2e: Object.freeze({
          ...current.e2e,
          planRevision: (current.e2e.planRevision ?? 0) + 1,
          plan: candidatePlan,
        }) });
      });
      const stored = await this.repository.recordTestPlan({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        turnId: input.turnId,
        requirementRevision: Math.max(1, context.e2e.goalRevision),
        sourceRevision: context.source!.revision,
        planRevision: context.e2e.planRevision!,
        plan: context.e2e.plan!,
      });
      return Object.freeze({
        accepted: true,
        contextRevision: context.revision,
        basePlanRevision,
        planId: stored.id,
        planRevision: context.e2e.planRevision,
        planSha256: stored.sha256,
      });
    }
    if (input.name === "test.verdict") {
      const testSummary = boundedObject(input.arguments);
      const current = await this.readContext(input.workspaceId, input.projectId);
      const uiSpecification = latestUiSpecification(current);
      if (String(testSummary.verdict ?? "") === "PASS" && uiSpecification) {
        const uiReview = normalizeUiTestReview(testSummary.uiReview, uiSpecification);
        return this.updateField(input.workspaceId, input.projectId, "testSummary",
          Object.freeze({ ...testSummary, uiReview }));
      }
      return this.updateField(input.workspaceId, input.projectId, "testSummary", testSummary);
    }
    if (input.name === "e2e.start") {
      const plan = await this.repository.readLatestTestPlan(input.workspaceId, input.projectId);
      if (!plan) throw new Error("The Test Agent must persist a complete plan before starting E2E");
      return Object.freeze({ accepted: true, plan, delegatedTo: "controlled-host-gateway" });
    }
    if (input.name === "e2e.observe") {
      return Object.freeze({ runs: await this.repository.readTestEvidence(input.workspaceId, input.projectId) });
    }
    if (input.name === "evidence.read") {
      const runs = await this.repository.readTestEvidence(input.workspaceId, input.projectId);
      const visualEvidence = await this.readVisualEvidence(
        input.workspaceId,
        input.projectId,
        runs,
        input.arguments,
      );
      // e2e.observe owns history discovery. Repeating every historical run on
      // each six-image page needlessly floods the model context and can force
      // compaction before a long visual review finishes.
      return Object.freeze({ runs: evidenceRunsForVisualRead(runs), ...visualEvidence });
    }
    if (input.name === "diagnostics.run") {
      return Object.freeze({ accepted: true, delegatedTo: "controlled-host-gateway", bounded: true });
    }
    throw new Error(`Project Runtime tool is not implemented: ${input.name}`);
  }

  private async readVisualEvidence(
    workspaceId: string,
    projectId: string,
    runs: readonly Readonly<Record<string, unknown>>[],
    selector: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const selected = latestEvidenceReport(runs);
    if (!selected) return Object.freeze({ visualEvidence: Object.freeze({ available: false, reason: "NO_E2E_REPORT" }) });
    if (typeof selector.runId === "string" && selector.runId !== selected.runId) {
      throw new Error(`Evidence run ${selector.runId} is not the latest completed run`);
    }
    if (!this.artifactReader) {
      return Object.freeze({ visualEvidence: Object.freeze({
        available: false,
        reason: "ARTIFACT_READER_UNAVAILABLE",
        runId: selected.runId,
      }) });
    }
    const archive = await this.artifactReader.readProjectArtifact({
      workspaceId,
      projectId,
      ...selected.object,
      maximumBytes: AGENT_EVIDENCE_ARCHIVE_MAX_BYTES,
    });
    // The Core container intentionally has a small tmpfs at /tmp. E2E bundles
    // can be much larger than that after videos and checkpoint frames are
    // included, so extracting there turns valid evidence into an ENOSPC
    // verdict. Keep transient evidence on the bounded project-data volume and
    // remove it in the finally block below.
    const temporaryRoot = agentEvidenceTemporaryRoot(this.projectsRoot);
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(temporaryRoot, "read-"));
    try {
      const archivePath = join(directory, "evidence.zip");
      const extractionRoot = join(directory, "extracted");
      await writeFile(archivePath, archive, { mode: 0o600 });
      const validated = await extractAndValidateEvidenceBundle(
        archivePath,
        extractionRoot,
        AGENT_EVIDENCE_ARCHIVE_MAX_BYTES,
      );
      const reportCheckpoints = Array.isArray(validated.report.checkpoints)
        ? validated.report.checkpoints
        : [];
      const availableCheckpoints = visualEvidenceCheckpoints(reportCheckpoints);
      const selectedCheckpoints = selectVisualEvidenceCheckpoints(availableCheckpoints, selector);
      const evidenceImages: Readonly<Record<string, unknown>>[] = [];
      for (const selection of selectedCheckpoints) {
        const checkpoint = selection.checkpoint;
        const role = String(checkpoint.role);
        const relativeScreenshot = String(checkpoint.screenshot);
        const screenshotPath = resolve(extractionRoot, relativeScreenshot);
        const boundedPath = relative(extractionRoot, screenshotPath);
        if (!boundedPath || boundedPath === ".." || boundedPath.startsWith(`..${sep}`)) {
          throw new Error("E2E screenshot escaped the validated evidence root");
        }
        const original = await readFile(screenshotPath);
        if (original.length < 1 || original.length > AGENT_EVIDENCE_IMAGE_MAX_BYTES) {
          throw new Error("E2E screenshot size is invalid for Agent visual review");
        }
        const image = await sharp(original)
          .resize({ width: 960, height: 540, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 84, chromaSubsampling: "4:4:4" })
          .toBuffer();
        evidenceImages.push(Object.freeze({
          runId: selected.runId,
          targetPlatform: selected.targetPlatform,
          checkpointId: typeof checkpoint.checkpointId === "string" ? checkpoint.checkpointId : role.toLowerCase(),
          checkpointRole: role,
          contentIndex: selection.contentIndex,
          mimeType: "image/jpeg",
          sizeBytes: image.length,
          data: image.toString("base64"),
        }));
      }
      return Object.freeze({
        visualEvidence: Object.freeze({
          available: evidenceImages.length > 0,
          runId: selected.runId,
          targetPlatform: selected.targetPlatform,
          reportOutcome: validated.report.outcome,
          imageCount: availableCheckpoints.length,
          returnedImageCount: evidenceImages.length,
          checkpoints: Object.freeze(availableCheckpoints.map((checkpoint, index) => Object.freeze({
            contentIndex: index + 1,
            checkpointId: typeof checkpoint.checkpointId === "string"
              ? checkpoint.checkpointId : String(checkpoint.role).toLowerCase(),
            checkpointRole: String(checkpoint.role),
          }))),
        }),
        evidenceImages: Object.freeze(evidenceImages),
      });
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async checkpointSource(
    workspaceId: string,
    projectId: string,
    turnId: string,
    narrativeProof: unknown,
  ): Promise<Readonly<Record<string, unknown>>> {
    const context = await this.readContext(workspaceId, projectId);
    const uiSpecification = latestUiSpecification(context);
    if (uiSpecification) assertRequiredUiAssets(uiSpecification, context.assetPlan);
    const revision = (context.source?.revision ?? 0) + 1;
    const directory = join(resolve(this.projectsRoot), "workspaces", workspaceId, "projects", projectId, "runtime", "worktree");
    const narrativeScenes = requiredNarrativeSceneAssetKeys(context);
    const checkpointAssetPlanDigest = stableDigest(context.assetPlan);
    if (narrativeScenes.length > 0) {
      const narrativeSourceDigest = await narrativeProofSourceDigest(directory, narrativeProof);
      if (this.rejectedNarrativeSourceDigests.get(turnId) === narrativeSourceDigest) {
        throw new Error(
          "Narrative source is unchanged after a content-quality rejection; edit the production story source before retrying source.checkpoint",
        );
      }
      try {
        await validateNarrativeDeliveryProof(directory, narrativeScenes, narrativeProof);
      } catch (error) {
        if (isNarrativeSourceQualityRejection(error)) {
          this.rejectedNarrativeSourceDigests.set(turnId, narrativeSourceDigest);
        }
        throw error;
      }
      this.rejectedNarrativeSourceDigests.delete(turnId);
    }
    await this.requireProbePublisher(directory);
    // ProjectSourceStore validates every path and rejects links while publishing.
    const stored = await this.sources.publishDirectory({ workspaceId, projectId, revision, directory });
    await this.repository.recordSourceRevision({ workspaceId, projectId, revision,
      relativePath: stored.relativePath, digest: stored.digest, fileCount: stored.fileCount, totalBytes: stored.totalBytes });
    await this.mutateContext(workspaceId, projectId, current => updateProjectContext(current, {
      source: Object.freeze({ revision, sha256: stored.digest, relativePath: stored.relativePath }),
      e2e: Object.freeze({ ...current.e2e, planRevision: null, plan: null }),
      testSummary: null,
      workflow: Object.freeze({
        ...current.workflow,
        sourceCheckpointedByTurnId: turnId,
        sourceCheckpointRevision: revision,
        sourceCheckpointAssetPlanDigest: checkpointAssetPlanDigest,
        buildRequestedByTurnId: null,
      }),
    }));
    return Object.freeze({ revision, sha256: stored.digest, relativePath: stored.relativePath,
      narrativeScenesVerified: narrativeScenes.length });
  }

  private async requestBuildAfterCurrentTurnCheckpoint(
    workspaceId: string,
    projectId: string,
    turnId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.mutateResult(workspaceId, projectId, current => {
      if (!hasCurrentTurnSourceCheckpoint(current, turnId)) {
        throw new Error("A controlled build requires a successful source checkpoint from the current Development turn");
      }
      return updateProjectContext(current, { workflow: Object.freeze({
        ...current.workflow,
        state: "BUILDING",
        buildRequestedByTurnId: turnId,
      }) });
    });
  }

  private async listSource(workspaceId: string, projectId: string): Promise<readonly string[]> {
    const root = await this.sourceRoot(workspaceId, projectId);
    const paths: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) paths.push(relative(root, path).split(sep).join("/"));
        if (paths.length > 20_000) throw new Error("Project source contains too many files");
      }
    };
    await visit(root);
    return Object.freeze(paths.sort());
  }

  private async readSource(
    workspaceId: string,
    projectId: string,
    path: string,
    range: Readonly<{ startLine: unknown; endLine: unknown }>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const root = await this.sourceRoot(workspaceId, projectId);
    const target = resolve(root, normalizeProjectPath(path));
    if (!target.startsWith(`${root}${sep}`)) throw new Error("Source path escapes the project");
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error("Source file is not readable");
    const bytes = await readFile(target);
    if (bytes.includes(0)) throw new Error("Binary source is not returned as conversation context");
    const hasRange = range.startLine !== undefined || range.endLine !== undefined;
    if (!hasRange) {
      if (info.size > 1024 * 1024) {
        throw new Error("Source file exceeds 1 MiB; provide startLine and endLine to read at most 1000 lines");
      }
      return Object.freeze({ content: bytes.toString("utf8") });
    }
    const startLine = Number(range.startLine);
    const endLine = Number(range.endLine);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
      || startLine < 1 || endLine < startLine || endLine - startLine >= 1_000) {
      throw new Error("source.read line range must use 1-based startLine/endLine spanning at most 1000 lines");
    }
    const lines = bytes.toString("utf8").split("\n");
    return Object.freeze({
      content: lines.slice(startLine - 1, endLine).join("\n"),
      startLine,
      endLine: Math.min(endLine, lines.length),
      totalLines: lines.length,
    });
  }

  private async validatePublishedProbeReferences(
    workspaceId: string,
    projectId: string,
    plan: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const root = await this.sourceRoot(workspaceId, projectId);
    const publisherTexts = await this.requireProbePublisher(root);
    const missing = unpublishedTestPlanProbeReferences(plan, publisherTexts);
    if (missing.length > 0) {
      throw new Error(`The Test Agent plan references values not published by the current Probe source: ${missing
        .map(reference => `${reference.kind}:${reference.value}`).join(", ")}`);
    }
  }

  private async requireProbePublisher(root: string): Promise<readonly string[]> {
    const publisherTexts: string[] = [];
    const projectTexts: string[] = [];
    const fontPaths: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const target = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(target);
          continue;
        }
        if (!entry.isFile()) continue;
        const projectPath = relative(root, target).split(sep).join("/");
        if (/\.(?:tt[cf]|ot[cf]|woff2?)$/i.test(entry.name)) {
          fontPaths.push(projectPath);
          continue;
        }
        if (!/\.(?:gd|cs|js|mjs|cjs|ts|tsx|lua|py|tscn|tres|theme|css|html|json|ya?ml)$/i.test(entry.name)) continue;
        const info = await lstat(target);
        if (info.size > 16 * 1024 * 1024) continue;
        const bytes = await readFile(target);
        if (bytes.includes(0)) continue;
        const text = bytes.toString("utf8");
        projectTexts.push(text);
        if (text.includes("deviludo.e2e-ui-probe")) publisherTexts.push(text);
      }
    };
    await visit(root);
    const fontError = bundledCjkFontValidationError(projectTexts, fontPaths);
    if (fontError) throw new Error(fontError);
    if (publisherTexts.length === 0) {
      throw new Error("The current source does not publish the deviludo.e2e-ui-probe contract required by cross-platform E2E");
    }
    const publication = publisherTexts.join("\n");
    const missingFields = [
      "DEVILUDO_E2E_UI_PROBE_FILE", "DEVILUDO_E2E_SESSION_NONCE",
      "sessionNonce", "pid", "sequence", "sceneId", "state",
      "screen_mode", "session_active", "gameplay_input_enabled", "blocking_layer_count",
      "progress", "controls",
    ].filter(field => !publication.includes(field));
    if (missingFields.length > 0) {
      throw new Error(`The current E2E Probe publisher is missing required fields: ${missingFields.join(", ")}`);
    }
    return Object.freeze(publisherTexts);
  }

  private async sourceRoot(workspaceId: string, projectId: string): Promise<string> {
    const context = await this.readContext(workspaceId, projectId);
    if (!context.source) throw new Error("Project has no source revision");
    const root = resolve(this.projectsRoot);
    const source = resolve(root, context.source.relativePath);
    if (source !== root && !source.startsWith(`${root}${sep}`)) throw new Error("Source revision escapes the project store");
    return source;
  }

  private updateWorkflow(workspaceId: string, projectId: string, workflow: Readonly<Record<string, unknown>>) {
    return this.mutateResult(workspaceId, projectId, current => updateProjectContext(current, {
      workflow: Object.freeze({ ...current.workflow, ...workflow }),
    }));
  }

  private updateField(
    workspaceId: string,
    projectId: string,
    field: "requirements" | "projectDocument" | "assetPlan" | "testSummary",
    value: ProjectContext["requirements"] | ProjectContext["projectDocument"] | ProjectContext["assetPlan"] | ProjectContext["testSummary"],
  ) {
    return this.mutateResult(workspaceId, projectId, current => {
      if (field === "requirements") return updateProjectContext(current, { requirements: value as ProjectContext["requirements"] });
      if (field === "projectDocument") return updateProjectContext(current, { projectDocument: value as ProjectContext["projectDocument"] });
      if (field === "assetPlan") return updateProjectContext(current, { assetPlan: value as ProjectContext["assetPlan"] });
      return updateProjectContext(current, { testSummary: value as ProjectContext["testSummary"] });
    });
  }

  private async confirmApprovedField(
    workspaceId: string,
    projectId: string,
    field: "requirements" | "projectDocument",
    value: ProjectContext["requirements"] | ProjectContext["projectDocument"],
  ): Promise<Readonly<Record<string, unknown>>> {
    const current = await this.readContext(workspaceId, projectId);
    if (!sameJson(value, current[field])) {
      throw new Error(`Design Agent cannot change the approved ${field} snapshot during execution`);
    }
    return Object.freeze({ accepted: true, contextRevision: current.revision });
  }

  private async updateUiDesignDocument(
    workspaceId: string,
    projectId: string,
    document: ProjectDocumentContent,
  ): Promise<Readonly<Record<string, unknown>>> {
    const current = await this.readContext(workspaceId, projectId);
    const approved = parseProjectDocumentContent(current.projectDocument);
    for (const field of ["introduction", "gameplay", "categories", "features"] as const) {
      if (!sameJson(document[field], approved[field])) {
        throw new Error(`UI Design Agent cannot change the approved ${field} snapshot`);
      }
    }
    const persisted = await this.repository.updateUiDesignDocument({
      workspaceId,
      projectId,
      expectedRevision: Number(current.workflow.documentRevision ?? 0),
      document,
      responseLanguage: current.language,
    });
    const updated = await this.mutateContext(workspaceId, projectId, context => updateProjectContext(context, {
      projectDocument: document,
      workflow: Object.freeze({ ...context.workflow, documentRevision: persisted.revision }),
    }));
    return Object.freeze({ accepted: true, contextRevision: updated.revision,
      documentRevision: persisted.revision });
  }

  private async replaceUiDesignGoals(
    workspaceId: string,
    projectId: string,
    goals: readonly E2eGoal[],
  ): Promise<Readonly<Record<string, unknown>>> {
    const current = await this.readContext(workspaceId, projectId);
    const workflowId = String(current.workflow.id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(workflowId)) throw new Error("UI Design workflow id is invalid");
    const persisted = await this.repository.replaceUiDesignGoals({
      workspaceId,
      projectId,
      workflowId,
      expectedRevision: current.e2e.goalRevision,
      goals,
    });
    const updated = await this.mutateContext(workspaceId, projectId, context => updateProjectContext(context, {
      e2e: Object.freeze({ ...context.e2e, goalRevision: persisted.revision, goals }),
      requirements: Object.freeze([
        ...context.requirements.filter(requirement => requirement.source !== "CORE_LOOP"
          && requirement.source !== "ACCEPTANCE"),
        ...goals.map(goal => Object.freeze({ id: goal.id, text: goal.description, source: goal.source })),
      ]),
      workflow: Object.freeze({ ...context.workflow, goalRevision: persisted.revision }),
    }));
    return Object.freeze({ accepted: true, contextRevision: updated.revision,
      goalRevision: persisted.revision });
  }

  private async replaceAssetPlan(
    workspaceId: string,
    projectId: string,
    requested: readonly Readonly<Record<string, unknown>>[],
  ): Promise<Readonly<Record<string, unknown>>> {
    const next = normalizeAssetPlan(requested);
    const current = await this.readContext(workspaceId, projectId);
    const uiSpecification = latestUiSpecification(current);
    if (uiSpecification) assertRequiredUiAssets(uiSpecification, next);
    const nextKeys = new Set(next.map(asset => String(asset.key)));
    const nextPaths = new Set(next.map(asset => assetSourcePath(asset)).filter((path): path is string => path !== null));
    const retainedUploads = current.assetPlan.filter(asset => isUserUpload(asset) && !nextKeys.has(String(asset.key ?? "")));
    const retained = Object.freeze([...next, ...retainedUploads]);
    const retainedObjectKeys = new Set(retained.map(asset => String(asset.objectKey ?? "")).filter(Boolean));
    const retired = current.assetPlan.filter(asset => !isUserUpload(asset)
      && !nextKeys.has(String(asset.key ?? "")));
    const objects = retired.flatMap(asset => {
      const bucket = typeof asset.bucket === "string" ? asset.bucket : "";
      const objectKey = typeof asset.objectKey === "string" ? asset.objectKey : "";
      return bucket && objectKey && !retainedObjectKeys.has(objectKey)
        ? [Object.freeze({ bucket, objectKey })]
        : [];
    });
    const contextAfter = await this.mutateContext(workspaceId, projectId,
      value => updateProjectContext(value, { assetPlan: retained }));
    const workflowId = String(contextAfter.workflow.id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(workflowId)) throw new Error("Asset plan workflow id is invalid");
    const manifest = await this.repository.replaceAssetManifestPlan({
      workspaceId, projectId, workflowId, assets: retained,
    });
    const queuedObjects = await this.repository.queueGeneratedAssetCleanup({ workspaceId, objects });
    let removedFiles = 0;
    for (const asset of retired) {
      const path = assetSourcePath(asset);
      if (!path || nextPaths.has(path)) continue;
      if (await this.removeGeneratedSourceFile(workspaceId, projectId, path)) removedFiles += 1;
    }
    return Object.freeze({
      accepted: true,
      contextRevision: contextAfter.revision,
      retainedUploads: retainedUploads.length,
      retiredAssets: retired.length,
      manifestId: manifest.manifestId,
      plannedAssets: manifest.planned,
      queuedObjects,
      removedFiles,
    });
  }

  private async removeGeneratedSourceFile(
    workspaceId: string,
    projectId: string,
    relativePath: string,
  ): Promise<boolean> {
    const root = resolve(this.projectsRoot, "workspaces", workspaceId, "projects", projectId, "runtime", "worktree");
    const target = resolve(root, normalizeProjectPath(relativePath));
    if (!target.startsWith(`${root}${sep}`)) throw new Error("Generated asset source path escapes the project worktree");
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Generated asset source path is not a regular file");
      await rm(target);
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private async mutateResult(workspaceId: string, projectId: string, mutate: (context: ProjectContext) => ProjectContext) {
    const context = await this.mutateContext(workspaceId, projectId, mutate);
    return Object.freeze({ accepted: true, contextRevision: context.revision });
  }

  private async mutateContext(workspaceId: string, projectId: string, mutate: (context: ProjectContext) => ProjectContext): Promise<ProjectContext> {
    return this.withProjectLock(workspaceId, projectId, () => this.repository.updateContext(
      workspaceId,
      projectId,
      async metadata => {
        if (!metadata) throw new Error("Project context is missing");
        const before = (await this.contexts.read(workspaceId, projectId, metadata.sha256)).context;
        const after = mutate(before);
        const stored = await this.contexts.write(after);
        return Object.freeze({ stored, result: after });
      },
    ));
  }

  private async withProjectLock<T>(
    workspaceId: string,
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${workspaceId}:${projectId}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>(resolve => { release = resolve; });
    const chained = previous.then(() => current);
    this.locks.set(key, chained);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  private async readRegisteredContext(workspaceId: string, projectId: string): Promise<Readonly<{
    metadata: Readonly<{ revision: number; relativePath: string; sha256: string; sizeBytes: number }>;
    context: ProjectContext;
  }>> {
    return this.withProjectLock(workspaceId, projectId, () => this.repository.updateContext(
      workspaceId,
      projectId,
      async metadata => {
        if (!metadata) throw new Error("Project Runtime context has not been initialized");
        let stored: StoredProjectContext;
        let recovered = false;
        // The advisory transaction lock makes readers wait through the normal
        // file-rename/metadata-commit window. If a process died after the
        // atomic rename, the single canonical file is one revision ahead and
        // is safe to register as the completed durable write.
        try {
          stored = await this.contexts.read(workspaceId, projectId, metadata.sha256);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("digest does not match")) throw error;
          stored = await this.contexts.read(workspaceId, projectId);
          if (stored.context.revision !== metadata.revision + 1) throw error;
          recovered = true;
        }
        return Object.freeze({
          stored: recovered ? stored : null,
          result: Object.freeze({
            metadata: recovered ? Object.freeze({
              revision: stored.context.revision,
              relativePath: stored.relativePath,
              sha256: stored.sha256,
              sizeBytes: stored.sizeBytes,
            }) : metadata,
            context: stored.context,
          }),
        });
      },
    ));
  }
}

export function agentEvidenceTemporaryRoot(projectsRoot: string): string {
  return join(resolve(projectsRoot), ".runtime-tmp", "agent-evidence");
}

export function visualEvidenceCheckpoints(
  checkpoints: readonly unknown[],
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(checkpoints.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const checkpoint = item as Record<string, unknown>;
    return checkpoint.status === "PASSED"
      && AGENT_EVIDENCE_ROLES.includes(checkpoint.role as typeof AGENT_EVIDENCE_ROLES[number])
      && typeof checkpoint.screenshot === "string"
      ? [Object.freeze(checkpoint)] : [];
  }).slice(0, AGENT_EVIDENCE_IMAGE_LIMIT));
}

type VisualEvidenceSelection = Readonly<{
  contentIndex: number;
  checkpoint: Readonly<Record<string, unknown>>;
}>;

/**
 * MCP transports at most six native images in one tool result. Select the
 * requested global checkpoint page before encoding image bytes so later
 * ACTION/PROGRESS/COMPLETION frames remain reachable instead of being silently
 * discarded by the transport formatter.
 */
export function selectVisualEvidenceCheckpoints(
  checkpoints: readonly Readonly<Record<string, unknown>>[],
  selector: Readonly<Record<string, unknown>>,
): readonly VisualEvidenceSelection[] {
  const indexed = checkpoints.map((checkpoint, index) => Object.freeze({
    contentIndex: index + 1,
    checkpoint,
  }));
  const checkpointId = typeof selector.checkpointId === "string" ? selector.checkpointId : null;
  if (checkpointId) {
    return Object.freeze(indexed.filter(item => item.checkpoint.checkpointId === checkpointId).slice(0, 1));
  }

  if (Array.isArray(selector.contentIndices)) {
    const requested = new Set(selector.contentIndices.filter(value =>
      Number.isInteger(value) && Number(value) >= 1 && Number(value) <= checkpoints.length));
    return Object.freeze(indexed.filter(item => requested.has(item.contentIndex)).slice(0, AGENT_EVIDENCE_PAGE_LIMIT));
  }

  const startContentIndex = Number.isInteger(selector.startContentIndex)
    ? Number(selector.startContentIndex) : null;
  const endContentIndex = Number.isInteger(selector.endContentIndex)
    ? Number(selector.endContentIndex) : null;
  if (startContentIndex !== null || endContentIndex !== null) {
    const start = Math.max(1, startContentIndex ?? 1);
    const end = Math.min(checkpoints.length, endContentIndex ?? start + AGENT_EVIDENCE_PAGE_LIMIT - 1);
    return Object.freeze(indexed.filter(item =>
      item.contentIndex >= start && item.contentIndex <= end).slice(0, AGENT_EVIDENCE_PAGE_LIMIT));
  }

  const offset = Number.isInteger(selector.imageOffset) ? Math.max(0, Number(selector.imageOffset)) : 0;
  const requestedLimit = Number.isInteger(selector.imageLimit) ? Number(selector.imageLimit) : AGENT_EVIDENCE_PAGE_LIMIT;
  const limit = Math.max(1, Math.min(AGENT_EVIDENCE_PAGE_LIMIT, requestedLimit));
  return Object.freeze(indexed.slice(offset, offset + limit));
}

type PhysicalRuntimeIdentity = Readonly<{
  workspaceId: string;
  projectId: string;
  generation: number;
  fencingToken: number;
  runtime: "CLAUDE_CODE" | "CODEX_CLI";
  state: "RUNNING" | "PAUSED" | "FAILED";
  containerId: string;
}>;

function contextFromSeed(current: ProjectContext, seed: ProjectContextSeed, initial = false): ProjectContext {
  const recordedDocumentRevision = Number(current.workflow.documentRevision ?? 0);
  const recordedGoalRevision = Number(current.workflow.goalRevision ?? 0);
  const documentChanged = initial || seed.documentRevision > recordedDocumentRevision;
  const goalsChanged = initial || seed.e2eGoalRevision > recordedGoalRevision;
  const requirements = goalsChanged && seed.requirements.length ? seed.requirements : current.requirements;
  const projectDocument = documentChanged ? seed.projectDocument : current.projectDocument;
  const e2e = goalsChanged ? Object.freeze({
    ...current.e2e,
    goalRevision: seed.e2eGoalRevision,
    goals: seed.e2eGoals,
  }) : current.e2e;
  const workflow = Object.freeze({
    ...current.workflow,
    ...seed.workflow,
    documentRevision: Math.max(recordedDocumentRevision, seed.documentRevision),
    goalRevision: Math.max(recordedGoalRevision, seed.e2eGoalRevision),
  });
  if (!initial
    && current.language === seed.language
    && requirements === current.requirements
    && projectDocument === current.projectDocument
    && e2e === current.e2e
    && sameJson(workflow, current.workflow)
    && sameJson(seed.pendingChange, current.pendingChange)) {
    return current;
  }
  return updateProjectContext(current, {
    language: seed.language,
    requirements,
    projectDocument,
    e2e,
    workflow,
    pendingChange: seed.pendingChange,
  });
}

/**
 * PostgreSQL jsonb does not preserve object-key insertion order. Runtime tools
 * parse typed payloads back into their schema order, so bytewise stringify
 * comparison can reject an otherwise identical approved snapshot. Sort object
 * keys recursively while preserving array order before comparing JSON values.
 */
export function projectRuntimeContextView(
  context: ProjectContext,
  role: ProjectRuntimeRole,
): Readonly<Record<string, unknown>> {
  const roles = Object.freeze(Object.fromEntries(PROJECT_RUNTIME_ROLES.map(agentRole => {
    const roleContext = context.roles[agentRole];
    return [agentRole, Object.freeze({
      ...roleContext,
      summary: roleContext.summary.slice(0, 2_000),
    })];
  })));
  const includeUiSpecification = ["UI_DESIGN", "DEVELOPMENT", "TEST"].includes(role);
  const seenTransitions = new Set<string>();
  const handoffs: Readonly<Record<string, unknown>>[] = [];
  for (let index = context.handoffs.length - 1; index >= 0; index -= 1) {
    const handoff = context.handoffs[index];
    const transition = `${String(handoff.fromRole ?? "")}>${String(handoff.toRole ?? "")}`;
    if (seenTransitions.has(transition)) continue;
    seenTransitions.add(transition);
    handoffs.unshift(Object.freeze({
      id: handoff.id,
      fromRole: handoff.fromRole,
      toRole: handoff.toRole,
      summary: typeof handoff.summary === "string" ? handoff.summary.slice(0, 8_000) : "",
      createdAt: handoff.createdAt,
      ...(includeUiSpecification && handoff.uiSpecification !== undefined
        ? { uiSpecification: handoff.uiSpecification }
        : {}),
    }));
  }
  const recentConversation = Object.freeze(context.recentConversation.slice(-12).map(message => Object.freeze({
    ...message,
    ...(typeof message.summary === "string" ? { summary: message.summary.slice(0, 2_000) } : {}),
  })));
  const testSummary = role === "TEST" || !context.testSummary
    ? context.testSummary
    : Object.freeze(Object.fromEntries(Object.entries(context.testSummary)
      .filter(([key]) => key !== "uiReview")));
  return Object.freeze({
    ...context,
    assetPlan: ["UI_DESIGN", "DEVELOPMENT", "TEST"].includes(role)
      ? context.assetPlan
      : Object.freeze([]),
    e2e: Object.freeze({
      ...context.e2e,
      plan: role === "TEST" ? context.e2e.plan : null,
    }),
    testSummary,
    roles,
    handoffs: Object.freeze(handoffs),
    recentConversation,
    recentTools: Object.freeze(context.recentTools.slice(-24)),
  });
}

export function sameJson(left: unknown, right: unknown): boolean {
  const canonicalize = (_key: string, value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Readonly<Record<string, unknown>>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  };
  return JSON.stringify(left, canonicalize) === JSON.stringify(right, canonicalize);
}

export function runtimeTurnHandoff(
  context: ProjectContext,
  turnId: string,
  fromRole: ProjectRuntimeRole,
  toRole: ProjectRuntimeRole,
): Readonly<Record<string, unknown>> | null {
  return context.handoffs.find(handoff => handoff.id === turnId
    && handoff.fromRole === fromRole
    && handoff.toRole === toRole
    && typeof handoff.summary === "string"
    && handoff.summary.trim().length > 0) ?? null;
}

export async function retryProjectRuntimeLifecycle<T>(
  operation: () => Promise<T>,
  options: Readonly<{
    retryLimit?: number;
    wait?: () => Promise<void>;
  }> = {},
): Promise<T> {
  const retryLimit = options.retryLimit ?? LIFECYCLE_RETRY_LIMIT;
  const wait = options.wait ?? (() => new Promise<void>(resolve => {
    setTimeout(resolve, LIFECYCLE_RETRY_INTERVAL_MS);
  }));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const lifecycleTransition = error instanceof Error
        && error.message === "Project Runtime is completing a lifecycle transition";
      if (!lifecycleTransition || attempt >= retryLimit) throw error;
      await wait();
    }
  }
}

function physicalIdentity(value: Readonly<Record<string, unknown>>): PhysicalRuntimeIdentity | null {
  if (!/^[0-9a-f-]{36}$/i.test(String(value.workspaceId ?? ""))
    || !/^[0-9a-f-]{36}$/i.test(String(value.projectId ?? ""))
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1
    || !Number.isSafeInteger(value.fencingToken) || Number(value.fencingToken) < 1
    || !["CLAUDE_CODE", "CODEX_CLI"].includes(String(value.runtime))
    || !["RUNNING", "PAUSED", "FAILED"].includes(String(value.state))
    || typeof value.containerId !== "string" || value.containerId.length < 12) return null;
  return Object.freeze({
    workspaceId: String(value.workspaceId), projectId: String(value.projectId),
    generation: Number(value.generation), fencingToken: Number(value.fencingToken),
    runtime: value.runtime as PhysicalRuntimeIdentity["runtime"],
    state: value.state as PhysicalRuntimeIdentity["state"], containerId: value.containerId,
  });
}

function controlFromPhysical(value: PhysicalRuntimeIdentity): ProjectRuntimeControlRequest {
  return Object.freeze({
    schemaVersion: PROJECT_RUNTIME_SCHEMA,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    generation: value.generation,
    fencingToken: value.fencingToken,
    runtime: value.runtime,
  });
}

const DEFAULT_TOOL_ARGUMENT_BYTES = 64_000;
// A complete authored campaign can legitimately need hundreds of deterministic
// events (per-exchange checkpoints plus the actions that resolve them). Keep
// the structural 512-event limit as the real bound, while allowing the JSON
// envelope to carry those validated events and their requirement coverage.
export const MAX_TEST_PLAN_TOOL_ARGUMENT_BYTES = 2_000_000;
export const MAX_SOURCE_CHECKPOINT_TOOL_ARGUMENT_BYTES = 512_000;

export function projectRuntimeToolArgumentLimit(name: string): number {
  if (name === "test_plan.replace") return MAX_TEST_PLAN_TOOL_ARGUMENT_BYTES;
  if (name === "source.checkpoint") return MAX_SOURCE_CHECKPOINT_TOOL_ARGUMENT_BYTES;
  return DEFAULT_TOOL_ARGUMENT_BYTES;
}

function boundedObject(
  value: unknown,
  maximumBytes = DEFAULT_TOOL_ARGUMENT_BYTES,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool argument must be an object");
  const serialized = JSON.stringify(value);
  // `boundedObject` is also used directly as an Array.map callback, whose
  // second argument is the item index. Treat only an explicitly wider limit as
  // an override so those call sites retain the default envelope.
  const byteLimit = maximumBytes >= DEFAULT_TOOL_ARGUMENT_BYTES
    ? maximumBytes : DEFAULT_TOOL_ARGUMENT_BYTES;
  if (serialized.length > byteLimit || containsSensitiveToolArgument(value)) {
    throw new Error("Tool argument summary is unsafe or too large");
  }
  return Object.freeze(JSON.parse(serialized));
}

const SENSITIVE_AUDIT_KEY = /(?:api.?key|authorization|credential|mcp.?token|password|provider.?token|secret)/i;

/**
 * Reject credential-bearing argument fields without scanning player-authored
 * prose. Narrative and test descriptions can legitimately contain words such
 * as "secret"; treating any occurrence in a serialized value as a credential
 * made otherwise valid test plans impossible to persist.
 */
export function containsSensitiveToolArgument(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveToolArgument);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) =>
    SENSITIVE_AUDIT_KEY.test(key) || containsSensitiveToolArgument(nested));
}
const MAX_AUDIT_BYTES = 8_000;

export function summarizeToolAuditValue(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({ type: Array.isArray(value) ? "array" : typeof value });
  }
  const sanitized = sanitizeAuditValue(value, 0);
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_AUDIT_BYTES) {
    return Object.freeze(JSON.parse(serialized) as Readonly<Record<string, unknown>>);
  }
  const original = JSON.stringify(value);
  return Object.freeze({
    type: "object",
    keys: Object.freeze(Object.keys(value as Readonly<Record<string, unknown>>).slice(0, 100)),
    bytes: Buffer.byteLength(original),
    truncated: true,
  });
}

export function summarizeRuntimeToolCalls(
  calls: readonly Readonly<Record<string, unknown>>[],
): readonly import("@/lib/product/project-runtime").ProjectRuntimeToolSummary[] {
  if (!Array.isArray(calls) || calls.length > 1_000) throw new Error("Project Runtime returned an invalid tool call list");
  return Object.freeze(calls.map(call => {
    const name = normalizeRuntimeToolName(call.name);
    const startedAt = String(call.startedAt ?? "");
    const completedAt = String(call.completedAt ?? "");
    if (!Number.isFinite(Date.parse(startedAt))
      || !Number.isFinite(Date.parse(completedAt))) {
      throw new Error("Project Runtime returned an invalid tool call summary");
    }
    return Object.freeze({
      name,
      arguments: summarizeToolAuditValue(call.arguments),
      result: summarizeToolAuditValue(call.result),
      startedAt,
      completedAt,
    });
  }));
}

function normalizeRuntimeToolName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Project Runtime returned an invalid tool call summary");
  }
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9_.]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+/g, "_")
    .replace(/[._]+$/g, "")
    .slice(0, 100);
  const name = normalized.length >= 3 ? normalized : `runtime.${normalized || "tool"}`;
  if (!/^[a-z][a-z0-9_.]{2,100}$/.test(name)) {
    throw new Error("Project Runtime returned an invalid tool call summary");
  }
  return name;
}

function sanitizeAuditValue(value: unknown, depth: number, key = ""): unknown {
  if (SENSITIVE_AUDIT_KEY.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length <= 500 ? value : `${value.slice(0, 500)}…`;
  if (depth >= 5) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map(item => sanitizeAuditValue(item, depth + 1));
    return value.length > items.length ? [...items, { omittedItems: value.length - items.length }] : items;
  }
  if (!value || typeof value !== "object") return String(value);
  return Object.fromEntries(Object.entries(value as Readonly<Record<string, unknown>>)
    .slice(0, 100)
    .map(([entryKey, entryValue]) => [entryKey, sanitizeAuditValue(entryValue, depth + 1, entryKey)]));
}

function arrayOfObjects(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error("Tool argument must be a bounded array");
  return Object.freeze(value.map(boundedObject));
}

function normalizeRuntimeE2eGoals(value: unknown): readonly E2eGoal[] {
  const goals = arrayOfObjects(value);
  const ids = new Set<string>();
  return Object.freeze(goals.map(goal => {
    const id = typeof goal.id === "string" ? goal.id : "";
    const description = typeof goal.description === "string" ? goal.description.trim() : "";
    const source = String(goal.source ?? "");
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(id) || ids.has(id)
      || !description || description.length > 2_000
      || !["CORE_LOOP", "ACCEPTANCE"].includes(source)) {
      throw new Error("UI Design Agent returned an invalid or duplicate E2E goal");
    }
    ids.add(id);
    return Object.freeze({ id, description, source: source as E2eGoal["source"] });
  }));
}

function arrayOfStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 1_000 || value.some(item => typeof item !== "string" || item.length > 500)) {
    throw new Error("Tool argument must be a bounded string array");
  }
  return Object.freeze(value);
}

function normalizeAssetPlan(value: readonly Readonly<Record<string, unknown>>[]): readonly Readonly<Record<string, unknown>>[] {
  const keys = new Set<string>();
  return Object.freeze(value.map(asset => {
    const key = String(asset.key ?? "");
    const assetType = String(asset.assetType ?? "").toLowerCase();
    const origin = String(asset.origin ?? "GENERATED").toUpperCase();
    const resource = String(asset.expectedResourcePath ?? "");
    const music = assetType === "music";
    const description = String(asset.description ?? "").trim();
    const generationPrompt = String(asset.generationPrompt ?? "").trim();
    const targetId = String(asset.targetId ?? "");
    const checkpointRole = String(asset.checkpointRole ?? "").toUpperCase();
    const visualTypes = ["sprite", "animation", "background", "ui", "icon", "tileset"];
    const generatedResource = `res://assets/generated/${key}.png`;
    const musicResourcePrefix = `res://assets/generated/${key}.`;
    const musicResource = musicResourcePrefix.length < resource.length
      && ["mp3", "ogg", "wav"].includes(resource.slice(musicResourcePrefix.length).toLowerCase());
    const musicGenerationFields = ["generationPrompt", "prompt", "frameCount", "dimensions", "sourcePath"]
      .some(field => asset[field] !== undefined && asset[field] !== null);
    if (!/^[a-z0-9][a-z0-9/_.-]{0,199}$/.test(key) || keys.has(key)
      || !["GENERATED", "USER_UPLOAD"].includes(origin)
      || (music
        ? origin !== "USER_UPLOAD"
          || description.length < 1 || description.length > 2_000
          || !musicResource
          || musicGenerationFields
        : !visualTypes.includes(assetType)
          || description.length < 1 || description.length > 2_000
          || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(targetId)
          || !["START", "READY", "ACTION", "PROGRESS", "COMPLETION"].includes(checkpointRole)
          || resource !== generatedResource
          || (origin === "GENERATED" && (generationPrompt.length < 20 || generationPrompt.length > 4_000))
          || (origin === "USER_UPLOAD" && generationPrompt.length > 0)
          || (asset.dimensions !== undefined && !/^\d{1,5}x\d{1,5}$/.test(String(asset.dimensions)))
          || (asset.frameCount !== undefined
            && (!Number.isSafeInteger(Number(asset.frameCount)) || Number(asset.frameCount) < 1 || Number(asset.frameCount) > 4_096)))) {
      throw new Error("Agent returned an invalid or duplicate asset plan item");
    }
    keys.add(key);
    const normalized = {
      ...asset,
      key,
      ...(music ? { assetType: "music", description } : {}),
      ...(!music ? { assetType, description, targetId, checkpointRole,
        ...(origin === "GENERATED" ? { generationPrompt } : {}) } : {}),
      origin,
      expectedResourcePath: resource,
      ...(!music ? { sourcePath: assetSourcePath(asset) ?? resource.slice("res://".length) } : {}),
    };
    return Object.freeze(normalized);
  }));
}

const UI_SPECIFICATION_SCHEMA = "deviludo.ui-specification";
const UI_SPECIFICATION_ROLES = Object.freeze(["START", "READY", "ACTION", "PROGRESS", "COMPLETION"]);
const PRINCIPAL_UI_SPECIFICATION_ROLES = Object.freeze(["START", "READY", "PROGRESS", "COMPLETION"]);
const UI_SPECIFICATION_ASSET_FIELDS = Object.freeze([
  "key", "assetType", "origin", "description", "generationPrompt", "dimensions",
  "frameCount", "expectedResourcePath", "targetId", "checkpointRole",
]);

export function normalizeUiSpecification(value: unknown): Readonly<Record<string, unknown>> {
  const specification = boundedObject(value);
  const canvas = boundedObject(specification.referenceCanvas);
  if (specification.schema !== UI_SPECIFICATION_SCHEMA || canvas.width !== 1280 || canvas.height !== 720
    || typeof specification.visualThesis !== "string" || !specification.visualThesis.trim()
    || specification.visualThesis.length > 4_000) {
    throw new Error("UI Design Agent returned an invalid UI specification header");
  }
  assertOnlyKeys(specification, ["schema", "visualThesis", "referenceCanvas", "checkpoints", "assets"], "UI specification");
  assertOnlyKeys(canvas, ["width", "height"], "UI reference canvas");
  if (!Array.isArray(specification.assets) || specification.assets.length > 500) {
    throw new Error("UI Design Agent returned an invalid UI asset contract");
  }
  const assets = normalizeAssetPlan(arrayOfObjects(specification.assets));
  if (assets.some(asset => asset.assetType === "music")) {
    throw new Error("UI Design Agent cannot include upload-only music in its visual asset contract");
  }
  if (!Array.isArray(specification.checkpoints)
    || specification.checkpoints.length < PRINCIPAL_UI_SPECIFICATION_ROLES.length
    || specification.checkpoints.length > 32) {
    throw new Error("UI Design Agent must specify every principal screenshot checkpoint");
  }
  const assetByKey = new Map(assets.map(asset => [String(asset.key), asset]));
  const assetAnchors = new Set<string>();
  const principalCounts = new Map(PRINCIPAL_UI_SPECIFICATION_ROLES.map(role => [role, 0]));
  const checkpoints = specification.checkpoints.map(candidate => {
    const checkpoint = boundedObject(candidate);
    assertOnlyKeys(checkpoint, [
      "role", "purpose", "silhouette", "focalPoint", "primaryActionId", "regions",
      "visualAnchors", "negativeSpaceIntent", "contentStressCase", "thumbnailRead",
      "acceptanceCriteria", "forbiddenFallbacks",
    ], "UI checkpoint");
    const role = String(checkpoint.role ?? "");
    if (!UI_SPECIFICATION_ROLES.includes(role)) throw new Error("UI checkpoint role is invalid");
    if (principalCounts.has(role)) principalCounts.set(role, Number(principalCounts.get(role)) + 1);
    for (const field of ["purpose", "silhouette", "focalPoint", "negativeSpaceIntent", "contentStressCase", "thumbnailRead"]) {
      requireUiSpecificationText(checkpoint[field], `UI checkpoint ${field}`, field === "contentStressCase" ? 4_000 : 2_000);
    }
    if (!isStableUiId(checkpoint.primaryActionId)) throw new Error("UI checkpoint primary action ID is invalid");
    if (!Array.isArray(checkpoint.regions) || checkpoint.regions.length < 1 || checkpoint.regions.length > 32) {
      throw new Error("UI checkpoint requires bounded spatial regions");
    }
    const regionIds = new Set<string>();
    const regions = checkpoint.regions.map(candidateRegion => {
      const region = boundedObject(candidateRegion);
      assertOnlyKeys(region, ["id", "x", "y", "width", "height", "layer", "purpose", "content", "overflow"], "UI region");
      const id = String(region.id ?? "");
      const x = Number(region.x); const y = Number(region.y);
      const width = Number(region.width); const height = Number(region.height); const layer = Number(region.layer);
      if (!isStableUiId(id) || regionIds.has(id)
        || ![x, y, width, height, layer].every(Number.isSafeInteger)
        || x < 0 || y < 0 || width < 1 || height < 1 || layer < 0 || layer > 100
        || x + width > 1280 || y + height > 720) {
        throw new Error("UI checkpoint contains an invalid or out-of-canvas region");
      }
      regionIds.add(id);
      requireUiSpecificationText(region.purpose, "UI region purpose");
      requireUiSpecificationText(region.content, "UI region representative content", 4_000);
      requireUiSpecificationText(region.overflow, "UI region overflow rule");
      return Object.freeze({ ...region, id, x, y, width, height, layer });
    });
    if (!Array.isArray(checkpoint.visualAnchors)
      || checkpoint.visualAnchors.length < 1 || checkpoint.visualAnchors.length > 32) {
      throw new Error("Every UI checkpoint requires a visible identity anchor");
    }
    const visualAnchors = checkpoint.visualAnchors.map(candidateAnchor => {
      const anchor = boundedObject(candidateAnchor);
      assertOnlyKeys(anchor, ["kind", "key", "targetId", "description"], "UI visual anchor");
      const kind = String(anchor.kind ?? "");
      const targetId = String(anchor.targetId ?? "");
      const key = typeof anchor.key === "string" ? anchor.key : null;
      if (!["ASSET", "CODE_NATIVE"].includes(kind) || !isStableUiId(targetId)) {
        throw new Error("UI checkpoint visual anchor is invalid");
      }
      requireUiSpecificationText(anchor.description, "UI visual anchor description");
      if (kind === "ASSET") {
        const asset = key ? assetByKey.get(key) : null;
        if (!asset || asset.targetId !== targetId || asset.checkpointRole !== role) {
          throw new Error("UI checkpoint asset anchor does not match its asset contract");
        }
        assetAnchors.add(key!);
      } else if (key !== null) {
        throw new Error("Code-native UI anchors cannot claim a generated asset key");
      }
      return Object.freeze({ ...anchor, kind, targetId, ...(key ? { key } : {}) });
    });
    const acceptanceCriteria = uiSpecificationTextList(checkpoint.acceptanceCriteria, "UI checkpoint acceptance criteria");
    const forbiddenFallbacks = uiSpecificationTextList(checkpoint.forbiddenFallbacks, "UI checkpoint forbidden fallbacks");
    return Object.freeze({ ...checkpoint, role, regions: Object.freeze(regions),
      visualAnchors: Object.freeze(visualAnchors), acceptanceCriteria, forbiddenFallbacks });
  });
  if (PRINCIPAL_UI_SPECIFICATION_ROLES.some(role => principalCounts.get(role) !== 1)) {
    throw new Error("UI specification must contain exactly one START, READY, PROGRESS, and COMPLETION checkpoint");
  }
  const unanchoredAssets = assets.filter(asset => !assetAnchors.has(String(asset.key))).map(asset => String(asset.key));
  if (unanchoredAssets.length > 0) {
    throw new Error(`UI asset contract is not visibly anchored at its checkpoint: ${unanchoredAssets.join(", ")}`);
  }
  return Object.freeze({
    schema: UI_SPECIFICATION_SCHEMA,
    visualThesis: specification.visualThesis.trim(),
    referenceCanvas: Object.freeze({ width: 1280, height: 720 }),
    checkpoints: Object.freeze(checkpoints),
    assets,
  });
}

export function latestUiSpecification(
  context: Pick<ProjectContext, "handoffs">,
): Readonly<Record<string, unknown>> | null {
  for (let index = context.handoffs.length - 1; index >= 0; index -= 1) {
    const handoff = context.handoffs[index];
    if (handoff?.fromRole !== "UI_DESIGN" || handoff.toRole !== "DEVELOPMENT"
      || handoff.uiSpecification === undefined) continue;
    return normalizeUiSpecification(handoff.uiSpecification);
  }
  return null;
}

const NARRATIVE_ANCHOR_FIELDS = Object.freeze([
  "entry", "objective", "exchanges", "reveal", "consequence", "transition",
] as const);
const NARRATIVE_EXCHANGE_ANCHOR_FIELDS = Object.freeze(["prompt", "choices"] as const);
const NARRATIVE_CHOICE_ANCHOR_FIELDS = Object.freeze(["action", "response"] as const);

/**
 * A numbered scene-art contract means UI Design expects authored narrative
 * scenes rather than interchangeable level decoration. Development must prove
 * that every one of those scenes has its own implemented beats before Core
 * publishes a source revision.
 */
export function requiredNarrativeSceneAssetKeys(
  context: Pick<ProjectContext, "assetPlan">,
): readonly string[] {
  const candidates = context.assetPlan.flatMap(asset => {
    const key = String(asset.key ?? "");
    const match = /^scene-(\d{2,3})(?:-|$)/.exec(key);
    return match ? [{ key, order: Number(match[1]) }] : [];
  });
  if (candidates.length < 2) return Object.freeze([]);
  candidates.sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
  const seenOrders = new Set<number>();
  for (const candidate of candidates) {
    if (candidate.order < 1 || seenOrders.has(candidate.order)) {
      throw new Error("Numbered narrative scene assets must use unique positive scene numbers");
    }
    seenOrders.add(candidate.order);
  }
  for (let order = 1; order <= candidates[candidates.length - 1]!.order; order += 1) {
    if (!seenOrders.has(order)) throw new Error("Numbered narrative scene assets must form one contiguous sequence");
  }
  return Object.freeze(candidates.map(candidate => candidate.key));
}

export function hasCurrentTurnSourceCheckpoint(
  context: Pick<ProjectContext, "source" | "workflow" | "assetPlan">,
  turnId: string,
): boolean {
  return Boolean(context.source)
    && context.workflow.sourceCheckpointedByTurnId === turnId
    && Number(context.workflow.sourceCheckpointRevision ?? 0) === context.source!.revision
    && context.workflow.sourceCheckpointAssetPlanDigest === stableDigest(context.assetPlan);
}

export async function validateNarrativeDeliveryProof(
  sourceRoot: string,
  requiredSceneKeys: readonly string[],
  value: unknown,
): Promise<void> {
  const proof = boundedObject(value, MAX_SOURCE_CHECKPOINT_TOOL_ARGUMENT_BYTES);
  assertOnlyKeys(proof, ["opening", "scenes"], "Narrative delivery proof");
  const opening = boundedObject(proof.opening);
  assertOnlyKeys(opening, ["sourcePath", "anchors"], "Narrative opening proof");
  const scenes = arrayOfObjects(proof.scenes);
  if (scenes.length !== requiredSceneKeys.length) {
    throw new Error(`Narrative delivery proof must cover all ${requiredSceneKeys.length} authored scenes exactly`);
  }

  const root = resolve(sourceRoot);
  const sourceCache = new Map<string, string>();
  const sourceText = async (pathValue: unknown): Promise<string> => {
    if (typeof pathValue !== "string" || !pathValue.trim() || pathValue.length > 1_000) {
      throw new Error("Narrative delivery proof contains an invalid source path");
    }
    const projectPath = normalizeProjectPath(pathValue);
    const cached = sourceCache.get(projectPath);
    if (cached !== undefined) return cached;
    const target = resolve(root, projectPath);
    if (!target.startsWith(`${root}${sep}`)) throw new Error("Narrative proof source path escapes the project");
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 4 * 1024 * 1024) {
      throw new Error(`Narrative proof source is not a bounded text file: ${projectPath}`);
    }
    const bytes = await readFile(target);
    if (bytes.includes(0)) throw new Error(`Narrative proof source is not text: ${projectPath}`);
    const normalized = normalizeNarrativeAnchor(bytes.toString("utf8"));
    sourceCache.set(projectPath, normalized);
    return normalized;
  };

  const globallyUniqueAnchors = new Set<string>();
  const structurallyUniqueChoiceAnchors = new Set<string>();
  const choicePhraseOccurrences = new Map<string, number>();
  const verifyAnchor = async (candidate: unknown, sourcePath: unknown, label: string): Promise<void> => {
    if (typeof candidate !== "string" || candidate.length > 1_000) {
      throw new Error(`${label} is invalid`);
    }
    const anchor = normalizeNarrativeAnchor(candidate);
    if (Array.from(anchor).length < 12 || /(?:%[a-z]|\$\{|\{\{|\}\})/i.test(anchor)
      || globallyUniqueAnchors.has(anchor)) {
      throw new Error(`${label} must be unique authored text without formatting placeholders`);
    }
    const source = await sourceText(sourcePath);
    if (!source.includes(anchor)) throw new Error(`${label} is not present in its declared source file`);
    globallyUniqueAnchors.add(anchor);
  };

  if (!Array.isArray(opening.anchors) || opening.anchors.length < 4 || opening.anchors.length > 24) {
    throw new Error("Narrative opening proof requires at least four authored source anchors");
  }
  for (let index = 0; index < opening.anchors.length; index += 1) {
    await verifyAnchor(opening.anchors[index], opening.sourcePath, `Narrative opening anchor ${index + 1}`);
  }

  const expectedKeys = new Set(requiredSceneKeys);
  const seenKeys = new Set<string>();
  for (const candidate of scenes) {
    assertOnlyKeys(candidate, ["id", "title", "sourcePath", "anchors"], "Narrative scene proof");
    const id = String(candidate.id ?? "");
    const title = typeof candidate.title === "string" ? normalizeNarrativeAnchor(candidate.title) : "";
    if (!expectedKeys.has(id) || seenKeys.has(id) || !title || title.length > 200) {
      throw new Error("Narrative delivery proof has a missing, duplicate, or unexpected scene");
    }
    seenKeys.add(id);
    const anchors = boundedObject(candidate.anchors);
    assertOnlyKeys(anchors, NARRATIVE_ANCHOR_FIELDS, `Narrative scene ${id} anchors`);
    for (const field of NARRATIVE_ANCHOR_FIELDS) {
      if (!(field in anchors)) throw new Error(`Narrative scene ${id} is missing its ${field} anchor`);
      if (field !== "exchanges") {
        await verifyAnchor(anchors[field], candidate.sourcePath, `Narrative scene ${id} ${field} anchor`);
      }
    }
    const exchanges = arrayOfObjects(anchors.exchanges);
    const sceneChoiceAnchors = new Map<string, string[]>();
    if (exchanges.length < 3 || exchanges.length > 12) {
      throw new Error(`Narrative scene ${id} requires at least three authored exchanges`);
    }
    for (let exchangeIndex = 0; exchangeIndex < exchanges.length; exchangeIndex += 1) {
      const exchange = exchanges[exchangeIndex]!;
      assertOnlyKeys(exchange, NARRATIVE_EXCHANGE_ANCHOR_FIELDS,
        `Narrative scene ${id} exchange ${exchangeIndex + 1}`);
      if (!("prompt" in exchange) || !("choices" in exchange)) {
        throw new Error(`Narrative scene ${id} exchange ${exchangeIndex + 1} requires a prompt and choices`);
      }
      await verifyAnchor(exchange.prompt, candidate.sourcePath,
        `Narrative scene ${id} exchange ${exchangeIndex + 1} prompt anchor`);
      const choices = arrayOfObjects(exchange.choices);
      if (choices.length < 2 || choices.length > 6) {
        throw new Error(`Narrative scene ${id} exchange ${exchangeIndex + 1} requires two to six authored choices`);
      }
      for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
        const choice = choices[choiceIndex]!;
        assertOnlyKeys(choice, NARRATIVE_CHOICE_ANCHOR_FIELDS,
          `Narrative scene ${id} exchange ${exchangeIndex + 1} choice ${choiceIndex + 1}`);
        for (const field of NARRATIVE_CHOICE_ANCHOR_FIELDS) {
          if (!(field in choice)) {
            throw new Error(`Narrative scene ${id} exchange ${exchangeIndex + 1} choice ${choiceIndex + 1} is missing its ${field} anchor`);
          }
          await verifyAnchor(choice[field], candidate.sourcePath,
            `Narrative scene ${id} exchange ${exchangeIndex + 1} choice ${choiceIndex + 1} ${field} anchor`);
          const structuralAnchor = normalizeNarrativeChoiceStructure(String(choice[field]));
          if (structurallyUniqueChoiceAnchors.has(structuralAnchor)) {
            throw new Error(
              `Narrative scene ${id} exchange ${exchangeIndex + 1} choice ${choiceIndex + 1} ${field} anchor `
              + "must be scene-specific authored text, not repeated numbered boilerplate",
            );
          }
          const priorSceneAnchors = sceneChoiceAnchors.get(field) ?? [];
          if (priorSceneAnchors.some(prior => narrativeChoiceNearDuplicate(prior, structuralAnchor))) {
            throw new Error(
              `Narrative scene ${id} exchange ${exchangeIndex + 1} choice ${choiceIndex + 1} ${field} anchor `
              + "near-duplicates another choice instead of authoring a distinct decision or consequence",
            );
          }
          priorSceneAnchors.push(structuralAnchor);
          sceneChoiceAnchors.set(field, priorSceneAnchors);
          structurallyUniqueChoiceAnchors.add(structuralAnchor);
          for (const phrase of narrativeChoicePhraseKeys(String(choice[field]))) {
            const occurrences = (choicePhraseOccurrences.get(phrase) ?? 0) + 1;
            if (occurrences > 5) {
              throw new Error(
                `Narrative scene ${id} exchange ${exchangeIndex + 1} choice ${choiceIndex + 1} ${field} anchor `
                + "repeats a boilerplate phrase across too many choices",
              );
            }
            choicePhraseOccurrences.set(phrase, occurrences);
          }
        }
      }
    }
  }
  if (requiredSceneKeys.some(key => !seenKeys.has(key))) {
    throw new Error("Narrative delivery proof does not cover every required scene");
  }
}

async function narrativeProofSourceDigest(sourceRoot: string, value: unknown): Promise<string> {
  const proof = boundedObject(value, MAX_SOURCE_CHECKPOINT_TOOL_ARGUMENT_BYTES);
  const opening = boundedObject(proof.opening);
  const paths = new Set<string>();
  if (typeof opening.sourcePath === "string" && opening.sourcePath.trim()) {
    paths.add(normalizeProjectPath(opening.sourcePath));
  }
  for (const scene of arrayOfObjects(proof.scenes)) {
    if (typeof scene.sourcePath === "string" && scene.sourcePath.trim()) {
      paths.add(normalizeProjectPath(scene.sourcePath));
    }
  }
  const root = resolve(sourceRoot);
  const digest = createHash("sha256");
  for (const projectPath of [...paths].sort()) {
    const target = resolve(root, projectPath);
    if (!target.startsWith(`${root}${sep}`)) throw new Error("Narrative proof source path escapes the project");
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 4 * 1024 * 1024) {
      throw new Error(`Narrative proof source is not a bounded text file: ${projectPath}`);
    }
    const bytes = await readFile(target);
    if (bytes.includes(0)) throw new Error(`Narrative proof source is not text: ${projectPath}`);
    digest.update(projectPath).update("\0").update(bytes).update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

function isNarrativeSourceQualityRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("not repeated numbered boilerplate")
    || error.message.includes("repeats a boilerplate phrase")
    || error.message.includes("near-duplicates another choice");
}

function normalizeNarrativeAnchor(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizeNarrativeChoiceStructure(value: string): string {
  return normalizeNarrativeAnchor(value)
    .toLocaleLowerCase("und")
    .replace(/\p{Number}+/gu, "#")
    .replace(/\s*#(?:\s*[场章节幕轮步项次])?/gu, "#")
    .replace(/[\p{Punctuation}\p{Symbol}\s]+/gu, "")
    .trim();
}

function narrativeChoicePhraseKeys(value: string): ReadonlySet<string> {
  const prose = normalizeNarrativeChoiceStructure(value).replace(/#/g, "");
  const keys = new Set<string>();
  const characters = Array.from(prose);
  // Eight visible characters is long enough to avoid ordinary connective
  // prose while still catching a repeated wrapper whose unique suffix merely
  // quotes the current prompt (for example, "先正面回答……并单独归档").
  const phraseLength = 8;
  for (let index = 0; index + phraseLength <= characters.length; index += 1) {
    keys.add(characters.slice(index, index + phraseLength).join(""));
  }
  return keys;
}

function narrativeChoiceNearDuplicate(left: string, right: string): boolean {
  const leftPairs = narrativeCharacterPairs(left);
  const rightPairs = narrativeCharacterPairs(right);
  const smallerSize = Math.min(leftPairs.size, rightPairs.size);
  if (smallerSize < 8) return false;
  let shared = 0;
  for (const pair of leftPairs) {
    if (rightPairs.has(pair)) shared += 1;
  }
  // Adding the current prompt, a timestamp, or connective filler around an
  // existing answer preserves nearly all of the shorter answer's character
  // pairs. That is proof decoration, not a new player decision.
  return shared / smallerSize >= 0.78;
}

function narrativeCharacterPairs(value: string): ReadonlySet<string> {
  const characters = Array.from(value.replace(/#/g, ""));
  const pairs = new Set<string>();
  for (let index = 0; index + 1 < characters.length; index += 1) {
    pairs.add(`${characters[index]}${characters[index + 1]}`);
  }
  return pairs;
}

export function normalizeUiTestReview(
  value: unknown,
  specification: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const review = boundedObject(value);
  assertOnlyKeys(review, ["checkpoints"], "UI test review");
  if (!Array.isArray(review.checkpoints) || review.checkpoints.length !== PRINCIPAL_UI_SPECIFICATION_ROLES.length) {
    throw new Error("Test Agent cannot PASS without reviewing every principal UI screenshot checkpoint");
  }
  const specificationByRole = new Map(arrayOfObjects(specification.checkpoints)
    .filter(checkpoint => PRINCIPAL_UI_SPECIFICATION_ROLES.includes(String(checkpoint.role ?? "")))
    .map(checkpoint => [String(checkpoint.role), checkpoint]));
  const seenRoles = new Set<string>();
  const checkpoints = review.checkpoints.map(candidate => {
    const checkpoint = boundedObject(candidate);
    assertOnlyKeys(checkpoint, [
      "role", "checkpointId", "screenshotDescription", "silhouetteMatches", "focalPointVisible",
      "primaryActionVisible", "negativeSpaceCompliant", "thumbnailReadMatches", "stressCaseHandled",
      "visualAnchorsVisible", "mostlyBlankUndecoratedPanelPresent", "acceptanceCriteria",
      "forbiddenFallbacks",
    ], "UI checkpoint review");
    const role = String(checkpoint.role ?? "");
    const expected = specificationByRole.get(role);
    if (!expected || seenRoles.has(role)) {
      throw new Error("Test Agent UI review has a missing, duplicate, or invalid principal checkpoint role");
    }
    seenRoles.add(role);
    requireUiSpecificationText(checkpoint.checkpointId, "UI review screenshot checkpoint ID", 500);
    requireUiSpecificationText(checkpoint.screenshotDescription, "UI review screenshot description", 4_000);
    const passingBooleanFields = [
      "silhouetteMatches", "focalPointVisible", "primaryActionVisible", "negativeSpaceCompliant",
      "thumbnailReadMatches", "stressCaseHandled", "visualAnchorsVisible",
    ];
    const failedFields = passingBooleanFields.filter(field => checkpoint[field] !== true);
    if (failedFields.length > 0 || checkpoint.mostlyBlankUndecoratedPanelPresent !== false) {
      throw new Error(`Test Agent cannot PASS UI checkpoint ${role}: ${[
        ...failedFields,
        ...(checkpoint.mostlyBlankUndecoratedPanelPresent !== false
          ? ["mostlyBlankUndecoratedPanelPresent"] : []),
      ].join(", ")}`);
    }
    const expectedCriteria = uiSpecificationTextList(expected.acceptanceCriteria,
      "UI checkpoint acceptance criteria");
    const acceptanceCriteria = normalizeUiCriterionReview(
      checkpoint.acceptanceCriteria,
      expectedCriteria,
      "criterion",
      result => result.status === "PASS",
      `UI checkpoint ${role} acceptance criterion`,
    );
    const expectedFallbacks = uiSpecificationTextList(expected.forbiddenFallbacks,
      "UI checkpoint forbidden fallbacks");
    const forbiddenFallbacks = normalizeUiCriterionReview(
      checkpoint.forbiddenFallbacks,
      expectedFallbacks,
      "fallback",
      result => result.present === false,
      `UI checkpoint ${role} forbidden fallback`,
    );
    return Object.freeze({ ...checkpoint, role, acceptanceCriteria, forbiddenFallbacks });
  });
  if (PRINCIPAL_UI_SPECIFICATION_ROLES.some(role => !seenRoles.has(role))) {
    throw new Error("Test Agent cannot PASS without reviewing every principal UI screenshot checkpoint");
  }
  return Object.freeze({ checkpoints: Object.freeze(checkpoints) });
}

function normalizeUiCriterionReview(
  value: unknown,
  expected: readonly string[],
  textField: "criterion" | "fallback",
  passes: (result: Readonly<Record<string, unknown>>) => boolean,
  label: string,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error(`${label} review must cover the approved contract exactly`);
  }
  return Object.freeze(value.map((candidate, index) => {
    const result = boundedObject(candidate);
    const keys = textField === "criterion"
      ? ["criterion", "status", "evidence"]
      : ["fallback", "present", "evidence"];
    assertOnlyKeys(result, keys, label);
    if (result[textField] !== expected[index]) {
      throw new Error(`${label} review must preserve the approved contract text and order`);
    }
    requireUiSpecificationText(result.evidence, `${label} evidence`, 4_000);
    if (!passes(result)) throw new Error(`Test Agent cannot PASS a failed ${label}`);
    return Object.freeze({ ...result, [textField]: expected[index] });
  }));
}

export function requiredUiAssetProblems(
  specification: Readonly<Record<string, unknown>>,
  candidatePlan: readonly Readonly<Record<string, unknown>>[],
): readonly string[] {
  const expected = arrayOfObjects(specification.assets);
  const actualByKey = new Map(candidatePlan.map(asset => [String(asset.key ?? ""), asset]));
  return Object.freeze(expected.flatMap(asset => {
    const actual = actualByKey.get(String(asset.key));
    if (!actual) return [`missing:${String(asset.key)}`];
    const mismatch = UI_SPECIFICATION_ASSET_FIELDS.some(field => JSON.stringify(actual[field] ?? null) !== JSON.stringify(asset[field] ?? null));
    return mismatch ? [`mismatch:${String(asset.key)}`] : [];
  }));
}

function assertRequiredUiAssets(
  specification: Readonly<Record<string, unknown>>,
  candidatePlan: readonly Readonly<Record<string, unknown>>[],
): void {
  const problems = requiredUiAssetProblems(specification, candidatePlan);
  if (problems.length > 0) {
    throw new Error(`Development Agent asset plan does not implement the approved UI asset contract: ${problems.join(", ")}`);
  }
}

function requireUiSpecificationText(value: unknown, label: string, maximum = 2_000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label} is invalid`);
}

function uiSpecificationTextList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) throw new Error(`${label} is invalid`);
  const result = value.map(item => {
    requireUiSpecificationText(item, label);
    return item.trim();
  });
  return Object.freeze(result);
}

function isStableUiId(value: unknown): boolean {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,119}$/.test(value);
}

function assertOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error(`${label} contains unsupported fields`);
}

function isUserUpload(asset: Readonly<Record<string, unknown>>): boolean {
  return String(asset.origin ?? "").toUpperCase() === "USER_UPLOAD";
}

export function latestEvidenceReport(
  runs: readonly Readonly<Record<string, unknown>>[],
): Readonly<{
  runId: string;
  targetPlatform: string;
  object: Readonly<{
    bucket: string;
    key: string;
    sha256: string;
    sizeBytes: number;
  }>;
}> | null {
  for (const run of runs) {
    const summary = run.evidenceSummary;
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) continue;
    const outputs = (summary as Record<string, unknown>).outputObjects;
    if (!Array.isArray(outputs)) continue;
    const report = outputs.find(candidate => candidate && typeof candidate === "object"
      && !Array.isArray(candidate) && (candidate as Record<string, unknown>).kind === "E2E_REPORT") as Record<string, unknown> | undefined;
    if (!report || typeof report.bucket !== "string" || typeof report.key !== "string"
      || typeof report.sha256 !== "string" || !Number.isSafeInteger(report.sizeBytes)
      || typeof run.id !== "string" || typeof run.targetPlatform !== "string") continue;
    return Object.freeze({
      runId: run.id,
      targetPlatform: run.targetPlatform,
      object: Object.freeze({
        bucket: report.bucket,
        key: report.key,
        sha256: report.sha256,
        sizeBytes: Number(report.sizeBytes),
      }),
    });
  }
  return null;
}

export function evidenceRunsForVisualRead(
  runs: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] {
  const selected = latestEvidenceReport(runs);
  if (!selected) return Object.freeze([]);
  const run = runs.find(candidate => candidate.id === selected.runId);
  return Object.freeze(run ? [run] : []);
}

function assetSourcePath(asset: Readonly<Record<string, unknown>>): string | null {
  const source = typeof asset.sourcePath === "string" ? asset.sourcePath
    : typeof asset.expectedResourcePath === "string" && asset.expectedResourcePath.startsWith("res://")
      ? asset.expectedResourcePath.slice("res://".length)
      : "";
  if (!source) return null;
  try { return normalizeProjectPath(source); } catch { return null; }
}

type ProbeReference = Readonly<{ kind: "CONTROL" | "STATE" | "PROGRESS"; value: string }>;

function testPlanProbeReferences(plan: Readonly<Record<string, unknown>>): readonly ProbeReference[] {
  const references = new Map<string, ProbeReference>();
  const add = (kind: ProbeReference["kind"], value: unknown) => {
    if (typeof value !== "string" || !value) return;
    references.set(`${kind}:${value}`, Object.freeze({ kind, value }));
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (item.source === "STATE" || item.source === "PROGRESS") add(item.source, item.key);
    if (item.source === "CONTROL") add("CONTROL", item.targetId);
    if (typeof item.type === "string" && item.type !== "checkpoint" && item.type !== "wait") {
      add("CONTROL", item.targetId);
      add("CONTROL", item.fromTargetId);
      add("CONTROL", item.toTargetId);
    }
    if (item.type === "checkpoint") add("CONTROL", item.changeTargetId);
    Object.values(item).forEach(visit);
  };
  visit(plan.testManifest);
  const placement = boundedObject(plan.assetPlacementPlan);
  if (Array.isArray(placement.placements)) {
    placement.placements.forEach(item => add("CONTROL", boundedObject(item).targetId));
  }
  return Object.freeze([...references.values()]);
}

export function unpublishedTestPlanProbeReferences(
  plan: Readonly<Record<string, unknown>>,
  publisherTexts: readonly string[],
): readonly ProbeReference[] {
  const published = probePublisherLiterals(publisherTexts);
  return Object.freeze(testPlanProbeReferences(plan).filter(reference => !published.matches(reference.value)));
}

export function bundledCjkFontValidationError(
  texts: readonly string[],
  fontPaths: readonly string[],
): string | null {
  const cjkLiteral = /"(?:\\.|[^"\\\r\n])*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}](?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}](?:\\.|[^'\\\r\n])*'/u;
  if (!texts.some(text => cjkLiteral.test(text))) return null;
  if (fontPaths.length === 0) {
    return "Project source displays CJK text but does not bundle a TTF, TTC, OTF, OTC, WOFF, or WOFF2 font; cross-platform builds must not depend on host fallback fonts";
  }
  const publication = texts.join("\n").toLowerCase();
  const referenced = fontPaths.some(path => {
    const normalized = path.toLowerCase();
    const basename = normalized.split("/").at(-1) ?? normalized;
    return publication.includes(normalized) || publication.includes(`res://${normalized}`)
      || publication.includes(basename);
  });
  return referenced ? null
    : "Project source bundles a CJK font but does not reference it from the runtime UI or theme";
}

export function unobservedTestPlanAssetPlacements(
  plan: Readonly<Record<string, unknown>>,
): readonly Readonly<{ targetId: string; checkpointRole: string }>[] {
  const manifest = boundedObject(plan.testManifest, MAX_TEST_PLAN_TOOL_ARGUMENT_BYTES);
  const events: Readonly<Record<string, unknown>>[] = [];
  if (Array.isArray(manifest.features)) {
    for (const feature of manifest.features) {
      const boundedFeature = boundedObject(feature, MAX_TEST_PLAN_TOOL_ARGUMENT_BYTES);
      // Artifact and source-backed requirements are valid non-interactive
      // features. They have no interactionScript and therefore cannot
      // contribute screenshot checkpoints for asset-placement coverage.
      if (!boundedFeature.interactionScript
        || typeof boundedFeature.interactionScript !== "object"
        || Array.isArray(boundedFeature.interactionScript)) continue;
      const script = boundedObject(boundedFeature.interactionScript, MAX_TEST_PLAN_TOOL_ARGUMENT_BYTES);
      if (Array.isArray(script.events)) events.push(...script.events.map(boundedObject));
    }
  }
  const referencesTarget = (value: unknown, targetId: string): boolean => {
    if (!Array.isArray(value)) return false;
    return value.some(candidate => boundedObject(candidate).source === "CONTROL"
      && boundedObject(candidate).targetId === targetId);
  };
  const placementObserved = (targetId: string, checkpointRole: string): boolean => {
    return events.some(event => event.type === "checkpoint" && event.role === checkpointRole
      && (checkpointRole === "START" || checkpointRole === "READY"
        || event.changeTargetId === targetId
        || referencesTarget(event.assertions, targetId)));
  };
  const placement = boundedObject(plan.assetPlacementPlan);
  if (!Array.isArray(placement.placements)) return Object.freeze([]);
  return Object.freeze(placement.placements.flatMap(candidate => {
    const item = boundedObject(candidate);
    const targetId = typeof item.targetId === "string" ? item.targetId : "";
    const checkpointRole = typeof item.checkpointRole === "string" ? item.checkpointRole : "";
    return targetId && checkpointRole && !placementObserved(targetId, checkpointRole)
      ? [Object.freeze({ targetId, checkpointRole })]
      : [];
  }));
}

/**
 * A special interaction branch replaces the normal dialogue choice list.
 * Reject a checkpoint that claims the normal list is visible immediately
 * before driving a crisis, verification, recovery, or ending control. This is
 * a plan-authoring contradiction, not a product failure.
 */
export function specialBranchCheckpointMismatches(
  manifest: Readonly<Record<string, unknown>>,
): readonly string[] {
  const mismatches: string[] = [];
  const features = Array.isArray(manifest.features) ? manifest.features : [];
  const specialTarget = /^(?:crisis-|verification-|timeline-seal(?:$|-))/u;
  for (const featureValue of features) {
    if (!featureValue || typeof featureValue !== "object" || Array.isArray(featureValue)) continue;
    const script = (featureValue as Readonly<Record<string, unknown>>).interactionScript;
    if (!script || typeof script !== "object" || Array.isArray(script)) continue;
    const events = Array.isArray((script as Readonly<Record<string, unknown>>).events)
      ? (script as Readonly<Record<string, unknown>>).events as readonly unknown[] : [];
    for (let index = 0; index < events.length - 1; index += 1) {
      const currentValue = events[index];
      const nextValue = events[index + 1];
      if (!currentValue || typeof currentValue !== "object" || Array.isArray(currentValue)
        || !nextValue || typeof nextValue !== "object" || Array.isArray(nextValue)) continue;
      const checkpoint = currentValue as Readonly<Record<string, unknown>>;
      const next = nextValue as Readonly<Record<string, unknown>>;
      const nextTarget = typeof next.targetId === "string" ? next.targetId : "";
      if (checkpoint.type !== "checkpoint" || !specialTarget.test(nextTarget)) continue;
      const assertsDefaultList = checkpoint.changeTargetId === "dialogue-choice-list"
        || (Array.isArray(checkpoint.assertions) && checkpoint.assertions.some(value => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return false;
          const assertion = value as Readonly<Record<string, unknown>>;
          return assertion.source === "CONTROL" && assertion.targetId === "dialogue-choice-list";
        }));
      if (assertsDefaultList) {
        mismatches.push(`${String(checkpoint.id ?? `checkpoint-${index + 1}`)} -> ${nextTarget}`);
      }
    }
  }
  return Object.freeze(mismatches);
}

export function finalSealPostconditionMismatches(
  manifest: Readonly<Record<string, unknown>>,
): readonly string[] {
  const mismatches: string[] = [];
  const features = Array.isArray(manifest.features) ? manifest.features : [];
  for (const featureValue of features) {
    if (!featureValue || typeof featureValue !== "object" || Array.isArray(featureValue)) continue;
    const script = (featureValue as Readonly<Record<string, unknown>>).interactionScript;
    if (!script || typeof script !== "object" || Array.isArray(script)) continue;
    const events = Array.isArray((script as Readonly<Record<string, unknown>>).events)
      ? (script as Readonly<Record<string, unknown>>).events as readonly unknown[] : [];
    for (let index = 1; index < events.length; index += 1) {
      const previousValue = events[index - 1];
      const currentValue = events[index];
      if (!previousValue || typeof previousValue !== "object" || Array.isArray(previousValue)
        || !currentValue || typeof currentValue !== "object" || Array.isArray(currentValue)) continue;
      const previous = previousValue as Readonly<Record<string, unknown>>;
      const current = currentValue as Readonly<Record<string, unknown>>;
      if (previous.targetId !== "timeline-seal" || current.targetId !== "action-confirm"
        || !Array.isArray(current.postconditions)) continue;
      const assertsSceneAdvance = current.postconditions.some(value => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const assertion = value as Readonly<Record<string, unknown>>;
        return assertion.source === "PROGRESS" && assertion.key === "scene_number"
          && assertion.operator === "CHANGED";
      });
      if (assertsSceneAdvance) mismatches.push(String(current.stepId ?? `event-${index + 1}`));
    }
  }
  return Object.freeze(mismatches);
}

function probePublisherLiterals(texts: readonly string[]): Readonly<{ matches(value: string): boolean }> {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  const register = (value: string): void => {
    if (value.length > 240) return;
    exact.add(value);
    if (/%[sdif]/i.test(value)) {
      const expression = value
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/%[sdif]/gi, "[a-z0-9_.-]+");
      patterns.push(new RegExp(`^${expression}$`));
    }
    if (value.endsWith("-") && /^[a-z0-9][a-z0-9_.-]*-$/.test(value)) {
      patterns.push(new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z0-9_.-]+$`));
    }
  };
  const literal = /"((?:\\.|[^"\\\r\n]){0,240})"|'((?:\\.|[^'\\\r\n]){0,240})'/g;
  const stableLiteral = /(["'])((?:[a-z0-9_.-]|%[sdif]){1,240})\1/gi;
  for (const text of texts) {
    // Probe references are stable IDs/paths. Extract those bounded literals
    // independently so an apostrophe in a comment (for example `engine's`)
    // cannot make a language-agnostic quote matcher consume the rest of the
    // source and hide otherwise explicit publisher keys.
    for (const match of text.matchAll(stableLiteral)) register(String(match[2] ?? ""));
    for (const match of text.matchAll(literal)) {
      const value = String(match[1] ?? match[2] ?? "").replace(/\\(["'\\])/g, "$1");
      register(value);
    }
  }
  return Object.freeze({ matches: (value: string) => exact.has(value) || patterns.some(pattern => pattern.test(value)) });
}

export function reviseTestPlanTimeout(
  value: Readonly<Record<string, unknown>>,
  timeoutMs: number,
): Readonly<Record<string, unknown>> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) {
    throw new Error("A revised Test plan timeout must be an integer from 1 through 900000");
  }
  const testManifest = structuredClone(boundedObject(value.testManifest, MAX_TEST_PLAN_TOOL_ARGUMENT_BYTES));
  if (!Array.isArray(testManifest.features)) throw new Error("The base Test plan has no feature list");
  let revisedInteractiveFeatures = 0;
  const features = testManifest.features.map(candidate => {
    const feature = boundedObject(candidate, MAX_TEST_PLAN_TOOL_ARGUMENT_BYTES);
    if (feature.verificationMethod !== "interactive") return structuredClone(feature);
    revisedInteractiveFeatures += 1;
    return Object.freeze({ ...structuredClone(feature), timeoutMs });
  });
  if (revisedInteractiveFeatures === 0) throw new Error("The base Test plan has no interactive feature timeout to revise");
  return Object.freeze({
    testManifest: Object.freeze({ ...testManifest, features: Object.freeze(features) }),
    assetPlacementPlan: Object.freeze(structuredClone(
      boundedObject(value.assetPlacementPlan, MAX_TEST_PLAN_TOOL_ARGUMENT_BYTES),
    )),
  });
}

function freezeTestPlan(value: Readonly<Record<string, unknown>>, context: ProjectContext): Readonly<Record<string, unknown>> {
  const manifest = value.testManifest;
  const validationError = testManifestValidationError(manifest);
  if (validationError) throw new Error(`The Test Agent plan contains an invalid deterministic test manifest: ${validationError}`);
  if (!validateTestManifest(manifest)) throw new Error("The Test Agent plan contains an invalid deterministic test manifest");
  const manifestRequirementIds = new Set(manifest.requirements.map(item => item.requirementId));
  const goalIds = context.e2e.goals.map(goal => String(goal.id ?? "")).filter(Boolean);
  if (goalIds.some(id => !manifestRequirementIds.has(id))) {
    throw new Error("The Test Agent plan does not cover every current E2E goal ID");
  }
  const missingNarrativeCheckpoints = missingNarrativeExchangeCheckpoints(
    manifest,
    requiredNarrativeSceneAssetKeys(context),
  );
  if (missingNarrativeCheckpoints.length > 0) {
    throw new Error(`The Test Agent plan must capture every authored narrative exchange before choosing: ${missingNarrativeCheckpoints.join(", ")}`);
  }
  const placement = boundedObject(value.assetPlacementPlan);
  const visualAssetPlan = context.assetPlan.filter(asset => String(asset.assetType ?? "").toLowerCase() !== "music");
  const plannedAssetKeys = visualAssetPlan.map(asset => String(asset.key ?? asset.assetKey ?? "")).filter(Boolean).sort();
  if (placement.schema !== "deviludo.asset-placement-plan"
    || !Array.isArray(placement.plannedAssetKeys)
    || !Array.isArray(placement.placements)
    || !Array.isArray(placement.unmappedAssetKeys)
    || placement.unmappedAssetKeys.length > 0
    || JSON.stringify([...placement.plannedAssetKeys].sort()) !== JSON.stringify(plannedAssetKeys)) {
    throw new Error("The Test Agent plan must map every current planned asset to its required control");
  }
  const mapped = new Set<string>();
  for (const candidate of placement.placements) {
    const item = boundedObject(candidate);
    if (!plannedAssetKeys.includes(String(item.assetKey ?? ""))
      || typeof item.targetId !== "string" || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(item.targetId)
      || !["START", "READY", "ACTION", "PROGRESS", "COMPLETION"].includes(String(item.checkpointRole))
      || typeof item.expectedResourcePath !== "string" || !/^res:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,499}\.(?:png|jpe?g|webp|svg)$/i.test(item.expectedResourcePath)
      || !(item.expectedSha256 === null || /^sha256:[0-9a-f]{64}$/.test(String(item.expectedSha256)))) {
      throw new Error("The Test Agent plan contains an invalid asset-to-control binding");
    }
    mapped.add(String(item.assetKey));
  }
  if (plannedAssetKeys.some(key => !mapped.has(key))) throw new Error("The Test Agent plan leaves a planned asset untested");
  const unobservedPlacements = unobservedTestPlanAssetPlacements(value);
  if (unobservedPlacements.length > 0) {
    throw new Error(`The Test Agent plan does not explicitly observe conditional asset targets at their planned checkpoint roles: ${unobservedPlacements
      .map(item => `${item.targetId}@${item.checkpointRole}`).join(", ")}`);
  }
  const specialBranchMismatches = specialBranchCheckpointMismatches(manifest);
  if (specialBranchMismatches.length > 0) {
    throw new Error(`The Test Agent plan asserts the default dialogue choice list before a special branch control: ${specialBranchMismatches.join(", ")}`);
  }
  const finalSealMismatches = finalSealPostconditionMismatches(manifest);
  if (finalSealMismatches.length > 0) {
    throw new Error(`The Test Agent plan expects scene_number to advance after the final timeline seal confirmation: ${finalSealMismatches.join(", ")}`);
  }
  const coverage = Object.freeze(Object.fromEntries(manifest.requirements.map(requirement => [
    requirement.requirementId,
    Object.freeze(manifest.features.filter(feature => feature.requirementIds.includes(requirement.requirementId)).map(feature => feature.id)),
  ])));
  const assetPlacementPlan = Object.freeze({
    schema: "deviludo.asset-placement-plan",
    plannedAssetKeys: Object.freeze(plannedAssetKeys),
    placements: Object.freeze(placement.placements.map(item => Object.freeze(structuredClone(item)))),
    unmappedAssetKeys: Object.freeze([]),
  });
  const testManifestDigest = stableDigest(manifest);
  const contractDigest = stableDigest({ testManifest: manifest, assetPlacementPlan, runner: "adaptive-real-input" });
  return Object.freeze({
    testManifest: Object.freeze(structuredClone(manifest)),
    coverage,
    assetPlacementPlan,
    testManifestDigest,
    contractDigest,
    executionPlan: planE2eExecution(manifest),
  });
}

/**
 * A source checkpoint proves authored strings exist; the E2E plan must prove
 * that each declared exchange is separately reachable and rendered. Requiring
 * the scene/beat pair in the same screenshot checkpoint prevents a planner
 * from sampling chapter labels while shared choices silently repeat beneath
 * changing prompts.
 */
export function missingNarrativeExchangeCheckpoints(
  manifest: Readonly<Record<string, unknown>>,
  requiredSceneKeys: readonly string[],
): readonly string[] {
  if (requiredSceneKeys.length < 2) return Object.freeze([]);
  const observed = new Set<string>();
  const features = Array.isArray(manifest.features) ? manifest.features : [];
  for (const featureValue of features) {
    if (!featureValue || typeof featureValue !== "object") continue;
    const feature = featureValue as Readonly<Record<string, unknown>>;
    const script = feature.interactionScript;
    if (!script || typeof script !== "object") continue;
    const events = Array.isArray((script as Readonly<Record<string, unknown>>).events)
      ? (script as Readonly<Record<string, unknown>>).events as readonly unknown[] : [];
    for (const eventValue of events) {
      if (!eventValue || typeof eventValue !== "object") continue;
      const event = eventValue as Readonly<Record<string, unknown>>;
      if (event.type !== "checkpoint" || event.role === "START" || !Array.isArray(event.assertions)) continue;
      let sceneNumber: number | null = null;
      let sceneBeat: number | null = null;
      for (const assertionValue of event.assertions) {
        if (!assertionValue || typeof assertionValue !== "object") continue;
        const assertion = assertionValue as Readonly<Record<string, unknown>>;
        if (assertion.source !== "PROGRESS" || assertion.operator !== "EQUALS"
          || typeof assertion.value !== "number" || !Number.isInteger(assertion.value)) continue;
        if (assertion.key === "scene_number") sceneNumber = assertion.value;
        if (assertion.key === "scene_beat") sceneBeat = assertion.value;
      }
      if (sceneNumber !== null && sceneBeat !== null) observed.add(`${sceneNumber}:${sceneBeat}`);
    }
  }
  const missing: string[] = [];
  for (let sceneNumber = 1; sceneNumber <= requiredSceneKeys.length; sceneNumber += 1) {
    for (let sceneBeat = 0; sceneBeat < 3; sceneBeat += 1) {
      const key = `${sceneNumber}:${sceneBeat}`;
      if (!observed.has(key)) missing.push(`scene ${sceneNumber} beat ${sceneBeat + 1}`);
    }
  }
  return Object.freeze(missing);
}

function stableDigest(value: unknown): string {
  const stable = (candidate: unknown): string => {
    if (Array.isArray(candidate)) return `[${candidate.map(stable).join(",")}]`;
    if (candidate && typeof candidate === "object") {
      const object = candidate as Record<string, unknown>;
      return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
    }
    return JSON.stringify(candidate);
  };
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}
