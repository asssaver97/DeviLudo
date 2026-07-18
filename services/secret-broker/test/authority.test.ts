import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { PostgresInferenceCredentialAuthority } from "../src/authority";

const projectId = "22222222-2222-4222-8222-222222222222";
const tenantId = "11111111-1111-4111-8111-111111111111";
const secretRef = "vault://kv/deviludo/records/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function poolFor(payload: unknown, projectRows: readonly { id: string }[] = [{ id: projectId }]) {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      if (text.includes("admin_catalog_state")) return { rowCount: 1, rows: [{ payload }] as unknown as Row[] };
      if (text.includes("FROM deviludo.projects")) return { rowCount: projectRows.length, rows: projectRows as unknown as Row[] };
      return { rowCount: 0, rows: [] as Row[] };
    },
    release() {},
  };
  const pool: PostgresWorkflowPool = { async connect() { return client; } };
  return { pool, queries };
}

function catalog(profileScope: "platform" | "tenant" | "project", profileScopeId: string,
  credentialScope: "platform" | "tenant", credentialScopeId: string) {
  return {
    credentials: [{ id: "credential-v1", scope: credentialScope, scopeId: credentialScopeId, secretRef, state: "ACTIVE" }],
    providers: [{ id: "provider-r1", credentialVersionId: "credential-v1", state: "VALIDATING" }],
    profiles: [{ providerRevisionId: "provider-r1", credentialVersionId: "credential-v1",
      scope: profileScope, scopeId: profileScopeId, state: "VALIDATING" }],
  };
}

test("project Provider probes prove the project belongs to the credential tenant under RLS", async () => {
  const fixture = poolFor(catalog("project", projectId, "tenant", tenantId));
  const authority = new PostgresInferenceCredentialAuthority(fixture.pool);
  assert.equal(await authority.resolveProbe({ providerRevisionId: "provider-r1", credentialVersionId: "credential-v1" }), secretRef);
  const rls = fixture.queries.find((query) => query.text.includes("set_config('app.tenant_id'"));
  assert.deepEqual(rls?.values, [tenantId]);
  assert.ok(fixture.queries.some((query) => query.text.includes("FROM deviludo.projects")));
});

test("project Provider probes cannot borrow a platform credential or a project from another tenant", async () => {
  const platform = poolFor(catalog("project", projectId, "platform", "global"));
  await assert.rejects(
    new PostgresInferenceCredentialAuthority(platform.pool)
      .resolveProbe({ providerRevisionId: "provider-r1", credentialVersionId: "credential-v1" }),
    /rejected the binding/,
  );
  assert.equal(platform.queries.some((query) => query.text.includes("FROM deviludo.projects")), false);

  const missingProject = poolFor(catalog("project", projectId, "tenant", tenantId), []);
  await assert.rejects(
    new PostgresInferenceCredentialAuthority(missingProject.pool)
      .resolveProbe({ providerRevisionId: "provider-r1", credentialVersionId: "credential-v1" }),
    /rejected the binding/,
  );
});
