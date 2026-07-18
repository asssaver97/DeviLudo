import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import type { SteamWorkflowOperationRequest } from "../src/workflow-broker-http";
import { PostgresSteamWorkflowOperationPersistence } from "../src/postgres-workflow-operations";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const firstToken = "55555555-5555-4555-8555-555555555555";
const secondToken = "66666666-6666-4666-8666-666666666666";
const evidenceId = "77777777-7777-4777-8777-777777777777";
const mfaId = "88888888-8888-4888-8888-888888888888";
const operationKey = "workflow-job:99999999-9999-4999-8999-999999999999";
const requestDigest = "a".repeat(64);
const submittedBy = "spiffe://deviludo.internal/temporal-steam-publisher";
const createdAt = "2030-01-01T00:00:00.000Z";
const request: SteamWorkflowOperationRequest = Object.freeze({
  schemaVersion: "deviludo.steam-workflow.v1",
  kind: "PRIVATE_BETA_UPLOAD",
  operationKey,
  requestDigest,
  tenantId,
  projectId,
  workflowId: "delivery-001",
  runId,
  mainCommitSha: "b".repeat(40),
  mainEvidenceBundleId: evidenceId,
  mfaApprovalId: mfaId,
  targetMatrix: Object.freeze(["linux"] as const),
});
const receipt = Object.freeze({
  receiptId: "steam-upload-receipt-001", runId, mainCommitSha: "b".repeat(40),
  mainEvidenceBundleId: evidenceId, mfaApprovalId: mfaId,
  targetMatrix: Object.freeze(["linux"] as const), buildId: "91234567",
});

type Row = {
  id: string; tenant_id: string; project_id: string; submitter_spiffe_id: string;
  workflow_id: string; run_id: string; kind: string; operation_key: string;
  request_digest: string; payload_digest: string; request_payload: unknown;
  state: string; claim_token: string | null; claim_expires_at: string | null;
  attempt_count: number; receipt: unknown | null; error_code: string | null;
  terminal: boolean | null; created_at: string; updated_at: string; completed_at: string | null;
  available_at: string; last_enqueued_at: string; enqueue_count: number;
};

