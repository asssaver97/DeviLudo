import assert from "node:assert/strict";
import test from "node:test";
import type {
  PostgresQueryResult,
  PostgresWorkflowClient,
  PostgresWorkflowPool,
} from "../../temporal/src/postgres-inbox";
import { sha256Canonical } from "../src/canonical";
import { PostgresRunnerWorkflowPort } from "../src/postgres-workflow";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const evidenceId = "66666666-6666-4666-8666-666666666666";
const specRevisionId = "77777777-7777-4777-8777-777777777777";
const sha = (value: string) => value.repeat(64);
const commitSha = "a".repeat(40);
const sourceDigest = sha("b");
const specDigest = sha("c");
const testPlanDigest = sha("d");

const input = Object.freeze({
  operationKey: `workflow-job:${jobId}`,
  requestDigest: sha("e"),
  tenantId,
  projectId,
  workflowId: "delivery-001",
  runId,
  mode: "CANDIDATE" as const,
  commitSha,
  draftPullRequest: 91,
  steamBuildId: null,
  targetMatrix: Object.freeze(["linux"] as const),
  async heartbeat() { return "renewed"; },
});

function binding() {
  return {
    schemaVersion: "deviludo.e2e-attempt.v1",
    workflowId: input.workflowId,
    operationKey: input.operationKey,
    requestDigest: input.requestDigest,
    iterationId: "88888888-8888-4888-8888-888888888888",
    mode: input.mode,
    specRevisionId,
    specDigest,
    testPlanDigest,
    targetMatrix: ["linux"],
  };
}

function attempt(state: "QUEUED" | "RUNNING" | "PASSED" | "FAILED" = "QUEUED") {
  return {
    id: attemptId,
    run_id: runId,
    workflow_id: input.workflowId,
    workflow_operation_key: input.operationKey,
    workflow_request_digest: input.requestDigest,
    mode: input.mode,
    commit_sha: commitSha,
    source_digest: sourceDigest,
    binding: binding(),
    target_matrix: ["linux"],
    draft_pull_request: "91",
    steam_build_id: null,
    state,
    repair_prompt_id: state === "FAILED" ? "repair-prompt-001" : null,
    completed_at: state === "PASSED" || state === "FAILED" ? "2026-07-18T00:01:00.000Z" : null,
  };
}

function terminalRow(status: "PASSED" | "FAILED", digestOverride?: string) {
  const platformEvidence = [{
    platform: "linux",
    runnerId: "linux-runner-001",
    runnerCapabilityDigest: sha("1"),
    exportDigest: sha("2"),
    logsDigest: sha("3"),
    junitDigest: sha("4"),
    inputTimelineDigest: sha("5"),
    screenshotManifestDigest: sha("6"),
    videoManifestDigest: sha("7"),
    status,
  }];
  const core = {
    id: evidenceId,
    attemptId,
    specRevisionId,
    specDigest,
    testPlanDigest,
    commitSha,
    sourceDigest,
    targetMatrix: ["linux"],
    godotTestKitDigest: sha("8"),
    buildManifestDigest: sha("9"),
    sbomDigest: sha("a"),
    vulnerabilityScanDigest: sha("b"),
    assetLicenseLedgerDigest: sha("c"),
    platformEvidence,
    status,
    valid: true,
    createdAt: "2026-07-18T00:01:00.000Z",
  };
  const bundleDigest = digestOverride ?? sha256Canonical(core);
  return {
    ...attempt(status),
    evidence_id: evidenceId,
    evidence_commit_sha: commitSha,
    evidence_source_digest: sourceDigest,
    evidence_binding: {
      schemaVersion: "deviludo.evidence-binding.v1",
      attemptId,
      specRevisionId,
      specDigest,
      testPlanDigest,
      commitSha,
      sourceDigest,
      targetMatrix: ["linux"],
    },
    evidence_manifest: { ...core, bundleDigest },
    evidence_bundle_digest: bundleDigest,
    evidence_object_key: `tenants/${tenantId}/evidence/${bundleDigest}.json`,
    evidence_status: status,
    evidence_invalidated_at: null,
  };
}

