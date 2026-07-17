import type {
  GitHubClientSecretResolver,
  GitHubUserAuthorizationVerifier,
  GitHubVerifiedInstallation,
} from "./github-auth-contracts";

const GITHUB_WEB_ORIGIN = "https://github.com/";
const GITHUB_API_ORIGIN = "https://api.github.com/";
const API_VERSION = "2026-03-10";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_INSTALLATION_PAGES = 10;

type FetchLike = typeof fetch;

export class GitHubRestUserAuthorizationVerifier implements GitHubUserAuthorizationVerifier {
  readonly #clientId: string;
  readonly #clientSecretRef: string;
  readonly #appSlug: string;
  readonly #redirectUri: string;
  readonly #secrets: GitHubClientSecretResolver;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly clientId: string;
    readonly clientSecretRef: string;
    readonly appSlug: string;
    readonly redirectUri: string;
    readonly secrets: GitHubClientSecretResolver;
    readonly fetch?: FetchLike;
    readonly timeoutMs?: number;
  }) {
    if (!/^(?:Iv1\.[A-Za-z0-9]{16,}|Ov23li[A-Za-z0-9]{10,})$/.test(options.clientId)) throw new Error("GitHub App client ID is invalid");
    if (!/^vault:\/\/[A-Za-z0-9._~:/-]{1,500}$/.test(options.clientSecretRef)) throw new Error("GitHub App client SecretRef is invalid");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(options.appSlug)) throw new Error("GitHub App slug is invalid");
    validateRedirectUri(options.redirectUri);
    this.#clientId = options.clientId;
    this.#clientSecretRef = options.clientSecretRef;
    this.#appSlug = options.appSlug;
    this.#redirectUri = options.redirectUri;
    this.#secrets = options.secrets;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = validateTimeout(options.timeoutMs ?? 15_000);
  }

  async verify(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly installationId: string;
    readonly expectedGithubUserId: number;
    readonly at: string;
  }): Promise<GitHubVerifiedInstallation> {
    validateInput(input);
    const secret = await this.#secrets.resolve(this.#clientSecretRef);
    if (!secret.value || secret.value.length > 1_024 || /[\u0000-\u0020]/.test(secret.value)) {
      secret.destroy();
      throw new Error("GitHub App client secret lease is invalid");
    }

    let accessToken: string | null = null;
    let result: GitHubVerifiedInstallation | null = null;
    let primaryError: unknown;
    try {
      accessToken = await this.#exchangeCode(input.code, input.codeVerifier, secret.value);
      const user = await this.#getUser(accessToken);
      if (user.id !== input.expectedGithubUserId) throw new Error("GitHub user authorization does not match the signed-in account");
      const installation = await this.#findInstallation(accessToken, input.installationId);
      result = parseVerifiedInstallation(installation, user, input.installationId, this.#appSlug, input.at);
    } catch (error) {
      primaryError = error;
    }

    let revokeError: unknown;
    if (accessToken) {
      try {
        await this.#revokeToken(accessToken, secret.value);
      } catch (error) {
        revokeError = error;
      }
    }
    secret.destroy();

    if (primaryError) throw primaryError;
    if (revokeError) throw new Error("GitHub ephemeral user token could not be revoked");
    if (!result) throw new Error("GitHub installation verification did not produce a result");
    return result;
  }

  async #exchangeCode(code: string, codeVerifier: string, clientSecret: string): Promise<string> {
    const url = new URL("/login/oauth/access_token", GITHUB_WEB_ORIGIN);
    const body = new URLSearchParams({
      client_id: this.#clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: this.#redirectUri,
      code_verifier: codeVerifier,
    });
    const response = await request(this.#fetch, url, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "DeviLudo-SCM-Proxy/1.0",
      },
      body: body.toString(),
    }, this.#timeoutMs);
    if (response.status !== 200) throw statusError("OAuth code exchange", response);
    const payload = await readObject(response);
    if (payload.error !== undefined) throw new Error("GitHub rejected the OAuth code exchange");
    const token = requireString(payload, "access_token", 2_048);
    if (!token.startsWith("ghu_") || /[\u0000-\u0020]/.test(token)) throw new Error("GitHub returned an invalid user access token");
    if (requireString(payload, "token_type", 20).toLowerCase() !== "bearer") throw new Error("GitHub returned an invalid user token type");
    return token;
  }

  async #getUser(accessToken: string): Promise<{ readonly id: number; readonly nodeId: string; readonly login: string }> {
    const response = await this.#apiRequest(accessToken, "/user");
    const body = await readObject(response);
    return Object.freeze({
      id: requirePositiveInteger(body, "id"),
      nodeId: requireString(body, "node_id", 256),
      login: requireString(body, "login", 100),
    });
  }

  async #findInstallation(accessToken: string, installationId: string): Promise<Record<string, unknown>> {
    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
      const response = await this.#apiRequest(accessToken, `/user/installations?per_page=100&page=${page}`);
      const body = await readObject(response);
      const installations = body.installations;
      if (!Array.isArray(installations)) throw new Error("GitHub installation list response is invalid");
      for (const raw of installations) {
        const installation = requireObjectValue(raw);
        const id = requirePositiveInteger(installation, "id");
        if (String(id) === installationId) return installation;
      }
      if (installations.length < 100) break;
    }
    throw new Error("GitHub user cannot access the requested App installation");
  }

  async #apiRequest(accessToken: string, pathAndQuery: string): Promise<Response> {
    const url = new URL(pathAndQuery, GITHUB_API_ORIGIN);
    if (url.origin !== new URL(GITHUB_API_ORIGIN).origin) throw new Error("GitHub API request origin is invalid");
    const response = await request(this.#fetch, url, {
      method: "GET",
      redirect: "error",
      headers: apiHeaders(accessToken),
    }, this.#timeoutMs);
    if (response.status !== 200) throw statusError("user authorization verification", response);
    return response;
  }

  async #revokeToken(accessToken: string, clientSecret: string): Promise<void> {
    const url = new URL(`/applications/${encodeURIComponent(this.#clientId)}/token`, GITHUB_API_ORIGIN);
    const credentials = Buffer.from(`${this.#clientId}:${clientSecret}`).toString("base64");
    const response = await request(this.#fetch, url, {
      method: "DELETE",
      redirect: "error",
      headers: {
        ...apiHeaders(accessToken),
        authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({ access_token: accessToken }),
    }, this.#timeoutMs);
    if (response.status !== 204) throw statusError("ephemeral user token revocation", response);
  }
}

