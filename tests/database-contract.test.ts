import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sqlUrl = new URL("../infra/postgres/001_core.sql", import.meta.url);

test("fresh baseline exposes only the persistent multi-Agent workflow contract", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  assert.match(sql, /VALUES \(true, '003', 'deviludo-persistent-multi-agent-v3', '001_persistent_multi_agent'\)/);
  assert.deepEqual(enumValues(sql, "job_kind"), [
    "AGENT_TURN", "BUILD", "E2E_PLATFORM_RUN", "STEAM_PUBLISH",
  ]);
  assert.deepEqual(enumValues(sql, "agent_role"), [
    "INTENT", "ANALYSIS", "DESIGN", "UI_DESIGN", "DEVELOPMENT", "TEST", "PUBLISHING",
  ]);
  assert.deepEqual(enumValues(sql, "agent_container_state"), [
    "CREATING", "RUNNING", "PAUSING", "PAUSED", "COMPACTING", "DESTROYED", "STOPPED", "FAILED",
  ]);
  assert.deepEqual(enumValues(sql, "workflow_state"), [
    "DRAFT", "ANALYZING", "DESIGNING", "UI_DESIGNING", "DEVELOPING", "BUILDING", "TEST_PLANNING",
    "TESTING", "RELEASE_APPROVAL_PENDING", "STEAM_PREPARING", "STEAM_PUBLISHING",
    "SUCCEEDED", "BLOCKED", "STOPPED", "FAILED", "CANCELLED",
  ]);
  assert.doesNotMatch(sql, /AGENT_GENERATION|PROJECT_DOCUMENT_MAINTENANCE|job_guidance_messages|repair_count < 5/);
  assert.doesNotMatch(sql, /superseded[\s\S]{0,400}state <> 'CANCELLED'/i);
});

