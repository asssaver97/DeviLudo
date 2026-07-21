import { createPublicKey, type KeyObject } from "node:crypto";
import type {
  RunnerNativeInstallActivationGrantPayload,
  RunnerNativeInstallAuthorizationRequest,
  RunnerNativeInstallDrainReceipt,
  SignedRunnerNativeInstallActivationGrant,
} from "./contracts";
import { sha256Canonical, verifyCanonical } from "./canonical";

const SHA256 = /^[a-f0-9]{64}$/;
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RUNNER_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const REQUEST_KEYS = Object.freeze([
  "architecture", "currentCapabilityDigest", "currentRunnerId", "operationId", "planDigest", "platform",
  "releaseDigest", "releaseId", "schemaVersion", "stagingReceiptDigest", "targetCapabilityDigest",
  "targetRunnerId", "targetSpiffeId",
]);
const GRANT_KEYS = Object.freeze([
  "activeLeaseCount", "architecture", "currentCapabilityDigest", "currentRunnerId", "currentSpiffeId", "expiresAt",
  "grantSequence", "issuedAt", "operationId", "planDigest", "platform", "releaseDigest", "releaseId",
  "requiredRunnerState", "schemaVersion", "stagingReceiptDigest", "targetCapabilityDigest", "targetRunnerId",
  "targetSpiffeId",
]);

export function validateRunnerNativeInstallAuthorizationRequest(
  value: unknown,
): RunnerNativeInstallAuthorizationRequest {
  const request = record(value);
  if (!exactKeys(request, REQUEST_KEYS)
    || request.schemaVersion !== "deviludo.runner-native-install-authorization-request.v1"
    || !UUID_V4.test(string(request.operationId)) || !RUNNER_ID.test(string(request.currentRunnerId))
    || !SHA256.test(string(request.currentCapabilityDigest)) || !RUNNER_ID.test(string(request.targetRunnerId))
    || !validSpiffeId(request.targetSpiffeId) || !SHA256.test(string(request.targetCapabilityDigest))
    || !new Set(["windows", "linux", "macos"]).has(string(request.platform))
    || !new Set(["x86_64", "arm64"]).has(string(request.architecture))
    || !SHA256.test(string(request.planDigest)) || !SHA256.test(string(request.stagingReceiptDigest))
    || !UUID_V4.test(string(request.releaseId)) || !PREFIXED_SHA256.test(string(request.releaseDigest))
    || request.currentRunnerId === request.targetRunnerId
      && request.currentCapabilityDigest !== request.targetCapabilityDigest) invalid();
  return Object.freeze({ ...request }) as unknown as RunnerNativeInstallAuthorizationRequest;
}

export function runnerNativeInstallRequestDigest(request: RunnerNativeInstallAuthorizationRequest): string {
  return sha256Canonical(validateRunnerNativeInstallAuthorizationRequest(request));
}

export function createRunnerNativeInstallDrainReceipt(input: {
  readonly request: RunnerNativeInstallAuthorizationRequest;
  readonly activeLeaseCount: number;
  readonly observedAt: string;
  readonly retryAfterSeconds: number;
}): RunnerNativeInstallDrainReceipt {
  validateRunnerNativeInstallAuthorizationRequest(input.request);
  if (!Number.isSafeInteger(input.activeLeaseCount) || input.activeLeaseCount < 1
    || !canonicalTimestamp(input.observedAt) || !Number.isSafeInteger(input.retryAfterSeconds)
    || input.retryAfterSeconds < 1 || input.retryAfterSeconds > 300) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.runner-native-install-drain-receipt.v1",
    operationId: input.request.operationId,
    currentRunnerId: input.request.currentRunnerId,
    planDigest: input.request.planDigest,
    state: "DRAINING",
    activeLeaseCount: input.activeLeaseCount,
    observedAt: input.observedAt,
    retryAfterSeconds: input.retryAfterSeconds,
  });
}

