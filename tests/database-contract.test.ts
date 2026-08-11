import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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
  assert.match(sql, /CREATE TRIGGER jobs_snapshot_artifact_build_assets[\s\S]*BEFORE INSERT ON deviludo\.jobs/);
  assert.match(sql, /'assetInputs', inputs/);
  assert.match(sql, /asset_key ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9\._\/\-\]\{0,199\}\$'/);
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
  assert.match(sql, /CREATE TRIGGER jobs_queue_local_git_commit[\s\S]*AFTER UPDATE OF state ON deviludo\.jobs/);
  assert.match(sql, /queue_local_git_commit_after_e2e\(\)[\s\S]*NEW\.kind <> 'E2E_TEST'[\s\S]*'expectedSourceDigest', source_digest/);
  assert.match(sql, /claim_local_git_commit\(p_lease_seconds integer\)[\s\S]*FOR UPDATE OF workflow SKIP LOCKED/);
  assert.match(sql, /complete_local_git_commit[\s\S]*GIT_COMMIT_COMPLETED/);
  assert.match(sql, /fail_local_git_commit[\s\S]*attempts >= 3[\s\S]*GIT_COMMIT_FAILED/);
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

test("migration upgrades compatible databases in order and still rejects incompatible baselines", async () => {
  const migration = await readFile(new URL("../scripts/migrate-postgres.mjs", import.meta.url), "utf8");
  assert.match(migration, /deviludo-core-source-v1/);
  assert.match(migration, /INCOMPATIBLE_BASELINE_RESET_REQUIRED/);
  assert.match(migration, /infra\/postgres\/migrations/);
  assert.match(migration, /pg_advisory_lock/);
  assert.match(migration, /schema_migrations/);
  assert.match(migration, /MIGRATION_CHECKSUM_MISMATCH/);
  assert.match(migration, /DATABASE_SCHEMA_AHEAD/);
  assert.match(migration, /await client\.query\(migration\.source\)/);
  const reset = await readFile(new URL("../scripts/reset-source-baseline.mjs", import.meta.url), "utf8");
  assert.match(reset, /--confirm=RESET_DEVILUDO_SOURCE_V1/);
  assert.match(reset, /remoteResourcesDeleted: false/);
  assert.match(reset, /DEVILUDO_PROJECTS_ROOT/);
});

test("upgraded databases restore workflow helper privileges after revoking PUBLIC execute", async () => {
  const privileges = await readFile(
    new URL("../infra/postgres/migrations/009_workflow_helper_privileges.sql", import.meta.url),
    "utf8",
  );
  for (const helper of [
    "delivery_stages(deviludo.workflow_profile)",
    "stage_running_state(deviludo.job_kind)",
  ]) {
    assert.match(
      privileges,
      new RegExp(`GRANT EXECUTE ON FUNCTION deviludo\\.${helper.replace(/[().]/g, "\\$&")}[\\s\\S]*deviludo_api, deviludo_scheduler, deviludo_sandbox`),
    );
  }
  assert.doesNotMatch(privileges, /\bPUBLIC\b[^\n]*;/);
});

test("upgraded databases revoke the default PUBLIC grant from import analysis claiming", async () => {
  const privileges = await readFile(
    new URL("../infra/postgres/migrations/012_revoke_import_analysis_public.sql", import.meta.url),
    "utf8",
  );
  assert.match(privileges, /REVOKE ALL ON FUNCTION deviludo\.claim_project_import_analysis\(integer\) FROM PUBLIC/);
});

