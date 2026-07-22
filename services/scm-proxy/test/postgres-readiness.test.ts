import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { PostgresCandidatePublicationStore } from "../src/postgres-candidate-publication";
import { PostgresScmMergeStore } from "../src/postgres-merge";
import { PostgresScmOperationStore } from "../src/postgres-operation-store";
import { PostgresSourceSnapshotAuthority } from "../src/postgres-source-snapshot-authority";
import { PostgresSourceBaselineStore } from "../src/source-baseline-postgres";

test("candidate publication readiness requires run, baseline, repository and receipt authority", async () => {
  await assertProbe([
    "agent_runs", "github_source_baseline_receipts", "github_repository_bindings",
    "github_installations", "github_candidate_receipts",
  ], (pool) => new PostgresCandidatePublicationStore(pool));
});

test("SCM operation readiness requires the durable external-side-effect claim ledger", async () => {
  await assertProbe(["scm_operation_claims"], (pool) => new PostgresScmOperationStore(pool));
});

test("accepted-candidate merge readiness requires the complete acceptance and evidence authority", async () => {
  await assertProbe([
    "workflow_command_jobs", "user_candidate_acceptances", "workflow_control_actions",
    "workflow_signal_outbox", "github_candidate_receipts", "github_repository_bindings",
    "github_installations", "evidence_bundles", "e2e_attempts", "immutable_revisions",
    "github_merge_receipts",
  ], (pool) => new PostgresScmMergeStore(pool));
});

test("source baseline readiness requires approved specification and repository authority", async () => {
  await assertProbe([
    "github_source_baseline_operations", "github_source_baseline_receipts",
    "github_repository_bindings", "github_installations", "immutable_revisions",
    "approved_test_plan_bindings", "spec_dialogue_operations",
  ], (pool) => new PostgresSourceBaselineStore(pool));
});

test("source snapshot readiness requires baseline, candidate and merged-main receipt authority", async () => {
  await assertProbe([
    "github_candidate_receipts", "github_repository_bindings", "github_installations",
    "agent_runs", "github_source_baseline_receipts", "github_merge_receipts",
  ], (pool) => new PostgresSourceSnapshotAuthority(pool));
});

async function assertProbe(
  tables: readonly string[],
  build: (pool: PostgresWorkflowPool) => Readonly<{ probe(): Promise<void> }>,
): Promise<void> {
  for (const missing of [null, tables.at(-1)!]) {
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
    if (missing) await assert.rejects(probe);
    else await probe;
    assert.equal(released, 1);
  }
}
