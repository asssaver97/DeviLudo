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
