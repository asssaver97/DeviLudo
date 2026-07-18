import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { SteamPrivateBetaReceipt, SteamPublishOperationStore, SteamTargetPlatform } from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,511}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const BRANCH = /^[a-z0-9][a-z0-9_-]{2,39}$/;

type PublishClaimRow = {
  key: string;
  tenant_id: string;
  project_id: string;
  release_id: string;
  request_digest: string;
  claim_token: string;
  claim_expires_at: string;
  response: unknown | null;
  authorized_at: string;
  completed_at: string | null;
};

/** Durable multi-replica claim store for one irreversible Steam upload. */
export class PostgresSteamPublishOperationStore implements SteamPublishOperationStore {
  readonly #now: () => Date;

  constructor(private readonly pool: PostgresWorkflowPool, options: Readonly<{ now?: () => Date }> = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async acquire(input: Parameters<SteamPublishOperationStore["acquire"]>[0]) {
    validateAcquire(input);
    const now = validDate(this.#now()).getTime();
    return this.#transaction(input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.steam_publish_claims
          (key, tenant_id, project_id, release_id, request_digest, claim_token,
           claim_expires_at, authorized_at)
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid,
                 $7::timestamptz, $8::timestamptz)
         ON CONFLICT (key) DO NOTHING`,
        [input.key, input.tenantId, input.projectId, input.releaseId, input.requestDigest,
          input.claimToken, input.claimExpiresAt, input.authorizedAt],
      );
      const row = await selectClaim(client, input.tenantId, input.key);
      validateBinding(row, input);
      if (row.response !== null) {
        if (row.completed_at === null || !Number.isFinite(Date.parse(row.completed_at))) invalid();
        return Object.freeze({ kind: "COMPLETED" as const, response: parseReceipt(row.response, input) });
      }
      if (row.completed_at !== null) invalid();
      if (row.claim_token === input.claimToken) return Object.freeze({ kind: "ACQUIRED" as const });
      if (Date.parse(row.claim_expires_at) > now) return Object.freeze({ kind: "BUSY" as const });
      const updated = await client.query(
        `UPDATE deviludo.steam_publish_claims
            SET claim_token = $4::uuid, claim_expires_at = $5::timestamptz
          WHERE tenant_id = $1::uuid AND key = $2 AND request_digest = $3
            AND response IS NULL`,
        [input.tenantId, input.key, input.requestDigest, input.claimToken, input.claimExpiresAt],
      );
      if (updated.rowCount !== 1) invalid();
      return Object.freeze({ kind: "ACQUIRED" as const });
    });
  }

  async complete(input: Parameters<SteamPublishOperationStore["complete"]>[0]): Promise<void> {
    validateComplete(input);
    const response = parseReceipt(input.response, input);
    await this.#transaction(input.tenantId, async (client) => {
      const row = await selectClaim(client, input.tenantId, input.key);
      validateBinding(row, input);
      if (row.response !== null) {
        const existing = parseReceipt(row.response, input);
        if (row.completed_at === null || sha256Canonical(existing) !== sha256Canonical(response)) invalid();
        return;
      }
      if (row.completed_at !== null || row.claim_token !== input.claimToken) invalid();
      const updated = await client.query(
        `UPDATE deviludo.steam_publish_claims
            SET response = $6::jsonb, completed_at = $7::timestamptz
          WHERE tenant_id = $1::uuid AND key = $2 AND request_digest = $3
            AND claim_token = $4::uuid AND release_id = $5::uuid
            AND response IS NULL`,
        [input.tenantId, input.key, input.requestDigest, input.claimToken,
          input.releaseId, JSON.stringify(response), input.completedAt],
      );
      if (updated.rowCount !== 1) invalid();
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ ready: number }>("SELECT 1 AS ready");
      if (result.rows.length !== 1 || result.rows[0]?.ready !== 1) invalid();
    } finally { client.release(); }
  }

  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve publish failure */ }
      throw error;
    } finally { client.release(); }
  }
}

async function selectClaim(client: PostgresWorkflowClient, tenantId: string, key: string): Promise<PublishClaimRow> {
  const selected = await client.query<PublishClaimRow>(
    `SELECT key, tenant_id::text, project_id::text, release_id::text,
            request_digest, claim_token::text, claim_expires_at::text,
            response, authorized_at::text, completed_at::text
       FROM deviludo.steam_publish_claims
      WHERE tenant_id = $1::uuid AND key = $2
      FOR UPDATE`,
    [tenantId, key],
  );
  if (selected.rows.length !== 1) invalid();
  return selected.rows[0]!;
}

function validateAcquire(input: Parameters<SteamPublishOperationStore["acquire"]>[0]): void {
  validateCommon(input);
  const authorizedAt = Date.parse(input.authorizedAt);
  const claimExpiresAt = Date.parse(input.claimExpiresAt);
  if (!Number.isFinite(authorizedAt) || !Number.isFinite(claimExpiresAt)
    || claimExpiresAt <= authorizedAt || claimExpiresAt - authorizedAt > 15 * 60_000) invalid();
}

function validateComplete(input: Parameters<SteamPublishOperationStore["complete"]>[0]): void {
  validateCommon(input);
  if (!Number.isFinite(Date.parse(input.completedAt))) invalid();
}

function validateCommon(input: Readonly<{
  key: string; tenantId: string; projectId: string; releaseId: string;
  requestDigest: string; claimToken: string;
}>): void {
  if (!SAFE_KEY.test(input.key) || ![input.tenantId, input.projectId, input.releaseId, input.claimToken].every((value) => UUID.test(value))
    || !SHA256.test(input.requestDigest)) invalid();
}

function validateBinding(
  row: PublishClaimRow,
  input: Readonly<{ key: string; tenantId: string; projectId: string; releaseId: string; requestDigest: string }>,
): void {
  if (row.key !== input.key || row.tenant_id !== input.tenantId || row.project_id !== input.projectId
    || row.release_id !== input.releaseId || row.request_digest !== input.requestDigest
    || !UUID.test(row.claim_token) || !Number.isFinite(Date.parse(row.claim_expires_at))
    || !Number.isFinite(Date.parse(row.authorized_at))) invalid();
}

function parseReceipt(value: unknown, expected: Readonly<{
  tenantId: string; projectId: string; releaseId: string;
}>): SteamPrivateBetaReceipt {
  const body = record(value);
  exactKeys(body, [
    "tenantId", "projectId", "releaseId", "steamAppId", "mainCommitSha", "sourceDigest",
    "evidenceBundleDigest", "buildId", "betaBranch", "depotManifestIds", "installAttempts",
    "state", "uploadedAt",
  ]);
  if (body.tenantId !== expected.tenantId || body.projectId !== expected.projectId || body.releaseId !== expected.releaseId
    || typeof body.steamAppId !== "string" || !NUMERIC_ID.test(body.steamAppId)
    || typeof body.mainCommitSha !== "string" || !SHA1.test(body.mainCommitSha)
    || typeof body.sourceDigest !== "string" || !SHA256.test(body.sourceDigest)
    || typeof body.evidenceBundleDigest !== "string" || !SHA256.test(body.evidenceBundleDigest)
    || typeof body.buildId !== "string" || !NUMERIC_ID.test(body.buildId)
    || typeof body.betaBranch !== "string" || !BRANCH.test(body.betaBranch)
    || body.betaBranch === "default" || body.betaBranch === "public" || body.state !== "INSTALL_TESTING"
    || typeof body.uploadedAt !== "string" || !Number.isFinite(Date.parse(body.uploadedAt))) invalid();
  const depots = numericMap(body.depotManifestIds);
  const attempts = attemptMap(body.installAttempts);
  if (Object.keys(depots).length !== Object.keys(attempts).length) invalid();
  return deepFreeze({
    tenantId: body.tenantId,
    projectId: body.projectId,
    releaseId: body.releaseId,
    steamAppId: body.steamAppId,
    mainCommitSha: body.mainCommitSha,
    sourceDigest: body.sourceDigest,
    evidenceBundleDigest: body.evidenceBundleDigest,
    buildId: body.buildId,
    betaBranch: body.betaBranch,
    depotManifestIds: depots,
    installAttempts: attempts,
    state: "INSTALL_TESTING",
    uploadedAt: body.uploadedAt,
  });
}

function numericMap(value: unknown): Readonly<Record<string, string>> {
  const body = record(value);
  const entries = Object.entries(body);
  if (entries.length < 1 || entries.length > 3) invalid();
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!NUMERIC_ID.test(key) || typeof item !== "string" || !NUMERIC_ID.test(item)) invalid();
    result[key] = item;
  }
  return Object.freeze(result);
}

function attemptMap(value: unknown): Readonly<Record<SteamTargetPlatform, string>> {
  const body = record(value);
  const entries = Object.entries(body);
  if (entries.length < 1 || entries.length > 3) invalid();
  const result: Partial<Record<SteamTargetPlatform, string>> = {};
  for (const [key, item] of entries) {
    if (!isPlatform(key) || typeof item !== "string" || !OPAQUE_ID.test(item)) invalid();
    result[key] = item;
  }
  return Object.freeze(result) as Readonly<Record<SteamTargetPlatform, string>>;
}

function isPlatform(value: string): value is SteamTargetPlatform {
  return value === "windows" || value === "linux" || value === "macos";
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid();
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
  return value;
}

function deepFreeze<T>(value: T): T {
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && typeof child === "object") deepFreeze(child);
  }
  return value;
}

function invalid(): never {
  throw new Error("Steam publish operation is invalid");
}
