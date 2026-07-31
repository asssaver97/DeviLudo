import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { readFileSync } from "node:fs";
import Fastify, { type FastifyRequest } from "fastify";
import type { ProductConversation, ProductProjectDetail, UserRecord, WorkspaceSummary } from "@/lib/product/contracts";
import {
  assertPoolOperatingSystem,
  isServerPoolKind,
  type ServerNodeState,
  type ServerOperatingSystem,
  type ServerPoolKind,
} from "@/lib/runtime/server-pools";
import {
  createAgentSecretStore,
  isMaskedApiKey,
  parseAgentSettingsInput,
  type AgentSecretStore,
} from "./agent-settings";
import { detectAgentRuntimes } from "./agent-runtime-detection";
import type { CoreConfig } from "./config";
import { AccessResolver, type AccessPrincipal } from "./access";
import {
  assertE2eCompletion,
  parseCompletion,
  type ClaimedJobIdentity,
  type WorkflowSignalInput,
} from "./contracts";
import type { Database } from "./database";
import { CORE_MODULES } from "./modules";
import { CoreObjectStore } from "./object-store";
import { generateProjectName } from "./project-naming";
import {
  analyzeImportedProject,
  inspectProjectZip,
  type ImportedSourceSnapshot,
} from "./project-import";
import {
  generateProductConversationReply,
  streamProductConversationReply,
  type ConversationAgentProjectContext,
  type ProductConversationAgentReply,
} from "./product-conversation";
import type { CoreRepository, StoredInstanceAgentSettings } from "./repository";
import { HttpSigningGrantBroker, type SigningGrantBroker } from "./signing-grants";
import { E2ePkiIssuer } from "./e2e-pki";
import { E2E_INFRASTRUCTURE_DOMAINS } from "@/lib/runtime/e2e-failure";
import { createInitialProjectDocument, parseProjectDocumentContent } from "@/lib/product/project-document";
import { ProjectSourceStore } from "./project-sources";