test("an unroutable signal kind is rejected rather than accepted and ignored", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  // The routing below the guard is a chain of conditionals with no fallback, so a
  // kind this schema does not know would insert its row, return true, and move
  // nothing -- which reaches the user as a control that does nothing and produces
  // no error to explain it. That is what a database running functions older than
  // its caller actually looks like, so the kind is checked before any of it.
  assert.match(
    sql,
    /IF p_signal_kind NOT IN \(\s*'SPEC_APPROVED', 'STAGE_RERUN_REQUESTED', 'CANCEL_REQUESTED',\s*'RELEASE_APPROVED', 'EXTERNAL_APPROVAL'\s*\) THEN\s*RAISE EXCEPTION 'Signal kind % cannot be routed by this schema version'/,
  );
  // The guard has to precede the routing, or an unknown kind reaches the branches
  // it is meant to protect.
  const guard = sql.indexOf("cannot be routed by this schema version");
  const firstBranch = sql.indexOf("IF p_signal_kind = 'STAGE_RERUN_REQUESTED' THEN");
  assert.ok(guard > 0 && firstBranch > guard, "the signal kind guard must precede signal routing");
  // Every kind the API is allowed to send must be routable, or that endpoint is
  // shipping a control the database will reject.
  const api = await readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8");
  const declared = [...api.matchAll(/kind: "([A-Z_]+)"/g)].map(match => match[1]);
  for (const kind of new Set(declared.filter(value => value.endsWith("_REQUESTED") || value.endsWith("_APPROVED")))) {
    assert.match(sql, new RegExp(`'${kind}'`), `${kind} is sent by the API but unknown to accept_workflow_signal`);
  }
});

