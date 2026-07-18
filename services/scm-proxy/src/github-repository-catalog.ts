import type { GitHubAppJwtSigner } from "./github-contracts";
import type { GitHubInstallationRepositoryCatalog, GitHubRepositoryCatalogItem } from "./project-repository-contracts";

const API_ORIGIN = "https://api.github.com/";
const API_VERSION = "2026-03-10";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 10;
type FetchLike = typeof fetch;
type GitHubRepositoryCatalogCandidate = Omit<GitHubRepositoryCatalogItem, "archived" | "disabled"> & {
  readonly archived: boolean;
  readonly disabled: boolean;
};

/** Lists only repositories currently exposed by one verified App installation. */
export class GitHubAppRepositoryCatalog implements GitHubInstallationRepositoryCatalog {
  readonly #appId: string;
  readonly #signer: GitHubAppJwtSigner;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: Readonly<{
    appId: string;
    signer: GitHubAppJwtSigner;
    fetch?: FetchLike;
    timeoutMs?: number;
  }>) {
    if (!/^\d{1,20}$/.test(options.appId) || options.appId === "0" || !options.signer.keyId) invalid();
    this.#appId = options.appId;
    this.#signer = options.signer;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = integer(options.timeoutMs ?? 15_000, 1_000, 60_000);
  }

  async list(installationId: string): Promise<readonly GitHubRepositoryCatalogItem[]> {
    if (!/^\d{1,20}$/.test(installationId) || installationId === "0") invalid();
    const token = await this.#issueCatalogToken(installationId);
    const repositories: GitHubRepositoryCatalogItem[] = [];
    let primaryError: unknown;
    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = await this.#request(token, "GET", `/installation/repositories?per_page=100&page=${page}`);
        if (response.status !== 200) throw new Error("GitHub rejected repository catalog lookup");
        const body = await readObject(response);
        if (!Array.isArray(body.repositories)) invalid();
        for (const raw of body.repositories) {
          const repository = parseRepository(raw, installationId);
          if (!repository.archived && !repository.disabled) {
            repositories.push(Object.freeze({ ...repository, archived: false, disabled: false }));
          }
        }
        if (body.repositories.length < 100) break;
        if (page === MAX_PAGES) throw new Error("GitHub repository catalog exceeds the supported page limit");
      }
    } catch (error) { primaryError = error; }
    let revokeError: unknown;
    try {
      const response = await this.#request(token, "DELETE", "/installation/token");
      if (response.status !== 204) revokeError = new Error("GitHub catalog token could not be revoked");
    } catch (error) { revokeError = error; }
    if (primaryError) throw primaryError;
    if (revokeError) throw revokeError;
    repositories.sort((left, right) => left.owner.localeCompare(right.owner)
      || left.name.localeCompare(right.name) || left.repositoryId - right.repositoryId);
    if (new Set(repositories.map((item) => item.repositoryId)).size !== repositories.length) invalid();
    return Object.freeze(repositories);
  }

  async #issueCatalogToken(installationId: string): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
    const claims = base64UrlJson({ iat: now - 60, exp: now + 9 * 60, iss: this.#appId });
    const signingInput = `${header}.${claims}`;
    const signature = await this.#signer.signRs256(new TextEncoder().encode(signingInput));
    if (!(signature instanceof Uint8Array) || signature.byteLength < 128 || signature.byteLength > 1_024) invalid();
    const appJwt = `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
    const response = await request(this.#fetch, `/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: headers(appJwt),
      body: JSON.stringify({ permissions: { metadata: "read" } }),
    }, this.#timeoutMs);
    if (response.status !== 201) throw new Error("GitHub rejected repository catalog token issuance");
    const body = await readObject(response);
    const token = string(body.token, 1_024);
    if (!token.startsWith("ghs_") || /[\u0000-\u0020]/.test(token)) invalid();
    const expiresAt = Date.parse(string(body.expires_at, 100));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) invalid();
    const permissions = object(body.permissions);
    if (permissions.metadata !== "read" || Object.keys(permissions).length !== 1) invalid();
    return token;
  }

  #request(token: string, method: "GET" | "DELETE", pathAndQuery: string): Promise<Response> {
    return request(this.#fetch, pathAndQuery, { method, headers: headers(token) }, this.#timeoutMs);
  }
}

function parseRepository(value: unknown, installationId: string): GitHubRepositoryCatalogCandidate {
  const body = object(value);
  const owner = object(body.owner);
  const repositoryId = positiveInteger(body.id);
  const repositoryNodeId = string(body.node_id, 256);
  const ownerLogin = string(owner.login, 100);
  const name = string(body.name, 100);
  const defaultBranch = string(body.default_branch, 255);
  const isPrivate = boolean(body.private);
  const archived = boolean(body.archived);
  const disabled = boolean(body.disabled);
  return Object.freeze({
    installationId,
    repositoryId,
    repositoryNodeId,
    owner: ownerLogin,
    name,
    defaultBranch,
    private: isPrivate,
    archived,
    disabled,
  });
}

async function request(fetcher: FetchLike, pathAndQuery: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const url = new URL(pathAndQuery, API_ORIGIN);
  if (url.origin !== new URL(API_ORIGIN).origin || url.protocol !== "https:" || url.username || url.password || url.hash) invalid();
  try { return await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new Error("GitHub repository catalog request failed before a trusted response"); }
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) invalid();
  const textBody = await response.text();
  if (Buffer.byteLength(textBody, "utf8") > MAX_RESPONSE_BYTES) invalid();
  try { return object(JSON.parse(textBody) as unknown); }
  catch { invalid(); }
}
function headers(token: string): Record<string, string> { return { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "DeviLudo-Repository-Onboarding/1.0", "x-github-api-version": API_VERSION }; }
function base64UrlJson(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function string(value: unknown, maximum: number): string { if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid(); return value; }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }
function positiveInteger(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(); return value as number; }
function integer(value: number, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(); return value; }
function invalid(): never { throw new Error("GitHub repository catalog binding is invalid"); }
