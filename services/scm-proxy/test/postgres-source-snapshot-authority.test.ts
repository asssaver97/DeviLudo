import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { PostgresSourceSnapshotAuthority } from "../src/postgres-source-snapshot-authority";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const commitSha = "c".repeat(40);
const sourceDigest = "d".repeat(64);

test("PostgreSQL source authority resolves a candidate receipt and active GitHub binding under RLS", async () => {
  const fixture = authorityFixture();
  const result = await fixture.authority.resolve(input("CANDIDATE"));
  assert.deepEqual(result, {
    binding: {
      tenantId,
      projectId,
      installationId: "123456",
      repositoryId: 991,
      repositoryNodeId: "R_repo991",
      owner: "north-dock-studio",
      name: "ember-archipelago",
      defaultBranch: "main",
    },
    sourceDigest,
  });
  assert.ok(fixture.sql.some((statement) => statement.includes("set_config('app.tenant_id'")));
  assert.ok(fixture.sql.some((statement) => statement.includes("github_candidate_receipts candidate")));
  assert.ok(fixture.sql.some((statement) => statement.includes("installation.status = 'ACTIVE'")));
  assert.deepEqual(fixture.queryValues, [tenantId, projectId, runId, commitSha, sourceDigest]);
  assert.equal(fixture.releases, 1);
});

test("PostgreSQL source authority uses the fresh merged-main digest for release gates", async () => {
  const fixture = authorityFixture();
  await fixture.authority.resolve(input("MAIN_RELEASE_GATE"));
  const query = fixture.sql.find((statement) => statement.includes("github_merge_receipts merge")) ?? "";
  assert.match(query, /merge\.default_branch_head_sha = \$4/);
  assert.match(query, /merge\.main_source_digest = \$5/);
  assert.doesNotMatch(query, /candidate\.source_digest AS source_digest/);
});

test("PostgreSQL source authority materializes only the AgentRun's locked baseline", async () => {
  const fixture = authorityFixture();
  await fixture.authority.resolve(input("AGENT_BASELINE"));
  const query = fixture.sql.find((statement) => statement.includes("github_source_baseline_receipts baseline")) ?? "";
  assert.match(query, /baseline\.id = run\.source_baseline_receipt_id/);
  assert.match(query, /baseline\.commit_sha = \$4/);
  assert.deepEqual(fixture.queryValues, [tenantId, projectId, runId, commitSha, sourceDigest]);
});

test("PostgreSQL source authority rejects missing, cross-binding and malformed receipts", async () => {
  await assert.rejects(authorityFixture({ missing: true }).authority.resolve(input("CANDIDATE")), /authority receipt/);
  await assert.rejects(authorityFixture({ row: { project_id: "44444444-4444-4444-8444-444444444444" } })
    .authority.resolve(input("CANDIDATE")), /authority receipt/);
  await assert.rejects(authorityFixture({ row: { source_digest: "f".repeat(64) } })
    .authority.resolve(input("CANDIDATE")), /authority receipt/);
  await assert.rejects(authorityFixture({ row: { repository_id: "9007199254740992" } })
    .authority.resolve(input("CANDIDATE")), /authority receipt/);
  await assert.rejects(authorityFixture().authority.resolve({ ...input("CANDIDATE"), commitSha: "invalid" }), /authority receipt/);
});

test("PostgreSQL source authority readiness probe releases its connection", async () => {
  const fixture = authorityFixture();
  await fixture.authority.probe();
  assert.ok(fixture.sql.includes("SELECT 1 AS ready"));
  assert.equal(fixture.releases, 1);
});

function input(mode: "AGENT_BASELINE" | "CANDIDATE" | "MAIN_RELEASE_GATE") {
  return { tenantId, projectId, runId, mode, commitSha, sourceDigest };
}

function authorityFixture(options: {
  readonly missing?: boolean;
  readonly row?: Readonly<Record<string, unknown>>;
} = {}) {
  const sql: string[] = [];
  let queryValues: readonly unknown[] = [];
  let releases = 0;
  const row = {
    tenant_id: tenantId,
    project_id: projectId,
    installation_id: "123456",
    repository_id: "991",
    repository_node_id: "R_repo991",
    owner_name: "north-dock-studio",
    repository_name: "ember-archipelago",
    default_branch: "main",
    source_digest: sourceDigest,
    ...options.row,
  };
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(
      statement: string,
      values: readonly unknown[] = [],
    ): Promise<PostgresQueryResult<Row>> {
      sql.push(statement);
      if (statement === "SELECT 1 AS ready") return { rowCount: 1, rows: [{ ready: 1 } as unknown as Row] };
      if (statement.includes("github_candidate_receipts candidate") || statement.includes("github_merge_receipts merge")
        || statement.includes("github_source_baseline_receipts baseline")) {
        queryValues = values;
        return { rowCount: options.missing ? 0 : 1, rows: options.missing ? [] : [row as unknown as Row] };
      }
      return { rowCount: null, rows: [] };
    },
    release() { releases += 1; },
  };
  const pool: PostgresWorkflowPool = { async connect() { return client; } };
  return {
    authority: new PostgresSourceSnapshotAuthority(pool),
    sql,
    get queryValues() { return queryValues; },
    get releases() { return releases; },
  };
}
