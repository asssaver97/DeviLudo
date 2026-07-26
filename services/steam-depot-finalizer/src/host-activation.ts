import { type KeyObject } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { sha256Canonical, verifyCanonical } from "../../runner-control/src/canonical";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_GRANT_LIFETIME_MS = 15 * 60_000;

export interface SteamDepotFinalizerHostActivationGrantPayload {
  readonly schemaVersion: "deviludo.steam-depot-finalizer-host-activation-grant-payload.v1";
  readonly operationId: string;
  readonly grantSequence: number;
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

export function verifySteamDepotFinalizerHostActivationGrant(
  value: unknown,
  options: Readonly<{
    publicKey: KeyObject;
    keyId: string;
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

function validatePayload(value: unknown): SteamDepotFinalizerHostActivationGrantPayload {
  const body = record(value);
  exactKeys(body, [
    "activeOperationCount", "architecture", "definitionDigest", "expiresAt", "grantSequence", "issuedAt",
    "nativeReleaseDigest", "operationId", "operationState", "planDigest", "platform", "previousDefinitionDigest",
    "previousPlanDigest", "receiptPath", "releaseId", "schemaVersion", "serviceReleaseDigest",
    "stagingReceiptDigest", "transactionDigest",
  ]);
  if (body.schemaVersion !== "deviludo.steam-depot-finalizer-host-activation-grant-payload.v1") invalid("schema");
  if (typeof body.operationId !== "string" || !UUID_V4.test(body.operationId)) invalid("operation identity");
  if (!Number.isSafeInteger(body.grantSequence) || Number(body.grantSequence) < 1) invalid("sequence");
  if (typeof body.releaseId !== "string" || !UUID_V4.test(body.releaseId)) invalid("release identity");
  if (!digests(body, ["definitionDigest", "nativeReleaseDigest", "planDigest", "serviceReleaseDigest",
    "stagingReceiptDigest", "transactionDigest"])) invalid("digest");
  if (body.platform !== "windows" && body.platform !== "linux" && body.platform !== "macos"
    || body.architecture !== "x86_64" && body.architecture !== "arm64"
    || body.operationState !== "INITIALIZING" && body.operationState !== "DRAINING"
    || body.activeOperationCount !== 0 || !nullableDigest(body.previousPlanDigest)
    || !nullableDigest(body.previousDefinitionDigest)) invalid("state");
  if (typeof body.receiptPath !== "string" || !absolute(body.receiptPath)
    || typeof body.issuedAt !== "string" || !canonicalTimestamp(body.issuedAt)
    || typeof body.expiresAt !== "string" || !canonicalTimestamp(body.expiresAt)) invalid("boundary");
  return deepFreeze({ ...body }) as unknown as SteamDepotFinalizerHostActivationGrantPayload;
}

function digests(value: Record<string, unknown>, names: readonly string[]): boolean {
  return names.every((name) => typeof value[name] === "string" && SHA256.test(value[name]));
}
function nullableDigest(value: unknown): boolean { return value === null || typeof value === "string" && SHA256.test(value); }
function absolute(value: string): boolean { return isAbsolute(value) && resolve(value) === value && value.length <= 4_096 && !/[\0\r\n]/.test(value); }
function canonicalTimestamp(value: string): boolean { return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) invalid();
}
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
function invalid(label = "envelope"): never { throw new Error(`Steam depot finalizer host activation grant ${label} is invalid`); }
