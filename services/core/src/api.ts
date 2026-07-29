import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import Fastify, { type FastifyRequest } from "fastify";
import {
  assertPoolOperatingSystem,
  isServerPoolKind,
  type ServerNodeState,
  type ServerOperatingSystem,
} from "@/lib/runtime/server-pools";
import {
  createAgentSecretStore,
  isMaskedApiKey,
  parseAgentSettingsInput,
  type AgentSecretStore,
} from "./agent-settings";
import { detectAgentRuntimes } from "./agent-runtime-detection";
import type { CoreConfig } from "./config";
import {
  assertE2eCompletion,
  parseCompletion,
  type ClaimedJobIdentity,
  type WorkflowSignalInput,
} from "./contracts";
import type { Database } from "./database";
import { CORE_MODULES } from "./modules";
import { generateProjectName } from "./project-naming";
import type { CoreRepository, StoredInstanceAgentSettings } from "./repository";
import { HttpSigningGrantBroker, type SigningGrantBroker } from "./signing-grants";

export async function runApi(
  repository: CoreRepository,
  database: Database,
  config: CoreConfig,
  signal: AbortSignal,
  signingGrants: SigningGrantBroker = new HttpSigningGrantBroker(),
  agentSecrets: AgentSecretStore = createAgentSecretStore(),
): Promise<void> {
  const app = Fastify({
    logger: true,
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 70_000,
    trustProxy: false,
  });

  app.setErrorHandler((error, _request, reply) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    const status = "statusCode" in failure && typeof failure.statusCode === "number" ? failure.statusCode : 400;
    const code = "code" in failure && typeof failure.code === "string" ? failure.code : null;
    void reply.code(status >= 400 && status < 500 ? status : 500).send({
      code: status >= 500 ? "INTERNAL_ERROR" : code ?? "INVALID_REQUEST",
      message: status >= 500 ? "Core request failed" : failure.message,
    });
  });

  app.get("/health/live", async () => ({
    schemaVersion: "deviludo.core-liveness.v1",
    service: "core",
    role: config.role,
    status: "ok",
    modules: CORE_MODULES.filter(module => module.role === config.role).map(module => module.name),
  }));

  app.get("/health/ready", async (_request, reply) => {
    await repository.ping();
    const pools = await repository.readServerPools();
    const required = new Set(config.requiredReadyPools);
    const ready = pools
      .filter(pool => required.has(pool.kind))
      .every(pool => pool.readiness === "READY" || pool.readiness === "ON_DEMAND_READY");
    return reply.code(ready ? 200 : 503).send({
      schemaVersion: "deviludo.platform-readiness.v1",
      status: ready ? "ready" : "not_ready",
      pools: Object.fromEntries(pools.map(pool => [pool.kind, pool.readiness])),
      requiredPools: config.requiredReadyPools,
    });
  });

  app.get("/v1/admin/server-pools", async (request, reply) => {
    authorizeWeb(request, config);
    const [pools, nodes] = await Promise.all([repository.readServerPools(), repository.readServerNodes()]);
    return reply.send({ pools, nodes });
  });

  app.get("/v1/admin/server-nodes", async (request, reply) => {
    authorizeWeb(request, config);
    return reply.send({ nodes: await repository.readServerNodes() });
  });

  app.get("/v1/session", async (request, reply) => {
    localProductAccess(request, config);
    const selectedWorkspace = await selectedWorkspaceFromRequest(request, repository);
    return reply.header("cache-control", "no-store").send({ session: { selectedWorkspace } });
  });

  app.get("/v1/workspaces", async (request, reply) => {
    localProductAccess(request, config);
    return reply.header("cache-control", "no-store").send({ workspaces: await repository.listWorkspaces() });
  });

  app.post("/v1/workspaces", async (request, reply) => {
    localProductAccess(request, config);
    const body = objectBody(request.body);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 200) return reply.code(400).send({ code: "INVALID_WORKSPACE_NAME" });
    const workspace = await repository.createWorkspace({ id: randomUUID(), name });
    return reply
      .header("set-cookie", selectedWorkspaceCookie(workspace.id))
      .code(201)
      .send({ workspace, selectedWorkspace: workspace });
  });

  app.put("/v1/session/workspace", async (request, reply) => {
    localProductAccess(request, config);
    const body = objectBody(request.body);
    if (typeof body.workspaceId !== "string" || !UUID.test(body.workspaceId)) {
      return reply.code(400).send({ code: "INVALID_WORKSPACE" });
    }
    const workspace = await repository.readWorkspace(body.workspaceId);
    if (!workspace) return reply.code(404).send({ code: "WORKSPACE_NOT_FOUND" });
    return reply.header("set-cookie", selectedWorkspaceCookie(workspace.id)).send({ selectedWorkspace: workspace });
  });

  app.delete("/v1/session/workspace", async (request, reply) => {
    localProductAccess(request, config);
    return reply.header("set-cookie", selectedWorkspaceCookie(null)).send({ selectedWorkspace: null });
  });

  app.get("/v1/settings/agent", async (request, reply) => {
    localProductAccess(request, config);
    const [settings, runtimes] = await Promise.all([
      repository.readAgentSettings(),
      detectAgentRuntimes(),
    ]);
    const apiKeyMask = settings
      ? settings.apiKeyMask
        ?? await agentSecrets.readApiKeyMask(settings.credentialSecretRef)
      : null;
    return reply.header("cache-control", "no-store").send({
      settings: publicAgentSettings(settings, apiKeyMask),
      runtimes,
    });
  });

  app.put("/v1/settings/agent", async (request, reply) => {
    localProductAccess(request, config);
    const input = parseAgentSettingsInput(request.body);
    const current = await repository.readAgentSettings();
    const currentMask = current
      ? current.apiKeyMask
        ?? await agentSecrets.readApiKeyMask(current.credentialSecretRef)
      : null;
    if (input.apiKey && isMaskedApiKey(input.apiKey) && input.apiKey !== currentMask) {
      throw new Error("API Key 掩码与已保存凭据不匹配");
    }
    const replacementApiKey = input.apiKey && input.apiKey !== currentMask ? input.apiKey : null;
    if (!replacementApiKey && !current) throw new Error("首次配置必须提供 API Key");
    const credential = replacementApiKey
      ? await agentSecrets.writeApiKey(replacementApiKey)
      : {
          secretRef: current?.credentialSecretRef ?? "",
          mask: currentMask ?? "",
          fingerprint: current?.apiKeyFingerprint ?? "",
          version: current?.credentialVersion ?? "",
        };
    if (!credential.mask) throw new Error("已保存 API Key 的掩码不可用，请重新填写 API Key");
    const saved = await repository.saveAgentSettings({
      agentRuntime: input.agentRuntime,
      baseUrl: input.baseUrl,
      models: input.models,
      credentialSecretRef: credential.secretRef,
      apiKeyMask: credential.mask,
      apiKeyFingerprint: credential.fingerprint,
      credentialVersion: credential.version,
      updatedBy: "LOCAL_OPERATOR",
    });
    return reply.header("cache-control", "no-store").send({ settings: publicAgentSettings(saved) });
  });

  app.get("/v1/projects", async (request, reply) => {
    localProductAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository);
    return reply.send({ projects: await repository.listProjects(workspace.id) });
  });

  app.post("/v1/projects", async (request, reply) => {
    localProductAccess(request, config);
    const body = objectBody(request.body);
    const concept = typeof body.concept === "string" ? body.concept.trim() : "";
    const suppliedName = typeof body.name === "string" ? body.name.trim() : "";
    if (concept.length < 10 || concept.length > 4_000 || suppliedName.length > 200) {
      return reply.code(400).send({ code: "INVALID_GAME_CONCEPT" });
    }
    const idempotencyKey = requestIdempotencyKey(request, "project");
    const currentWorkspace = await selectedWorkspaceFromRequest(request, repository);
    const prior = await repository.readProjectCreationReceipt(idempotencyKey);
    if (prior) {
      if (prior.operationKind !== "PROJECT" || (currentWorkspace && currentWorkspace.id !== prior.workspaceId)) {
        return reply.code(409).send({ code: "IDEMPOTENCY_KEY_REUSED" });
      }
      const [workspace, project] = await Promise.all([
        repository.readWorkspace(prior.workspaceId),
        repository.readProject(prior.workspaceId, prior.projectId),
      ]);
      if (!workspace || !project) throw new Error("Project creation receipt is incomplete");
      return reply.header("set-cookie", selectedWorkspaceCookie(workspace.id)).send({ workspace, project });
    }
    const name = suppliedName || await agentProjectName(concept, repository, agentSecrets);
    const workspace = currentWorkspace ?? Object.freeze({ id: randomUUID(), name, createdAt: "" });
    const project = await repository.createProject({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      projectId: randomUUID(),
      workflowId: randomUUID(),
      idempotencyKey,
      name,
      concept,
      specification: specificationFromConcept(name, concept),
    });
    const selectedWorkspace = currentWorkspace ?? await repository.readWorkspace(workspace.id);
    if (!selectedWorkspace) throw new Error("Created workspace could not be read");
    return reply
      .header("set-cookie", selectedWorkspaceCookie(selectedWorkspace.id))
      .code(201)
      .send({ workspace: selectedWorkspace, project });
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId", async (request, reply) => {
    localProductAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    return project ? reply.send({ project }) : reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
  });

  app.get<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId",
    async (request, reply) => {
      localProductAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository);
      if (!UUID.test(request.params.conversationId)) {
        return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      }
      const conversation = await repository.readConversation(workspace.id, request.params.conversationId);
      return conversation
        ? reply.send({ conversation })
        : reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
    },
  );

  app.post("/v1/conversations/messages", async (request, reply) => {
    localProductAccess(request, config);
    const body = objectBody(request.body);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const conversationId = body.conversationId === undefined ? null : body.conversationId;
    const suppliedProjectId = body.projectId === undefined ? null : body.projectId;
    if (content.length < 2 || content.length > 4_000
      || (conversationId !== null && (typeof conversationId !== "string" || !UUID.test(conversationId)))
      || (suppliedProjectId !== null && (typeof suppliedProjectId !== "string" || !UUID.test(suppliedProjectId)))) {
      return reply.code(400).send({ code: "INVALID_CONVERSATION_MESSAGE" });
    }

    let workspace = await selectedWorkspaceFromRequest(request, repository);
    let projectId = suppliedProjectId as string | null;
    if (typeof conversationId === "string") {
      workspace ??= await requireSelectedWorkspace(request, repository);
      const existing = await repository.readConversation(workspace.id, conversationId);
      if (!existing) return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      if (body.projectId !== undefined && projectId !== existing.projectId) {
        return reply.code(409).send({ code: "CONVERSATION_PROJECT_LOCKED" });
      }
      projectId = existing.projectId;
    } else if (projectId && (!workspace || !(await repository.readProject(workspace.id, projectId)))) {
      return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    }

    const created = conversationId === null;
    if (created && !projectId) {
      const idempotencyKey = requestIdempotencyKey(request, "conversation");
      const prior = await repository.readProjectCreationReceipt(idempotencyKey);
      if (prior) {
        if (prior.operationKind !== "CONVERSATION" || !prior.conversationId
          || (workspace && workspace.id !== prior.workspaceId)) {
          return reply.code(409).send({ code: "IDEMPOTENCY_KEY_REUSED" });
        }
        const [priorWorkspace, project, conversation] = await Promise.all([
          repository.readWorkspace(prior.workspaceId),
          repository.readProject(prior.workspaceId, prior.projectId),
          repository.readConversation(prior.workspaceId, prior.conversationId),
        ]);
        if (!priorWorkspace || !project || !conversation) throw new Error("Conversation creation receipt is incomplete");
        return reply
          .header("set-cookie", selectedWorkspaceCookie(priorWorkspace.id))
          .send({ workspace: priorWorkspace, project, conversation });
      }
      const name = await agentProjectName(content, repository, agentSecrets);
      const targetWorkspace = workspace ?? Object.freeze({ id: randomUUID(), name, createdAt: "" });
      const createdBundle = await repository.createProjectConversation({
        workspaceId: targetWorkspace.id,
        workspaceName: targetWorkspace.name,
        projectId: randomUUID(),
        workflowId: randomUUID(),
        conversationId: randomUUID(),
        idempotencyKey,
        name,
        concept: content,
        specification: specificationFromConcept(name, content),
        userContent: content,
      });
      const selectedWorkspace = workspace ?? await repository.readWorkspace(targetWorkspace.id);
      if (!selectedWorkspace) throw new Error("Created workspace could not be read");
      return reply
        .header("set-cookie", selectedWorkspaceCookie(selectedWorkspace.id))
        .code(201)
        .send({ workspace: selectedWorkspace, ...createdBundle });
    }
    workspace ??= await requireSelectedWorkspace(request, repository);
    if (!projectId) throw new Error("Conversation project is required");
    const conversation = await repository.appendConversationTurn({
      workspaceId: workspace.id,
      conversationId: typeof conversationId === "string" ? conversationId : randomUUID(),
      projectId,
      userContent: content,
    });
    const project = await repository.readProject(workspace.id, projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    return reply.code(created ? 201 : 200).send({ workspace, project, conversation });
  });

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/specification",
    async (request, reply) => {
      localProductAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository);
      const body = objectBody(request.body);
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (note.length < 2 || note.length > 2_000) {
        return reply.code(400).send({ code: "INVALID_SPECIFICATION_NOTE" });
      }
      const current = await repository.readProject(workspace.id, request.params.projectId);
      if (!current) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      const project = await repository.updateProjectSpecification({
        workspaceId: workspace.id,
        projectId: request.params.projectId,
        specification: refineSpecification(current.specification, note),
        note,
        idempotencyKey: `spec-refined:${randomUUID()}`,
      });
      return reply.send({ project });
    },
  );

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/approve", async (request, reply) => {
    localProductAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const digest = createHash("sha256").update(JSON.stringify(project.specification)).digest("hex");
    const accepted = await repository.appendSignal(workspace.id, project.workflowId, {
      kind: "SPEC_APPROVED",
      idempotencyKey: `spec-approved:${project.workflowId}`,
      payload: { specificationDigest: `sha256:${digest}` },
    });
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/cancel", async (request, reply) => {
    localProductAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const accepted = await repository.appendSignal(workspace.id, project.workflowId, {
      kind: "CANCEL_REQUESTED",
      idempotencyKey: `cancel:${project.workflowId}`,
      payload: { requestedBy: "LOCAL_OPERATOR" },
    });
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  app.post("/v1/admin/server-nodes", async (request, reply) => {
    authorizeWeb(request, config);
    const body = objectBody(request.body);
    if (!isServerPoolKind(body.poolKind)
      || !["linux", "windows", "macos"].includes(String(body.operatingSystem))
      || !Array.isArray(body.capabilities)
      || body.capabilities.some(value => typeof value !== "string")) {
      return reply.code(400).send({ code: "INVALID_SERVER_NODE" });
    }
    const operatingSystem = body.operatingSystem as ServerOperatingSystem;
    assertPoolOperatingSystem(body.poolKind, operatingSystem);
    const node = await repository.createServerNode({
      poolKind: body.poolKind,
      operatingSystem,
      capabilities: body.capabilities as string[],
    });
    return reply.code(201).send({ node });
  });

  app.post<{ Params: { nodeId: string; action: string } }>(
    "/v1/admin/server-nodes/:nodeId/:action",
    async (request, reply) => {
      authorizeWeb(request, config);
      const states: Readonly<Record<string, ServerNodeState>> = Object.freeze({
        activate: "ACTIVE",
        drain: "DRAINING",
        disable: "DISABLED",
      });
      const state = states[request.params.action];
      if (!state) return reply.code(404).send({ code: "UNKNOWN_NODE_ACTION" });
      const node = await repository.transitionServerNode(request.params.nodeId, state);
      return node ? reply.send({ node }) : reply.code(404).send({ code: "SERVER_NODE_NOT_FOUND" });
    },
  );

  app.post("/v1/e2e/jobs/claim", async (request, reply) => {
    authorizeE2e(request, config);
    const body = objectBody(request.body);
    if (typeof body.nodeId !== "string"
      || !isServerPoolKind(body.poolKind)
      || !body.poolKind.startsWith("E2E_")) {
      return reply.code(400).send({ code: "INVALID_E2E_CLAIM" });
    }
    const node = (await repository.readServerNodes()).find(candidate => candidate.id === body.nodeId);
    if (!node || node.state !== "ACTIVE" || node.poolKind !== body.poolKind) {
      return reply.code(409).send({ code: "NODE_NOT_ELIGIBLE" });
    }
    const job = await repository.claimJob({
      workerId: `e2e:${body.nodeId}`,
      poolKind: body.poolKind,
      leaseSeconds: 60,
    });
    return reply.send({ job });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/heartbeat", async (request, reply) => {
    authorizeE2e(request, config);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body));
    return reply.send({ accepted: await repository.heartbeat(job) });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/complete", async (request, reply) => {
    authorizeE2e(request, config);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body));
    const completion = parseCompletion(body);
    assertE2eCompletion(job, completion);
    return reply.send({ accepted: await repository.complete(job, completion) });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/fail", async (request, reply) => {
    authorizeE2e(request, config);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body));
    const reason = typeof body.reason === "string" ? body.reason : "E2E execution failed";
    return reply.send({ accepted: await repository.fail(job, reason) });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/signing-grant", async (request, reply) => {
    authorizeE2e(request, config);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body));
    if (job.jobKind !== "ARTIFACT_SIGN") return reply.code(403).send({ code: "SIGNING_GRANT_FORBIDDEN" });
    if (typeof body.beforeReimageProof !== "string" || body.beforeReimageProof.length < 16) {
      return reply.code(409).send({ code: "REIMAGE_PROOF_REQUIRED" });
    }
    const operationId = await repository.registerOperation(job, "PLATFORM_SIGN");
    const grant = await signingGrants.issue(job);
    return reply.send({ ...grant, operationId });
  });

  app.post<{ Params: { workflowId: string } }>("/v1/workflows/:workflowId/signals", async (request, reply) => {
    authorizeWeb(request, config);
    const body = objectBody(request.body);
    if (typeof body.workspaceId !== "string"
      || !["SPEC_APPROVED", "CANCEL_REQUESTED", "EXTERNAL_APPROVAL"].includes(String(body.kind))
      || typeof body.idempotencyKey !== "string"
      || !body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      return reply.code(400).send({ code: "INVALID_WORKFLOW_SIGNAL" });
    }
    const accepted = await repository.appendSignal(body.workspaceId, request.params.workflowId, {
      kind: body.kind,
      idempotencyKey: body.idempotencyKey,
      payload: body.payload,
    } as WorkflowSignalInput);
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  app.post("/v1/dev/smoke/mac-e2e", async (request, reply) => {
    authorizeWeb(request, config);
    if (process.env.NODE_ENV === "production") return reply.code(404).send({ code: "NOT_FOUND" });
    const body = objectBody(request.body);
    for (const name of ["workspaceId", "projectId", "workflowId", "jobId"]) {
      if (typeof body[name] !== "string") return reply.code(400).send({ code: "INVALID_SMOKE_IDS" });
    }
    if (!["E2E_TEST", "ARTIFACT_SIGN", "STEAM_CLEAN_INSTALL"].includes(String(body.jobKind))) {
      return reply.code(400).send({ code: "INVALID_SMOKE_JOB_KIND" });
    }
    await repository.createMacSmokeJob({
      workspaceId: body.workspaceId as string,
      projectId: body.projectId as string,
      workflowId: body.workflowId as string,
      jobId: body.jobId as string,
      jobKind: body.jobKind as "E2E_TEST" | "ARTIFACT_SIGN" | "STEAM_CLEAN_INSTALL",
    });
    return reply.code(201).send({ accepted: true });
  });

  app.post("/v1/dev/smoke/workspace-isolation", async (request, reply) => {
    authorizeWeb(request, config);
    if (process.env.NODE_ENV === "production") return reply.code(404).send({ code: "NOT_FOUND" });
    const result = await repository.verifyWorkspaceIsolation({
      firstWorkspaceId: randomUUID(),
      firstProjectId: randomUUID(),
      secondWorkspaceId: randomUUID(),
      secondProjectId: randomUUID(),
      forbiddenProjectId: randomUUID(),
    });
    const passed = Object.values(result).every(Boolean);
    return reply.code(passed ? 200 : 500).send({ passed, checks: result });
  });

  app.get<{ Params: { workspaceId: string; jobId: string } }>(
    "/v1/dev/smoke/mac-e2e/:workspaceId/:jobId",
    async (request, reply) => {
      authorizeWeb(request, config);
      if (process.env.NODE_ENV === "production") return reply.code(404).send({ code: "NOT_FOUND" });
      const job = await repository.readJobStatus(request.params.workspaceId, request.params.jobId);
      return job ? reply.send({ job }) : reply.code(404).send({ code: "JOB_NOT_FOUND" });
    },
  );

  signal.addEventListener("abort", () => void app.close(), { once: true });
  await app.listen({ host: "0.0.0.0", port: config.port });
  await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  await database.close();
}

function authorizeWeb(request: FastifyRequest, config: CoreConfig): void {
  if (process.env.NODE_ENV !== "production" && !config.webToken) return;
  const actual = String(request.headers["x-deviludo-web-auth"] ?? "");
  if (!secureEqual(actual, config.webToken)) throw unauthorized("Web service authentication failed");
}

function authorizeE2e(request: FastifyRequest, config: CoreConfig): void {
  if (process.env.NODE_ENV === "production") {
    const socket = request.raw.socket as Socket & {
      authorized?: boolean;
      getPeerCertificate?: () => { subjectaltname?: string };
    };
    const identity = socket.getPeerCertificate?.().subjectaltname ?? "";
    if (socket.authorized !== true || !identity.includes("URI:spiffe://deviludo/e2e-node/")) {
      throw unauthorized("E2E node mTLS authentication failed");
    }
    return;
  }
  const actual = String(request.headers["x-deviludo-node-auth"] ?? "");
  if (!config.e2eDevelopmentToken || !secureEqual(actual, config.e2eDevelopmentToken)) {
    throw unauthorized("E2E node authentication failed");
  }
}

function jobIdentity(jobId: string, body: Record<string, unknown>): ClaimedJobIdentity {
  if (typeof body.workspaceId !== "string" || typeof body.leaseToken !== "string") {
    throw new Error("Job workspace and lease identity are required");
  }
  return Object.freeze({ jobId, workspaceId: body.workspaceId, leaseToken: body.leaseToken });
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object");
  return value as Record<string, unknown>;
}

function secureEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function unauthorized(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 401 });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_COOKIE = "deviludo_workspace";

