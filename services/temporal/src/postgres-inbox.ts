import type { DeliveryActivityReceipt } from "./contracts";
import type { WorkflowCommandInbox } from "./receiver";

export interface PostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresWorkflowClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
  release(): void;
}

export interface PostgresWorkflowPool {
  connect(): Promise<PostgresWorkflowClient>;
}

type InboxRow = {
  request_digest: string;
  claim_token: string | null;
  claim_active: boolean;
  receipt: unknown | null;
};

/**
 * PostgreSQL/RLS implementation of the destination-side command claim.
 * A node-postgres Pool can be injected without coupling this package to one
 * concrete driver. Each method opens a transaction and sets the authorized
 * tenant with SET LOCAL semantics before touching tenant rows.
 */
export class PostgresWorkflowCommandInbox implements WorkflowCommandInbox {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async acquire(
    input: Parameters<WorkflowCommandInbox["acquire"]>[0],
  ): Promise<Awaited<ReturnType<WorkflowCommandInbox["acquire"]>>> {
    return this.#transaction(input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.workflow_command_inbox
          (idempotency_key, tenant_id, project_id, workflow_id, destination,
           operation, request_digest, claim_token, claim_expires_at)
         VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9::timestamptz)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
        [
          input.idempotencyKey,
          input.tenantId,
          input.projectId,
          input.workflowId,
          input.destination,
          input.operation,
          input.requestDigest,
          input.claimToken,
          input.claimExpiresAt,
        ],
      );
      const selected = await client.query<InboxRow>(
        `SELECT request_digest, claim_token,
                COALESCE(claim_expires_at > now(), false) AS claim_active,
                receipt
           FROM deviludo.workflow_command_inbox
          WHERE tenant_id = $2::uuid
            AND idempotency_key = $1
          FOR UPDATE`,
        [input.idempotencyKey, input.tenantId],
      );
      const row = selected.rows[0];
      if (!row) throw new Error("Workflow command claim is not visible in the authorized tenant");
      if (row.request_digest !== input.requestDigest) {
        throw new Error("Workflow idempotency key was reused with another request");
      }
      if (row.receipt !== null) return { kind: "COMPLETED", receipt: parseReceipt(row.receipt) };
      if (row.claim_token === input.claimToken) return { kind: "ACQUIRED" };
      if (row.claim_token && row.claim_active) return { kind: "BUSY" };
      const reclaimed = await client.query(
        `UPDATE deviludo.workflow_command_inbox
            SET claim_token = $3::uuid, claim_expires_at = $4::timestamptz,
                updated_at = now()
          WHERE tenant_id = $2::uuid
            AND idempotency_key = $1
            AND request_digest = $5
            AND receipt_id IS NULL
            AND (claim_token IS NULL OR claim_expires_at <= now())
        RETURNING idempotency_key`,
        [input.idempotencyKey, input.tenantId, input.claimToken, input.claimExpiresAt, input.requestDigest],
      );
      if (reclaimed.rowCount !== 1) return { kind: "BUSY" };
      return { kind: "ACQUIRED" };
    });
  }

  async complete(input: Parameters<WorkflowCommandInbox["complete"]>[0]): Promise<void> {
    await this.#transaction(input.tenantId, async (client) => {
      const completed = await client.query(
        `UPDATE deviludo.workflow_command_inbox
            SET claim_token = NULL, claim_expires_at = NULL,
                receipt_id = $5::uuid, receipt = $6::jsonb,
                accepted_at = $7::timestamptz, updated_at = now()
          WHERE tenant_id = $2::uuid
            AND idempotency_key = $1
            AND request_digest = $3
            AND claim_token = $4::uuid
            AND receipt_id IS NULL
        RETURNING idempotency_key`,
        [
          input.idempotencyKey,
          input.tenantId,
          input.requestDigest,
          input.claimToken,
          input.receipt.receiptId,
          JSON.stringify(input.receipt),
          input.receipt.acceptedAt,
        ],
      );
      if (completed.rowCount !== 1) throw new Error("Workflow command claim was lost before receipt persistence");
    });
  }

  async release(input: Parameters<WorkflowCommandInbox["release"]>[0]): Promise<void> {
    await this.#transaction(input.tenantId, async (client) => {
      const released = await client.query(
        `UPDATE deviludo.workflow_command_inbox
            SET claim_token = NULL, claim_expires_at = NULL, updated_at = now()
          WHERE tenant_id = $2::uuid
            AND idempotency_key = $1
            AND request_digest = $3
            AND claim_token = $4::uuid
            AND receipt_id IS NULL
        RETURNING idempotency_key`,
        [input.idempotencyKey, input.tenantId, input.requestDigest, input.claimToken],
      );
      if (released.rowCount !== 1) throw new Error("Workflow command claim was lost before release");
    });
  }

  async #transaction<T>(
    tenantId: string,
    operation: (client: PostgresWorkflowClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the operation error; the pool discards broken connections.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

function parseReceipt(value: unknown): DeliveryActivityReceipt {
  const candidate = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!candidate || typeof candidate !== "object") throw new Error("Stored workflow receipt is invalid");
  const receipt = candidate as Record<string, unknown>;
  if (
    typeof receipt.receiptId !== "string" ||
    typeof receipt.acceptedAt !== "string" ||
    typeof receipt.destination !== "string" ||
    typeof receipt.workflowId !== "string" ||
    typeof receipt.idempotencyKey !== "string" ||
    typeof receipt.operation !== "string"
  ) {
    throw new Error("Stored workflow receipt is invalid");
  }
  return Object.freeze({ ...receipt }) as unknown as DeliveryActivityReceipt;
}
