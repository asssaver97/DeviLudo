import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import { PostgresSteamWorkflowOperationDispatch } from "../src/postgres-workflow-dispatch";
import { postgresReadinessResult } from "./postgres-readiness-fixture";

const tenantId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const operationKey = "workflow-job:33333333-3333-4333-8333-333333333333";
const requestDigest = "a".repeat(64);

class Client implements PostgresWorkflowClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  row: { id: string; tenant_id: string } | null = { id: operationId, tenant_id: tenantId };
  enqueueMatches = true;
  releases = 0;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ text, values });
    const readiness = postgresReadinessResult<Row>(text);
    if (readiness) return readiness;
    if (text.includes("SET enqueue_count")) {
      return this.enqueueMatches ? result([{ id: operationId }] as unknown as Row[]) : result([]);
    }
    if (text.includes("FOR UPDATE SKIP LOCKED")) {
      return this.row ? result([this.row] as unknown as Row[]) : result([]);
    }
    return result([]);
  }

  release(): void { this.releases += 1; }
}

test("PostgreSQL Steam dispatch durably re-enqueues one exact opaque operation under tenant RLS", async () => {
  const client = new Client();
  const dispatch = new PostgresSteamWorkflowOperationDispatch({ async connect() { return client; } });
  await dispatch.enqueue({ tenantId, operationId, operationKey, requestDigest });
  const update = client.calls.find((call) => call.text.includes("SET enqueue_count"));
  assert.ok(update);
  assert.deepEqual(update.values, [tenantId, operationId, operationKey, requestDigest]);
  assert.match(update.text, /available_at = CASE WHEN state = 'PENDING'/);
  assert.match(update.text, /GREATEST\(created_at, now\(\)\)/);
  assert.ok(client.calls.some((call) => call.text.includes("set_config('app.tenant_id'")));
  assert.doesNotMatch(JSON.stringify(client.calls), /request_payload|config\.vdf|password|steam.?guard/i);

  client.enqueueMatches = false;
  await assert.rejects(dispatch.enqueue({ tenantId, operationId, operationKey, requestDigest }), /dispatch is invalid/);
  assert.equal(client.calls.at(-1)?.text, "ROLLBACK");
});

test("PostgreSQL Steam dispatch polls only due or expired opaque operation identities", async () => {
  const client = new Client();
  const dispatch = new PostgresSteamWorkflowOperationDispatch({ async connect() { return client; } });
  assert.deepEqual(await dispatch.next(tenantId), { tenantId, operationId });
  const poll = client.calls.find((call) => call.text.includes("FOR UPDATE SKIP LOCKED"));
  assert.ok(poll);
  assert.match(poll.text, /available_at <= now\(\)/);
  assert.match(poll.text, /claim_expires_at <= now\(\)/);
  assert.doesNotMatch(poll.text, /request_payload|receipt|session|credential/i);
  client.row = null;
  assert.equal(await dispatch.next(tenantId), null);
  await dispatch.probe();
  assert.equal(client.releases, 3);
});

function result<Row extends Record<string, unknown>>(rows: Row[]): PostgresQueryResult<Row> {
  return { rows, rowCount: rows.length };
}
