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
    "conversation_messages", "project_documents", "project_document_revisions",
    "instance_agent_settings", "project_creation_receipts", "workflow_instances",
    "workflow_events", "jobs", "external_signals", "job_progress_events",
    "job_guidance_messages", "operation_receipts",
    "project_source_revisions", "project_source_ready_outbox",
    "artifacts", "artifact_inputs", "executor_receipts",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE deviludo\\.${table}\\s*\\(`));
  }
});

test("every workspace-owned table fails closed with forced row isolation", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  assert.match(sql, /current_setting\('app\.workspace_id', true\)/);
  assert.match(sql, /ALTER TABLE deviludo\.workspaces FORCE ROW LEVEL SECURITY/);
  for (const table of [
    "projects", "project_source_revisions", "project_source_ready_outbox", "project_documents", "project_document_revisions",
    "project_conversations", "conversation_messages", "agent_installations",
    "workflow_instances", "workflow_events",
    "jobs", "external_signals", "job_progress_events", "job_guidance_messages",
    "operation_receipts", "workspace_claim_fairness",
    "artifacts", "artifact_inputs", "executor_receipts", "project_creation_receipts",
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
  assert.match(sql, /GRANT SELECT, INSERT, DELETE ON deviludo\.project_creation_receipts TO deviludo_api/);
  assert.match(sql, /FUNCTION deviludo\.reconcile_p0_capacity\(\)[\s\S]*SECURITY INVOKER/);
  assert.match(sql, /FUNCTION deviludo\.cleanup_expired_executor_state\(\)[\s\S]*SECURITY DEFINER/);
  assert.match(sql, /CREATE TABLE deviludo\.project_conversations \([\s\S]*project_id uuid NOT NULL/);
  assert.match(sql, /CREATE TABLE deviludo\.project_source_revisions[\s\S]*relative_path text NOT NULL[\s\S]*content_digest text NOT NULL/);
  assert.match(sql, /CREATE TABLE deviludo\.project_source_ready_outbox[\s\S]*development_actor_account_id uuid NOT NULL[\s\S]*acknowledged_at timestamptz/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION deviludo\.pull_source_ready_events/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION deviludo\.acknowledge_source_ready_events/);
  assert.doesNotMatch(sql, /users|sessions|membership|invitation|github|repository_connection|password_hash|argon2/i);
  assert.doesNotMatch(sql, /'GITHUB_SYNC'|'REPOSITORY_SYNC_RECEIPT'|'SOURCE'/);
  assert.match(sql, /CREATE TABLE deviludo\.executor_receipts[\s\S]*receipt->>'simulated' = 'false'/);
  assert.match(sql, /CREATE TABLE deviludo\.job_progress_events[\s\S]*event_kind IN \('PHASE', 'AGENT_OUTPUT', 'GUIDANCE_ACCEPTED', 'COMPLETED', 'FAILED'\)/);
  assert.match(sql, /CREATE TABLE deviludo\.job_guidance_messages[\s\S]*state IN \('PENDING', 'DELIVERED', 'REJECTED'\)/);
  assert.match(sql, /credential_secret_ref text NOT NULL/);
  assert.match(sql, /api_key_mask text NOT NULL/);
  for (const column of ["primary_model", "opus_model", "sonnet_model", "haiku_model", "subagent_model"]) {
    assert.match(sql, new RegExp(`${column} text CHECK`));
  }
  assert.match(sql, /credential_secret_ref LIKE 'vault:\/\/instance\/agent-runtime\/api-key\/versions\/%'/);
  assert.match(sql, /WHEN 'AGENT_GENERATION' THEN[\s\S]*p_payload \? 'repairFromE2eJobId'[\s\S]*artifact\.kind = 'E2E_REPORT'[\s\S]*repairFromE2eJobId/);
  assert.match(sql, /IF p_kind IN \('AGENT_GENERATION', 'ARTIFACT_BUILD'\) THEN[\s\S]*'sourceRelativePath', v_source\.relative_path/);
  assert.match(sql, /PROJECT_DOCUMENT_MAINTENANCE/);
  assert.match(sql, /schedule_idle_project_document_maintenance/);
  assert.match(sql, /project\.last_activity_at <= clock_timestamp\(\) - make_interval/);
  assert.match(sql, /document\.last_agent_maintained_at < project\.last_activity_at/);
  assert.match(sql, /project document maintenance result is stale/);
  assert.match(sql, /p_kind = 'AGENT_GENERATION' AND p_payload \? 'repairFromE2eJobId' AND v_input_count <> 2/);
  assert.match(sql, /p_kind = 'AGENT_GENERATION' AND NOT \(p_payload \? 'repairFromE2eJobId'\) AND v_input_count <> 1/);
  assert.match(sql, /E2E_CONTENT_FAILED/);
  assert.match(sql, /last_error = 'E2E_PRODUCT: ' \|\| failure_summary/);
  assert.match(sql, /repair_count < 3/);
  assert.match(sql, /'repairFromE2eJobId', job\.id/);
  assert.match(sql, /p_signal_kind = 'AGENT_RETRY_REQUESTED'/);
  assert.match(sql, /failed_job\.kind <> 'AGENT_GENERATION'/);
  assert.match(sql, /:agent:retry:/);
  assert.match(sql, /p_signal_kind = 'ARTIFACT_BUILD_RETRY_REQUESTED'/);
  assert.match(sql, /failed_job\.kind <> 'ARTIFACT_BUILD'/);
  assert.match(sql, /:artifact:retry:/);
  assert.match(sql, /p_signal_kind = 'E2E_RETRY_REQUESTED'/);
  assert.match(sql, /failed_job\.kind <> 'E2E_TEST'/);
  assert.match(sql, /:e2e:retry:/);
  assert.match(sql, /successful_test\.target_operating_system = required_platform\.operating_system/);
  assert.match(sql, /source IN \('PROJECT_CREATED', 'PROJECT_IMPORTED', 'USER_EDIT', 'AGENT_CONVERSATION', 'AGENT_IDLE_MAINTENANCE'\)/);
  assert.doesNotMatch(sql, /api_key\s+text/i);
});

test("Core stores only opaque external actor identifiers and has no account authority", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const repository = await readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8");
  const bootstrap = await readFile(new URL("../scripts/bootstrap-instance.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /VALUES\s*\(\s*'admin'/i);
  assert.doesNotMatch(bootstrap, /password_hash|admin\/admin|argon2/i);
  assert.match(sql, /created_by_actor_account_id uuid NOT NULL/);
  assert.match(sql, /development_actor_account_id uuid/);
  assert.doesNotMatch(repository, /github|oauth|session|membership|invitation/i);
});

test("migration refuses legacy compatibility and requires the destructive reset", async () => {
  const migration = await readFile(new URL("../scripts/migrate-postgres.mjs", import.meta.url), "utf8");
  assert.match(migration, /deviludo-core-source-v1/);
  assert.match(migration, /INCOMPATIBLE_BASELINE_RESET_REQUIRED/);
  assert.doesNotMatch(migration, /ALTER TYPE|CREATE TABLE IF NOT EXISTS/);
  const reset = await readFile(new URL("../scripts/reset-source-baseline.mjs", import.meta.url), "utf8");
  assert.match(reset, /--confirm=RESET_DEVILUDO_SOURCE_V1/);
  assert.match(reset, /remoteResourcesDeleted: false/);
  assert.match(reset, /DEVILUDO_PROJECTS_ROOT/);
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

test("a new attempt and successful completion clear stale job errors", async () => {
  const sql = await readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8");
  const claim = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.claim_job\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.accept_workflow_signal\()/)?.[0] ?? "";
  const complete = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.complete_job\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.fail_job\()/)?.[0] ?? "";
  assert.match(claim, /SET state = 'RUNNING',[\s\S]*last_error = NULL/);
  assert.match(complete, /SET state = 'SUCCEEDED',[\s\S]*last_error = NULL/);
});