function localProductAccess(request: FastifyRequest, config: CoreConfig): void {
  authorizeWeb(request, config);
  if (process.env.NODE_ENV === "production") {
    throw unauthorized("A verified operator session is required");
  }
}

async function selectedWorkspaceFromRequest(
  request: FastifyRequest,
  repository: CoreRepository,
) {
  const workspaceId = cookieValue(request.headers.cookie, WORKSPACE_COOKIE);
  return workspaceId && UUID.test(workspaceId) ? repository.readWorkspace(workspaceId) : null;
}

async function requireSelectedWorkspace(request: FastifyRequest, repository: CoreRepository) {
  const workspace = await selectedWorkspaceFromRequest(request, repository);
  if (!workspace) throw httpError(409, "WORKSPACE_REQUIRED", "请先选择工作区");
  return workspace;
}

function selectedWorkspaceCookie(workspaceId: string | null): string {
  const attributes = [
    `${WORKSPACE_COOKIE}=${workspaceId ?? ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    workspaceId ? "Max-Age=31536000" : "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production") attributes.push("Secure");
  return attributes.join("; ");
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function requestIdempotencyKey(request: FastifyRequest, prefix: string): string {
  const raw = request.headers["idempotency-key"];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return `${prefix}:${randomUUID()}`;
  if (value.length < 8 || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw httpError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 格式无效");
  }
  return value;
}

async function agentProjectName(
  concept: string,
  repository: CoreRepository,
  agentSecrets: AgentSecretStore,
): Promise<string> {
  const settings = await repository.readAgentSettings();
  if (!settings) throw httpError(424, "AGENT_CONFIG_REQUIRED", "请先配置全局 Agent 连接");
  const apiKey = await agentSecrets.readApiKey(settings.credentialSecretRef);
  if (!apiKey) throw httpError(424, "AGENT_CONFIG_REQUIRED", "无法读取全局 Agent 凭据，请重新保存配置");
  try {
    return await generateProjectName({ concept, settings, apiKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent 项目命名失败";
    throw httpError(424, "AGENT_NAMING_FAILED", message);
  }
}

function httpError(statusCode: number, code: string, message: string): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), { statusCode, code });
}

function publicAgentSettings(
  settings: StoredInstanceAgentSettings | null,
  apiKeyMask = settings?.apiKeyMask ?? null,
) {
  return Object.freeze({
    agentRuntime: settings?.agentRuntime ?? "CLAUDE_CODE",
    baseUrl: settings?.baseUrl ?? "https://api.anthropic.com",
    models: settings?.models ?? null,
    apiKeyConfigured: settings !== null,
    apiKeyMasked: apiKeyMask,
    apiKeyFingerprint: settings?.apiKeyFingerprint ?? null,
    revision: settings?.revision ?? 0,
    updatedAt: settings?.updatedAt ?? null,
  });
}

function specificationFromConcept(name: string, concept: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    title: name,
    vision: concept,
    playerExperience: "让玩家在清晰反馈中快速理解目标，并持续获得可验证的成长与挑战。",
    coreLoop: Object.freeze(["进入一局并识别当前目标", "做出关键操作并获得即时反馈", "结算进度并解锁下一轮变化"]),
    targetPlatforms: Object.freeze(["Linux", "Windows", "macOS"]),
    acceptanceCriteria: Object.freeze([
      "新玩家无需外部说明即可完成第一局",
      "核心循环可在自动化测试中重复执行",
      "三个桌面平台使用同一规则与存档格式",
      "发布前完成签名与 Steam 干净回装验证",
    ]),
    revisionNotes: Object.freeze([]),
  });
}

function refineSpecification(
  current: Readonly<Record<string, unknown>>,
  note: string,
): Readonly<Record<string, unknown>> {
  const previous = Array.isArray(current.revisionNotes)
    ? current.revisionNotes.filter(value => typeof value === "string")
    : [];
  return Object.freeze({
    ...current,
    revisionNotes: Object.freeze([...previous, note].slice(-12)),
  });
}
