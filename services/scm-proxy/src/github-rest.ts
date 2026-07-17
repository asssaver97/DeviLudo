import type {
  GitHubAppJwtSigner,
  GitHubCommitSnapshot,
  GitHubInstallationAccessToken,
  GitHubInstallationTokenBroker,
  GitHubPullRequestSnapshot,
  GitHubReference,
  GitHubRepositoryBinding,
  GitHubRepositorySnapshot,
  GitHubScmConnector,
} from "./github-contracts";

const DEFAULT_API_BASE_URL = "https://api.github.com/";
const DEFAULT_API_VERSION = "2026-03-10";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SHA1 = /^[a-f0-9]{40}$/;

type FetchLike = typeof fetch;

export class GitHubAppInstallationTokenBroker implements GitHubInstallationTokenBroker {
  readonly #appId: string;
  readonly #signer: GitHubAppJwtSigner;
  readonly #fetch: FetchLike;
  readonly #apiBaseUrl: URL;
  readonly #apiVersion: string;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly appId: string;
    readonly signer: GitHubAppJwtSigner;
    readonly fetch?: FetchLike;
    readonly apiBaseUrl?: string;
    readonly apiVersion?: string;
    readonly timeoutMs?: number;
  }) {
    if (!/^\d+$/.test(options.appId)) throw new Error("GitHub App ID must be numeric");
    if (!options.signer.keyId.trim()) throw new Error("GitHub App JWT signer key ID is required");
    this.#appId = options.appId;
    this.#signer = options.signer;
    this.#fetch = options.fetch ?? fetch;
    this.#apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.#apiVersion = validateApiVersion(options.apiVersion ?? DEFAULT_API_VERSION);
    this.#timeoutMs = validateTimeout(options.timeoutMs ?? 15_000);
  }

  async issue(binding: GitHubRepositoryBinding): Promise<GitHubInstallationAccessToken> {
    validateNumericInstallationId(binding.installationId);
    if (!Number.isSafeInteger(binding.repositoryId) || binding.repositoryId <= 0) throw new Error("GitHub repository ID is invalid");
    const now = Math.floor(Date.now() / 1_000);
    const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
    const claims = base64UrlJson({ iat: now - 60, exp: now + 9 * 60, iss: this.#appId });
    const signingInput = `${header}.${claims}`;
    const signature = await this.#signer.signRs256(new TextEncoder().encode(signingInput));
    if (!(signature instanceof Uint8Array) || signature.byteLength < 128) throw new Error("GitHub App JWT signer returned an invalid signature");
    const appJwt = `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
    const url = new URL(`/app/installations/${encodeURIComponent(binding.installationId)}/access_tokens`, this.#apiBaseUrl);
    const response = await fetchWithTimeout(this.#fetch, url, {
      method: "POST",
      redirect: "error",
      headers: githubHeaders(this.#apiVersion, appJwt),
      body: JSON.stringify({
        repository_ids: [binding.repositoryId],
        permissions: { contents: "write", pull_requests: "write" },
      }),
    }, this.#timeoutMs);
    if (response.status !== 201) throw githubStatusError("installation-token", response);
    const body = await readJsonObject(response);
    const token = requireString(body, "token", 1_024);
    const expiresAt = requireIsoDate(body, "expires_at");
    if (Date.parse(expiresAt) <= Date.now() + 5 * 60_000) throw new Error("GitHub installation token lifetime is unexpectedly short");
    const repositories = body.repositories;
    if (!Array.isArray(repositories)) throw new Error("GitHub installation token response omitted its repository scope");
    const ids = repositories.map((item) => objectNumber(item, "id"));
    if (ids.length !== 1 || ids[0] !== binding.repositoryId) throw new Error("GitHub installation token is not scoped only to the bound repository");
    const permissions = requireObject(body, "permissions");
    if (permissions.contents !== "write" || permissions.pull_requests !== "write") {
      throw new Error("GitHub installation token did not receive the required least privileges");
    }
    return Object.freeze({ value: token, expiresAt, installationId: binding.installationId, repositoryId: binding.repositoryId });
  }
}

export class GitHubRestConnector implements GitHubScmConnector {
  readonly #tokens: GitHubInstallationTokenBroker;
  readonly #fetch: FetchLike;
  readonly #apiBaseUrl: URL;
  readonly #apiVersion: string;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly tokens: GitHubInstallationTokenBroker;
    readonly fetch?: FetchLike;
    readonly apiBaseUrl?: string;
    readonly apiVersion?: string;
    readonly timeoutMs?: number;
  }) {
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? fetch;
    this.#apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.#apiVersion = validateApiVersion(options.apiVersion ?? DEFAULT_API_VERSION);
    this.#timeoutMs = validateTimeout(options.timeoutMs ?? 30_000);
  }

  async getRepository(binding: GitHubRepositoryBinding): Promise<GitHubRepositorySnapshot> {
    const body = await this.#requestObject(binding, "GET", `/repositories/${binding.repositoryId}`);
    const owner = requireObject(body, "owner");
    return Object.freeze({
      repositoryId: requireNumber(body, "id"),
      repositoryNodeId: requireString(body, "node_id", 256),
      owner: requireString(owner, "login", 100),
      name: requireString(body, "name", 100),
      defaultBranch: requireString(body, "default_branch", 128),
      archived: requireBoolean(body, "archived"),
      disabled: requireBoolean(body, "disabled"),
    });
  }

  async getReference(binding: GitHubRepositoryBinding, branch: string): Promise<GitHubReference | null> {
    const raw = await this.#request(binding, "GET", `${repositoryPath(binding)}/git/ref/heads/${encodeURIComponent(branch)}`, undefined, true);
    if (!raw) return null;
    const body = requireJsonObject(raw);
    const object = requireObject(body, "object");
    const commitSha = requireSha(requireString(object, "sha", 40), "reference commit");
    return Object.freeze({ branch, commitSha });
  }

  async getCommit(binding: GitHubRepositoryBinding, commitSha: string): Promise<GitHubCommitSnapshot> {
    const body = await this.#requestObject(binding, "GET", `${repositoryPath(binding)}/git/commits/${requireSha(commitSha, "commit")}`);
    const tree = requireObject(body, "tree");
    return Object.freeze({
      commitSha: requireSha(requireString(body, "sha", 40), "commit"),
      treeSha: requireSha(requireString(tree, "sha", 40), "tree"),
    });
  }

  async createBlob(binding: GitHubRepositoryBinding, contentBase64: string): Promise<{ readonly blobSha: string }> {
    const body = await this.#requestObject(binding, "POST", `${repositoryPath(binding)}/git/blobs`, { content: contentBase64, encoding: "base64" });
    return Object.freeze({ blobSha: requireSha(requireString(body, "sha", 40), "blob") });
  }

  async createTree(binding: GitHubRepositoryBinding, input: Parameters<GitHubScmConnector["createTree"]>[1]): Promise<{ readonly treeSha: string }> {
    const body = await this.#requestObject(binding, "POST", `${repositoryPath(binding)}/git/trees`, {
      base_tree: input.baseTreeSha,
      tree: input.entries,
    });
    return Object.freeze({ treeSha: requireSha(requireString(body, "sha", 40), "tree") });
  }

  async createCommit(binding: GitHubRepositoryBinding, input: Parameters<GitHubScmConnector["createCommit"]>[1]): Promise<{ readonly commitSha: string }> {
    const body = await this.#requestObject(binding, "POST", `${repositoryPath(binding)}/git/commits`, {
      message: input.message,
      tree: input.treeSha,
      parents: [input.parentCommitSha],
      author: input.author,
      committer: input.author,
    });
    return Object.freeze({ commitSha: requireSha(requireString(body, "sha", 40), "commit") });
  }

  async createReference(binding: GitHubRepositoryBinding, branch: string, commitSha: string): Promise<void> {
    await this.#request(binding, "POST", `${repositoryPath(binding)}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: requireSha(commitSha, "commit"),
    });
  }

  async findOpenPullRequest(binding: GitHubRepositoryBinding, headBranch: string, baseBranch: string): Promise<GitHubPullRequestSnapshot | null> {
    const body = await this.#request(binding, "GET", `${repositoryPath(binding)}/pulls`, undefined, false, {
      state: "open",
      head: `${binding.owner}:${headBranch}`,
      base: baseBranch,
      per_page: "2",
    });
    if (!Array.isArray(body)) throw new Error("GitHub pull request list response is invalid");
    if (body.length > 1) throw new Error("GitHub returned multiple open pull requests for one candidate branch");
    return body.length ? parsePullRequest(requireJsonObject(body[0])) : null;
  }

  async createDraftPullRequest(binding: GitHubRepositoryBinding, input: Parameters<GitHubScmConnector["createDraftPullRequest"]>[1]): Promise<GitHubPullRequestSnapshot> {
    const body = await this.#requestObject(binding, "POST", `${repositoryPath(binding)}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.headBranch,
      base: input.baseBranch,
      draft: true,
      maintainer_can_modify: false,
    });
    return parsePullRequest(body);
  }

  async getPullRequest(binding: GitHubRepositoryBinding, number: number): Promise<GitHubPullRequestSnapshot> {
    requirePositiveInteger(number, "pull request number");
    return parsePullRequest(await this.#requestObject(binding, "GET", `${repositoryPath(binding)}/pulls/${number}`));
  }

  async markPullRequestReady(binding: GitHubRepositoryBinding, nodeId: string): Promise<void> {
    if (!nodeId || nodeId.length > 256) throw new Error("GitHub pull request node ID is invalid");
    const body = await this.#requestObject(binding, "POST", "/graphql", {
      query: "mutation MarkReady($pullRequestId:ID!){markPullRequestReadyForReview(input:{pullRequestId:$pullRequestId}){pullRequest{id isDraft}}}",
      variables: { pullRequestId: nodeId },
    });
    if (Array.isArray(body.errors) && body.errors.length) throw new Error("GitHub GraphQL rejected the ready-for-review transition");
    const data = requireObject(body, "data");
    const transition = requireObject(data, "markPullRequestReadyForReview");
    const pullRequest = requireObject(transition, "pullRequest");
    if (requireString(pullRequest, "id", 256) !== nodeId || requireBoolean(pullRequest, "isDraft")) {
      throw new Error("GitHub did not mark the pull request ready for review");
    }
  }

  async mergePullRequest(binding: GitHubRepositoryBinding, input: Parameters<GitHubScmConnector["mergePullRequest"]>[1]): Promise<{ readonly merged: boolean; readonly mergeCommitSha: string; readonly message: string }> {
    requirePositiveInteger(input.number, "pull request number");
    const body = await this.#requestObject(binding, "PUT", `${repositoryPath(binding)}/pulls/${input.number}/merge`, {
      commit_title: input.commitTitle,
      commit_message: input.commitMessage,
      sha: requireSha(input.expectedHeadSha, "expected head"),
      merge_method: "merge",
    });
    return Object.freeze({
      merged: requireBoolean(body, "merged"),
      mergeCommitSha: requireSha(requireString(body, "sha", 40), "merge commit"),
      message: requireString(body, "message", 1_000),
    });
  }

  async #request(
    binding: GitHubRepositoryBinding,
    method: string,
    pathname: string,
    body?: unknown,
    allowNotFound = false,
    query?: Readonly<Record<string, string>>,
  ): Promise<Record<string, unknown> | unknown[] | null> {
    const access = await this.#tokens.issue(binding);
    validateAccessToken(access, binding);
    const url = new URL(pathname, this.#apiBaseUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const response = await fetchWithTimeout(this.#fetch, url, {
      method,
      redirect: "error",
      headers: githubHeaders(this.#apiVersion, access.value),
      body: body === undefined ? undefined : JSON.stringify(body),
    }, this.#timeoutMs);
    if (allowNotFound && response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) throw githubStatusError(`${method} ${pathname}`, response);
    return readJson(response);
  }

  async #requestObject(
    binding: GitHubRepositoryBinding,
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    return requireJsonObject(await this.#request(binding, method, pathname, body));
  }
}

