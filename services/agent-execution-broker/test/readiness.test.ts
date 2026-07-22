import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { PostgresAgentExecutionDispatch } from "../src/postgres-dispatch";
import { PostgresAgentExecutionOperations } from "../src/postgres-operations";
import { PostgresAgentDevelopmentWorkPackage } from "../src/postgres-work-package";

const operationTables = [
  "agent_execution_operations", "agent_runs", "inference_run_authorizations",
  "agent_run_provider_failovers", "inference_provider_revisions", "agent_execution_events",
] as const;

test("Agent execution Broker readiness requires its complete durable operation schema", async () => {
  await assertProbe(operationTables, (pool) => new PostgresAgentExecutionOperations(pool), "agent_execution_events");
});

test("Agent dispatch readiness requires the durable queue relation", async () => {
  await assertProbe(["agent_execution_operations"], (pool) => new PostgresAgentExecutionDispatch(pool), "agent_execution_operations");
});

test("Agent work-package readiness requires both immutable specification relations", async () => {
  await assertProbe(
    ["immutable_revisions", "approved_test_plan_bindings"],
    (pool) => new PostgresAgentDevelopmentWorkPackage(pool),
    "approved_test_plan_bindings",
  );
});

async function assertProbe(
  tables: readonly string[],
  build: (pool: PostgresWorkflowPool) => Readonly<{ probe(): Promise<void> }>,
  missingTable: string,
): Promise<void> {
  for (const missing of [null, missingTable]) {
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
    const probe = build(pool).probe();
    if (missing) await assert.rejects(probe, /invalid/);
    else await probe;
    assert.equal(released, 1);
  }
}
