import assert from "node:assert/strict";
import test from "node:test";
import { DevelopmentAgentSupplyChain } from "../../control-plane/src/agent-supply-chain";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { AgentVersionDiscoveryRequest } from "../src/contracts";
import { agentSupplyChainPayloadDigest } from "../src/request-contract";
import { PostgresAgentSupplyChainOperations } from "../src/postgres-operations";

test("PostgreSQL Agent supply-chain operations fence, complete and replay one exact receipt", async () => {
  const request: AgentVersionDiscoveryRequest = Object.freeze({
    schemaVersion: "deviludo.agent-version-discovery-request.v1",
    operationKey: "a".repeat(64),
    requestDigest: "b".repeat(64),
    agent: "codex-cli",
    requestedVersion: "0.92.0",
  });
  const implementation = new DevelopmentAgentSupplyChain(() => new Date("2026-07-18T08:00:00.000Z"));
  const response = Object.freeze({
    schemaVersion: "deviludo.agent-version-discovery-receipt.v1" as const,
    candidates: await implementation.discover(request),
  });
  let row: Record<string, unknown> | null = null;
  const statements: string[] = [];
  let releases = 0;
  const client = {
    async query(text: string, values: readonly unknown[] = []) {
      statements.push(text);
      if (text.includes("INSERT INTO deviludo.agent_supply_chain_operations") && row === null) {
        row = {
          operation_key: values[0], request_digest: values[1], kind: values[2], payload_digest: values[3],
          request_payload: JSON.parse(String(values[4])), state: "PENDING", claim_token: null,
          claim_expires_at: null, attempt_count: 0, response_payload: null, response_digest: null,
          created_at: values[5], updated_at: values[5], completed_at: null,
        };
        return result([], 1);
      }
      if (text.includes("FOR UPDATE")) return result(row ? [row] : [], row ? 1 : 0);
      if (text.includes("SET state = 'RUNNING'")) {
        assert.ok(row);
        row.state = "RUNNING";
        row.claim_token = values[1];
        row.claim_expires_at = values[2];
        row.attempt_count = Number(row.attempt_count) + 1;
        row.updated_at = values[3];
        return result([{ attempt_count: row.attempt_count }], 1);
      }
      if (text.includes("SET state = 'COMPLETED'")) {
        assert.ok(row);
        assert.equal(row.claim_token, values[1]);
        row.state = "COMPLETED";
        row.claim_token = null;
        row.claim_expires_at = null;
        row.response_payload = JSON.parse(String(values[2]));
        row.response_digest = values[3];
        row.completed_at = values[4];
        row.updated_at = values[4];
        return result([], 1);
      }
      return result([], 0);
    },
    release() { releases += 1; },
  };
  const operations = new PostgresAgentSupplyChainOperations({ async connect() { return client; } } as unknown as PostgresWorkflowPool);
  const claimed = await operations.claim({
    operationKey: request.operationKey,
    requestDigest: request.requestDigest,
    kind: "DISCOVER",
    payloadDigest: agentSupplyChainPayloadDigest(request),
    request,
    claimToken: "11111111-1111-4111-8111-111111111111",
    claimedAt: "2026-07-18T08:00:00.000Z",
    claimExpiresAt: "2026-07-18T08:10:00.000Z",
  });
  assert.deepEqual(claimed, { kind: "ACQUIRED", attempt: 1 });
  await operations.complete({
    operationKey: request.operationKey,
    claimToken: "11111111-1111-4111-8111-111111111111",
    response,
    responseDigest: sha256Canonical(response),
    completedAt: "2026-07-18T08:01:00.000Z",
  });
  const replay = await operations.claim({
    operationKey: request.operationKey,
    requestDigest: request.requestDigest,
    kind: "DISCOVER",
    payloadDigest: agentSupplyChainPayloadDigest(request),
    request,
    claimToken: "22222222-2222-4222-8222-222222222222",
    claimedAt: "2026-07-18T08:02:00.000Z",
    claimExpiresAt: "2026-07-18T08:10:00.000Z",
  });
  assert.equal(replay.kind, "REPLAY");
  if (replay.kind === "REPLAY") assert.deepEqual(replay.response, response);
  assert.equal(statements.some((statement) => statement.includes("FOR UPDATE")), true);
  assert.equal(statements.includes("ROLLBACK"), false);
  assert.equal(releases, 3);
});

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length) {
  return Object.freeze({ rows: Object.freeze(rows), rowCount });
}
