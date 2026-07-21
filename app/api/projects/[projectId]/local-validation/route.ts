import { idempotencyKey, json, problemResponse } from "@/lib/control-plane/http";
import { readLocalDelivery, saveLocalValidation } from "@/lib/local-delivery/store";
import type { LocalValidationSnapshot } from "@/lib/local-delivery/model";
import { assertLoopbackTestRequest } from "@/lib/security/local-test-mode";
import { createLocalRuntimeHeaders } from "@/services/local-runtime/src/request-auth";

const RUNTIME_URL = loopbackRuntimeUrl();

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    assertLoopbackTestRequest(request, "本机验证 API 只在显式启用的 loopback 测试站可用");
    const { projectId } = await context.params;
    const delivery = await readLocalDelivery(projectId);
    return json({ data: delivery.localValidation, meta: { runId: delivery.runId, stage: delivery.stage } });
  } catch (error) {
    return problemResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    assertLoopbackTestRequest(request, "本机验证 API 只在显式启用的 loopback 测试站可用");
    const { projectId } = await context.params;
    const delivery = await readLocalDelivery(projectId);
    if (!delivery.runId) {
      return json({ error: { code: "SPEC_APPROVAL_REQUIRED", message: "请先批准规格并锁定本地运行" } }, { status: 409 });
    }
    if (delivery.stage === "AWAITING_SPEC_APPROVAL" || delivery.stage === "RELEASED") {
      return json({ error: { code: "INVALID_DELIVERY_STAGE", message: "当前交付阶段不能运行本机验证" } }, { status: 409 });
    }

    const command = JSON.stringify({ projectId, runId: delivery.runId, specRevisionId: delivery.specRevisionId });
    let runtimeResponse: Response;
    try {
      runtimeResponse = await fetch(`${RUNTIME_URL}/v1/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", ...createLocalRuntimeHeaders({
          method: "POST", path: "/v1/runs", body: command,
        }) },
        body: command,
        signal: AbortSignal.timeout(90_000),
      });
    } catch {
      return json({ error: { code: "LOCAL_RUNTIME_UNAVAILABLE", message: "本机执行服务未启动；请使用 npm run local:dev" } }, { status: 503 });
    }
    const payload = await runtimeResponse.json() as { data?: unknown; error?: { message?: string } };
    if (!runtimeResponse.ok) {
      return json({ error: { code: "LOCAL_RUNTIME_FAILED", message: payload.error?.message ?? "本机 Godot 验证失败" } }, { status: 502 });
    }
    const validation = validateEvidence(payload.data, projectId, delivery.runId, delivery.specRevisionId);
    const saved = await saveLocalValidation(
      projectId,
      validation,
      `local-validation:${projectId}:${idempotencyKey(request)}`,
    );
    return json(
      { data: saved.snapshot.localValidation, delivery: saved.snapshot, meta: { idempotentReplay: saved.replayed } },
      { status: saved.replayed ? 200 : 201 },
    );
  } catch (error) {
    return problemResponse(error);
  }
}

function loopbackRuntimeUrl() {
  const url = new URL(process.env.DEVILUDO_LOCAL_RUNTIME_URL ?? "http://127.0.0.1:4311");
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") || url.username || url.password || url.search || url.hash) {
    throw new Error("DEVILUDO_LOCAL_RUNTIME_URL must be a plain loopback HTTP origin");
  }
  return url.origin;
}

function validateEvidence(
  value: unknown,
  projectId: string,
  runId: string,
  specRevisionId: string,
): Omit<LocalValidationSnapshot, "valid"> {
  if (!value || typeof value !== "object") throw new Error("本机证据响应无效");
  const item = value as Record<string, unknown>;
  if (item.projectId !== projectId || item.runId !== runId || item.specRevisionId !== specRevisionId) {
    throw new Error("本机证据绑定与锁定运行不一致");
  }
  if (item.status !== "TESTS_PASSED" && item.status !== "FAILED") throw new Error("本机证据状态无效");
  if (!["WAITING_EXPORT_TEMPLATES", "LOCAL_VALIDATION_PASSED", "TESTS_FAILED"].includes(String(item.releaseGate))) {
    throw new Error("本机证据发布门禁无效");
  }
  if (!/^[a-f0-9]{40}$/.test(String(item.candidateSha)) || !/^[a-f0-9]{64}$/.test(String(item.bundleDigest))) {
    throw new Error("本机证据摘要无效");
  }
  if (!/^[a-f0-9]{64}$/.test(String(item.sourceDigest)) || !/^EV-LOCAL-[A-F0-9]{12}$/.test(String(item.evidenceId))) {
    throw new Error("本机证据标识或源码摘要无效");
  }
  if (typeof item.godotVersion !== "string" || !item.godotVersion.startsWith("4.")) throw new Error("本机 Godot 版本无效");
  if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) throw new Error("本机证据时间无效");
  if (!Array.isArray(item.checks) || item.checks.length < 4 || item.checks.some((check) => !validCheck(check))) {
    throw new Error("本机证据检查列表无效");
  }
  if (!validArtifactDigests(item.artifactDigests)) throw new Error("本机证据制品摘要无效");
  const failed = item.checks.some((check) => (check as Record<string, unknown>).status === "FAILED");
  if ((item.status === "FAILED") !== failed || (item.releaseGate === "TESTS_FAILED") !== failed) {
    throw new Error("本机证据状态与检查结果不一致");
  }
  return {
    evidenceId: String(item.evidenceId),
    status: item.status,
    releaseGate: item.releaseGate as LocalValidationSnapshot["releaseGate"],
    candidateSha: String(item.candidateSha),
    sourceDigest: String(item.sourceDigest),
    bundleDigest: String(item.bundleDigest),
    godotVersion: String(item.godotVersion),
    checks: item.checks as LocalValidationSnapshot["checks"],
    createdAt: String(item.createdAt),
  };
}

function validCheck(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const check = value as Record<string, unknown>;
  return ["import", "boot", "core-loop", "save-load", "performance", "macos-export"].includes(String(check.name))
    && ["PASSED", "FAILED", "WAITING_DEPENDENCY"].includes(String(check.status))
    && typeof check.durationMs === "number"
    && Number.isFinite(check.durationMs)
    && check.durationMs >= 0
    && typeof check.detail === "string";
}

function validArtifactDigests(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const digests = value as Record<string, unknown>;
  return /^[a-f0-9]{64}$/.test(String(digests["junit.xml"]))
    && /^[a-f0-9]{64}$/.test(String(digests["godot.log"]));
}
