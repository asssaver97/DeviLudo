import assert from "node:assert/strict";
import test from "node:test";
import type { ScmPostgresPool } from "../src/github-auth-postgres";
import { PostgresProjectRepositoryOnboardingStore } from "../src/project-repository-postgres";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const bindingId = "33333333-3333-4333-8333-333333333333";

test("PostgreSQL project catalog applies tenant RLS and returns only active accessible repository bindings", async () => {
  const statements: string[] = [];
  const pool = {
    async connect() {
      return {
        async query(text: string, values?: readonly unknown[]) {
          statements.push(text);
          if (text.includes("set_config('app.tenant_id'")) {
            assert.deepEqual(values, [tenantId]);
            return { rowCount: 1, rows: [] };
          }
          if (text.includes("FROM deviludo.projects project")) {
            assert.deepEqual(values, [tenantId, "user-ada", 42]);
            assert.match(text, /binding\.status = 'ACTIVE'/);
            assert.match(text, /installation\.status = 'ACTIVE'/);
            assert.match(text, /project\.created_by = \$2/);
            assert.match(text, /verified_by_github_user_id = \$3::bigint/);
            assert.match(text, /LIMIT 501/);
            return { rowCount: 1, rows: [{
              project_id: projectId,
              tenant_id: tenantId,
              slug: "ember-archipelago",
              name: "余烬群岛",
              created_at: "2030-01-01T00:00:00.000Z",
              repository_binding_id: bindingId,
              installation_id: "9001",
              repository_id: "7001",
              repository_node_id: "R_repo_node",
              owner_name: "north-dock",
              repository_name: "ember-archipelago",
              default_branch: "main",
            }] };
          }
          return { rowCount: null, rows: [] };
        },
        release() {},
      };
    },
  } as unknown as ScmPostgresPool;
  const projects = await new PostgresProjectRepositoryOnboardingStore(pool).projects({
    tenantId, userId: "user-ada", githubUserId: 42,
  });
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0], {
    projectId, tenantId, slug: "ember-archipelago", name: "余烬群岛",
    repositoryBindingId: bindingId, installationId: "9001", repositoryId: 7001,
    repositoryNodeId: "R_repo_node", owner: "north-dock", repositoryName: "ember-archipelago",
    defaultBranch: "main", createdAt: "2030-01-01T00:00:00.000Z",
  });
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "COMMIT");
});

test("PostgreSQL project repository readiness requires every onboarding and binding table", async () => {
  const expected = {
    projects: "deviludo.projects",
    installations: "deviludo.github_installations",
    bindings: "deviludo.github_repository_bindings",
    operations: "deviludo.project_creation_operations",
  };
  const store = new PostgresProjectRepositoryOnboardingStore({ async connect() { return {
    async query(text: string) { assert.match(text, /github_repository_bindings/); return { rowCount: 1, rows: [expected] }; },
    release() {},
  }; } } as unknown as ScmPostgresPool);
  await store.probe();
  const missing = new PostgresProjectRepositoryOnboardingStore({ async connect() { return {
    async query() { return { rowCount: 1, rows: [{ ...expected, bindings: null }] }; },
    release() {},
  }; } } as unknown as ScmPostgresPool);
  await assert.rejects(missing.probe());
});
