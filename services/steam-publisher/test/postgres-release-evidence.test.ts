import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import { PostgresSteamReleaseEvidenceGate } from "../src/postgres-release-evidence";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const evidenceId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const input = Object.freeze({
  tenantId, projectId, mainCommitSha: "a".repeat(40), sourceDigest: "b".repeat(64),
  specDigest: "c".repeat(64), testPlanDigest: "d".repeat(64), evidenceBundleDigest: "e".repeat(64),
  targetMatrix: Object.freeze(["linux", "windows"] as const),
});

function authorityRow() {
  const binding = { specDigest: input.specDigest, testPlanDigest: input.testPlanDigest, targetMatrix: input.targetMatrix };
  return {
    evidence_id: evidenceId, evidence_commit_sha: input.mainCommitSha,
    evidence_source_digest: input.sourceDigest, evidence_bundle_digest: input.evidenceBundleDigest,
    evidence_binding: binding,
    evidence_manifest: { ...binding, bundleDigest: input.evidenceBundleDigest, status: "PASSED", valid: true },
    evidence_status: "PASSED", evidence_invalidated_at: null,
    attempt_id: attemptId, attempt_commit_sha: input.mainCommitSha,
    attempt_source_digest: input.sourceDigest, attempt_binding: binding,
    attempt_target_matrix: input.targetMatrix, attempt_mode: "MAIN_RELEASE_GATE", attempt_state: "PASSED",
  };
}

test("PostgreSQL Steam evidence gate re-resolves one exact non-invalidated main matrix", async () => {
  const calls: string[] = [];
  const client = clientFor(authorityRow(), calls);
  const gate = new PostgresSteamReleaseEvidenceGate({ async connect() { return client; } });
  await gate.assertPassed(input);
  assert.equal(calls[0], "BEGIN");
  assert.match(calls[2] ?? "", /attempt\.mode = 'MAIN_RELEASE_GATE'/);
  assert.match(calls[2] ?? "", /evidence\.invalidated_at IS NULL/);
  assert.equal(calls.at(-1), "COMMIT");
  await gate.probe();

  for (const changed of [
    { evidence_invalidated_at: "2030-01-01T00:01:00.000Z" },
    { attempt_mode: "CANDIDATE" },
    { attempt_binding: { specDigest: "f".repeat(64), testPlanDigest: input.testPlanDigest, targetMatrix: input.targetMatrix } },
    { attempt_target_matrix: ["linux"] },
  ]) {
    const rejected = new PostgresSteamReleaseEvidenceGate({
      async connect() { return clientFor({ ...authorityRow(), ...changed }, []); },
    });
    await assert.rejects(rejected.assertPassed(input), /evidence gate is invalid/);
  }
});

function clientFor(row: Record<string, unknown>, calls: string[]): PostgresWorkflowClient {
  return {
    async query<Row extends Record<string, unknown>>(text: string): Promise<PostgresQueryResult<Row>> {
      calls.push(text);
      if (text.includes("FROM deviludo.evidence_bundles")) return { rows: [row as Row], rowCount: 1 };
      if (text === "SELECT 1 AS ready") return { rows: [{ ready: 1 } as unknown as Row], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
}
