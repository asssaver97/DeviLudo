import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { GitHubAppRepositoryCatalog } from "../src/github-repository-catalog";
import type {
  BoundProjectReceipt,
  CreateBoundProjectCommand,
  GitHubRepositoryCatalogItem,
  ProjectRepositoryOnboardingStore,
  ProjectRepositoryPrincipal,
} from "../src/project-repository-contracts";
import { registerProjectRepositoryRoutes } from "../src/project-repository-http";
import { ProjectRepositoryOnboardingService } from "../src/project-repository-service";

const principal: ProjectRepositoryPrincipal = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "user-ada",
  githubUserId: 42,
});
const repository: GitHubRepositoryCatalogItem = Object.freeze({
  installationId: "9001",
  repositoryId: 7001,
  repositoryNodeId: "R_repo_node",
  owner: "north-dock",
  name: "ember-archipelago",
  defaultBranch: "main",
  private: true,
  archived: false,
  disabled: false,
});

class MemoryStore implements ProjectRepositoryOnboardingStore {
  readonly receipts = new Map<string, BoundProjectReceipt>();
  releases = 0;

  async authorizedInstallations(value: ProjectRepositoryPrincipal) {
    assert.deepEqual(value, principal);
    return [{ installationRecordId: "22222222-2222-4222-8222-222222222222", installationId: "9001", accountLogin: "north-dock" }];
  }

  async project(value: ProjectRepositoryPrincipal, projectId: string) {
    assert.deepEqual(value, principal);
    return [...this.receipts.values()].find((receipt) => receipt.projectId === projectId) ?? null;
  }

  async claim(command: CreateBoundProjectCommand) {
    const replay = this.receipts.get(command.idempotencyKey);
    return replay ? { kind: "REPLAY" as const, receipt: replay } : { kind: "ACQUIRED" as const };
  }

  async complete(input: Parameters<ProjectRepositoryOnboardingStore["complete"]>[0]) {
    const receipt: BoundProjectReceipt = Object.freeze({
      projectId: input.projectId,
      tenantId: input.command.principal.tenantId,
      slug: input.command.slug,
      name: input.command.name,
      repositoryBindingId: input.repositoryBindingId,
      installationId: input.command.installationId,
      repositoryId: input.repository.repositoryId,
      repositoryNodeId: input.repository.repositoryNodeId,
      owner: input.repository.owner,
      repositoryName: input.repository.name,
      defaultBranch: input.repository.defaultBranch,
      createdAt: input.createdAt,
    });
    this.receipts.set(input.command.idempotencyKey, receipt);
    return receipt;
  }

  async release() { this.releases += 1; }
}

test("project onboarding derives the repository binding from live GitHub data and replays the durable receipt", async () => {
  const store = new MemoryStore();
  let lists = 0;
  const service = new ProjectRepositoryOnboardingService(store, {
    async list(installationId) { lists += 1; assert.equal(installationId, "9001"); return [repository]; },
  }, () => new Date("2030-01-01T00:00:00.000Z"));
  assert.deepEqual(await service.catalog(principal), {
    installations: [{ installationId: "9001", accountLogin: "north-dock", repositories: [repository] }],
  });
  const command = {
    idempotencyKey: "create-project-001", principal, slug: "ember-archipelago",
    name: "余烬群岛", installationId: "9001", repositoryId: 7001,
  } as const;
  const first = await service.create(command);
  const replay = await service.create(command);
  assert.deepEqual(replay, first);
  assert.deepEqual(await service.project({ principal, projectId: first.projectId }), first);
  assert.equal(first.owner, "north-dock");
  assert.equal(first.repositoryName, "ember-archipelago");
  assert.equal(first.defaultBranch, "main");
  assert.equal(lists, 2, "one catalog lookup and one authoritative creation lookup");

  await assert.rejects(service.create({ ...command, idempotencyKey: "create-project-002", repositoryId: 9999 }), /not available/);
  assert.equal(store.releases, 1);
});

test("GitHub repository catalog issues a metadata-only token, filters unusable repositories and revokes immediately", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/app/installations/9001/access_tokens") {
      assert.deepEqual(JSON.parse(String(init?.body)), { permissions: { metadata: "read" } });
      assert.match(String((init?.headers as Record<string, string>).authorization), /^Bearer ey/);
      return new Response(JSON.stringify({
        token: "ghs_one_time_catalog_token",
        expires_at: "2099-01-01T01:00:00.000Z",
        permissions: { metadata: "read" },
      }), { status: 201 });
    }
    if (url.pathname === "/installation/repositories") {
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer ghs_one_time_catalog_token");
      return new Response(JSON.stringify({ repositories: [
        { id: 7001, node_id: "R_repo_node", owner: { login: "north-dock" }, name: "ember-archipelago", default_branch: "main", private: true, archived: false, disabled: false },
        { id: 7002, node_id: "R_old", owner: { login: "north-dock" }, name: "old", default_branch: "main", private: true, archived: true, disabled: false },
      ] }), { status: 200 });
    }
    if (url.pathname === "/installation/token") return new Response(null, { status: 204 });
    throw new Error(`unexpected GitHub route ${url.pathname}`);
  };
  const catalog = new GitHubAppRepositoryCatalog({
    appId: "1234",
    signer: { keyId: "github-app-rsa-v3", async signRs256() { return new Uint8Array(256).fill(7); } },
    fetch: fetcher,
  });
  const result = await catalog.list("9001");
  assert.deepEqual(result, [repository]);
  assert.deepEqual(calls.map((call) => `${call.init?.method} ${call.url.pathname}`), [
    "POST /app/installations/9001/access_tokens",
    "GET /installation/repositories",
    "DELETE /installation/token",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /ghs_one_time_catalog_token/);
});

test("project repository HTTP surface requires workload identity and exact request shapes", async () => {
  const service = new ProjectRepositoryOnboardingService(new MemoryStore(), { async list() { return [repository]; } });
  let authorized = false;
  const server = Fastify({ logger: false });
  registerProjectRepositoryRoutes(server, { service, authorize() { if (!authorized) throw new Error("denied"); } });
  assert.equal((await server.inject({ method: "POST", url: "/v1/project-repositories/catalog", payload: { principal } })).statusCode, 401);
  authorized = true;
  const catalog = await server.inject({ method: "POST", url: "/v1/project-repositories/catalog", payload: { principal } });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.headers["cache-control"], "no-store");
  const created = await server.inject({
    method: "POST", url: "/v1/projects", headers: { "idempotency-key": "http-create-001" },
    payload: { principal, slug: "ember-archipelago", name: "余烬群岛", installationId: "9001", repositoryId: 7001 },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().repositoryNodeId, "R_repo_node");
  const lookup = await server.inject({ method: "POST", url: "/v1/projects/lookup", payload: { principal, projectId: created.json().projectId } });
  assert.equal(lookup.statusCode, 200);
  assert.equal(lookup.json().name, "余烬群岛");
  assert.equal((await server.inject({ method: "POST", url: "/v1/projects/lookup", payload: { principal, projectId: "44444444-4444-4444-8444-444444444444" } })).statusCode, 404);
  assert.equal((await server.inject({
    method: "POST", url: "/v1/projects", headers: { "idempotency-key": "http-create-002" },
    payload: { principal, slug: "evil", name: "evil", installationId: "9001", repositoryId: 7001, owner: "attacker" },
  })).statusCode, 400);
  await server.close();
});
