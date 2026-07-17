import assert from "node:assert/strict";
import test from "node:test";
import {
  PostgresSteamEnrollmentStore,
  type SteamPostgresClient,
  type SteamPostgresQueryResult,
} from "../src/enrollment-postgres";
import type { SteamBuildSession } from "../src/contracts";

test("Postgres Steam enrollment completion applies tenant RLS and commits only Vault metadata", async () => {
  const calls: { text: string; values?: readonly unknown[] }[] = [];
  let released = false;
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const enrollmentId = "22222222-2222-4222-8222-222222222222";
  const session: SteamBuildSession = Object.freeze({
    id: "33333333-3333-4333-8333-333333333333",
    tenantId,
    accountId: "steam-account-42",
    accountName: "deviludo_build_bot",
    configVdfSecretRef: "vault://kv/steam/config-vdf/version-1",
    credentialVersionId: "44444444-4444-4444-8444-444444444444",
    allowedAppIds: Object.freeze(["2841930"]),
    permissions: Object.freeze(["EditAppMetadata", "PublishAppChanges"] as const),
    state: "ACTIVE",
    verifiedAt: "2099-01-01T00:05:00.000Z",
    expiresAt: "2099-02-01T00:00:00.000Z",
  });
  const client: SteamPostgresClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      calls.push({ text, values });
      if (text.includes("SELECT id FROM deviludo.steam_enrollments")) return { rowCount: 1, rows: [{ id: enrollmentId }] } as unknown as SteamPostgresQueryResult<Row>;
      if (text.includes("INSERT INTO deviludo.credential_versions")) return { rowCount: 1, rows: [{ id: session.credentialVersionId }] } as unknown as SteamPostgresQueryResult<Row>;
      if (text.includes("INSERT INTO deviludo.steam_build_sessions")) return { rowCount: 1, rows: [{ id: session.id }] } as unknown as SteamPostgresQueryResult<Row>;
      if (text.includes("UPDATE deviludo.steam_enrollments")) {
        return {
          rowCount: 1,
          rows: [{
            id: enrollmentId,
            tenant_id: tenantId,
            user_subject: "user-ada",
            session_binding_digest: "a".repeat(64),
            idempotency_key: "steam-enrollment-1",
            request_digest: "b".repeat(64),
            state: "READY",
            challenge_secret_ref: null,
            created_at: "2099-01-01T00:00:00.000Z",
            expires_at: "2099-01-01T00:15:00.000Z",
            completed_at: "2099-01-01T00:05:00.000Z",
            session_id: session.id,
            account_id: session.accountId,
            account_name: session.accountName,
            config_vdf_secret_ref: session.configVdfSecretRef,
            credential_version_id: session.credentialVersionId,
            allowed_app_ids: [...session.allowedAppIds],
            permissions: [...session.permissions],
            session_state: session.state,
            verified_at: session.verifiedAt,
            session_expires_at: session.expiresAt,
          }],
        } as unknown as SteamPostgresQueryResult<Row>;
      }
      return { rowCount: 0, rows: [] } as SteamPostgresQueryResult<Row>;
    },
    release() { released = true; },
  };
  const store = new PostgresSteamEnrollmentStore({ async connect() { return client; } });
  const completed = await store.complete({
    tenantId,
    enrollmentId,
    session,
    credentialBindingId: "55555555-5555-4555-8555-555555555555",
    fingerprint: "c".repeat(64),
    maskedValue: "sha256:1234abcd…987654",
    at: "2099-01-01T00:05:00.000Z",
  });

  assert.equal(calls[0].text, "BEGIN");
  assert.equal(calls[1].text, "SELECT set_config('app.tenant_id', $1, true)");
  assert.deepEqual(calls[1].values, [tenantId]);
  assert.equal(calls.at(-1)?.text, "COMMIT");
  assert.equal(released, true);
  assert.equal(completed.state, "READY");
  assert.equal(completed.buildSession?.configVdfSecretRef, session.configVdfSecretRef);
  const databaseBoundary = JSON.stringify(calls);
  assert.match(databaseBoundary, /vault:\/\/kv\/steam\/config-vdf\/version-1/);
  assert.doesNotMatch(databaseBoundary, /password|guard.?code|sensitive-config-vdf-session/i);
});
