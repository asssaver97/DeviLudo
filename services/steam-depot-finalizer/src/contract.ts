import { steamCanonicalDigest } from "../../steam-publisher/src/artifacts";
import {
  notarizationEvidenceObjectKey,
  signedDepotObjectKey,
  signingEvidenceObjectKey,
  type SteamDepotSigningScheme,
} from "../../steam-publisher/src/depot-finalization";
import type { SteamTargetPlatform } from "../../steam-publisher/src/contracts";
import type { SteamDepotFinalizationReceipt, SteamDepotFinalizationRequest } from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]{1,1023}$/;

export const STEAM_DEPOT_SIGNING_SCHEMES = Object.freeze([
  "LINUX_SIGSTORE",
  "MACOS_DEVELOPER_ID",
  "WINDOWS_AUTHENTICODE",
] as const);

export function parseSteamDepotFinalizationRequest(value: unknown): SteamDepotFinalizationRequest {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "operationKey", "tenantId", "projectId", "releaseId", "mainCommitSha",
    "evidenceBundleDigest", "platform", "sourceObjectKey", "sourceArtifactDigest", "requestDigest",
  ]);
  if (body.schemaVersion !== "deviludo.steam-depot-finalization.v1"
    || typeof body.tenantId !== "string" || !UUID.test(body.tenantId)
    || typeof body.projectId !== "string" || !UUID.test(body.projectId)
    || typeof body.releaseId !== "string" || !UUID.test(body.releaseId)
    || typeof body.mainCommitSha !== "string" || !SHA1.test(body.mainCommitSha)
    || typeof body.evidenceBundleDigest !== "string" || !SHA256.test(body.evidenceBundleDigest)
    || !isPlatform(body.platform)
    || typeof body.sourceArtifactDigest !== "string" || !SHA256.test(body.sourceArtifactDigest)
    || typeof body.requestDigest !== "string" || !SHA256.test(body.requestDigest)) invalid("request");
  const operationKey = `steam-depot-finalize:${body.releaseId}:${body.platform}`;
  if (body.operationKey !== operationKey || typeof body.sourceObjectKey !== "string"
    || !validSourceObjectKey(
      body.sourceObjectKey, body.tenantId, body.projectId, body.platform, body.sourceArtifactDigest,
    )) invalid("request binding");
  const requestCore = Object.freeze({
    schemaVersion: body.schemaVersion,
    operationKey,
    tenantId: body.tenantId,
    projectId: body.projectId,
    releaseId: body.releaseId,
    mainCommitSha: body.mainCommitSha,
    evidenceBundleDigest: body.evidenceBundleDigest,
    platform: body.platform,
    sourceObjectKey: body.sourceObjectKey,
    sourceArtifactDigest: body.sourceArtifactDigest,
  });
  if (steamCanonicalDigest(requestCore) !== body.requestDigest) invalid("request digest");
  return deepFreeze({ ...requestCore, requestDigest: body.requestDigest });
}