class ScriptedClient implements PostgresWorkflowClient {
  readonly sql: string[] = [];
  releases = 0;
  polls = 0;
  constructor(
    readonly terminal: "PASSED" | "FAILED" = "PASSED",
    readonly tamperedDigest = false,
    readonly missingSource = false,
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.sql.push(text);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config('app.tenant_id'")) {
      return result([]);
    }
    if (text.includes("FROM deviludo.agent_runs") && text.includes("FOR UPDATE")) {
      assert.deepEqual(values, [tenantId, projectId, runId]);
      return result([{ iteration_id: binding().iterationId, configuration_lock: {
        specRevisionId, specDigest, testPlanDigest, targetMatrix: ["linux"],
      } }] as unknown as Row[]);
    }
    if (text.includes("FROM deviludo.github_candidate_receipts")) {
      return result((this.missingSource ? [] : [{ source_digest: sourceDigest, spec_revision_id: specRevisionId }]) as unknown as Row[]);
    }
    if (text.includes("INSERT INTO deviludo.e2e_attempts")) {
      assert.equal(values[8], input.operationKey);
      assert.equal(values[9], input.requestDigest);
      assert.equal(values[10], "CANDIDATE");
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("workflow_operation_key = $3") && !text.includes("LEFT JOIN")) {
      return result([attempt()] as unknown as Row[]);
    }
    if (text.includes("LEFT JOIN deviludo.evidence_bundles")) {
      this.polls += 1;
      if (this.polls === 1) return result([attempt("RUNNING")] as unknown as Row[]);
      return result([terminalRow(this.terminal, this.tamperedDigest ? sha("f") : undefined)] as unknown as Row[]);
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  release(): void { this.releases += 1; }
}

function result<Row extends Record<string, unknown>>(rows: readonly Row[]): PostgresQueryResult<Row> {
  return { rowCount: rows.length, rows };
}

function pool(client: ScriptedClient): PostgresWorkflowPool {
  return { async connect() { return client; } };
}

test("PostgreSQL Runner workflow schedules once, heartbeats and accepts only terminal content-bound evidence", async () => {
  const client = new ScriptedClient();
  let heartbeats = 0;
  let now = 0;
  const port = new PostgresRunnerWorkflowPort({
    pool: pool(client), pollIntervalMs: 250, maxWaitMs: 30_000,
    now: () => now,
    async pause(delay) { now += delay; },
  });
  const receipt = await port.execute({ ...input, async heartbeat() { heartbeats += 1; return "renewed"; } });
  assert.equal(receipt.status, "PASSED");
  assert.equal(receipt.attemptId, attemptId);
  assert.equal(receipt.evidenceBundleId, evidenceId);
  assert.equal(receipt.repairPromptId, null);
  assert.equal(heartbeats, 1);
  assert.equal(client.polls, 2);
  assert.ok(client.sql.some((sql) => sql.includes("ON CONFLICT (tenant_id, workflow_operation_key) DO NOTHING")));
  assert.ok(client.sql.some((sql) => sql.includes("set_config('app.tenant_id'")));
  assert.equal(client.releases, 3);
});

test("PostgreSQL Runner workflow exposes failed evidence only with its immutable repair prompt", async () => {
  const client = new ScriptedClient("FAILED");
  let now = 0;
  const port = new PostgresRunnerWorkflowPort({
    pool: pool(client), pollIntervalMs: 250, maxWaitMs: 30_000,
    now: () => now,
    async pause(delay) { now += delay; },
  });
  const receipt = await port.execute(input);
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.repairPromptId, "repair-prompt-001");
});

test("PostgreSQL Runner workflow fails closed on a tampered bundle digest", async () => {
  const client = new ScriptedClient("PASSED", true);
  let now = 0;
  const port = new PostgresRunnerWorkflowPort({
    pool: pool(client), pollIntervalMs: 250, maxWaitMs: 30_000,
    now: () => now,
    async pause(delay) { now += delay; },
  });
  await assert.rejects(port.execute(input), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "E2E_EVIDENCE_DIGEST_INVALID");
    return true;
  });
});

test("PostgreSQL Runner workflow does not invent a source digest when the authoritative SCM receipt is absent", async () => {
  const client = new ScriptedClient("PASSED", false, true);
  const port = new PostgresRunnerWorkflowPort({ pool: pool(client) });
  await assert.rejects(port.execute(input), /GitHub candidate source receipt is not available/);
  assert.equal(client.polls, 0);
  assert.ok(client.sql.includes("ROLLBACK"));
});
