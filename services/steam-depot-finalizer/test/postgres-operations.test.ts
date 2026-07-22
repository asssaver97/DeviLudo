import assert from "node:assert/strict";
import test from "node:test";
import { steamCanonicalDigest } from "../../steam-publisher/src/artifacts";
import { signedDepotObjectKey, signingEvidenceObjectKey } from "../../steam-publisher/src/depot-finalization";
import type {
  PostgresQueryResult,
  PostgresWorkflowClient,
  PostgresWorkflowPool,
} from "../../temporal/src/postgres-inbox";
import { PostgresReadinessFixture } from "../../temporal/test/postgres-readiness-fixture";
import { parseSteamDepotFinalizationRequest, steamDepotFinalizationReceiptDigest } from "../src/contract";
import type { SteamDepotFinalizationRequest } from "../src/contracts";
import { PostgresSteamDepotFinalizationOperations } from "../src/postgres-operations";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";

test("PostgreSQL finalization store applies tenant RLS and replays one immutable receipt", async () => {
  const client = new FixtureClient();
  const store = new PostgresSteamDepotFinalizationOperations(pool(client));
  const request = finalizationRequest("1".repeat(40));
  const claim = await store.claim({
    request,
    claimToken: "55555555-5555-4555-8555-555555555555",
    claimedAt: "2026-07-21T10:00:00.000Z",
    claimExpiresAt: "2026-07-21T10:55:00.000Z",
  });
  assert.deepEqual(claim, { kind: "ACQUIRED", attempt: 1 });
  const result = receipt(request);
  await store.complete({
    request,
    claimToken: "55555555-5555-4555-8555-555555555555",
    receipt: result,
    receiptDigest: steamDepotFinalizationReceiptDigest(result),
    completedAt: "2026-07-21T10:01:00.000Z",
  });
  const replay = await store.claim({
    request,
    claimToken: "66666666-6666-4666-8666-666666666666",
    claimedAt: "2026-07-21T10:02:00.000Z",
    claimExpiresAt: "2026-07-21T10:57:00.000Z",
  });
  assert.deepEqual(replay, { kind: "REPLAY", receipt: result });
  assert.ok(client.statements.some((statement) => statement.includes("set_config('app.tenant_id'")));
  assert.ok(client.statements.some((statement) => statement.includes("ON CONFLICT (tenant_id, operation_key) DO NOTHING")));
  assert.equal(client.row?.state, "COMPLETED");
  assert.equal(client.row?.attempt_count, 1);
});

test("PostgreSQL finalization store rejects a changed request under the same operation key", async () => {
  const client = new FixtureClient();
  const store = new PostgresSteamDepotFinalizationOperations(pool(client));
  const request = finalizationRequest("1".repeat(40));
  await store.claim({
    request,
    claimToken: "55555555-5555-4555-8555-555555555555",
    claimedAt: "2026-07-21T10:00:00.000Z",
    claimExpiresAt: "2026-07-21T10:55:00.000Z",
  });
  await assert.rejects(store.claim({
    request: finalizationRequest("9".repeat(40)),
    claimToken: "66666666-6666-4666-8666-666666666666",
    claimedAt: "2026-07-21T10:01:00.000Z",
    claimExpiresAt: "2026-07-21T10:56:00.000Z",
  }), /operation is invalid/);
  assert.ok(client.statements.includes("ROLLBACK"));
});

