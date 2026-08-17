import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { readFileSync } from "node:fs";
import Fastify, { type FastifyRequest } from "fastify";
import type { ProductConversation, ProductProjectDetail, ProjectAgentRole, WorkspaceSummary } from "@/lib/product/contracts";
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
import { localAccessContext, type LocalAccessContext } from "./access";
import {
  assertE2eCompletion,
  deliveryStages,
  isRerunnableStage,
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
  decodeProjectSourceStream,
  inspectProjectFiles,
  normalizeGitBranchName,
  normalizeGitHubRepositoryUrl,
  type ImportedSourceSnapshot,
  type SourceFile,
} from "./project-import";
import {
  generateProductConversationGroupReply,
  isDevelopmentApprovalRequest,
  streamProductConversationGroupReply,
  type ConversationAgentProjectContext,
  type ProductConversationGroupReply,
} from "./product-conversation";
import {
  generateE2ePlayerDecision,
  parsePlayerPolicyRequest,
  playerPolicyIdempotencyInput,
  verifyE2ePlayerVision,
} from "./e2e-player-policy";
import type {
  CoreRepository,
  PendingProjectImportAnalysis,
  StoredInstanceAgentSettings,
} from "./repository";
import { E2ePkiIssuer } from "./e2e-pki";
import { E2E_INFRASTRUCTURE_DOMAINS } from "@/lib/runtime/e2e-failure";
import { createInitialProjectDocument, parseProjectDocumentContent } from "@/lib/product/project-document";
import { ProjectSourceStore } from "./project-sources";
import {
  createSteamSecretStore,
  validateSteamBuildToken,
  type SteamSecretStore,
} from "./steam-settings";
import { UsageTelemetry } from "./usage-telemetry";

