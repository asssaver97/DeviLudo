import { type KeyObject } from "node:crypto";
import { posix, win32 } from "node:path";
import { sha256Canonical, verifyCanonical } from "../../runner-control/src/canonical";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const HOST_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_GRANT_LIFETIME_MS = 15 * 60_000;

export interface SteamDepotFinalizerHostActivationGrantPayload {
  readonly schemaVersion: "deviludo.steam-depot-finalizer-host-activation-grant-payload.v1";
  readonly operationId: string;
  readonly grantSequence: number;
  readonly hostId: string;
  readonly hostSpiffeId: string;
  readonly hostCertificateFingerprint: string;
  readonly planDigest: string;
  readonly transactionDigest: string;
  readonly stagingReceiptDigest: string;
  readonly releaseId: string;
  readonly serviceReleaseDigest: string;
  readonly nativeReleaseDigest: string;
  readonly platform: "windows" | "linux" | "macos";
  readonly architecture: "x86_64" | "arm64";
  readonly operationState: "INITIALIZING" | "DRAINING";
  readonly activeOperationCount: 0;
  readonly previousPlanDigest: string | null;
  readonly previousDefinitionDigest: string | null;
  readonly definitionDigest: string;
  readonly receiptPath: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SteamDepotFinalizerHostActivationRequest {
  readonly schemaVersion: "deviludo.steam-depot-finalizer-host-activation-request.v1";
  readonly operationId: string;
  readonly hostId: string;
  readonly hostSpiffeId: string;
  readonly hostCertificateFingerprint: string;
  readonly planDigest: string;
  readonly transactionDigest: string;
  readonly stagingReceiptDigest: string;
  readonly releaseId: string;
  readonly serviceReleaseDigest: string;
  readonly nativeReleaseDigest: string;
  readonly platform: "windows" | "linux" | "macos";
  readonly architecture: "x86_64" | "arm64";
  readonly operationState: "INITIALIZING" | "DRAINING";
  readonly previousPlanDigest: string | null;
  readonly previousDefinitionDigest: string | null;
  readonly definitionDigest: string;
  readonly receiptPath: string;
}

export interface SteamDepotFinalizerHostDrainReceipt {
  readonly schemaVersion: "deviludo.steam-depot-finalizer-host-drain-receipt.v1";
  readonly operationId: string;
  readonly hostId: string;
  readonly state: "DRAINING";
  readonly activeOperationCount: number;
  readonly observedAt: string;
  readonly retryAfterSeconds: number;
}

export interface SteamDepotFinalizerHostActuationReceipt {
  readonly schemaVersion: "deviludo.steam-depot-finalizer-host-actuation-receipt.v1";
  readonly state: "ACTIVATED" | "ROLLED_BACK";
  readonly operationId: string;
  readonly grantSequence: number;
  readonly hostId: string;
  readonly hostSpiffeId: string;
  readonly hostCertificateFingerprint: string;
  readonly transactionDigest: string;
  readonly planDigest: string;
  readonly stagingReceiptDigest: string;
  readonly releaseId: string;
  readonly platform: "windows" | "linux" | "macos";
  readonly architecture: "x86_64" | "arm64";
  readonly previousDefinitionDigest: string | null;
  readonly failureDigest: string | null;
  readonly completedAt: string;
  readonly receiptDigest: string;
}

export interface SignedSteamDepotFinalizerHostActivationGrant {
  readonly schemaVersion: "deviludo.steam-depot-finalizer-host-activation-grant.v1";
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly payload: SteamDepotFinalizerHostActivationGrantPayload;
  readonly signature: string;
}

export function steamDepotFinalizerHostActivationGrantPayloadDigest(value: unknown): string {
  return sha256Canonical(validatePayload(value));
}

export function validateSteamDepotFinalizerHostActivationRequest(
  value: unknown,
): SteamDepotFinalizerHostActivationRequest {
  const body = record(value);
  exactKeys(body, [
    "architecture", "definitionDigest", "hostCertificateFingerprint", "hostId", "hostSpiffeId",
    "nativeReleaseDigest", "operationId", "operationState", "planDigest", "platform",
    "previousDefinitionDigest", "previousPlanDigest", "receiptPath", "releaseId", "schemaVersion",
    "serviceReleaseDigest", "stagingReceiptDigest", "transactionDigest",
  ]);
  if (body.schemaVersion !== "deviludo.steam-depot-finalizer-host-activation-request.v1"
    || typeof body.operationId !== "string" || !UUID_V4.test(body.operationId)
    || typeof body.hostId !== "string" || !HOST_ID.test(body.hostId)
    || !validSpiffeId(body.hostSpiffeId) || typeof body.hostCertificateFingerprint !== "string"
    || !SHA256.test(body.hostCertificateFingerprint)
    || typeof body.releaseId !== "string" || !UUID_V4.test(body.releaseId)
    || !digests(body, ["definitionDigest", "nativeReleaseDigest", "planDigest", "serviceReleaseDigest",
      "stagingReceiptDigest", "transactionDigest"])
    || body.platform !== "windows" && body.platform !== "linux" && body.platform !== "macos"
    || body.architecture !== "x86_64" && body.architecture !== "arm64"
    || body.operationState !== "INITIALIZING" && body.operationState !== "DRAINING"
    || !nullableDigest(body.previousPlanDigest) || !nullableDigest(body.previousDefinitionDigest)
    || (body.operationState === "INITIALIZING"
      && (body.previousPlanDigest !== null || body.previousDefinitionDigest !== null))
    || (body.operationState === "DRAINING"
      && (body.previousPlanDigest === null || body.previousDefinitionDigest === null))
    || typeof body.receiptPath !== "string" || !absoluteForPlatform(body.receiptPath, body.platform)) invalid("request");
  return deepFreeze({ ...body }) as unknown as SteamDepotFinalizerHostActivationRequest;
}

export function steamDepotFinalizerHostActivationRequestDigest(value: unknown): string {
  return sha256Canonical(validateSteamDepotFinalizerHostActivationRequest(value));
}

export function createSteamDepotFinalizerHostDrainReceipt(input: Readonly<{
  request: SteamDepotFinalizerHostActivationRequest;
  activeOperationCount: number;
  observedAt: string;
  retryAfterSeconds: number;
}>): SteamDepotFinalizerHostDrainReceipt {
  const request = validateSteamDepotFinalizerHostActivationRequest(input.request);
  return validateSteamDepotFinalizerHostDrainReceipt({
    schemaVersion: "deviludo.steam-depot-finalizer-host-drain-receipt.v1",
    operationId: request.operationId,
    hostId: request.hostId,
    state: "DRAINING",
    activeOperationCount: input.activeOperationCount,
    observedAt: input.observedAt,
    retryAfterSeconds: input.retryAfterSeconds,
  }, request);
}

export function validateSteamDepotFinalizerHostDrainReceipt(
  value: unknown,
  requestValue?: unknown,
): SteamDepotFinalizerHostDrainReceipt {
  const body = record(value);
  exactKeys(body, [
    "activeOperationCount", "hostId", "observedAt", "operationId", "retryAfterSeconds", "schemaVersion", "state",
  ]);
  if (body.schemaVersion !== "deviludo.steam-depot-finalizer-host-drain-receipt.v1"
    || typeof body.operationId !== "string" || !UUID_V4.test(body.operationId)
    || typeof body.hostId !== "string" || !HOST_ID.test(body.hostId) || body.state !== "DRAINING"
    || !Number.isSafeInteger(body.activeOperationCount) || Number(body.activeOperationCount) < 1
    || typeof body.observedAt !== "string" || !canonicalTimestamp(body.observedAt)
    || !Number.isSafeInteger(body.retryAfterSeconds) || Number(body.retryAfterSeconds) < 1
    || Number(body.retryAfterSeconds) > 300) invalid("drain receipt");
  if (requestValue !== undefined) {
    const request = validateSteamDepotFinalizerHostActivationRequest(requestValue);
    if (body.operationId !== request.operationId || body.hostId !== request.hostId) invalid("drain binding");
  }
  return deepFreeze({ ...body }) as unknown as SteamDepotFinalizerHostDrainReceipt;
}

export function createSteamDepotFinalizerHostActivationGrantPayload(input: Readonly<{
  request: SteamDepotFinalizerHostActivationRequest;
  grantSequence: number;
  issuedAt: string;
  expiresAt: string;
}>): SteamDepotFinalizerHostActivationGrantPayload {
  const request = validateSteamDepotFinalizerHostActivationRequest(input.request);
  const payload = {
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-grant-payload.v1" as const,
    operationId: request.operationId,
    grantSequence: input.grantSequence,
    hostId: request.hostId,
    hostSpiffeId: request.hostSpiffeId,
    hostCertificateFingerprint: request.hostCertificateFingerprint,
    planDigest: request.planDigest,
    transactionDigest: request.transactionDigest,
    stagingReceiptDigest: request.stagingReceiptDigest,
    releaseId: request.releaseId,
    serviceReleaseDigest: request.serviceReleaseDigest,
    nativeReleaseDigest: request.nativeReleaseDigest,
    platform: request.platform,
    architecture: request.architecture,
    operationState: request.operationState,
    activeOperationCount: 0 as const,
    previousPlanDigest: request.previousPlanDigest,
    previousDefinitionDigest: request.previousDefinitionDigest,
    definitionDigest: request.definitionDigest,
    receiptPath: request.receiptPath,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
  return validatePayload(payload);
}

export function validateSteamDepotFinalizerHostActuationReceipt(
  value: unknown,
  grant: SignedSteamDepotFinalizerHostActivationGrant,
): SteamDepotFinalizerHostActuationReceipt {
  const payload = validatePayload(grant?.payload);
  const receipt = record(value);
  exactKeys(receipt, [
    "architecture", "completedAt", "failureDigest", "grantSequence", "hostCertificateFingerprint", "hostId",
    "hostSpiffeId", "operationId", "planDigest", "platform", "previousDefinitionDigest", "receiptDigest",
    "releaseId", "schemaVersion", "stagingReceiptDigest", "state", "transactionDigest",
  ]);
  const core = { ...receipt }; delete core.receiptDigest;
  if (receipt.schemaVersion !== "deviludo.steam-depot-finalizer-host-actuation-receipt.v1"
    || receipt.state !== "ACTIVATED" && receipt.state !== "ROLLED_BACK"
    || receipt.operationId !== payload.operationId || receipt.grantSequence !== payload.grantSequence
    || receipt.hostId !== payload.hostId || receipt.hostSpiffeId !== payload.hostSpiffeId
    || receipt.hostCertificateFingerprint !== payload.hostCertificateFingerprint
    || receipt.transactionDigest !== payload.transactionDigest || receipt.planDigest !== payload.planDigest
    || receipt.stagingReceiptDigest !== payload.stagingReceiptDigest || receipt.releaseId !== payload.releaseId
    || receipt.platform !== payload.platform || receipt.architecture !== payload.architecture
    || !nullableDigest(receipt.previousDefinitionDigest)
    || receipt.previousDefinitionDigest !== payload.previousDefinitionDigest
    || (receipt.state === "ACTIVATED" && receipt.failureDigest !== null)
    || (receipt.state === "ROLLED_BACK" && !SHA256.test(String(receipt.failureDigest)))
    || typeof receipt.completedAt !== "string" || !canonicalTimestamp(receipt.completedAt)
    || typeof receipt.receiptDigest !== "string" || !SHA256.test(receipt.receiptDigest)
    || receipt.receiptDigest !== sha256Canonical(core)) invalid("actuation receipt");
  return deepFreeze({ ...receipt }) as unknown as SteamDepotFinalizerHostActuationReceipt;
}

export function verifySteamDepotFinalizerHostActivationGrant(
  value: unknown,
  options: Readonly<{
    publicKey: KeyObject;
    keyId: string;
    request?: unknown;
    now?: Date;
    allowExpired?: boolean;
  }>,
): SignedSteamDepotFinalizerHostActivationGrant {
  const envelope = record(value);
  exactKeys(envelope, ["algorithm", "keyId", "payload", "schemaVersion", "signature"]);
  if (envelope.schemaVersion !== "deviludo.steam-depot-finalizer-host-activation-grant.v1"
    || envelope.algorithm !== "Ed25519" || typeof envelope.keyId !== "string"
    || envelope.keyId !== options.keyId || !SAFE_ID.test(envelope.keyId)
    || typeof envelope.signature !== "string" || envelope.signature.length !== 86
    || options.publicKey?.type !== "public" || options.publicKey.asymmetricKeyType !== "ed25519") invalid();
  const payload = validatePayload(envelope.payload);
  if (options.request !== undefined) assertRequestBinding(payload, validateSteamDepotFinalizerHostActivationRequest(options.request));
  const now = options.now ?? new Date();
  const issuedAt = Date.parse(payload.issuedAt); const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(now.valueOf()) || issuedAt >= expiresAt || expiresAt - issuedAt > MAX_GRANT_LIFETIME_MS
    || issuedAt > now.valueOf() + MAX_CLOCK_SKEW_MS || options.allowExpired !== true && expiresAt <= now.valueOf()
    || !verifyCanonical(options.publicKey, payload, envelope.signature)) invalid();
  return deepFreeze({
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-grant.v1",
    algorithm: "Ed25519",
    keyId: envelope.keyId,
    payload,
    signature: envelope.signature,
  });
}

function assertRequestBinding(
  payload: SteamDepotFinalizerHostActivationGrantPayload,
  request: SteamDepotFinalizerHostActivationRequest,
): void {
  for (const key of [
    "operationId", "hostId", "hostSpiffeId", "hostCertificateFingerprint", "planDigest", "transactionDigest",
    "stagingReceiptDigest", "releaseId", "serviceReleaseDigest", "nativeReleaseDigest", "platform", "architecture",
    "operationState", "previousPlanDigest", "previousDefinitionDigest", "definitionDigest", "receiptPath",
  ] as const) if (payload[key] !== request[key]) invalid("request binding");
}

function validatePayload(value: unknown): SteamDepotFinalizerHostActivationGrantPayload {
  const body = record(value);
  exactKeys(body, [
    "activeOperationCount", "architecture", "definitionDigest", "expiresAt", "grantSequence",
    "hostCertificateFingerprint", "hostId", "hostSpiffeId", "issuedAt", "nativeReleaseDigest", "operationId",
    "operationState", "planDigest", "platform", "previousDefinitionDigest",
    "previousPlanDigest", "receiptPath", "releaseId", "schemaVersion", "serviceReleaseDigest",
    "stagingReceiptDigest", "transactionDigest",
  ]);
  if (body.schemaVersion !== "deviludo.steam-depot-finalizer-host-activation-grant-payload.v1") invalid("schema");
  if (typeof body.operationId !== "string" || !UUID_V4.test(body.operationId)) invalid("operation identity");
  if (!Number.isSafeInteger(body.grantSequence) || Number(body.grantSequence) < 1) invalid("sequence");
  if (typeof body.hostId !== "string" || !HOST_ID.test(body.hostId) || !validSpiffeId(body.hostSpiffeId)
    || typeof body.hostCertificateFingerprint !== "string" || !SHA256.test(body.hostCertificateFingerprint)) {
    invalid("host identity");
  }
  if (typeof body.releaseId !== "string" || !UUID_V4.test(body.releaseId)) invalid("release identity");
  if (!digests(body, ["definitionDigest", "nativeReleaseDigest", "planDigest", "serviceReleaseDigest",
    "stagingReceiptDigest", "transactionDigest"])) invalid("digest");
  if (body.platform !== "windows" && body.platform !== "linux" && body.platform !== "macos"
    || body.architecture !== "x86_64" && body.architecture !== "arm64"
    || body.operationState !== "INITIALIZING" && body.operationState !== "DRAINING"
    || body.activeOperationCount !== 0 || !nullableDigest(body.previousPlanDigest)
    || !nullableDigest(body.previousDefinitionDigest)
    || (body.operationState === "INITIALIZING"
      && (body.previousPlanDigest !== null || body.previousDefinitionDigest !== null))
    || (body.operationState === "DRAINING"
      && (body.previousPlanDigest === null || body.previousDefinitionDigest === null))) invalid("state");
  if (typeof body.receiptPath !== "string" || !absoluteForPlatform(body.receiptPath, body.platform)
    || typeof body.issuedAt !== "string" || !canonicalTimestamp(body.issuedAt)
    || typeof body.expiresAt !== "string" || !canonicalTimestamp(body.expiresAt)) invalid("boundary");
  return deepFreeze({ ...body }) as unknown as SteamDepotFinalizerHostActivationGrantPayload;
}

function digests(value: Record<string, unknown>, names: readonly string[]): boolean {
  return names.every((name) => typeof value[name] === "string" && SHA256.test(value[name]));
}
function nullableDigest(value: unknown): boolean { return value === null || typeof value === "string" && SHA256.test(value); }
function validSpiffeId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 512 || /[?#\0\s]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "spiffe:" && Boolean(url.hostname) && url.pathname !== "/"
      && !url.username && !url.password && !url.port && !url.search && !url.hash && url.toString() === value;
  } catch { return false; }
}
function absoluteForPlatform(value: string, platform: unknown): boolean {
  if (value.length > 4_096 || /[\0\r\n]/.test(value)) return false;
  return platform === "windows"
    ? win32.isAbsolute(value) && win32.normalize(value) === value
    : (platform === "linux" || platform === "macos") && posix.isAbsolute(value) && posix.normalize(value) === value;
}
function canonicalTimestamp(value: string): boolean { return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) invalid();
}
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
function invalid(label = "envelope"): never { throw new Error(`Steam depot finalizer host activation grant ${label} is invalid`); }
