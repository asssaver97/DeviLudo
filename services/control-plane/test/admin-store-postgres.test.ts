import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient, QueryResult } from "pg";
import { PostgresAdminStore } from "../src/admin-store-postgres";
import { recordAdminAudit } from "../src/admin.store";

const emptyPayload = {
  versions: [],
  installations: [],
  providers: [],
  profiles: [],
  credentials: [],
  defaults: [],
};

test("Postgres admin catalog serializes mutations, advances one revision and appends audit", async () => {
  let revision = 0;
  let payload: unknown = structuredClone(emptyPayload);
  const statements: string[] = [];
  const audits: unknown[][] = [];
  let released = 0;
  const client = {
    async query(text: string, values?: unknown[]) {
      statements.push(text);
      if (text.includes("SELECT revision, payload")) return result([{ revision, payload }]);
      if (text.includes("UPDATE deviludo.admin_catalog_state")) {
        assert.equal(values?.[0], revision);
        payload = JSON.parse(String(values?.[1]));
        revision += 1;
        return result([{ revision }]);
      }
      if (text.includes("INSERT INTO deviludo.admin_audit_records")) {
        audits.push(values ?? []);
        return result([]);
      }
      if (text.includes("FROM deviludo.admin_audit_records")) {
        return result(audits.map((values) => ({
          id: values[0], action: values[1], resource: values[2], actor_role: values[3],
          actor_id: values[4], tenant_id: values[5], project_id: values[6],
          request_id: values[7], occurred_at: values[8], metadata: JSON.parse(String(values[9])),
        })));
      }
      return result([]);
    },
    release() { released += 1; },
  } as unknown as PoolClient;
  const pool = {
    async connect() { return client; },
    async end() {},
  } as unknown as Pool;
  const store = new PostgresAdminStore(pool);
  const created = await store.mutate((state) => {
    const version = {
      id: "codex-cli@1.2.3",
      agent: "codex-cli" as const,
      version: "1.2.3",
      state: "DISCOVERED" as const,
      source: "https://github.com/openai/codex",
      integrity: `sha256:${"a".repeat(64)}`,
      signatureVerified: false,
      sbomRef: "pending://codex-cli@1.2.3",
      scan: "PENDING" as const,
      discoveredAt: "2026-07-18T00:00:00.000Z",
    };
    state.versions.set(version.id, version);
    recordAdminAudit(state, {
      action: "AGENT_VERSION_DISCOVERED",
      resource: version.id,
      role: "TenantAdmin",
      actorId: "actor-1",
      tenantId: "tenant-1",
      projectId: null,
      requestId: "request-1",
    });
    return version.id;
  });
  assert.equal(created, "codex-cli@1.2.3");
  assert.equal(revision, 1);
  assert.equal((payload as { versions: unknown[] }).versions.length, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.[5], "tenant-1");
  assert.equal(statements.some((text) => text.includes("FOR UPDATE")), true);

  const read = await store.read((state) => ({
    version: state.versions.get("codex-cli@1.2.3")?.version,
    audit: state.audit[0]?.action,
  }));
  assert.deepEqual(read, { version: "1.2.3", audit: "AGENT_VERSION_DISCOVERED" });
  assert.equal(released, 2);
});

test("Postgres admin catalog rolls back a failed mutation without writing state or audit", async () => {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text);
      if (text.includes("SELECT revision, payload")) return result([{ revision: 4, payload: emptyPayload }]);
      return result([]);
    },
    release() {},
  } as unknown as PoolClient;
  const store = new PostgresAdminStore({ async connect() { return client; }, async end() {} } as unknown as Pool);
  await assert.rejects(store.mutate(() => { throw new Error("mutation failed"); }), /mutation failed/);
  assert.equal(statements.includes("ROLLBACK"), true);
  assert.equal(statements.some((text) => text.includes("UPDATE deviludo.admin_catalog_state")), false);
});

function result<Row extends Record<string, unknown>>(rows: Row[]): QueryResult<Row> {
  return { command: "", rowCount: rows.length, oid: 0, fields: [], rows };
}
