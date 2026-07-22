import { createHash, randomUUID } from "node:crypto";
import type { DeliverySignal } from "../../temporal/src/contracts";
import { assertDeliverySignal } from "../../temporal/src/contracts";
import type { WorkflowSignalPort } from "../../temporal/src/job-processor";
import type {
  WorkflowJobProcessResult,
  WorkflowJobProcessorPort,
} from "../../temporal/src/job-worker-host";
import type {
  PostgresWorkflowClient,
  PostgresWorkflowPool,
} from "../../temporal/src/postgres-inbox";
import { probePostgresRelations } from "../../temporal/src/postgres-readiness";

type OutboxRow = {
  id: string;
  tenant_id: string;
  workflow_id: string;
  signal_id: string;
  signal_digest: string;
  signal: unknown;
  attempt: number;
  claim_token: string;
};

export interface ClaimedWorkflowSignal {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly signalId: string;
  readonly signalDigest: string;
  readonly signal: DeliverySignal;
  readonly attempt: number;
  readonly claimToken: string;
}

export interface WorkflowSignalOutboxPort {
  claimNext(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly leaseSeconds: number;
  }): Promise<ClaimedWorkflowSignal | null>;
  complete(input: {
    readonly tenantId: string;
    readonly outboxId: string;
    readonly claimToken: string;
  }): Promise<void>;
  fail(input: {
    readonly tenantId: string;
    readonly outboxId: string;
    readonly claimToken: string;
    readonly retryAt: string;
    readonly errorCode: string;
  }): Promise<void>;
}

export class PostgresWorkflowSignalOutbox implements WorkflowSignalOutboxPort {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async probe(): Promise<void> {
    await probePostgresRelations(
      this.pool,
      ["workflow_signal_outbox"],
      () => new Error("Workflow signal outbox PostgreSQL schema is not ready"),
    );
  }

  async claimNext(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly leaseSeconds: number;
  }): Promise<ClaimedWorkflowSignal | null> {
    validateWorker(input.workerId, input.leaseSeconds);
    const claimToken = randomUUID();
    return this.#transaction(input.tenantId, async (client) => {
      const result = await client.query<OutboxRow>(
        `WITH candidate AS (
           SELECT id
             FROM deviludo.workflow_signal_outbox
            WHERE tenant_id = $1::uuid AND available_at <= now()
              AND (state IN ('PENDING', 'RETRYABLE_FAILED')
                OR (state = 'DELIVERING' AND claim_expires_at <= now()))
            ORDER BY available_at, created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE deviludo.workflow_signal_outbox AS item
            SET state = 'DELIVERING', attempt = item.attempt + 1,
                claimed_by = $2, claim_token = $3::uuid,
                claim_expires_at = now() + ($4::int * interval '1 second'),
                error_code = NULL, updated_at = now()
           FROM candidate
          WHERE item.id = candidate.id
        RETURNING item.id, item.tenant_id, item.workflow_id, item.signal_id,
                  item.signal_digest, item.signal, item.attempt, item.claim_token`,
        [input.tenantId, input.workerId, claimToken, input.leaseSeconds],
      );
      return result.rows[0] ? parseClaim(result.rows[0], input.tenantId) : null;
    });
  }

  async complete(input: {
    readonly tenantId: string;
    readonly outboxId: string;
    readonly claimToken: string;
  }): Promise<void> {
    await this.#transaction(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE deviludo.workflow_signal_outbox
            SET state = 'DELIVERED', claimed_by = NULL, claim_token = NULL,
                claim_expires_at = NULL, delivered_at = now(), updated_at = now()
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND state = 'DELIVERING' AND claim_token = $3::uuid
        RETURNING id`,
        [input.tenantId, input.outboxId, input.claimToken],
      );
      if (result.rowCount !== 1) throw new Error("Workflow signal outbox claim was lost before completion");
    });
  }

  async fail(input: {
    readonly tenantId: string;
    readonly outboxId: string;
    readonly claimToken: string;
    readonly retryAt: string;
    readonly errorCode: string;
  }): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{2,99}$/.test(input.errorCode)
      || !Number.isFinite(Date.parse(input.retryAt))) {
      throw new Error("Workflow signal outbox retry binding is invalid");
    }
    await this.#transaction(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE deviludo.workflow_signal_outbox
            SET state = 'RETRYABLE_FAILED', claimed_by = NULL,
                claim_token = NULL, claim_expires_at = NULL,
                available_at = $4::timestamptz, error_code = $5, updated_at = now()
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND state = 'DELIVERING' AND claim_token = $3::uuid
        RETURNING id`,
        [input.tenantId, input.outboxId, input.claimToken, input.retryAt, input.errorCode],
      );
      if (result.rowCount !== 1) throw new Error("Workflow signal outbox claim was lost before failure recording");
    });
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
      try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

export class WorkflowSignalOutboxProcessor implements WorkflowJobProcessorPort {
  constructor(
    private readonly outbox: WorkflowSignalOutboxPort,
    private readonly signals: WorkflowSignalPort,
    private readonly workerId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    validateWorker(workerId, 60);
  }

  async processOne(tenantId: string): Promise<WorkflowJobProcessResult> {
    const item = await this.outbox.claimNext({ tenantId, workerId: this.workerId, leaseSeconds: 60 });
    if (!item) return Object.freeze({ kind: "IDLE" as const });
    try {
      await this.signals.signal(item.workflowId, item.signal);
      await this.outbox.complete({ tenantId, outboxId: item.id, claimToken: item.claimToken });
      return Object.freeze({ kind: "COMPLETED" as const, jobId: item.id, signalId: item.signalId });
    } catch {
      const at = this.now();
      if (!Number.isFinite(at.getTime())) throw new Error("Workflow signal outbox clock is invalid");
      const retryAt = new Date(at.getTime() + Math.min(15 * 60_000, 5_000 * (2 ** Math.min(item.attempt - 1, 8))));
      await this.outbox.fail({
        tenantId,
        outboxId: item.id,
        claimToken: item.claimToken,
        retryAt: retryAt.toISOString(),
        errorCode: "TEMPORAL_SIGNAL_FAILED",
      });
      return Object.freeze({
        kind: "FAILED" as const,
        jobId: item.id,
        terminal: false,
        errorCode: "TEMPORAL_SIGNAL_FAILED",
      });
    }
  }
}

function parseClaim(row: OutboxRow, tenantId: string): ClaimedWorkflowSignal {
  const signal = (typeof row.signal === "string" ? JSON.parse(row.signal) as unknown : row.signal) as DeliverySignal;
  assertDeliverySignal(signal);
  if (row.tenant_id !== tenantId || row.signal_id !== signal.signalId
    || !/^[a-f0-9]{64}$/.test(row.signal_digest) || row.signal_digest !== signalDigest(signal)
    || !Number.isSafeInteger(row.attempt) || row.attempt < 1
    || !isUuid(row.id) || !isUuid(row.claim_token)) {
    throw new Error("Claimed workflow signal outbox binding is invalid");
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    signalId: row.signal_id,
    signalDigest: row.signal_digest,
    signal: Object.freeze({ ...signal }),
    attempt: row.attempt,
    claimToken: row.claim_token,
  });
}

function signalDigest(value: DeliverySignal): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function validateWorker(workerId: string, leaseSeconds: number): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(workerId)
    || !Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
    throw new Error("Workflow signal outbox worker configuration is invalid");
  }
}
