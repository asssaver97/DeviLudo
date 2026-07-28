import assert from "node:assert/strict";
import test from "node:test";
import { GET as GET_REPOSITORIES } from "../app/api/projects/repositories/route.ts";
import { GET as GET_PROJECT } from "../app/api/projects/[projectId]/route.ts";
import { GET as GET_PROJECTS, POST as CREATE_PROJECT } from "../app/api/projects/route.ts";
import { createLocalGitHubProject } from "../lib/projects/local-project-catalog.ts";

function request(path, init = {}) {
  return new Request(`http://127.0.0.1:3000${path}`, init);
}

function creation(slug, key, name = "本地新游戏") {
  return request("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({
      slug,
      name,
      installationId: "local-fixture-9001",
      repositoryId: 7001,
    }),
  });
}

test("local project creation persists in the catalog and replays one exact command", async () => {
  const previousMode = process.env.DEVILUDO_LOCAL_TEST_MODE;
  const previousNodeEnvironment = process.env.NODE_ENV;
  process.env.DEVILUDO_LOCAL_TEST_MODE = "1";
  process.env.NODE_ENV = "test";
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const slug = `local-game-${suffix}`;
  try {
    const repositories = await GET_REPOSITORIES(request("/api/projects/repositories"));
    const repositoryPayload = await repositories.json();
    assert.equal(repositories.status, 200);
    assert.deepEqual(repositoryPayload.data.installations[0].repositories[0], {
      installationId: "local-fixture-9001",
      repositoryId: 7001,
      owner: "local-sandbox",
      name: "generated-godot-project",
      defaultBranch: "main",
      private: true,
    });

    const created = await CREATE_PROJECT(creation(slug, `create-${suffix}`));
    const createdPayload = await created.json();
    assert.equal(created.status, 201);
    assert.equal(createdPayload.meta.idempotentReplay, false);
    assert.deepEqual(createdPayload.data, {
      projectId: slug,
      tenantId: "tenant-local",
      slug,
      name: "本地新游戏",
      repositoryBindingId: `local-binding-${slug}`,
      installationId: "local-fixture-9001",
      repositoryId: 7001,
      repositoryNodeId: `LOCAL_R_${slug}`,
      owner: "local-sandbox",
      repositoryName: slug,
      defaultBranch: "main",
      createdAt: createdPayload.data.createdAt,
    });
    assert.equal(new Date(createdPayload.data.createdAt).toISOString(), createdPayload.data.createdAt);

    const replay = await CREATE_PROJECT(creation(slug, `create-${suffix}`));
    const replayPayload = await replay.json();
    assert.equal(replay.status, 200);
    assert.equal(replayPayload.meta.idempotentReplay, true);
    assert.deepEqual(replayPayload.data, createdPayload.data);

    const drift = await CREATE_PROJECT(creation(`${slug}-other`, `create-${suffix}`, "不同请求"));
    assert.equal(drift.status, 409);
    assert.equal((await drift.json()).error.code, "PROJECT_CREATION_IDEMPOTENCY_CONFLICT");

    const duplicate = await CREATE_PROJECT(creation(slug, `duplicate-${suffix}`));
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, "PROJECT_CREATION_CONFLICT");

    const catalog = await GET_PROJECTS(request("/api/projects"));
    const catalogPayload = await catalog.json();
    assert.equal(catalog.status, 200);
    assert.equal(catalogPayload.meta.authoritativeSource, "loopback-local-project-catalog");
    assert.equal(catalogPayload.data[0].projectId, "ember-archipelago");
    assert.deepEqual(catalogPayload.data.find((project) => project.projectId === slug), createdPayload.data);

    const detail = await GET_PROJECT(request(`/api/projects/${slug}`), { params: Promise.resolve({ projectId: slug }) });
    assert.equal(detail.status, 200);
    assert.deepEqual((await detail.json()).data, createdPayload.data);
  } finally {
    if (previousMode === undefined) delete process.env.DEVILUDO_LOCAL_TEST_MODE;
    else process.env.DEVILUDO_LOCAL_TEST_MODE = previousMode;
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
  }
});

test("local project creation rejects browser-supplied repository authority and non-loopback access", async () => {
  const previousMode = process.env.DEVILUDO_LOCAL_TEST_MODE;
  const previousNodeEnvironment = process.env.NODE_ENV;
  process.env.DEVILUDO_LOCAL_TEST_MODE = "1";
  process.env.NODE_ENV = "test";
  try {
    const extra = await CREATE_PROJECT(request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "extra-local-project-authority" },
      body: JSON.stringify({
        slug: "forged-local-project",
        name: "伪造项目",
        installationId: "local-fixture-9001",
        repositoryId: 7001,
        owner: "attacker",
      }),
    }));
    assert.equal(extra.status, 400);
    assert.equal((await extra.json()).error.code, "INVALID_PROJECT_CREATION");

    const forgedRepository = await CREATE_PROJECT(request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "forged-local-repository" },
      body: JSON.stringify({
        slug: "forged-local-repository",
        name: "伪造仓库",
        installationId: "other-installation",
        repositoryId: 9009,
      }),
    }));
    assert.equal(forgedRepository.status, 400);

    const nonLoopback = await GET_PROJECTS(new Request("https://deviludo.example/api/projects"));
    assert.equal(nonLoopback.status, 503);
    assert.equal((await nonLoopback.json()).error.code, "PROJECT_REPOSITORY_BROKER_REQUIRED");
  } finally {
    if (previousMode === undefined) delete process.env.DEVILUDO_LOCAL_TEST_MODE;
    else process.env.DEVILUDO_LOCAL_TEST_MODE = previousMode;
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
  }
});

test("authenticated local GitHub authority persists the exact real repository binding", async () => {
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const slug = `github-game-${suffix}`;
  const result = await createLocalGitHubProject({
    slug,
    name: "真实 GitHub 游戏",
    repository: {
      installationId: "42001",
      repositoryId: 991,
      repositoryNodeId: `R_real_${suffix}`,
      owner: "ada",
      name: "real-godot-game",
      defaultBranch: "develop",
    },
  }, `github-import-${suffix}`);
  assert.equal(result.replayed, false);
  assert.deepEqual(result.project, {
    projectId: slug,
    tenantId: "tenant-local",
    slug,
    name: "真实 GitHub 游戏",
    repositoryBindingId: `github-binding-${slug}-991`,
    installationId: "42001",
    repositoryId: 991,
    repositoryNodeId: `R_real_${suffix}`,
    owner: "ada",
    repositoryName: "real-godot-game",
    defaultBranch: "develop",
    createdAt: result.project.createdAt,
  });
  const replay = await createLocalGitHubProject({
    slug,
    name: "真实 GitHub 游戏",
    repository: {
      installationId: "42001", repositoryId: 991, repositoryNodeId: `R_real_${suffix}`,
      owner: "ada", name: "real-godot-game", defaultBranch: "develop",
    },
  }, `github-import-${suffix}`);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.project, result.project);
});
