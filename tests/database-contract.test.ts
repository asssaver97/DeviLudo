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
    "conversation_messages", "instance_agent_settings", "project_creation_receipts", "workflow_instances",
    "workflow_events", "jobs", "external_signals", "operation_receipts",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE deviludo\\.${table}\\s*\\(`));
  }
});

test("every workspace-owned table fails closed with forced row isolation", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  assert.match(sql, /current_setting\('app\.workspace_id', true\)/);
  assert.match(sql, /ALTER TABLE deviludo\.workspaces FORCE ROW LEVEL SECURITY/);
  for (const table of [
    "projects", "project_conversations", "conversation_messages", "agent_installations",
    "workflow_instances", "workflow_events",
    "jobs", "external_signals", "operation_receipts", "workspace_claim_fairness",
  ]) {
    assert.ok(sql.includes(`'${table}'`), `${table} must be enumerated by the forced isolation block`);
  }
  assert.match(sql, /FOREIGN KEY \(workspace_id, project_id\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, workflow_id\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, job_id\)/);
  for (const role of ["api", "scheduler", "sandbox"]) {
    assert.match(sql, new RegExp(`CREATE ROLE deviludo_${role} NOLOGIN NOBYPASSRLS`));
  }
  assert.match(sql, /CREATE ROLE deviludo_claim_executor NOLOGIN BYPASSRLS/);
  assert.match(sql, /CREATE TABLE deviludo\.project_conversations \([\s\S]*project_id uuid NOT NULL/);
  assert.doesNotMatch(sql, /CREATE TABLE deviludo\.(?:accounts|users|members|workspace_memberships)\b/);
  assert.match(sql, /credential_secret_ref text NOT NULL/);
  assert.match(sql, /api_key_mask text NOT NULL/);
  for (const column of ["primary_model", "opus_model", "sonnet_model", "haiku_model", "subagent_model"]) {
    assert.match(sql, new RegExp(`${column} text CHECK`));
  }
  assert.match(sql, /credential_secret_ref LIKE 'vault:\/\/instance\/agent-runtime\/api-key\/versions\/%'/);
  assert.doesNotMatch(sql, /api_key\s+text/i);
});

test("instance Agent settings are frozen into new workspace jobs by secret reference", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  assert.match(sql, /agent_settings deviludo\.instance_agent_settings%ROWTYPE/);
  assert.match(sql, /'credentialRef', agent_settings\.credential_secret_ref/);
  assert.match(sql, /'runtime', agent_settings\.agent_runtime::text/);
  assert.match(sql, /'models', CASE WHEN agent_settings\.primary_model IS NULL/);
  assert.match(sql, /'revision', agent_settings\.revision/);
});

test("cross-workspace claiming returns identity only and then requires a workspace transaction", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  assert.match(sql, /RETURNS TABLE \("jobId" uuid, "workspaceId" uuid, "leaseToken" uuid\)/);
  assert.match(sql, /FOR UPDATE OF job SKIP LOCKED/);
  assert.match(sql, /fencing_token = fencing_token \+ 1/);
  assert.match(sql, /jobs_one_active_lease_per_executor/);
  assert.match(sql, /make_interval\(secs => least\(3600,/);
  const repository = await readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8");
  const database = await readFile(new URL("../services/core/src/database.ts", import.meta.url), "utf8");
  assert.match(repository, /withWorkspace\(identity\.workspaceId/);
  assert.match(database, /set_config\('app\.workspace_id'/);
});
