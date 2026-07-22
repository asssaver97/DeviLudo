import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import { PostgresSteamCleanInstallGrantStore } from "../src/postgres-install-grants";
import { postgresReadinessResult } from "./postgres-readiness-fixture";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const buildReceiptId = "44444444-4444-4444-8444-444444444444";
const grantId = "55555555-5555-4555-8555-555555555555";
const now = "2030-01-01T00:00:00.000Z";

class Client implements PostgresWorkflowClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  releases = 0;
  drift = false;
  redemptionDrift = false;
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ text, values });
    const readiness = postgresReadinessResult<Row>(text);
    if (readiness) return readiness;
    if (text.includes("SELECT redemption.grant_id::text")) return result([{
      grant_id: grantId, platform: "linux", runner_id: "runner-linux-1",
      job_digest: this.redemptionDrift ? "f".repeat(64) : "b".repeat(64),
      execution_lock_digest: "c".repeat(64), redeemed_at: "2030-01-01T00:00:00.000Z",
      steam_app_id: "2841930", build_id: "91234567", beta_branch: "deviludo_private_9",
      expires_at: "2030-01-01T03:00:00.000Z", revoked_at: null,
    }] as unknown as Row[]);
    if (text.includes("SELECT grant_id::text")) return result([{
      grant_id: grantId, tenant_id: tenantId, project_id: projectId, run_id: runId,
      lock_key: "a".repeat(64), build_receipt_id: buildReceiptId,
      steam_app_id: "2841930", build_id: this.drift ? "999" : "91234567",
      beta_branch: "deviludo_private_9", target_matrix: ["linux", "macos", "windows"],
      issued_at: now, expires_at: "2030-01-01T03:00:00.000Z", revoked_at: null,
    }] as unknown as Row[]);
    return { rowCount: text.includes("INSERT INTO") ? 1 : 0, rows: [] };
  }
  release() { this.releases += 1; }
}

const input = {
  tenantId, projectId, runId, lockKey: "a".repeat(64), buildReceiptId,
  steamAppId: "2841930", buildId: "91234567", betaBranch: "deviludo_private_9",
  targetMatrix: ["linux", "macos", "windows"] as const,
};

test("PostgreSQL issuer creates one opaque expiring grant under tenant RLS", async () => {
  const client = new Client();
  const store = new PostgresSteamCleanInstallGrantStore({ async connect() { return client; } }, {
    now: () => new Date(now), newId: () => grantId,
  });
  const receipt = await store.issue(input);
  assert.deepEqual(receipt, {
    installGrantId: grantId, steamAppId: "2841930", buildId: "91234567",
    betaBranch: "deviludo_private_9", targetMatrix: ["linux", "macos", "windows"],
  });
  assert.ok(client.calls.some((call) => call.text.includes("set_config('app.tenant_id'")));
  const insert = client.calls.find((call) => call.text.includes("INSERT INTO deviludo.steam_install_grants"))!;
  assert.match(String(insert.values[11]), /^2030-01-01T03:00:00\.000Z$/);
  assert.equal(client.calls.at(-1)?.text, "COMMIT");
  await store.probe();
  assert.equal(client.releases, 2);
});

test("PostgreSQL issuer rejects binding drift and rolls back without exposing credentials", async () => {
  const client = new Client();
  client.drift = true;
  const store = new PostgresSteamCleanInstallGrantStore({ async connect() { return client; } }, {
    now: () => new Date(now), newId: () => grantId,
  });
  await assert.rejects(store.issue(input), /grant is invalid/);
  assert.equal(client.calls.at(-1)?.text, "ROLLBACK");
  assert.doesNotMatch(JSON.stringify(client.calls), /password|config\.vdf|steam.?guard/i);
  await assert.rejects(store.issue({ ...input, targetMatrix: ["windows", "linux"] }), /grant is invalid/);
});

test("PostgreSQL grant redemption is idempotent only for one exact platform job", async () => {
  const client = new Client();
  const store = new PostgresSteamCleanInstallGrantStore({ async connect() { return client; } }, { now: () => new Date(now) });
  const redemption = {
    tenantId, projectId, runId, grantId, platform: "linux" as const,
    runnerId: "runner-linux-1", jobDigest: "b".repeat(64), executionLockDigest: "c".repeat(64),
    steamAppId: "2841930", buildId: "91234567", betaBranch: "deviludo_private_9",
  };
  assert.deepEqual(await store.redeem(redemption), {
    grantId, platform: "linux", steamAppId: "2841930", buildId: "91234567",
    betaBranch: "deviludo_private_9", redeemedAt: now,
  });
  const insert = client.calls.find((call) => call.text.includes("steam_install_grant_redemptions"))!;
  assert.match(insert.text, /ON CONFLICT \(tenant_id, grant_id, platform\) DO NOTHING/);
  assert.ok(insert.text.includes("grant.expires_at > $12::timestamptz"));
  client.redemptionDrift = true;
  await assert.rejects(store.redeem(redemption), /grant is invalid/);
  assert.equal(client.calls.at(-1)?.text, "ROLLBACK");
});

function result<Row extends Record<string, unknown>>(rows: Row[]): PostgresQueryResult<Row> {
  return { rowCount: rows.length, rows };
}
