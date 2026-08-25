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
    "implementation_change_requests", "workflow_e2e_goal_revisions", "operation_receipts",
    "project_source_revisions",
    "artifacts", "artifact_inputs", "object_cleanup_queue", "executor_receipts",
    "asset_manifests", "asset_items", "e2e_test_plans",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE deviludo\\.${table}\\s*\\(`));
  }
});

test("every workspace-owned table fails closed with forced row isolation", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  assert.match(sql, /current_setting\('app\.workspace_id', true\)/);
  assert.match(sql, /ALTER TABLE deviludo\.workspaces FORCE ROW LEVEL SECURITY/);
  for (const table of [
    "projects", "project_source_revisions", "project_documents", "project_document_revisions",
    "project_conversations", "conversation_messages", "agent_installations",
    "workflow_instances", "workflow_events",
    "jobs", "external_signals", "job_progress_events", "implementation_change_requests",
    "workflow_e2e_goal_revisions",
    "operation_receipts", "workspace_claim_fairness",
    "artifacts", "artifact_inputs", "object_cleanup_queue", "e2e_policy_locks", "e2e_policy_decisions", "e2e_test_plans", "e2e_regression_traces",
    "executor_receipts", "project_creation_receipts",
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
  assert.match(sql, /CREATE TABLE deviludo\.conversation_messages \([\s\S]*completed_at timestamptz NOT NULL DEFAULT clock_timestamp\(\)[\s\S]*conversation_messages_completed_after_creation CHECK \(completed_at >= created_at\)/);
  assert.match(sql, /CREATE TABLE deviludo\.project_source_revisions[\s\S]*relative_path text NOT NULL[\s\S]*content_digest text NOT NULL/);
  assert.doesNotMatch(sql, /UNIQUE \(workspace_id, project_id, content_digest\)/);
  assert.doesNotMatch(sql, /source_ready_outbox|pull_source_ready_events|acknowledge_source_ready_events/);
  assert.doesNotMatch(sql, /users|sessions|membership|invitation|github|repository_connection|password_hash|argon2/i);
  assert.doesNotMatch(sql, /'GITHUB_SYNC'|'REPOSITORY_SYNC_RECEIPT'|'SOURCE'/);
  assert.match(sql, /CREATE TABLE deviludo\.executor_receipts[\s\S]*receipt->>'simulated' = 'false'/);
  assert.match(sql, /CREATE TABLE deviludo\.job_progress_events[\s\S]*event_kind IN \('PHASE', 'AGENT_OUTPUT', 'SUPERSEDED', 'COMPLETED', 'FAILED'\)/);
  assert.doesNotMatch(sql, /job_guidance_messages|GUIDANCE_ACCEPTED/);
  assert.match(sql, /CREATE TABLE deviludo\.implementation_change_requests[\s\S]*decision_idempotency_key text/);
  assert.match(sql, /CREATE UNIQUE INDEX implementation_change_requests_one_pending/);
  assert.match(sql, /CREATE TABLE deviludo\.workflow_e2e_goal_revisions[\s\S]*goals_digest text NOT NULL/);
  assert.match(sql, /automatic_build_repair := job\.kind = 'ARTIFACT_BUILD'[\s\S]*position\('BUILD_PRODUCT:' IN p_reason\) > 0/);
  assert.match(sql, /terminal := automatic_build_repair OR job\.attempt >= job\.max_attempts/);
  assert.match(sql, /automatic_build_repair[\s\S]*'repairFailureJobId', job\.id[\s\S]*'repairFailureKind', 'ARTIFACT_BUILD'[\s\S]*'repairFailureSummary', left\(p_reason, 1800\)/);
  assert.match(sql, /snapshot_artifact_build_assets[\s\S]*source_job\.receipt #> '\{assetManifest,items\}'[\s\S]*latest_agent\.state = 'SUCCEEDED'/);
  assert.match(sql, /FUNCTION deviludo\.recover_expired_jobs[\s\S]*failed_workflows AS[\s\S]*UPDATE deviludo\.workflow_instances[\s\S]*terminal\.workflow_id/);
  assert.match(sql, /credential_secret_ref text NOT NULL/);
  assert.match(sql, /api_key_mask text NOT NULL/);
  assert.match(sql, /primary_model text NOT NULL CHECK/);
  assert.match(sql, /model_overrides jsonb NOT NULL CHECK/);
  for (const role of ["design", "development", "test"]) {
    assert.match(sql, new RegExp(`model_overrides->'${role}'`));
  }
  assert.match(sql, /image_model text CHECK/);
  assert.doesNotMatch(sql, /opus_model|sonnet_model|haiku_model|subagent_model|role_models/);
  assert.match(sql, /credential_secret_ref LIKE 'vault:\/\/instance\/agent-runtime\/api-key\/versions\/%'/);
  assert.doesNotMatch(sql, /instance_agent_provider_profiles/);
  assert.match(sql, /WHEN 'AGENT_GENERATION' THEN[\s\S]*p_payload \? 'repairFromE2eJobId'[\s\S]*artifact\.kind = 'E2E_REPORT'[\s\S]*repairFromE2eJobId/);
  assert.match(sql, /artifact\.kind = 'SPECIFICATION'[\s\S]*latest_specification\.workflow_id = p_workflow_id[\s\S]*ORDER BY latest_specification\.created_at DESC, latest_specification\.id DESC/);
  assert.match(sql, /IF p_kind IN \('AGENT_GENERATION', 'ARTIFACT_BUILD', 'E2E_TEST'\) THEN[\s\S]*'sourceRelativePath', v_source\.relative_path/);
  assert.match(sql, /CREATE TRIGGER jobs_snapshot_agent_baseline_source/);
  assert.match(sql, /'baselineSourceRelativePath', baseline\.relative_path/);
  assert.match(sql, /CREATE TRIGGER jobs_snapshot_artifact_build_assets[\s\S]*BEFORE INSERT ON deviludo\.jobs/);
  assert.match(sql, /'assetInputs', inputs/);
  assert.match(sql, /asset_key ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9\._\/\-\]\{0,199\}\$'/);
  assert.match(sql, /CASE WHEN p_kind = 'AGENT_GENERATION' THEN 5400[\s\S]*WHEN p_kind = 'E2E_TEST' THEN 5400[\s\S]*ELSE 1800 END/);
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
  assert.match(sql, /repair_count < 5/);
  assert.doesNotMatch(sql, /project_source_revisions[\s\S]{0,1600}test_manifest_schema/);
  assert.doesNotMatch(sql, /\{testManifest,schema\}|\{e2eExecutionPlan,plannedTimeoutSeconds\}/);
  assert.match(sql, /p_receipt #>> '\{execution,evidence,testManifestDigest\}'/);
  assert.match(sql, /p_receipt #>> '\{execution,evidence,regressionContractDigest\}'/);
  assert.match(sql, /previous_repair\.payload->>'manualRerun' IS DISTINCT FROM 'true'/);
  assert.match(sql, /previous_repair\.created_at > coalesce\(\([\s\S]*max\(manual_agent\.created_at\)[\s\S]*manual_agent\.payload->>'manualRerun' = 'true'/);
  assert.match(sql, /'repairFromE2eJobId', job\.id/);
  assert.match(sql, /p_signal_kind = 'STAGE_RERUN_REQUESTED'/);
  assert.match(sql, /workflow\.state NOT IN \('RELEASE_DECISION_PENDING', 'FAILED', 'SUCCEEDED', 'CANCELLED'\)/);
  assert.match(sql, /FUNCTION deviludo\.request_stage_rerun/);
  assert.match(sql, /rerun_stage := \(p_payload->>'stage'\)::deviludo\.job_kind/);
  assert.match(sql, /stage_list := deviludo\.delivery_stages\(workflow\.profile\)/);
  assert.match(sql, /downstream_stages := stage_list\[stage_index:/);
  assert.match(sql, /failed_job\.receipt #>> '\{execution,outcome\}' = 'FAILED'[\s\S]*failed_job\.receipt #>> '\{execution,failureDomain\}' = 'PRODUCT'[\s\S]*evidence\.kind = 'E2E_REPORT'/);
  assert.match(sql, /failed_job\.kind = 'ARTIFACT_BUILD'[\s\S]*failed_job\.state = 'FAILED'[\s\S]*length\(coalesce\(failed_job\.last_error, ''\)\) > 0/);
  assert.match(sql, /repair_build_updated_at > coalesce\(repair_e2e_updated_at, '-infinity'::timestamptz\)/);
  assert.match(sql, /'manualRerun', true[\s\S]*'repairFromE2eJobId', repair_e2e_job_id[\s\S]*'failedPlatform', repair_e2e_platform[\s\S]*'repairFailureJobId', repair_build_job_id[\s\S]*'repairFailureKind', 'ARTIFACT_BUILD'[\s\S]*'repairFailureSummary', repair_build_summary/);
  assert.match(sql, /last_error = 'superseded by stage rerun from ' \|\| rerun_stage::text[\s\S]*AND kind = ANY\(downstream_stages\)/);
  assert.match(sql, /:rerun:/);
  assert.match(sql, /successful_test\.target_operating_system = required_platform\.operating_system/);
  assert.match(sql, /CREATE TRIGGER jobs_queue_local_git_commit[\s\S]*AFTER UPDATE OF state ON deviludo\.jobs/);
  assert.match(sql, /queue_local_git_commit_after_e2e\(\)[\s\S]*NEW\.kind <> 'E2E_TEST'[\s\S]*'expectedSourceDigest', source_digest/);
  assert.match(sql, /claim_local_git_commit\(p_lease_seconds integer\)[\s\S]*FOR UPDATE OF workflow SKIP LOCKED/);
  assert.match(sql, /complete_local_git_commit[\s\S]*GIT_COMMIT_COMPLETED/);
  assert.match(sql, /fail_local_git_commit[\s\S]*attempts >= 3[\s\S]*GIT_COMMIT_FAILED/);
  assert.doesNotMatch(sql, /schedule_e2e_protocol_revalidation|e2eProtocolRevalidation/);
  assert.match(sql, /E2E_REGRESSION/);
  assert.match(sql, /CREATE TABLE deviludo\.e2e_test_plans[\s\S]*PRIMARY KEY \(workspace_id, workflow_id, source_revision, goal_revision, target_platform\)/);
  assert.match(sql, /GRANT SELECT, INSERT ON deviludo\.e2e_test_plans TO deviludo_api/);
  assert.match(sql, /e2e_policy_decisions/);
  assert.match(sql, /current E2E output set is invalid/);
  assert.match(sql, /claim_object_cleanup\(p_lease_seconds integer\)[\s\S]*FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /replaced E2E regression trace/);
  assert.match(sql, /CREATE TRIGGER artifacts_retain_latest_e2e_report[\s\S]*BEFORE INSERT ON deviludo\.artifacts[\s\S]*WHEN \(NEW\.kind = 'E2E_REPORT'\)/);
  assert.match(sql, /retain_latest_e2e_report\(\)[\s\S]*'superseded E2E report'/);
  assert.match(sql, /artifact\.workflow_id = NEW\.workflow_id[\s\S]*artifact\.target_platform IS NOT DISTINCT FROM NEW\.target_platform/);
  assert.match(sql, /source IN \('PROJECT_CREATED', 'PROJECT_IMPORTED', 'USER_EDIT', 'AGENT_CONVERSATION', 'AGENT_IDLE_MAINTENANCE'\)/);
  assert.doesNotMatch(sql, /api_key\s+text/i);
});

test("Agent reruns select only the latest historical draft specification", async () => {
  const migration = await readFile(
    new URL("../infra/postgres/migrations/057_latest_agent_specification_input.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /pg_get_functiondef/);
  assert.match(migration, /latest_specification\.workflow_id = p_workflow_id/);
  assert.match(migration, /latest_specification\.producing_job_id IS NULL/);
  assert.match(migration, /ORDER BY latest_specification\.created_at DESC, latest_specification\.id DESC/);
  assert.match(migration, /replace\(definition, old_condition, latest_condition\)/);
});

test("conversation intent migration removes legacy guidance progress before tightening its constraint", async () => {
  const migration = await readFile(
    new URL("../infra/postgres/migrations/058_conversation_intent_rerun.sql", import.meta.url),
    "utf8",
  );
  const dropConstraint = migration.indexOf("DROP CONSTRAINT job_progress_events_event_kind_check");
  const deleteLegacyRows = migration.indexOf("DELETE FROM deviludo.job_progress_events WHERE event_kind = 'GUIDANCE_ACCEPTED'");
  const addConstraint = migration.indexOf("event_kind IN ('PHASE', 'AGENT_OUTPUT', 'SUPERSEDED', 'COMPLETED', 'FAILED')");
  assert.ok(dropConstraint >= 0 && deleteLegacyRows > dropConstraint && addConstraint > deleteLegacyRows);
});

test("confirmed conversation reruns reset automatic repair budgets", async () => {
  const migration = await readFile(
    new URL("../infra/postgres/migrations/059_reset_repair_budget_after_intent_rerun.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /OR NOT \(manual_agent\.payload \? 'repairFromE2eJobId'\)/);
  assert.match(migration, /NOT \(manual_agent\.payload \? 'repairFailureKind'\)/);
  assert.match(migration, /pg_get_functiondef\(complete_target\)/);
  assert.match(migration, /pg_get_functiondef\(fail_target\)/);
});

test("manual Agent reruns retain product-failure evidence and reset the bounded repair cycle", async () => {
  const rerunMigration = await readFile(
    new URL("../infra/postgres/migrations/037_manual_agent_rerun_uses_e2e_evidence.sql", import.meta.url),
    "utf8",
  );
  const evidenceMigration = await readFile(
    new URL("../infra/postgres/migrations/038_preserve_superseded_e2e_repair_evidence.sql", import.meta.url),
    "utf8",
  );
  const buildMigration = await readFile(
    new URL("../infra/postgres/migrations/039_manual_agent_rerun_uses_build_failure.sql", import.meta.url),
    "utf8",
  );
  assert.match(rerunMigration, /accept_workflow_signal\(uuid,text,text,jsonb\)/);
  assert.match(rerunMigration, /evidence\.kind = 'E2E_REPORT'/);
  assert.match(rerunMigration, /'manualRerun', true/);
  assert.match(rerunMigration, /'repairFromE2eJobId', repair_e2e_job_id/);
  assert.match(rerunMigration, /complete_job\(uuid,uuid,bigint,bigint,jsonb,jsonb,text,text,text\)/);
  assert.match(rerunMigration, /previous_repair\.payload->>'manualRerun' IS DISTINCT FROM 'true'/);
  assert.match(rerunMigration, /manual_agent\.payload->>'manualRerun' = 'true'/);
  assert.match(evidenceMigration, /failed_job\.receipt #>> '\{execution,outcome\}' = 'FAILED'/);
  assert.match(evidenceMigration, /failed_job\.receipt #>> '\{execution,failureDomain\}' = 'PRODUCT'/);
  assert.match(buildMigration, /failed_job\.kind = 'ARTIFACT_BUILD'/);
  assert.match(buildMigration, /repair_build_updated_at > coalesce\(repair_e2e_updated_at, '-infinity'::timestamptz\)/);
  assert.match(buildMigration, /'repairFailureJobId', repair_build_job_id/);
  assert.match(buildMigration, /'repairFailureKind', 'ARTIFACT_BUILD'/);
  assert.match(buildMigration, /'repairFailureSummary', repair_build_summary/);
});

test("deterministic Builder product failures automatically return to Agent repair", async () => {
  const migration = await readFile(
    new URL("../infra/postgres/migrations/055_automatic_build_product_repair.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE OR REPLACE FUNCTION deviludo\.fail_job/);
  assert.match(migration, /position\('BUILD_PRODUCT:' IN p_reason\) > 0/);
  assert.match(migration, /terminal := automatic_build_repair OR job\.attempt >= job\.max_attempts/);
  assert.match(migration, /'repairFailureJobId', job\.id/);
  assert.match(migration, /'repairFailureKind', 'ARTIFACT_BUILD'/);
  assert.match(migration, /'repairAttempt', repair_count \+ 1/);
  assert.match(migration, /repair_count < 5/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION deviludo\.snapshot_artifact_build_assets/);
  assert.match(migration, /source_job\.receipt #> '\{assetManifest,items\}'/);
});

test("database smoke freezes only assets planned by its successful Agent", async () => {
  const smoke = await readFile(new URL("../scripts/local-database-smoke.mjs", import.meta.url), "utf8");
  assert.match(
    smoke,
    /SET state = 'SUCCEEDED',[\s\S]*receipt = jsonb_build_object\([\s\S]*'assetManifest'[\s\S]*'items'[\s\S]*'assetKey', 'ui\/smoke'/,
  );
});

test("Core stores only opaque local actor identifiers and has no identity authority", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const repository = await readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8");
  const bootstrap = await readFile(new URL("../scripts/bootstrap-instance.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /VALUES\s*\(\s*'admin'/i);
  assert.doesNotMatch(bootstrap, /password_hash|admin\/admin|argon2/i);
  assert.match(sql, /created_by_actor_id uuid NOT NULL/);
  assert.match(sql, /development_actor_id uuid/);
  assert.doesNotMatch(repository, /github|oauth|membership|invitation/i);
});

test("migration upgrades compatible databases in order and still rejects incompatible baselines", async () => {
  const migration = await readFile(new URL("../scripts/migrate-postgres.mjs", import.meta.url), "utf8");
  assert.match(migration, /deviludo-self-hosted-v1/);
  assert.match(migration, /INCOMPATIBLE_BASELINE_RESET_REQUIRED/);
  assert.match(migration, /infra\/postgres\/migrations/);
  assert.match(migration, /pg_advisory_lock/);
  assert.match(migration, /schema_migrations/);
  assert.match(migration, /MIGRATION_CHECKSUM_MISMATCH/);
  assert.match(migration, /DATABASE_SCHEMA_AHEAD/);
  assert.match(migration, /await client\.query\(migration\.source\)/);
  const reset = await readFile(new URL("../scripts/reset-self-hosted-baseline.mjs", import.meta.url), "utf8");
  assert.match(reset, /--confirm=RESET_DEVILUDO_SELF_HOSTED/);
  assert.match(reset, /remoteResourcesDeleted: false/);
  assert.match(reset, /DEVILUDO_PROJECTS_ROOT/);
});

test("the adaptive E2E migration retires old evidence and reruns only each latest active cohort", async () => {
  const migration = await readFile(
    new URL("../infra/postgres/migrations/029_adaptive_e2e.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /DELETE FROM deviludo\.artifacts WHERE kind = 'E2E_REPORT'/);
  assert.match(migration, /INSERT INTO deviludo\.object_cleanup_queue[\s\S]*retired E2E evidence contract/);
  assert.match(migration, /kind IN \('ARTIFACT_BUILD', 'E2E_TEST'\)[\s\S]*state IN \('QUEUED', 'RETRY', 'RUNNING'\)/);
  assert.match(migration, /newer\.iteration_number > workflow\.iteration_number/);
  assert.match(migration, /'STAGE_RERUN_REQUESTED', 'adaptive-e2e-current'/);
  assert.match(migration, /'stage', 'AGENT_GENERATION'/);
  assert.doesNotMatch(migration, /allowLegacy/);
});

test("E2E report retention deletes superseded evidence on upgrade and after every rerun", async () => {
  const migration = await readFile(
    new URL("../infra/postgres/migrations/047_latest_e2e_report_retention.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TRIGGER artifacts_retain_latest_e2e_report/);
  assert.match(migration, /PARTITION BY workspace_id, workflow_id, target_platform/);
  assert.match(migration, /ORDER BY created_at DESC, id DESC/);
  assert.match(migration, /INSERT INTO deviludo\.object_cleanup_queue[\s\S]*'superseded E2E report'/);
  assert.match(migration, /DELETE FROM deviludo\.artifact_inputs/);
  assert.match(migration, /DELETE FROM deviludo\.artifacts/);
  assert.match(migration, /OWNER TO deviludo_claim_executor/);
  assert.match(migration, /SET row_security = off/);
  const privilegeMigration = await readFile(
    new URL("../infra/postgres/migrations/048_e2e_report_retention_privilege.sql", import.meta.url),
    "utf8",
  );
  assert.match(privilegeMigration, /ALTER FUNCTION deviludo\.retain_latest_e2e_report\(\) OWNER TO CURRENT_USER/);
  assert.match(privilegeMigration, /REVOKE ALL ON FUNCTION deviludo\.retain_latest_e2e_report\(\) FROM PUBLIC/);
  assert.doesNotMatch(privilegeMigration, /GRANT DELETE ON deviludo\.artifacts/);
  const orderingMigration = await readFile(
    new URL("../infra/postgres/migrations/049_e2e_report_retention_before_insert.sql", import.meta.url),
    "utf8",
  );
  assert.match(orderingMigration, /DROP TRIGGER IF EXISTS artifacts_retain_latest_e2e_report/);
  assert.match(orderingMigration, /BEFORE INSERT ON deviludo\.artifacts/);
});

test("upgraded schedulers can inspect idempotent workflow signals", async () => {
  const sql = await readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../infra/postgres/migrations/016_scheduler_external_signal_privilege.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    migration,
    /GRANT SELECT, INSERT, UPDATE ON deviludo\.external_signals TO deviludo_scheduler/,
  );
  assert.match(
    migration,
    /GRANT SELECT ON deviludo\.external_signals TO deviludo_claim_executor/,
  );
  assert.match(
    sql,
    /deviludo\.runtime_images, deviludo\.artifacts, deviludo\.artifact_inputs,\s*deviludo\.external_signals, deviludo\.steam_releases, deviludo\.e2e_regression_traces\s*TO deviludo_claim_executor/,
  );
});

test("E2E completion can idempotently queue a replaced regression object", async () => {
  const sql = await readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../infra/postgres/migrations/053_e2e_regression_cleanup_conflict_privilege.sql", import.meta.url),
    "utf8",
  );
  const conflictKeyPrivilege = /GRANT SELECT \(workspace_id, bucket, object_key\)(?:, INSERT)?\s+ON deviludo\.object_cleanup_queue\s+TO deviludo_api, deviludo_sandbox/;
  assert.match(sql, conflictKeyPrivilege);
  assert.match(migration, conflictKeyPrivilege);
  assert.doesNotMatch(migration, /GRANT SELECT ON deviludo\.object_cleanup_queue/);
});

test("the protocol scheduler definer can route its idempotent rerun signal", async () => {
  const [sql, migration] = await Promise.all([
    readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8"),
    readFile(
      new URL("../infra/postgres/migrations/017_protocol_revalidation_definer_privileges.sql", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(migration, /GRANT INSERT ON deviludo\.external_signals TO deviludo_claim_executor/);
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION deviludo\.delivery_stages\(deviludo\.workflow_profile\)[\s\S]*TO deviludo_claim_executor/,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION deviludo\.stage_running_state\(deviludo\.job_kind\)[\s\S]*TO deviludo_claim_executor/,
  );
  assert.match(
    sql,
    /GRANT INSERT ON deviludo\.jobs, deviludo\.artifact_inputs, deviludo\.external_signals\s*TO deviludo_claim_executor/,
  );
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
    /IF p_signal_kind NOT IN \(\s*'SPEC_APPROVED', 'STAGE_RERUN_REQUESTED', 'CANCEL_REQUESTED',\s*'RELEASE_APPROVED', 'RELEASE_SKIPPED', 'EXTERNAL_APPROVAL'\s*\) THEN\s*RAISE EXCEPTION 'Signal kind % cannot be routed by this schema version'/,
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

test("the Provider ownership repair restores Claude and removes custom Codex credentials", async () => {
  const migration = await readFile(new URL("../infra/postgres/migrations/034_restore_claude_provider_ownership.sql", import.meta.url), "utf8");
  const removal = await readFile(new URL("../infra/postgres/migrations/036_remove_agent_provider_profiles.sql", import.meta.url), "utf8");
  assert.match(migration, /SELECT 'CLAUDE_CODE'::deviludo\.agent_runtime/);
  assert.match(migration, /DELETE FROM deviludo\.instance_agent_provider_profiles[\s\S]*agent_runtime = 'CODEX_CLI'/);
  assert.match(migration, /instance_agent_settings_claude_provider_only/);
  assert.match(removal, /DROP TABLE deviludo\.instance_agent_provider_profiles/);
});

test("instance Agent settings are frozen into new workspace jobs by secret reference", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  assert.match(sql, /agent_settings deviludo\.instance_agent_settings%ROWTYPE/);
  assert.match(sql, /'credentialRef', agent_settings\.credential_secret_ref/);
  assert.match(sql, /'runtime', agent_settings\.agent_runtime::text/);
  assert.match(sql, /'model', coalesce\(agent_settings\.model_overrides->>'development', agent_settings\.primary_model\)/);
  assert.doesNotMatch(sql, /'models', CASE WHEN agent_settings\.agent_runtime <> 'CLAUDE_CODE'/);
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
  // Re-planning keeps one manifest per project. The insert trigger resolves the
  // selected runtime's actual image backend without overriding later user toggles.
  assert.match(complete, /ON CONFLICT \(workspace_id, project_id\) DO UPDATE/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION deviludo\.default_asset_auto_generation\(\)[\s\S]*agent_runtime = 'CODEX_CLI'[\s\S]*agent_runtime = 'CLAUDE_CODE' AND image_model IS NOT NULL/);
  assert.match(sql, /BEFORE INSERT ON deviludo\.asset_manifests/);
  assert.match(complete, /RETURNING id, auto_generate_enabled INTO asset_manifest_id, asset_auto_generate/);
  assert.match(complete, /ON CONFLICT \(workspace_id, manifest_id, asset_key\) DO UPDATE/);
  assert.match(complete, /INSERT INTO deviludo\.object_cleanup_queue[\s\S]*retired generated asset after Agent manifest re-plan[\s\S]*old\.status = 'generated'/);
  assert.match(complete, /UPDATE deviludo\.asset_items old[\s\S]*old\.status = 'generated'[\s\S]*generation_prompt IS DISTINCT FROM/);
  assert.match(complete, /DELETE FROM deviludo\.asset_items[\s\S]*status <> 'uploaded'[\s\S]*asset_key NOT IN/);
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
  for (const prefix of ["artifact", "e2e:"]) {
    assert.match(complete, new RegExp(`${prefix.replace("-", "\\-")}[^\\n]*:after:' \\|\\| job\\.id::text`));
  }
  const signal = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.accept_workflow_signal\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.complete_job\()/)?.[0] ?? "";
  assert.match(signal, /':publish:approved:' \|\| inserted_id::text/);
  assert.match(complete, /SET state = 'RELEASE_DECISION_PENDING'/);
  assert.doesNotMatch(complete, /enqueue_job\([^;]*'ARTIFACT_SIGN'|enqueue_job\([^;]*'STEAM_CLEAN_INSTALL'/);
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
  assert.doesNotMatch(stages, /ARTIFACT_SIGN|STEAM_CLEAN_INSTALL/);
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
  assert.match(claim, /generation_lease_token = gen_random_uuid\(\)/);
  // Without configured settings there is no credential to call with, so claiming
  // would only burn attempts.
  assert.match(claim, /IF NOT EXISTS \([\s\S]*SELECT 1 FROM deviludo\.instance_agent_settings[\s\S]*agent_runtime = 'CODEX_CLI'[\s\S]*agent_runtime = 'CLAUDE_CODE' AND image_model IS NOT NULL[\s\S]*\) THEN RETURN; END IF;/);
  assert.match(sql, /status IN \('planned', 'generating', 'generated', 'uploaded', 'existing', 'failed'\)/);
  assert.match(sql, /\(status = 'existing'\) = \(source_path IS NOT NULL\)/);
  assert.match(sql, /CREATE TRIGGER asset_items_normalize_existing_source[\s\S]*BEFORE INSERT OR UPDATE OF status, source_path/);
  assert.match(sql, /normalize_asset_item_existing_source\(\)[\s\S]*IF NEW\.status <> 'existing' THEN[\s\S]*NEW\.source_path := NULL/);

  // A user upload that lands mid-generation wins: settlement only applies to items
  // still leased, so a generated image cannot replace the art they chose.
  assert.match(complete, /AND status = 'generating'/);
  assert.match(complete, /generation_lease_token = p_lease_token/);
  assert.match(complete, /SET status = 'generated', bucket = p_bucket/);
  assert.match(complete, /generation_lease_expires_at = NULL/);
  // A transient provider error retries; the last attempt settles as failed so the
  // panel stops presenting it as pending work.
  assert.match(fail, /CASE WHEN generation_attempt >= 3 THEN 'failed' ELSE 'planned' END/);
  assert.match(fail, /generation_lease_expires_at = NULL/);
  assert.match(fail, /AND status = 'generating'/);
  assert.match(fail, /generation_lease_token = p_lease_token/);

  // The lease columns are bounded and tied to the status they describe.
  assert.match(sql, /ADD COLUMN generation_attempt integer NOT NULL DEFAULT 0\s*\n\s*CHECK \(generation_attempt BETWEEN 0 AND 3\)/);
  assert.match(sql, /CONSTRAINT asset_items_lease_requires_generating CHECK \(\s*\n?\s*\(generation_lease_expires_at IS NOT NULL\) = \(status = 'generating'\)/);

  // Generation is driven by the scheduler role, not an executor lease.
  assert.match(sql, /GRANT EXECUTE ON FUNCTION deviludo\.claim_asset_generation\(integer, integer\) TO deviludo_scheduler/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION deviludo\.fail_asset_generation\(uuid, uuid, uuid, text\) TO deviludo_scheduler/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON deviludo\.instance_agent_settings TO deviludo_api/);
  assert.match(sql, /GRANT SELECT ON deviludo\.instance_agent_settings TO deviludo_scheduler, deviludo_sandbox/);
  assert.match(sql, /GRANT SELECT ON deviludo\.e2e_regression_traces\s+TO deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor/);
  assert.match(sql, /deviludo\.workflow_instances, deviludo\.instance_agent_settings,/);
  // These sweep every workspace, so they are definer functions owned by the role
  // that bypasses row-level security.
  for (const definer of [claim, complete, fail]) {
    assert.match(definer, /SECURITY DEFINER/);
    assert.match(definer, /SET row_security = off/);
  }

  // A re-plan replaces unresolved attempts, preserves user uploads, reuses an
  // unchanged generated contract, and retires a changed generated contract.
  const completeJob = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.complete_job\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.fail_job\()/)?.[0] ?? "";
  assert.match(completeJob, /INSERT INTO deviludo\.object_cleanup_queue[\s\S]*old\.status = 'generated'/);
  assert.match(completeJob, /old\.generation_prompt IS DISTINCT FROM item->>'generationPrompt'/);
  assert.match(completeJob, /SET status = 'planned', bucket = NULL, object_key = NULL,[\s\S]*generation_lease_token = NULL/);
  assert.match(completeJob, /generation_attempt = CASE\s*\n\s*WHEN deviludo\.asset_items\.status IN \('generated', 'uploaded'\) THEN deviludo\.asset_items\.generation_attempt\s*\n\s*ELSE 0 END/);
  assert.match(completeJob, /status = CASE\s*\n\s*WHEN deviludo\.asset_items\.status IN \('generated', 'uploaded'\) THEN deviludo\.asset_items\.status\s*\n\s*ELSE 'planned' END/);
  assert.match(completeJob, /source_path = CASE\s*\n\s*WHEN deviludo\.asset_items\.status IN \('generated', 'uploaded'\) THEN deviludo\.asset_items\.source_path\s*\n\s*ELSE NULL END/);
});

