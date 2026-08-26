import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import type { ProjectRuntimeRole } from "@/lib/product/contracts";
import {
  PROJECT_RUNTIME_SCHEMA,
  type ProjectRuntimeControlRequest,
  type ProjectRuntimeTurnMode,
  type ProjectRuntimeTurnResult,
} from "@/lib/product/project-runtime";
import { normalizeProjectPath } from "@/lib/product/source-archive";
import { planE2eExecution, validateTestManifest } from "@/lib/product/test-manifest";
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
import { ProjectRuntimeRepository, type ProjectContextSeed } from "./project-runtime-repository";
import { ProjectSourceStore } from "./project-sources";
import type { StoredInstanceAgentSettings } from "./repository";

const ROLE_TO_MODEL = Object.freeze({
  INTENT: "intent",
  ANALYSIS: "analysis",
  DESIGN: "design",
  DEVELOPMENT: "development",
  TEST: "test",
} as const);

const ROLE_TOOLS = Object.freeze({
  INTENT: new Set(["context.read", "conversation.reply", "workflow.intent_decision", "workflow.stop", "workflow.continue"]),
  ANALYSIS: new Set(["context.read", "source.list", "source.read", "diagnostics.run", "context.update_analysis", "conversation.reply"]),
  DESIGN: new Set(["context.read", "requirements.update", "project_document.update", "e2e_goals.update", "conversation.reply", "handoff.create"]),
  DEVELOPMENT: new Set(["context.read", "source.list", "source.read", "source.checkpoint", "assets.plan", "assets.cleanup", "build.request", "conversation.reply", "handoff.create"]),
  TEST: new Set(["context.read", "source.list", "source.read", "test_plan.replace", "e2e.start", "e2e.observe", "evidence.read", "test.verdict", "conversation.reply", "handoff.create"]),
});
const READ_ONLY_TOOLS = new Set([
  "context.read", "source.list", "source.read", "evidence.read", "conversation.reply",
]);

export class ProjectRuntimeService {
  private readonly contexts: ProjectContextStore;
  private readonly sources: ProjectSourceStore;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: ProjectRuntimeRepository,
    private readonly projectsRoot: string,
    private readonly backend: ProjectRuntimeBackend = new ProcessProjectRuntimeBackend(),
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