export function validateSteamDepotFinalizationReceipt(
  value: unknown,
  request: SteamDepotFinalizationRequest,
): SteamDepotFinalizationReceipt {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "operationKey", "requestDigest", "tenantId", "projectId", "releaseId",
    "mainCommitSha", "evidenceBundleDigest", "platform", "sourceArtifactDigest", "artifactObjectKey",
    "artifactDigest", "signingScheme", "signingIdentityDigest", "signingEvidenceObjectKey",
    "signingEvidenceDigest", "notarizationEvidenceObjectKey", "notarizationEvidenceDigest",
  ]);
  if (body.schemaVersion !== "deviludo.steam-depot-finalization-receipt.v1"
    || body.operationKey !== request.operationKey || body.requestDigest !== request.requestDigest
    || body.tenantId !== request.tenantId || body.projectId !== request.projectId
    || body.releaseId !== request.releaseId || body.mainCommitSha !== request.mainCommitSha
    || body.evidenceBundleDigest !== request.evidenceBundleDigest || body.platform !== request.platform
    || body.sourceArtifactDigest !== request.sourceArtifactDigest
    || typeof body.artifactDigest !== "string" || !SHA256.test(body.artifactDigest)
    || typeof body.signingIdentityDigest !== "string" || !SHA256.test(body.signingIdentityDigest)
    || typeof body.signingEvidenceDigest !== "string" || !SHA256.test(body.signingEvidenceDigest)
    || body.signingScheme !== signingScheme(request.platform)) invalid("receipt binding");
  const artifactObjectKey = objectKey(body.artifactObjectKey);
  const signingObjectKey = objectKey(body.signingEvidenceObjectKey);
  if (artifactObjectKey !== signedDepotObjectKey(
    request.tenantId, request.projectId, request.releaseId, request.platform, body.artifactDigest,
  ) || signingObjectKey !== signingEvidenceObjectKey(
    request.tenantId, request.projectId, request.releaseId, request.platform, body.signingEvidenceDigest,
  )) invalid("receipt object scope");
  let notarizationObjectKey: string | null = null;
  let notarizationDigest: string | null = null;
  if (request.platform === "macos") {
    if (typeof body.notarizationEvidenceDigest !== "string" || !SHA256.test(body.notarizationEvidenceDigest)) {
      invalid("macOS notarization");
    }
    notarizationDigest = body.notarizationEvidenceDigest;
    notarizationObjectKey = objectKey(body.notarizationEvidenceObjectKey);
    if (notarizationObjectKey !== notarizationEvidenceObjectKey(
      request.tenantId, request.projectId, request.releaseId, notarizationDigest,
    )) invalid("macOS notarization scope");
  } else if (body.notarizationEvidenceObjectKey !== null || body.notarizationEvidenceDigest !== null) {
    invalid("unexpected notarization");
  }
  return deepFreeze({
    schemaVersion: "deviludo.steam-depot-finalization-receipt.v1",
    operationKey: request.operationKey,
    requestDigest: request.requestDigest,
    tenantId: request.tenantId,
    projectId: request.projectId,
    releaseId: request.releaseId,
    mainCommitSha: request.mainCommitSha,
    evidenceBundleDigest: request.evidenceBundleDigest,
    platform: request.platform,
    sourceArtifactDigest: request.sourceArtifactDigest,
    artifactObjectKey,
    artifactDigest: body.artifactDigest,
    signingScheme: body.signingScheme as SteamDepotSigningScheme,
    signingIdentityDigest: body.signingIdentityDigest,
    signingEvidenceObjectKey: signingObjectKey,
    signingEvidenceDigest: body.signingEvidenceDigest,
    notarizationEvidenceObjectKey: notarizationObjectKey,
    notarizationEvidenceDigest: notarizationDigest,
  });
}

export function steamDepotFinalizationReceiptDigest(receipt: SteamDepotFinalizationReceipt): string {
  return steamCanonicalDigest(receipt);
}

function validSourceObjectKey(
  value: string,
  tenantId: string,
  projectId: string,
  platform: SteamTargetPlatform,
  digest: string,
): boolean {
  if (!SAFE_OBJECT_KEY.test(value) || value.includes("..") || value.startsWith("/") || value.endsWith("/")) return false;
  const prefix = `tenants/${tenantId}/projects/${projectId}/runner-artifacts/`;
  const suffix = `/${platform}/production-export/${digest}`;
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
  const attemptId = value.slice(prefix.length, value.length - suffix.length);
  return UUID.test(attemptId);
}

function signingScheme(platform: SteamTargetPlatform): SteamDepotSigningScheme {
  if (platform === "windows") return "WINDOWS_AUTHENTICODE";
  if (platform === "macos") return "MACOS_DEVELOPER_ID";
  return "LINUX_SIGSTORE";
}

function objectKey(value: unknown): string {
  if (typeof value !== "string" || !SAFE_OBJECT_KEY.test(value) || value.includes("..")
    || value.startsWith("/") || value.endsWith("/")) invalid("object key");
  return value;
}

function isPlatform(value: unknown): value is SteamTargetPlatform {
  return value === "windows" || value === "linux" || value === "macos";
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid("fields");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(label: string): never {
  throw new Error(`Steam depot finalization ${label} is invalid`);
}