export async function runApi(
  repository: CoreRepository,
  database: Database,
  config: CoreConfig,
  signal: AbortSignal,
  agentSecrets: AgentSecretStore = createAgentSecretStore(),
  steamSecrets: SteamSecretStore = createSteamSecretStore(),
): Promise<void> {
  const objectStore = new CoreObjectStore();
  const projectSources = new ProjectSourceStore(config.projectsRoot);
  const pki = new E2ePkiIssuer();
  const telemetry = new UsageTelemetry(config);
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

  app.setErrorHandler((error, request, reply) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    const status = "statusCode" in failure && typeof failure.statusCode === "number" ? failure.statusCode : 400;
    const code = "code" in failure && typeof failure.code === "string" ? failure.code : null;
    if (status >= 500) request.log.error({ err: failure, failureCode: code ?? "INTERNAL_ERROR" }, "Core request failed");
    void reply.code(status >= 400 && status < 500 ? status : 500).send({
      code: status >= 500 ? "INTERNAL_ERROR" : code ?? "INVALID_REQUEST",
      message: status >= 500 ? "Core request failed" : failure.message,
    });
  });

  app.addHook("preHandler", async request => {
    const path = request.url.split("?", 1)[0];
    if (!path.startsWith("/v1/") || path.startsWith("/v1/e2e/")) return;
    authorizeWeb(request, config);
    if (path.startsWith("/v1/dev/")) return;
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (mutating && request.headers["x-deviludo-origin-verified"] !== "1") {
      throw httpError(403, "ORIGIN_REJECTED", "请求来源校验失败");
    }
    telemetry.recordActivity();
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
      schemaVersion: "deviludo.instance-readiness",
      status: ready ? "ready" : "not_ready",
      pools: Object.fromEntries(pools.map(pool => [pool.kind, pool.readiness])),
      requiredPools: config.requiredReadyPools,
    });
  });

  app.get("/v1/runtime/server-pools", async (request, reply) => {
    requireLocalOperator();
    const [pools, nodes] = await Promise.all([repository.readServerPools(), repository.readServerNodes()]);
    return reply.send({ pools, nodes });
  });

  app.get("/v1/runtime/server-nodes", async (request, reply) => {
    requireLocalOperator();
    return reply.send({ nodes: await repository.readServerNodes() });
  });

  app.get("/v1/instance", async (request, reply) => {
    const access = productAccess(request, config);
    return reply.header("cache-control", "no-store").send({ instance: {
      mode: "SELF_HOSTED",
      workspace: access.workspace,
    } });
  });

  app.get("/v1/settings/telemetry", async (request, reply) => {
    productAccess(request, config);
    return reply.header("cache-control", "no-store").send({ settings: await telemetry.settings() });
  });

  app.put("/v1/settings/telemetry", async (request, reply) => {
    productAccess(request, config);
    const body = objectBody(request.body);
    if (typeof body.enabled !== "boolean") throw httpError(400, "INVALID_TELEMETRY_SETTINGS", "遥测开关无效");
    return reply.header("cache-control", "no-store").send({ settings: await telemetry.setEnabled(body.enabled) });
  });

  app.get("/v1/settings/agent", async (request, reply) => {
    productAccess(request, config);
    const [settings, runtimes] = await Promise.all([
      repository.readAgentSettings(),
      detectAgentRuntimes(),
    ]);
    const apiKeyMask = settings?.agentRuntime === "CLAUDE_CODE"
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
    const input = parseAgentSettingsInput(request.body);
    const current = await repository.readAgentSettings();
    const currentMask = current?.agentRuntime === "CLAUDE_CODE"
      ? current.apiKeyMask
        ?? await agentSecrets.readApiKeyMask(current.credentialSecretRef)
      : null;
    if (input.apiKey && isMaskedApiKey(input.apiKey) && input.apiKey !== currentMask) {
      throw new Error("API Key 掩码与已保存凭据不匹配");
    }
    const replacementApiKey = input.apiKey && input.apiKey !== currentMask ? input.apiKey : null;
    if (input.agentRuntime === "CLAUDE_CODE" && !replacementApiKey && current?.agentRuntime !== "CLAUDE_CODE") {
      throw new Error("切换到 Claude Code 时必须提供 Provider API Key");
    }
    const credential = input.agentRuntime === "CODEX_CLI"
      ? await agentSecrets.writeApiKey(readCodexOfficialLogin())
      : replacementApiKey
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
      roleModels: input.roleModels,
      imageModel: input.imageModel,
      credentialSecretRef: credential.secretRef,
      apiKeyMask: credential.mask,
      apiKeyFingerprint: credential.fingerprint,
      credentialVersion: credential.version,
      updatedBy: principal.actorLabel,
    });
    return reply.header("cache-control", "no-store").send({
      settings: publicAgentSettings(saved),
    });
  });

  app.get("/v1/settings/steam", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const settings = await repository.readWorkspaceSteamSettings(workspace.id);
    return reply.header("cache-control", "no-store").send({
      settings: settings ? {
        builderUsername: settings.builderUsername,
        buildToken: settings.credentialMask,
        revision: settings.revision,
        updatedAt: settings.updatedAt,
      } : null,
      editable: true,
    });
  });

  app.put("/v1/settings/steam", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const body = objectBody(request.body);
    const builderUsername = typeof body.builderUsername === "string" ? body.builderUsername.trim() : "";
    const buildToken = typeof body.buildToken === "string" ? body.buildToken : "";
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(builderUsername)) {
      return reply.code(400).send({ code: "INVALID_STEAM_BUILDER_USERNAME" });
    }
    const current = await repository.readWorkspaceSteamSettings(workspace.id);
    const keepCredential = current !== null && buildToken === current.credentialMask;
    if (!keepCredential && !buildToken) {
      return reply.code(400).send({ code: "STEAM_BUILD_TOKEN_REQUIRED" });
    }
    const credential = keepCredential ? {
      secretRef: current.credentialSecretRef,
      mask: current.credentialMask,
      fingerprint: current.credentialFingerprint,
      version: current.credentialVersion,
    } : await steamSecrets.writeBuildToken(workspace.id, validateSteamBuildToken(buildToken));
    const saved = await repository.saveWorkspaceSteamSettings({
      workspaceId: workspace.id,
      builderUsername,
      credentialSecretRef: credential.secretRef,
      credentialMask: credential.mask,
      credentialFingerprint: credential.fingerprint,
      credentialVersion: credential.version,
      updatedByActorId: principal.actorId,
    });
    return reply.header("cache-control", "no-store").send({ settings: {
      builderUsername: saved.builderUsername,
      buildToken: saved.credentialMask,
      revision: saved.revision,
      updatedAt: saved.updatedAt,
    } });
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
    const projectId = deterministicProjectId(principal.actorId, idempotencyKey);
    const project = await repository.createProject({
      actorId: principal.actorId,
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

  app.post<{ Body: { name?: unknown; bindingId?: unknown; gitBranch?: unknown } }>(
    "/v1/projects/bind/local-directory",
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const principal = productAccess(request, config);
      if (!config.localDirectoryBindings) {
        throw httpError(409, "LOCAL_DIRECTORY_BINDING_UNAVAILABLE", "本地目录关联仅在本机部署中可用");
      }
      const body = objectBody(request.body);
      if (typeof body.bindingId !== "string" || !UUID.test(body.bindingId)) {
        throw httpError(400, "INVALID_DIRECTORY_BINDING", "本地项目目录绑定无效");
      }
      const displayName = typeof body.name === "string" ? body.name.trim() : "本地项目";
      const gitBranch = typeof body.gitBranch === "string" ? body.gitBranch : "";
      const result = await queueBoundProjectImport({
        request,
        principal,
        repository,
        name: displayName,
        source: {
          sourceKind: "LOCAL_DIRECTORY",
          localDirectoryBindingId: body.bindingId as string,
          gitBranch,
          displayName,
          repositoryUrl: null,
        },
      });
      return reply.code(result.statusCode).send(result.payload);
    },
  );

  app.post<{ Body: { name?: unknown; repositoryUrl?: unknown; bindingId?: unknown; gitBranch?: unknown } }>(
    "/v1/projects/bind/github",
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const principal = productAccess(request, config);
      if (!config.localDirectoryBindings) {
        throw httpError(409, "LOCAL_DIRECTORY_BINDING_UNAVAILABLE", "GitHub 本地工作目录关联仅在本机部署中可用");
      }
      const body = objectBody(request.body);
      if (typeof body.bindingId !== "string" || !UUID.test(body.bindingId)) {
        throw httpError(400, "INVALID_DIRECTORY_BINDING", "GitHub 项目缺少本地工作目录绑定");
      }
      const repositoryUrl = typeof body.repositoryUrl === "string" ? body.repositoryUrl : "";
      const displayName = typeof body.name === "string" ? body.name.trim() : "";
      const gitBranch = typeof body.gitBranch === "string" ? body.gitBranch : "";
      const github = normalizeGitHubRepositoryUrl(repositoryUrl);
      const result = await queueBoundProjectImport({
        request,
        principal,
        repository,
        name: displayName || github.displayName,
        source: {
          sourceKind: "GIT",
          repositoryUrl: github.canonicalUrl,
          localDirectoryBindingId: body.bindingId as string,
          gitBranch,
          displayName: displayName || github.displayName,
        },
      });
      return reply.code(result.statusCode).send(result.payload);
    },
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    return project ? reply.send({ project }) : reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
  });

  app.post<{ Params: { projectId: string }; Body: { baseWorkflowId?: unknown } }>(
    "/v1/projects/:projectId/iterations",
    async (request, reply) => {
      const principal = productAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository, principal);
      const body = objectBody(request.body);
      if (!UUID.test(request.params.projectId)
        || typeof body.baseWorkflowId !== "string"
        || !UUID.test(body.baseWorkflowId)) {
        throw httpError(400, "INVALID_PROJECT_ITERATION", "项目迭代请求无效");
      }
      const result = await repository.createProjectIteration({
        workspaceId: workspace.id,
        projectId: request.params.projectId,
        baseWorkflowId: body.baseWorkflowId,
        actorId: principal.actorId,
      });
      return reply.code(result.created ? 201 : 200).send(result);
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/iterations",
    async (request, reply) => {
      const principal = productAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository, principal);
      if (!UUID.test(request.params.projectId)) {
        return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      }
      const iterations = await repository.listProjectIterations(workspace.id, request.params.projectId);
      return iterations
        ? reply.send({ iterations })
        : reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    },
  );

  app.get<{ Params: { projectId: string; workflowId: string } }>(
    "/v1/projects/:projectId/iterations/:workflowId",
    async (request, reply) => {
      const principal = productAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository, principal);
      if (!UUID.test(request.params.projectId) || !UUID.test(request.params.workflowId)) {
        return reply.code(404).send({ code: "PROJECT_ITERATION_NOT_FOUND" });
      }
      const iteration = await repository.readProjectIteration(
        workspace.id,
        request.params.projectId,
        request.params.workflowId,
      );
      return iteration
        ? reply.send({ iteration })
        : reply.code(404).send({ code: "PROJECT_ITERATION_NOT_FOUND" });
    },
  );

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/analysis/retry", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.retryProjectImportAnalysis(workspace.id, request.params.projectId);
    return project
      ? reply.code(202).send({ project })
      : reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/artifacts", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    return reply.send({
      artifacts: await repository.listProjectArtifacts(workspace.id, project.id, project.workflowId),
    });
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/asset-manifest", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const view = await repository.assets.read(workspace.id, project.id);
    // A project without a manifest is ordinary, not an error: the Agent has not
    // planned assets for it yet.
    if (!view) return reply.send({ manifest: null, items: [], completion: null });
    return reply.send(view);
  });

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/asset-manifest/auto-generate",
    async (request, reply) => {
      const principal = productAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository, principal);
      const project = await repository.readProject(workspace.id, request.params.projectId);
      if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      const body = objectBody(request.body);
      if (typeof body.enabled !== "boolean") {
        return reply.code(400).send({ code: "INVALID_AUTO_GENERATE", message: "enabled 必须是布尔值" });
      }
      const updated = await repository.assets.setAutoGenerate(workspace.id, project.id, body.enabled);
      if (!updated) return reply.code(404).send({ code: "ASSET_MANIFEST_NOT_FOUND" });
      return reply.send({ enabled: body.enabled });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/asset-manifest/uploads",
    { bodyLimit: MAX_ASSET_REQUEST_BYTES },
    async (request, reply) => {
      const principal = productAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository, principal);
      const project = await repository.readProject(workspace.id, request.params.projectId);
      if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      const body = objectBody(request.body);
      const assetKey = typeof body.assetKey === "string" ? body.assetKey : "";
      const contentType = typeof body.contentType === "string" ? body.contentType : "";
      const encoded = typeof body.content === "string" ? body.content : "";
      const extension = ASSET_CONTENT_TYPES[contentType];
      if (!assetKey || assetKey.length > 200 || !extension || !encoded) {
        return reply.code(400).send({
          code: "INVALID_ASSET_UPLOAD",
          message: "请提供素材键名和受支持的图片内容 (PNG/JPEG/WebP)",
        });
      }
      // Decoded length is what actually lands in the bucket, so bound that
      // rather than the base64 envelope.
      const content = Buffer.from(encoded, "base64");
      if (content.length < 1 || content.length > MAX_ASSET_BYTES) {
        return reply.code(413).send({
          code: "ASSET_TOO_LARGE",
          message: `单个素材不能超过 ${MAX_ASSET_BYTES / (1024 * 1024)} MB`,
        });
      }
      // Store first, then record: an orphaned object is harmless and gets swept
      // with the project, whereas a row pointing at a missing object is not.
      const stored = await objectStore.putProjectAsset({
        workspaceId: workspace.id,
        projectId: project.id,
        assetKey,
        extension,
        contentType,
        content,
      });
      const item = await repository.assets.attachUpload({
        workspaceId: workspace.id,
        projectId: project.id,
        assetKey,
        bucket: stored.bucket,
        objectKey: stored.key,
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
      });
      if (!item) return reply.code(404).send({ code: "ASSET_ITEM_NOT_FOUND" });
      return reply.send({ item });
    },
  );

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

  app.delete<{ Params: { projectId: string }; Body?: { deleteLocalDirectory?: unknown } }>("/v1/projects/:projectId", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body
      : {};
    if (body.deleteLocalDirectory !== undefined && typeof body.deleteLocalDirectory !== "boolean") {
      throw httpError(400, "INVALID_PROJECT_DELETE_REQUEST", "本地目录删除选项无效");
    }
    const deleteLocalDirectory = body.deleteLocalDirectory === true;
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    if (deleteLocalDirectory && project.localDirectory
      && (!config.localDirectoryBindings || !config.localProjectBridgeUrl || !config.localProjectBridgeToken)) {
      throw httpError(409, "LOCAL_DIRECTORY_DELETE_UNAVAILABLE", "当前环境不支持删除本地项目目录");
    }
    const localDirectoryBindingId = project.localDirectory?.bindingId ?? null;
    const deleted = await repository.deleteProject(
      workspace.id,
      request.params.projectId,
      async () => {
        await Promise.all([
          objectStore.deleteProjectObjects(workspace.id, request.params.projectId),
          projectSources.deleteProject(workspace.id, request.params.projectId),
        ]);
        if (deleteLocalDirectory && localDirectoryBindingId) {
          await deleteBoundProjectDirectory(config, localDirectoryBindingId);
        }
      },
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
      actorId: principal.actorId,
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
    const result = await processConversationMessage({ request, principal, repository, objectStore, agentSecrets, command });
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
        objectStore,
        agentSecrets,
        command,
        signal: abortController.signal,
        onStage: phase => write({ type: "status", phase }),
        onDelta: (agentRole, delta) => write({ type: "agent_delta", agentRole, delta }),
      });
      if (result.payload.conversation.messages.slice(-3).some(
        message => message.metadata.projectDocumentUpdated === true,
      )) {
        write({ type: "project_document", project: result.payload.project });
      }
      write({ type: "complete", ...result.payload });
    } catch (error) {
      const failure = publicStreamError(error);
      request.log.warn({
        code: failure.code,
        error: failure.message,
      }, "conversation stream failed");
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
    if (project.analysisStatus !== "READY") {
      throw httpError(
        409,
        "PROJECT_ANALYSIS_INCOMPLETE",
        project.analysisStatus === "NEEDS_INPUT"
          ? "请先在项目会话中回答现有项目分析提出的问题，再开始开发"
          : "项目源码分析完成后才能开始开发",
      );
    }
    const accepted = await approveProjectDevelopment({
      repository,
      objectStore,
      workspaceId: workspace.id,
      project,
      requestedByActorId: principal.actorId,
    });
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/steam-settings", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    return reply.header("cache-control", "no-store").send({
      settings: await repository.readProjectSteamSettings(workspace.id, project.id),
      editable: true,
    });
  });

  app.put<{ Params: { projectId: string } }>("/v1/projects/:projectId/steam-settings", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const input = parseProjectSteamSettings(request.body);
    const settings = await repository.saveProjectSteamSettings({
      workspaceId: workspace.id,
      projectId: project.id,
      ...input,
      updatedByActorId: principal.actorId,
    });
    return reply.send({ settings });
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/steam-releases", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    return reply.header("cache-control", "no-store").send({
      releases: await repository.listSteamReleases(workspace.id, project.id),
    });
  });

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/steam-releases", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const body = objectBody(request.body);
    const workflowId = typeof body.workflowId === "string" ? body.workflowId : "";
    const version = typeof body.version === "string" ? body.version.trim() : "";
    const channel = body.channel === "TEST" || body.channel === "DEFAULT" ? body.channel : null;
    if (workflowId !== project.workflowId || !SEMVER.test(version) || !channel) {
      return reply.code(400).send({ code: "INVALID_STEAM_RELEASE" });
    }
    if (project.workflowState !== "RELEASE_DECISION_PENDING") {
      return reply.code(409).send({
        code: "RELEASE_DECISION_UNAVAILABLE",
        message: "当前轮次必须先通过真实操作 E2E，才能上传 Steam",
      });
    }
    const result = await repository.createSteamRelease({
      workspaceId: workspace.id,
      projectId: project.id,
      workflowId,
      version,
      channel,
      requestedByActorId: principal.actorId,
    });
    return reply.code(result.accepted ? 202 : 200).send(result);
  });

  app.post<{ Params: { projectId: string; workflowId: string } }>(
    "/v1/projects/:projectId/iterations/:workflowId/complete",
    async (request, reply) => {
      const principal = productAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository, principal);
      const project = await repository.readProject(workspace.id, request.params.projectId);
      if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      if (project.workflowId !== request.params.workflowId || project.workflowState !== "RELEASE_DECISION_PENDING") {
        return reply.code(409).send({ code: "RELEASE_DECISION_UNAVAILABLE" });
      }
      const accepted = await repository.completeWorkflowIteration({
        workspaceId: workspace.id,
        workflowId: project.workflowId,
        idempotencyKey: requestIdempotencyKey(request, `release-skipped:${project.workflowId}`),
        requestedByActorId: principal.actorId,
      });
      return reply.code(accepted ? 202 : 200).send({ accepted });
    },
  );

  app.post<{ Params: { projectId: string; releaseId: string } }>(
    "/v1/projects/:projectId/steam-releases/:releaseId/confirm-live",
    async (request, reply) => {
      const principal = productAccess(request, config);
      const workspace = await requireSelectedWorkspace(request, repository, principal);
      const project = await repository.readProject(workspace.id, request.params.projectId);
      if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      const release = await repository.confirmSteamReleaseLive({
        workspaceId: workspace.id,
        projectId: project.id,
        releaseId: request.params.releaseId,
      });
      if (!release) return reply.code(409).send({ code: "DEFAULT_PROMOTION_NOT_PENDING" });
      return reply.send({ release });
    },
  );

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/rerun-stage", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const body = objectBody(request.body);
    if (!isRerunnableStage(body.stage)) {
      return reply.code(400).send({
        code: "INVALID_RERUN_STAGE",
        message: "重跑节点不是已知的流程阶段",
      });
    }
    const stage = body.stage;
    const stages = deliveryStages(project.workflowProfile);
    if (!stages.includes(stage)) {
      return reply.code(409).send({
        code: "STAGE_NOT_IN_PROFILE",
        message: `${stage} 不属于当前 ${project.workflowProfile} 流程，不能从这里重跑`,
      });
    }
    // The rerun key is scoped to the stage so picking a different node is a new
    // request, while double-clicking the same node collapses into one signal.
    const idempotencyKey = requestIdempotencyKey(request, `stage-rerun:${stage}`);
    // Superseding downstream jobs would race executors that still hold leases,
    // so a rerun only makes sense once the delivery has come to rest.
    if (!["FAILED", "SUCCEEDED", "CANCELLED"].includes(project.workflowState)) {
      if (await repository.workflowSignalExists(workspace.id, project.workflowId, idempotencyKey)) {
        return reply.send({ accepted: false });
      }
      return reply.code(409).send({
        code: "STAGE_RERUN_UNAVAILABLE",
        message: "流程正在运行中，请先取消当前交付再选择重跑节点",
      });
    }
    if (stage === "AGENT_GENERATION" && !await repository.readAgentSettings()) {
      return reply.code(424).send({
        code: "AGENT_CONFIG_REQUIRED",
        message: "请先完成全局 Agent 配置，再重新生成",
      });
    }
    const signalInput = {
      kind: "STAGE_RERUN_REQUESTED",
      idempotencyKey,
      payload: {
        stage,
        requestedBy: principal.actorLabel,
        requestedByActorId: principal.actorId,
      },
    } as const;
    const accepted = stage === "STEAM_PUBLISH"
      ? await repository.retrySteamRelease({
          workspaceId: workspace.id,
          workflowId: project.workflowId,
          idempotencyKey,
          requestedByActorId: principal.actorId,
        })
      : await repository.appendSignal(workspace.id, project.workflowId, signalInput);
    return reply.code(accepted ? 202 : 200).send({ accepted, stage });
  });

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/cancel", async (request, reply) => {
    const principal = productAccess(request, config);
    const workspace = await requireSelectedWorkspace(request, repository, principal);
    const project = await repository.readProject(workspace.id, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const accepted = await repository.appendSignal(workspace.id, project.workflowId, {
      kind: "CANCEL_REQUESTED",
      idempotencyKey: requestIdempotencyKey(request, `cancel:${project.workflowId}`),
      payload: { requestedBy: principal.actorLabel, requestedByActorId: principal.actorId },
    });
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  app.post("/v1/runtime/server-nodes", async (request, reply) => {
    requireLocalOperator();
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

  app.post("/v1/runtime/e2e-enrollment-tokens", async (request, reply) => {
    const principal = requireLocalOperator();
    const body = objectBody(request.body);
    if (!isServerPoolKind(body.poolKind) || !body.poolKind.startsWith("E2E_")) {
      return reply.code(400).send({ code: "INVALID_E2E_POOL" });
    }
    const token = randomBytes(32).toString("base64url");
    const created = await repository.createE2eEnrollmentToken({
      tokenHash: digest(token),
      poolKind: body.poolKind as Extract<ServerPoolKind, `E2E_${string}`>,
      createdBy: principal.actorId,
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

  app.post("/v1/e2e/enroll-development", async (request, reply) => {
    if (process.env.NODE_ENV === "production" || !config.e2eDevelopmentToken) {
      return reply.code(404).send({ code: "NOT_FOUND" });
    }
    const body = objectBody(request.body);
    const token = typeof body.token === "string" ? body.token : "";
    if (!isServerPoolKind(body.poolKind) || !body.poolKind.startsWith("E2E_")
      || !["linux", "windows", "macos"].includes(String(body.operatingSystem))
      || typeof body.receiptPublicKey !== "string" || !/^[A-Za-z0-9_-]{32,200}$/.test(token)
      || typeof body.nodeAuthTokenHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(body.nodeAuthTokenHash)
      || typeof body.runtimeImage !== "string" || !/^sha256:[0-9a-f]{64}$/.test(body.runtimeImage)) {
      return reply.code(400).send({ code: "INVALID_DEVELOPMENT_E2E_ENROLLMENT" });
    }
    try {
      if (createPublicKey(body.receiptPublicKey).asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
    } catch {
      return reply.code(400).send({ code: "INVALID_E2E_RECEIPT_KEY" });
    }
    const operatingSystem = body.operatingSystem as ServerOperatingSystem;
    assertPoolOperatingSystem(body.poolKind, operatingSystem);
    const nodeId = await repository.reserveDevelopmentE2eEnrollment({
      tokenHash: digest(token),
      poolKind: body.poolKind as Extract<ServerPoolKind, `E2E_${string}`>,
      operatingSystem,
      receiptPublicKey: body.receiptPublicKey,
      nodeAuthTokenHash: body.nodeAuthTokenHash,
      runtimeImage: body.runtimeImage,
    });
    return reply.code(201).send({ nodeId, poolKind: body.poolKind, operatingSystem });
  });

  app.post<{ Params: { nodeId: string } }>("/v1/e2e/nodes/:nodeId/renew", async (request, reply) => {
    await authorizeE2e(request, config, repository);
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
    "/v1/runtime/server-nodes/:nodeId/:action",
    async (request, reply) => {
      requireLocalOperator();
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
    const authenticatedNodeId = await authorizeE2e(request, config, repository);
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
    await repository.heartbeatServerNode(node.id, node.poolKind);
    const job = await repository.claimJob({
      workerId: `e2e:${body.nodeId}`,
      poolKind: body.poolKind,
      leaseSeconds: 60,
    });
    return reply.send({ job });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/heartbeat", async (request, reply) => {
    const nodeId = await authorizeE2e(request, config, repository);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body), nodeId ? `e2e:${nodeId}` : undefined);
    const reportingNodeId = nodeId ?? (typeof body.nodeId === "string" && UUID.test(body.nodeId) ? body.nodeId : null);
    if (reportingNodeId) await repository.heartbeatServerNode(reportingNodeId, job.poolKind);
    return reply.send({ accepted: await repository.heartbeat(job) });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/complete", async (request, reply) => {
    const nodeId = await authorizeE2e(request, config, repository);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body), nodeId ? `e2e:${nodeId}` : undefined);
    const completion = parseCompletion(body);
    assertE2eCompletion(job, completion);
    await objectStore.verifyOutputs(job, completion.executorReceipt.outputObjects);
    return reply.send({ accepted: await repository.complete(job, completion) });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/fail", async (request, reply) => {
    const nodeId = await authorizeE2e(request, config, repository);
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

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/objects", async (request, reply) => {
    const nodeId = await authorizeE2e(request, config, repository);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body), nodeId ? `e2e:${nodeId}` : undefined);
    return reply.send({ inputs: await objectStore.authorizeInputs(job) });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/outputs", async (request, reply) => {
    const nodeId = await authorizeE2e(request, config, repository);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body), nodeId ? `e2e:${nodeId}` : undefined);
    return reply.send(await objectStore.authorizeOutput(job, {
      kind: String(body.kind ?? ""),
      sha256: String(body.sha256 ?? ""),
      sizeBytes: Number(body.sizeBytes),
      targetPlatform: job.targetOperatingSystem,
    }));
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/player-policy/verify", async (request, reply) => {
    const nodeId = await authorizeE2e(request, config, repository);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body), nodeId ? `e2e:${nodeId}` : undefined);
    if (job.jobKind !== "E2E_TEST") return reply.code(409).send({ code: "PLAYER_POLICY_JOB_INVALID" });
    const settings = await repository.readAgentSettings();
    if (!settings) return reply.code(503).send({ code: "PLAYER_POLICY_NOT_CONFIGURED" });
    const model = settings.roleModels.test;
    const configurationDigest = jsonDigest({
      runtime: settings.agentRuntime, baseUrl: settings.baseUrl, model,
      settingsRevision: settings.revision, credentialVersion: settings.credentialVersion,
    });
    const policy = await repository.lockE2ePlayerPolicy({
      workspaceId: job.workspaceId, jobId: job.jobId, settingsRevision: settings.revision,
      runtime: settings.agentRuntime, baseUrl: settings.baseUrl, model,
      credentialSecretRef: settings.credentialSecretRef, configurationDigest,
    });
    if (settings.testPolicyReady && settings.testPolicyCheckedRevision === settings.revision) {
      return reply.send({ ready: true, policy: {
        configurationDigest: policy.configurationDigest,
        settingsRevision: policy.settingsRevision,
        model: policy.model,
      } });
    }
    const apiKey = await agentSecrets.readApiKey(policy.credentialSecretRef);
    if (!apiKey) return reply.code(503).send({ code: "PLAYER_POLICY_CREDENTIAL_UNAVAILABLE" });
    try {
      await verifyE2ePlayerVision({
        runtime: policy.runtime, baseUrl: policy.baseUrl, apiKey, model: policy.model,
      });
    } catch (error) {
      await repository.markTestPolicyUnavailable(policy.settingsRevision);
      const code = error instanceof Error && "code" in error && error.code === "PLAYER_POLICY_VISION_UNAVAILABLE"
        ? "PLAYER_POLICY_VISION_UNAVAILABLE"
        : "PLAYER_POLICY_PROVIDER";
      request.log.warn({
        event: "e2e_player_vision_failed",
        code,
        reason: error instanceof Error ? error.message : "Test Agent visual capability check failed",
      }, "Test Agent visual capability check failed");
      return reply.code(503).send({
        code,
        message: code === "PLAYER_POLICY_VISION_UNAVAILABLE"
          ? "Test Agent Provider 未向模型提供图像输入，无法执行真实画面自适应测试"
          : "Test Agent Provider 视觉能力检查失败",
      });
    }
    await repository.markTestPolicyReady(policy.settingsRevision);
    return reply.send({ ready: true, policy: {
      configurationDigest: policy.configurationDigest,
      settingsRevision: policy.settingsRevision,
      model: policy.model,
    } });
  });

  app.post<{ Params: { jobId: string } }>("/v1/e2e/jobs/:jobId/player-policy", async (request, reply) => {
    const nodeId = await authorizeE2e(request, config, repository);
    const body = objectBody(request.body);
    const job = await repository.loadLeasedJob(jobIdentity(request.params.jobId, body), nodeId ? `e2e:${nodeId}` : undefined);
    if (job.jobKind !== "E2E_TEST") return reply.code(409).send({ code: "PLAYER_POLICY_JOB_INVALID" });
    const policyRequest = parsePlayerPolicyRequest(body.request);
    const settings = await repository.readAgentSettings();
    if (!settings) return reply.code(503).send({ code: "PLAYER_POLICY_NOT_CONFIGURED" });
    const model = settings.roleModels.test;
    const configurationDigest = jsonDigest({
      runtime: settings.agentRuntime, baseUrl: settings.baseUrl, model,
      settingsRevision: settings.revision, credentialVersion: settings.credentialVersion,
    });
    const policy = await repository.lockE2ePlayerPolicy({
      workspaceId: job.workspaceId, jobId: job.jobId, settingsRevision: settings.revision,
      runtime: settings.agentRuntime, baseUrl: settings.baseUrl, model,
      credentialSecretRef: settings.credentialSecretRef, configurationDigest,
    });
    const requestDigest = jsonDigest(playerPolicyIdempotencyInput(policyRequest));
    return repository.withE2ePlayerDecisionLock({
      workspaceId: job.workspaceId, jobId: job.jobId,
      rolloutIndex: policyRequest.rolloutIndex, decisionIndex: policyRequest.decisionIndex,
    }, async () => {
      const cached = await repository.readE2ePlayerDecision({
        workspaceId: job.workspaceId, jobId: job.jobId,
        rolloutIndex: policyRequest.rolloutIndex, decisionIndex: policyRequest.decisionIndex, requestDigest,
      });
      if (cached) return reply.send({ decision: cached, policy: {
        configurationDigest: policy.configurationDigest, settingsRevision: policy.settingsRevision, model: policy.model,
      }, cached: true });
      const apiKey = await agentSecrets.readApiKey(policy.credentialSecretRef);
      if (!apiKey) return reply.code(503).send({ code: "PLAYER_POLICY_CREDENTIAL_UNAVAILABLE" });
      const startedAt = Date.now();
      let generated;
      try {
        generated = await generateE2ePlayerDecision({
          request: policyRequest, runtime: policy.runtime, baseUrl: policy.baseUrl, apiKey, model: policy.model,
        });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          && error.code === "PLAYER_POLICY_VISION_UNAVAILABLE"
          ? "PLAYER_POLICY_VISION_UNAVAILABLE"
          : "PLAYER_POLICY_PROVIDER";
        request.log.warn({ failureCode: code }, "Test Agent policy request failed");
        return reply.code(503).send({
          code,
          message: code === "PLAYER_POLICY_VISION_UNAVAILABLE"
            ? "Test Agent Provider 未向模型提供图像输入，无法执行真实画面自适应测试"
            : "Test Agent Provider 请求失败",
        });
      }
      const stored = await repository.saveE2ePlayerDecision({
        workspaceId: job.workspaceId, jobId: job.jobId,
        rolloutIndex: policyRequest.rolloutIndex, decisionIndex: policyRequest.decisionIndex,
        requestDigest, screenshotDigest: policyRequest.screenshotSha256,
        decision: generated.decision, latencyMs: Date.now() - startedAt,
        inputTokens: generated.inputTokens, outputTokens: generated.outputTokens,
      });
      await repository.markTestPolicyReady(policy.settingsRevision);
      return reply.send({ decision: stored, policy: {
        configurationDigest: policy.configurationDigest, settingsRevision: policy.settingsRevision, model: policy.model,
      }, cached: false });
    });
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
      payload: { ...(body.payload as Record<string, unknown>), requestedByActorId: principal.actorId },
    } as WorkflowSignalInput);
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  signal.addEventListener("abort", () => void app.close(), { once: true });
  await app.listen({ host: "0.0.0.0", port: config.port });
  const importAnalysisWorker = runProjectImportAnalysisWorker({
    repository,
    agentSecrets,
    projectSources,
    config,
    signal,
    logFailure: (message, error) => app.log.error({ err: error }, message),
  });
  await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  await importAnalysisWorker;
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
  principal: LocalAccessContext;
  repository: CoreRepository;
  objectStore: CoreObjectStore;
  agentSecrets: AgentSecretStore;
  command: ConversationMessageCommand;
  signal?: AbortSignal;
  onStage?: (phase: "NAMING" | "RESPONDING" | "SAVING") => void;
  onDelta?: (agentRole: ProjectAgentRole, delta: string) => void;
}>): Promise<ConversationMessageResult> {
  const { request, principal, repository, objectStore, agentSecrets, command } = input;
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
    const agentReplies = await conversationAgentReplies({
      userContent: command.content,
      history: Object.freeze([]),
      project: Object.freeze({
        name,
        concept: command.content,
        workflowState: "DRAFT",
        specification,
        document: createInitialProjectDocument(name, command.content, specification),
        analysisStatus: "READY",
        discovery: null,
      }),
      allowDraftMutation: true,
    }, repository, agentSecrets, { signal: input.signal, onDelta: input.onDelta });
    input.onStage?.("SAVING");
    const targetWorkspace = workspace ?? Object.freeze({ id: randomUUID(), name, createdAt: "" });
    const projectId = deterministicProjectId(principal.actorId, idempotencyKey);
    const createdBundle = await repository.createProjectConversation({
      actorId: principal.actorId,
      workspaceId: targetWorkspace.id,
      workspaceName: targetWorkspace.name,
      projectId,
      workflowId: randomUUID(),
      conversationId: randomUUID(),
      idempotencyKey,
      name,
      concept: command.content,
      specification,
      document: agentReplies.find(reply => reply.agentRole === "DESIGN")?.projectDocument
        ?? createInitialProjectDocument(name, command.content, specification),
      userContent: command.content,
      assistantMessages: agentReplies.map(reply => Object.freeze({
        content: reply.content,
        metadata: conversationAgentMetadata(reply),
      })),
      ...defaultWorkflowConfiguration(),
    });
    const selectedWorkspace = workspace ?? await repository.readWorkspace(targetWorkspace.id);
    if (!selectedWorkspace) throw new Error("Created workspace could not be read");
    let createdProject = createdBundle.project;
    if (createdProject.workflowState === "DRAFT" && createdProject.analysisStatus === "READY"
      && isDevelopmentApprovalRequest(command.content)) {
      await approveProjectDevelopment({
        repository,
        objectStore,
        workspaceId: targetWorkspace.id,
        project: createdProject,
        requestedByActorId: principal.actorId,
      });
      createdProject = await repository.readProject(targetWorkspace.id, projectId) ?? createdProject;
    }
    return Object.freeze({
      statusCode: 201,
      setWorkspaceCookie: true,
      payload: Object.freeze({ workspace: selectedWorkspace, ...createdBundle, project: createdProject }),
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
  const agentReplies = await conversationAgentReplies({
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
    assistantMessages: agentReplies.map(reply => Object.freeze({
      content: reply.content,
      metadata: conversationAgentMetadata(reply),
    })),
    assistantApplyToDraft: agentReplies.some(reply => reply.agentRole === "DESIGN" && reply.applyToDraft),
    assistantProjectDocument: agentReplies.find(reply => reply.agentRole === "DESIGN")?.projectDocument ?? null,
    resolveImportAnalysis: project.analysisStatus === "NEEDS_INPUT"
      && agentReplies.every(reply => reply.readyForDevelopment),
  });
  let updatedProject = await repository.readProject(workspace.id, projectId);
  if (!updatedProject) throw httpError(404, "PROJECT_NOT_FOUND", "项目已不存在");
  if (updatedProject.workflowState === "DRAFT" && updatedProject.analysisStatus === "READY"
    && isDevelopmentApprovalRequest(command.content)) {
    await approveProjectDevelopment({
      repository,
      objectStore,
      workspaceId: workspace.id,
      project: updatedProject,
      requestedByActorId: principal.actorId,
    });
    updatedProject = await repository.readProject(workspace.id, projectId) ?? updatedProject;
  }
  return Object.freeze({
    statusCode: created ? 201 : 200,
    setWorkspaceCookie: false,
    payload: Object.freeze({ workspace, project: updatedProject, conversation }),
  });
}

async function approveProjectDevelopment(input: Readonly<{
  repository: CoreRepository;
  objectStore: CoreObjectStore;
  workspaceId: string;
  project: ProductProjectDetail;
  requestedByActorId: string;
}>): Promise<boolean> {
  const specificationObject = await input.objectStore.putSpecification({
    workspaceId: input.workspaceId,
    projectId: input.project.id,
    workflowId: input.project.workflowId,
    specification: input.project.specification,
  });
  await input.repository.registerSpecificationArtifact({
    workspaceId: input.workspaceId,
    projectId: input.project.id,
    workflowId: input.project.workflowId,
    object: specificationObject,
  });
  return input.repository.appendSignal(input.workspaceId, input.project.workflowId, {
    kind: "SPEC_APPROVED",
    idempotencyKey: `spec-approved:${input.project.workflowId}`,
    payload: { specificationObject, requestedByActorId: input.requestedByActorId },
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

async function authorizeE2e(
  request: FastifyRequest,
  config: CoreConfig,
  repository: CoreRepository,
): Promise<string | null> {
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
  if (config.e2eDevelopmentToken && secureEqual(actual, config.e2eDevelopmentToken)) return null;
  const nodeId = String(request.headers["x-deviludo-node-id"] ?? "");
  if (!UUID.test(nodeId) || !actual
    || !await repository.authenticateDevelopmentE2eNode(nodeId, digest(actual))) {
    throw unauthorized("E2E node authentication failed");
  }
  return nodeId;
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

function jsonDigest(value: unknown): string {
  const stable = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(stable).join(",")}]`;
    if (input && typeof input === "object") {
      const object = input as Record<string, unknown>;
      return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
    }
    return JSON.stringify(input);
  };
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
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
// Raster formats only, and the extension is derived here rather than taken from
// the client filename so an upload cannot choose its own key suffix.
const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
});
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
/**
 * Transport budget for an asset upload. The bytes arrive base64-encoded inside a
 * JSON envelope, which inflates them by 4/3, so the route limit has to clear
 * that before `MAX_ASSET_BYTES` can be enforced on the decoded buffer.
 */
const MAX_ASSET_REQUEST_BYTES = Math.ceil(MAX_ASSET_BYTES * 4 / 3) + 4 * 1024;
function productAccess(request: FastifyRequest, config: CoreConfig): LocalAccessContext {
  authorizeWeb(request, config);
  return localAccessContext();
}

async function selectedWorkspaceFromRequest(
  _request: FastifyRequest,
  _repository: CoreRepository,
  context: LocalAccessContext,
) {
  return context.workspace;
}

async function requireSelectedWorkspace(
  request: FastifyRequest,
  repository: CoreRepository,
  context: LocalAccessContext,
) {
  return selectedWorkspaceFromRequest(request, repository, context);
}

function requireLocalOperator(): LocalAccessContext {
  return localAccessContext();
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

async function readBoundProjectSource(
  config: CoreConfig,
  metadata: Readonly<{
    sourceKind: "GIT" | "LOCAL_DIRECTORY";
    repositoryUrl?: string | null;
    localDirectoryBindingId: string;
    gitBranch?: string | null;
    displayName: string;
  }>,
): Promise<ImportedSourceSnapshot> {
  if (!config.localProjectBridgeUrl || !config.localProjectBridgeToken) {
    throw new Error("本地项目桥接尚未配置");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1_000);
  try {
    const response = await fetch(`${config.localProjectBridgeUrl}/internal/directory/source`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-deviludo-bridge-token": config.localProjectBridgeToken,
      },
      body: JSON.stringify({ bindingId: metadata.localDirectoryBindingId }),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { message?: unknown };
      throw new Error(typeof failure.message === "string" ? failure.message : "无法读取已关联的本地项目目录");
    }
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/x-deviludo-source-v1") {
      throw new Error("本地项目桥接返回了无效的源码格式");
    }
    const files = decodeProjectSourceStream(new Uint8Array(await response.arrayBuffer()));
    const expectedDigest = response.headers.get("x-deviludo-source-digest") ?? "";
    if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest) || projectSourceDigest(files) !== expectedDigest) {
      throw new Error("本地项目源码完整性校验失败");
    }
    return inspectProjectFiles({ ...metadata, files });
  } finally {
    clearTimeout(timer);
  }
}

async function deleteBoundProjectDirectory(config: CoreConfig, bindingId: string): Promise<void> {
  if (!config.localProjectBridgeUrl || !config.localProjectBridgeToken) {
    throw httpError(409, "LOCAL_DIRECTORY_DELETE_UNAVAILABLE", "当前环境不支持删除本地项目目录");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1_000);
  try {
    const response = await fetch(`${config.localProjectBridgeUrl}/internal/directory/delete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-deviludo-bridge-token": config.localProjectBridgeToken,
      },
      body: JSON.stringify({ bindingId }),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { code?: unknown; message?: unknown };
      const code = typeof failure.code === "string" ? failure.code : "LOCAL_DIRECTORY_DELETE_FAILED";
      const message = typeof failure.message === "string" ? failure.message : "本地项目目录删除失败";
      throw httpError(response.status >= 500 ? 502 : 409, code, message);
    }
  } catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error;
    const message = error instanceof Error && error.name === "AbortError"
      ? "删除本地项目目录超时，项目记录已保留"
      : "无法连接本地项目桥接，项目记录已保留";
    throw httpError(502, "LOCAL_DIRECTORY_DELETE_FAILED", message);
  } finally {
    clearTimeout(timer);
  }
}

