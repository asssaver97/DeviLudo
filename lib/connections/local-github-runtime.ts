import { HttpProblem } from "@/lib/control-plane/http";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";
import type { GitHubConnectionStatus } from "@/services/scm-proxy/src/github-auth-contracts";
import type { ProjectRepositoryCatalogView } from "@/services/scm-proxy/src/project-repository-contracts";
import { createLocalGitHubRuntimeHeaders } from "@/services/local-github-runtime/src/request-auth";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function localGitHubImportEnabled(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.DEVILUDO_LOCAL_GITHUB_IMPORT === "1" && isLoopbackTestRequest(request, env);
}

export class LocalGitHubRuntimeClient {
  readonly #origin: URL;
  constructor(env: Readonly<Record<string, string | undefined>> = process.env) {
    if (env.NODE_ENV === "production" || env.DEVILUDO_LOCAL_TEST_MODE !== "1" || env.DEVILUDO_LOCAL_GITHUB_IMPORT !== "1") invalid();
    const origin = new URL(env.DEVILUDO_LOCAL_GITHUB_RUNTIME_URL ?? "http://127.0.0.1:4315");
    if (origin.protocol !== "http:" || (origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost")
      || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) invalid();
    this.#origin = origin;
  }

  async status(): Promise<GitHubConnectionStatus> { return parseStatus(await this.#call("/v1/github/status", {})); }
  async begin(returnPath = "/settings/connections"): Promise<{ authorizeUrl: string; expiresAt: string }> { return parseAuthorization(await this.#call("/v1/github/begin", { returnPath }), "install"); }
  async setup(input: Readonly<{ state: string; installationId: string; setupAction: "install" | "update" }>): Promise<{ authorizeUrl: string; expiresAt: string }> { return parseAuthorization(await this.#call("/v1/github/setup", input), "oauth"); }
  async complete(input: Readonly<{ state: string; code: string }>): Promise<{ returnPath: string }> { return parseCompletion(await this.#call("/v1/github/complete", input)); }
  async repositories(): Promise<ProjectRepositoryCatalogView> { return parseRepositories(await this.#call("/v1/github/repositories", {})); }

  async #call(pathname: string, value: Readonly<Record<string, unknown>>): Promise<unknown> {
    const body = JSON.stringify(value);
    let response: Response;
    try {
      response = await fetch(new URL(pathname, this.#origin), {
        method: "POST",
        headers: { "content-type": "application/json", ...createLocalGitHubRuntimeHeaders({ method: "POST", path: pathname, body }) },
        body,
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new HttpProblem(503, "LOCAL_GITHUB_RUNTIME_UNAVAILABLE", "本机 GitHub 导入服务未启动或无法连接 GitHub。"); }
    if (response.status >= 300 && response.status < 400) throw new HttpProblem(502, "LOCAL_GITHUB_RUNTIME_INVALID", "本机 GitHub 导入服务返回了不安全的重定向。");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) invalid();
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) invalid();
    let payload: { data?: unknown; error?: { message?: string } };
    try { payload = JSON.parse(text) as typeof payload; }
    catch { invalid(); }
    if (!response.ok || payload.data === undefined) {
      throw new HttpProblem(502, "LOCAL_GITHUB_OPERATION_REJECTED", payload.error?.message ?? "本机 GitHub 操作失败。");
    }
    return payload.data;
  }
}

function parseStatus(value: unknown): GitHubConnectionStatus {
  const body = exact(value, ["accountLogin", "installationCount", "permissions", "repositorySelection", "state", "verifiedAt"]);
  if (!Number.isSafeInteger(body.installationCount) || (body.installationCount as number) < 0 || (body.installationCount as number) > 100) invalid();
  if (body.state === "NOT_CONNECTED") {
    if (body.installationCount !== 0 || body.accountLogin !== null || body.permissions !== null || body.repositorySelection !== null || body.verifiedAt !== null) invalid();
  } else if (body.state === "CONNECTED") {
    if ((body.installationCount as number) < 1 || !safe(body.accountLogin, 100)
      || (body.repositorySelection !== "all" && body.repositorySelection !== "selected")
      || typeof body.verifiedAt !== "string" || !Number.isFinite(Date.parse(body.verifiedAt))) invalid();
    const permissions = exact(body.permissions, ["contents", "metadata", "pull_requests"]);
    if (permissions.contents !== "write" || permissions.metadata !== "read" || permissions.pull_requests !== "write") invalid();
  } else invalid();
  return Object.freeze(body) as unknown as GitHubConnectionStatus;
}

function parseAuthorization(value: unknown, stage: "install" | "oauth"): { authorizeUrl: string; expiresAt: string } {
  const body = exact(value, ["authorizeUrl", "expiresAt"]);
  if (typeof body.authorizeUrl !== "string" || typeof body.expiresAt !== "string" || !Number.isFinite(Date.parse(body.expiresAt))) invalid();
  const url = new URL(body.authorizeUrl);
  const validPath = stage === "install"
    ? /^\/apps\/[a-z0-9-]{1,100}\/installations\/new$/.test(url.pathname)
    : url.pathname === "/login/oauth/authorize";
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.hash || !validPath) invalid();
  return Object.freeze({ authorizeUrl: url.href, expiresAt: body.expiresAt });
}

function parseCompletion(value: unknown): { returnPath: string } {
  const body = exact(value, ["returnPath"]);
  if (body.returnPath !== "/settings/connections") invalid();
  return Object.freeze({ returnPath: body.returnPath });
}

function parseRepositories(value: unknown): ProjectRepositoryCatalogView {
  const body = exact(value, ["installations"]);
  if (!Array.isArray(body.installations) || body.installations.length > 100) invalid();
  const installations = body.installations.map((raw) => {
    const installation = exact(raw, ["accountLogin", "installationId", "repositories"]);
    if (typeof installation.installationId !== "string" || !/^\d{1,20}$/.test(installation.installationId)
      || !safe(installation.accountLogin, 100) || !Array.isArray(installation.repositories) || installation.repositories.length > 1_000) invalid();
    const repositories = installation.repositories.map((rawRepository) => {
      const repository = exact(rawRepository, ["archived", "defaultBranch", "disabled", "installationId", "name", "owner", "private", "repositoryId", "repositoryNodeId"]);
      if (repository.installationId !== installation.installationId || !Number.isSafeInteger(repository.repositoryId) || (repository.repositoryId as number) < 1
        || !safe(repository.repositoryNodeId, 256) || !safe(repository.owner, 100) || !safe(repository.name, 100) || !safe(repository.defaultBranch, 255)
        || typeof repository.private !== "boolean" || repository.archived !== false || repository.disabled !== false) invalid();
      return Object.freeze(repository) as unknown as ProjectRepositoryCatalogView["installations"][number]["repositories"][number];
    });
    if (new Set(repositories.map((item) => item.repositoryId)).size !== repositories.length) invalid();
    return Object.freeze({ installationId: installation.installationId, accountLogin: installation.accountLogin as string, repositories: Object.freeze(repositories) });
  });
  if (new Set(installations.map((item) => item.installationId)).size !== installations.length) invalid();
  return Object.freeze({ installations: Object.freeze(installations) });
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) invalid();
  return body;
}
function safe(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value); }
function invalid(): never { throw new HttpProblem(500, "LOCAL_GITHUB_CONFIGURATION_INVALID", "本机 GitHub 导入配置无效。"); }
