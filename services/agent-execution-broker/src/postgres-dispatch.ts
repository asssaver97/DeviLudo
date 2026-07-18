import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { AgentExecutionOperationDispatcher } from "./operations";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export interface AgentExecutionOperationSource {
  next(tenantId: string): Promise<Readonly<{ tenantId: string; runId: string }> | null>;
  probe(): Promise<void>;
}

/** Durable outbox. Polling exposes only tenant + run identities, never lock or secret material. */
export class PostgresAgentExecutionDispatch implements AgentExecutionOperationDispatcher, AgentExecutionOperationSource {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async enqueue(input: Parameters<AgentExecutionOperationDispatcher["enqueue"]>[0]): Promise<void> {
    validate(input.tenantId, input.runId);
    await this.#transaction(input.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE deviludo.agent_execution_operations
            SET enqueue_count = enqueue_count + 1,
                last_enqueued_at = GREATEST(created_at, now()),
                available_at = CASE WHEN state = 'QUEUED'
                  THEN LEAST(available_at, GREATEST(created_at, now())) ELSE available_at END,
                updated_at = now()
          WHERE tenant_id = $1::uuid AND run_id = $2::uuid
            AND operation_key = $3 AND request_digest = $4
            AND state IN ('QUEUED', 'RUNNING')
        RETURNING run_id`,
        [input.tenantId, input.runId, input.operationKey, input.requestDigest],
      );
      if (updated.rowCount !== 1) invalid();
    });
  }

  async next(tenantId: string): Promise<Readonly<{ tenantId: string; runId: string }> | null> {
    validate(tenantId, tenantId);
    return this.#transaction(tenantId, async (client) => {
      const selected = await client.query<{ tenant_id: string; run_id: string }>(
        `SELECT tenant_id::text, run_id::text
           FROM deviludo.agent_execution_operations
          WHERE tenant_id = $1::uuid
            AND available_at <= now() AND (retry_at IS NULL OR retry_at <= now())
            AND (state = 'QUEUED' OR (state = 'RUNNING' AND claim_expires_at <= now()))
          ORDER BY available_at, updated_at, run_id
          FOR UPDATE SKIP LOCKED LIMIT 1`,
        [tenantId],
      );
      const row = selected.rows[0];
      if (!row) return null;
      if (row.tenant_id !== tenantId || !UUID.test(row.run_id)) invalid();
      return Object.freeze({ tenantId, runId: row.run_id });
    });
  }

  async probe(): Promise<void> { const client = await this.pool.connect(); try { await client.query("SELECT 1 AS agent_execution_dispatch_probe"); } finally { client.release(); } }

  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client); await client.query("COMMIT"); return result;
    } catch (error) { try { await client.query("ROLLBACK"); } catch { /* preserve original */ } throw error; }
    finally { client.release(); }
  }
}

function validate(tenantId: string, runId: string): void { if (!UUID.test(tenantId) || !UUID.test(runId)) invalid(); }
function invalid(): never { throw new Error("Agent execution dispatch is invalid"); }
