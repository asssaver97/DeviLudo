import type { GitHubClientSecretResolver } from "../../scm-proxy/src/github-auth-contracts";
import type { GitHubIdentityVerifier, VerifiedGitHubIdentity } from "./contracts";

const GITHUB_WEB_ORIGIN = "https://github.com/";
const GITHUB_API_ORIGIN = "https://api.github.com/";
const API_VERSION = "2026-03-10";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
type FetchLike = typeof fetch;

/**
 * Exchanges a single OAuth callback, resolves /user, and revokes the resulting
 * GitHub token before returning public identity attributes.
 */
export class GitHubRestIdentityVerifier implements GitHubIdentityVerifier {
  readonly #clientId: string;
  readonly #clientSecretRef: string;
  readonly #redirectUri: string;
  readonly #secrets: GitHubClientSecretResolver;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly clientId: string;
    readonly clientSecretRef: string;
    readonly redirectUri: string;
    readonly secrets: GitHubClientSecretResolver;
    readonly fetch?: FetchLike;
    readonly timeoutMs?: number;
  }) {
    if (!/^(?:Iv1\.[A-Za-z0-9]{16,}|Ov23li[A-Za-z0-9]{10,})$/.test(options.clientId)) invalid();
    if (!/^vault:\/\/[A-Za-z0-9._~:/-]{1,500}$/.test(options.clientSecretRef)) invalid();
    validateRedirectUri(options.redirectUri);
    const timeout = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 60_000) invalid();
    this.#clientId = options.clientId;
    this.#clientSecretRef = options.clientSecretRef;
    this.#redirectUri = options.redirectUri;
    this.#secrets = options.secrets;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = timeout;
  }

  async verify(input: { readonly code: string; readonly codeVerifier: string; readonly at: string }): Promise<VerifiedGitHubIdentity> {
    validateInput(input);
    const secret = await this.#secrets.resolve(this.#clientSecretRef);
    if (!secret.value || secret.value.length > 1_024 || /[\u0000-\u0020]/.test(secret.value)) {
      secret.destroy();
      throw new Error("GitHub login client secret lease is invalid");
    }
    let accessToken: string | null = null;
    let identity: VerifiedGitHubIdentity | null = null;
    let primaryError: unknown;
    try {
      accessToken = await this.#exchange(input.code, input.codeVerifier, secret.value);
      identity = await this.#user(accessToken);
    } catch (error) { primaryError = error; }
    let revokeError: unknown;
    if (accessToken) {
      try { await this.#revoke(accessToken, secret.value); }
      catch (error) { revokeError = error; }
    }
    secret.destroy();
    accessToken = null;
    if (primaryError) throw primaryError;
    if (revokeError) throw new Error("GitHub login token could not be revoked");
    if (!identity) throw new Error("GitHub login did not produce an identity");
    return identity;
  }

  async #exchange(code: string, codeVerifier: string, clientSecret: string): Promise<string> {
    const response = await request(this.#fetch, new URL("/login/oauth/access_token", GITHUB_WEB_ORIGIN), {
      method: "POST", redirect: "error",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "DeviLudo-Identity/1.0" },
      body: new URLSearchParams({ client_id: this.#clientId, client_secret: clientSecret, code,
        redirect_uri: this.#redirectUri, code_verifier: codeVerifier }).toString(),
    }, this.#timeoutMs);
    if (response.status !== 200) throw new Error("GitHub rejected the login code exchange");
    const body = await readObject(response);
    if (body.error !== undefined) throw new Error("GitHub rejected the login code exchange");
    const token = requireString(body, "access_token", 2_048);
    if (!/^(?:ghu|gho)_[A-Za-z0-9_]+$/.test(token) || /[\u0000-\u0020]/.test(token)) throw new Error("GitHub returned an invalid login token");
    if (requireString(body, "token_type", 20).toLowerCase() !== "bearer") throw new Error("GitHub returned an invalid login token type");
    return token;
  }

  async #user(token: string): Promise<VerifiedGitHubIdentity> {
    const response = await request(this.#fetch, new URL("/user", GITHUB_API_ORIGIN), {
      method: "GET", redirect: "error", headers: apiHeaders(token),
    }, this.#timeoutMs);
    if (response.status !== 200) throw new Error("GitHub rejected the authenticated user lookup");
    const body = await readObject(response);
    const login = requireString(body, "login", 100);
    const name = body.name === null || body.name === undefined ? login : requireString(body, "name", 160);
    const avatar = new URL(requireString(body, "avatar_url", 2_048));
    if (avatar.protocol !== "https:" || avatar.username || avatar.password || avatar.hash
      || (avatar.hostname !== "avatars.githubusercontent.com" && avatar.hostname !== "github.com")) {
      throw new Error("GitHub returned an invalid avatar URL");
    }
    return Object.freeze({
      githubUserId: requirePositiveInteger(body, "id"), githubNodeId: requireString(body, "node_id", 256),
      githubLogin: login, displayName: name, avatarUrl: avatar.href,
    });
  }

  async #revoke(token: string, clientSecret: string): Promise<void> {
    const credentials = Buffer.from(`${this.#clientId}:${clientSecret}`).toString("base64");
    const response = await request(this.#fetch,
      new URL(`/applications/${encodeURIComponent(this.#clientId)}/token`, GITHUB_API_ORIGIN), {
        method: "DELETE", redirect: "error",
        headers: { ...apiHeaders(token), authorization: `Basic ${credentials}` },
        body: JSON.stringify({ access_token: token }),
      }, this.#timeoutMs);
    if (response.status !== 204) throw new Error("GitHub rejected the login token revocation");
  }
}

function validateInput(input: { code: string; codeVerifier: string; at: string }): void {
  if (!input.code || input.code.length > 512 || /[\u0000-\u0020]/.test(input.code)
    || !/^[A-Za-z0-9_-]{43}$/.test(input.codeVerifier) || !Number.isFinite(Date.parse(input.at))) invalid();
}
function validateRedirectUri(value: string): void {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if ((!loopback && url.protocol !== "https:") || url.username || url.password || url.search || url.hash
    || url.pathname !== "/api/auth/github/callback") invalid();
}
function apiHeaders(token: string): Record<string, string> {
  return { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
    "content-type": "application/json", "user-agent": "DeviLudo-Identity/1.0", "x-github-api-version": API_VERSION };
}
async function request(fetcher: FetchLike, url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  if ((url.origin !== new URL(GITHUB_WEB_ORIGIN).origin && url.origin !== new URL(GITHUB_API_ORIGIN).origin)
    || url.protocol !== "https:" || url.username || url.password || url.hash) invalid();
  try { return await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new Error("GitHub login request failed before a trusted response was received"); }
}
async function readObject(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("GitHub login response exceeds the size limit");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("GitHub login response exceeds the size limit");
  try { const value: unknown = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new Error("GitHub login response is invalid JSON"); }
}
function requireString(body: Record<string, unknown>, name: string, maximum: number): string {
  const value = body[name]; if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`GitHub ${name} is invalid`); return value;
}
function requirePositiveInteger(body: Record<string, unknown>, name: string): number {
  const value = body[name]; if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`GitHub ${name} is invalid`); return value as number;
}
function invalid(): never { throw new Error("GitHub identity verifier configuration is invalid"); }