test("applied migrations are immutable and fresh baselines stamp incorporated versions", async () => {
  const migration = await readFile(new URL("../scripts/migrate-postgres.mjs", import.meta.url), "utf8");
  assert.match(migration, /createHash\("sha256"\)\.update\(source, "utf8"\)/);
  assert.match(migration, /previousChecksum !== migration\.checksum/);
  assert.match(migration, /INSERT INTO deviludo\.schema_migrations\(version, checksum\)/);
  assert.match(migration, /SET source_digest = \$1, current_version = \$2/);
  assert.match(migration, /baselineHasAllMigrations[\s\S]*metadata\.rows\[0\]\?\.current_version === migrations\.at\(-1\)\?\.version/);
  const sql = await readFile(sqlUrl, "utf8");
  assert.match(sql, /source_digest text CHECK \(source_digest IS NULL OR source_digest ~ '\^sha256:\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /CREATE TABLE deviludo\.schema_migrations/);
  const migrationNames = (await readdir(new URL("../infra/postgres/migrations/", import.meta.url)))
    .filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  assert.match(sql, new RegExp(`'${migrationNames.at(-1)?.slice(0, -4)}'`));
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
  // Re-planning keeps one manifest per project, gates the build only when a real
  // image provider exists, and preserves any already-uploaded asset.
  assert.match(complete, /ON CONFLICT \(workspace_id, project_id\) DO UPDATE/);
  assert.match(complete, /EXISTS \(SELECT 1 FROM deviludo\.instance_image_generation_settings WHERE singleton = true\)/);
  assert.match(complete, /RETURNING id, auto_generate_enabled INTO asset_manifest_id, asset_auto_generate/);
  assert.match(complete, /ON CONFLICT \(workspace_id, manifest_id, asset_key\) DO UPDATE/);
  assert.match(complete, /DELETE FROM deviludo\.asset_items[\s\S]*status NOT IN \('generated', 'uploaded'\)[\s\S]*asset_key NOT IN/);
  // complete_job is SECURITY INVOKER and the Agent stage is completed by the
  // sandbox role, so that role must hold the DELETE the re-plan performs.
  assert.doesNotMatch(complete, /SECURITY DEFINER/);
  assert.match(sql, /GRANT DELETE ON deviludo\.asset_items TO deviludo_sandbox/);
});

test("forward workflow jobs use their successful predecessor as the idempotency generation", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const complete = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.complete_job\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.fail_job\()/)?.[0] ?? "";
  // Superseded rows retain their unique keys. Every forward edge therefore has
  // to derive a fresh key from the job that just succeeded, or a stage rerun
  // advances the workflow state while enqueue_job returns the old CANCELLED row.
  for (const prefix of ["artifact", "e2e:", "sign:", "clean-install:"]) {
    assert.match(complete, new RegExp(`${prefix.replace("-", "\\-")}[^\\n]*:after:' \\|\\| job\\.id::text`));
  }
  const signal = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.accept_workflow_signal\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.complete_job\()/)?.[0] ?? "";
  assert.match(signal, /':publish:approved:' \|\| inserted_id::text/);
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

test("asset generation is leased, attempt-bounded, and never overwrites a user upload", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const claim = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.claim_asset_generation\([\s\S]*?\$\$;/)?.[0] ?? "";
  const complete = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.complete_asset_generation\([\s\S]*?\$\$;/)?.[0] ?? "";
  const fail = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.fail_asset_generation\([\s\S]*?\$\$;/)?.[0] ?? "";
  assert.ok(claim && complete && fail, "the asset generation functions must exist");

  // Two scheduler replicas must not generate the same asset, and a generator that
  // dies must not strand an item: the claim locks rows and takes a timed lease.
  assert.match(claim, /FOR UPDATE OF item SKIP LOCKED/);
  assert.match(claim, /SET status = 'generating'/);
  assert.match(claim, /generation_lease_expires_at = clock_timestamp\(\) \+ make_interval/);
  // An expired lease is a crashed generator, so it is reclaimable.
  assert.match(claim, /item\.status = 'generating' AND item\.generation_lease_expires_at <= clock_timestamp\(\)/);
  // Only opted-in manifests, only items that actually have a prompt to send, and
  // only while attempts remain.
  assert.match(claim, /manifest\.auto_generate_enabled = true/);
  assert.match(claim, /item\.generation_prompt IS NOT NULL/);
  assert.match(claim, /item\.generation_attempt < 3/);
  assert.match(claim, /generation_attempt = item\.generation_attempt \+ 1/);
  // Without configured settings there is no credential to call with, so claiming
  // would only burn attempts.
  assert.match(claim, /IF NOT EXISTS \(\s*SELECT 1 FROM deviludo\.instance_image_generation_settings WHERE singleton = true\s*\) THEN RETURN; END IF;/);

  // A user upload that lands mid-generation wins: settlement only applies to items
  // still leased, so a generated image cannot replace the art they chose.
  assert.match(complete, /AND status = 'generating'/);
  assert.match(complete, /SET status = 'generated', bucket = p_bucket/);
  assert.match(complete, /generation_lease_expires_at = NULL/);
  // A transient provider error retries; the last attempt settles as failed so the
  // panel stops presenting it as pending work.
  assert.match(fail, /CASE WHEN generation_attempt >= 3 THEN 'failed' ELSE 'planned' END/);
  assert.match(fail, /generation_lease_expires_at = NULL/);
  assert.match(fail, /AND status = 'generating'/);

  // The lease columns are bounded and tied to the status they describe.
  assert.match(sql, /ADD COLUMN generation_attempt integer NOT NULL DEFAULT 0\s*\n\s*CHECK \(generation_attempt BETWEEN 0 AND 3\)/);
  assert.match(sql, /CONSTRAINT asset_items_lease_requires_generating CHECK \(\s*\n?\s*\(generation_lease_expires_at IS NOT NULL\) = \(status = 'generating'\)/);

  // Generation is driven by the scheduler role, not an executor lease.
  assert.match(sql, /GRANT EXECUTE ON FUNCTION deviludo\.claim_asset_generation\(integer, integer\) TO deviludo_scheduler/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION deviludo\.fail_asset_generation\(uuid, uuid, text\) TO deviludo_scheduler/);
  assert.match(sql, /GRANT SELECT ON deviludo\.instance_image_generation_settings TO deviludo_scheduler/);
  assert.match(sql, /GRANT SELECT ON deviludo\.instance_image_generation_settings TO deviludo_sandbox/);
  // These sweep every workspace, so they are definer functions owned by the role
  // that bypasses row-level security.
  for (const definer of [claim, complete, fail]) {
    assert.match(definer, /SECURITY DEFINER/);
    assert.match(definer, /SET row_security = off/);
  }

  // A re-plan replaces the prompt, so previous attempts no longer apply and an
  // exhausted item becomes generatable again — but a settled asset is untouched.
  const completeJob = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.complete_job\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.fail_job\()/)?.[0] ?? "";
  assert.match(completeJob, /generation_attempt = CASE\s*\n\s*WHEN deviludo\.asset_items\.status IN \('generated', 'uploaded'\) THEN deviludo\.asset_items\.generation_attempt\s*\n\s*ELSE 0 END/);
  assert.match(completeJob, /status = CASE\s*\n\s*WHEN deviludo\.asset_items\.status IN \('generated', 'uploaded'\) THEN deviludo\.asset_items\.status\s*\n\s*ELSE 'planned' END/);
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
