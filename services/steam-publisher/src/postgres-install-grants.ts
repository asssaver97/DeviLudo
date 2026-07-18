import { randomUUID } from "node:crypto";
import type { TargetPlatform } from "../../../lib/domain/types";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { SteamCleanInstallGrantIssuer } from "./clean-install-preparation";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const APP_ID = /^[1-9][0-9]{0,19}$/;
const BRANCH = /^[a-z0-9][a-z0-9_-]{2,39}$/;

type GrantRow = {
  grant_id: string;
  tenant_id: string;
  project_id: string;
  run_id: string;
  lock_key: string;
  build_receipt_id: string;
  steam_app_id: string;
  build_id: string;
  beta_branch: string;
  target_matrix: string[];
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
};

export interface SteamInstallGrantRedemptionStore {
  redeem(input: Readonly<{
    tenantId: string; projectId: string; runId: string; grantId: string;
    platform: TargetPlatform; runnerId: string; jobDigest: string;
    executionLockDigest: string; steamAppId: string; buildId: string; betaBranch: string;
  }>): Promise<Readonly<{
    grantId: string; platform: TargetPlatform; steamAppId: string; buildId: string;
    betaBranch: string; redeemedAt: string;
  }>>;
  probe(): Promise<void>;
}

/** Idempotently issues only opaque, expiring grant IDs under tenant RLS. */
export class PostgresSteamCleanInstallGrantStore implements SteamCleanInstallGrantIssuer {
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #newId: () => string;

