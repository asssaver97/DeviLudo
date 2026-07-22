import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { PostgresControlPlaneWorkflowActionStore } from "../src/workflow-action-postgres";
import { PostgresWorkflowActionCompletionStore } from "../src/workflow-action-completion-postgres";
import { PostgresWorkflowSignalOutbox } from "../src/workflow-signal-outbox";

const actionRelations = [
  "delivery_cancellation_revocations", "workflow_control_actions",
] as const;

const completionRelations = [
  "agent_execution_operations", "agent_run_provider_failovers", "agent_runs", "approved_test_plan_bindings",
  "e2e_attempts", "evidence_bundles", "github_candidate_receipts", "immutable_revisions",
  "inference_provider_revisions", "inference_request_claims", "inference_run_authorizations",
  "spec_conversations", "spec_dialogue_operations", "steam_build_receipts", "steam_releases",
  "user_feedback_operations", "workflow_control_actions", "workflow_external_approval_receipts",
  "workflow_feedback_invalidations", "workflow_signal_outbox",
] as const;

test("Control-plane workflow readiness covers actions, completion authorities and the signal outbox", async () => {
  await assertProbe(actionRelations, (pool) => new PostgresControlPlaneWorkflowActionStore(pool).probe());
  await assertProbe(completionRelations, (pool) => new PostgresWorkflowActionCompletionStore(pool).probe());
  await assertProbe(["workflow_signal_outbox"], (pool) => new PostgresWorkflowSignalOutbox(pool).probe());
});

async function assertProbe(
  relations: readonly string[],
  probe: (pool: PostgresWorkflowPool) => Promise<void>,
): Promise<void> {
  for (const missing of [null, relations.at(-1)] as const) {
    let released = 0;
    const client: PostgresWorkflowClient = {
      async query<Row extends Record<string, unknown>>(statement: string) {
        for (const relation of relations) {
          assert.match(statement, new RegExp(`to_regclass\\('deviludo\\.${relation}'\\)`));
        }
        const row = Object.fromEntries(relations.map((relation) => [
          relation,
          relation === missing ? null : `deviludo.${relation}`,
        ]));
        return { rowCount: 1, rows: [row as unknown as Row] };
      },
      release() { released += 1; },
    };
    const result = probe({ async connect() { return client; } });
    if (missing) await assert.rejects(result, /schema is not ready/);
    else await result;
    assert.equal(released, 1);
  }
}
