import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../../runner-control/src/canonical";
import type { PostgresQueryResult, PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { PostgresFrozenTestPlanPort } from "../src/postgres-test-plan";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const specRevisionId = "33333333-3333-4333-8333-333333333333";
const planRevisionId = "44444444-4444-4444-8444-444444444444";
const payload = Object.freeze({
  schemaVersion: "deviludo.godot-test-plan.v2",
  engine: "godot-4",
  targetMatrix: ["linux"],
  requiredGodotVersion: "4.6.2-stable",
  timeouts: { importSeconds: 60, bootSeconds: 60, suiteSeconds: 300, exportSeconds: 600 },
  performance: { warmupFrames: 30, sampleFrames: 120, maximumAverageFrameMs: 16, maximumP95FrameMs: 32 },
  scenarios: [],
});
const bytes = Buffer.from(canonicalJson(payload), "utf8");
const testPlanDigest = createHash("sha256").update(bytes).digest("hex");

test("PostgreSQL test-plan reader returns only one approved spec-bound canonical payload under RLS", async () => {
  const fixture = readerFixture();
  assert.deepEqual(await fixture.reader.read(input()), bytes);
  assert.ok(fixture.sql.some((statement) => statement.includes("set_config('app.tenant_id'")));
  assert.ok(fixture.sql.some((statement) => statement.includes("spec.aggregate_type = 'GAME_SPEC'")));
  assert.ok(fixture.sql.some((statement) => statement.includes("plan.aggregate_type = 'TEST_PLAN'")));
  assert.deepEqual(fixture.queryValues, [tenantId, projectId, specRevisionId, testPlanDigest]);
  assert.equal(fixture.releases, 1);
});

test("PostgreSQL test-plan reader rejects missing binding, payload drift and receipt drift", async () => {
  await assert.rejects(readerFixture({ missing: true }).reader.read(input()), /frozen test plan/);
  await assert.rejects(readerFixture({ payload: { ...payload, engine: "other" } }).reader.read(input()), /frozen test plan/);
  await assert.rejects(readerFixture({ boundDigest: "f".repeat(64) }).reader.read(input()), /frozen test plan/);
  await assert.rejects(readerFixture().reader.read({ ...input(), specRevisionId: "not-a-uuid" }), /frozen test plan/);
});

function input() {
  return { tenantId, projectId, specRevisionId, testPlanDigest };
}

function readerFixture(options: {
  readonly missing?: boolean;
  readonly payload?: unknown;
  readonly boundDigest?: string;
} = {}) {
  const sql: string[] = [];
  let queryValues: readonly unknown[] = [];
  let releases = 0;
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(
      statement: string,
      values: readonly unknown[] = [],
    ): Promise<PostgresQueryResult<Row>> {
      sql.push(statement);
      if (statement.includes("FROM deviludo.approved_test_plan_bindings")) {
        queryValues = values;
        return {
          rowCount: options.missing ? 0 : 1,
          rows: options.missing ? [] : [{
            spec_revision_id: specRevisionId,
            spec_state: "APPROVED",
            plan_revision_id: planRevisionId,
            plan_state: "FROZEN",
            payload: options.payload ?? payload,
            payload_digest: testPlanDigest,
            bound_digest: options.boundDigest ?? testPlanDigest,
          } as unknown as Row],
        };
      }
      return { rowCount: null, rows: [] };
    },
    release() { releases += 1; },
  };
  const pool: PostgresWorkflowPool = { async connect() { return client; } };
  return {
    reader: new PostgresFrozenTestPlanPort(pool),
    sql,
    get queryValues() { return queryValues; },
    get releases() { return releases; },
  };
}
