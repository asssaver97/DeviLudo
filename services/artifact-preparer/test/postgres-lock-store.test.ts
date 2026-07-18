import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { runnerExecutionLockDigest, type RunnerExecutionLock } from "../../runner-control/src/execution-lock";
import { PostgresRunnerExecutionLockPort } from "../src/postgres-lock-store";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const executionLockId = "44444444-4444-4444-8444-444444444444";
const sha = (value: string) => value.repeat(64);

test("PostgreSQL execution-lock store persists once under tenant RLS and rejects conflicting replay", async () => {
  let row: Record<string, unknown> | null = null;
  const statements: string[] = [];
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
      statements.push(text);
      if (text.startsWith("INSERT INTO deviludo.runner_execution_locks")) {
        if (row) return { rowCount: 0, rows: [] };
        row = {
          id: executionLockId,
          tenant_id: values[0],
          project_id: values[1],
          run_id: values[2],
          lock_key: values[3],
          payload: JSON.parse(values[8] as string) as unknown,
          payload_digest: values[9],
        };
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("FROM deviludo.runner_execution_locks")) return { rowCount: 1, rows: [row as Row] };
      return { rowCount: null, rows: [] };
    },
    release() {},
  };
  const pool: PostgresWorkflowPool = { async connect() { return client; } };
  const store = new PostgresRunnerExecutionLockPort(pool);
  const payload = executionLock();
  const input = {
    tenantId,
    projectId,
    runId,
    lockKey: sha("1"),
    payload,
    payloadDigest: runnerExecutionLockDigest(payload),
  };
  assert.deepEqual(await store.persist(input), {
    executionLockId,
    payloadDigest: input.payloadDigest,
    created: true,
  });
  assert.deepEqual(await store.persist(input), {
    executionLockId,
    payloadDigest: input.payloadDigest,
    created: false,
  });
  assert.equal(statements.some((statement) => statement.includes("set_config('app.tenant_id'")), true);
  assert.equal(statements.some((statement) => statement.includes("ON CONFLICT (tenant_id, lock_key) DO NOTHING")), true);
  await assert.rejects(store.persist({
    ...input,
    payload: { ...payload, sourceDigest: sha("f") },
    payloadDigest: runnerExecutionLockDigest({ ...payload, sourceDigest: sha("f") }),
  }), /persistence is invalid/);
});

function executionLock(): RunnerExecutionLock {
  return {
    schemaVersion: "deviludo.runner-execution-lock.v1",
    tenantId,
    projectId,
    runId,
    mode: "CANDIDATE",
    commitSha: "a".repeat(40),
    sourceDigest: sha("2"),
    steamBuildId: null,
    specRevisionId: "55555555-5555-4555-8555-555555555555",
    specDigest: sha("3"),
    testPlanDigest: sha("4"),
    runnerToolchainRevisionId: "66666666-6666-4666-8666-666666666666",
    runnerToolchainDigest: sha("c"),
    targetMatrix: ["linux"],
    requiredGodotVersion: "4.6.2-stable",
    godotTestKitDigest: sha("5"),
    exportTemplates: { linux: sha("6") },
    buildManifestDigest: sha("7"),
    sbomDigest: sha("8"),
    vulnerabilityScanDigest: sha("9"),
    assetLicenseLedgerDigest: sha("a"),
    execution: {
      kind: "SOURCE_ARTIFACT",
      objectKey: `tenants/${tenantId}/projects/${projectId}/sources/${sha("b")}.tar.zst`,
      artifactDigest: sha("b"),
    },
    preparedAt: "2030-01-01T00:00:00.000Z",
  };
}
