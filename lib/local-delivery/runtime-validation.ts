import { HttpProblem } from "@/lib/control-plane/http";
import type { LocalDeliverySnapshot, LocalValidationSnapshot } from "@/lib/local-delivery/model";
import { saveLocalValidation } from "@/lib/local-delivery/store";
import { createLocalRuntimeHeaders } from "@/services/local-runtime/src/request-auth";

export async function runAndSaveLocalValidation(
  projectId: string,
  delivery: LocalDeliverySnapshot,
  commandKey: string,
) {
  if (!delivery.runId) {
    throw new HttpProblem(409, "SPEC_APPROVAL_REQUIRED", "请先批准规格并锁定本地运行");
  }
  if (delivery.stage === "AWAITING_SPEC_APPROVAL" || delivery.stage === "RELEASED") {
    throw new HttpProblem(409, "INVALID_DELIVERY_STAGE", "当前交付阶段不能运行本机验证");
  }

  const command = JSON.stringify({
    projectId,
    runId: delivery.runId,
    specRevisionId: delivery.specRevisionId,
    targetMatrix: delivery.targetMatrix,
  });
  let runtimeResponse: Response;
  try {
    runtimeResponse = await fetch(`${loopbackRuntimeUrl()}/v1/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createLocalRuntimeHeaders({ method: "POST", path: "/v1/runs", body: command }),
      },
      body: command,
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new HttpProblem(503, "LOCAL_RUNTIME_UNAVAILABLE", "本机执行服务未启动；请使用 npm run local:dev");
  }
  if (runtimeResponse.status >= 300 && runtimeResponse.status < 400) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机执行服务返回了不安全的重定向");
  }
  let payload: { data?: unknown; error?: { message?: string } };
  try {
    payload = await runtimeResponse.json() as typeof payload;
  } catch {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机执行服务未返回有效 JSON");
  }
  if (!runtimeResponse.ok) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_FAILED", payload.error?.message ?? "本机 Godot 验证失败");
  }
  const validation = validateLocalValidationEvidence(
    payload.data,
    projectId,
    delivery.runId,
    delivery.specRevisionId,
    delivery.targetMatrix,
  );
  return saveLocalValidation(projectId, validation, commandKey);
}

export function validateLocalValidationEvidence(
  value: unknown,
  projectId: string,
  runId: string,
  specRevisionId: string,
  targetMatrix: LocalValidationSnapshot["targetMatrix"],
): Omit<LocalValidationSnapshot, "valid"> {
  if (!value || typeof value !== "object") throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机证据响应无效");
  const item = value as Record<string, unknown>;
  if (item.projectId !== projectId || item.runId !== runId || item.specRevisionId !== specRevisionId) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_BINDING_MISMATCH", "本机证据绑定与锁定运行不一致");
  }
  if (item.schemaVersion !== 2 || JSON.stringify(item.targetMatrix) !== JSON.stringify(targetMatrix)) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_BINDING_MISMATCH", "本机证据目标矩阵与锁定运行不一致");
  }
  if (item.platform !== "macos" || item.fixtureOnly !== true) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_BINDING_MISMATCH", "本机证据缺少真实 macOS 执行平台绑定");
  }
  if (!validEvidenceStatus(item.status)) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机证据状态无效");
  }
  if (!validReleaseGate(item.releaseGate)) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机证据发布门禁无效");
  }
  if (!/^[a-f0-9]{40}$/.test(String(item.candidateSha)) || !/^[a-f0-9]{64}$/.test(String(item.bundleDigest))) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机证据摘要无效");
  }
  if (!/^[a-f0-9]{64}$/.test(String(item.sourceDigest)) || !/^EV-LOCAL-[A-F0-9]{12}$/.test(String(item.evidenceId))) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机证据标识或源码摘要无效");
  }
  if (typeof item.godotVersion !== "string" || !item.godotVersion.startsWith("4.")) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机 Godot 版本无效");
  }
  if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机证据时间无效");
  }
  if (!Array.isArray(item.checks) || item.checks.length < 4 || item.checks.some((check) => !validCheck(check))) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机证据检查列表无效");
  }
  if (!validArtifactDigests(item.artifactDigests)) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机证据制品摘要无效");
  }
  const failed = item.checks.some((check) => (check as Record<string, unknown>).status === "FAILED");
  const waiting = item.checks.some((check) => (check as Record<string, unknown>).status === "WAITING_DEPENDENCY");
  const validTerminal = item.status === "TESTS_PASSED" && item.releaseGate === "LOCAL_VALIDATION_PASSED" && !failed && !waiting;
  const validWait = item.status === "WAITING_DEPENDENCY" && item.releaseGate === "WAITING_EXPORT_TEMPLATES" && !failed && waiting;
  const validFailure = item.status === "FAILED" && item.releaseGate === "TESTS_FAILED" && failed;
  if (!validTerminal && !validWait && !validFailure) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机证据状态与检查结果不一致");
  }
  return {
    evidenceId: String(item.evidenceId),
    status: item.status,
    releaseGate: item.releaseGate,
    candidateSha: String(item.candidateSha),
    sourceDigest: String(item.sourceDigest),
    bundleDigest: String(item.bundleDigest),
    godotVersion: String(item.godotVersion),
    targetMatrix: Object.freeze([...targetMatrix]),
    platform: "macos",
    fixtureOnly: true,
    checks: item.checks as LocalValidationSnapshot["checks"],
    createdAt: String(item.createdAt),
  };
}

function loopbackRuntimeUrl() {
  const url = new URL(process.env.DEVILUDO_LOCAL_RUNTIME_URL ?? "http://127.0.0.1:4311");
  if (url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.pathname !== "/"
    || url.username || url.password || url.search || url.hash) {
    throw new HttpProblem(500, "LOCAL_RUNTIME_CONFIGURATION_INVALID", "DEVILUDO_LOCAL_RUNTIME_URL must be a plain loopback HTTP origin");
  }
  return url.origin;
}

function validEvidenceStatus(value: unknown): value is LocalValidationSnapshot["status"] {
  return value === "TESTS_PASSED" || value === "WAITING_DEPENDENCY" || value === "FAILED";
}

function validReleaseGate(value: unknown): value is LocalValidationSnapshot["releaseGate"] {
  return value === "WAITING_EXPORT_TEMPLATES" || value === "LOCAL_VALIDATION_PASSED" || value === "TESTS_FAILED";
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