function projectSourceDigest(files: readonly SourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const path = Buffer.from(file.path, "utf8");
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(file.bytes.length));
    hash.update(path).update("\0").update(size).update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function queueBoundProjectImport(input: Readonly<{
  request: FastifyRequest;
  principal: LocalAccessContext;
  repository: CoreRepository;
  name: string;
  source: Readonly<{
    sourceKind: "GIT" | "LOCAL_DIRECTORY";
    repositoryUrl: string | null;
    localDirectoryBindingId: string;
    gitBranch: string;
    displayName: string;
  }>;
}>): Promise<Readonly<{
  statusCode: 200 | 202;
  payload: Readonly<{
    workspace: WorkspaceSummary;
    project: ProductProjectDetail;
    conversation: null;
  }>;
}>> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 200) {
    throw httpError(400, "INVALID_PROJECT_NAME", "项目目录或仓库名称长度必须在 1 至 200 个字符之间");
  }
  const idempotencyKey = requestIdempotencyKey(input.request, "project-import");
  const currentWorkspace = await selectedWorkspaceFromRequest(input.request, input.repository, input.principal);
  const prior = await input.repository.readProjectCreationReceipt(input.principal.workspace.id, idempotencyKey);
  if (prior) {
    if (prior.operationKind !== "PROJECT" || (currentWorkspace && currentWorkspace.id !== prior.workspaceId)) {
      throw httpError(409, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他操作");
    }
    const [workspace, project] = await Promise.all([
      input.repository.readWorkspace(prior.workspaceId),
      input.repository.readProject(prior.workspaceId, prior.projectId),
    ]);
    if (!workspace || !project) throw new Error("Project link receipt is incomplete");
    return Object.freeze({
      statusCode: 200,
      payload: Object.freeze({ workspace, project, conversation: null }),
    });
  }

  const targetWorkspace = currentWorkspace ?? Object.freeze({ id: randomUUID(), name, createdAt: "" });
  const project = await input.repository.createPendingImportedProject({
    actorId: input.principal.actorId,
    workspaceId: targetWorkspace.id,
    workspaceName: targetWorkspace.name,
    projectId: deterministicProjectId(input.principal.actorId, idempotencyKey),
    workflowId: randomUUID(),
    idempotencyKey,
    name,
    source: {
      kind: input.source.sourceKind,
      repositoryUrl: input.source.repositoryUrl,
      localDirectoryBindingId: input.source.localDirectoryBindingId,
      gitBranch: normalizeGitBranchName(input.source.gitBranch),
      displayName: name,
    },
    ...defaultWorkflowConfiguration(),
  });
  const workspace = currentWorkspace ?? await input.repository.readWorkspace(targetWorkspace.id);
  if (!workspace) throw new Error("Linked workspace could not be read");
  return Object.freeze({
    statusCode: 202,
    payload: Object.freeze({ workspace, project, conversation: null }),
  });
}