function parseVerifiedInstallation(
  body: Record<string, unknown>,
  user: { readonly id: number; readonly nodeId: string; readonly login: string },
  installationId: string,
  appSlug: string,
  at: string,
): GitHubVerifiedInstallation {
  if (String(requirePositiveInteger(body, "id")) !== installationId) throw new Error("GitHub installation response changed identity");
  if (requireString(body, "app_slug", 100) !== appSlug) throw new Error("GitHub installation belongs to another App");
  if (body.suspended_at !== null && body.suspended_at !== undefined) throw new Error("GitHub installation is suspended");
  const account = requireObject(body, "account");
  const rawSelection = requireString(body, "repository_selection", 20);
  if (rawSelection !== "all" && rawSelection !== "selected") throw new Error("GitHub repository selection is invalid");
  const permissionsBody = requireObject(body, "permissions");
  const permissions: Record<string, string> = {};
  for (const [key, value] of Object.entries(permissionsBody)) {
    if (!/^[a-z_]{1,100}$/.test(key) || (value !== "read" && value !== "write" && value !== "admin")) {
      throw new Error("GitHub installation permissions are invalid");
    }
    permissions[key] = value;
  }
  if (permissions.contents !== "write" || permissions.pull_requests !== "write" || permissions.metadata !== "read") {
    throw new Error("GitHub installation lacks the required repository permissions");
  }
  for (const [permission, level] of Object.entries(permissions)) {
    if (!new Set(["contents", "pull_requests", "metadata"]).has(permission) && (level === "write" || level === "admin")) {
      throw new Error("GitHub installation has an unapproved elevated permission");
    }
  }
  return Object.freeze({
    installationId,
    githubUserId: user.id,
    githubUserNodeId: user.nodeId,
    githubUserLogin: user.login,
    accountNodeId: requireString(account, "node_id", 256),
    accountLogin: requireString(account, "login", 100),
    repositorySelection: rawSelection,
    permissions: Object.freeze(permissions),
    appSlug,
    verifiedAt: requireIso(at, "verification"),
  });
}

function validateInput(input: { code: string; codeVerifier: string; installationId: string; expectedGithubUserId: number; at: string }): void {
  if (!input.code || input.code.length > 512 || /[\u0000-\u0020]/.test(input.code)) throw new Error("GitHub OAuth code is invalid");
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.codeVerifier)) throw new Error("GitHub PKCE verifier is invalid");
  if (!/^\d{1,20}$/.test(input.installationId) || input.installationId === "0") throw new Error("GitHub installation ID is invalid");
  if (!Number.isSafeInteger(input.expectedGithubUserId) || input.expectedGithubUserId <= 0) throw new Error("GitHub expected user is invalid");
  requireIso(input.at, "verification");
}

function validateRedirectUri(value: string): void {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash
    || url.pathname !== "/api/connections/github/callback") throw new Error("GitHub OAuth redirect URI is invalid");
}

function apiHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "DeviLudo-SCM-Proxy/1.0",
    "x-github-api-version": API_VERSION,
  };
}

async function request(fetcher: FetchLike, url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const allowed = url.origin === new URL(GITHUB_WEB_ORIGIN).origin || url.origin === new URL(GITHUB_API_ORIGIN).origin;
  if (!allowed || url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("GitHub request URL is invalid");
  try {
    return await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error("GitHub authorization request failed before a trusted response was received");
  }
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("GitHub authorization response exceeds the size limit");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("GitHub authorization response exceeds the size limit");
  try {
    return requireObjectValue(JSON.parse(text));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GitHub")) throw error;
    throw new Error("GitHub authorization response is invalid JSON");
  }
}

function requireObject(body: Record<string, unknown>, field: string): Record<string, unknown> {
  return requireObjectValue(body[field]);
}

function requireObjectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub authorization object is invalid");
  return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field];
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`GitHub authorization ${field} is invalid`);
  return value;
}

function requirePositiveInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`GitHub authorization ${field} is invalid`);
  return value as number;
}

function requireIso(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`GitHub ${label} time is invalid`);
  return value;
}

function statusError(operation: string, response: Response): Error {
  const rawId = response.headers.get("x-github-request-id") ?? "";
  const requestId = /^[A-Za-z0-9:-]{1,100}$/.test(rawId) ? ` (request ${rawId})` : "";
  return new Error(`GitHub rejected ${operation} with status ${response.status}${requestId}`);
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 60_000) throw new Error("GitHub authorization timeout is invalid");
  return value;
}
