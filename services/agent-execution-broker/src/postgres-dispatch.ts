import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { AgentExecutionOperationDispatcher } from "./operations";
import { parseAgentExecutionWorkerBinding, type AgentExecutionWorkerBinding } from "./worker-binding";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export interface AgentExecutionOperationSource {
  next(tenantId: string, binding: AgentExecutionWorkerBinding): Promise<Readonly<{ tenantId: string; runId: string }> | null>;
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

  async next(tenantId: string, input: AgentExecutionWorkerBinding): Promise<Readonly<{ tenantId: string; runId: string }> | null> {
    validate(tenantId, tenantId);
    const binding = parseAgentExecutionWorkerBinding(input);
    return this.#transaction(tenantId, async (client) => {
      const selected = await client.query<{
        tenant_id: string; run_id: string; effective_installation_id: string; effective_worker_pool: string;
        effective_image_digest: string; effective_agent_version: string; effective_adapter_version: string; effective_agent: string;
      }>(
        `SELECT operation.tenant_id::text, operation.run_id::text,
                CASE WHEN failover.run_id IS NULL THEN run.installation_id
                  ELSE run.configuration_lock->'fallback'->>'installationId' END AS effective_installation_id,
                CASE WHEN failover.run_id IS NULL THEN run.configuration_lock->>'workerPool'
                  ELSE run.configuration_lock->'fallback'->>'workerPool' END AS effective_worker_pool,
                CASE WHEN failover.run_id IS NULL THEN run.image_digest
                  ELSE run.configuration_lock->'fallback'->>'imageDigest' END AS effective_image_digest,
                CASE WHEN failover.run_id IS NULL THEN run.exact_agent_version
                  ELSE run.configuration_lock->'fallback'->>'exactAgentVersion' END AS effective_agent_version,
                CASE WHEN failover.run_id IS NULL THEN run.adapter_version
                  ELSE run.configuration_lock->'fallback'->>'adapterVersion' END AS effective_adapter_version,
                CASE WHEN failover.run_id IS NULL THEN run.configuration_lock->>'agent'
                  ELSE run.configuration_lock->'fallback'->>'agent' END AS effective_agent
           FROM deviludo.agent_execution_operations operation
           JOIN deviludo.agent_runs run
             ON run.tenant_id = operation.tenant_id AND run.id = operation.run_id
           LEFT JOIN deviludo.agent_run_provider_failovers failover
             ON failover.tenant_id = run.tenant_id AND failover.run_id = run.id
          WHERE operation.tenant_id = $1::uuid
            AND operation.available_at <= now() AND (operation.retry_at IS NULL OR operation.retry_at <= now())
            AND (operation.state = 'QUEUED' OR (operation.state = 'RUNNING' AND operation.claim_expires_at <= now()))
            AND CASE WHEN failover.run_id IS NULL THEN run.installation_id
              ELSE run.configuration_lock->'fallback'->>'installationId' END = ANY($2::text[])
            AND CASE WHEN failover.run_id IS NULL THEN run.configuration_lock->>'workerPool'
              ELSE run.configuration_lock->'fallback'->>'workerPool' END = $3
            AND CASE WHEN failover.run_id IS NULL THEN run.image_digest
              ELSE run.configuration_lock->'fallback'->>'imageDigest' END = $4
            AND CASE WHEN failover.run_id IS NULL THEN run.exact_agent_version
              ELSE run.configuration_lock->'fallback'->>'exactAgentVersion' END = $5
            AND CASE WHEN failover.run_id IS NULL THEN run.adapter_version
              ELSE run.configuration_lock->'fallback'->>'adapterVersion' END = $6
            AND CASE WHEN failover.run_id IS NULL THEN run.configuration_lock->>'agent'
              ELSE run.configuration_lock->'fallback'->>'agent' END = $7
          ORDER BY operation.available_at, operation.updated_at, operation.run_id
          FOR UPDATE SKIP LOCKED LIMIT 1`,
        [tenantId, binding.installationIds, binding.workerPool, binding.workerImageDigest,
          binding.exactAgentVersion, binding.adapterVersion, binding.agent],
      );
      const row = selected.rows[0];
      if (!row) return null;
      if (row.tenant_id !== tenantId || !UUID.test(row.run_id)
        || !binding.installationIds.includes(row.effective_installation_id)
        || row.effective_worker_pool !== binding.workerPool || row.effective_image_digest !== binding.workerImageDigest
        || row.effective_agent_version !== binding.exactAgentVersion
        || row.effective_adapter_version !== binding.adapterVersion || row.effective_agent !== binding.agent) invalid();
      return Object.freeze({ tenantId, runId: row.run_id });
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ agent_execution_operations?: unknown; agent_runs?: unknown;
        agent_run_provider_failovers?: unknown }>(
        `SELECT to_regclass('deviludo.agent_execution_operations')::text AS agent_execution_operations,
                to_regclass('deviludo.agent_runs')::text AS agent_runs,
                to_regclass('deviludo.agent_run_provider_failovers')::text AS agent_run_provider_failovers`,
      );
      if (result.rows[0]?.agent_execution_operations !== "deviludo.agent_execution_operations"
        || result.rows[0]?.agent_runs !== "deviludo.agent_runs"
        || result.rows[0]?.agent_run_provider_failovers !== "deviludo.agent_run_provider_failovers") invalid();
    } finally { client.release(); }
  }

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