  constructor(private readonly pool: PostgresWorkflowPool, options: Readonly<{
    now?: () => Date;
    ttlSeconds?: number;
    newId?: () => string;
  }> = {}) {
    this.#now = options.now ?? (() => new Date());
    const ttlSeconds = options.ttlSeconds ?? 10_800;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 86_400) invalid();
    this.#ttlMs = ttlSeconds * 1_000;
    this.#newId = options.newId ?? randomUUID;
  }

  async issue(input: Parameters<SteamCleanInstallGrantIssuer["issue"]>[0]) {
    validateInput(input);
    const issuedAt = validDate(this.#now());
    const expiresAt = new Date(issuedAt.getTime() + this.#ttlMs);
    const grantId = this.#newId();
    if (!UUID.test(grantId)) invalid();
    return this.#transaction(input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.steam_install_grants
          (grant_id, tenant_id, project_id, run_id, lock_key, build_receipt_id,
           steam_app_id, build_id, beta_branch, target_matrix, issued_at, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid,
                 $7, $8, $9, $10::text[], $11::timestamptz, $12::timestamptz)
         ON CONFLICT (tenant_id, lock_key) DO NOTHING`,
        [grantId, input.tenantId, input.projectId, input.runId, input.lockKey, input.buildReceiptId,
          input.steamAppId, input.buildId, input.betaBranch, input.targetMatrix,
          issuedAt.toISOString(), expiresAt.toISOString()],
      );
      const selected = await client.query<GrantRow>(
        `SELECT grant_id::text, tenant_id::text, project_id::text, run_id::text,
                lock_key, build_receipt_id::text, steam_app_id, build_id,
                beta_branch, target_matrix, issued_at::text, expires_at::text,
                revoked_at::text
           FROM deviludo.steam_install_grants
          WHERE tenant_id = $1::uuid AND lock_key = $2
          FOR SHARE`,
        [input.tenantId, input.lockKey],
      );
      if (selected.rows.length !== 1) invalid();
      const row = selected.rows[0]!;
      if (!UUID.test(row.grant_id) || row.tenant_id !== input.tenantId
        || row.project_id !== input.projectId || row.run_id !== input.runId
        || row.lock_key !== input.lockKey || row.build_receipt_id !== input.buildReceiptId
        || row.steam_app_id !== input.steamAppId || row.build_id !== input.buildId
        || row.beta_branch !== input.betaBranch || !sameMatrix(row.target_matrix, input.targetMatrix)
        || row.revoked_at !== null || Date.parse(row.expires_at) <= issuedAt.getTime()
        || !Number.isFinite(Date.parse(row.issued_at))) invalid();
      return Object.freeze({
        installGrantId: row.grant_id,
        steamAppId: row.steam_app_id,
        buildId: row.build_id,
        betaBranch: row.beta_branch,
        targetMatrix: Object.freeze([...row.target_matrix]) as readonly TargetPlatform[],
      });
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ ready: number }>("SELECT 1 AS ready");
      if (result.rows.length !== 1 || result.rows[0]?.ready !== 1) invalid();
    } finally { client.release(); }
  }

  async redeem(input: Parameters<SteamInstallGrantRedemptionStore["redeem"]>[0]) {
    if (![input.tenantId, input.projectId, input.runId, input.grantId].every((value) => UUID.test(value))
      || !SHA256.test(input.jobDigest) || !SHA256.test(input.executionLockDigest)
      || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(input.runnerId)
      || !APP_ID.test(input.steamAppId) || !APP_ID.test(input.buildId) || !BRANCH.test(input.betaBranch)
      || !["windows", "linux", "macos"].includes(input.platform)) invalid();
    const redeemedAt = validDate(this.#now()).toISOString();
    return this.#transaction(input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.steam_install_grant_redemptions
          (tenant_id, project_id, run_id, grant_id, platform, runner_id,
           job_digest, execution_lock_digest, redeemed_at)
         SELECT grant.tenant_id, grant.project_id, grant.run_id, grant.grant_id,
                $5, $6, $7, $8, $12::timestamptz
           FROM deviludo.steam_install_grants grant
          WHERE grant.tenant_id = $1::uuid AND grant.project_id = $2::uuid
            AND grant.run_id = $3::uuid AND grant.grant_id = $4::uuid
            AND $5 = ANY(grant.target_matrix) AND grant.steam_app_id = $9
            AND grant.build_id = $10 AND grant.beta_branch = $11
            AND grant.revoked_at IS NULL AND grant.expires_at > $12::timestamptz
         ON CONFLICT (tenant_id, grant_id, platform) DO NOTHING`,
        [input.tenantId, input.projectId, input.runId, input.grantId, input.platform,
          input.runnerId, input.jobDigest, input.executionLockDigest, input.steamAppId,
          input.buildId, input.betaBranch, redeemedAt],
      );
      const selected = await client.query<{
        grant_id: string; platform: string; runner_id: string; job_digest: string;
        execution_lock_digest: string; redeemed_at: string; steam_app_id: string;
        build_id: string; beta_branch: string; expires_at: string; revoked_at: string | null;
      }>(
        `SELECT redemption.grant_id::text, redemption.platform, redemption.runner_id,
                redemption.job_digest, redemption.execution_lock_digest,
                redemption.redeemed_at::text, grant.steam_app_id, grant.build_id,
                grant.beta_branch, grant.expires_at::text, grant.revoked_at::text
           FROM deviludo.steam_install_grant_redemptions redemption
           JOIN deviludo.steam_install_grants grant
             ON grant.tenant_id = redemption.tenant_id AND grant.grant_id = redemption.grant_id
          WHERE redemption.tenant_id = $1::uuid AND redemption.grant_id = $2::uuid
            AND redemption.platform = $3
          FOR SHARE OF redemption, grant`,
        [input.tenantId, input.grantId, input.platform],
      );
      if (selected.rows.length !== 1) invalid();
      const row = selected.rows[0]!;
      if (row.grant_id !== input.grantId || row.platform !== input.platform
        || row.runner_id !== input.runnerId || row.job_digest !== input.jobDigest
        || row.execution_lock_digest !== input.executionLockDigest
        || row.steam_app_id !== input.steamAppId || row.build_id !== input.buildId
        || row.beta_branch !== input.betaBranch || row.revoked_at !== null
        || Date.parse(row.expires_at) <= Date.parse(redeemedAt)
        || !Number.isFinite(Date.parse(row.redeemed_at))) invalid();
      return Object.freeze({
        grantId: row.grant_id, platform: row.platform as TargetPlatform,
        steamAppId: row.steam_app_id, buildId: row.build_id,
        betaBranch: row.beta_branch, redeemedAt: row.redeemed_at,
      });
    });
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
      try { await client.query("ROLLBACK"); } catch { /* preserve grant failure */ }
      throw error;
    } finally { client.release(); }
  }
}

function validateInput(input: Parameters<SteamCleanInstallGrantIssuer["issue"]>[0]): void {
  if (![input.tenantId, input.projectId, input.runId, input.buildReceiptId].every((value) => UUID.test(value))
    || !SHA256.test(input.lockKey) || !APP_ID.test(input.steamAppId) || !APP_ID.test(input.buildId)
    || !BRANCH.test(input.betaBranch) || !validMatrix(input.targetMatrix)) invalid();
}

function validMatrix(value: readonly string[]): value is readonly TargetPlatform[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 3
    && value.every((item) => item === "windows" || item === "linux" || item === "macos")
    && JSON.stringify(value) === JSON.stringify([...new Set(value)].sort());
}

function sameMatrix(left: readonly string[], right: readonly string[]): boolean {
  return validMatrix(left) && JSON.stringify(left) === JSON.stringify(right);
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
  return value;
}

function invalid(): never {
  throw new Error("Steam clean-install grant is invalid");
}
