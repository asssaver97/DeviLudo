import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import type { SteamPrivateBetaReceipt } from "../src/contracts";
import { PostgresSteamPublishOperationStore } from "../src/postgres-publish-operations";
import { postgresReadinessResult } from "./postgres-readiness-fixture";

const tenantId = "11111111-1111-4111-8111-111111111111";
const otherTenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const firstToken = "44444444-4444-4444-8444-444444444444";
const secondToken = "55555555-5555-4555-8555-555555555555";
const now = "2030-01-01T00:00:00.000Z";
const key = `steam-private-beta:${tenantId}:${releaseId}:publish-001`;

type Row = {
  key: string; tenant_id: string; project_id: string; release_id: string;
  request_digest: string; claim_token: string; claim_expires_at: string;
  response: unknown | null; authorized_at: string; completed_at: string | null;
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
    const readiness = postgresReadinessResult<ResultRow>(text);
    if (readiness) return readiness;
    if (text.includes("INSERT INTO deviludo.steam_publish_claims")) {
      if (this.row === null) {
        this.row = {
          key: String(values[0]), tenant_id: String(values[1]), project_id: String(values[2]), release_id: String(values[3]),
          request_digest: String(values[4]), claim_token: String(values[5]), claim_expires_at: String(values[6]),
          response: null, authorized_at: String(values[7]), completed_at: null,
        };
        return result([], 1);
      }
      return result([], 0);
    }
    if (text.includes("FROM deviludo.steam_publish_claims") && text.includes("FOR UPDATE")) {
      if (this.row === null || this.row.tenant_id !== values[0] || this.row.key !== values[1]) return result([]);
      return result([this.row] as unknown as ResultRow[]);
    }
    if (text.includes("SET claim_token")) {
      if (this.row === null) return result([], 0);
      this.row.claim_token = String(values[3]);
      this.row.claim_expires_at = String(values[4]);
      return result([], 1);
    }
    if (text.includes("SET response")) {
      if (this.row === null || this.row.response !== null) return result([], 0);
      this.row.response = JSON.parse(String(values[5])) as unknown;
      this.row.completed_at = String(values[6]);
      return result([], 1);
    }
    return result([]);
  }

  release(): void { this.releases += 1; }
}

const acquire = {
  key,
  tenantId,
  projectId,
  releaseId,
  requestDigest: "a".repeat(64),
  claimToken: firstToken,
  claimExpiresAt: "2030-01-01T00:05:00.000Z",
  authorizedAt: now,
};

const receipt: SteamPrivateBetaReceipt = Object.freeze({
  tenantId,
  projectId,
  releaseId,
  steamAppId: "2841930",
  mainCommitSha: "b".repeat(40),
  sourceDigest: "c".repeat(64),
  evidenceBundleDigest: "d".repeat(64),
  buildId: "91234567",
  betaBranch: "deviludo_private_9",
  depotManifestIds: { "2841931": "81234567" },
  installAttempts: { linux: "install-linux-001" } as never,
  state: "INSTALL_TESTING",
  uploadedAt: "2030-01-01T00:02:00.000Z",
});

test("PostgreSQL Steam publish claim is tenant-scoped, exclusive and reclaimable after expiry", async () => {
  const client = new Client();
  const store = new PostgresSteamPublishOperationStore({ async connect() { return client; } }, { now: () => new Date(now) });
  assert.deepEqual(await store.acquire(acquire), { kind: "ACQUIRED" });
  assert.ok(client.calls.some((call) => call.text.includes("set_config('app.tenant_id'")));
  assert.match(client.calls.find((call) => call.text.includes("INSERT INTO"))!.text, /ON CONFLICT \(key\) DO NOTHING/);

  assert.deepEqual(await store.acquire({ ...acquire, claimToken: secondToken }), { kind: "BUSY" });
  assert.equal(client.row?.claim_token, firstToken);
  client.row!.claim_expires_at = "2029-12-31T23:59:59.000Z";
  assert.deepEqual(await store.acquire({ ...acquire, claimToken: secondToken }), { kind: "ACQUIRED" });
  assert.equal(client.row?.claim_token, secondToken);
  assert.ok(client.calls.some((call) => call.text.includes("SET claim_token")));
  await store.probe();
  assert.equal(client.releases, 4);
});

test("PostgreSQL Steam publish completion persists and replays one exact immutable receipt", async () => {
  const client = new Client();
  const store = new PostgresSteamPublishOperationStore({ async connect() { return client; } }, { now: () => new Date(now) });
  await store.acquire(acquire);
  const completion = {
    key, tenantId, projectId, releaseId, requestDigest: acquire.requestDigest,
    claimToken: firstToken, response: receipt, completedAt: "2030-01-01T00:03:00.000Z",
  };
  await store.complete(completion);
  assert.equal(client.row?.completed_at, completion.completedAt);
  assert.deepEqual(await store.acquire({ ...acquire, claimToken: secondToken }), { kind: "COMPLETED", response: receipt });
  await store.complete({ ...completion, claimToken: secondToken });
  assert.equal(client.calls.filter((call) => call.text.includes("SET response")).length, 1);
});

test("PostgreSQL Steam publish claim rejects cross-tenant, binding and receipt drift", async () => {
  const client = new Client();
  const store = new PostgresSteamPublishOperationStore({ async connect() { return client; } }, { now: () => new Date(now) });
  await store.acquire(acquire);
  await assert.rejects(store.acquire({ ...acquire, requestDigest: "f".repeat(64), claimToken: secondToken }), /operation is invalid/);
  assert.equal(client.calls.at(-1)?.text, "ROLLBACK");
  await assert.rejects(store.acquire({ ...acquire, tenantId: otherTenantId, claimToken: secondToken }), /operation is invalid/);
  assert.equal(client.calls.at(-1)?.text, "ROLLBACK");
  await assert.rejects(store.complete({
    key, tenantId, projectId, releaseId, requestDigest: acquire.requestDigest, claimToken: firstToken,
    response: { ...receipt, buildId: "0" }, completedAt: "2030-01-01T00:03:00.000Z",
  }), /operation is invalid/);
  assert.doesNotMatch(JSON.stringify(client.calls), /config\.vdf|password|steam.?guard/i);
});

function result<ResultRow extends Record<string, unknown>>(
  rows: ResultRow[],
  rowCount = rows.length,
): PostgresQueryResult<ResultRow> {
  return { rowCount, rows };
}