test("the new durable model stores contexts, seven sessions, turns, handoffs, plans and evidence", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  for (const table of [
    "project_contexts", "agent_containers", "agent_sessions", "agent_turns",
    "agent_tool_calls", "role_handoffs", "test_plans_v2", "platform_test_runs", "test_evidence",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE deviludo\\.${table}\\s*\\(`));
    assert.ok(sql.includes(`'${table}'`), `${table} must be covered by forced workspace RLS`);
  }
  assert.match(sql, /UNIQUE \(workspace_id, project_id, role, container_generation\)/);
  assert.match(sql, /jsonb_typeof\(content->'uiDesign'\) = 'string'/);
  assert.match(sql, /active_turn_id uuid/);
  assert.match(sql, /mcp_token_hash text/);
  assert.match(sql, /fencing_token bigint/);
  assert.match(sql, /plan_sha256 text NOT NULL CHECK \(plan_sha256 ~ '\^sha256:/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, plan_id\) REFERENCES deviludo\.test_plans_v2/);
});

test("Steam preparation is workspace-isolated and gates SteamPipe behind a verified Save receipt", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  for (const table of ["steam_delivery_preparations", "steam_store_assets"]) {
    assert.match(sql, new RegExp(`CREATE TABLE deviludo\\.${table}\\s*\\(`));
    assert.ok(sql.includes(`'${table}'`), `${table} must be covered by forced workspace RLS`);
  }
  assert.deepEqual(enumValues(sql, "steam_release_state"), [
    "PREPARING", "UPLOADING", "FAILED", "LIVE_TEST", "AWAITING_DEFAULT_PROMOTION", "LIVE_DEFAULT",
  ]);
  const approved = functionSource(sql, "accept_workflow_signal");
  assert.match(approved, /state = 'STEAM_PREPARING'/);
  assert.match(approved, /'role', 'PUBLISHING', 'purpose', 'PUBLISHING'/);
  assert.match(approved, /e2e_job\.payload->>'sourceRevision'.*preparation_source_revision/);
  assert.doesNotMatch(approved, /publishing:approved:[\s\S]{0,1000}'STEAM_PUBLISH'/);
  const claimed = functionSource(sql, "claim_steam_preparation");
  assert.match(claimed, /state IN \('GENERATING_ASSETS', 'SYNCING'\)/);
  assert.match(claimed, /workflow\.state = 'STEAM_PREPARING'/);
  const completed = functionSource(sql, "complete_steam_preparation");
  assert.match(completed, /p_receipt->>'action'.*'SAVE'/);
  assert.match(completed, /state = 'SAVED'/);
  assert.match(completed, /state = 'STEAM_PUBLISHING'/);
  assert.match(completed, /GET DIAGNOSTICS changed = ROW_COUNT;[\s\S]*IF changed <> 1 THEN RETURN false/);
  assert.match(completed, /'STEAM_PUBLISH'/);
  const failed = functionSource(sql, "fail_steam_preparation");
  assert.match(failed, /failure_stage = 'STEAM_PREPARATION'/);
  assert.match(failed, /id = p_workflow_id AND state = 'STEAM_PREPARING'/);
  const failedJob = functionSource(sql, "fail_job");
  assert.match(failedJob, /job\.payload->>'role' = 'PUBLISHING'[\s\S]*failure_stage = 'STEAM_PREPARATION'/);
  assert.match(sql, /failure_stage = 'STEAM_PUBLISH'/);
});

test("Runtime lifecycle claims exactly five-minute idle and thirty-minute paused thresholds", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const claim = functionSource(sql, "claim_agent_container_lifecycle");
  assert.match(claim, /p_idle_seconds/);
  assert.match(claim, /p_paused_seconds/);
  assert.match(claim, /FOR UPDATE SKIP LOCKED/);
  assert.match(claim, /NOT EXISTS \([\s\S]*agent_turns running_turn[\s\S]*state = 'RUNNING'/);
  assert.match(claim, /NOT EXISTS \([\s\S]*jobs running_test[\s\S]*kind = 'E2E_PLATFORM_RUN'[\s\S]*state = 'RUNNING'/);
  assert.match(claim, /WHEN container\.state = 'PAUSED'[\s\S]*THEN 'DESTROY'/);
  assert.match(claim, /p_idle_seconds integer DEFAULT 300/);
  assert.match(claim, /p_paused_seconds integer DEFAULT 1800/);
});

test("Agent completion advances Design, UI Design, Development and Test through one persistent path", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const complete = functionSource(sql, "complete_agent_turn_job");
  assert.match(complete, /role text;/);
  assert.match(complete, /purpose text;/);
  assert.match(complete, /role = 'DESIGN'/);
  assert.match(complete, /jsonb_typeof\(p_output->'handoff'\) IS DISTINCT FROM 'object'/);
  assert.match(complete, /handoff,toRole.*IS DISTINCT FROM 'UI_DESIGN'/);
  assert.match(complete, /Design Agent did not create a complete UI_DESIGN handoff/);
  assert.match(complete, /role = 'UI_DESIGN'/);
  assert.match(complete, /UI Design Agent did not create a complete DEVELOPMENT handoff/);
  assert.match(complete, /role = 'DEVELOPMENT'/);
  assert.match(complete, /assets_ready boolean;/);
  assert.match(complete, /item\.status NOT IN \('generated', 'uploaded', 'existing'\)/);
  assert.match(complete, /IF assets_ready THEN[\s\S]*state = 'BUILDING'[\s\S]*enqueue_job/);
  assert.match(complete, /jsonb_build_object\('targetPlatforms', workflow\.target_platforms\)/);
  assert.match(complete, /purpose = 'TEST_PLAN'/);
  assert.match(complete, /current_test_plan_available boolean/);
  assert.match(complete, /Test Agent did not persist the complete current-source plan or a DEVELOPMENT source-contract handoff/);
  assert.match(complete, /development:test-plan-handoff:/);
  assert.match(complete, /verdict := upper/);
  assert.match(complete, /failure_class = 'CONFIGURATION'/);
  assert.match(complete, /verdict := 'REPLAN'/);
  assert.match(complete, /ELSIF verdict = 'REPLAN' THEN/);
  assert.doesNotMatch(complete, /verdict = 'REPLAN' AND configuration_failed/);
  assert.match(complete, /test-replan:plan:/);
  assert.match(complete, /'TEST_PLAN'[\s\S]*E2E_PLATFORM_RUN/);
  assert.match(complete, /:e2e:[\s\S]*:source:[\s\S]*p_output->>'sourceRevision'[\s\S]*:plan:/);
  assert.match(complete, /verdict = 'FAIL'[\s\S]*'testHandoff'/);
  assert.doesNotMatch(complete, /repair_count|max_attempts/);
});

test("a blocked workflow can be reopened from an explicitly selected rerun stage", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const signal = functionSource(sql, "accept_workflow_signal");
  assert.match(signal, /workflow\.state NOT IN \('RELEASE_APPROVAL_PENDING', 'BLOCKED', 'FAILED', 'SUCCEEDED', 'CANCELLED'\)/);
  assert.match(signal, /current_test_plan_available boolean := false/);
  assert.match(signal, /plan\.source_revision = \([\s\S]*ORDER BY source\.revision DESC[\s\S]*LIMIT 1/);
  assert.match(signal, /WHEN rerun_stage = 'E2E_PLATFORM_RUN' AND NOT current_test_plan_available[\s\S]*THEN 'TEST_PLANNING'/);
  assert.match(signal, /rerun_agent_role NOT IN \('DESIGN', 'UI_DESIGN', 'DEVELOPMENT'\)/);
  assert.match(signal, /WHEN 'UI_DESIGN' THEN 'UI_DESIGNING'/);
  assert.match(signal, /ELSE 'DEVELOPING'/);
  assert.match(signal, /jsonb_build_object\('role', 'TEST', 'purpose', 'TEST_PLAN', 'manualRerun', true\)/);
  assert.match(signal, /'role', rerun_agent_role,[\s\S]*'purpose', rerun_agent_role/);
  assert.match(signal, /WHEN 'UI_DESIGN' THEN 'uiDesign'/);
});

test("workflow cancellation releases the persistent Agent turn before rerun", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const signal = functionSource(sql, "accept_workflow_signal");
  assert.match(signal, /CANCEL_REQUESTED[\s\S]*UPDATE deviludo\.agent_turns turn_row[\s\S]*state = 'CANCELLED'/);
  assert.match(signal, /UPDATE deviludo\.agent_sessions session[\s\S]*active_turn_id = NULL/);
  assert.match(signal, /turn_row\.output_summary = 'workflow-job:' \|\| job\.id::text/);
});

test("completed UI Design, Development and Test Agent turns publish durable player-facing messages", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const publish = functionSource(sql, "publish_development_agent_message");
  assert.match(publish, /IN \('UI_DESIGN', 'DEVELOPMENT', 'TEST'\)/);
  assert.match(publish, /turn_output->>'role' IS DISTINCT FROM agent_role/);
  assert.match(publish, /'agentRole', agent_role/);
  assert.match(publish, /WHEN 'TEST' THEN 'DeviLudo Test Agent'/);
  assert.match(publish, /WHEN 'UI_DESIGN' THEN 'DeviLudo UI Design Agent'/);
  assert.match(publish, /'planRevision', turn_output->'planRevision'/);
  assert.match(publish, /'verdict', turn_output->'verdict'/);
});

test("asset readiness cannot overtake an active Development Agent turn", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const advance = functionSource(sql, "advance_asset_workflows");
  const complete = functionSource(sql, "complete_agent_turn_job");
  assert.match(advance, /source\.state = 'SUCCEEDED'/);
  assert.match(advance, /coalesce\(source\.payload->>'role', 'DEVELOPMENT'\) = 'DEVELOPMENT'/);
  assert.match(advance, /coalesce\(source\.payload->>'purpose', 'DEVELOPMENT'\) = 'DEVELOPMENT'/);
  assert.match(advance, /NOT EXISTS \([\s\S]*active_development\.state IN \('QUEUED', 'RUNNING', 'RETRY'\)[\s\S]*active_development\.payload->>'role'/);
  assert.doesNotMatch(advance, /manifest\.auto_generate_enabled = false/);
  assert.doesNotMatch(complete, /manifest\.auto_generate_enabled = true/);
});

test("artifact builds fail closed while any planned visual asset is unresolved", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const snapshot = functionSource(sql, "snapshot_artifact_build_assets");
  assert.match(snapshot, /IF NEW\.kind <> 'BUILD' THEN RETURN NEW/);
  assert.match(snapshot, /item\.asset_type <> 'music'/);
  assert.match(snapshot, /item\.status NOT IN \('generated', 'uploaded', 'existing'\)/);
  assert.match(snapshot, /IF unresolved_assets > 0 THEN[\s\S]*RAISE EXCEPTION 'BUILD requires every planned visual asset to be supplied'/);
  assert.match(snapshot, /item\.status IN \('generated', 'uploaded'\)/);
});

test("music assets are upload-only and never enter image generation or block builds", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const claim = functionSource(sql, "claim_asset_generation");
  const rerun = functionSource(sql, "request_asset_rerun");
  const advance = functionSource(sql, "advance_asset_workflows");
  const complete = functionSource(sql, "complete_agent_turn_job");
  assert.match(sql, /asset_type IN \('sprite', 'animation', 'background', 'ui', 'icon', 'tileset', 'music'\)/);
  assert.match(sql, /asset_type <> 'music'[\s\S]*generation_prompt IS NULL/);
  assert.match(claim, /item\.asset_type <> 'music'/);
  assert.match(rerun, /item\.asset_type <> 'music'/);
  assert.match(advance, /item\.asset_type <> 'music'/);
  assert.match(complete, /item\.asset_type <> 'music'/);
});

test("Test Agent jobs are semantically deduplicated and retry storms terminate", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const enqueue = lastFunctionSource(sql, "enqueue_job");
  const claim = functionSource(sql, "claim_job");
  const fail = functionSource(sql, "fail_job");
  assert.match(enqueue, /pg_advisory_xact_lock/);
  assert.match(enqueue, /p_payload->>'role' = 'TEST'/);
  assert.match(enqueue, /candidate\.state IN \('QUEUED', 'RUNNING', 'RETRY'\)/);
  assert.match(claim, /superseded by canonical Test Agent turn/i);
  assert.match(claim, /exhausted_job\.attempt >= exhausted_job\.max_attempts/);
  assert.match(claim, /SET state = 'BLOCKED'/);
  assert.match(fail, /attempts_exhausted := NOT worker_interrupted AND job\.attempt >= job\.max_attempts/);
  assert.match(fail, /product_failure OR configuration_failure OR attempts_exhausted/);
});

test("worker restarts and expired leases do not consume workflow retry attempts", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const fail = functionSource(sql, "fail_job");
  const recover = functionSource(sql, "recover_expired_jobs");
  assert.match(fail, /worker_interrupted := position\('WORKER_INTERRUPTED:' IN p_reason\) = 1/);
  assert.match(fail, /attempt = CASE WHEN worker_interrupted THEN greatest\(job\.attempt - 1, 0\)/);
  assert.match(fail, /WHEN worker_interrupted THEN fencing_token \+ 1/);
  assert.match(fail, /IF worker_interrupted THEN\s+NULL;/);
  assert.match(recover, /attempt = greatest\(attempt - 1, 0\)/);
  assert.match(recover, /fencing_token = fencing_token \+ 1/);
});

test("Builder, platform tests and Steam are the only disposable job settlements", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const complete = functionSource(sql, "complete_job");
  assert.match(complete, /v_plan_id uuid;/);
  assert.doesNotMatch(complete, /\n  plan_id uuid;/);
  const fail = functionSource(sql, "fail_job");
  assert.match(complete, /AGENT_TURN must be settled by the persistent Project Runtime/);
  assert.match(complete, /job\.kind = 'BUILD'/);
  assert.match(complete, /state = 'BUILDING'[\s\S]*active_build\.state IN \('QUEUED', 'RUNNING', 'RETRY'\)[\s\S]*IF FOUND THEN[\s\S]*'TEST_PLAN'/);
  assert.match(complete, /job\.kind = 'E2E_PLATFORM_RUN'/);
  assert.match(complete, /job\.kind = 'STEAM_PUBLISH'/);
  assert.match(complete, /INSERT INTO deviludo\.platform_test_runs/);
  assert.match(complete, /INSERT INTO deviludo\.test_evidence/);
  assert.match(complete, /':test-verdict:e2e:' \|\| job\.id::text/);
  assert.doesNotMatch(complete, /':test-verdict:plan:' \|\| v_plan_id::text/);
  assert.match(fail, /position\('CONFIGURATION:' IN p_reason\)[\s\S]*position\('CREDENTIAL:' IN p_reason\)/);
  assert.match(fail, /state = 'BLOCKED'/);
  assert.match(fail, /attempts_exhausted/);
  assert.match(fail, /'RETRY'::deviludo\.job_state/);
  assert.doesNotMatch(fail, /repair_count/);
});

test("all target platforms must use the current source and frozen Test plan before PASS", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const completeAgent = functionSource(sql, "complete_agent_turn_job");
  const enqueue = lastFunctionSource(sql, "enqueue_job");
  assert.match(enqueue, /testPlanId/);
  assert.match(enqueue, /testPlanRevision/);
  assert.match(enqueue, /testPlanDigest/);
  assert.match(enqueue, /'testPlan', v_plan\.plan/);
  assert.match(completeAgent, /plan\.source_revision = \(p_output->>'sourceRevision'\)::bigint/);
  assert.match(completeAgent, /plan\.plan_revision = \(p_output->>'planRevision'\)::bigint/);
  assert.match(completeAgent, /run\.plan_id = verdict_plan_id/);
  assert.match(completeAgent, /run\.target_platform = required\.target_platform/);
  assert.match(completeAgent, /run\.verdict = 'PASS'/);
  assert.match(completeAgent, /PASS contradicts deterministic platform evidence/);
});

test("schema migration permits only exact reviewed development refreshes", async () => {
  const migration = await readFile(new URL("../scripts/migrate-postgres.mjs", import.meta.url), "utf8");
  const reset = await readFile(new URL("../scripts/reset-self-hosted-baseline.mjs", import.meta.url), "utf8");
  assert.match(migration, /const BASELINE = "003"/);
  assert.match(migration, /const COMPATIBILITY = "deviludo-persistent-multi-agent-v3"/);
  assert.match(migration, /const VERSION = "001_persistent_multi_agent"/);
  assert.match(migration, /DEVELOPMENT_FUNCTION_REFRESHES/);
  assert.match(migration, /DEVELOPMENT_SCHEMA_REFRESHES/);
  assert.match(migration, /process\.env\.NODE_ENV !== "development"/);
  assert.match(migration, /complete_agent_turn_job/);
  assert.match(migration, /advance_asset_workflows/);
  assert.match(migration, /complete_job/);
  assert.match(migration, /publish_development_agent_message/);
  assert.match(migration, /enqueue_job/);
  assert.match(migration, /claim_job/);
  assert.match(migration, /fail_job/);
  assert.match(migration, /claim_agent_container_lifecycle/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION deviludo\.\$\{functionName\}/);
  assert.match(migration, /WHERE singleton = true AND source_digest = \$2/);
  assert.match(migration, /WHERE version = \$2 AND checksum = \$3/);
  assert.match(migration, /ledger\.rows\.length !== 1/);
  assert.match(migration, /ledger\.rows\[0\]\?\.checksum !== baselineDigest/);
  assert.match(migration, /ALTER TYPE deviludo\.workflow_state ADD VALUE IF NOT EXISTS 'UI_DESIGNING' BEFORE 'DEVELOPING'/);
  assert.match(migration, /ALTER TYPE deviludo\.agent_role ADD VALUE IF NOT EXISTS 'UI_DESIGN' BEFORE 'DEVELOPMENT'/);
  assert.match(migration, /UPLOAD_ONLY_MUSIC_ASSETS/);
  assert.match(migration, /DROP CONSTRAINT asset_items_asset_type_check/);
  assert.match(migration, /ADD CONSTRAINT asset_items_music_upload_only/);
  assert.match(migration, /jsonb_set\(model_overrides, '\{uiDesign\}'/);
  assert.match(migration, /jsonb_set\(content, '\{uiDesign\}'/);
  assert.match(migration, /DROP CONSTRAINT project_documents_content_check/);
  assert.match(migration, /INCOMPATIBLE_BASELINE_RESET_REQUIRED/);
  assert.doesNotMatch(migration, /readdir|migrationsUrl|migration\.source/);
  assert.match(reset, /DROP SCHEMA IF EXISTS deviludo CASCADE/);
  assert.match(reset, /deviludo\.kind=project-runtime/);
  assert.match(reset, /deviludo-runtime-/);
});

test("database smoke settings cover every persistent Agent role", async () => {
  const smoke = await readFile(new URL("../scripts/local-database-smoke.mjs", import.meta.url), "utf8");
  assert.match(smoke, /\{"intent":null,"analysis":null,"design":null,"uiDesign":null,"development":null,"test":null\}/);
});

test("workspace-owned Runtime tables use forced row isolation and scoped foreign keys", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  assert.match(sql, /current_setting\('app\.workspace_id', true\)/);
  assert.match(sql, /ALTER TABLE deviludo\.workspaces FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, project_id\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, turn_id\)/);
  for (const role of ["api", "scheduler", "sandbox"]) {
    assert.match(sql, new RegExp(`CREATE ROLE deviludo_${role} NOLOGIN NOBYPASSRLS`));
  }
  assert.match(sql, /CREATE ROLE deviludo_claim_executor NOLOGIN BYPASSRLS/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON[\s\S]*deviludo\.project_contexts, deviludo\.agent_containers, deviludo\.agent_sessions,[\s\S]*deviludo\.test_plans_v2, deviludo\.platform_test_runs, deviludo\.test_evidence[\s\S]*TO deviludo_sandbox;/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON[\s\S]*deviludo\.project_contexts, deviludo\.agent_containers, deviludo\.agent_sessions,[\s\S]*TO deviludo_scheduler;/);
  assert.match(sql, /GRANT SELECT ON deviludo\.agent_turns TO deviludo_claim_executor;/);
  assert.match(sql, /deviludo\.implementation_change_requests,[\s\S]*deviludo\.project_contexts[\s\S]*TO deviludo_sandbox;/);
  assert.match(sql, /GRANT SELECT, INSERT ON deviludo\.project_cleanup_requests TO deviludo_api;/);
});

function enumValues(sql: string, name: string): string[] {
  const body = sql.match(new RegExp(`CREATE TYPE deviludo\\.${name} AS ENUM \\(([\\s\\S]*?)\\);`))?.[1] ?? "";
  return [...body.matchAll(/'([^']+)'/g)].map(match => match[1]!);
}

test("managed artifact retention records lifecycle state and queues only disposable outputs",async()=>{
  const sql=await readFile(sqlUrl,"utf8");
  assert.match(sql,/state text NOT NULL DEFAULT 'AVAILABLE'.*'DELETING'.*'DELETED'/s);
  assert.match(sql,/enqueue_expired_artifacts\([\s\S]*artifact\.kind IN \('BUILD', 'E2E_REPORT', 'SIGNED_BUILD', 'PUBLISH_RECEIPT', 'CLEAN_INSTALL_REPORT'\)/);
  assert.match(sql,/job\.state IN \('QUEUED', 'RUNNING', 'RETRY'\)/);
  assert.match(sql,/INSERT INTO deviludo\.object_cleanup_queue[\s\S]*artifact retention expired/);
  assert.match(sql,/complete_object_cleanup[\s\S]*SET state = 'DELETED'/);
});

test("authorized uploads are durably reconciled after terminal jobs", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  assert.match(sql, /CREATE TABLE deviludo\.pending_object_uploads/);
  assert.match(sql, /'pending_object_uploads'/);
  assert.match(sql, /artifacts_clear_pending_upload[\s\S]*AFTER INSERT ON deviludo\.artifacts/);
  assert.match(sql, /DELETE FROM deviludo\.pending_object_uploads[\s\S]*NEW\.object_key/);
  assert.match(sql, /reconcile_expired_uploads\([\s\S]*job\.state IN \('SUCCEEDED', 'FAILED', 'CANCELLED'\)/);
  assert.match(sql, /NOT EXISTS \([\s\S]*FROM deviludo\.artifacts artifact/);
  assert.match(sql, /authorized upload did not become an artifact/);
  assert.match(sql, /REVOKE ALL ON FUNCTION deviludo\.reconcile_expired_uploads\(integer\) FROM PUBLIC/);
});

function functionSource(sql: string, name: string): string {
  const matches = [...sql.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION deviludo\\.${name}\\([\\s\\S]*?\\$\\$;`, "g"))];
  assert.equal(matches.length, 1, `${name} must have exactly one implementation`);
  return matches[0]![0];
}

function lastFunctionSource(sql: string, name: string): string {
  const matches = [...sql.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION deviludo\\.${name}\\([\\s\\S]*?\\$\\$;`, "g"))];
  assert.ok(matches.length >= 1, `${name} must exist`);
  return matches.at(-1)![0];
}