function parsePullRequest(body: Record<string, unknown>): GitHubPullRequestSnapshot {
  const head = requireObject(body, "head");
  const base = requireObject(body, "base");
  const merged = typeof body.merged === "boolean" ? body.merged : false;
  const stateRaw = requireString(body, "state", 20);
  if (stateRaw !== "open" && stateRaw !== "closed") throw new Error("GitHub pull request state is invalid");
  const mergeCommitSha = body.merge_commit_sha === null || body.merge_commit_sha === undefined
    ? null
    : requireSha(String(body.merge_commit_sha), "merge commit");
  return Object.freeze({
    number: requirePositiveInteger(requireNumber(body, "number"), "pull request number"),
    nodeId: requireString(body, "node_id", 256),
    url: requireString(body, "html_url", 2_048),
    state: stateRaw === "open" ? "OPEN" : "CLOSED",
    draft: requireBoolean(body, "draft"),
    merged,
    headBranch: requireString(head, "ref", 128),
    headSha: requireSha(requireString(head, "sha", 40), "pull request head"),
    baseBranch: requireString(base, "ref", 128),
    mergeCommitSha,
  });
}

function repositoryPath(binding: GitHubRepositoryBinding): string {
  return `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.name)}`;
}

function githubHeaders(apiVersion: string, token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "DeviLudo-SCM-Proxy/1.0",
    "x-github-api-version": apiVersion,
  };
}

