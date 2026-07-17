import type { GitHubAuthorizationPrincipal } from "@/services/scm-proxy/src/github-auth-contracts";

const MAX_RESPONSE_BYTES = 64 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

type FetchLike = typeof fetch;

export interface GitHubBrokerRuntime {
  readonly broker: GitHubAuthorizationBrokerClient;
  readonly sessionHmacKey: Uint8Array;
}

export interface TrustedPlatformSession {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionBinding: string;
  readonly githubUserId: number;
}

export class GitHubAuthorizationBrokerClient {
  readonly #origin: URL;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly endpoint: string;
    readonly fetch?: FetchLike;
    readonly timeoutMs?: number;
  }) {
    const endpoint = new URL(options.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== "/"
    ) {
      throw new Error("GitHub authorization broker endpoint is invalid");
    }
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new Error("GitHub authorization broker timeout is invalid");
    }
    this.#origin = endpoint;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = timeoutMs;
  }

  async begin(
    principal: GitHubAuthorizationPrincipal,
    idempotencyKey: string,
  ): Promise<{ readonly authorizeUrl: string; readonly expiresAt: string }> {
    const payload = await this.#call("/v1/github/authorizations/begin", {
      principal,
      returnPath: "/settings/connections",
    }, idempotencyKey);
    const authorizeUrl = requireString(payload, "authorizeUrl", 2_048);
    validateGitHubInstallUrl(authorizeUrl);
    return Object.freeze({ authorizeUrl, expiresAt: requireIso(payload, "expiresAt") });
  }

  async setup(input: {
    readonly principal: GitHubAuthorizationPrincipal;
    readonly state: string;
    readonly installationId: string;
    readonly setupAction: "install" | "update";
    readonly idempotencyKey: string;
  }): Promise<{ readonly authorizeUrl: string; readonly expiresAt: string }> {
    const { idempotencyKey, ...body } = input;
    const payload = await this.#call("/v1/github/authorizations/setup", body, idempotencyKey);
    const authorizeUrl = requireString(payload, "authorizeUrl", 4_096);
    validateGitHubOauthUrl(authorizeUrl);
    return Object.freeze({ authorizeUrl, expiresAt: requireIso(payload, "expiresAt") });
  }

  async complete(input: {
    readonly principal: GitHubAuthorizationPrincipal;
    readonly state: string;
    readonly code: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly returnPath: string }> {
    const { idempotencyKey, ...body } = input;
    const payload = await this.#call("/v1/github/authorizations/complete", body, idempotencyKey);
    return Object.freeze({ returnPath: requireReturnPath(payload.returnPath) });
  }

  async #call(
    path: string,
    body: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    if (!OPAQUE_ID.test(idempotencyKey)) throw new Error("GitHub broker idempotency key is invalid");
    const url = new URL(path, this.#origin);
    if (url.origin !== this.#origin.origin) throw new Error("GitHub broker request origin is invalid");
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
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new Error("GitHub authorization broker is unavailable");
    }
    if (!response.ok) throw new Error(`GitHub authorization broker rejected the request with status ${response.status}`);
    return readObject(response);
  }
}

export function githubBrokerRuntimeFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GitHubBrokerRuntime | null {
  const endpoint = env.DEVILUDO_GITHUB_AUTH_BROKER_URL?.trim();
  if (!endpoint) return null;
  const encodedKey = env.DEVILUDO_SESSION_HMAC_KEY?.trim();
  if (!encodedKey) throw new Error("DEVILUDO_SESSION_HMAC_KEY is required with the GitHub broker");
  const sessionHmacKey = decodeBase64Url(encodedKey);
  if (sessionHmacKey.byteLength < 32 || sessionHmacKey.byteLength > 64) {
    throw new Error("Platform session HMAC key is invalid");
  }
  return Object.freeze({
    broker: new GitHubAuthorizationBrokerClient({ endpoint }),
    sessionHmacKey,
  });
}

export async function verifyTrustedGitHubSession(
  request: Request,
  key: Uint8Array,
  now: Date = new Date(),
): Promise<GitHubAuthorizationPrincipal> {
  const session = await verifyTrustedPlatformSession(request, key, now);
  return Object.freeze({
    tenantId: session.tenantId,
    userId: session.userId,
    sessionBinding: session.sessionBinding,
    expectedGithubUserId: session.githubUserId,
  });
}

