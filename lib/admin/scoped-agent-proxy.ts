import { adminControlPlaneBrokerFromEnvironment, type ControlPlaneAdminPrincipal } from "@/lib/admin/control-plane-broker";
import { HttpProblem, json } from "@/lib/control-plane/http";
import { ScopedAgentAccessProblem } from "@/lib/admin/scoped-agent-access";

export async function forwardScopedAgentRequest(
  request: Request,
  downstreamPath: string,
  principal: ControlPlaneAdminPrincipal,
): Promise<Response> {
  if (request.method !== "GET" && !sameOrigin(request)) {
    return json({ error: { code: "CROSS_ORIGIN_MUTATION_REJECTED", message: "浏览器配置操作必须来自当前站点。" } }, { status: 403 });
  }
  let broker;
  try { broker = adminControlPlaneBrokerFromEnvironment(); }
  catch { return unavailable("AGENT_CONTROL_PLANE_MISCONFIGURED", "Agent 控制面连接配置无效。"); }
  if (!broker) return unavailable("AGENT_CONTROL_PLANE_REQUIRED", "生产配置需要独立的 Agent 控制面连接器。");
  try { return await broker.forward(request, downstreamPath, principal); }
  catch { return json({ error: { code: "AGENT_CONTROL_PLANE_UNAVAILABLE", message: "Agent 控制面未能完成请求。" } }, { status: 502 }); }
}

export function scopedAccessProblem(error: unknown): Response {
  if (error instanceof ScopedAgentAccessProblem) {
    return json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  if (error instanceof HttpProblem) {
    return json({ error: { code: error.code, message: error.message, details: error.details ?? null } }, { status: error.status });
  }
  return json({ error: { code: "AUTHENTICATION_REQUIRED", message: "需要有效的平台会话。" } }, { status: 401 });
}

export function rewrittenJsonRequest(request: Request, body: Record<string, unknown>, pathname = new URL(request.url).pathname): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const idempotency = request.headers.get("idempotency-key");
  const origin = request.headers.get("origin");
  const cookie = request.headers.get("cookie");
  if (idempotency) headers.set("idempotency-key", idempotency);
  if (origin) headers.set("origin", origin);
  if (cookie) headers.set("cookie", cookie);
  return new Request(new URL(pathname, request.url), { method: request.method, headers, body: JSON.stringify(body) });
}

export function localAdminRequest(
  request: Request,
  downstreamPath: string,
  role: ControlPlaneAdminPrincipal["role"],
  body?: Record<string, unknown>,
): Request {
  const url = new URL(`/api${downstreamPath}`, "http://127.0.0.1:3000");
  const headers = new Headers({ accept: "application/json", "x-deviludo-role": role });
  const idempotency = request.headers.get("idempotency-key");
  if (idempotency) headers.set("idempotency-key", idempotency);
  if (request.method !== "GET") headers.set("content-type", "application/json");
  return new Request(url, {
    method: request.method,
    headers,
    ...(request.method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin && !request.headers.has("cookie")) return true;
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}

function unavailable(code: string, message: string): Response {
  return json({ error: { code, message } }, { status: 503 });
}
