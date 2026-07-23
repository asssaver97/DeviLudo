import { bodyObject, idempotencyKey, json, problemResponse } from "@/lib/control-plane/http";
import {
  authorizeLocalProjectAccess,
  authorizeProjectAccess,
  ProjectAccessError,
  projectAccessResponse,
} from "@/lib/projects/project-read-access";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";
import {
  deterministicConversationId,
  specDialogueBrokerRuntimeFromEnvironment,
  specOperationKey,
} from "@/lib/spec-dialogue/broker";
import { createLocalSpecRuntimeHeaders } from "@/services/local-spec-runtime/src/request-auth";

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const local = localRuntimeUrl(request);
    if (local) {
      await authorizeLocalProjectAccess(projectId);
      return await proxyLocal(local, projectId, { method: "GET" });
    }
    if (!UUID.test(projectId)) return invalidProject();
    const runtime = specDialogueBrokerRuntimeFromEnvironment();
    if (!runtime) return brokerRequired();
    const principal = await authorizeProjectAccess(request, projectId);
    const conversationId = await deterministicConversationId(principal.tenantId, projectId);
    return json({ data: await runtime.broker.snapshot({ tenantId: principal.tenantId, projectId, conversationId }) });
  } catch (error) { return accessProblem(error); }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const body = await bodyObject(request);
    const keys = Object.keys(body).sort();
    const hasConversation = "conversationId" in body;
    if (JSON.stringify(keys) !== JSON.stringify(hasConversation
      ? ["conversationId", "expectedRevision", "message"]
      : ["expectedRevision", "message"])) {
      return json({ error: { code: "INVALID_SPEC_DIALOGUE_REQUEST", message: "构想消息格式无效" } }, { status: 400 });
    }
    const local = localRuntimeUrl(request);
    if (local) {
      await authorizeLocalProjectAccess(projectId);
      return await proxyLocal(local, projectId, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey(request) },
        body: JSON.stringify({ expectedRevision: body.expectedRevision, message: body.message }),
      });
    }
    if (!UUID.test(projectId)) return invalidProject();
    const runtime = specDialogueBrokerRuntimeFromEnvironment();
    if (!runtime) return brokerRequired();
    const principal = await authorizeProjectAccess(request, projectId);
    let conversationId = await deterministicConversationId(principal.tenantId, projectId);
    if (hasConversation) {
      if (typeof body.conversationId !== "string") throw new Error("Specification conversation binding is invalid");
      const snapshot = await runtime.broker.snapshot({
        tenantId: principal.tenantId,
        projectId,
        conversationId: body.conversationId,
      });
      if (!snapshot || snapshot.state !== "DRAFT" || snapshot.revision !== body.expectedRevision) {
        throw new Error("Specification conversation binding is not the current draft");
      }
      conversationId = snapshot.conversationId;
    }
    const commandKey = idempotencyKey(request);
    const snapshot = await runtime.broker.send({
      tenantId: principal.tenantId,
      projectId,
      conversationId,
      actorId: principal.userId,
      operationKey: await specOperationKey({ tenantId: principal.tenantId, projectId, conversationId, userId: principal.userId, idempotencyKey: commandKey }),
      expectedRevision: body.expectedRevision,
      message: body.message,
    });
    return json({ data: snapshot }, { status: 201 });
  } catch (error) { return accessProblem(error); }
}

async function proxyLocal(endpoint: URL, projectId: string, init: RequestInit): Promise<Response> {
  if (!PROJECT.test(projectId)) return json({ error: { code: "INVALID_PROJECT", message: "项目标识无效" } }, { status: 400 });
  const path = `/v1/projects/${encodeURIComponent(projectId)}/conversation`;
  const method = init.method === "POST" ? "POST" : "GET";
  const body = typeof init.body === "string" ? init.body : "";
  let upstream: Response;
  try {
    upstream = await fetch(new URL(path, endpoint), {
      ...init,
      redirect: "manual",
      headers: { accept: "application/json", ...(init.headers ?? {}), ...createLocalSpecRuntimeHeaders({ method, path, body }) },
      signal: AbortSignal.timeout(15_000),
    });
    if (upstream.status >= 300 && upstream.status < 400) throw new Error("Local specification runtime redirected the request");
  } catch {
    return json({ error: { code: "LOCAL_SPEC_RUNTIME_UNAVAILABLE", message: "本机构想服务未启动；请使用 npm run local:dev" } }, { status: 503 });
  }
  const payload = await upstream.json() as unknown;
  return json(payload, { status: upstream.status });
}

function brokerRequired(): Response {
  return json({ error: { code: "SPEC_DIALOGUE_BROKER_REQUIRED", message: "规格对话需要独立的生产 Broker；当前入口不会在 Web 进程内伪造模型回复。" } }, { status: 503 });
}

function invalidProject(): Response {
  return json({ error: { code: "INVALID_PROJECT", message: "项目标识无效" } }, { status: 400 });
}

function accessProblem(error: unknown): Response {
  return error instanceof ProjectAccessError ? projectAccessResponse(error) : problemResponse(error);
}

function localRuntimeUrl(request: Request): URL | null {
  if (!isLoopbackTestRequest(request)) return null;
  const raw = process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_URL ?? "http://127.0.0.1:4313";
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password
    || url.search || url.hash || url.pathname !== "/") throw new Error("Local specification runtime URL is invalid");
  return url;
}
