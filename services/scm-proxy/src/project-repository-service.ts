import { createHash, randomUUID } from "node:crypto";
import type {
  BoundProjectReceipt,
  CreateBoundProjectCommand,
  GitHubInstallationRepositoryCatalog,
  GitHubRepositoryCatalogItem,
  ProjectRepositoryCatalogView,
  ProjectRepositoryOnboardingStore,
  ProjectRepositoryPrincipal,
} from "./project-repository-contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const INSTALLATION = /^\d{1,20}$/;

export class ProjectRepositoryOnboardingService {
  constructor(
    private readonly store: ProjectRepositoryOnboardingStore,
    private readonly github: GitHubInstallationRepositoryCatalog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async catalog(value: unknown): Promise<ProjectRepositoryCatalogView> {
    const principal = parsePrincipal(value);
    const installations = await this.store.authorizedInstallations(principal);
    if (installations.length > 100) throw new Error("GitHub installation catalog exceeds the supported limit");
    const result = [];
    let repositoryCount = 0;
    for (const installation of installations) {
      const repositories = await this.github.list(installation.installationId);
      for (const repository of repositories) validateRepository(repository, installation.installationId);
      repositoryCount += repositories.length;
      if (repositoryCount > 2_000) throw new Error("GitHub repository catalog exceeds the supported limit");
      result.push(Object.freeze({
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        repositories,
      }));
    }
    return Object.freeze({ installations: Object.freeze(result) });
  }

  async create(value: unknown): Promise<BoundProjectReceipt> {
    const command = parseCreateCommand(value);
    const requestDigest = digest({
      principal: command.principal,
      slug: command.slug,
      name: command.name,
      installationId: command.installationId,
      repositoryId: command.repositoryId,
    });
    const claimToken = randomUUID();
    const claim = await this.store.claim(command, requestDigest, claimToken);
    if (claim.kind === "REPLAY") return claim.receipt;
    if (claim.kind === "BUSY") throw new Error("Project creation is currently processing");
    if (claim.kind === "CONFLICT") throw new Error("Project creation idempotency key conflicts with another request");
    try {
      const installations = await this.store.authorizedInstallations(command.principal);
      if (!installations.some((item) => item.installationId === command.installationId)) {
        throw new Error("GitHub installation is not authorized for this account and tenant");
      }
      const repositories = await this.github.list(command.installationId);
      const repository = repositories.find((item) => item.repositoryId === command.repositoryId);
      if (!repository) throw new Error("GitHub repository is not available to this installation");
      validateRepository(repository, command.installationId);
      return await this.store.complete({
        command,
        requestDigest,
        claimToken,
        projectId: randomUUID(),
        repositoryBindingId: randomUUID(),
        repository,
        createdAt: this.now().toISOString(),
      });
    } catch (error) {
      await this.store.release(command.principal.tenantId, command.idempotencyKey, claimToken).catch(() => undefined);
      throw error;
    }
  }
}

export function parsePrincipal(value: unknown): ProjectRepositoryPrincipal {
  const body = exactObject(value, ["githubUserId", "tenantId", "userId"]);
  if (typeof body.tenantId !== "string" || !UUID.test(body.tenantId)
    || typeof body.userId !== "string" || !SAFE_ID.test(body.userId)
    || !Number.isSafeInteger(body.githubUserId) || (body.githubUserId as number) < 1) invalid();
  return Object.freeze({ tenantId: body.tenantId, userId: body.userId, githubUserId: body.githubUserId as number });
}

export function parseCreateCommand(value: unknown): CreateBoundProjectCommand {
  const body = exactObject(value, ["idempotencyKey", "installationId", "name", "principal", "repositoryId", "slug"]);
  const principal = parsePrincipal(body.principal);
  if (typeof body.idempotencyKey !== "string" || !KEY.test(body.idempotencyKey)
    || typeof body.slug !== "string" || !SLUG.test(body.slug)
    || typeof body.name !== "string" || body.name.trim() !== body.name || body.name.length < 1 || body.name.length > 120
    || /[\u0000-\u001f\u007f]/.test(body.name)
    || typeof body.installationId !== "string" || !INSTALLATION.test(body.installationId) || body.installationId === "0"
    || !Number.isSafeInteger(body.repositoryId) || (body.repositoryId as number) < 1) invalid();
  return Object.freeze({
    idempotencyKey: body.idempotencyKey,
    principal,
    slug: body.slug,
    name: body.name,
    installationId: body.installationId,
    repositoryId: body.repositoryId as number,
  });
}

function validateRepository(value: GitHubRepositoryCatalogItem, installationId: string): void {
  if (value.installationId !== installationId || !Number.isSafeInteger(value.repositoryId) || value.repositoryId < 1
    || !value.repositoryNodeId || !value.owner || !value.name || !value.defaultBranch
    || value.archived !== false || value.disabled !== false) invalid();
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) invalid();
  return body;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function invalid(): never { throw new Error("Project repository onboarding request is invalid"); }