test("asset Manifest garbage collection migration upgrades existing databases atomically", async () => {
  const migration = await readFile(
    new URL("../infra/postgres/migrations/060_asset_manifest_garbage_collection.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /pg_get_functiondef\(target\)/);
  assert.match(migration, /INSERT INTO deviludo\.object_cleanup_queue[\s\S]*old\.status = 'generated'/);
  assert.match(migration, /old\.generation_prompt IS DISTINCT FROM item->>'generationPrompt'/);
  assert.match(migration, /status <> 'uploaded'/);
});

test("conversation completion migration backfills old messages and records future completion times", async () => {
  const migration = await readFile(
    new URL("../infra/postgres/migrations/061_conversation_message_completed_at.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /ADD COLUMN completed_at timestamptz/);
  assert.match(migration, /SET completed_at = created_at/);
  assert.match(migration, /ALTER COLUMN completed_at SET DEFAULT clock_timestamp\(\)/);
  assert.match(migration, /ALTER COLUMN completed_at SET NOT NULL/);
  assert.match(migration, /CHECK \(completed_at >= created_at\)/);
});

test("asset re-plan migration atomically clears stale existing-source paths", async () => {
  const migration = await readFile(
    new URL("../infra/postgres/migrations/054_asset_replan_existing_source_consistency.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE OR REPLACE FUNCTION deviludo\.normalize_asset_item_existing_source\(\)/);
  assert.match(migration, /IF NEW\.status <> 'existing' THEN\s*NEW\.source_path := NULL/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OF status, source_path ON deviludo\.asset_items/);
  assert.match(migration, /REVOKE ALL ON FUNCTION deviludo\.normalize_asset_item_existing_source\(\) FROM PUBLIC/);
});

test("asset reruns atomically invalidate downstream work and resume the delivery chain", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const rerun = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.request_asset_rerun\([\s\S]*?\n\$\$;/)?.[0] ?? "";
  const advance = sql.match(/CREATE OR REPLACE FUNCTION deviludo\.advance_asset_workflows\([\s\S]*?\n\$\$;/)?.[0] ?? "";
  assert.ok(rerun && advance, "asset rerun and readiness functions must exist");
  assert.match(rerun, /FOR UPDATE/);
  assert.match(rerun, /'ASSET_GENERATING', 'RELEASE_DECISION_PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'/);
  assert.match(rerun, /signal_kind[\s\S]*'ASSET_RERUN_REQUESTED'/);
  assert.match(rerun, /SET status = 'planned', generation_attempt = 0/);
  assert.match(rerun, /kind IN \('ARTIFACT_BUILD', 'E2E_TEST', 'STEAM_PUBLISH'\)[\s\S]*state <> 'CANCELLED'/);
  assert.match(rerun, /SET state = 'ASSET_GENERATING'/);
  assert.match(advance, /signal\.signal_kind = 'ASSET_RERUN_REQUESTED'/);
  assert.match(advance, /':artifact:assets:'[\s\S]*asset_rerun_signal_id/);
  assert.match(advance, /'assets-ready:' \|\| coalesce\(candidate\.asset_rerun_signal_id::text, 'initial'\)/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION deviludo\.request_asset_rerun\(uuid, uuid, text, jsonb\) TO deviludo_api/);

  const migration = await readFile(new URL("../infra/postgres/migrations/046_asset_rerun_continuation.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE OR REPLACE FUNCTION deviludo\.request_asset_rerun/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION deviludo\.advance_asset_workflows/);
  assert.match(migration, /REVOKE ALL ON FUNCTION deviludo\.request_asset_rerun\(uuid, uuid, text, jsonb\) FROM PUBLIC/);
});

test("image generation requires one explicit model through the selected Agent connection", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const table = sql.match(/CREATE TABLE deviludo\.instance_agent_settings \(([\s\S]*?)\n\);/)?.[1] ?? "";
  assert.match(table, /credential_secret_ref text NOT NULL/);
  assert.match(table, /LIKE 'vault:\/\/instance\/agent-runtime\/api-key\/versions\/%'/);
  assert.match(table, /api_key_mask text NOT NULL CHECK \(api_key_mask ~ '\^\.\{3\}\\\*\{8\}\.\{4\}\$'\)/);
  assert.match(table, /primary_model text NOT NULL CHECK/);
  assert.match(table, /model_overrides jsonb NOT NULL CHECK/);
  assert.doesNotMatch(table, /model_overrides->'image'/);
  assert.match(table, /image_model text CHECK \(image_model IS NULL/);
  assert.doesNotMatch(table, /opus_model|sonnet_model|haiku_model|subagent_model|role_models/);
  assert.doesNotMatch(table, /\bapi_key text\b|\bapi_key_value\b|\bsecret text\b/);
  assert.doesNotMatch(sql, /CREATE TABLE deviludo\.instance_image_generation_settings/);
  assert.match(table, /singleton boolean PRIMARY KEY DEFAULT true CHECK \(singleton\)/);
});

test("the unified Agent connection migration removes the independent image settings store", async () => {
  const migration = await readFile(new URL("../infra/postgres/migrations/040_unify_image_generation_with_agent_connection.sql", import.meta.url), "utf8");
  assert.match(migration, /ADD COLUMN image_model text/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS instance_agent_settings_runtime_models/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS instance_agent_settings_claude_provider_only/);
  assert.match(migration, /DROP TABLE deviludo\.instance_image_generation_settings/);
});

test("the primary-model migration removes obsolete Claude routes and folds image into role overrides", async () => {
  const migration = await readFile(new URL("../infra/postgres/migrations/043_primary_agent_model.sql", import.meta.url), "utf8");
  assert.match(migration, /ADD COLUMN model_overrides jsonb/);
  assert.match(migration, /'design'[\s\S]*'development'[\s\S]*'test'[\s\S]*'image'/);
  assert.match(migration, /DROP COLUMN opus_model[\s\S]*DROP COLUMN image_model/);
  assert.match(migration, /coalesce\(agent_settings\.model_overrides->>''development'', agent_settings\.primary_model\)/);
  assert.match(migration, /procedure\.prokind = 'f'/);
});

test("the explicit-image migration separates image generation from inheriting text models", async () => {
  const migration = await readFile(new URL("../infra/postgres/migrations/044_explicit_image_and_codex_models.sql", import.meta.url), "utf8");
  assert.match(migration, /ADD COLUMN image_model text/);
  assert.match(migration, /SET image_model = model_overrides->>'image'/);
  assert.match(migration, /model_overrides - ARRAY\['design', 'development', 'test'\]::text\[\] = '\{\}'::jsonb/);
  assert.doesNotMatch(migration, /model_overrides->'image'/);
});

test("E2E node preparation progress is durable and bounded", async () => {
  const [baseline, migration] = await Promise.all([
    readFile(sqlUrl, "utf8"),
    readFile(new URL("../infra/postgres/migrations/052_e2e_node_preparation_progress.sql", import.meta.url), "utf8"),
  ]);
  for (const column of [
    "preparation_state", "preparation_stage", "preparation_progress", "preparation_message", "preparation_updated_at",
  ]) {
    assert.match(baseline, new RegExp(`${column} `));
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(baseline, /preparation_progress BETWEEN 0 AND 100/);
  assert.match(baseline, /preparation_state IN \('PREPARING', 'READY', 'FAILED'\)/);
});
