import { bodyObject, idempotencyKey, json, problemResponse } from "@/lib/control-plane/http";
import {
  deterministicConversationId,
  specDialogueBrokerRuntimeFromEnvironment,
  specOperationKey,
  verifyTrustedSpecSession,
} from "@/lib/spec-dialogue/broker";

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const local = localRuntimeUrl(request);
    if (local) return await proxyLocal(local, projectId, { method: "GET" });
    const runtime = specDialogueBrokerRuntimeFromEnvironment();
    if (!runtime) return brokerRequired();
    const principal = await verifyTrustedSpecSession(request, runtime.sessionHmacKey);
    const conversationId = await deterministicConversationId(principal.tenantId, projectId);
    return json({ data: await runtime.broker.snapshot({ tenantId: principal.tenantId, projectId, conversationId }) });
  } catch (error) { return problemResponse(error); }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const body = await bodyObject(request);
    if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["expectedRevision", "message"])) {
      return json({ error: { code: "INVALID_SPEC_DIALOGUE_REQUEST", message: "构想消息格式无效" } }, { status: 400 });
    }
    const local = localRuntimeUrl(request);
    if (local) return await proxyLocal(local, projectId, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey(request) },
      body: JSON.stringify(body),
    });
    const runtime = specDialogueBrokerRuntimeFromEnvironment();
    if (!runtime) return brokerRequired();
    const principal = await verifyTrustedSpecSession(request, runtime.sessionHmacKey);
    const conversationId = await deterministicConversationId(principal.tenantId, projectId);
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
  } catch (error) { return problemResponse(error); }
}

async function proxyLocal(endpoint: URL, projectId: string, init: RequestInit): Promise<Response> {
  if (!PROJECT.test(projectId)) return json({ error: { code: "INVALID_PROJECT", message: "项目标识无效" } }, { status: 400 });
  let upstream: Response;
  try {
    upstream = await fetch(new URL(`/v1/projects/${encodeURIComponent(projectId)}/conversation`, endpoint), {
      ...init,
      redirect: "manual",
      headers: { accept: "application/json", "x-deviludo-local-spec-runtime": "v1", ...(init.headers ?? {}) },
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

function localRuntimeUrl(request: Request): URL | null {
  const requestHost = new URL(request.url).hostname;
  if (requestHost !== "127.0.0.1" && requestHost !== "localhost") return null;
  const raw = process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_URL ?? "http://127.0.0.1:4313";
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password
    || url.search || url.hash || url.pathname !== "/") throw new Error("Local specification runtime URL is invalid");
  return url;
}
