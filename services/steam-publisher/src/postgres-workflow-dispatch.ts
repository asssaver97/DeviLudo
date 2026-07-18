import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { SteamWorkflowOperationDispatcher } from "./workflow-broker-operations";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OPERATION_KEY = /^workflow-job:[a-f0-9-]{36}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface SteamWorkflowOperationSource {
  next(tenantId: string): Promise<Readonly<{ tenantId: string; operationId: string }> | null>;
  probe(): Promise<void>;
}

/**
 * Durable PostgreSQL outbox used by both the credential-free Broker and the
 * isolated executor. The polling result intentionally contains no request or
 * Steam account material; the Worker resolves the operation under tenant RLS.
 */
export class PostgresSteamWorkflowOperationDispatch
implements SteamWorkflowOperationDispatcher, SteamWorkflowOperationSource {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async enqueue(input: Readonly<{
    tenantId: string;
    operationId: string;
    operationKey: string;
    requestDigest: string;
  }>): Promise<void> {
    validateBinding(input);
    await this.#transaction(input.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE deviludo.steam_workflow_operations
            SET enqueue_count = enqueue_count + 1,
                last_enqueued_at = GREATEST(created_at, now()),
                available_at = CASE WHEN state = 'PENDING'
                  THEN LEAST(available_at, GREATEST(created_at, now()))
                  ELSE available_at END,
                updated_at = now()
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND operation_key = $3 AND request_digest = $4
            AND state IN ('PENDING', 'RUNNING')
        RETURNING id`,
        [input.tenantId, input.operationId, input.operationKey, input.requestDigest],
      );
      if (updated.rowCount !== 1) invalid();
    });
  }

  async next(tenantId: string): Promise<Readonly<{ tenantId: string; operationId: string }> | null> {
    validateUuid(tenantId);
    return this.#transaction(tenantId, async (client) => {
      const selected = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id::text, tenant_id::text
           FROM deviludo.steam_workflow_operations
          WHERE tenant_id = $1::uuid
            AND available_at <= now()
            AND (state = 'PENDING'
              OR (state = 'RUNNING' AND claim_expires_at <= now()))
          ORDER BY available_at, updated_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [tenantId],
      );
      const row = selected.rows[0];
      if (!row) return null;
      if (row.tenant_id !== tenantId || !UUID.test(row.id)) invalid();
      return Object.freeze({ tenantId, operationId: row.id });
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
    validateUuid(tenantId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve dispatch failure */ }
      throw error;
    } finally { client.release(); }
  }
}

function validateBinding(input: Readonly<{
  tenantId: string;
  operationId: string;
  operationKey: string;
  requestDigest: string;
}>): void {
  validateUuid(input.tenantId);
  validateUuid(input.operationId);
  if (!OPERATION_KEY.test(input.operationKey) || !SHA256.test(input.requestDigest)) invalid();
}

function validateUuid(value: string): void { if (!UUID.test(value)) invalid(); }
function invalid(): never { throw new Error("Steam workflow dispatch is invalid"); }
