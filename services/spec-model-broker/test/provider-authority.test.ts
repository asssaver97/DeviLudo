import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { PostgresSpecModelProviderAuthority } from "../src/provider-authority";

const secretRef = "vault://kv/deviludo/records/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("Provider authority resolves only one exact ACTIVE platform Profile smallFastModel", async () => {
  const fixture = pool(catalog());
  const authority = new PostgresSpecModelProviderAuthority(fixture.pool);
  const binding = await authority.resolve("profile-spec-r1");
  assert.deepEqual(binding, {
    profileRevisionId: "profile-spec-r1",
    providerRevisionId: "provider-r1",
    credentialVersionId: "credential-v1",
    agent: "claude-code",
    protocol: "anthropic-messages",
    baseUrl: "https://api.example.com/v1",
    approvedPorts: [443],
    authentication: "x-api-key",
    model: "claude-haiku-4-5-20251001",
    policyDigest: binding.policyDigest,
  });
  assert.match(binding.policyDigest, /^[a-f0-9]{64}$/);
  assert.ok(fixture.queries.some((query) => query.includes("FOR SHARE")));
});

test("Provider authority rejects tenant scope, inactive state and credential drift", async () => {
  const tenant = catalog();
  tenant.profiles[0]!.scope = "tenant";
  tenant.profiles[0]!.scopeId = "11111111-1111-4111-8111-111111111111";
  await assert.rejects(new PostgresSpecModelProviderAuthority(pool(tenant).pool).resolve("profile-spec-r1"));

  const inactive = catalog();
  inactive.providers[0]!.state = "DEGRADED";
  await assert.rejects(new PostgresSpecModelProviderAuthority(pool(inactive).pool).resolve("profile-spec-r1"));

  const drift = catalog();
  drift.profiles[0]!.credentialVersionId = "credential-other";
  await assert.rejects(new PostgresSpecModelProviderAuthority(pool(drift).pool).resolve("profile-spec-r1"));
});

function catalog() {
  return {
    profiles: [{
      id: "profile-spec-r1", state: "ACTIVE", scope: "platform", scopeId: "global",
      agent: "claude-code", providerRevisionId: "provider-r1", credentialVersionId: "credential-v1",
    }],
    providers: [{
      id: "provider-r1", state: "ACTIVE", agent: "claude-code", protocol: "anthropic-messages",
      baseUrl: "https://api.example.com/v1", approvedPorts: [443], authentication: "x-api-key",
      credentialVersionId: "credential-v1",
      models: {
        primaryModel: "claude-sonnet-4-6-20250514", planningModel: "claude-sonnet-4-6-20250514",
        smallFastModel: "claude-haiku-4-5-20251001", subagentModel: "claude-sonnet-4-6-20250514",
      },
    }],
    credentials: [{
      id: "credential-v1", state: "ACTIVE", scope: "platform", scopeId: "global", secretRef,
    }],
  };
}

function pool(payload: unknown) {
  const queries: string[] = [];
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(text: string): Promise<PostgresQueryResult<Row>> {
      queries.push(text);
      if (text.includes("admin_catalog_state")) return result(1, [{ payload }] as unknown as Row[]);
      return result(1, []);
    },
    release() {},
  };
  return { pool: { async connect() { return client; } } satisfies PostgresWorkflowPool, queries };
}
function result<Row extends Record<string, unknown>>(rowCount: number, rows: readonly Row[]): PostgresQueryResult<Row> {
  return { rowCount, rows };
}
