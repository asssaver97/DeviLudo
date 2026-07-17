import type { TrustedPlatformSession } from "../connections/github-broker";

const MAX_RESPONSE_BYTES = 64 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
type FetchLike = typeof fetch;

export interface ReleaseAuthorizationResult {
  readonly releaseId: string;
  readonly state: "MFA_REQUIRED" | "DISPATCHED";
  readonly approvalId: string;
  readonly authorizationUrl: string | null;
  readonly workflowId: string | null;
  readonly expiresAt: string;
}

export interface ReleaseAuthorizationRuntime {
  readonly broker: ReleaseAuthorizationBrokerClient;
  readonly sessionHmacKey: Uint8Array;
}

export class ReleaseAuthorizationBrokerClient {
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
    this.#origin = requireRootHttpsOrigin(options.endpoint, "Release authorization broker");
    this.#publicOrigin = requireRootHttpsOrigin(options.publicOrigin, "Release authorization public");
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error("Release authorization broker timeout is invalid");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = timeoutMs;
    this.#now = options.now ?? (() => new Date());
  }

  async begin(
    principal: TrustedPlatformSession,
    releaseId: string,
    idempotencyKey: string,
  ): Promise<ReleaseAuthorizationResult> {
    validatePrincipal(principal);
    if (!OPAQUE_ID.test(releaseId) || !OPAQUE_ID.test(idempotencyKey)) throw new Error("Release authorization identity is invalid");
    const url = new URL(`/v1/releases/${encodeURIComponent(releaseId)}/accept-and-publish`, this.#origin);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          principal: {
            tenantId: principal.tenantId,
            userId: principal.userId,
            sessionBinding: principal.sessionBinding,
          },
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new Error("Release authorization broker is unavailable");
    }
    if (!response.ok) throw new Error(`Release authorization broker rejected the request with status ${response.status}`);
    const body = await readObject(response);
    if (body.releaseId !== releaseId) throw new Error("Release authorization binding is invalid");
    const state = body.state;
    if (state !== "MFA_REQUIRED" && state !== "DISPATCHED") throw new Error("Release authorization state is invalid");
    const approvalId = requireOpaqueId(body.approvalId, "Release approval");
    const expiresAt = requireIso(body.expiresAt, "Release authorization expiry");
    const now = this.#now();
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(now.getTime()) || expiry <= now.getTime() || expiry > now.getTime() + 10 * 60_000) {
      throw new Error("Release authorization expiry is invalid");
    }
    let authorizationUrl: string | null = null;
    let workflowId: string | null = null;
    if (state === "MFA_REQUIRED") {
      if (typeof body.authorizationUrl !== "string") throw new Error("Release authorization URL is missing");
      authorizationUrl = validateAuthorizationUrl(body.authorizationUrl, this.#publicOrigin, approvalId);
      if (body.workflowId !== null && body.workflowId !== undefined) throw new Error("Pending release authorization exposed a workflow ID");
    } else {
      workflowId = requireOpaqueId(body.workflowId, "Release workflow");
      if (body.authorizationUrl !== null && body.authorizationUrl !== undefined) throw new Error("Dispatched release authorization returned an MFA URL");
    }
    return Object.freeze({ releaseId, state, approvalId, authorizationUrl, workflowId, expiresAt });
  }
}

export function releaseAuthorizationRuntimeFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReleaseAuthorizationRuntime | null {
  const endpoint = env.DEVILUDO_RELEASE_AUTHORIZATION_BROKER_URL?.trim();
  if (!endpoint) return null;
  const publicOrigin = env.DEVILUDO_RELEASE_AUTHORIZATION_PUBLIC_ORIGIN?.trim();
  const encodedKey = env.DEVILUDO_SESSION_HMAC_KEY?.trim();
  if (!publicOrigin || !encodedKey) throw new Error("Release authorization Broker requires its public origin and session HMAC key");
  const sessionHmacKey = decodeBase64Url(encodedKey);
  if (sessionHmacKey.byteLength < 32 || sessionHmacKey.byteLength > 64) throw new Error("Platform session HMAC key is invalid");
  return Object.freeze({
    broker: new ReleaseAuthorizationBrokerClient({ endpoint, publicOrigin }),
    sessionHmacKey,
  });
}

function validatePrincipal(principal: TrustedPlatformSession): void {
  if (!OPAQUE_ID.test(principal.tenantId) || !OPAQUE_ID.test(principal.userId)
    || principal.sessionBinding.length < 32 || principal.sessionBinding.length > 512
    || /[\u0000-\u001f\u007f]/.test(principal.sessionBinding)) {
    throw new Error("Release authorization principal is invalid");
  }
}

function requireRootHttpsOrigin(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} origin is invalid`);
  }
  return url;
}

function validateAuthorizationUrl(value: string, publicOrigin: URL, approvalId: string): string {
  const url = new URL(value);
  if (url.origin !== publicOrigin.origin || url.pathname !== `/approvals/${encodeURIComponent(approvalId)}`
    || url.username || url.password || url.search || url.hash) {
    throw new Error("Release authorization URL is invalid");
  }
  return url.href;
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Release authorization response exceeds the size limit");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("Release authorization response exceeds the size limit");
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Release authorization response is invalid JSON");
  }
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw new Error(`${label} ID is invalid`);
  return value;
}

function requireIso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  return new Date(value).toISOString();
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Base64url value is invalid");
  return new Uint8Array(Buffer.from(value, "base64url"));
}
