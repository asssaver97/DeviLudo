import { HttpProblem } from "@/lib/control-plane/http";
import type { LocalDeliverySnapshot, LocalMainValidationSnapshot } from "@/lib/local-delivery/model";
import { saveLocalMainValidation } from "@/lib/local-delivery/store";
import { createLocalRuntimeHeaders } from "@/services/local-runtime/src/request-auth";

export async function runAndSaveLocalMainValidation(
  projectId: string,
  delivery: LocalDeliverySnapshot,
  commandKey: string,
) {
  const candidate = delivery.localValidation;
  if (!delivery.runId || !candidate?.valid
    || candidate.status !== "TESTS_PASSED"
    || candidate.releaseGate !== "LOCAL_VALIDATION_PASSED") {
    throw new HttpProblem(409, "LOCAL_CANDIDATE_EVIDENCE_REQUIRED", "main SHA 门禁缺少已接受的候选证据");
  }
  if (delivery.stage !== "MERGING" && delivery.stage !== "MAIN_GATE_RUNNING") {
    throw new HttpProblem(409, "INVALID_DELIVERY_STAGE", "当前交付阶段不能运行 main SHA 门禁");
  }

  const body = JSON.stringify({
    projectId,
    runId: delivery.runId,
    specRevisionId: delivery.specRevisionId,
    targetMatrix: delivery.targetMatrix,
    candidateEvidenceId: candidate.evidenceId,
    candidateBundleDigest: candidate.bundleDigest,
    candidateSha: candidate.candidateSha,
    sourceDigest: candidate.sourceDigest,
  });
  const path = "/v1/main-gates";
  let response: Response;
  try {
    response = await fetch(`${loopbackRuntimeUrl()}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createLocalRuntimeHeaders({ method: "POST", path, body }),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new HttpProblem(503, "LOCAL_RUNTIME_UNAVAILABLE", "本机执行服务未启动；请使用 npm run local:dev");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机执行服务返回了不安全的重定向");
  }
  let payload: { data?: unknown; error?: { message?: string } };
  try {
    payload = await response.json() as typeof payload;
  } catch {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机 main 门禁未返回有效 JSON");
  }
  if (!response.ok) {
    throw new HttpProblem(502, "LOCAL_MAIN_GATE_FAILED", payload.error?.message ?? "本机 main SHA 门禁失败");
  }
  const validation = validateLocalMainValidationEvidence(payload.data, delivery);
  return saveLocalMainValidation(projectId, validation, commandKey);
}

export function validateLocalMainValidationEvidence(
  value: unknown,
  delivery: LocalDeliverySnapshot,
): Omit<LocalMainValidationSnapshot, "valid"> {
  const candidate = delivery.localValidation;
  if (!delivery.runId || !candidate) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_BINDING_MISMATCH", "锁定候选证据不存在");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "main SHA 门禁证据响应无效");
  }
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || item.phase !== "MAIN_SHA_GATE"
    || item.projectId !== delivery.projectId
    || item.runId !== delivery.runId
    || item.specRevisionId !== delivery.specRevisionId
    || JSON.stringify(item.targetMatrix) !== JSON.stringify(delivery.targetMatrix)
    || item.platform !== "macos" || item.fixtureOnly !== true
    || item.candidateEvidenceId !== candidate.evidenceId
    || item.candidateBundleDigest !== candidate.bundleDigest
    || item.candidateSha !== candidate.candidateSha
    || item.sourceDigest !== candidate.sourceDigest) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_BINDING_MISMATCH", "main SHA 门禁证据与已接受候选不一致");
  }
  if (!/^EV-MAIN-[A-F0-9]{12}$/.test(String(item.evidenceId))
    || !/^[a-f0-9]{64}$/.test(String(item.bundleDigest))
    || !/^[a-f0-9]{40}$/.test(String(item.mainSha))
    || item.mainSha !== item.candidateSha
    || !/^[a-f0-9]{64}$/.test(String(item.mainSourceDigest))
    || item.mainSourceDigest !== item.sourceDigest
    || typeof item.godotVersion !== "string" || !item.godotVersion.startsWith("4.")
    || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "main SHA 门禁证据标识或摘要无效");
  }
  if (!validMergeReceipt(item.mergeReceipt, item)
    || !Array.isArray(item.checks) || item.checks.length < 4 || item.checks.some((check) => !validCheck(check))
    || !validArtifactDigests(item.artifactDigests)) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "main SHA 门禁合并或检查证据无效");
  }
  const checks = item.checks as LocalMainValidationSnapshot["checks"];
  const failed = checks.some((check) => check.status === "FAILED");
  const waiting = checks.some((check) => check.status === "WAITING_DEPENDENCY");
  const passed = item.status === "TESTS_PASSED" && item.releaseGate === "MAIN_VALIDATION_PASSED" && !failed && !waiting;
  const wait = item.status === "WAITING_DEPENDENCY" && item.releaseGate === "WAITING_EXPORT_TEMPLATES" && !failed && waiting;
  const failure = item.status === "FAILED" && item.releaseGate === "TESTS_FAILED" && failed;
  if (!passed && !wait && !failure) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "main SHA 门禁状态与检查结果不一致");
  }
  if (passed && !checks.some((check) => check.name === "macos-export-boot" && check.status === "PASSED")) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "main SHA 门禁缺少导出包启动证据");
  }
  const buildArtifact = parseBuildArtifact(item.buildArtifact);
  if ((passed && !buildArtifact) || (!passed && item.buildArtifact !== null) || (item.buildArtifact !== null && !buildArtifact)) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "main SHA 门禁状态与构建物授权不一致");
  }
  return {
    schemaVersion: 1,
    evidenceId: String(item.evidenceId),
    status: item.status as LocalMainValidationSnapshot["status"],
    releaseGate: item.releaseGate as LocalMainValidationSnapshot["releaseGate"],
    candidateEvidenceId: String(item.candidateEvidenceId),
    candidateBundleDigest: String(item.candidateBundleDigest),
    candidateSha: String(item.candidateSha),
    sourceDigest: String(item.sourceDigest),
    mainSha: String(item.mainSha),
    mainSourceDigest: String(item.mainSourceDigest),
    bundleDigest: String(item.bundleDigest),
    godotVersion: String(item.godotVersion),
    targetMatrix: Object.freeze([...delivery.targetMatrix]),
    platform: "macos",
    fixtureOnly: true,
    buildArtifact,
    checks,
    createdAt: String(item.createdAt),
  };
}

function parseBuildArtifact(value: unknown): LocalMainValidationSnapshot["buildArtifact"] {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.fileName !== "DeviLudoMain.zip" || item.platform !== "macos"
    || item.contentType !== "application/zip" || !/^[a-f0-9]{64}$/.test(String(item.sha256))
    || !Number.isSafeInteger(item.sizeBytes) || Number(item.sizeBytes) < 1
    || Number(item.sizeBytes) > 512 * 1024 * 1024) return null;
  return Object.freeze({
    fileName: "DeviLudoMain.zip",
    platform: "macos",
    contentType: "application/zip",
    sha256: String(item.sha256),
    sizeBytes: Number(item.sizeBytes),
  });
}

function validMergeReceipt(value: unknown, evidence: Record<string, unknown>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.scmProxy === "local-git-proxy-v1" && item.branch === "main"
    && item.candidateCommitSha === evidence.candidateSha
    && item.mainCommitSha === evidence.mainSha
    && item.sourceDigest === evidence.mainSourceDigest
    && typeof item.mergedAt === "string" && Number.isFinite(Date.parse(item.mergedAt));
}

function validCheck(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ["import", "boot", "core-loop", "save-load", "performance", "macos-export", "macos-export-boot"].includes(String(item.name))
    && ["PASSED", "FAILED", "WAITING_DEPENDENCY"].includes(String(item.status))
    && typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0
    && typeof item.detail === "string";
}

function validArtifactDigests(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return /^[a-f0-9]{64}$/.test(String(item["junit.xml"]))
    && /^[a-f0-9]{64}$/.test(String(item["godot.log"]));
}

function loopbackRuntimeUrl() {
  const url = new URL(process.env.DEVILUDO_LOCAL_RUNTIME_URL ?? "http://127.0.0.1:4311");
  if (url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new HttpProblem(500, "LOCAL_RUNTIME_CONFIGURATION_INVALID", "DEVILUDO_LOCAL_RUNTIME_URL must be a plain loopback HTTP origin");
  }
  return url.origin;
}