async function runProjectImportAnalysisWorker(input: Readonly<{
  repository: CoreRepository;
  agentSecrets: AgentSecretStore;
  projectSources: ProjectSourceStore;
  config: CoreConfig;
  signal: AbortSignal;
  logFailure: (message: string, error: unknown) => void;
}>): Promise<void> {
  while (!input.signal.aborted) {
    let claimed: PendingProjectImportAnalysis | null;
    try {
      claimed = await input.repository.claimProjectImportAnalysis(30 * 60);
    } catch (error) {
      input.logFailure("Unable to claim pending project analysis", error);
      await abortableDelay(2_000, input.signal);
      continue;
    }
    if (!claimed) {
      await abortableDelay(1_000, input.signal);
      continue;
    }

    try {
      const source = await readBoundProjectSource(input.config, {
        sourceKind: claimed.sourceKind,
        repositoryUrl: claimed.repositoryUrl,
        localDirectoryBindingId: claimed.localDirectoryBindingId,
        gitBranch: claimed.gitBranch,
        displayName: claimed.displayName,
      });
      const settings = await input.repository.readAgentSettings();
      if (!settings) throw new Error("请先在设置中配置全局 Agent 连接");
      const apiKey = await input.agentSecrets.readApiKey(settings.credentialSecretRef);
      if (!apiKey) throw new Error("无法读取全局 Agent 凭据，请重新保存配置");
      const analysis = await analyzeImportedProject({ source, settings, apiKey });
      const stored = await input.projectSources.publishFiles({
        workspaceId: claimed.workspaceId,
        projectId: claimed.projectId,
        revision: 1,
        files: source.files,
      });
      const completed = await input.repository.completeProjectImportAnalysis({
        workspaceId: claimed.workspaceId,
        projectId: claimed.projectId,
        workflowId: claimed.workflowId,
        actorId: claimed.actorId,
        leaseToken: claimed.leaseToken,
        concept: analysis.concept,
        specification: analysis.specification,
        document: analysis.document,
        assistantContent: analysis.assistantContent,
        assistantMetadata: {
          agentRuntime: analysis.runtime,
          model: analysis.model,
          settingsRevision: analysis.settingsRevision,
          analyzedProjectName: analysis.name,
          readyForDevelopment: analysis.discovery.questions.length === 0,
          analysisQuestions: analysis.discovery.questions,
        },
        discovery: analysis.discovery,
        source: {
          kind: source.sourceKind as "GIT" | "LOCAL_DIRECTORY",
          repositoryUrl: source.repositoryUrl,
          localDirectoryBindingId: claimed.localDirectoryBindingId,
          gitBranch: source.gitBranch,
          displayName: claimed.displayName,
          fileCount: source.fileCount,
          totalBytes: source.totalBytes,
          revision: stored.revision,
          relativePath: stored.relativePath,
          sha256: stored.digest,
        },
      });
      if (!completed) {
        input.logFailure("Project analysis lease expired before completion", new Error(claimed.projectId));
      }
    } catch (error) {
      const message = projectAnalysisFailureMessage(error);
      await input.repository.failProjectImportAnalysis({
        workspaceId: claimed.workspaceId,
        workflowId: claimed.workflowId,
        projectId: claimed.projectId,
        leaseToken: claimed.leaseToken,
        error: message,
      }).catch(failure => input.logFailure("Unable to persist project analysis failure", failure));
      input.logFailure(`Project analysis failed for ${claimed.projectId}`, error);
    }
  }
}

