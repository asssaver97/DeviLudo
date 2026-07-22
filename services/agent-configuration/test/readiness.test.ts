import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { PostgresAgentConfigurationStore } from "../src/postgres-store";

const tables = [
  "workflow_control_actions", "agent_configuration_resolutions", "immutable_revisions",
  "approved_test_plan_bindings", "runner_toolchain_revisions", "github_source_baseline_receipts",
  "admin_catalog_state", "agent_runs", "inference_run_authorizations", "agent_execution_operations",
  "evidence_bundles", "e2e_attempts", "inference_provider_revisions", "workflow_signal_outbox",
] as const;

test("Agent configuration readiness requires every relation used by development and repair locking", async () => {
  for (const missing of [null, "evidence_bundles", "workflow_signal_outbox"] as const) {
    let released = 0;
    const client: PostgresWorkflowClient = {
      async query<Row extends Record<string, unknown>>(sql: string) {
        for (const table of tables) assert.match(sql, new RegExp(`to_regclass\\('deviludo\\.${table}'\\)`));
        const row = Object.fromEntries(tables.map((table) => [table, table === missing ? null : `deviludo.${table}`]));
        return { rowCount: 1, rows: [row as Row] };
      },
      release() { released += 1; },
    };
    const pool: PostgresWorkflowPool = { async connect() { return client; } };
    const probe = new PostgresAgentConfigurationStore(pool).probe();
    if (missing) await assert.rejects(probe, /invalid/);
    else await probe;
    assert.equal(released, 1);
  }
});
