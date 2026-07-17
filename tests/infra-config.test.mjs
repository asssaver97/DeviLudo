import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("local integration PostgreSQL applies every migration in order", () => {
  const compose = readFileSync(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");
  const offsets = Array.from({ length: 15 }, (_, index) => {
    const prefix = String(index + 1).padStart(3, "0");
    const marker = `./postgres/${prefix}_`;
    const offset = compose.indexOf(marker);
    assert.notEqual(offset, -1, `missing PostgreSQL migration ${prefix}`);
    return offset;
  });
  assert.deepEqual(offsets, [...offsets].sort((left, right) => left - right));
});

test("Runner ingress persists replayable signed jobs and immutable lease/event bindings", () => {
  const migration = readFileSync(new URL("../infra/postgres/015_runner_ingress_transactions.sql", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../services/runner-control/src/postgres-ingress.ts", import.meta.url), "utf8");
  assert.match(migration, /ADD COLUMN job jsonb/);
  assert.match(migration, /runner identity and capabilities are immutable/);
  assert.match(migration, /platform lease binding and signed job are immutable/);
  assert.match(migration, /platform_runner_events_append_only/);
  assert.match(adapter, /FOR UPDATE OF attempt SKIP LOCKED/);
  assert.match(adapter, /COALESCE\(MAX\(fencing_token\), 0\) \+ 1/);
  assert.match(adapter, /Runner is not assigned to this tenant/);
  assert.match(adapter, /signCanonical/);
});

test("physical Runner attempts require an append-only tenant execution lock", () => {
  const migration = readFileSync(new URL("../infra/postgres/014_runner_execution_locks.sql", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../services/runner-control/src/postgres-workflow.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.runner_execution_locks/);
  assert.match(migration, /UNIQUE \(tenant_id, lock_key\)/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /runner_execution_locks_append_only/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, project_id, run_id, execution_lock_id\)/);
  assert.match(migration, /workflow_operation_key IS NULL OR execution_lock_id IS NOT NULL/);
  assert.match(adapter, /FROM deviludo\.runner_execution_locks/);
  assert.match(adapter, /RUNNER_EXECUTION_LOCK_BINDING_CONFLICT/);
  assert.match(adapter, /executionLockDigest/);
});

test("Runner workflow attempts are immutable, tenant-scoped and content-bound", () => {
  const migration = readFileSync(new URL("../infra/postgres/013_runner_workflow_attempts.sql", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../services/runner-control/src/postgres-workflow.ts", import.meta.url), "utf8");
  assert.match(migration, /UNIQUE \(tenant_id, workflow_operation_key\)/);
  assert.match(migration, /main_source_digest/);
  assert.match(migration, /e2e_attempt_workflow_binding_immutable/);
  assert.match(migration, /evidence_bundle_immutable/);
  assert.match(adapter, /set_config\('app\.tenant_id'/);
  assert.match(adapter, /ON CONFLICT \(tenant_id, workflow_operation_key\) DO NOTHING/);
  assert.match(adapter, /createEvidenceBundle/);
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

test("workflow action completions use a tenant-isolated transactional signal outbox", () => {
  const migration = readFileSync(new URL("../infra/postgres/012_workflow_signal_outbox.sql", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../services/control-plane/src/workflow-action-completion-postgres.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.workflow_signal_outbox/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /UNIQUE \(tenant_id, signal_id\)/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, project_id, workflow_id, action_id\)/);
  assert.match(migration, /UNIQUE \(tenant_id, project_id, workflow_id, id\)/);
  assert.match(adapter, /set_config\('app\.tenant_id'/);
  assert.match(adapter, /INSERT INTO deviludo\.workflow_signal_outbox/);
  assert.match(adapter, /status = 'COMPLETED'/);
});
