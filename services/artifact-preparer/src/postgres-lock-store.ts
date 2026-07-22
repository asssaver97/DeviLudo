import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { parseRunnerExecutionLock, runnerExecutionLockDigest } from "../../runner-control/src/execution-lock";
import type { RunnerExecutionLockPort } from "./preparer";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

type LockRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  run_id: string;
  lock_key: string;
  payload: unknown;
  payload_digest: string;
};

/** Transactional append-only execution-lock store under the caller's tenant RLS scope. */
export class PostgresRunnerExecutionLockPort implements RunnerExecutionLockPort {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async persist(input: Parameters<RunnerExecutionLockPort["persist"]>[0]): Promise<Awaited<ReturnType<RunnerExecutionLockPort["persist"]>>> {
    const payload = parseRunnerExecutionLock(input.payload);
    const payloadDigest = runnerExecutionLockDigest(payload);
    if (!UUID.test(input.tenantId) || !UUID.test(input.projectId) || !UUID.test(input.runId)
      || !SHA256.test(input.lockKey) || !SHA256.test(input.payloadDigest)
      || input.payloadDigest !== payloadDigest
      || payload.tenantId !== input.tenantId || payload.projectId !== input.projectId || payload.runId !== input.runId) {
      invalid();
    }
    return this.#transaction(input.tenantId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO deviludo.runner_execution_locks
          (tenant_id, project_id, run_id, lock_key, mode, commit_sha,
           source_digest, steam_build_id, target_matrix, payload, payload_digest)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
                 $9::text[], $10::jsonb, $11)
         ON CONFLICT (tenant_id, lock_key) DO NOTHING`,
        [
          input.tenantId,
          input.projectId,
          input.runId,
          input.lockKey,
          payload.mode,
          payload.commitSha,
          payload.sourceDigest,
          payload.steamBuildId,
          payload.targetMatrix,
          JSON.stringify(payload),
          payloadDigest,
        ],
      );
      const selected = await client.query<LockRow>(
        `SELECT id::text, tenant_id::text, project_id::text, run_id::text,
                lock_key, payload, payload_digest
           FROM deviludo.runner_execution_locks
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
            AND run_id = $3::uuid AND lock_key = $4
          FOR SHARE`,
        [input.tenantId, input.projectId, input.runId, input.lockKey],
      );
      if (selected.rows.length !== 1) invalid();
      const row = selected.rows[0]!;
      let stored;
      try { stored = parseRunnerExecutionLock(row.payload); }
      catch { invalid(); }
      if (!UUID.test(row.id) || row.tenant_id !== input.tenantId || row.project_id !== input.projectId
        || row.run_id !== input.runId || row.lock_key !== input.lockKey
        || row.payload_digest !== payloadDigest || runnerExecutionLockDigest(stored) !== payloadDigest) invalid();
      return Object.freeze({
        executionLockId: row.id,
        payloadDigest,
        created: inserted.rowCount === 1,
      });
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ runner_execution_locks?: unknown }>(
        "SELECT to_regclass('deviludo.runner_execution_locks')::text AS runner_execution_locks",
      );
      if (result.rows[0]?.runner_execution_locks !== "deviludo.runner_execution_locks") invalid();
    } finally { client.release(); }
  }

  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

function invalid(): never {
  throw new Error("Artifact preparation execution lock persistence is invalid");
}
