import { createHash, randomUUID } from "node:crypto";
import type { DeliveryDispatchRequest } from "./activities";
import type { DeliveryCommandDestination } from "./contracts";
import type {
  PostgresWorkflowClient,
  PostgresWorkflowPool,
} from "./postgres-inbox";
import {
  assertDeliveryDispatchRequest,
  deliveryDispatchRequestDigest,
  type WorkflowCommandHandler,
} from "./receiver";

export type WorkflowJobState =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "RETRYABLE_FAILED"
  | "TERMINAL_FAILED"
  | "CANCELLED";

export interface ClaimedWorkflowJob {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly destination: DeliveryCommandDestination;
  readonly operation: string;
  readonly requestDigest: string;
  readonly request: DeliveryDispatchRequest;
  readonly attempt: number;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
}

type JobRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  destination: string;
  operation: string;
  request_digest: string;
  request_body: unknown;
  state: WorkflowJobState;
  attempt: number;
  claim_token: string;
  claim_expires_at: string | Date;
  result?: unknown;
};

export class PostgresWorkflowCommandQueue implements WorkflowCommandHandler {
  constructor(
    private readonly pool: PostgresWorkflowPool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enqueue(request: DeliveryDispatchRequest): Promise<void> {
    assertDeliveryDispatchRequest(request, request.destination);
    const requestDigest = deliveryDispatchRequestDigest(request);
    await this.#transaction(request.payload.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.workflow_command_jobs
          (tenant_id, project_id, workflow_id, idempotency_key, destination,
           operation, request_digest, request_body)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
        [
          request.payload.tenantId,
          request.payload.projectId,
          request.payload.workflowId,
          request.payload.idempotencyKey,
          request.destination,
          operation(request),
          requestDigest,
          JSON.stringify(request),
        ],
      );
      const selected = await client.query<{ request_digest: string }>(
        `SELECT request_digest
           FROM deviludo.workflow_command_jobs
          WHERE tenant_id = $1::uuid AND idempotency_key = $2`,
        [request.payload.tenantId, request.payload.idempotencyKey],
      );
      if (selected.rows[0]?.request_digest !== requestDigest) {
        throw new Error("Workflow job idempotency binding mismatch");
      }
    });
  }

  async claimNext(input: {
    readonly tenantId: string;
    readonly destination: DeliveryCommandDestination;
    readonly workerId: string;
    readonly leaseSeconds?: number;
  }): Promise<ClaimedWorkflowJob | null> {
    validateWorkerId(input.workerId);
    const leaseSeconds = input.leaseSeconds ?? 300;
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
      throw new Error("Workflow job lease duration is invalid");
    }
    const claimToken = randomUUID();
    return this.#transaction(input.tenantId, async (client) => {
      const claimed = await client.query<JobRow>(
        `WITH candidate AS (
           SELECT id
             FROM deviludo.workflow_command_jobs
            WHERE tenant_id = $1::uuid
              AND destination = $2
              AND available_at <= now()
              AND (
                state IN ('QUEUED', 'RETRYABLE_FAILED')
                OR (state = 'RUNNING' AND claim_expires_at <= now())
              )
            ORDER BY available_at, created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE deviludo.workflow_command_jobs AS job
            SET state = 'RUNNING', attempt = job.attempt + 1,
                claimed_by = $3, claim_token = $4::uuid,
                claim_expires_at = now() + ($5::int * interval '1 second'),
                error_code = NULL, updated_at = now()
           FROM candidate
          WHERE job.id = candidate.id
        RETURNING job.id, job.tenant_id, job.project_id, job.workflow_id,
                  job.destination, job.operation, job.request_digest,
                  job.request_body, job.state, job.attempt,
                  job.claim_token, job.claim_expires_at`,
        [input.tenantId, input.destination, input.workerId, claimToken, leaseSeconds],
      );
      const row = claimed.rows[0];
      return row ? parseClaimedJob(row, input.destination) : null;
    });
  }

  async complete(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly claimToken: string;
    readonly result: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    validateResult(input.result);
    await this.#transaction(input.tenantId, async (client) => {
      const completedAt = this.#nowIso();
      const completed = await client.query(
        `UPDATE deviludo.workflow_command_jobs
            SET state = 'COMPLETED', claimed_by = NULL, claim_token = NULL,
                claim_expires_at = NULL, result = $4::jsonb,
                completed_at = $5::timestamptz, updated_at = now()
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND state = 'RUNNING' AND claim_token = $3::uuid
        RETURNING id`,
        [input.tenantId, input.jobId, input.claimToken, JSON.stringify(input.result), completedAt],
      );
      if (completed.rowCount === 1) return;
      const existing = await client.query<{ state: WorkflowJobState; result: unknown }>(
        `SELECT state, result FROM deviludo.workflow_command_jobs
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [input.tenantId, input.jobId],
      );
      const row = existing.rows[0];
      if (row?.state === "COMPLETED" && jsonDigest(row.result) === jsonDigest(input.result)) return;
      throw new Error("Workflow job claim was lost before completion");
    });
  }

  async fail(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly claimToken: string;
    readonly errorCode: string;
    readonly retryAt?: string;
    readonly terminal?: boolean;
  }): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{2,99}$/.test(input.errorCode)) throw new Error("Workflow job error code is invalid");
    const terminal = input.terminal === true;
    const recordedAt = this.#nowIso();
    const availableAt = terminal ? recordedAt : requireFutureRetry(input.retryAt, recordedAt);
    await this.#transaction(input.tenantId, async (client) => {
      const failed = await client.query(
        `UPDATE deviludo.workflow_command_jobs
            SET state = $4, claimed_by = NULL, claim_token = NULL,
                claim_expires_at = NULL, error_code = $5,
                available_at = $6::timestamptz,
                completed_at = $7::timestamptz, updated_at = now()
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND state = 'RUNNING' AND claim_token = $3::uuid
        RETURNING id`,
        [
          input.tenantId,
          input.jobId,
          input.claimToken,
          terminal ? "TERMINAL_FAILED" : "RETRYABLE_FAILED",
          input.errorCode,
          availableAt,
          terminal ? availableAt : null,
        ],
      );
      if (failed.rowCount !== 1) throw new Error("Workflow job claim was lost before failure recording");
    });
  }

  async cancel(input: {
    readonly tenantId: string;
    readonly jobId: string;
  }): Promise<boolean> {
    return this.#transaction(input.tenantId, async (client) => {
      const cancelled = await client.query(
        `UPDATE deviludo.workflow_command_jobs
            SET state = 'CANCELLED', claimed_by = NULL, claim_token = NULL,
                claim_expires_at = NULL, completed_at = $3::timestamptz,
                updated_at = now()
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND state IN ('QUEUED', 'RUNNING', 'RETRYABLE_FAILED')
        RETURNING id`,
        [input.tenantId, input.jobId, this.#nowIso()],
      );
      return cancelled.rowCount === 1;
    });
  }

  #nowIso(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) throw new Error("Workflow job clock is invalid");
    return value.toISOString();
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
      try { await client.query("ROLLBACK"); } catch { /* preserve the primary error */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

function parseClaimedJob(row: JobRow, expectedDestination: DeliveryCommandDestination): ClaimedWorkflowJob {
  if (row.destination !== expectedDestination || row.state !== "RUNNING" || !Number.isSafeInteger(row.attempt) || row.attempt < 1) {
    throw new Error("Claimed workflow job metadata is invalid");
  }
  const request = assertDeliveryDispatchRequest(parseJson(row.request_body), expectedDestination);
  if (
    row.tenant_id !== request.payload.tenantId ||
    row.project_id !== request.payload.projectId ||
    row.workflow_id !== request.payload.workflowId ||
    row.operation !== operation(request) ||
    row.request_digest !== deliveryDispatchRequestDigest(request) ||
    !row.claim_token ||
    !Number.isFinite(Date.parse(String(row.claim_expires_at)))
  ) {
    throw new Error("Claimed workflow job binding is invalid");
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    destination: expectedDestination,
    operation: row.operation,
    requestDigest: row.request_digest,
    request,
    attempt: row.attempt,
    claimToken: row.claim_token,
    claimExpiresAt: new Date(row.claim_expires_at).toISOString(),
  });
}

function operation(request: DeliveryDispatchRequest): string {
  return request.kind === "COMMAND" ? request.payload.command : "CANCEL_DELIVERY";
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { throw new Error("Workflow job request is invalid JSON"); }
}

function validateWorkerId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(value)) throw new Error("Workflow worker identity is invalid");
}

function validateResult(value: Readonly<Record<string, unknown>>): void {
  if (!value || Array.isArray(value)) throw new Error("Workflow job result is invalid");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1024 * 1024) throw new Error("Workflow job result exceeds the size limit");
}

function requireFutureRetry(value: string | undefined, after: string): string {
  if (!value || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.parse(after)) {
    throw new Error("Workflow job retry time is invalid");
  }
  return new Date(value).toISOString();
}

function jsonDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
