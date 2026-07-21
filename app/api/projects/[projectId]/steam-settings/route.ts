import { json } from "@/lib/control-plane/http";
import { projectAgentPrincipal } from "@/lib/admin/scoped-agent-access";
import { scopedAccessProblem } from "@/lib/admin/scoped-agent-proxy";
import { steamEnrollmentRuntimeFromEnvironment, type SteamBrokerPrincipal } from "@/lib/connections/steam-broker";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    if (isLoopbackTestRequest(request)) return localSafetyBoundary(projectId);
    const runtime = runtimeOrProblem();
    if (runtime instanceof Response) return runtime;
    const principal = await projectAgentPrincipal(request, projectId);
    try {
      return json({ data: await runtime.broker.projectConfigurationStatus(steamPrincipal(principal), projectId) }, {
        headers: { "cache-control": "no-store" },
      });
    } catch {
      return json({ error: { code: "STEAM_PROJECT_CONFIGURATION_UNAVAILABLE", message: "暂时无法验证项目的 Steam 发布配置。" } }, {
        status: 502, headers: { "cache-control": "no-store" },
      });
    }
  } catch (error) { return scopedAccessProblem(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    if (isLoopbackTestRequest(request)) return localSafetyBoundary(projectId);
    if (!sameOrigin(request)) {
      return json({ error: { code: "CROSS_ORIGIN_MUTATION_REJECTED", message: "Steam 配置操作必须来自当前站点。" } }, { status: 403 });
    }
    if (request.headers.has("content-type") || request.headers.has("transfer-encoding")
      || ![null, "0"].includes(request.headers.get("content-length"))) {
      return json({ error: { code: "STEAM_PROJECT_CONFIGURATION_BODY_REJECTED",
        message: "主站配置入口不接受 App、Depot、分支或密码字段。" } }, { status: 400 });
    }
    const runtime = runtimeOrProblem();
    if (runtime instanceof Response) return runtime;
    const principal = await projectAgentPrincipal(request, projectId);
    if (principal.role === "Auditor") {
      return json({ error: { code: "FORBIDDEN", message: "审计账号只能查看 Steam 发布配置。" } }, { status: 403 });
    }
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(idempotencyKey)) {
      return json({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "配置操作需要有效的幂等键。" } }, { status: 400 });
    }
    try {
      const result = await runtime.broker.beginProjectConfiguration(steamPrincipal(principal), projectId, idempotencyKey);
      return json({ data: result }, { status: result.state === "READY" ? 200 : 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      const conflict = error instanceof Error && error.message.includes("status 409");
      return json({ error: { code: conflict ? "IDEMPOTENCY_CONFLICT" : "STEAM_PROJECT_CONFIGURATION_REJECTED",
        message: conflict ? "幂等键已绑定到另一项配置。" : "无法开始 Steam 项目配置；请先验证 Build Account 会话和 App 权限。" } }, {
        status: conflict ? 409 : 502, headers: { "cache-control": "no-store" },
      });
    }
  } catch (error) { return scopedAccessProblem(error); }
}

function steamPrincipal(principal: Awaited<ReturnType<typeof projectAgentPrincipal>>): SteamBrokerPrincipal {
  if (!principal.tenantId) throw new Error("Project Steam principal is missing its tenant");
  return Object.freeze({ tenantId: principal.tenantId, userId: principal.actorId, sessionBinding: principal.sessionId });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin && !request.headers.has("cookie")) return true;
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}

function localSafetyBoundary(projectId: string): Response {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(projectId)) {
    return json({ error: { code: "PROJECT_ACCESS_NOT_FOUND", message: "本地项目不存在。" } }, { status: 404 });
  }
  return json({ error: { code: "STEAM_PROJECT_CONFIGURATION_BROKER_REQUIRED",
    message: "本地站点未接入隔离的 Steam 发布配置 Broker；不会接收或伪造 Steam 分支密码。" } }, {
    status: 503, headers: { "cache-control": "no-store" },
  });
}

function runtimeOrProblem() {
  try {
    const runtime = steamEnrollmentRuntimeFromEnvironment();
    if (runtime) return runtime;
  } catch {
    return json({ error: { code: "STEAM_PROJECT_CONFIGURATION_MISCONFIGURED", message: "Steam 发布配置 Broker 参数无效。" } }, { status: 503 });
  }
  return json({ error: { code: "STEAM_PROJECT_CONFIGURATION_BROKER_REQUIRED",
    message: "本地站点未接入隔离的 Steam 发布配置 Broker；不会在主站收集分支密码。" } }, {
    status: 503, headers: { "cache-control": "no-store" },
  });
}
