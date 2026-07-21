import { idempotencyKey, json, problemResponse } from "@/lib/control-plane/http";
import { readLocalDelivery, saveLocalAgentExecution } from "@/lib/local-delivery/store";
import type { LocalAgentExecutionReceipt } from "@/services/local-agent-runtime/src/contracts";
import { createLocalAgentRuntimeHeaders } from "@/services/local-agent-runtime/src/request-auth";
import { assertLoopbackTestRequest } from "@/lib/security/local-test-mode";

const AGENT_RUNTIME_URL = loopbackAgentRuntimeUrl();

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    assertLoopbackTestRequest(request, "本机 Agent 运行 API 只在显式启用的 loopback 测试站可用");
    const { projectId } = await context.params;
    const delivery = await readLocalDelivery(projectId);
    if (!delivery.runId) {
      return json({ error: { code: "SPEC_APPROVAL_REQUIRED", message: "请先批准规格并锁定 Agent 运行" } }, { status: 409 });
    }
    if (delivery.stage !== "AGENT_QUEUED" && delivery.stage !== "AGENT_RUNNING") {
      return json({ error: { code: "INVALID_DELIVERY_STAGE", message: "当前阶段不能启动新的 Agent 尝试" } }, { status: 409 });
    }
    const commandKey = idempotencyKey(request);
    const locked = delivery.lockedProfile;
    const attemptId = `ATT-${delivery.runId}`;
    const executionRequest = {
      tenantId: "tenant-local",
      projectId,
      runId: delivery.runId,
      attemptId,
      specRevisionId: delivery.specRevisionId,
      testPlanRevisionId: locked.testPlanRevisionId,
      profileRevisionId: locked.profileRevisionId,
      installationId: locked.installationId,
      agent: locked.agent,
      expectedVersion: locked.exactAgentVersion,
      imageDigest: locked.imageDigest,
      adapterVersion: locked.adapterVersion,
      providerRevisionId: locked.providerRevisionId,
      providerProtocol: locked.providerProtocol,
      credentialVersionId: locked.credentialVersionId,
      model: locked.model,
      modelRoles: locked.modelRoles,
      budget: locked.budget,
      timeoutSeconds: locked.timeoutSeconds,
      prompt: `Implement the approved immutable game specification ${delivery.specRevisionId}. Do not modify platform test policy, credentials, hooks, plugins, MCP configuration, or files outside the workspace.`,
    };
    const command = JSON.stringify(executionRequest);

    let runtimeResponse: Response;
    try {
      runtimeResponse = await fetch(`${AGENT_RUNTIME_URL}/v1/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", ...createLocalAgentRuntimeHeaders({
          method: "POST", path: "/v1/runs", body: command,
        }) },
        body: command,
        signal: AbortSignal.timeout(15 * 60_000),
      });
    } catch {
      return json({ error: { code: "LOCAL_AGENT_RUNTIME_UNAVAILABLE", message: "本机 Agent 运行服务未启动；请使用 npm run local:dev" } }, { status: 503 });
    }
    const payload = await runtimeResponse.json() as { data?: unknown; error?: { code?: string; message?: string } };
    if (!runtimeResponse.ok) {
      const status = runtimeResponse.status === 409 || runtimeResponse.status === 503 ? runtimeResponse.status : 502;
      return json({ error: { code: payload.error?.code ?? "LOCAL_AGENT_RUN_FAILED", message: payload.error?.message ?? "本机 Agent 运行被阻止" }, data: payload.data }, { status });
    }
    let receipt: LocalAgentExecutionReceipt;
    try {
      receipt = validateReceipt(payload.data, executionRequest);
    } catch {
      return json({ error: { code: "INVALID_LOCAL_AGENT_RECEIPT", message: "本机 Agent 运行回执未通过锁定绑定校验" } }, { status: 502 });
    }
    const saved = await saveLocalAgentExecution(projectId, receipt, `agent-run:${projectId}:${commandKey}`);
    return json(
      { data: receipt, delivery: saved.snapshot, meta: { idempotentReplay: saved.replayed } },
      { status: saved.replayed ? 200 : 201 },
    );
  } catch (error) {
    return problemResponse(error);
  }
}

function validateReceipt(
  value: unknown,
  expected: {
    projectId: string;
    tenantId: string;
    runId: string;
    attemptId: string;
    specRevisionId: string;
    testPlanRevisionId: string;
    profileRevisionId: string;
    installationId: string;
    imageDigest: string;
    adapterVersion: string;
    providerRevisionId: string;
    credentialVersionId: string;
    model: string;
    modelRoles: { primaryModel: string; planningModel: string; smallFastModel: string; subagentModel: string };
    agent: string;
    budget: { maxTurns: number; maxCostUsd: number; maxInputTokens: number; maxOutputTokens: number };
    timeoutSeconds: number;
  },
): LocalAgentExecutionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本机 Agent 运行回执无效");
  const receipt = value as Record<string, unknown>;
  for (const key of ["tenantId", "projectId", "runId", "attemptId", "specRevisionId", "testPlanRevisionId", "profileRevisionId", "installationId", "imageDigest", "adapterVersion", "providerRevisionId", "credentialVersionId", "model", "agent", "timeoutSeconds"] as const) {
    if (receipt[key] !== expected[key]) throw new Error("本机 Agent 运行回执与锁定任务不一致");
  }
  const candidate = object(receipt.candidate);
  const usage = object(receipt.usage);
  const budget = object(receipt.budget);
  const modelRoles = object(receipt.modelRoles);
  if (receipt.schemaVersion !== 1 || receipt.status !== "completed"
    || typeof receipt.summary !== "string" || !receipt.summary || receipt.summary.length > 4_000
    || (receipt.sessionId !== undefined && (typeof receipt.sessionId !== "string" || receipt.sessionId.length > 256))
    || !Number.isSafeInteger(usage.inputTokens) || (usage.inputTokens as number) < 0
    || !Number.isSafeInteger(usage.outputTokens) || (usage.outputTokens as number) < 0
    || typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0
    || (usage.inputTokens as number) > expected.budget.maxInputTokens
    || (usage.outputTokens as number) > expected.budget.maxOutputTokens
    || usage.costUsd > expected.budget.maxCostUsd
    || candidate.scmProxy !== "local-git-proxy-v1"
    || typeof candidate.branch !== "string" || !validCandidateBranch(candidate.branch)
    || typeof candidate.baseCommitSha !== "string" || !/^[a-f0-9]{40}$/.test(candidate.baseCommitSha)
    || typeof candidate.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(candidate.commitSha)
    || candidate.baseCommitSha === candidate.commitSha
    || typeof candidate.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sourceDigest)
    || candidate.draftPullRequest !== null
    || budget.maxTurns !== expected.budget.maxTurns
    || budget.maxCostUsd !== expected.budget.maxCostUsd
    || budget.maxInputTokens !== expected.budget.maxInputTokens
    || budget.maxOutputTokens !== expected.budget.maxOutputTokens
    || modelRoles.primaryModel !== expected.modelRoles.primaryModel
    || modelRoles.planningModel !== expected.modelRoles.planningModel
    || modelRoles.smallFastModel !== expected.modelRoles.smallFastModel
    || modelRoles.subagentModel !== expected.modelRoles.subagentModel
    || !validChangedFiles(candidate.changedFiles)
    || !validStrings(receipt.warnings, 100, 1_000)
    || typeof receipt.completedAt !== "string" || !Number.isFinite(Date.parse(receipt.completedAt))) {
    throw new Error("本机 Agent 运行回执内容无效");
  }
  return value as LocalAgentExecutionReceipt;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本机 Agent 运行回执结构无效");
  return value as Record<string, unknown>;
}

function validStrings(value: unknown, maxItems: number, maxLength: number): boolean {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string" && item.length <= maxLength);
}

function validChangedFiles(value: unknown): boolean {
  return validStrings(value, 10_000, 500)
    && (value as string[]).length > 0
    && new Set(value as string[]).size === (value as string[]).length
    && (value as string[]).every((item) => !item.startsWith("/")
      && !item.includes("\\")
      && !item.split("/").some((part) => part === "" || part === "." || part === ".."));
}

function validCandidateBranch(value: string): boolean {
  return value.length <= 128
    && /^deviludo\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i.test(value)
    && !value.includes("..")
    && !value.endsWith(".lock");
}

function loopbackAgentRuntimeUrl() {
  const url = new URL(process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_URL ?? "http://127.0.0.1:4312");
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") || url.username || url.password || url.search || url.hash) {
    throw new Error("DEVILUDO_LOCAL_AGENT_RUNTIME_URL must be a plain loopback HTTP origin");
  }
  return url.origin;
}