async function fetchWithTimeout(fetcher: FetchLike, url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error("GitHub API request failed before a trusted response was received");
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | unknown[]> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("GitHub API response exceeds the size limit");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("GitHub API response exceeds the size limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("GitHub API returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("GitHub API returned an invalid JSON payload");
  return parsed as Record<string, unknown> | unknown[];
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  return requireJsonObject(await readJson(response));
}

function requireJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub API object response is invalid");
  return value as Record<string, unknown>;
}

function requireObject(body: Record<string, unknown>, field: string): Record<string, unknown> {
  return requireJsonObject(body[field]);
}

function requireString(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field];
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`GitHub API ${field} is invalid`);
  return value;
}

function requireBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== "boolean") throw new Error(`GitHub API ${field} is invalid`);
  return value;
}

function requireNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`GitHub API ${field} is invalid`);
  return value as number;
}

function objectNumber(value: unknown, field: string): number {
  return requireNumber(requireJsonObject(value), field);
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`GitHub ${label} is invalid`);
  return value;
}

function requireSha(value: string, label: string): string {
  if (!SHA1.test(value)) throw new Error(`GitHub ${label} SHA is invalid`);
  return value;
}

function requireIsoDate(body: Record<string, unknown>, field: string): string {
  const value = requireString(body, field, 100);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`GitHub API ${field} timestamp is invalid`);
  return value;
}

