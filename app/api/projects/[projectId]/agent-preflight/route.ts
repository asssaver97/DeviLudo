import { json, problemResponse } from "@/lib/control-plane/http";
import { readLocalDelivery } from "@/lib/local-delivery/store";
import type { LocalLockedAgentProfile } from "@/lib/local-delivery/model";
import type { LocalAgentPreflightResult } from "@/services/local-agent-runtime/src/contracts";
import { createLocalAgentRuntimeHeaders } from "@/services/local-agent-runtime/src/request-auth";
import { assertLoopbackTestRequest } from "@/lib/security/local-test-mode";

const AGENT_RUNTIME_URL = loopbackAgentRuntimeUrl();

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    assertLoopbackTestRequest(request, "本机 Agent 预检只在显式启用的 loopback 测试站可用");
    const { projectId } = await context.params;
    const delivery = await readLocalDelivery(projectId);
    if (!delivery.runId) {
      return json({ error: { code: "SPEC_APPROVAL_REQUIRED", message: "请先批准规格并锁定 Agent 运行" } }, { status: 409 });
    }

    const locked = delivery.lockedProfile;
    const command = JSON.stringify({
      projectId,
      runId: delivery.runId,
      profileRevisionId: locked.profileRevisionId,
      installationId: locked.installationId,
      agent: locked.agent,
      expectedVersion: locked.exactAgentVersion,
      imageDigest: locked.imageDigest,
      adapterVersion: locked.adapterVersion,
      providerRevisionId: locked.providerRevisionId,
      credentialVersionId: locked.credentialVersionId,
      model: locked.model,
      modelRoles: locked.modelRoles,
    });
    let response: Response;
    try {
      response = await fetch(`${AGENT_RUNTIME_URL}/v1/preflight`, {
        method: "POST",
        headers: { "content-type": "application/json", ...createLocalAgentRuntimeHeaders({
          method: "POST", path: "/v1/preflight", body: command,
        }) },
        body: command,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return json({ error: { code: "LOCAL_AGENT_RUNTIME_UNAVAILABLE", message: "本机 Agent 探针未启动；请使用 npm run local:dev" } }, { status: 503 });
    }
    const payload = await response.json() as { data?: unknown; error?: { message?: string } };
    if (!response.ok) {
      return json({ error: { code: "LOCAL_AGENT_PREFLIGHT_FAILED", message: payload.error?.message ?? "本机 Agent 预检失败" } }, { status: 502 });
    }
    return json({ data: validatePreflight(payload.data, projectId, delivery.runId, locked) });
  } catch (error) {
    return problemResponse(error);
  }
}

function validatePreflight(
  value: unknown,
  projectId: string,
  runId: string,
  locked: Awaited<ReturnType<typeof readLocalDelivery>>["lockedProfile"],
): LocalAgentPreflightResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本机 Agent 预检响应无效");
  const item = value as Record<string, unknown>;
  if (item.projectId !== projectId
    || item.runId !== runId
    || item.profileRevisionId !== locked.profileRevisionId
    || item.installationId !== locked.installationId
    || item.agent !== locked.agent
    || item.expectedVersion !== locked.exactAgentVersion
    || item.imageDigest !== locked.imageDigest
    || item.adapterVersion !== locked.adapterVersion
    || item.model !== locked.model
    || !sameModelRoles(item.modelRoles, locked.modelRoles)) {
    throw new Error("本机 Agent 预检绑定与锁定运行不一致");
  }
  if ((item.status !== "BLOCKED" && item.status !== "READY")
    || !["INSTALLATION_UNAVAILABLE", "INSTALLATION_MISMATCH", "ADAPTER_MISMATCH", "WORKER_IMAGE_MISMATCH", "WAITING_PROVIDER", "EXECUTION_DISABLED", "READY"].includes(String(item.code))
    || (item.agent !== "claude-code" && item.agent !== "codex-cli")
    || typeof item.message !== "string"
    || item.message.length > 500
    || (item.observedVersion !== null && typeof item.observedVersion !== "string")) {
    throw new Error("本机 Agent 预检状态无效");
  }
  if ((item.status === "READY") !== (item.code === "READY")) throw new Error("本机 Agent 预检状态矛盾");
  return item as unknown as LocalAgentPreflightResult;
}

function sameModelRoles(value: unknown, expected: LocalLockedAgentProfile["modelRoles"]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const roles = value as Record<string, unknown>;
  return roles.primaryModel === expected.primaryModel
    && roles.planningModel === expected.planningModel
    && roles.smallFastModel === expected.smallFastModel
    && roles.subagentModel === expected.subagentModel;
}

function loopbackAgentRuntimeUrl() {
  const url = new URL(process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_URL ?? "http://127.0.0.1:4312");
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") || url.username || url.password || url.search || url.hash) {
    throw new Error("DEVILUDO_LOCAL_AGENT_RUNTIME_URL must be a plain loopback HTTP origin");
  }
  return url.origin;
}
