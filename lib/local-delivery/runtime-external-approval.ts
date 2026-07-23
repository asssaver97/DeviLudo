import { createHash } from "node:crypto";
import { HttpProblem } from "@/lib/control-plane/http";
import type { LocalDeliverySnapshot, LocalExternalApprovalEvidenceSnapshot } from "@/lib/local-delivery/model";
import { saveLocalExternalApproval } from "@/lib/local-delivery/store";
import { createLocalRuntimeHeaders } from "@/services/local-runtime/src/request-auth";

const GATES = ["VALVE_REVIEW", "FIRST_RELEASE", "DEFAULT_BRANCH_CONFIRMATION"] as const;
const STATES = ["LOCAL_VALVE_REVIEW_CONFIRMED", "LOCAL_FIRST_RELEASE_CONFIRMED", "LOCAL_DEFAULT_BRANCH_CONFIRMED"] as const;

export async function runAndSaveLocalExternalApproval(
  projectId: string,
  delivery: LocalDeliverySnapshot,
  commandKey: string,
) {
  const reinstall = delivery.steamReinstall;
  const sequence = delivery.externalApprovalEvidence.length + 1;
  const gate = GATES[sequence - 1];
  if (delivery.stage !== "EXTERNAL_APPROVAL_REQUIRED" || !gate || delivery.externalGate !== gate
    || !delivery.runId || !delivery.mainSha || !delivery.steamBuildId
    || !reinstall?.valid || reinstall.releaseGate !== "LOCAL_STEAM_REINSTALL_PASSED"
    || reinstall.buildId !== delivery.steamBuildId) {
    throw new HttpProblem(409, "LOCAL_EXTERNAL_APPROVAL_NOT_REQUIRED", "当前没有可确认的本地外部发布门禁");
  }
  const body = JSON.stringify({
    projectId,
    runId: delivery.runId,
    specRevisionId: delivery.specRevisionId,
    targetMatrix: delivery.targetMatrix,
    mainSha: delivery.mainSha,
    steamBuildId: delivery.steamBuildId,
    steamReinstallEvidenceId: reinstall.evidenceId,
    steamReinstallBundleDigest: reinstall.bundleDigest,
    gate,
    sequence,
    previousApprovalEvidenceId: delivery.externalApprovalEvidence.at(-1)?.evidenceId ?? null,
  });
  const path = "/v1/external-approvals";
  let response: Response;
  try {
    response = await fetch(`${loopbackRuntimeUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...createLocalRuntimeHeaders({ method: "POST", path, body }) },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpProblem(503, "LOCAL_RUNTIME_UNAVAILABLE", "本机外部批准服务未启动；请使用 npm run local:dev");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机外部批准服务返回了不安全的重定向");
  }
  let payload: { data?: unknown; error?: { message?: string } };
  try { payload = await response.json() as typeof payload; }
  catch { throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机外部批准服务未返回有效 JSON"); }
  if (!response.ok) {
    throw new HttpProblem(502, "LOCAL_EXTERNAL_APPROVAL_FAILED", payload.error?.message ?? "本机外部批准失败");
  }
  const evidence = validateLocalExternalApprovalEvidence(payload.data, delivery);
  return saveLocalExternalApproval(projectId, evidence, commandKey);
}

export function validateLocalExternalApprovalEvidence(
  value: unknown,
  delivery: LocalDeliverySnapshot,
): Omit<LocalExternalApprovalEvidenceSnapshot, "valid"> {
  const reinstall = delivery.steamReinstall;
  const sequence = delivery.externalApprovalEvidence.length + 1;
  const gate = GATES[sequence - 1];
  const observedState = STATES[sequence - 1];
  const previousApprovalEvidenceId = delivery.externalApprovalEvidence.at(-1)?.evidenceId ?? null;
  if (!delivery.runId || !delivery.mainSha || !delivery.steamBuildId || !reinstall?.valid || !gate || !observedState) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_BINDING_MISMATCH", "本地外部批准的锁定授权不存在");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本地外部批准证据响应无效");
  }
  const item = value as Record<string, unknown>;
  const { evidenceId, bundleDigest, ...unsigned } = item;
  const checks = item.checks;
  if (item.schemaVersion !== 1 || item.phase !== "LOCAL_EXTERNAL_APPROVAL" || item.localOnly !== true
    || item.projectId !== delivery.projectId || item.runId !== delivery.runId
    || item.specRevisionId !== delivery.specRevisionId
    || JSON.stringify(item.targetMatrix) !== JSON.stringify(["macos"])
    || item.mainSha !== delivery.mainSha || item.steamBuildId !== delivery.steamBuildId
    || item.steamReinstallEvidenceId !== reinstall.evidenceId
    || item.steamReinstallBundleDigest !== reinstall.bundleDigest
    || item.gate !== gate || item.sequence !== sequence
    || item.previousApprovalEvidenceId !== previousApprovalEvidenceId
    || item.observedState !== observedState || item.status !== "APPROVED") {
    throw new HttpProblem(502, "LOCAL_RUNTIME_BINDING_MISMATCH", "本地外部批准证据与 main、BuildID、回装或前序回执不一致");
  }
  if (!/^EV-APPROVAL-[A-F0-9]{12}$/.test(String(evidenceId))
    || !/^[a-f0-9]{64}$/.test(String(bundleDigest))
    || createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") !== bundleDigest
    || evidenceId !== `EV-APPROVAL-${String(bundleDigest).slice(0, 12).toUpperCase()}`
    || !/^APPROVAL-LOCAL-[A-F0-9]{12}$/.test(String(item.approvalId))
    || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))
    || !Array.isArray(checks) || checks.length !== 1
    || !validAuthorityCheck(checks[0])) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本地外部批准证据标识、摘要或权威检查无效");
  }
  return {
    schemaVersion: 1,
    phase: "LOCAL_EXTERNAL_APPROVAL",
    localOnly: true,
    evidenceId: String(evidenceId),
    bundleDigest: String(bundleDigest),
    projectId: String(item.projectId),
    runId: String(item.runId),
    specRevisionId: String(item.specRevisionId),
    targetMatrix: Object.freeze(["macos"] as const),
    mainSha: String(item.mainSha),
    steamBuildId: String(item.steamBuildId),
    steamReinstallEvidenceId: String(item.steamReinstallEvidenceId),
    steamReinstallBundleDigest: String(item.steamReinstallBundleDigest),
    gate,
    sequence: sequence as 1 | 2 | 3,
    previousApprovalEvidenceId,
    approvalId: String(item.approvalId),
    observedState,
    status: "APPROVED",
    checks: checks as unknown as LocalExternalApprovalEvidenceSnapshot["checks"],
    createdAt: String(item.createdAt),
  };
}

function validAuthorityCheck(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.name === "authority-binding" && item.status === "PASSED"
    && typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0
    && typeof item.detail === "string";
}

function loopbackRuntimeUrl() {
  const url = new URL(process.env.DEVILUDO_LOCAL_RUNTIME_URL ?? "http://127.0.0.1:4311");
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new HttpProblem(500, "LOCAL_RUNTIME_CONFIGURATION_INVALID", "DEVILUDO_LOCAL_RUNTIME_URL must be a plain loopback HTTP origin");
  }
  return url.origin;
}
