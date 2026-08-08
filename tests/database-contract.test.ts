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
    "instance_image_generation_settings", "asset_manifests", "asset_items",
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
    "asset_manifests", "asset_items",
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
  assert.match(sql, /CASE WHEN p_kind = 'AGENT_GENERATION' THEN 5400 ELSE 1800 END/);
  assert.match(sql, /p_payload := p_payload[\s\S]*CASE WHEN v_source\.revision IS NULL THEN '\{\}'::jsonb ELSE jsonb_build_object\([\s\S]*'sourceDigest', v_source\.content_digest/);
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
  assert.match(sql, /p_signal_kind = 'STAGE_RERUN_REQUESTED'/);
  assert.match(sql, /rerun_stage := \(p_payload->>'stage'\)::deviludo\.job_kind/);
  assert.match(sql, /stage_list := deviludo\.delivery_stages\(workflow\.profile\)/);
  assert.match(sql, /downstream_stages := stage_list\[stage_index:/);
  assert.match(sql, /last_error = 'superseded by stage rerun from ' \|\| rerun_stage::text[\s\S]*AND kind = ANY\(downstream_stages\)/);
  assert.match(sql, /:rerun:/);
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

test("Agent generation lands its planned asset manifest, validated and whole", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const complete = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.complete_job\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.fail_job\()/)?.[0] ?? "";
  // Ingestion belongs to the Agent stage only, and an absent manifest is normal.
  assert.match(complete, /IF p_receipt \? 'assetManifest' THEN/);
  assert.match(complete, /jsonb_array_length\(p_receipt #> '\{assetManifest,items\}'\) NOT BETWEEN 1 AND 500/);
  // A partially-accepted manifest would leave the source referencing assets that
  // were never planned, so every item is validated before anything is written.
  assert.match(complete, /RAISE EXCEPTION 'asset manifest items are invalid'/);
  assert.match(complete, /RAISE EXCEPTION 'asset manifest keys must be unique'/);
  assert.match(complete, /NOT IN\s*\n?\s*\('sprite', 'animation', 'background', 'ui', 'icon', 'tileset'\)/);
  // Re-planning keeps one manifest per project so the user's auto-generate choice
  // and any already-uploaded asset survive a rerun.
  assert.match(complete, /ON CONFLICT \(workspace_id, project_id\) DO UPDATE/);
  assert.match(complete, /ON CONFLICT \(workspace_id, manifest_id, asset_key\) DO UPDATE/);
  assert.match(complete, /DELETE FROM deviludo\.asset_items[\s\S]*status NOT IN \('generated', 'uploaded'\)[\s\S]*asset_key NOT IN/);
  // complete_job is SECURITY INVOKER and the Agent stage is completed by the
  // sandbox role, so that role must hold the DELETE the re-plan performs.
  assert.doesNotMatch(complete, /SECURITY DEFINER/);
  assert.match(sql, /GRANT DELETE ON deviludo\.asset_items TO deviludo_sandbox/);
});

test("asset generation stays off the serial delivery chain", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  // Assets are planned by the Agent and delivered by a later ARTIFACT_BUILD
  // rerun, so no asset stage may exist as a job kind or delivery step.
  const jobKinds = sql.match(/CREATE TYPE deviludo\.job_kind AS ENUM \(([\s\S]*?)\);/)?.[1] ?? "";
  assert.deepEqual([...jobKinds.matchAll(/'([^']+)'/g)].map(match => match[1]), [
    "AGENT_GENERATION", "PROJECT_DOCUMENT_MAINTENANCE", "ARTIFACT_BUILD", "STEAM_PUBLISH",
    "E2E_TEST", "ARTIFACT_SIGN", "STEAM_CLEAN_INSTALL",
  ]);
  const stages = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.delivery_stages\([\s\S]*?\$\$;/)?.[0] ?? "";
  assert.doesNotMatch(stages, /ASSET/);
  assert.doesNotMatch(stages, /PROJECT_DOCUMENT_MAINTENANCE/);
});

test("the image generation key is held by reference and never stored in the row", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const table = sql.match(/CREATE TABLE deviludo\.instance_image_generation_settings \(([\s\S]*?)\n\);/)?.[1] ?? "";
  assert.match(table, /credential_secret_ref text NOT NULL/);
  // Its own Vault scope: an Agent-runtime ref must not resolve this key.
  assert.match(table, /LIKE 'vault:\/\/instance\/image-generation\/api-key\/versions\/%'/);
  assert.match(table, /api_key_mask text NOT NULL CHECK \(api_key_mask ~ '\^\.\{3\}\\\*\{8\}\.\{4\}\$'\)/);
  assert.doesNotMatch(table, /\bapi_key text\b|\bapi_key_value\b|\bsecret text\b/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON deviludo\.instance_image_generation_settings TO deviludo_api/);
  // Instance-wide singleton, like the Agent runtime settings.
  assert.match(table, /singleton boolean PRIMARY KEY DEFAULT true CHECK \(singleton\)/);
});