export async function runApi(
  repository: CoreRepository,
  database: Database,
  config: CoreConfig,
  signal: AbortSignal,
  signingGrants: SigningGrantBroker = new HttpSigningGrantBroker(),
  agentSecrets: AgentSecretStore = createAgentSecretStore(),
): Promise<void> {
  const objectStore = new CoreObjectStore();
  const projectSources = new ProjectSourceStore(config.projectsRoot);
  const pki = new E2ePkiIssuer();
  const access = new AccessResolver(config);
  const app = Fastify({
    logger: true,
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 70_000,
    trustProxy: false,
    ...(config.tlsCertificateFile && config.tlsKeyFile && config.tlsClientCaFile ? {
      https: {
        cert: readFileSync(config.tlsCertificateFile),
        key: readFileSync(config.tlsKeyFile),
        ca: readFileSync(config.tlsClientCaFile),
        requestCert: true,
        rejectUnauthorized: false,
      },
    } : {}),
  });

  app.addContentTypeParser(
    ["application/zip", "application/x-zip-compressed"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.setErrorHandler((error, _request, reply) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    const status = "statusCode" in failure && typeof failure.statusCode === "number" ? failure.statusCode : 400;
    const code = "code" in failure && typeof failure.code === "string" ? failure.code : null;
    void reply.code(status >= 400 && status < 500 ? status : 500).send({
      code: status >= 500 ? "INTERNAL_ERROR" : code ?? "INVALID_REQUEST",
      message: status >= 500 ? "Core request failed" : failure.message,
    });
  });

  app.addHook("preHandler", async request => {
    const path = request.url.split("?", 1)[0];
    if (!path.startsWith("/v1/") || path.startsWith("/v1/e2e/")) return;
    if (path.startsWith("/v1/internal/platform/")) return;
    authorizeWeb(request, config);
    if (path.startsWith("/v1/dev/")) return;
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const principal = await access.resolve(request, mutating);
    authenticatedRequests.set(request, principal);
    if (mutating && request.headers["x-deviludo-origin-verified"] !== "1") {
      throw httpError(403, "ORIGIN_REJECTED", "请求来源校验失败");
    }
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

  app.get<{ Querystring: { limit?: string } }>("/v1/internal/platform/source-events", async (request, reply) => {
    authorizePlatformService(request, config);
    const limit = Number(request.query.limit ?? "100");
    return reply.header("cache-control", "no-store").send({
      events: await repository.listSourceReadyEvents(limit),
    });
  });

  app.post("/v1/internal/platform/source-events/ack", async (request, reply) => {
    authorizePlatformService(request, config);
    const body = objectBody(request.body);
    if (!Array.isArray(body.eventIds) || body.eventIds.some(value => typeof value !== "string")) {
      throw httpError(400, "INVALID_SOURCE_EVENT_ACK", "源码事件确认格式无效");
    }
    return reply.send({ acknowledged: await repository.acknowledgeSourceReadyEvents(body.eventIds as string[]) });
  });

  app.post(
    "/v1/internal/platform/projects/import",
    { bodyLimit: 64 * 1024 * 1024 },
    async (request, reply) => {
      authorizePlatformService(request, config);
      const workspaceId = header(request, "x-deviludo-workspace-id");
      const actorAccountId = header(request, "x-deviludo-actor-account-id");
      const encodedName = header(request, "x-deviludo-project-name");
      const workspaceName = decodeHeader(header(request, "x-deviludo-workspace-name") || "Organization");
      if (!UUID.test(workspaceId) || !UUID.test(actorAccountId) || !Buffer.isBuffer(request.body)) {
        throw httpError(400, "INVALID_PLATFORM_IMPORT", "Platform 项目导入请求无效");
      }
      const displayName = decodeHeader(encodedName || "GitHub project");
      const principal: AccessPrincipal = Object.freeze({
        id: "platform-import",
        user: Object.freeze({ id: actorAccountId, username: "Platform actor", instanceAdmin: false, createdAt: "" }),
        workspace: Object.freeze({ id: workspaceId, name: workspaceName, createdAt: "" }),
        role: "MEMBER",
        csrfHash: null,
        expiresAt: null,
        platformAdminRoles: Object.freeze([]),
      });
      const result = await processProjectImport({
        request,
        principal,
        repository,
        agentSecrets,
        projectSources,
        source: async () => inspectProjectZip({
          bytes: request.body as Buffer,
          sourceKind: "GIT",
          displayName,
        }),
      });
      return reply.code(result.statusCode).send(result.payload);
    },
  );

  app.get<{ Params: { workspaceId: string; projectId: string } }>(
    "/v1/internal/platform/workspaces/:workspaceId/projects/:projectId",
    async (request, reply) => {
      authorizePlatformService(request, config);
      if (!UUID.test(request.params.workspaceId) || !UUID.test(request.params.projectId)) {
        return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      }
      const project = await repository.readProject(request.params.workspaceId, request.params.projectId);
      if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      return reply.header("cache-control", "no-store").send({ project: {
        id: project.id,
        workspaceId: request.params.workspaceId,
        name: project.name,
        workflowState: project.workflowState,
        source: project.source,
      } });
    },
  );

  app.delete<{ Params: { workspaceId: string; projectId: string } }>(
    "/v1/internal/platform/workspaces/:workspaceId/projects/:projectId",
    async (request, reply) => {
      authorizePlatformService(request, config);
      if (!UUID.test(request.params.workspaceId) || !UUID.test(request.params.projectId)) {
        return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      }
      const deleted = await repository.deleteProject(
        request.params.workspaceId,
        request.params.projectId,
        () => Promise.all([
          objectStore.deleteProjectObjects(request.params.workspaceId, request.params.projectId),
          projectSources.deleteProject(request.params.workspaceId, request.params.projectId),
        ]).then(() => undefined),
      );
      return deleted ? reply.code(204).send() : reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    },
  );

  app.get<{ Params: { workspaceId: string; projectId: string; revision: string } }>(
    "/v1/internal/platform/workspaces/:workspaceId/projects/:projectId/source/:revision/archive",
    async (request, reply) => {
      authorizePlatformService(request, config);
      const revision = Number(request.params.revision);
      if (!UUID.test(request.params.workspaceId) || !UUID.test(request.params.projectId)
        || !Number.isSafeInteger(revision) || revision < 1) {
        return reply.code(404).send({ code: "SOURCE_REVISION_NOT_FOUND" });
      }
      const source = await repository.readSourceRevision({
        workspaceId: request.params.workspaceId,
        projectId: request.params.projectId,
        revision,
      });
      if (!source) return reply.code(404).send({ code: "SOURCE_REVISION_NOT_FOUND" });
      const archive = await projectSources.archive(source.relativePath);
      if (archive.digest !== source.digest || archive.fileCount !== source.fileCount || archive.totalBytes !== source.totalBytes) {
        throw httpError(409, "SOURCE_REVISION_CORRUPTED", "源码 revision 与数据库摘要不一致");
      }
      return reply
        .header("content-type", "application/gzip")
        .header("content-disposition", `attachment; filename=source-r${revision}.tar.gz`)
        .header("x-deviludo-source-digest", source.digest)
        .header("x-deviludo-source-files", String(source.fileCount))
        .header("x-deviludo-source-bytes", String(source.totalBytes))
        .send(archive.bytes);
    },
  );

  app.get("/v1/admin/server-pools", async (request, reply) => {
    requireInstanceAdmin(request);
    const [pools, nodes] = await Promise.all([repository.readServerPools(), repository.readServerNodes()]);
    return reply.send({ pools, nodes });
  });

  app.get("/v1/admin/server-nodes", async (request, reply) => {
    requireInstanceAdmin(request);
    return reply.send({ nodes: await repository.readServerNodes() });
  });

  app.get("/v1/session", async (request, reply) => {
    const principal = productAccess(request, config);
    return reply.header("cache-control", "no-store").send({ session: {
      user: publicUser(principal.user),
      authenticated: true,
      authMode: config.accessMode === "standalone" ? "STANDALONE" : "PLATFORM",
      canLogout: config.accessMode === "platform",
      selectedWorkspace: principal.workspace,
    } });
  });

  app.put("/v1/session/workspace", async (request, reply) => {
    const principal = productAccess(request, config);
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    if (body.workspaceId !== principal.workspace.id) {
      throw httpError(409, "WORKSPACE_ASSERTION_CHANGED", "当前工作区由访问模式决定，请刷新后重试");
    }
    return reply.header("cache-control", "no-store").send({ workspace: principal.workspace });
  });

  app.get("/v1/workspaces", async (request, reply) => {
    const principal = productAccess(request, config);
    return reply.header("cache-control", "no-store").send({ workspaces: [principal.workspace] });
  });

  app.get("/v1/settings/agent", async (request, reply) => {
    const principal = productAccess(request, config);
    if (!principal.user.instanceAdmin) throw httpError(403, "INSTANCE_ADMIN_REQUIRED", "需要实例管理员权限");
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
    const principal = productAccess(request, config);
    if (!principal.user.instanceAdmin) throw httpError(403, "INSTANCE_ADMIN_REQUIRED", "需要实例管理员权限");
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
      updatedBy: principal.user.username,
    });
    return reply.header("cache-control", "no-store").send({ settings: publicAgentSettings(saved) });
  });

  app.get("/v1/projects", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    return reply.send({ projects: await repository.listProjects(workspace.id) });
  });

  app.post("/v1/projects", async (request, reply) => {
    const principal = productAccess(request, config);
    const body = objectBody(request.body);
    const concept = typeof body.concept === "string" ? body.concept.trim() : "";
    const suppliedName = typeof body.name === "string" ? body.name.trim() : "";
    if (concept.length < 10 || concept.length > 4_000 || suppliedName.length > 200) {
      return reply.code(400).send({ code: "INVALID_GAME_CONCEPT" });
    }
    const idempotencyKey = requestIdempotencyKey(request, "project");
    const currentWorkspace = await selectedWorkspaceFromRequest(request, repository, principal);
    const prior = await repository.readProjectCreationReceipt(principal.workspace.id, idempotencyKey);
    if (prior) {
      if (prior.operationKind !== "PROJECT" || (currentWorkspace && currentWorkspace.id !== prior.workspaceId)) {
        return reply.code(409).send({ code: "IDEMPOTENCY_KEY_REUSED" });
      }
      const [workspace, project] = await Promise.all([
        repository.readWorkspace(prior.workspaceId),
        repository.readProject(prior.workspaceId, prior.projectId),
      ]);
      if (!workspace || !project) throw new Error("Project creation receipt is incomplete");
      return reply.send({ workspace, project });
    }
    const name = suppliedName || await agentProjectName(concept, repository, agentSecrets);
    const workspace = currentWorkspace ?? Object.freeze({ id: randomUUID(), name, createdAt: "" });
    const projectId = deterministicProjectId(principal.user.id, idempotencyKey);
    const project = await repository.createProject({
      actorUserId: principal.user.id,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      projectId,
      workflowId: randomUUID(),
      idempotencyKey,
      name,
      concept,
      specification: specificationFromConcept(name, concept),
      ...defaultWorkflowConfiguration(),
    });
    const selectedWorkspace = currentWorkspace ?? await repository.readWorkspace(workspace.id);
    if (!selectedWorkspace) throw new Error("Created workspace could not be read");
    return reply
      .code(201)
      .send({ workspace: selectedWorkspace, project });
  });

  app.post<{ Querystring: { name?: string } }>(
    "/v1/projects/import/archive",
    { bodyLimit: 64 * 1024 * 1024 },
    async (request, reply) => {
      const principal = productAccess(request, config);
      if (!Buffer.isBuffer(request.body)) {
        throw httpError(400, "INVALID_PROJECT_ARCHIVE", "请选择 ZIP 项目压缩包或本地项目文件夹");
      }
      const displayName = typeof request.query.name === "string" ? request.query.name.trim() : "本地项目";
      const result = await processProjectImport({
        request,
        principal,
        repository,
        agentSecrets,
        projectSources,
        source: async () => inspectProjectZip({
          bytes: request.body as Buffer,
          sourceKind: "LOCAL_ARCHIVE",
          displayName,
        }),
      });
      return reply
        .code(result.statusCode)
        .send(result.payload);
    },
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    return project ? reply.send({ project }) : reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/artifacts", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    return reply.send({ artifacts: await repository.listProjectArtifacts(workspace.id, project.id) });
  });

  app.post<{ Params: { projectId: string; artifactId: string } }>(
    "/v1/projects/:projectId/artifacts/:artifactId/download",
    async (request, reply) => {
      const principal = productAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository, principal);
      if (!UUID.test(request.params.projectId) || !UUID.test(request.params.artifactId)) {
        return reply.code(404).send({ code: "ARTIFACT_NOT_FOUND" });
      }
      const artifact = await repository.readProjectArtifact(
        workspace.id,
        request.params.projectId,
        request.params.artifactId,
      );
      if (!artifact) return reply.code(404).send({ code: "ARTIFACT_NOT_FOUND" });
      return reply.send(await objectStore.authorizeArtifactDownload(artifact));
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/conversations",
    async (request, reply) => {
      const principal = productAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository, principal);
      const project = await repository.readProject(workspace.id, request.params.projectId);
      if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      return reply.send({
        conversations: await repository.listProjectConversations(workspace.id, project.id),
      });
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { after?: string } }>(
    "/v1/projects/:projectId/agent-progress/stream",
    async (request, reply) => {
      const principal = productAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository, principal);
      if (!UUID.test(request.params.projectId)) {
        return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      }
      const project = await repository.readProject(workspace.id, request.params.projectId);
      if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      const requestedAfter = Number(request.query.after ?? "0");
      let after = Number.isSafeInteger(requestedAfter) && requestedAfter >= 0 ? requestedAfter : 0;
      let closed = false;
      request.raw.once("aborted", () => { closed = true; });
      reply.hijack();
      reply.raw.writeHead(200, {
        "cache-control": "no-store, no-transform",
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-accel-buffering": "no",
      });
      for (let poll = 0; poll < 60 && !closed && !reply.raw.destroyed; poll += 1) {
        const events = await repository.readAgentProgress(workspace.id, project.id, after);
        for (const event of events) {
          after = Math.max(after, event.sequence);
          reply.raw.write(`${JSON.stringify({ type: "progress", event })}\n`);
        }
        if (events.length || poll === 0) {
          reply.raw.write(`${JSON.stringify({ type: "cursor", after })}\n`);
        }
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    },
  );

  app.delete<{ Params: { projectId: string } }>("/v1/projects/:projectId", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    if (principal.role !== "OWNER" && principal.role !== "ADMIN") {
      throw httpError(403, "WORKSPACE_ADMIN_REQUIRED", "只有工作区管理员可以删除项目");
    }
    const deleted = await repository.deleteProject(
      workspace.id,
      request.params.projectId,
      () => Promise.all([
        objectStore.deleteProjectObjects(workspace.id, request.params.projectId),
        projectSources.deleteProject(workspace.id, request.params.projectId),
      ]).then(() => undefined),
    );
    return deleted
      ? reply.code(204).send()
      : reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
  });

  app.put<{ Params: { projectId: string } }>("/v1/projects/:projectId/document", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const body = objectBody(request.body);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
      return reply.code(400).send({ code: "INVALID_PROJECT_DOCUMENT_REVISION" });
    }
    let content;
    try {
      content = parseProjectDocumentContent(body.content);
    } catch (error) {
      return reply.code(400).send({
        code: "INVALID_PROJECT_DOCUMENT",
        message: error instanceof Error ? error.message : "项目说明文档无效",
      });
    }
    const project = await repository.updateProjectDocument({
      actorUserId: principal.user.id,
      workspaceId: workspace.id,
      projectId: request.params.projectId,
      expectedRevision: Number(body.expectedRevision),
      content,
    });
    return project ? reply.send({ project }) : reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
  });

  app.get<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId",
    async (request, reply) => {
      const principal = productAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository, principal);
      if (!UUID.test(request.params.conversationId)) {
        return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      }
      const conversation = await repository.readConversation(workspace.id, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      const project = await repository.readProject(workspace.id, conversation.projectId);
      if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      return reply.send({ conversation });
    },
  );

  app.post("/v1/conversations/messages", async (request, reply) => {
    const principal = productAccess(request, config);
    const command = conversationMessageCommand(request.body);
    const result = await processConversationMessage({ request, principal, repository, agentSecrets, command });
    return reply.code(result.statusCode).send(result.payload);
  });

  app.post("/v1/conversations/messages/stream", async (request, reply) => {
    const principal = productAccess(request, config);
    const command = conversationMessageCommand(request.body);
    const abortController = new AbortController();
    request.raw.once("aborted", () => abortController.abort());
    reply.hijack();
    reply.raw.writeHead(200, {
      "cache-control": "no-store, no-transform",
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-accel-buffering": "no",
    });
    const write = (event: Readonly<Record<string, unknown>>) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`${JSON.stringify(event)}\n`);
    };
    write({ type: "status", phase: "PREPARING" });
    try {
      const result = await processConversationMessage({
        request,
        principal,
        repository,
        agentSecrets,
        command,
        signal: abortController.signal,
        onStage: phase => write({ type: "status", phase }),
        onDelta: delta => write({ type: "delta", delta }),
      });
      const latestMessage = result.payload.conversation.messages.at(-1);
      if (latestMessage?.metadata.projectDocumentUpdated === true) {
        write({ type: "project_document", project: result.payload.project });
      }
      write({ type: "complete", ...result.payload });
    } catch (error) {
      const failure = publicStreamError(error);
      write({ type: "error", ...failure });
    } finally {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  });

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/specification",
    async (request, reply) => {
      const principal = productAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository, principal);
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
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const specificationObject = await objectStore.putSpecification({
      workspaceId: workspace.id,
      projectId: project.id,
      workflowId: project.workflowId,
      specification: project.specification,
    });
    await repository.registerSpecificationArtifact({
      workspaceId: workspace.id,
      projectId: project.id,
      workflowId: project.workflowId,
      object: specificationObject,
    });
    const accepted = await repository.appendSignal(workspace.id, project.workflowId, {
      kind: "SPEC_APPROVED",
      idempotencyKey: `spec-approved:${project.workflowId}`,
      payload: { specificationObject, requestedByAccountId: principal.user.id },
    });
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/retry-agent", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const idempotencyKey = requestIdempotencyKey(request, "agent-retry");
    const failedJob = [...project.jobs]
      .reverse()
      .find(job => job.state === "FAILED");
    if (project.workflowState !== "FAILED" || failedJob?.kind !== "AGENT_GENERATION") {
      if (await repository.workflowSignalExists(workspace.id, project.workflowId, idempotencyKey)) {
        return reply.send({ accepted: false });
      }
      return reply.code(409).send({
        code: "AGENT_RETRY_UNAVAILABLE",
        message: "当前失败阶段不是 Agent 生成，不能从这里重试",
      });
    }
    if (!await repository.readAgentSettings()) {
      return reply.code(424).send({
        code: "AGENT_CONFIG_REQUIRED",
        message: "请先完成全局 Agent 配置，再重新生成",
      });
    }
    const accepted = await repository.appendSignal(workspace.id, project.workflowId, {
      kind: "AGENT_RETRY_REQUESTED",
      idempotencyKey,
      payload: {
        previousJobId: failedJob.id,
        requestedBy: principal.user.username,
        requestedByAccountId: principal.user.id,
      },
    });
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/retry-artifact-build", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const idempotencyKey = requestIdempotencyKey(request, "artifact-build-retry");
    const failedJob = [...project.jobs]
      .reverse()
      .find(job => job.state === "FAILED");
    if (project.workflowState !== "FAILED" || failedJob?.kind !== "ARTIFACT_BUILD") {
      if (await repository.workflowSignalExists(workspace.id, project.workflowId, idempotencyKey)) {
        return reply.send({ accepted: false });
      }
      return reply.code(409).send({
        code: "ARTIFACT_BUILD_RETRY_UNAVAILABLE",
        message: "当前失败阶段不是制品构建，不能从这里重试",
      });
    }
    const accepted = await repository.appendSignal(workspace.id, project.workflowId, {
      kind: "ARTIFACT_BUILD_RETRY_REQUESTED",
      idempotencyKey,
      payload: {
        previousJobId: failedJob.id,
        requestedBy: principal.user.username,
        requestedByAccountId: principal.user.id,
      },
    });
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/retry-e2e", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const idempotencyKey = requestIdempotencyKey(request, "e2e-retry");
    const failedJob = [...project.jobs].reverse().find(job => job.state === "FAILED");
    if (project.workflowState !== "FAILED" || failedJob?.kind !== "E2E_TEST") {
      if (await repository.workflowSignalExists(workspace.id, project.workflowId, idempotencyKey)) {
        return reply.send({ accepted: false });
      }
      return reply.code(409).send({
        code: "E2E_RETRY_UNAVAILABLE",
        message: "当前失败阶段不是跨平台 E2E，不能从这里重试",
      });
    }
    const accepted = await repository.appendSignal(workspace.id, project.workflowId, {
      kind: "E2E_RETRY_REQUESTED",
      idempotencyKey,
      payload: { previousJobId: failedJob.id, requestedBy: principal.user.username, requestedByAccountId: principal.user.id },
    });
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/cancel", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const accepted = await repository.appendSignal(workspace.id, project.workflowId, {
      kind: "CANCEL_REQUESTED",
      idempotencyKey: `cancel:${project.workflowId}`,
      payload: { requestedBy: principal.user.username, requestedByAccountId: principal.user.id },
    });
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  app.post("/v1/admin/server-nodes", async (request, reply) => {
    requireInstanceAdmin(request);
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

  app.post("/v1/admin/e2e-enrollment-tokens", async (request, reply) => {
    const principal = requireInstanceAdmin(request);
    const body = objectBody(request.body);
    if (!isServerPoolKind(body.poolKind) || !body.poolKind.startsWith("E2E_")) {
      return reply.code(400).send({ code: "INVALID_E2E_POOL" });
    }
    const token = randomBytes(32).toString("base64url");
    const created = await repository.createE2eEnrollmentToken({
      tokenHash: digest(token),
      poolKind: body.poolKind as Extract<ServerPoolKind, `E2E_${string}`>,
      createdBy: principal.user.id,
    });
    return reply.code(201).send({ enrollment: { ...created, token } });
  });

  app.post("/v1/e2e/enroll", async (request, reply) => {
    const body = objectBody(request.body);
    const token = typeof body.token === "string" ? body.token : "";
    if (!isServerPoolKind(body.poolKind) || !body.poolKind.startsWith("E2E_")
      || !["linux", "windows", "macos"].includes(String(body.operatingSystem))
      || typeof body.csr !== "string" || typeof body.receiptPublicKey !== "string" || token.length < 32) {
      return reply.code(400).send({ code: "INVALID_E2E_ENROLLMENT" });
    }
    try {
      if (createPublicKey(body.receiptPublicKey).asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
    } catch {
      return reply.code(400).send({ code: "INVALID_E2E_RECEIPT_KEY" });
    }
    const operatingSystem = body.operatingSystem as ServerOperatingSystem;
    assertPoolOperatingSystem(body.poolKind, operatingSystem);
    const nodeId = await repository.reserveE2eEnrollment({
      tokenHash: digest(token),
      poolKind: body.poolKind as Extract<ServerPoolKind, `E2E_${string}`>,
      operatingSystem,
      receiptPublicKey: body.receiptPublicKey,
    });
    const certificate = await pki.issue(nodeId, body.csr);
    await repository.saveE2eCertificate({ nodeId, ...certificate });
    return reply.code(201).send({ nodeId, ...certificate });
  });

  app.post<{ Params: { nodeId: string } }>("/v1/e2e/nodes/:nodeId/renew", async (request, reply) => {
    authorizeE2e(request, config);
    const socket = request.raw.socket as Socket & { getPeerCertificate?: () => { subjectaltname?: string } };
    if (!(socket.getPeerCertificate?.().subjectaltname ?? "").includes(`URI:spiffe://deviludo/e2e-node/${request.params.nodeId}`)) {
      throw unauthorized("E2E node certificate identity mismatch");
    }
    const body = objectBody(request.body);
    if (typeof body.csr !== "string") return reply.code(400).send({ code: "INVALID_CSR" });
    const certificate = await pki.issue(request.params.nodeId, body.csr);
    await repository.saveE2eCertificate({ nodeId: request.params.nodeId, ...certificate });
    return reply.send(certificate);
  });

  app.post<{ Params: { nodeId: string; action: string } }>(
    "/v1/admin/server-nodes/:nodeId/:action",
    async (request, reply) => {
      requireInstanceAdmin(request);
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
    const authenticatedNodeId = authorizeE2e(request, config);
    const body = objectBody(request.body);
    if (typeof body.nodeId !== "string"
      || !isServerPoolKind(body.poolKind)
      || !body.poolKind.startsWith("E2E_")) {
      return reply.code(400).send({ code: "INVALID_E2E_CLAIM" });
    }
    if (authenticatedNodeId && authenticatedNodeId !== body.nodeId) throw unauthorized("E2E node identity mismatch");
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
    const nodeId = authorizeE2e(request, config);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body), nodeId ? `e2e:${nodeId}` : undefined);
    return reply.send({ accepted: await repository.heartbeat(job) });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/complete", async (request, reply) => {
    const nodeId = authorizeE2e(request, config);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body), nodeId ? `e2e:${nodeId}` : undefined);
    const completion = parseCompletion(body);
    assertE2eCompletion(job, completion);
    await objectStore.verifyOutputs(job, completion.executorReceipt.outputObjects);
    return reply.send({ accepted: await repository.complete(job, completion) });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/fail", async (request, reply) => {
    const nodeId = authorizeE2e(request, config);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body), nodeId ? `e2e:${nodeId}` : undefined);
    if (body.classification !== "INFRASTRUCTURE"
      || !E2E_INFRASTRUCTURE_DOMAINS.includes(body.domain as never)
      || typeof body.reason !== "string" || body.reason.trim().length < 1) {
      return reply.code(400).send({ code: "INVALID_E2E_FAILURE_CLASSIFICATION" });
    }
    const reason = `E2E_INFRASTRUCTURE/${body.domain}: ${body.reason.trim()}`;
    return reply.send({ accepted: await repository.fail(job, reason) });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/signing-grant", async (request, reply) => {
    const nodeId = authorizeE2e(request, config);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body), nodeId ? `e2e:${nodeId}` : undefined);
    if (job.jobKind !== "ARTIFACT_SIGN") return reply.code(403).send({ code: "SIGNING_GRANT_FORBIDDEN" });
    if (typeof body.beforeReimageProof !== "string" || body.beforeReimageProof.length < 16) {
      return reply.code(409).send({ code: "REIMAGE_PROOF_REQUIRED" });
    }
    const operationId = await repository.beginOperation(job, "PLATFORM_SIGN");
    const grant = await signingGrants.issue(job);
    return reply.send({ ...grant, operationId });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/objects", async (request, reply) => {
    const nodeId = authorizeE2e(request, config);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body), nodeId ? `e2e:${nodeId}` : undefined);
    return reply.send({ inputs: await objectStore.authorizeInputs(job) });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/outputs", async (request, reply) => {
    const nodeId = authorizeE2e(request, config);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body), nodeId ? `e2e:${nodeId}` : undefined);
    return reply.send(await objectStore.authorizeOutput(job, {
      kind: String(body.kind ?? ""),
      sha256: String(body.sha256 ?? ""),
      sizeBytes: Number(body.sizeBytes),
      targetPlatform: job.targetOperatingSystem,
    }));
  });

  app.post<{ Params: { workflowId: string } }>("/v1/workflows/:workflowId/signals", async (request, reply) => {
    const principal = productAccess(request, config);
    const body = objectBody(request.body);
    if (typeof body.workspaceId !== "string" || !UUID.test(body.workspaceId)
      || !UUID.test(request.params.workflowId)
      || !["SPEC_APPROVED", "CANCEL_REQUESTED", "EXTERNAL_APPROVAL"].includes(String(body.kind))
      || typeof body.idempotencyKey !== "string"
      || !body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      return reply.code(400).send({ code: "INVALID_WORKFLOW_SIGNAL" });
    }
    if (body.workspaceId !== principal.workspace.id) return reply.code(404).send({ code: "WORKFLOW_NOT_FOUND" });
    const workspace = principal.workspace;
    const projectSummary = (await repository.listProjects(workspace.id))
      .find(project => project.workflowId === request.params.workflowId);
    const project = projectSummary ? await repository.readProject(workspace.id, projectSummary.id) : null;
    if (!project) return reply.code(404).send({ code: "WORKFLOW_NOT_FOUND" });
    const accepted = await repository.appendSignal(body.workspaceId, request.params.workflowId, {
      kind: body.kind,
      idempotencyKey: body.idempotencyKey,
      payload: { ...(body.payload as Record<string, unknown>), requestedByAccountId: principal.user.id },
    } as WorkflowSignalInput);
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  signal.addEventListener("abort", () => void app.close(), { once: true });
  await app.listen({ host: "0.0.0.0", port: config.port });
  await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  await database.close();
}

type ConversationMessageCommand = Readonly<{
  content: string;
  conversationId: string | null;
  projectId: string | null;
  projectIdSupplied: boolean;
}>;

type ConversationMessageResult = Readonly<{
  statusCode: 200 | 201;
  setWorkspaceCookie: boolean;
  payload: Readonly<{
    workspace: WorkspaceSummary;
    project: ProductProjectDetail;
    conversation: ProductConversation;
  }>;
}>;

function conversationMessageCommand(value: unknown): ConversationMessageCommand {
  const body = objectBody(value);
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const conversationId = body.conversationId === undefined ? null : body.conversationId;
  const projectId = body.projectId === undefined ? null : body.projectId;
  if (content.length < 2 || content.length > 4_000
    || (conversationId !== null && (typeof conversationId !== "string" || !UUID.test(conversationId)))
    || (projectId !== null && (typeof projectId !== "string" || !UUID.test(projectId)))) {
    throw httpError(400, "INVALID_CONVERSATION_MESSAGE", "对话消息格式无效");
  }
  return Object.freeze({
    content,
    conversationId: conversationId as string | null,
    projectId: projectId as string | null,
    projectIdSupplied: body.projectId !== undefined,
  });
}

async function processConversationMessage(input: Readonly<{
  request: FastifyRequest;
  principal: AccessPrincipal;
  repository: CoreRepository;
  agentSecrets: AgentSecretStore;
  command: ConversationMessageCommand;
  signal?: AbortSignal;
  onStage?: (phase: "NAMING" | "RESPONDING" | "SAVING") => void;
  onDelta?: (delta: string) => void;
}>): Promise<ConversationMessageResult> {
  const { request, principal, repository, agentSecrets, command } = input;
  let workspace = await selectedWorkspaceFromRequest(request, repository, principal);
  let projectId = command.projectId;
  let existingConversation: ProductConversation | null = null;
  if (command.conversationId) {
    workspace ??= await requireSelectedWorkspace(request, repository, principal);
    existingConversation = await repository.readConversation(workspace.id, command.conversationId);
    if (!existingConversation) throw httpError(404, "CONVERSATION_NOT_FOUND", "对话已不存在");
    if (command.projectIdSupplied && projectId !== existingConversation.projectId) {
      throw httpError(409, "CONVERSATION_PROJECT_LOCKED", "对话不能切换到其他项目");
    }
    projectId = existingConversation.projectId;
  } else if (projectId && (!workspace || !(await repository.readProject(workspace.id, projectId)))) {
    throw httpError(404, "PROJECT_NOT_FOUND", "项目已不存在");
  }

  const created = command.conversationId === null;
  if (created && !projectId) {
    const idempotencyKey = requestIdempotencyKey(request, "conversation");
    const prior = await repository.readProjectCreationReceipt(principal.workspace.id, idempotencyKey);
    if (prior) {
      if (prior.operationKind !== "CONVERSATION" || !prior.conversationId
        || (workspace && workspace.id !== prior.workspaceId)) {
        throw httpError(409, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他操作");
      }
      const [priorWorkspace, project, conversation] = await Promise.all([
        repository.readWorkspace(prior.workspaceId),
        repository.readProject(prior.workspaceId, prior.projectId),
        repository.readConversation(prior.workspaceId, prior.conversationId),
      ]);
      if (!priorWorkspace || !project || !conversation) throw new Error("Conversation creation receipt is incomplete");
      return Object.freeze({
        statusCode: 200,
        setWorkspaceCookie: true,
        payload: Object.freeze({ workspace: priorWorkspace, project, conversation }),
      });
    }
    input.onStage?.("NAMING");
    const name = await agentProjectName(command.content, repository, agentSecrets);
    const specification = specificationFromConcept(name, command.content);
    input.onStage?.("RESPONDING");
    const agentReply = await conversationAgentReply({
      userContent: command.content,
      history: Object.freeze([]),
      project: Object.freeze({
        name,
        concept: command.content,
        workflowState: "DRAFT",
        specification,
        document: createInitialProjectDocument(name, command.content, specification),
      }),
      allowDraftMutation: true,
    }, repository, agentSecrets, { signal: input.signal, onDelta: input.onDelta });
    input.onStage?.("SAVING");
    const targetWorkspace = workspace ?? Object.freeze({ id: randomUUID(), name, createdAt: "" });
    const projectId = deterministicProjectId(principal.user.id, idempotencyKey);
    const createdBundle = await repository.createProjectConversation({
      actorUserId: principal.user.id,
      workspaceId: targetWorkspace.id,
      workspaceName: targetWorkspace.name,
      projectId,
      workflowId: randomUUID(),
      conversationId: randomUUID(),
      idempotencyKey,
      name,
      concept: command.content,
      specification,
      document: agentReply.projectDocument ?? createInitialProjectDocument(name, command.content, specification),
      userContent: command.content,
      assistantContent: agentReply.content,
      assistantMetadata: conversationAgentMetadata(agentReply),
      ...defaultWorkflowConfiguration(),
    });
    const selectedWorkspace = workspace ?? await repository.readWorkspace(targetWorkspace.id);
    if (!selectedWorkspace) throw new Error("Created workspace could not be read");
    return Object.freeze({
      statusCode: 201,
      setWorkspaceCookie: true,
      payload: Object.freeze({ workspace: selectedWorkspace, ...createdBundle }),
    });
  }

  workspace ??= await requireSelectedWorkspace(request, repository, principal);
  if (!projectId) throw new Error("Conversation project is required");
  const project = await repository.readProject(workspace.id, projectId);
  if (!project) throw httpError(404, "PROJECT_NOT_FOUND", "项目已不存在");
  if (project.workflowState === "AGENT_RUNNING") {
    input.onStage?.("SAVING");
    const conversation = await repository.appendAgentGuidance({
      workspaceId: workspace.id,
      projectId,
      conversationId: command.conversationId ?? randomUUID(),
      content: command.content,
    });
    return Object.freeze({
      statusCode: created ? 201 : 200,
      setWorkspaceCookie: false,
      payload: Object.freeze({ workspace, project, conversation }),
    });
  }
  input.onStage?.("RESPONDING");
  const agentReply = await conversationAgentReply({
    userContent: command.content,
    history: existingConversation?.messages ?? Object.freeze([]),
    project: conversationProjectContext(project),
    allowDraftMutation: project.workflowState === "DRAFT",
  }, repository, agentSecrets, { signal: input.signal, onDelta: input.onDelta });
  input.onStage?.("SAVING");
  const conversation = await repository.appendConversationTurn({
    workspaceId: workspace.id,
    conversationId: command.conversationId ?? randomUUID(),
    projectId,
    userContent: command.content,
    expectedWorkflowState: project.workflowState,
    assistantContent: agentReply.content,
    assistantApplyToDraft: agentReply.applyToDraft,
    assistantProjectDocument: agentReply.projectDocument,
    assistantMetadata: conversationAgentMetadata(agentReply),
  });
  const updatedProject = await repository.readProject(workspace.id, projectId);
  if (!updatedProject) throw httpError(404, "PROJECT_NOT_FOUND", "项目已不存在");
  return Object.freeze({
    statusCode: created ? 201 : 200,
    setWorkspaceCookie: false,
    payload: Object.freeze({ workspace, project: updatedProject, conversation }),
  });
}

function publicStreamError(error: unknown): Readonly<{ code: string; message: string }> {
  const failure = error instanceof Error ? error : new Error(String(error));
  const status = "statusCode" in failure && typeof failure.statusCode === "number" ? failure.statusCode : 500;
  const code = "code" in failure && typeof failure.code === "string" ? failure.code : null;
  return Object.freeze({
    code: status >= 500 ? "INTERNAL_ERROR" : code ?? "INVALID_REQUEST",
    message: status >= 500 ? "Core request failed" : failure.message,
  });
}

function authorizeWeb(request: FastifyRequest, config: CoreConfig): void {
  if (process.env.NODE_ENV !== "production" && !config.webToken) return;
  const actual = String(request.headers["x-deviludo-web-auth"] ?? "");
  if (!secureEqual(actual, config.webToken)) throw unauthorized("Web service authentication failed");
}

function authorizePlatformService(request: FastifyRequest, config: CoreConfig): void {
  if (config.accessMode !== "platform" || !config.platformInternalToken) {
    throw httpError(404, "NOT_FOUND", "接口不存在");
  }
  const authorization = String(request.headers.authorization ?? "");
  if (!authorization.startsWith("Bearer ") || !secureEqual(authorization.slice(7), config.platformInternalToken)) {
    throw unauthorized("Platform service authentication failed");
  }
}

function authorizeE2e(request: FastifyRequest, config: CoreConfig): string | null {
  if (process.env.NODE_ENV === "production") {
    const socket = request.raw.socket as Socket & {
      authorized?: boolean;
      getPeerCertificate?: () => { subjectaltname?: string };
    };
    const identity = socket.getPeerCertificate?.().subjectaltname ?? "";
    const match = identity.match(/(?:^|,\s*)URI:spiffe:\/\/deviludo\/e2e-node\/([0-9a-f-]{36})(?:,|$)/i);
    if (socket.authorized !== true || !match) {
      throw unauthorized("E2E node mTLS authentication failed");
    }
    return match[1];
  }
  const actual = String(request.headers["x-deviludo-node-auth"] ?? "");
  if (!config.e2eDevelopmentToken || !secureEqual(actual, config.e2eDevelopmentToken)) {
    throw unauthorized("E2E node authentication failed");
  }
  return null;
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

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === "string" ? value.trim() : "";
}

function decodeHeader(value: string): string {
  try { return decodeURIComponent(value).slice(0, 200); } catch { throw httpError(400, "INVALID_PLATFORM_IMPORT", "Platform 项目导入元数据无效"); }
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
const authenticatedRequests = new WeakMap<FastifyRequest, AccessPrincipal>();

function productAccess(request: FastifyRequest, config: CoreConfig): AccessPrincipal {
  authorizeWeb(request, config);
  const session = authenticatedRequests.get(request);
  if (!session) throw unauthorized("请先登录");
  return session;
}

async function selectedWorkspaceFromRequest(
  _request: FastifyRequest,
  _repository: CoreRepository,
  session: AccessPrincipal,
) {
  return session.workspace;
}

async function requireSelectedWorkspace(
  request: FastifyRequest,
  repository: CoreRepository,
  session: AccessPrincipal,
) {
  return selectedWorkspaceFromRequest(request, repository, session);
}

function requireInstanceAdmin(request: FastifyRequest): AccessPrincipal {
  const principal = authenticatedRequests.get(request);
  if (!principal) throw unauthorized("请先登录");
  if (!principal.user.instanceAdmin) throw httpError(403, "INSTANCE_ADMIN_REQUIRED", "需要实例管理员权限");
  return principal;
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

async function processProjectImport(input: Readonly<{
  request: FastifyRequest;
  principal: AccessPrincipal;
  repository: CoreRepository;
  agentSecrets: AgentSecretStore;
  projectSources: ProjectSourceStore;
  source: () => Promise<ImportedSourceSnapshot>;
}>): Promise<Readonly<{
  statusCode: 200 | 201;
  workspace: WorkspaceSummary;
  payload: Readonly<{
    workspace: WorkspaceSummary;
    project: ProductProjectDetail;
    conversation: ProductConversation | null;
  }>;
}>> {
  const idempotencyKey = requestIdempotencyKey(input.request, "project-import");
  const currentWorkspace = await selectedWorkspaceFromRequest(input.request, input.repository, input.principal);
  const prior = await input.repository.readProjectCreationReceipt(input.principal.workspace.id, idempotencyKey);
  if (prior) {
    if (prior.operationKind !== "PROJECT" || (currentWorkspace && currentWorkspace.id !== prior.workspaceId)) {
      throw httpError(409, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他操作");
    }
    const [workspace, project, conversations] = await Promise.all([
      input.repository.readWorkspace(prior.workspaceId),
      input.repository.readProject(prior.workspaceId, prior.projectId),
      input.repository.listProjectConversations(prior.workspaceId, prior.projectId),
    ]);
    if (!workspace || !project) throw new Error("Project import receipt is incomplete");
    const conversation = conversations[0]
      ? await input.repository.readConversation(prior.workspaceId, conversations[0].id)
      : null;
    return Object.freeze({
      statusCode: 200,
      workspace,
      payload: Object.freeze({ workspace, project, conversation }),
    });
  }

  let source: ImportedSourceSnapshot;
  try {
    source = await input.source();
  } catch (error) {
    const message = error instanceof Error ? error.message : "项目源码读取失败";
    throw httpError(422, "PROJECT_IMPORT_SOURCE_FAILED", message);
  }
  const settings = await input.repository.readAgentSettings();
  if (!settings) throw httpError(424, "AGENT_CONFIG_REQUIRED", "请先配置全局 Agent 连接");
  const apiKey = await input.agentSecrets.readApiKey(settings.credentialSecretRef);
  if (!apiKey) throw httpError(424, "AGENT_CONFIG_REQUIRED", "无法读取全局 Agent 凭据，请重新保存配置");
  let analysis;
  try {
    analysis = await analyzeImportedProject({ source, settings, apiKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : "项目分析 Agent 调用失败";
    throw httpError(424, "AGENT_IMPORT_FAILED", message);
  }

  const targetWorkspace = currentWorkspace ?? Object.freeze({ id: randomUUID(), name: analysis.name, createdAt: "" });
  const projectId = deterministicProjectId(input.principal.user.id, idempotencyKey);
  const workflowId = randomUUID();
  const stored = await input.projectSources.publishFiles({
    workspaceId: targetWorkspace.id,
    projectId,
    revision: 1,
    files: source.files,
  });
  let bundle;
  try {
    bundle = await input.repository.createImportedProject({
      actorUserId: input.principal.user.id,
      workspaceId: targetWorkspace.id,
      workspaceName: targetWorkspace.name,
      projectId,
      workflowId,
      conversationId: randomUUID(),
      idempotencyKey,
      name: analysis.name,
      concept: analysis.concept,
      specification: analysis.specification,
      document: analysis.document,
      userContent: source.repositoryUrl
        ? `导入并分析 Git 项目：${source.repositoryUrl}`
        : `导入并分析本地项目：${source.displayName}`,
      assistantContent: analysis.assistantContent,
      assistantMetadata: {
        agentRuntime: analysis.runtime,
        model: analysis.model,
        settingsRevision: analysis.settingsRevision,
      },
      source: {
        kind: source.sourceKind,
        repositoryUrl: source.repositoryUrl,
        displayName: source.displayName,
        fileCount: source.fileCount,
        totalBytes: source.totalBytes,
        revision: stored.revision,
        relativePath: stored.relativePath,
        sha256: stored.digest,
      },
      ...defaultWorkflowConfiguration(),
    });
  } catch (error) {
    await input.projectSources.deleteProject(targetWorkspace.id, projectId).catch(() => undefined);
    throw error;
  }
  const workspace = currentWorkspace ?? await input.repository.readWorkspace(targetWorkspace.id);
  if (!workspace) throw new Error("Imported workspace could not be read");
  return Object.freeze({
    statusCode: 201,
    workspace,
    payload: Object.freeze({ workspace, ...bundle }),
  });
}

async function conversationAgentReply(
  input: Readonly<{
    userContent: string;
    history: readonly Pick<ProductConversation["messages"][number], "role" | "content">[];
    project: ConversationAgentProjectContext;
    allowDraftMutation: boolean;
  }>,
  repository: CoreRepository,
  agentSecrets: AgentSecretStore,
  stream?: Readonly<{
    signal?: AbortSignal;
    onDelta?: (delta: string) => void;
  }>,
): Promise<ProductConversationAgentReply> {
  const settings = await repository.readAgentSettings();
  if (!settings) throw httpError(424, "AGENT_CONFIG_REQUIRED", "请先配置全局 Agent 连接");
  const apiKey = await agentSecrets.readApiKey(settings.credentialSecretRef);
  if (!apiKey) throw httpError(424, "AGENT_CONFIG_REQUIRED", "无法读取全局 Agent 凭据，请重新保存配置");
  try {
    if (stream?.onDelta) {
      return await streamProductConversationReply({ ...input, settings, apiKey, signal: stream.signal }, stream.onDelta);
    }
    return await generateProductConversationReply({ ...input, settings, apiKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : "设计 Agent 调用失败";
    throw httpError(424, "AGENT_CONVERSATION_FAILED", message);
  }
}

function conversationProjectContext(project: ProductProjectDetail): ConversationAgentProjectContext {
  return Object.freeze({
    name: project.name,
    concept: project.concept,
    workflowState: project.workflowState,
    specification: project.specification,
    document: project.document.content,
  });
}

function conversationAgentMetadata(reply: ProductConversationAgentReply): Readonly<Record<string, unknown>> {
  return Object.freeze({
    source: "AI_AGENT",
    agentRuntime: reply.runtime,
    model: reply.model,
    settingsRevision: reply.settingsRevision,
    readyForDevelopment: reply.readyForDevelopment,
    options: reply.options,
  });
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

function publicUser(user: UserRecord) {
  return Object.freeze({
    id: user.id,
    username: user.username,
    instanceAdmin: user.instanceAdmin,
    createdAt: user.createdAt,
  });
}

function deterministicProjectId(userId: string, idempotencyKey: string): string {
  const bytes = createHash("sha256").update("deviludo-project\0").update(userId).update("\0").update(idempotencyKey).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function defaultWorkflowConfiguration(): Readonly<{
  profile: "VALIDATE" | "RELEASE";
  targetPlatforms: readonly ServerOperatingSystem[];
}> {
  return process.env.DEVILUDO_DEFAULT_WORKFLOW_PROFILE === "RELEASE"
    ? Object.freeze({ profile: "RELEASE", targetPlatforms: Object.freeze<ServerOperatingSystem[]>(["linux", "windows", "macos"]) })
    : Object.freeze({ profile: "VALIDATE", targetPlatforms: Object.freeze<ServerOperatingSystem[]>(["macos"]) });
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
