import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { sha256Canonical } from "./canonical";
import type { ScmOperationRecord, ScmOperationStore } from "./github-contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

type OperationRow = { operation_key: string; tenant_id: string; project_id: string; operation: string; request_digest: string;
  claim_token: string; claim_expires_at: string; response: unknown | null };

export class PostgresScmOperationStore implements ScmOperationStore {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async inspect<T>(key: string): Promise<ScmOperationRecord<T> | null> {
    const binding = parseKey(key);
    return this.#transaction(binding.tenantId, async (client) => {
      const selected = await client.query<OperationRow>(SELECT, [key]);
      if (selected.rows.length === 0) return null;
      const row = selected.rows[0]; if (!row || selected.rows.length !== 1) invalid(); assertRow(row, binding, undefined);
      return Object.freeze({ requestDigest: row.request_digest, response: row.response as T | null,
        claimToken: row.claim_token, claimExpiresAt: row.claim_expires_at });
    });
  }

  async acquire<T>(input: Parameters<ScmOperationStore["acquire"]>[0]) {
    const binding = parseKey(input.key); if (!SHA256.test(input.requestDigest) || !UUID.test(input.claimToken)) invalid();
    const claimedAt = validTime(input.claimedAt); const expiresAt = validTime(input.claimExpiresAt);
    if (Date.parse(expiresAt) - Date.parse(claimedAt) < 30_000 || Date.parse(expiresAt) - Date.parse(claimedAt) > 10 * 60_000) invalid();
    return this.#transaction(binding.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.scm_operation_claims
          (operation_key, tenant_id, project_id, operation, request_digest,
           claim_token, claim_expires_at, authorized_at)
         VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::timestamptz, $8::timestamptz)
         ON CONFLICT (operation_key) DO NOTHING`,
        [input.key, binding.tenantId, binding.projectId, binding.operation, input.requestDigest,
          input.claimToken, expiresAt, claimedAt],
      );
      let row = only(await client.query<OperationRow>(`${SELECT} FOR UPDATE`, [input.key]));
      assertRow(row, binding, input.requestDigest);
      if (row.response !== null) return Object.freeze({ status: "COMPLETED" as const, response: row.response as T });
      if (row.claim_token !== input.claimToken && Date.parse(row.claim_expires_at) > Date.parse(claimedAt)) {
        return Object.freeze({ status: "BUSY" as const });
      }
      if (row.claim_token !== input.claimToken) {
        const updated = await client.query(
          `UPDATE deviludo.scm_operation_claims
              SET claim_token = $3::uuid, claim_expires_at = $4::timestamptz
            WHERE operation_key = $1 AND request_digest = $2 AND response IS NULL
              AND claim_expires_at <= $5::timestamptz RETURNING operation_key`,
          [input.key, input.requestDigest, input.claimToken, expiresAt, claimedAt],
        );
        if (updated.rowCount !== 1) invalid();
        row = { ...row, claim_token: input.claimToken, claim_expires_at: expiresAt };
      }
      return Object.freeze({ status: "ACQUIRED" as const, claimToken: row.claim_token });
    });
  }

  async complete<T>(input: Readonly<{ key: string; requestDigest: string; claimToken: string; response: T }>): Promise<void> {
    const binding = parseKey(input.key); if (!SHA256.test(input.requestDigest) || !UUID.test(input.claimToken)
      || !input.response || typeof input.response !== "object") invalid();
    await this.#transaction(binding.tenantId, async (client) => {
      const row = only(await client.query<OperationRow>(`${SELECT} FOR UPDATE`, [input.key]));
      assertRow(row, binding, input.requestDigest);
      if (row.response !== null) {
        if (sha256Canonical(row.response) !== sha256Canonical(input.response)) invalid();
        return;
      }
      const updated = await client.query(
        `UPDATE deviludo.scm_operation_claims
            SET response = $4::jsonb, completed_at = now()
          WHERE operation_key = $1 AND request_digest = $2 AND claim_token = $3::uuid
            AND claim_expires_at > now() AND response IS NULL RETURNING operation_key`,
        [input.key, input.requestDigest, input.claimToken, JSON.stringify(input.response)],
      );
      if (updated.rowCount !== 1) invalid();
    });
  }

  async probe(): Promise<void> { const client = await this.pool.connect(); try { await client.query("SELECT 1 AS scm_operation_probe"); } finally { client.release(); } }

  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const value = await operation(client); await client.query("COMMIT"); return value;
    } catch (error) { try { await client.query("ROLLBACK"); } catch { /* preserve original */ } throw error; }
    finally { client.release(); }
  }
}

const SELECT = `SELECT operation_key, tenant_id::text, project_id::text, operation,
                       request_digest, claim_token::text, claim_expires_at::text, response
                  FROM deviludo.scm_operation_claims WHERE operation_key = $1`;
function parseKey(key: string): Readonly<{ tenantId: string; projectId: string; operation: "PUBLISH_CANDIDATE" | "MERGE_ACCEPTED_CANDIDATE" }> {
  const match = /^github:(publish|merge):([a-f0-9-]{36}):([a-f0-9-]{36}):(.{1,200})$/i.exec(key);
  if (!match?.[1] || !match[2] || !match[3] || !UUID.test(match[2]) || !UUID.test(match[3])) invalid();
  const idempotency = match[4];
  if (!idempotency || idempotency.length > 160 || /[\u0000-\u0020]/.test(idempotency)) invalid();
  return Object.freeze({ tenantId: match[2], projectId: match[3],
    operation: match[1] === "publish" ? "PUBLISH_CANDIDATE" : "MERGE_ACCEPTED_CANDIDATE" });
}
function assertRow(row: OperationRow, binding: ReturnType<typeof parseKey>, digest: string | undefined): void {
  if (row.tenant_id !== binding.tenantId || row.project_id !== binding.projectId || row.operation !== binding.operation
    || !SHA256.test(row.request_digest) || digest !== undefined && row.request_digest !== digest
    || !UUID.test(row.claim_token) || !Number.isFinite(Date.parse(row.claim_expires_at))) invalid();
}
function only<T extends Record<string, unknown>>(result: { rows: readonly T[] }): T { if (result.rows.length !== 1 || !result.rows[0]) invalid(); return result.rows[0]; }
function validTime(value: string): string { if (!Number.isFinite(Date.parse(value))) invalid(); return value; }
function invalid(): never { throw new Error("PostgreSQL SCM operation store is invalid"); }
