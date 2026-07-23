import { HttpProblem } from "@/lib/control-plane/http";
import type { LocalDeliverySnapshot, LocalSteamReinstallSnapshot } from "@/lib/local-delivery/model";
import { saveLocalSteamReinstall } from "@/lib/local-delivery/store";
import { createLocalRuntimeHeaders } from "@/services/local-runtime/src/request-auth";
import { createHash } from "node:crypto";

export async function runAndSaveLocalSteamReinstall(
  projectId: string,
  delivery: LocalDeliverySnapshot,
  commandKey: string,
) {
  const main = delivery.mainValidation;
  if (delivery.stage !== "STEAM_REINSTALL_E2E") {
    throw new HttpProblem(409, "INVALID_DELIVERY_STAGE", "当前交付阶段不能运行本地 Beta 回装");
  }
  if (!delivery.runId || !delivery.mainSha || !main?.valid
    || main.status !== "TESTS_PASSED" || main.releaseGate !== "MAIN_VALIDATION_PASSED"
    || !main.buildArtifact || !delivery.mfaApprovalId || delivery.steamBranch !== "local-password-beta") {
    throw new HttpProblem(409, "LOCAL_STEAM_AUTHORITY_REQUIRED", "本地 Beta 回装缺少有效 main、构建物或 MFA 权限");
  }
  const body = JSON.stringify({
    projectId,
    runId: delivery.runId,
    specRevisionId: delivery.specRevisionId,
    targetMatrix: delivery.targetMatrix,
    mainEvidenceId: main.evidenceId,
    mainBundleDigest: main.bundleDigest,
    mainSha: delivery.mainSha,
    mainSourceDigest: main.mainSourceDigest,
    mainArtifactSha256: main.buildArtifact.sha256,
    mfaApprovalId: delivery.mfaApprovalId,
  });
  const path = "/v1/steam-reinstalls";
  let response: Response;
  try {
    response = await fetch(`${loopbackRuntimeUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...createLocalRuntimeHeaders({ method: "POST", path, body }) },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new HttpProblem(503, "LOCAL_RUNTIME_UNAVAILABLE", "本机执行服务未启动；请使用 npm run local:dev");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机 Beta 回装服务返回了不安全的重定向");
  }
  let payload: { data?: unknown; error?: { message?: string } };
  try {
    payload = await response.json() as typeof payload;
  } catch {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本机 Beta 回装未返回有效 JSON");
  }
  if (!response.ok) {
    throw new HttpProblem(502, "LOCAL_STEAM_REINSTALL_FAILED", payload.error?.message ?? "本机 Beta 回装失败");
  }
  const validation = validateLocalSteamReinstallEvidence(payload.data, delivery);
  return saveLocalSteamReinstall(projectId, validation, commandKey);
}

export function validateLocalSteamReinstallEvidence(
  value: unknown,
  delivery: LocalDeliverySnapshot,
): Omit<LocalSteamReinstallSnapshot, "valid"> {
  const main = delivery.mainValidation;
  if (!delivery.runId || !delivery.mainSha || !main?.buildArtifact || !delivery.mfaApprovalId) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_BINDING_MISMATCH", "本地 Beta 回装的锁定授权不存在");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本地 Beta 回装证据响应无效");
  }
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || item.phase !== "LOCAL_STEAM_REINSTALL" || item.localOnly !== true
    || item.projectId !== delivery.projectId || item.runId !== delivery.runId
    || item.specRevisionId !== delivery.specRevisionId
    || JSON.stringify(item.targetMatrix) !== JSON.stringify(delivery.targetMatrix)
    || item.platform !== "macos" || item.branch !== "local-password-beta"
    || item.mainEvidenceId !== main.evidenceId || item.mainBundleDigest !== main.bundleDigest
    || item.mainSha !== delivery.mainSha || item.mainSourceDigest !== main.mainSourceDigest
    || item.mainArtifactSha256 !== main.buildArtifact.sha256 || item.mfaApprovalId !== delivery.mfaApprovalId) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_BINDING_MISMATCH", "本地 Beta 回装证据与 main、构建物或 MFA 不一致");
  }
  const { evidenceId, bundleDigest, ...unsigned } = item;
  if (!/^EV-STEAM-[A-F0-9]{12}$/.test(String(evidenceId))
    || !/^[a-f0-9]{64}$/.test(String(item.bundleDigest))
    || createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") !== bundleDigest
    || evidenceId !== `EV-STEAM-${String(bundleDigest).slice(0, 12).toUpperCase()}`
    || !/^BUILD-LOCAL-[A-F0-9]{12}$/.test(String(item.buildId))
    || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))
    || !validArtifactDigests(item.artifactDigests)) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本地 Beta 回装证据标识或摘要无效");
  }
  if (!Array.isArray(item.checks) || item.checks.length !== 2 || item.checks.some((check) => !validCheck(check))) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本地 Beta 回装检查证据无效");
  }
  const checks = item.checks as LocalSteamReinstallSnapshot["checks"];
  const names = new Set(checks.map((check) => check.name));
  if (names.size !== 2 || !names.has("beta-package-integrity") || !names.has("clean-reinstall-boot")) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本地 Beta 回装缺少固定检查项");
  }
  const passed = item.status === "TESTS_PASSED"
    && item.releaseGate === "LOCAL_STEAM_REINSTALL_PASSED"
    && checks.every((check) => check.status === "PASSED");
  const failed = item.status === "FAILED"
    && item.releaseGate === "TESTS_FAILED"
    && checks.some((check) => check.status === "FAILED");
  if (!passed && !failed) throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本地 Beta 回装状态与检查不一致");
  const betaArtifact = parseBetaArtifact(item.betaArtifact);
  if ((passed && (!betaArtifact || betaArtifact.sha256 !== main.buildArtifact.sha256
      || betaArtifact.sizeBytes !== main.buildArtifact.sizeBytes))
    || (failed && item.betaArtifact !== null)
    || (item.betaArtifact !== null && !betaArtifact)) {
    throw new HttpProblem(502, "LOCAL_RUNTIME_INVALID", "本地 Beta 回装状态与安装包授权不一致");
  }
  return {
    schemaVersion: 1,
    evidenceId: String(item.evidenceId),
    bundleDigest: String(item.bundleDigest),
    status: item.status as LocalSteamReinstallSnapshot["status"],
    releaseGate: item.releaseGate as LocalSteamReinstallSnapshot["releaseGate"],
    localOnly: true,
    branch: "local-password-beta",
    buildId: String(item.buildId),
    mainEvidenceId: String(item.mainEvidenceId),
    mainBundleDigest: String(item.mainBundleDigest),
    mainSha: String(item.mainSha),
    mainSourceDigest: String(item.mainSourceDigest),
    mainArtifactSha256: String(item.mainArtifactSha256),
    mfaApprovalId: String(item.mfaApprovalId),
    targetMatrix: Object.freeze(["macos"] as const),
    platform: "macos",
    checks,
    betaArtifact,
    createdAt: String(item.createdAt),
  };
}

function parseBetaArtifact(value: unknown): LocalSteamReinstallSnapshot["betaArtifact"] {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.fileName !== "DeviLudoLocalBeta.zip" || item.platform !== "macos"
    || item.contentType !== "application/zip" || !/^[a-f0-9]{64}$/.test(String(item.sha256))
    || !Number.isSafeInteger(item.sizeBytes) || Number(item.sizeBytes) < 1
    || Number(item.sizeBytes) > 512 * 1024 * 1024) return null;
  return Object.freeze({
    fileName: "DeviLudoLocalBeta.zip",
    platform: "macos",
    contentType: "application/zip",
    sha256: String(item.sha256),
    sizeBytes: Number(item.sizeBytes),
  });
}

function validCheck(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ["beta-package-integrity", "clean-reinstall-boot"].includes(String(item.name))
    && ["PASSED", "FAILED"].includes(String(item.status))
    && typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0
    && typeof item.detail === "string";
}

function validArtifactDigests(value: unknown) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && /^[a-f0-9]{64}$/.test(String((value as Record<string, unknown>)["reinstall.log"]));
}

function loopbackRuntimeUrl() {
  const url = new URL(process.env.DEVILUDO_LOCAL_RUNTIME_URL ?? "http://127.0.0.1:4311");
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new HttpProblem(500, "LOCAL_RUNTIME_CONFIGURATION_INVALID", "DEVILUDO_LOCAL_RUNTIME_URL must be a plain loopback HTTP origin");
  }
  return url.origin;
}
