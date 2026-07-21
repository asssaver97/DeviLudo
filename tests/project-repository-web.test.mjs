import assert from "node:assert/strict";
import test from "node:test";
import { GET as GET_CATALOG } from "../app/api/projects/repositories/route.ts";
import { GET as GET_PROJECT } from "../app/api/projects/[projectId]/route.ts";
import { GET as GET_PROJECTS, POST } from "../app/api/projects/route.ts";
import { signTrustedGitHubSession } from "../lib/connections/github-broker.ts";
import { ProjectRepositoryBrokerClient } from "../lib/projects/repository-broker.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const bindingId = "33333333-3333-4333-8333-333333333333";
const key = new Uint8Array(32).fill(23);

async function trustedRequest(method, pathname, body) {
  const issuedAt = String(Date.now());
  const session = {
    method, pathname, tenantId, userId: "user-ada",
    sessionBinding: "session-binding-that-is-longer-than-thirty-two-bytes",
    githubUserId: "42", issuedAt, key,
  };
  const signature = await signTrustedGitHubSession(session);
  return new Request(`https://app.deviludo.example${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json", "idempotency-key": "create-project-web-001" }),
      "x-deviludo-session-tenant": tenantId,
      "x-deviludo-session-user": session.userId,
      "x-deviludo-session-binding": session.sessionBinding,
      "x-deviludo-session-github-user-id": session.githubUserId,
      "x-deviludo-session-issued-at": issuedAt,
      "x-deviludo-session-signature": signature,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("production Web lists only broker-derived repositories and creates an atomic binding from numeric IDs", async () => {
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL;
  const originalKey = process.env.DEVILUDO_SESSION_HMAC_KEY;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init.body));
    calls.push({ url, init, body });
    assert.deepEqual(body.principal, { tenantId, userId: "user-ada", githubUserId: 42 });
    if (url.pathname === "/v1/project-repositories/catalog") {
      return new Response(JSON.stringify({ installations: [{
        installationId: "9001", accountLogin: "north-dock", repositories: [{
          installationId: "9001", repositoryId: 7001, repositoryNodeId: "R_repo_node",
          owner: "north-dock", name: "ember-archipelago", defaultBranch: "main",
          private: true, archived: false, disabled: false,
        }],
      }] }), { status: 200 });
    }
    if (url.pathname === "/v1/projects/lookup") {
      assert.equal(body.projectId, projectId);
      return new Response(JSON.stringify({
        projectId, tenantId, slug: "ember-archipelago", name: "余烬群岛",
        repositoryBindingId: bindingId, installationId: "9001", repositoryId: 7001,
        repositoryNodeId: "R_repo_node", owner: "north-dock", repositoryName: "ember-archipelago",
        defaultBranch: "main", createdAt: "2030-01-01T00:00:00.000Z",
      }), { status: 200 });
    }
    if (url.pathname === "/v1/projects/list") {
      return new Response(JSON.stringify({ projects: [{
        projectId, tenantId, slug: "ember-archipelago", name: "余烬群岛",
        repositoryBindingId: bindingId, installationId: "9001", repositoryId: 7001,
        repositoryNodeId: "R_repo_node", owner: "north-dock", repositoryName: "ember-archipelago",
        defaultBranch: "main", createdAt: "2030-01-01T00:00:00.000Z",
      }] }), { status: 200 });
    }
    assert.equal(url.pathname, "/v1/projects");
    assert.deepEqual(body, {
      principal: { tenantId, userId: "user-ada", githubUserId: 42 },
      slug: "ember-archipelago", name: "余烬群岛", installationId: "9001", repositoryId: 7001,
    });
    assert.equal(init.headers["idempotency-key"], "create-project-web-001");
    return new Response(JSON.stringify({
      projectId, tenantId, slug: "ember-archipelago", name: "余烬群岛",
      repositoryBindingId: bindingId, installationId: "9001", repositoryId: 7001,
      repositoryNodeId: "R_repo_node", owner: "north-dock", repositoryName: "ember-archipelago",
      defaultBranch: "main", createdAt: "2030-01-01T00:00:00.000Z",
    }), { status: 201 });
  };
  process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL = "https://project-repository.internal/";
  process.env.DEVILUDO_SESSION_HMAC_KEY = Buffer.from(key).toString("base64url");
  try {
    const catalog = await GET_CATALOG(await trustedRequest("GET", "/api/projects/repositories"));
    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json()).data.installations[0].repositories[0].repositoryId, 7001);

    const projectCatalog = await GET_PROJECTS(await trustedRequest("GET", "/api/projects"));
    assert.equal(projectCatalog.status, 200);
    assert.equal((await projectCatalog.json()).data[0].projectId, projectId);

    const created = await POST(await trustedRequest("POST", "/api/projects", {
      slug: "ember-archipelago", name: "余烬群岛", installationId: "9001", repositoryId: 7001,
    }));
    assert.equal(created.status, 201);
    assert.equal((await created.json()).data.projectId, projectId);
    assert.equal(calls.length, 3);

    const project = await GET_PROJECT(await trustedRequest("GET", `/api/projects/${projectId}`), {
      params: Promise.resolve({ projectId }),
    });
    assert.equal(project.status, 200);
    assert.equal((await project.json()).data.name, "余烬群岛");
    assert.equal(calls.length, 4);

    const unauthorized = await GET_CATALOG(new Request("https://app.deviludo.example/api/projects/repositories"));
    assert.equal(unauthorized.status, 401);
    assert.equal(calls.length, 4);

    const unauthorizedProjects = await GET_PROJECTS(new Request("https://app.deviludo.example/api/projects"));
    assert.equal(unauthorizedProjects.status, 401);
    assert.equal(calls.length, 4);

    const extraAuthority = await POST(await trustedRequest("POST", "/api/projects", {
      slug: "ember-archipelago", name: "余烬群岛", installationId: "9001", repositoryId: 7001,
      owner: "attacker-controlled",
    }));
    assert.equal(extraAuthority.status, 400);
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint === undefined) delete process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL;
    else process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL = originalEndpoint;
    if (originalKey === undefined) delete process.env.DEVILUDO_SESSION_HMAC_KEY;
    else process.env.DEVILUDO_SESSION_HMAC_KEY = originalKey;
  }
});

test("project repository Web Broker pins HTTPS origin and rejects receipt drift", async () => {
  assert.throws(() => new ProjectRepositoryBrokerClient({ endpoint: "http://127.0.0.1:4559/" }), /invalid/);
  const client = new ProjectRepositoryBrokerClient({
    endpoint: "https://project-repository.internal/",
    fetch: async () => new Response(JSON.stringify({ projectId: "attacker" }), { status: 201 }),
  });
  await assert.rejects(client.create({
    principal: { tenantId, userId: "user-ada", githubUserId: 42 },
    slug: "ember-archipelago", name: "余烬群岛", installationId: "9001", repositoryId: 7001,
    idempotencyKey: "create-project-drift-001",
  }), /contract is invalid/);

  const crossTenant = new ProjectRepositoryBrokerClient({
    endpoint: "https://project-repository.internal/",
    fetch: async () => new Response(JSON.stringify({
      projectId, tenantId: "44444444-4444-4444-8444-444444444444",
      slug: "ember-archipelago", name: "余烬群岛", repositoryBindingId: bindingId,
      installationId: "9001", repositoryId: 7001, repositoryNodeId: "R_repo_node",
      owner: "north-dock", repositoryName: "ember-archipelago", defaultBranch: "main",
      createdAt: "2030-01-01T00:00:00.000Z",
    }), { status: 201 }),
  });
  await assert.rejects(crossTenant.create({
    principal: { tenantId, userId: "user-ada", githubUserId: 42 },
    slug: "ember-archipelago", name: "余烬群岛", installationId: "9001", repositoryId: 7001,
    idempotencyKey: "create-project-cross-tenant-001",
  }), /contract is invalid/);
});