export async function verifyTrustedPlatformSession(
  request: Request,
  key: Uint8Array,
  now: Date = new Date(),
): Promise<TrustedPlatformSession> {
  const tenantId = requiredHeader(request, "x-deviludo-session-tenant");
  const userId = requiredHeader(request, "x-deviludo-session-user");
  const sessionBinding = requiredHeader(request, "x-deviludo-session-binding", 512);
  const githubUserIdText = requiredHeader(request, "x-deviludo-session-github-user-id", 20);
  const issuedAtText = requiredHeader(request, "x-deviludo-session-issued-at", 20);
  const signature = requiredHeader(request, "x-deviludo-session-signature", 100);
  if (!OPAQUE_ID.test(tenantId) || !OPAQUE_ID.test(userId)) throw new Error("Trusted session principal is invalid");
  if (sessionBinding.length < 32 || /[\u0000-\u001f\u007f]/.test(sessionBinding)) throw new Error("Trusted session binding is invalid");
  if (!/^\d{1,20}$/.test(githubUserIdText)) throw new Error("Trusted GitHub user ID is invalid");
  const expectedGithubUserId = Number(githubUserIdText);
  if (!Number.isSafeInteger(expectedGithubUserId) || expectedGithubUserId < 1) throw new Error("Trusted GitHub user ID is invalid");
  const issuedAt = Number(issuedAtText);
  if (!Number.isSafeInteger(issuedAt) || !Number.isFinite(now.getTime()) || Math.abs(now.getTime() - issuedAt) > 60_000) {
    throw new Error("Trusted session assertion is stale");
  }
  if (!SIGNATURE.test(signature)) throw new Error("Trusted session signature is invalid");
  const canonical = sessionCanonical(request.method, new URL(request.url).pathname, {
    tenantId,
    userId,
    sessionBinding,
    githubUserId: githubUserIdText,
    issuedAt: issuedAtText,
  });
  const cryptoKey = await crypto.subtle.importKey("raw", toArrayBuffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const verified = await crypto.subtle.verify("HMAC", cryptoKey, toArrayBuffer(decodeBase64Url(signature)), new TextEncoder().encode(canonical));
  if (!verified) throw new Error("Trusted session signature is invalid");
  return Object.freeze({ tenantId, userId, sessionBinding, githubUserId: expectedGithubUserId });
}

/** Used by the trusted session proxy and contract tests, never by browsers. */
export async function signTrustedGitHubSession(input: {
  readonly method: string;
  readonly pathname: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionBinding: string;
  readonly githubUserId: string;
  readonly issuedAt: string;
  readonly key: Uint8Array;
}): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", toArrayBuffer(input.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(sessionCanonical(input.method, input.pathname, input)));
  return encodeBase64Url(new Uint8Array(signature));
}

export function requireGitHubSetupParameters(url: URL): {
  state: string;
  installationId: string;
  setupAction: "install" | "update";
} {
  const state = url.searchParams.get("state") ?? "";
  const installationId = url.searchParams.get("installation_id") ?? "";
  const setupAction = url.searchParams.get("setup_action") ?? "";
  if (!STATE.test(state) || !/^\d{1,20}$/.test(installationId) || installationId === "0" || (setupAction !== "install" && setupAction !== "update")) {
    throw new Error("GitHub setup callback parameters are invalid");
  }
  return { state, installationId, setupAction };
}

export function requireGitHubOauthParameters(url: URL): { state: string; code: string } {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!STATE.test(state) || !code || code.length > 512 || /[\u0000-\u0020]/.test(code)) {
    throw new Error("GitHub OAuth callback parameters are invalid");
  }
  return { state, code };
}

export async function githubCallbackIdempotencyKey(
  stage: "setup" | "oauth",
  state: string,
): Promise<string> {
  if (!STATE.test(state)) throw new Error("GitHub callback state is invalid");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  return `github-${stage}-${Buffer.from(digest).toString("hex")}`;
}

function sessionCanonical(
  method: string,
  pathname: string,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly sessionBinding: string;
    readonly githubUserId: string;
    readonly issuedAt: string;
  },
): string {
  return ["deviludo.session.v1", input.issuedAt, method.toUpperCase(), pathname, input.tenantId, input.userId, input.githubUserId, input.sessionBinding].join("\n");
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("GitHub broker response exceeds the size limit");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("GitHub broker response exceeds the size limit");
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
    return value as Record<string, unknown>;
  } catch {
    throw new Error("GitHub broker response is invalid JSON");
  }
}

function validateGitHubInstallUrl(value: string): void {
  const url = new URL(value);
  if (url.origin !== "https://github.com" || !/^\/apps\/[a-z0-9][a-z0-9-]{0,99}\/installations\/new$/.test(url.pathname) || !STATE.test(url.searchParams.get("state") ?? "")) {
    throw new Error("GitHub broker returned an invalid installation URL");
  }
}

function validateGitHubOauthUrl(value: string): void {
  const url = new URL(value);
  if (
    url.origin !== "https://github.com" ||
    url.pathname !== "/login/oauth/authorize" ||
    !url.searchParams.get("client_id") ||
    !STATE.test(url.searchParams.get("state") ?? "") ||
    !STATE.test(url.searchParams.get("code_challenge") ?? "") ||
    url.searchParams.get("code_challenge_method") !== "S256"
  ) {
    throw new Error("GitHub broker returned an invalid OAuth URL");
  }
}

function requireReturnPath(value: unknown): string {
  if (value === "/settings/connections" || (typeof value === "string" && /^\/projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/settings\/connections$/.test(value))) {
    return value;
  }
  throw new Error("GitHub broker return path is invalid");
}

function requireString(value: Record<string, unknown>, field: string, max: number): string {
  const entry = value[field];
  if (typeof entry !== "string" || !entry || entry.length > max || /[\u0000-\u001f]/.test(entry)) throw new Error(`GitHub broker ${field} is invalid`);
  return entry;
}

function requireIso(value: Record<string, unknown>, field: string): string {
  const entry = requireString(value, field, 100);
  if (!Number.isFinite(Date.parse(entry))) throw new Error(`GitHub broker ${field} is invalid`);
  return entry;
}

function requiredHeader(request: Request, name: string, max = 160): string {
  const value = request.headers.get(name);
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Trusted session assertion is incomplete");
  return value;
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Base64url value is invalid");
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}