export function validateRunnerNativeInstallActivationGrantPayload(
  value: unknown,
  request?: RunnerNativeInstallAuthorizationRequest,
): RunnerNativeInstallActivationGrantPayload {
  const payload = record(value);
  if (!exactKeys(payload, GRANT_KEYS)
    || payload.schemaVersion !== "deviludo.runner-native-install-activation-grant.v1"
    || !UUID_V4.test(string(payload.operationId)) || !Number.isSafeInteger(payload.grantSequence)
    || Number(payload.grantSequence) < 1 || !RUNNER_ID.test(string(payload.currentRunnerId))
    || !validSpiffeId(payload.currentSpiffeId) || !SHA256.test(string(payload.currentCapabilityDigest))
    || !RUNNER_ID.test(string(payload.targetRunnerId)) || !validSpiffeId(payload.targetSpiffeId)
    || !SHA256.test(string(payload.targetCapabilityDigest))
    || !new Set(["windows", "linux", "macos"]).has(string(payload.platform))
    || !new Set(["x86_64", "arm64"]).has(string(payload.architecture))
    || !SHA256.test(string(payload.planDigest)) || !SHA256.test(string(payload.stagingReceiptDigest))
    || !UUID_V4.test(string(payload.releaseId)) || !PREFIXED_SHA256.test(string(payload.releaseDigest))
    || payload.requiredRunnerState !== "DRAINING" || payload.activeLeaseCount !== 0
    || !canonicalTimestamp(payload.issuedAt) || !canonicalTimestamp(payload.expiresAt)
    || Date.parse(string(payload.expiresAt)) <= Date.parse(string(payload.issuedAt))
    || Date.parse(string(payload.expiresAt)) - Date.parse(string(payload.issuedAt)) > 15 * 60 * 1_000) invalid();
  if (request) {
    const expected = validateRunnerNativeInstallAuthorizationRequest(request);
    for (const key of [
      "operationId", "currentRunnerId", "currentCapabilityDigest", "targetRunnerId", "targetSpiffeId",
      "targetCapabilityDigest", "platform", "architecture", "planDigest", "stagingReceiptDigest", "releaseId",
      "releaseDigest",
    ] as const) if (payload[key] !== expected[key]) invalid();
  }
  return Object.freeze({ ...payload }) as unknown as RunnerNativeInstallActivationGrantPayload;
}

export function verifyRunnerNativeInstallActivationGrant(
  value: unknown,
  options: {
    readonly publicKey: KeyObject;
    readonly keyId: string;
    readonly request?: RunnerNativeInstallAuthorizationRequest;
    readonly now: string;
    readonly allowExpired?: boolean;
  },
): SignedRunnerNativeInstallActivationGrant {
  const grant = record(value);
  if (!exactKeys(grant, ["payload", "signature"])) invalid();
  const payload = validateRunnerNativeInstallActivationGrantPayload(grant.payload, options.request);
  const signature = record(grant.signature);
  const publicKey = options.publicKey.type === "public" ? options.publicKey : createPublicKey(options.publicKey);
  if (!exactKeys(signature, ["algorithm", "keyId", "value"]) || signature.algorithm !== "Ed25519"
    || signature.keyId !== options.keyId || !/^[A-Za-z0-9_-]{80,120}$/.test(string(signature.value))
    || publicKey.asymmetricKeyType !== "ed25519"
    || !canonicalTimestamp(options.now) || Date.parse(options.now) < Date.parse(payload.issuedAt)
    || options.allowExpired !== true && Date.parse(options.now) >= Date.parse(payload.expiresAt)
    || !verifyCanonical(publicKey, payload, string(signature.value))) invalid();
  return Object.freeze({ payload, signature: Object.freeze({
    algorithm: "Ed25519", keyId: string(signature.keyId), value: string(signature.value),
  }) });
}

function validSpiffeId(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 12 || value.length > 512 || /[?#\0\s]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "spiffe:" && Boolean(url.hostname) && Boolean(url.pathname && url.pathname !== "/")
      && !url.username && !url.password && !url.port;
  } catch { return false; }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== "string") invalid(); return value; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function invalid(): never { throw new Error("Runner native install authorization is invalid"); }
