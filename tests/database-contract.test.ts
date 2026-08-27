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
    "INTENT", "ANALYSIS", "DESIGN", "DEVELOPMENT", "TEST",
  ]);
  assert.deepEqual(enumValues(sql, "agent_container_state"), [
    "CREATING", "RUNNING", "PAUSING", "PAUSED", "COMPACTING", "DESTROYED", "STOPPED", "FAILED",
  ]);
  assert.deepEqual(enumValues(sql, "workflow_state"), [
    "DRAFT", "ANALYZING", "DESIGNING", "DEVELOPING", "BUILDING", "TEST_PLANNING",
    "TESTING", "RELEASE_APPROVAL_PENDING", "STEAM_PUBLISHING",
    "SUCCEEDED", "BLOCKED", "STOPPED", "FAILED", "CANCELLED",
  ]);
  assert.doesNotMatch(sql, /AGENT_GENERATION|PROJECT_DOCUMENT_MAINTENANCE|job_guidance_messages|repair_count < 5/);
  assert.doesNotMatch(sql, /superseded[\s\S]{0,400}state <> 'CANCELLED'/i);
});

test("the new durable model stores contexts, five sessions, turns, handoffs, plans and evidence", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  for (const table of [
    "project_contexts", "agent_containers", "agent_sessions", "agent_turns",
    "agent_tool_calls", "role_handoffs", "test_plans_v2", "platform_test_runs", "test_evidence",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE deviludo\\.${table}\\s*\\(`));
    assert.ok(sql.includes(`'${table}'`), `${table} must be covered by forced workspace RLS`);
  }
  assert.match(sql, /UNIQUE \(workspace_id, project_id, role, container_generation\)/);
  assert.match(sql, /active_turn_id uuid/);
  assert.match(sql, /mcp_token_hash text/);
  assert.match(sql, /fencing_token bigint/);
  assert.match(sql, /plan_sha256 text NOT NULL CHECK \(plan_sha256 ~ '\^sha256:/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, plan_id\) REFERENCES deviludo\.test_plans_v2/);
});

test("Runtime lifecycle claims exactly five-minute idle and thirty-minute paused thresholds", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const claim = functionSource(sql, "claim_agent_container_lifecycle");
  assert.match(claim, /p_idle_seconds/);
  assert.match(claim, /p_paused_seconds/);
  assert.match(claim, /FOR UPDATE SKIP LOCKED/);
  assert.match(claim, /NOT EXISTS \([\s\S]*agent_turns running_turn[\s\S]*state = 'RUNNING'/);
  assert.match(claim, /WHEN container\.state = 'PAUSED'[\s\S]*THEN 'DESTROY'/);
  assert.match(claim, /p_idle_seconds integer DEFAULT 300/);
  assert.match(claim, /p_paused_seconds integer DEFAULT 1800/);
});

test("Agent completion advances Design, Development and Test through one persistent path", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const complete = functionSource(sql, "complete_agent_turn_job");
  assert.match(complete, /role text;/);
  assert.match(complete, /purpose text;/);
  assert.match(complete, /role = 'DESIGN'/);
  assert.match(complete, /role = 'DEVELOPMENT'/);
  assert.match(complete, /assets_ready boolean;/);
  assert.match(complete, /item\.status NOT IN \('generated', 'uploaded', 'existing'\)/);
  assert.match(complete, /IF assets_ready THEN[\s\S]*state = 'BUILDING'[\s\S]*enqueue_job/);
  assert.match(complete, /jsonb_build_object\('targetPlatforms', workflow\.target_platforms\)/);
  assert.match(complete, /purpose = 'TEST_PLAN'/);
  assert.match(complete, /verdict := upper/);
  assert.match(complete, /'TEST_PLAN'[\s\S]*E2E_PLATFORM_RUN/);
  assert.match(complete, /ELSE[\s\S]*'testHandoff'/);
  assert.doesNotMatch(complete, /repair_count|max_attempts/);
});

test("asset readiness cannot overtake an active Development Agent turn", async () => {
  const sql = await readFile(sqlUrl, "utf8");
  const advance = functionSource(sql, "advance_asset_workflows");
  assert.match(advance, /source\.state = 'SUCCEEDED'/);
  assert.match(advance, /coalesce\(source\.payload->>'role', 'DEVELOPMENT'\) = 'DEVELOPMENT'/);
  assert.match(advance, /coalesce\(source\.payload->>'purpose', 'DEVELOPMENT'\) = 'DEVELOPMENT'/);
  assert.match(advance, /NOT EXISTS \([\s\S]*active_development\.state IN \('QUEUED', 'RUNNING', 'RETRY'\)[\s\S]*active_development\.payload->>'role'/);
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
  assert.match(fail, /position\('CONFIGURATION:' IN p_reason\)[\s\S]*position\('CREDENTIAL:' IN p_reason\)/);
  assert.match(fail, /state = 'BLOCKED'/);
  assert.match(fail, /'RETRY'::deviludo\.job_state/);
  assert.doesNotMatch(fail, /attempt >=|repair_count|max_attempts/);
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

test("schema migration permits only an exact development function refresh", async () => {
  const migration = await readFile(new URL("../scripts/migrate-postgres.mjs", import.meta.url), "utf8");
  const reset = await readFile(new URL("../scripts/reset-self-hosted-baseline.mjs", import.meta.url), "utf8");
  assert.match(migration, /const BASELINE = "003"/);
  assert.match(migration, /const COMPATIBILITY = "deviludo-persistent-multi-agent-v3"/);
  assert.match(migration, /const VERSION = "001_persistent_multi_agent"/);
  assert.match(migration, /DEVELOPMENT_FUNCTION_REFRESHES/);
  assert.match(migration, /process\.env\.NODE_ENV !== "development"/);
  assert.match(migration, /complete_agent_turn_job/);
  assert.match(migration, /advance_asset_workflows/);
  assert.match(migration, /complete_job/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION deviludo\.\$\{functionName\}/);
  assert.match(migration, /WHERE singleton = true AND source_digest = \$2/);
  assert.match(migration, /WHERE version = \$2 AND checksum = \$3/);
  assert.match(migration, /ledger\.rows\.length !== 1/);
  assert.match(migration, /ledger\.rows\[0\]\?\.checksum !== baselineDigest/);
  assert.match(migration, /INCOMPATIBLE_BASELINE_RESET_REQUIRED/);
  assert.doesNotMatch(migration, /readdir|migrationsUrl|migration\.source|ALTER TABLE|ALTER TYPE/);
  assert.match(reset, /DROP SCHEMA IF EXISTS deviludo CASCADE/);
  assert.match(reset, /deviludo\.kind=project-runtime/);
  assert.match(reset, /deviludo-runtime-/);
});

test("database smoke settings cover every persistent Agent role", async () => {
  const smoke = await readFile(new URL("../scripts/local-database-smoke.mjs", import.meta.url), "utf8");
  assert.match(smoke, /\{"intent":null,"analysis":null,"design":null,"development":null,"test":null\}/);
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
