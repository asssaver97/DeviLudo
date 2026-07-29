import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sqlUrl = new URL("../infra/postgres/001_core.sql", import.meta.url);

test("the fresh baseline fixes pool kinds and contains the durable workflow primitives", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const poolEnum = sql.match(/CREATE TYPE deviludo\.server_pool_kind AS ENUM \(([\s\S]*?)\);/)?.[1] ?? "";
  assert.deepEqual([...poolEnum.matchAll(/'([^']+)'/g)].map(match => match[1]), [
    "WEB", "CORE", "E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS",
  ]);
  for (const table of [
    "server_pools", "server_nodes", "pool_capacity_intents", "project_conversations",
    "conversation_messages", "workflow_instances",
    "workflow_events", "jobs", "external_signals", "operation_receipts",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE deviludo\\.${table}\\s*\\(`));
  }
});

test("every tenant-owned table fails closed with forced row isolation", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  assert.match(sql, /current_setting\('app\.tenant_id', true\)/);
  assert.match(sql, /ALTER TABLE deviludo\.tenants FORCE ROW LEVEL SECURITY/);
  for (const table of [
    "projects", "project_conversations", "conversation_messages", "agent_installations",
    "workflow_instances", "workflow_events",
    "jobs", "external_signals", "operation_receipts", "tenant_claim_fairness",
  ]) {
    assert.ok(sql.includes(`'${table}'`), `${table} must be enumerated by the forced isolation block`);
  }
  assert.match(sql, /FOREIGN KEY \(tenant_id, project_id\)/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, workflow_id\)/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, job_id\)/);
  for (const role of ["api", "scheduler", "sandbox"]) {
    assert.match(sql, new RegExp(`CREATE ROLE deviludo_${role} NOLOGIN NOBYPASSRLS`));
  }
  assert.match(sql, /CREATE ROLE deviludo_claim_executor NOLOGIN BYPASSRLS/);
});

test("cross-tenant claiming returns identity only and then requires a tenant transaction", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  assert.match(sql, /RETURNS TABLE \("jobId" uuid, "tenantId" uuid, "leaseToken" uuid\)/);
  assert.match(sql, /FOR UPDATE OF job SKIP LOCKED/);
  assert.match(sql, /fencing_token = fencing_token \+ 1/);
  assert.match(sql, /jobs_one_active_lease_per_executor/);
  assert.match(sql, /make_interval\(secs => least\(3600,/);
  const repository = await readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8");
  const database = await readFile(new URL("../services/core/src/database.ts", import.meta.url), "utf8");
  assert.match(repository, /withTenant\(identity\.tenantId/);
  assert.match(database, /set_config\('app\.tenant_id'/);
});
