import type { TrustedPlatformSession } from "./github-broker";

const MAX_RESPONSE_BYTES = 64 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

type FetchLike = typeof fetch;

export type SteamEnrollmentState = "WAITING_CREDENTIALS" | "WAITING_STEAM_GUARD" | "READY";

export interface SteamEnrollmentResult {
  readonly enrollmentId: string;
  readonly state: SteamEnrollmentState;
  readonly enrollmentUrl: string | null;
  readonly expiresAt: string;
}

export interface SteamEnrollmentRuntime {
  readonly broker: SteamEnrollmentBrokerClient;
  readonly sessionHmacKey: Uint8Array;
}

export interface SteamConnectionStatus {
  readonly state: "UNCONFIGURED" | SteamEnrollmentState;
  readonly enrollmentId: string | null;
  readonly enrollmentUrl: string | null;
  readonly accountName: string | null;
  readonly allowedAppIds: readonly string[];
  readonly permissions: readonly ("EditAppMetadata" | "PublishAppChanges")[];
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
}

export class SteamEnrollmentBrokerClient {
  readonly #origin: URL;
  readonly #publicOrigin: URL;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #now: () => Date;

  constructor(options: {
    readonly endpoint: string;
    readonly publicOrigin: string;
    readonly fetch?: FetchLike;
    readonly timeoutMs?: number;
    readonly now?: () => Date;
  }) {
    this.#origin = requireRootHttpsOrigin(options.endpoint, "Steam enrollment broker");
    this.#publicOrigin = requireRootHttpsOrigin(options.publicOrigin, "Steam enrollment public");
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error("Steam enrollment broker timeout is invalid");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = timeoutMs;
    this.#now = options.now ?? (() => new Date());
  }

  async connectionStatus(session: TrustedPlatformSession): Promise<SteamConnectionStatus> {
    validateSession(session);
    const body = await this.#post("/v1/steam/enrollments/status", {
      principal: { tenantId: session.tenantId, userId: session.userId, sessionBinding: session.sessionBinding },
    });
    const state = body.state;
    if (state !== "UNCONFIGURED" && state !== "WAITING_CREDENTIALS" && state !== "WAITING_STEAM_GUARD" && state !== "READY") {
      throw new Error("Steam connection state is invalid");
    }
    if (state === "UNCONFIGURED") {
      if (body.enrollmentId !== null || body.enrollmentUrl !== null || body.accountName !== null
        || body.verifiedAt !== null || body.expiresAt !== null
        || !Array.isArray(body.allowedAppIds) || body.allowedAppIds.length !== 0
        || !Array.isArray(body.permissions) || body.permissions.length !== 0) {
        throw new Error("Steam unconfigured projection is invalid");
      }
      return Object.freeze({ state, enrollmentId: null, enrollmentUrl: null, accountName: null,
        allowedAppIds: Object.freeze([]), permissions: Object.freeze([]), verifiedAt: null, expiresAt: null });
    }
    const enrollmentId = requireOpaqueId(body.enrollmentId, "Steam enrollment");
    const expiresAt = requireIso(body.expiresAt, "Steam connection expiry");
    const expiry = Date.parse(expiresAt);
    const now = this.#now().getTime();
    if (!Number.isFinite(now) || expiry <= now || expiry > now + 180 * 24 * 60 * 60_000) {
      throw new Error("Steam connection expiry is invalid");
    }
    if (state !== "READY") {
      if (typeof body.enrollmentUrl !== "string" || body.accountName !== null || body.verifiedAt !== null
        || !Array.isArray(body.allowedAppIds) || body.allowedAppIds.length !== 0
        || !Array.isArray(body.permissions) || body.permissions.length !== 0) {
        throw new Error("Steam pending connection projection is invalid");
      }
      return Object.freeze({ state, enrollmentId,
        enrollmentUrl: validateEnrollmentUrl(body.enrollmentUrl, this.#publicOrigin, enrollmentId),
        accountName: null, allowedAppIds: Object.freeze([]), permissions: Object.freeze([]), verifiedAt: null, expiresAt });
    }
    const accountName = body.accountName;
    if (typeof accountName !== "string" || !/^[A-Za-z0-9_-]{3,64}$/.test(accountName) || body.enrollmentUrl !== null
      || typeof body.verifiedAt !== "string" || !Number.isFinite(Date.parse(body.verifiedAt))) {
      throw new Error("Steam ready connection projection is invalid");
    }
    const allowedAppIds = requireStringArray(body.allowedAppIds, /^\d{1,20}$/, "Steam allowed App IDs");
    const permissions = requireStringArray(body.permissions, /^(?:EditAppMetadata|PublishAppChanges)$/, "Steam permissions");
    if (!allowedAppIds.length || allowedAppIds.includes("0")
      || !permissions.includes("EditAppMetadata") || !permissions.includes("PublishAppChanges")) {
      throw new Error("Steam ready connection permissions are invalid");
    }
    return Object.freeze({ state, enrollmentId, enrollmentUrl: null, accountName,
      allowedAppIds, permissions: permissions as SteamConnectionStatus["permissions"],
      verifiedAt: new Date(body.verifiedAt).toISOString(), expiresAt });
  }

  async begin(
    session: TrustedPlatformSession,
    idempotencyKey: string,
  ): Promise<SteamEnrollmentResult> {
    if (!OPAQUE_ID.test(idempotencyKey)) throw new Error("Steam enrollment idempotency key is invalid");
    validateSession(session);
    const body = await this.#post("/v1/steam/enrollments", {
      principal: { tenantId: session.tenantId, userId: session.userId, sessionBinding: session.sessionBinding },
    }, idempotencyKey);
    const enrollmentId = requireOpaqueId(body.enrollmentId, "Steam enrollment");
    const state = body.state;
    if (state !== "WAITING_CREDENTIALS" && state !== "WAITING_STEAM_GUARD" && state !== "READY") throw new Error("Steam enrollment state is invalid");
    const expiresAt = requireIso(body.expiresAt, "Steam enrollment expiry");
    const now = this.#now();
    if (!Number.isFinite(now.getTime()) || Date.parse(expiresAt) <= now.getTime() || Date.parse(expiresAt) > now.getTime() + 30 * 60_000) {
      throw new Error("Steam enrollment expiry is invalid");
    }
    let enrollmentUrl: string | null = null;
    if (state !== "READY") {
      if (typeof body.enrollmentUrl !== "string") throw new Error("Steam enrollment URL is missing");
      enrollmentUrl = validateEnrollmentUrl(body.enrollmentUrl, this.#publicOrigin, enrollmentId);
    } else if (body.enrollmentUrl !== null && body.enrollmentUrl !== undefined) {
      throw new Error("Ready Steam enrollment unexpectedly returned a login URL");
    }
    return Object.freeze({ enrollmentId, state, enrollmentUrl, expiresAt });
  }

  async #post(path: string, body: Readonly<Record<string, unknown>>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const url = new URL(path, this.#origin);
    if (url.origin !== this.#origin.origin) throw new Error("Steam enrollment broker request origin is invalid");
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        redirect: "error",
        headers: { accept: "application/json", "content-type": "application/json",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new Error("Steam enrollment broker is unavailable");
    }
    if (!response.ok) throw new Error(`Steam enrollment broker rejected the request with status ${response.status}`);
    return readObject(response);
  }
}

export function steamEnrollmentRuntimeFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SteamEnrollmentRuntime | null {
  const endpoint = env.DEVILUDO_STEAM_ENROLLMENT_BROKER_URL?.trim();
  if (!endpoint) return null;
  const publicOrigin = env.DEVILUDO_STEAM_ENROLLMENT_PUBLIC_ORIGIN?.trim();
  const encodedKey = env.DEVILUDO_SESSION_HMAC_KEY?.trim();
  if (!publicOrigin || !encodedKey) throw new Error("Steam enrollment Broker requires its public origin and session HMAC key");
  const sessionHmacKey = decodeBase64Url(encodedKey);
  if (sessionHmacKey.byteLength < 32 || sessionHmacKey.byteLength > 64) throw new Error("Platform session HMAC key is invalid");
  return Object.freeze({
    broker: new SteamEnrollmentBrokerClient({ endpoint, publicOrigin }),
    sessionHmacKey,
  });
}

function requireRootHttpsOrigin(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`${label} origin is invalid`);
  }
  return url;
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Steam enrollment response exceeds the size limit");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("Steam enrollment response exceeds the size limit");
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Steam enrollment response is invalid JSON");
  }
}

function validateEnrollmentUrl(value: string, publicOrigin: URL, enrollmentId: string): string {
  const url = new URL(value);
  if (
    url.origin !== publicOrigin.origin ||
    url.pathname !== `/enrollments/${encodeURIComponent(enrollmentId)}` ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Steam enrollment URL is invalid");
  }
  return url.href;
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw new Error(`${label} ID is invalid`);
  return value;
}

function requireIso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  return new Date(value).toISOString();
}

function validateSession(session: TrustedPlatformSession): void {
  if (!OPAQUE_ID.test(session.tenantId) || !OPAQUE_ID.test(session.userId)
    || session.sessionBinding.length < 32 || session.sessionBinding.length > 512
    || /[\u0000-\u001f\u007f]/.test(session.sessionBinding)) {
    throw new Error("Steam enrollment principal is invalid");
  }
}

function requireStringArray(value: unknown, pattern: RegExp, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== "string" || !pattern.test(entry))) {
    throw new Error(`${label} are invalid`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contain duplicates`);
  return Object.freeze([...value]) as readonly string[];
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Base64url value is invalid");
  return new Uint8Array(Buffer.from(value, "base64url"));
}
