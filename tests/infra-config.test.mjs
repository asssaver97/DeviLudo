import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("local integration PostgreSQL applies every migration in order", () => {
  const compose = readFileSync(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");
  const offsets = Array.from({ length: 11 }, (_, index) => {
    const prefix = String(index + 1).padStart(3, "0");
    const marker = `./postgres/${prefix}_`;
    const offset = compose.indexOf(marker);
    assert.notEqual(offset, -1, `missing PostgreSQL migration ${prefix}`);
    return offset;
  });
  assert.deepEqual(offsets, [...offsets].sort((left, right) => left - right));
});

test("workflow inbox idempotency is tenant-scoped in schema and adapter", () => {
  const adapter = readFileSync(new URL("../services/temporal/src/postgres-inbox.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../infra/postgres/009_workflow_inbox_tenant_key.sql", import.meta.url), "utf8");
  assert.match(migration, /PRIMARY KEY \(tenant_id, idempotency_key\)/);
  assert.match(adapter, /ON CONFLICT \(tenant_id, idempotency_key\) DO NOTHING/);
  assert.match(adapter, /WHERE tenant_id = \$2::uuid\s+AND idempotency_key = \$1/g);
  assert.doesNotMatch(adapter, /ON CONFLICT \(idempotency_key\)/);
});

test("production admin idempotency has a pinned PostgreSQL driver and durable claim schema", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../infra/postgres/010_admin_idempotency.sql", import.meta.url), "utf8");
  assert.equal(packageJson.dependencies.pg, "8.22.0");
  assert.match(migration, /identity_digest text PRIMARY KEY/);
  assert.match(migration, /state IN \('AVAILABLE', 'CLAIMED', 'COMPLETED'\)/);
  assert.match(migration, /pg_column_size\(response_payload\) <= 1048576/);
});

test("production Agent administration has a versioned catalog and append-only audit schema", () => {
  const migration = readFileSync(new URL("../infra/postgres/011_admin_catalog.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.admin_catalog_state/);
  assert.match(migration, /NEW\.revision <> OLD\.revision \+ 1/);
  assert.match(migration, /CREATE TABLE deviludo\.admin_audit_records/);
  assert.match(migration, /admin_audit_append_only/);
});

test("control-plane wait persistence uses the shared tenant RLS setting", () => {
  const adapter = readFileSync(new URL("../services/control-plane/src/workflow-action-postgres.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../infra/postgres/008_workflow_control_actions.sql", import.meta.url), "utf8");
  assert.match(adapter, /set_config\('app\.tenant_id'/);
  assert.doesNotMatch(adapter, /app\.current_tenant/);
  assert.match(migration, /deviludo\.current_tenant_id\(\)/);
  assert.doesNotMatch(migration, /app\.current_tenant/);
});
