import { randomUUID } from "node:crypto";
import type { GitHubBrokerRequestLedger } from "./github-auth-http";
import type { ScmPostgresClient, ScmPostgresPool } from "./github-auth-postgres";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OPERATIONS = new Set(["BEGIN", "SETUP", "COMPLETE"]);

type LedgerRow = Record<string, unknown> & {
  operation: string;
  request_digest: string;
  status: "CLAIMED" | "COMPLETED";
  claim_token: string | null;
  claim_active: boolean;
};

/**
 * Durable anti-replay ledger. It deliberately persists no response because
 * BEGIN/SETUP responses carry raw OAuth state. A completed retry must restart
 * the browser authorization instead of recovering secret-bearing state.
 */
export class PostgresGitHubBrokerRequestLedger implements GitHubBrokerRequestLedger {
  constructor(
    private readonly pool: ScmPostgresPool,
    private readonly claimLifetimeSeconds = 120,
  ) {
    if (!Number.isSafeInteger(claimLifetimeSeconds) || claimLifetimeSeconds < 30 || claimLifetimeSeconds > 600) invalid();
  }

  async execute<T extends Readonly<Record<string, unknown>>>(input: {
    readonly tenantId: string;
    readonly operationName: "BEGIN" | "SETUP" | "COMPLETE";
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly operation: () => Promise<T>;
  }): Promise<T> {
    validate(input);
    const claimToken = randomUUID();
    await this.#claim({ ...input, claimToken });
    try {
      const result = await input.operation();
      assertSafeResult(result);
      await this.#complete(input, claimToken);
      return result;
    } catch (error) {
      await this.#release(input.tenantId, input.idempotencyKey, claimToken).catch(() => undefined);
      throw error;
    }
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ ledger: string | null }>(
        "SELECT to_regclass('deviludo.github_authorization_request_ledger')::text AS ledger",
      );
      if (result.rows[0]?.ledger !== "deviludo.github_authorization_request_ledger") invalid();
    } finally { client.release(); }
  }

  async #claim(input: {
    tenantId: string; operationName: string; idempotencyKey: string; requestDigest: string; claimToken: string;
  }): Promise<void> {
    await this.#transaction(input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.github_authorization_request_ledger
          (tenant_id, idempotency_key, operation, request_digest, status, claim_token, claim_expires_at)
         VALUES ($1::uuid, $2, $3, $4, 'CLAIMED', $5::uuid,
                 now() + ($6::integer * interval '1 second'))
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
        [input.tenantId, input.idempotencyKey, input.operationName, input.requestDigest, input.claimToken, this.claimLifetimeSeconds],
      );
      const selected = await client.query<LedgerRow>(
        `SELECT operation, request_digest, status, claim_token::text,
                COALESCE(claim_expires_at > now(), false) AS claim_active
           FROM deviludo.github_authorization_request_ledger
          WHERE tenant_id = $1::uuid AND idempotency_key = $2
          FOR UPDATE`,
        [input.tenantId, input.idempotencyKey],
      );
      const row = selected.rows[0];
      if (!row || row.operation !== input.operationName || row.request_digest !== input.requestDigest) {
        throw new Error("GitHub broker idempotency key was reused with another request");
      }
      if (row.status === "COMPLETED") {
        throw new Error("GitHub broker idempotency key was already completed; restart authorization");
      }
      if (row.claim_token === input.claimToken) return;
      if (row.status !== "CLAIMED" || row.claim_active) {
        throw new Error("GitHub broker idempotency key is currently processing");
      }
      const reclaimed = await client.query(
        `UPDATE deviludo.github_authorization_request_ledger
            SET claim_token = $3::uuid,
                claim_expires_at = now() + ($4::integer * interval '1 second')
          WHERE tenant_id = $1::uuid AND idempotency_key = $2
            AND status = 'CLAIMED' AND claim_expires_at <= now()`,
        [input.tenantId, input.idempotencyKey, input.claimToken, this.claimLifetimeSeconds],
      );
      if (reclaimed.rowCount !== 1) throw new Error("GitHub broker idempotency key is currently processing");
    });
  }

  async #complete(input: { tenantId: string; idempotencyKey: string }, claimToken: string): Promise<void> {
    await this.#transaction(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE deviludo.github_authorization_request_ledger
            SET status = 'COMPLETED', claim_token = NULL,
                claim_expires_at = NULL, completed_at = now()
          WHERE tenant_id = $1::uuid AND idempotency_key = $2
            AND status = 'CLAIMED' AND claim_token = $3::uuid
            AND claim_expires_at > now()`,
        [input.tenantId, input.idempotencyKey, claimToken],
      );
      if (result.rowCount !== 1) throw new Error("GitHub broker idempotency claim expired before completion");
    });
  }

  async #release(tenantId: string, idempotencyKey: string, claimToken: string): Promise<void> {
    await this.#transaction(tenantId, async (client) => {
      await client.query(
        `DELETE FROM deviludo.github_authorization_request_ledger
          WHERE tenant_id = $1::uuid AND idempotency_key = $2
            AND status = 'CLAIMED' AND claim_token = $3::uuid`,
        [tenantId, idempotencyKey, claimToken],
      );
    });
  }

  async #transaction<T>(tenantId: string, operation: (client: ScmPostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
      throw error;
    } finally { client.release(); }
  }
}

function validate(input: { tenantId: string; operationName: string; idempotencyKey: string; requestDigest: string }): void {
  if (!UUID.test(input.tenantId) || !OPERATIONS.has(input.operationName) || !KEY.test(input.idempotencyKey) || !SHA256.test(input.requestDigest)) invalid();
}

function assertSafeResult(value: Readonly<Record<string, unknown>>): void {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 64 * 1024) invalid();
}

function invalid(): never { throw new Error("GitHub authorization request ledger binding is invalid"); }