function validateAccessToken(access: GitHubInstallationAccessToken, binding: GitHubRepositoryBinding): void {
  if (access.installationId !== binding.installationId || access.repositoryId !== binding.repositoryId
    || !access.value || access.value.length > 2_048 || /[\u0000-\u0020]/.test(access.value)
    || !Number.isFinite(Date.parse(access.expiresAt)) || Date.parse(access.expiresAt) <= Date.now()) {
    throw new Error("GitHub installation access token binding is invalid");
  }
}

function validateNumericInstallationId(value: string): void {
  if (!/^\d{1,20}$/.test(value)) throw new Error("GitHub installation ID is invalid");
}

function validateApiBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.href !== DEFAULT_API_BASE_URL || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Initial GitHub connector supports only the fixed https://api.github.com endpoint");
  }
  return url;
}

function validateApiVersion(value: string): string {
  if (value !== DEFAULT_API_VERSION) throw new Error(`GitHub API version must be pinned to ${DEFAULT_API_VERSION}`);
  return value;
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 60_000) throw new Error("GitHub API timeout is invalid");
  return value;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function githubStatusError(operation: string, response: Response): Error {
  const requestId = response.headers.get("x-github-request-id");
  return new Error(`GitHub API rejected ${operation} with status ${response.status}${requestId ? ` (request ${sanitizeRequestId(requestId)})` : ""}`);
}

function sanitizeRequestId(value: string): string {
  return /^[A-Za-z0-9:-]{1,100}$/.test(value) ? value : "invalid";
}
