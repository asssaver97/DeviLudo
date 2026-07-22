import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import { PostgresSteamCleanInstallDispatcher } from "../src/postgres-clean-install-dispatch";
import { postgresReadinessResult } from "./postgres-readiness-fixture";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const ids = [
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888",
  "99999999-9999-4999-8999-999999999999",
];
const input = Object.freeze({
  tenantId, projectId, releaseId, steamAppId: "2841930", buildId: "91234567",
  betaBranch: "private_beta", branchPasswordSecretRef: "vault://steam/beta/versions/7",
  mainCommitSha: "a".repeat(40), sourceDigest: "b".repeat(64),
  specDigest: "c".repeat(64), testPlanDigest: "d".repeat(64),
  targetMatrix: Object.freeze(["linux", "windows"] as const),
});

class Client implements PostgresWorkflowClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  readonly reservations = new Map<string, Record<string, unknown>>();

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ text, values });
    const readiness = postgresReadinessResult<Row>(text);
    if (readiness) return readiness;
    if (text.includes("FROM deviludo.steam_releases")) return result([{
      id: releaseId, main_commit_sha: input.mainCommitSha, steam_app_id: input.steamAppId,
      beta_branch: input.betaBranch, branch_password_secret_ref: input.branchPasswordSecretRef,
      target_matrix: input.targetMatrix, state: "STEAM_PRIVATE_BETA",
    }] as unknown as Row[]);
    if (text.includes("INSERT INTO deviludo.steam_clean_install_reservations")) {
      const platform = String(values[6]);
      if (!this.reservations.has(platform)) this.reservations.set(platform, {
        id: String(values[0]), tenant_id: String(values[1]), project_id: String(values[2]),
        release_id: String(values[3]), steam_app_id: String(values[4]), build_id: String(values[5]),
        platform, main_commit_sha: String(values[7]), source_digest: String(values[8]),
        spec_digest: String(values[9]), test_plan_digest: String(values[10]),
        reservation_digest: String(values[11]), created_at: String(values[12]),
      });
      return result([]);
    }
    if (text.includes("FROM deviludo.steam_clean_install_reservations")) {
      return result([...this.reservations.values()].sort((left, right) => String(left.platform).localeCompare(String(right.platform))) as Row[]);
    }
    return result([]);
  }

  release(): void {}
}

test("PostgreSQL Steam dispatcher reserves and replays one immutable handle per selected platform", async () => {
  const client = new Client();
  let index = 0;
  const dispatcher = new PostgresSteamCleanInstallDispatcher({ async connect() { return client; } }, {
    now: () => new Date("2030-01-01T00:02:00.000Z"),
    reservationId: () => ids[index++] as string,
  });
  const first = await dispatcher.schedule(input);
  const replay = await dispatcher.schedule(input);
  assert.deepEqual(first, { linux: ids[0], windows: ids[1] });
  assert.deepEqual(replay, first);
  assert.equal(client.reservations.size, 2);
  assert.ok(client.calls.some((call) => call.text.includes("ON CONFLICT (release_id, platform) DO NOTHING")));
  assert.ok(client.calls.some((call) => call.text.includes("set_config('app.tenant_id'")));
  assert.doesNotMatch(JSON.stringify(client.reservations), /branchPassword|vault:\/\//i);
  await dispatcher.probe();

  await assert.rejects(dispatcher.schedule({ ...input, buildId: "99999999" }), /dispatch is invalid/);
  assert.equal(client.calls.at(-1)?.text, "ROLLBACK");
});

function result<Row extends Record<string, unknown>>(rows: readonly Row[]): PostgresQueryResult<Row> {
  return { rows, rowCount: rows.length };
}
