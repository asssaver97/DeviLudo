import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import Fastify, { type FastifyRequest } from "fastify";
import {
  assertPoolOperatingSystem,
  isServerPoolKind,
  type ServerNodeState,
  type ServerOperatingSystem,
} from "@/lib/runtime/server-pools";
import type { CoreConfig } from "./config";
import {
  assertE2eCompletion,
  parseCompletion,
  type ClaimedJobIdentity,
  type WorkflowSignalInput,
} from "./contracts";
import type { Database } from "./database";
import { CORE_MODULES } from "./modules";
import type { CoreRepository } from "./repository";
import { HttpSigningGrantBroker, type SigningGrantBroker } from "./signing-grants";

export async function runApi(
  repository: CoreRepository,
  database: Database,
  config: CoreConfig,
  signal: AbortSignal,
  signingGrants: SigningGrantBroker = new HttpSigningGrantBroker(),
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
    void reply.code(status >= 400 && status < 500 ? status : 500).send({
      code: status >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST",
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
    const session = localProductSession(request, config);
    return reply.send({ session });
  });

  app.get("/v1/projects", async (request, reply) => {
    const session = localProductSession(request, config);
    return reply.send({ projects: await repository.listProjects(session.tenantId) });
  });

  app.post("/v1/projects", async (request, reply) => {
    const session = localProductSession(request, config);
    const body = objectBody(request.body);
    const concept = typeof body.concept === "string" ? body.concept.trim() : "";
    const suppliedName = typeof body.name === "string" ? body.name.trim() : "";
    if (concept.length < 10 || concept.length > 4_000 || suppliedName.length > 200) {
      return reply.code(400).send({ code: "INVALID_GAME_CONCEPT" });
    }
    const name = suppliedName || projectNameFromConcept(concept);
    const project = await repository.createProject({
      tenantId: session.tenantId,
      tenantName: session.tenantName,
      projectId: randomUUID(),
      workflowId: randomUUID(),
      name,
      concept,
      specification: specificationFromConcept(name, concept),
    });
    return reply.code(201).send({ project });
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId", async (request, reply) => {
    const session = localProductSession(request, config);
    const project = await repository.readProject(session.tenantId, request.params.projectId);
    return project ? reply.send({ project }) : reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
  });

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/specification",
    async (request, reply) => {
      const session = localProductSession(request, config);
      const body = objectBody(request.body);
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (note.length < 2 || note.length > 2_000) {
        return reply.code(400).send({ code: "INVALID_SPECIFICATION_NOTE" });
      }
      const current = await repository.readProject(session.tenantId, request.params.projectId);
      if (!current) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      const project = await repository.updateProjectSpecification({
        tenantId: session.tenantId,
        projectId: request.params.projectId,
        specification: refineSpecification(current.specification, note),
        note,
        idempotencyKey: `spec-refined:${randomUUID()}`,
      });
      return reply.send({ project });
    },
  );

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/approve", async (request, reply) => {
    const session = localProductSession(request, config);
    const project = await repository.readProject(session.tenantId, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const digest = createHash("sha256").update(JSON.stringify(project.specification)).digest("hex");
    const accepted = await repository.appendSignal(session.tenantId, project.workflowId, {
      kind: "SPEC_APPROVED",
      idempotencyKey: `spec-approved:${project.workflowId}`,
      payload: { specificationDigest: `sha256:${digest}` },
    });
    return reply.code(accepted ? 202 : 200).send({ accepted });
  });

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/cancel", async (request, reply) => {
    const session = localProductSession(request, config);
    const project = await repository.readProject(session.tenantId, request.params.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
    const accepted = await repository.appendSignal(session.tenantId, project.workflowId, {
      kind: "CANCEL_REQUESTED",
      idempotencyKey: `cancel:${project.workflowId}`,
      payload: { requestedBy: session.displayName },
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
    if (typeof body.tenantId !== "string"
      || !["SPEC_APPROVED", "CANCEL_REQUESTED", "EXTERNAL_APPROVAL"].includes(String(body.kind))
      || typeof body.idempotencyKey !== "string"
      || !body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      return reply.code(400).send({ code: "INVALID_WORKFLOW_SIGNAL" });
    }
    const accepted = await repository.appendSignal(body.tenantId, request.params.workflowId, {
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
    for (const name of ["tenantId", "projectId", "workflowId", "jobId"]) {
      if (typeof body[name] !== "string") return reply.code(400).send({ code: "INVALID_SMOKE_IDS" });
    }
    if (!["E2E_TEST", "ARTIFACT_SIGN", "STEAM_CLEAN_INSTALL"].includes(String(body.jobKind))) {
      return reply.code(400).send({ code: "INVALID_SMOKE_JOB_KIND" });
    }
    await repository.createMacSmokeJob({
      tenantId: body.tenantId as string,
      projectId: body.projectId as string,
      workflowId: body.workflowId as string,
      jobId: body.jobId as string,
      jobKind: body.jobKind as "E2E_TEST" | "ARTIFACT_SIGN" | "STEAM_CLEAN_INSTALL",
    });
    return reply.code(201).send({ accepted: true });
  });

  app.post("/v1/dev/smoke/tenant-isolation", async (request, reply) => {
    authorizeWeb(request, config);
    if (process.env.NODE_ENV === "production") return reply.code(404).send({ code: "NOT_FOUND" });
    const result = await repository.verifyTenantIsolation({
      firstTenantId: randomUUID(),
      firstProjectId: randomUUID(),
      secondTenantId: randomUUID(),
      secondProjectId: randomUUID(),
      forbiddenProjectId: randomUUID(),
    });
    const passed = Object.values(result).every(Boolean);
    return reply.code(passed ? 200 : 500).send({ passed, checks: result });
  });

  app.get<{ Params: { tenantId: string; jobId: string } }>(
    "/v1/dev/smoke/mac-e2e/:tenantId/:jobId",
    async (request, reply) => {
      authorizeWeb(request, config);
      if (process.env.NODE_ENV === "production") return reply.code(404).send({ code: "NOT_FOUND" });
      const job = await repository.readJobStatus(request.params.tenantId, request.params.jobId);
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
  if (typeof body.tenantId !== "string" || typeof body.leaseToken !== "string") {
    throw new Error("Job tenant and lease identity are required");
  }
  return Object.freeze({ jobId, tenantId: body.tenantId, leaseToken: body.leaseToken });
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

const LOCAL_TENANT_ID = "00000000-0000-4000-8000-000000000001";

function localProductSession(request: FastifyRequest, config: CoreConfig) {
  authorizeWeb(request, config);
  if (process.env.NODE_ENV === "production") {
    throw Object.assign(new Error("A verified tenant session is required"), { statusCode: 401 });
  }
  return Object.freeze({
    tenantId: LOCAL_TENANT_ID,
    tenantName: "本地游戏工作室",
    displayName: "本地创作者",
    role: "OWNER",
  });
}

function projectNameFromConcept(concept: string): string {
  const firstSentence = concept.split(/[。！？.!?\n]/, 1)[0].trim();
  return (firstSentence || "未命名游戏").slice(0, 40);
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