  async turn(input: Readonly<{
    workspaceId: string;
    projectId: string;
    role: ProjectRuntimeRole;
    mode: ProjectRuntimeTurnMode;
    prompt: string;
    responseLanguage: "en" | "zh";
    settings: StoredInstanceAgentSettings;
    sourceRevision: number | null;
    sourceRelativePath: string | null;
    lifecycleLeaseToken?: string;
    attachments?: readonly Readonly<{ content: Buffer; extension: "png" | "jpg" | "webp" }>[];
    onEvent?: (content: string) => void;
  }>): Promise<ProjectRuntimeTurnResult> {
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
    await this.repository.markContainer(input.workspaceId, input.projectId, {
      generation: runtime.generation,
      fencingToken: runtime.fencingToken,
      state: "RUNNING",
      containerId: ensured.containerId,
    });
    const started = await this.repository.startTurn({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
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
    const validatedArguments = boundedObject(input.arguments);
    const callId = await this.repository.beginToolCall({
      ...input,
      sessionId: authorization.sessionId,
      arguments: summarizeToolAuditValue(validatedArguments),
    });
    try {
      const result = await this.executeTool(input);
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
      return Object.freeze({ context: await this.readContext(input.workspaceId, input.projectId) });
    }
    if (input.name === "source.list") return Object.freeze({ paths: await this.listSource(input.workspaceId, input.projectId) });
    if (input.name === "source.read") return Object.freeze({ content: await this.readSource(input.workspaceId, input.projectId, String(input.arguments.path ?? "")) });
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
      return this.confirmApprovedField(input.workspaceId, input.projectId,
        "projectDocument", boundedObject(input.arguments.document));
    }
    if (input.name === "e2e_goals.update") {
      const goals = arrayOfObjects(input.arguments.goals);
      const current = await this.readContext(input.workspaceId, input.projectId);
      if (!sameJson(goals, current.e2e.goals)) {
        throw new Error("Design Agent cannot change the approved E2E goal snapshot during execution");
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
      return this.mutateResult(input.workspaceId, input.projectId, current => updateProjectContext(current, {
        handoffs: Object.freeze([...current.handoffs, Object.freeze({
          id: input.turnId, fromRole: input.role, ...boundedObject(input.arguments), createdAt: new Date().toISOString(),
        })].slice(-100)),
      }));
    }
    if (input.name === "source.checkpoint") return this.checkpointSource(input.workspaceId, input.projectId);
    if (input.name === "build.request") return this.updateWorkflow(input.workspaceId, input.projectId, { state: "BUILDING", buildRequestedByTurnId: input.turnId });
    if (input.name === "test_plan.replace") {
      const draftPlan = boundedObject(input.arguments.plan);
      const context = await this.mutateContext(input.workspaceId, input.projectId, current => {
        if (!current.source) throw new Error("A test plan requires a published source revision");
        const plan = freezeTestPlan(draftPlan, current);
        return updateProjectContext(current, { e2e: Object.freeze({
          ...current.e2e,
          planRevision: (current.e2e.planRevision ?? 0) + 1,
          plan,
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
    if (input.name === "test.verdict") return this.updateField(input.workspaceId, input.projectId, "testSummary", boundedObject(input.arguments));
    if (input.name === "e2e.start") {
      const plan = await this.repository.readLatestTestPlan(input.workspaceId, input.projectId);
      if (!plan) throw new Error("The Test Agent must persist a complete plan before starting E2E");
      return Object.freeze({ accepted: true, plan, delegatedTo: "controlled-host-gateway" });
    }
    if (input.name === "e2e.observe" || input.name === "evidence.read") {
      return Object.freeze({ runs: await this.repository.readTestEvidence(input.workspaceId, input.projectId) });
    }
    if (input.name === "diagnostics.run") {
      return Object.freeze({ accepted: true, delegatedTo: "controlled-host-gateway", bounded: true });
    }
    throw new Error(`Project Runtime tool is not implemented: ${input.name}`);
  }

  private async checkpointSource(workspaceId: string, projectId: string): Promise<Readonly<Record<string, unknown>>> {
    const context = await this.readContext(workspaceId, projectId);
    const revision = (context.source?.revision ?? 0) + 1;
    const directory = join(resolve(this.projectsRoot), "workspaces", workspaceId, "projects", projectId, "runtime", "worktree");
    // ProjectSourceStore validates every path and rejects links while publishing.
    const stored = await this.sources.publishDirectory({ workspaceId, projectId, revision, directory });
    await this.repository.recordSourceRevision({ workspaceId, projectId, revision,
      relativePath: stored.relativePath, digest: stored.digest, fileCount: stored.fileCount, totalBytes: stored.totalBytes });
    await this.mutateContext(workspaceId, projectId, current => updateProjectContext(current, { source: Object.freeze({
      revision, sha256: stored.digest, relativePath: stored.relativePath,
    }) }));
    return Object.freeze({ revision, sha256: stored.digest, relativePath: stored.relativePath });
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

  private async readSource(workspaceId: string, projectId: string, path: string): Promise<string> {
    const root = await this.sourceRoot(workspaceId, projectId);
    const target = resolve(root, normalizeProjectPath(path));
    if (!target.startsWith(`${root}${sep}`)) throw new Error("Source path escapes the project");
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("Source file is not readable");
    const bytes = await readFile(target);
    if (bytes.includes(0)) throw new Error("Binary source is not returned as conversation context");
    return bytes.toString("utf8");
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

  private async replaceAssetPlan(
    workspaceId: string,
    projectId: string,
    requested: readonly Readonly<Record<string, unknown>>[],
  ): Promise<Readonly<Record<string, unknown>>> {
    const next = normalizeAssetPlan(requested);
    const current = await this.readContext(workspaceId, projectId);
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

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function boundedObject(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool argument must be an object");
  const serialized = JSON.stringify(value);
  if (serialized.length > 64_000 || /(?:api.?key|credential|auth.?token|password|secret)/i.test(serialized)) {
    throw new Error("Tool argument summary is unsafe or too large");
  }
  return Object.freeze(JSON.parse(serialized));
}

const SENSITIVE_AUDIT_KEY = /(?:api.?key|authorization|credential|mcp.?token|password|provider.?token|secret)/i;
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
    const origin = String(asset.origin ?? "GENERATED").toUpperCase();
    const resource = String(asset.expectedResourcePath ?? "");
    if (!/^[a-z0-9][a-z0-9/_.-]{0,199}$/.test(key) || keys.has(key)
      || !["GENERATED", "USER_UPLOAD"].includes(origin)
      || !/^res:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,499}\.(?:png|jpe?g|webp|svg)$/i.test(resource)) {
      throw new Error("Development Agent returned an invalid or duplicate asset plan item");
    }
    keys.add(key);
    const normalized = {
      ...asset,
      key,
      origin,
      expectedResourcePath: resource,
      sourcePath: assetSourcePath(asset) ?? resource.slice("res://".length),
    };
    return Object.freeze(normalized);
  }));
}

function isUserUpload(asset: Readonly<Record<string, unknown>>): boolean {
  return String(asset.origin ?? "").toUpperCase() === "USER_UPLOAD";
}

function assetSourcePath(asset: Readonly<Record<string, unknown>>): string | null {
  const source = typeof asset.sourcePath === "string" ? asset.sourcePath
    : typeof asset.expectedResourcePath === "string" && asset.expectedResourcePath.startsWith("res://")
      ? asset.expectedResourcePath.slice("res://".length)
      : "";
  if (!source) return null;
  try { return normalizeProjectPath(source); } catch { return null; }
}

function freezeTestPlan(value: Readonly<Record<string, unknown>>, context: ProjectContext): Readonly<Record<string, unknown>> {
  const manifest = value.testManifest;
  if (!validateTestManifest(manifest)) throw new Error("The Test Agent plan contains an invalid deterministic test manifest");
  const manifestRequirementIds = new Set(manifest.requirements.map(item => item.requirementId));
  const goalIds = context.e2e.goals.map(goal => String(goal.id ?? "")).filter(Boolean);
  if (goalIds.some(id => !manifestRequirementIds.has(id))) {
    throw new Error("The Test Agent plan does not cover every current E2E goal ID");
  }
  const placement = boundedObject(value.assetPlacementPlan);
  const plannedAssetKeys = context.assetPlan.map(asset => String(asset.key ?? asset.assetKey ?? "")).filter(Boolean).sort();
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