function projectAnalysisFailureMessage(error: unknown): string {
  if (isTimeoutFailure(error)) return "项目分析超时，请检查本地目录、Agent 服务或网络后重试。";
  const message = error instanceof Error ? error.message.trim() : "项目分析失败";
  return message || "项目分析失败";
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}


async function conversationAgentReplies(
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
    onDelta?: (agentRole: ProjectAgentRole, delta: string) => void;
  }>,
): Promise<readonly ProductConversationGroupReply[]> {
  const settings = await repository.readAgentSettings();
  if (!settings) throw httpError(424, "AGENT_CONFIG_REQUIRED", "请先配置全局 Agent 连接");
  const apiKey = await agentSecrets.readApiKey(settings.credentialSecretRef);
  if (!apiKey) throw httpError(424, "AGENT_CONFIG_REQUIRED", "无法读取全局 Agent 凭据，请重新保存配置");
  try {
    if (stream?.onDelta) {
      return await streamProductConversationGroupReply({ ...input, settings, apiKey, signal: stream.signal }, stream.onDelta);
    }
    return await generateProductConversationGroupReply({ ...input, settings, apiKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : "项目群聊 Agent 调用失败";
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
    analysisStatus: project.analysisStatus,
    discovery: project.discovery,
  });
}

function conversationAgentMetadata(reply: ProductConversationGroupReply): Readonly<Record<string, unknown>> {
  return Object.freeze({
    source: "AI_AGENT",
    agentRole: reply.agentRole,
    agentName: reply.agentRole === "DESIGN" ? "DeviLudo Design Agent"
      : reply.agentRole === "DEVELOPMENT" ? "DeviLudo Development Agent" : "DeviLudo Test Agent",
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

function isTimeoutFailure(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"
    || /aborted due to timeout|timed?\s*out/i.test(error.message));
}

function publicAgentSettings(
  settings: StoredInstanceAgentSettings | null,
  apiKeyMask = settings?.apiKeyMask ?? null,
) {
  return Object.freeze({
    agentRuntime: settings?.agentRuntime ?? "CLAUDE_CODE",
    baseUrl: settings?.baseUrl ?? "https://api.anthropic.com",
    model: settings?.model ?? null,
    models: settings?.models ?? null,
    roleModels: settings?.roleModels ?? Object.freeze({
      design: "claude-sonnet-4-5",
      development: "claude-opus-4-1",
      test: "claude-haiku-4-5",
    }),
    imageModel: settings?.imageModel ?? null,
    imageGenerationReady: settings?.agentRuntime === "CLAUDE_CODE"
      && settings.imageModel !== null
      && settings.apiKeyMask !== null,
    apiKeyConfigured: settings !== null,
    apiKeyMasked: settings?.agentRuntime === "CLAUDE_CODE" ? apiKeyMask : null,
    apiKeyFingerprint: settings?.agentRuntime === "CLAUDE_CODE" ? settings.apiKeyFingerprint : null,
    revision: settings?.revision ?? 0,
    testPolicyReady: settings?.testPolicyReady ?? false,
    updatedAt: settings?.updatedAt ?? null,
  });
}

function readCodexOfficialLogin(): string {
  if (process.env.DEVILUDO_CODEX_LOGIN_METHOD !== "CHATGPT") {
    throw new Error("Codex CLI 尚未使用 OpenAI 官方账号登录，请先在宿主机运行 codex login");
  }
  const path = process.env.DEVILUDO_CODEX_AUTH_FILE ?? "/run/deviludo-codex/auth.json";
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error("无法读取 Codex CLI 官方登录状态，请重新运行 npm run local:up");
  }
  if (value.length < 16 || value.length > 64 * 1024) throw new Error("Codex CLI 官方登录数据无效");
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  } catch {
    throw new Error("Codex CLI 官方登录数据无效");
  }
  return value;
}

function parseProjectSteamSettings(value: unknown): Readonly<{
  appId: string;
  depots: Readonly<Partial<Record<ServerOperatingSystem, string>>>;
  testBranch: string;
}> {
  const body = objectBody(value);
  if (Object.keys(body).some(key => !["appId", "depots", "testBranch"].includes(key))) {
    throw new Error("Steam project settings contain unsupported fields");
  }
  const appId = steamNumericId(body.appId, "Steam App ID");
  const rawDepots = body.depots && typeof body.depots === "object" && !Array.isArray(body.depots)
    ? body.depots as Record<string, unknown>
    : {};
  if (Object.keys(rawDepots).some(key => !["linux", "windows", "macos"].includes(key))) {
    throw new Error("Steam depot platform is invalid");
  }
  const depots = Object.freeze(Object.fromEntries(
    (["linux", "windows", "macos"] as const)
      .filter(platform => rawDepots[platform] !== undefined && rawDepots[platform] !== null && rawDepots[platform] !== "")
      .map(platform => [platform, steamNumericId(rawDepots[platform], `Steam ${platform} Depot ID`)]),
  ) as Partial<Record<ServerOperatingSystem, string>>);
  if (Object.keys(depots).length === 0) throw new Error("At least one Steam depot is required");
  const testBranch = typeof body.testBranch === "string" ? body.testBranch.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(testBranch) || testBranch === "default") {
    throw new Error("Steam test branch is invalid");
  }
  return Object.freeze({ appId, depots, testBranch });
}

function steamNumericId(value: unknown, label: string): string {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof normalized !== "string" || !/^[1-9][0-9]{0,11}$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
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
      "发布前通过真实窗口 E2E，并由管理员明确选择是否上传 Steam",
    ]),
    revisionNotes: Object.freeze([]),
  });
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function deterministicProjectId(actorId: string, idempotencyKey: string): string {
  const bytes = createHash("sha256").update("deviludo-project\0").update(actorId).update("\0").update(idempotencyKey).digest().subarray(0, 16);
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