class Client implements PostgresWorkflowClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  row: Row | null = null;
  releases = 0;

  async query<ResultRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<ResultRow>> {
    this.calls.push({ text, values });
    if (text.includes("INSERT INTO deviludo.steam_workflow_operations")) {
      if (this.row !== null) return result([], 0);
      this.row = {
        id: String(values[0]), tenant_id: String(values[1]), project_id: String(values[2]),
        submitter_spiffe_id: String(values[3]), workflow_id: String(values[4]), run_id: String(values[5]),
        kind: String(values[6]), operation_key: String(values[7]), request_digest: String(values[8]),
        payload_digest: String(values[9]), request_payload: JSON.parse(String(values[10])) as unknown,
        state: "PENDING", claim_token: null, claim_expires_at: null, attempt_count: 0,
        receipt: null, error_code: null, terminal: null,
        created_at: String(values[11]), updated_at: String(values[11]), completed_at: null,
        available_at: String(values[11]), last_enqueued_at: String(values[11]), enqueue_count: 1,
      };
      return result([], 1);
    }
    if (text.includes("FROM deviludo.steam_workflow_operations")) {
      if (!this.row || this.row.tenant_id !== values[0]) return result([]);
      const matches = text.includes("operation_key = $2")
        ? this.row.operation_key === values[1]
        : this.row.id === values[1];
      return matches ? result([this.row] as unknown as ResultRow[]) : result([]);
    }
    if (text.includes("SET state = 'RUNNING'")) {
      if (!this.row || this.row.tenant_id !== values[0] || this.row.id !== values[1]) return result([], 0);
      const claimedAt = Date.parse(String(values[4]));
      if (this.row.state === "RUNNING" && Date.parse(this.row.claim_expires_at as string) > claimedAt) return result([], 0);
      this.row.state = "RUNNING";
      this.row.claim_token = String(values[2]);
      this.row.claim_expires_at = String(values[3]);
      this.row.attempt_count += 1;
      this.row.updated_at = String(values[4]);
      return result([{ attempt_count: this.row.attempt_count }] as unknown as ResultRow[], 1);
    }
    if (text.includes("SET claim_expires_at")) {
      if (!this.row || this.row.state !== "RUNNING" || this.row.claim_token !== values[2]
        || Date.parse(this.row.claim_expires_at as string) <= Date.parse(String(values[3]))) return result([], 0);
      this.row.claim_expires_at = String(values[4]);
      this.row.updated_at = String(values[3]);
      return result([], 1);
    }
    if (text.includes("SET state = 'COMPLETED'")) {
      if (!this.activeClaim(values, String(values[4]))) return result([], 0);
      this.row!.state = "COMPLETED";
      this.row!.claim_token = null;
      this.row!.claim_expires_at = null;
      this.row!.receipt = JSON.parse(String(values[3])) as unknown;
      this.row!.completed_at = String(values[4]);
      this.row!.updated_at = String(values[4]);
      return result([], 1);
    }
    if (text.includes("SET state = 'FAILED'")) {
      if (!this.activeClaim(values, String(values[4]))) return result([], 0);
      this.row!.state = "FAILED";
      this.row!.claim_token = null;
      this.row!.claim_expires_at = null;
      this.row!.error_code = String(values[3]);
      this.row!.terminal = true;
      this.row!.completed_at = String(values[4]);
      this.row!.updated_at = String(values[4]);
      return result([], 1);
    }
    if (text.includes("SET state = 'PENDING'")) {
      if (!this.row || this.row.state !== "RUNNING" || this.row.claim_token !== values[2]) return result([], 0);
      this.row.state = "PENDING";
      this.row.claim_token = null;
      this.row.claim_expires_at = null;
      this.row.updated_at = String(values[3]);
      this.row.available_at = String(values[4]);
      return result([], 1);
    }
    if (text === "SELECT 1 AS ready") return result([{ ready: 1 }] as unknown as ResultRow[]);
    return result([]);
  }

  release(): void { this.releases += 1; }

  private activeClaim(values: readonly unknown[], completedAt: string): boolean {
    return Boolean(this.row && this.row.state === "RUNNING"
      && this.row.tenant_id === values[0] && this.row.id === values[1]
      && this.row.claim_token === values[2]
      && Date.parse(this.row.claim_expires_at as string) > Date.parse(completedAt));
  }
}

function store(client: Client) {
  return new PostgresSteamWorkflowOperationPersistence({ async connect() { return client; } });
}

test("PostgreSQL Steam workflow reserve is tenant-RLS scoped and replays one exact payload", async () => {
  const client = new Client();
  const operations = store(client);
  const input = { operationId, submitterSpiffeId: submittedBy, request, createdAt };
  const first = await operations.reserve(input);
  assert.equal(first.created, true);
  assert.equal(first.status.status, "RUNNING");
  assert.equal(first.status.operationId, operationId);
  assert.ok(client.calls.some((call) => call.text.includes("set_config('app.tenant_id'")));
  assert.match(client.calls.find((call) => call.text.includes("INSERT INTO"))!.text, /ON CONFLICT \(tenant_id, operation_key\) DO NOTHING/);

  const replay = await operations.reserve({ ...input, operationId: firstToken });
  assert.equal(replay.created, false);
  assert.equal(replay.status.operationId, operationId);
  assert.equal(client.row?.payload_digest.length, 64);
  assert.doesNotMatch(JSON.stringify(client.row), /config\.vdf|password|steam.?guard/i);

  await assert.rejects(operations.reserve({
    ...input, operationId: secondToken,
    request: { ...request, targetMatrix: ["windows"] },
  }), /persistence is invalid/);
  assert.equal(client.calls.at(-1)?.text, "ROLLBACK");
});

