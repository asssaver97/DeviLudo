import type {
  BoundProjectReceipt,
  ProjectRepositoryCatalogView,
  ProjectRepositoryPrincipal,
} from "@/services/scm-proxy/src/project-repository-contracts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
type FetchLike = typeof fetch;

export class ProjectRepositoryBrokerClient {
  readonly #origin: URL;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: Readonly<{ endpoint: string; fetch?: FetchLike; timeoutMs?: number }>) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:" || !endpoint.hostname || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== "/") invalid();
    this.#origin = endpoint;
    this.#fetch = options.fetch ?? fetch;
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 60_000) invalid();
    this.#timeoutMs = timeout;
  }

  async catalog(principal: ProjectRepositoryPrincipal): Promise<ProjectRepositoryCatalogView> {
    return parseCatalog(await this.#call("/v1/project-repositories/catalog", { principal }));
  }

  async create(input: Readonly<{
    principal: ProjectRepositoryPrincipal;
    slug: string;
    name: string;
    installationId: string;
    repositoryId: number;
    idempotencyKey: string;
  }>): Promise<BoundProjectReceipt> {
    const { idempotencyKey, ...body } = input;
    const receipt = parseReceipt(await this.#call("/v1/projects", body, idempotencyKey));
    if (receipt.tenantId !== input.principal.tenantId || receipt.slug !== input.slug
      || receipt.name !== input.name || receipt.installationId !== input.installationId
      || receipt.repositoryId !== input.repositoryId) invalid();
    return receipt;
  }

  async #call(pathname: string, body: Readonly<Record<string, unknown>>, idempotencyKey?: string): Promise<unknown> {
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(idempotencyKey)) invalid();
    const url = new URL(pathname, this.#origin);
    if (url.origin !== this.#origin.origin) invalid();
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST", redirect: "error", cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch { throw new Error("Project repository Broker is unavailable"); }
    if (!response.ok) throw new ProjectRepositoryBrokerError(response.status);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) invalid();
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) invalid();
    try { return JSON.parse(text) as unknown; } catch { invalid(); }
  }
}

export class ProjectRepositoryBrokerError extends Error { constructor(readonly status: number) { super(`Project repository Broker returned ${status}`); } }

export function projectRepositoryBrokerFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): ProjectRepositoryBrokerClient | null {
  const endpoint = env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL?.trim();
  return endpoint ? new ProjectRepositoryBrokerClient({ endpoint }) : null;
}

function parseCatalog(value: unknown): ProjectRepositoryCatalogView {
  const body = exact(value, ["installations"]);
  if (!Array.isArray(body.installations) || body.installations.length > 100) invalid();
  const installations = body.installations.map((raw) => {
    const item = exact(raw, ["accountLogin", "installationId", "repositories"]);
    if (typeof item.installationId !== "string" || !/^\d{1,20}$/.test(item.installationId)
      || typeof item.accountLogin !== "string" || !item.accountLogin || item.accountLogin.length > 100
      || !Array.isArray(item.repositories) || item.repositories.length > 1_000) invalid();
    const repositories = item.repositories.map(parseRepository);
    if (repositories.some((repository) => repository.installationId !== item.installationId)
      || new Set(repositories.map((repository) => repository.repositoryId)).size !== repositories.length) invalid();
    return Object.freeze({ installationId: item.installationId, accountLogin: item.accountLogin, repositories: Object.freeze(repositories) });
  });
  if (new Set(installations.map((installation) => installation.installationId)).size !== installations.length) invalid();
  return Object.freeze({ installations: Object.freeze(installations) });
}
function parseRepository(value: unknown) {
  const body = exact(value, ["archived", "defaultBranch", "disabled", "installationId", "name", "owner", "private", "repositoryId", "repositoryNodeId"]);
  if (typeof body.installationId !== "string" || !/^\d{1,20}$/.test(body.installationId)
    || !Number.isSafeInteger(body.repositoryId) || (body.repositoryId as number) < 1
    || typeof body.repositoryNodeId !== "string" || !body.repositoryNodeId
    || typeof body.owner !== "string" || !body.owner || typeof body.name !== "string" || !body.name
    || typeof body.defaultBranch !== "string" || !body.defaultBranch || typeof body.private !== "boolean"
    || body.archived !== false || body.disabled !== false) invalid();
  return Object.freeze(body) as unknown as ProjectRepositoryCatalogView["installations"][number]["repositories"][number];
}
function parseReceipt(value: unknown): BoundProjectReceipt {
  const body = exact(value, ["createdAt", "defaultBranch", "installationId", "name", "owner", "projectId", "repositoryBindingId", "repositoryId", "repositoryName", "repositoryNodeId", "slug", "tenantId"]);
  for (const field of ["projectId", "tenantId", "repositoryBindingId"] as const) {
    if (typeof body[field] !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body[field] as string)) invalid();
  }
  if (typeof body.installationId !== "string" || !/^\d{1,20}$/.test(body.installationId)
    || !Number.isSafeInteger(body.repositoryId) || (body.repositoryId as number) < 1
    || !["slug", "name", "repositoryNodeId", "owner", "repositoryName", "defaultBranch", "createdAt"].every((field) => typeof body[field] === "string" && Boolean(body[field]))) invalid();
  return Object.freeze(body) as unknown as BoundProjectReceipt;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); const body = value as Record<string, unknown>; if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) invalid(); return body; }
function invalid(): never { throw new Error("Project repository Broker contract is invalid"); }