class FixtureClient implements PostgresWorkflowClient {
  statements: string[] = [];
  row: Record<string, unknown> | null = null;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.statements.push(text);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config")) {
      return result<Row>(1, []);
    }
    if (text.includes("INSERT INTO deviludo.steam_depot_finalization_operations")) {
      if (!this.row) {
        this.row = {
          tenant_id: values[0], operation_key: values[1], request_digest: values[2], project_id: values[3],
          release_id: values[4], platform: values[7], request_payload: JSON.parse(values[10] as string) as unknown,
          state: "PENDING", claim_token: null, claim_expires_at: null, attempt_count: 0,
          receipt: null, receipt_digest: null,
        };
      }
      return result<Row>(1, []);
    }
    if (text.includes("FROM deviludo.steam_depot_finalization_operations") && text.includes("FOR UPDATE")) {
      return result<Row>(this.row ? 1 : 0, this.row ? [this.row as Row] : []);
    }
    if (text.includes("SET state = 'RUNNING'")) {
      if (!this.row) return result<Row>(0, []);
      this.row.state = "RUNNING";
      this.row.claim_token = values[2];
      this.row.claim_expires_at = values[3];
      this.row.attempt_count = Number(this.row.attempt_count) + 1;
      return result<Row>(1, [{ attempt_count: this.row.attempt_count } as unknown as Row]);
    }
    if (text.includes("SET state = 'COMPLETED'")) {
      if (!this.row || this.row.claim_token !== values[2]) return result<Row>(0, []);
      this.row.state = "COMPLETED";
      this.row.claim_token = null;
      this.row.claim_expires_at = null;
      this.row.receipt = JSON.parse(values[3] as string) as unknown;
      this.row.receipt_digest = values[4];
      return result<Row>(1, []);
    }
    if (text.includes("SET state = 'PENDING'")) {
      if (!this.row || this.row.claim_token !== values[2]) return result<Row>(0, []);
      this.row.state = "PENDING";
      this.row.claim_token = null;
      this.row.claim_expires_at = null;
      return result<Row>(1, []);
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  release(): void {}
}

function pool(client: PostgresWorkflowClient): PostgresWorkflowPool {
  return { async connect() { return client; } };
}

function result<Row extends Record<string, unknown>>(rowCount: number, rows: readonly Row[]): PostgresQueryResult<Row> {
  return { rowCount, rows };
}

function finalizationRequest(mainCommitSha: string): SteamDepotFinalizationRequest {
  const sourceArtifactDigest = "a".repeat(64);
  const core = Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalization.v1" as const,
    operationKey: `steam-depot-finalize:${releaseId}:linux`,
    tenantId,
    projectId,
    releaseId,
    mainCommitSha,
    evidenceBundleDigest: "2".repeat(64),
    platform: "linux" as const,
    sourceObjectKey: `tenants/${tenantId}/projects/${projectId}/runner-artifacts/${attemptId}/linux/production-export/${sourceArtifactDigest}`,
    sourceArtifactDigest,
  });
  return parseSteamDepotFinalizationRequest({ ...core, requestDigest: steamCanonicalDigest(core) });
}

function receipt(request: SteamDepotFinalizationRequest) {
  const artifactDigest = "3".repeat(64);
  const evidenceDigest = "4".repeat(64);
  return {
    schemaVersion: "deviludo.steam-depot-finalization-receipt.v1" as const,
    operationKey: request.operationKey,
    requestDigest: request.requestDigest,
    tenantId: request.tenantId,
    projectId: request.projectId,
    releaseId: request.releaseId,
    mainCommitSha: request.mainCommitSha,
    evidenceBundleDigest: request.evidenceBundleDigest,
    platform: request.platform,
    sourceArtifactDigest: request.sourceArtifactDigest,
    artifactObjectKey: signedDepotObjectKey(
      request.tenantId, request.projectId, request.releaseId, request.platform, artifactDigest,
    ),
    artifactDigest,
    signingScheme: "LINUX_SIGSTORE" as const,
    signingIdentityDigest: "5".repeat(64),
    signingEvidenceObjectKey: signingEvidenceObjectKey(
      request.tenantId, request.projectId, request.releaseId, request.platform, evidenceDigest,
    ),
    signingEvidenceDigest: evidenceDigest,
    notarizationEvidenceObjectKey: null,
    notarizationEvidenceDigest: null,
  };
}

test("Steam depot finalizer readiness requires its durable operation ledger", async () => {
  const ready = new PostgresReadinessFixture();
  await new PostgresSteamDepotFinalizationOperations(ready).probe();
  assert.deepEqual(ready.observedRelations(), ["steam_depot_finalization_operations"]);
  assert.equal(ready.releases, 1);

  const missing = new PostgresReadinessFixture("steam_depot_finalization_operations");
  await assert.rejects(new PostgresSteamDepotFinalizationOperations(missing).probe());
  assert.equal(missing.releases, 1);
});