test("PostgreSQL Steam workflow lease heartbeats, fences duplicates and commits one receipt", async () => {
  const client = new Client();
  const operations = store(client);
  await operations.reserve({ operationId, submitterSpiffeId: submittedBy, request, createdAt });
  const claimed = await operations.claim({
    tenantId, operationId, claimToken: firstToken, claimedAt: createdAt,
    claimExpiresAt: "2030-01-01T00:05:00.000Z",
  });
  assert.equal(claimed.kind, "ACQUIRED");
  if (claimed.kind === "ACQUIRED") assert.equal(claimed.attempt, 1);
  assert.equal(client.row?.attempt_count, 1);
  const busy = await operations.claim({
    tenantId, operationId, claimToken: secondToken, claimedAt: "2030-01-01T00:01:00.000Z",
    claimExpiresAt: "2030-01-01T00:06:00.000Z",
  });
  assert.equal(busy.kind, "BUSY");
  await operations.heartbeat({
    tenantId, operationId, claimToken: firstToken, heartbeatAt: "2030-01-01T00:02:00.000Z",
    claimExpiresAt: "2030-01-01T00:07:00.000Z",
  });
  assert.equal(client.row?.claim_expires_at, "2030-01-01T00:07:00.000Z");
  const done = await operations.complete({
    tenantId, operationId, claimToken: firstToken, receipt,
    completedAt: "2030-01-01T00:03:00.000Z",
  });
  assert.equal(done.status, "COMPLETED");
  assert.equal(client.row?.state, "COMPLETED");
  assert.deepEqual(await operations.find({ tenantId, operationId, operationKey, requestDigest }), done);
  const terminal = await operations.claim({
    tenantId, operationId, claimToken: secondToken, claimedAt: "2030-01-01T00:08:00.000Z",
    claimExpiresAt: "2030-01-01T00:13:00.000Z",
  });
  assert.equal(terminal.kind, "TERMINAL");
  await operations.probe();
  assert.equal(client.releases, 8);
});

test("PostgreSQL Steam workflow reclaims only expired leases and rejects stale completion", async () => {
  const client = new Client();
  const operations = store(client);
  await operations.reserve({ operationId, submitterSpiffeId: submittedBy, request, createdAt });
  await operations.claim({
    tenantId, operationId, claimToken: firstToken, claimedAt: createdAt,
    claimExpiresAt: "2030-01-01T00:05:00.000Z",
  });
  const reclaimed = await operations.claim({
    tenantId, operationId, claimToken: secondToken, claimedAt: "2030-01-01T00:06:00.000Z",
    claimExpiresAt: "2030-01-01T00:11:00.000Z",
  });
  assert.equal(reclaimed.kind, "ACQUIRED");
  if (reclaimed.kind === "ACQUIRED") assert.equal(reclaimed.attempt, 2);
  assert.equal(client.row?.attempt_count, 2);
  await assert.rejects(operations.complete({
    tenantId, operationId, claimToken: firstToken, receipt,
    completedAt: "2030-01-01T00:07:00.000Z",
  }), /persistence is invalid/);
  await operations.release({
    tenantId, operationId, claimToken: secondToken, releasedAt: "2030-01-01T00:07:00.000Z",
    retryAt: "2030-01-01T00:07:05.000Z",
  });
  assert.equal(client.row?.state, "PENDING");
  assert.equal(client.row?.available_at, "2030-01-01T00:07:05.000Z");
  await operations.claim({
    tenantId, operationId, claimToken: firstToken, claimedAt: "2030-01-01T00:08:00.000Z",
    claimExpiresAt: "2030-01-01T00:13:00.000Z",
  });
  const failed = await operations.fail({
    tenantId, operationId, claimToken: firstToken,
    errorCode: "STEAM_AUTHORIZATION_REVOKED", terminal: true,
    completedAt: "2030-01-01T00:09:00.000Z",
  });
  assert.equal(failed.status, "FAILED");
  assert.equal(client.row?.error_code, "STEAM_AUTHORIZATION_REVOKED");
});

function result<ResultRow extends Record<string, unknown>>(
  rows: ResultRow[],
  rowCount = rows.length,
): PostgresQueryResult<ResultRow> {
  return { rowCount, rows };
}
