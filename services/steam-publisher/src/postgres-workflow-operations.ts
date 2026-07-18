import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import {
  parseSteamWorkflowOperationRequest,
  validateSteamWorkflowOperationStatus,
  type SteamWorkflowOperationLookup,
  type SteamWorkflowOperationRequest,
  type SteamWorkflowOperationStatus,
} from "./workflow-broker-http";
import type { SteamWorkflowOperationPersistence } from "./workflow-broker-operations";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,99}$/;

type OperationRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  submitter_spiffe_id: string;
  workflow_id: string;
  run_id: string;
  kind: string;
  operation_key: string;
  request_digest: string;
  payload_digest: string;
  request_payload: unknown;
  state: string;
  claim_token: string | null;
  claim_expires_at: string | null;
  attempt_count: number;
  receipt: unknown | null;
  error_code: string | null;
  terminal: boolean | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  available_at: string;
  last_enqueued_at: string;
  enqueue_count: number;
};

/** Tenant-RLS durable operation queue for isolated Steam execution workers. */
export class PostgresSteamWorkflowOperationPersistence implements SteamWorkflowOperationPersistence {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async reserve(input: Parameters<SteamWorkflowOperationPersistence["reserve"]>[0]) {
    const request = parseSteamWorkflowOperationRequest(input.request);
    validateUuid(input.operationId);
    validateSpiffe(input.submitterSpiffeId);
    const createdAt = validTime(input.createdAt);
    const payloadDigest = sha256Canonical(request);
    return this.#transaction(request.tenantId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO deviludo.steam_workflow_operations
          (id, tenant_id, project_id, submitter_spiffe_id, workflow_id, run_id,
           kind, operation_key, request_digest, payload_digest, request_payload,
           state, created_at, updated_at, available_at, last_enqueued_at, enqueue_count)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid,
                 $7, $8, $9, $10, $11::jsonb, 'PENDING',
                 $12::timestamptz, $12::timestamptz, $12::timestamptz,
                 $12::timestamptz, 1)
         ON CONFLICT (tenant_id, operation_key) DO NOTHING`,
        [input.operationId, request.tenantId, request.projectId, input.submitterSpiffeId,
          request.workflowId, request.runId, request.kind, request.operationKey,
          request.requestDigest, payloadDigest, JSON.stringify(request), createdAt],
      );
      const row = await selectByOperationKey(client, request.tenantId, request.operationKey);
      const parsed = parseRow(row);
      validateRequestBinding(parsed, request, input.submitterSpiffeId, payloadDigest);
      return Object.freeze({ created: inserted.rowCount === 1, status: statusFromRow(parsed) });
    });
  }

  async find(lookup: SteamWorkflowOperationLookup): Promise<SteamWorkflowOperationStatus> {
    validateLookup(lookup);
    return this.#transaction(lookup.tenantId, async (client) => {
      const selected = await client.query<OperationRow>(
        `${SELECT_OPERATION}
           FROM deviludo.steam_workflow_operations
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [lookup.tenantId, lookup.operationId],
      );
      if (selected.rows.length !== 1) invalid();
      const row = parseRow(selected.rows[0]!);
      if (row.operation_key !== lookup.operationKey || row.request_digest !== lookup.requestDigest) invalid();
      return statusFromRow(row);
    });
  }

  async claim(input: Parameters<SteamWorkflowOperationPersistence["claim"]>[0]) {
    validateTenantOperation(input.tenantId, input.operationId);
    validateUuid(input.claimToken);
    const claimedAt = validTime(input.claimedAt);
    const claimExpiresAt = validTime(input.claimExpiresAt);
    if (Date.parse(claimExpiresAt) - Date.parse(claimedAt) < 30_000
      || Date.parse(claimExpiresAt) - Date.parse(claimedAt) > 15 * 60_000) invalid();
    return this.#transaction(input.tenantId, async (client) => {
      const row = parseRow(await selectById(client, input.tenantId, input.operationId));
      const status = statusFromRow(row);
      if (status.status === "COMPLETED" || status.status === "FAILED") {
        return Object.freeze({ kind: "TERMINAL" as const, status });
      }
      if (row.state === "RUNNING" && Date.parse(row.claim_expires_at as string) > Date.parse(claimedAt)) {
        return Object.freeze({ kind: "BUSY" as const, status });
      }
      const updated = await client.query<{ attempt_count: number }>(
        `UPDATE deviludo.steam_workflow_operations
            SET state = 'RUNNING', claim_token = $3::uuid,
                claim_expires_at = $4::timestamptz,
                attempt_count = attempt_count + 1, updated_at = $5::timestamptz
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND state IN ('PENDING', 'RUNNING')
            AND available_at <= $5::timestamptz
            AND (claim_token IS NULL OR claim_expires_at <= $5::timestamptz)
        RETURNING attempt_count`,
        [input.tenantId, input.operationId, input.claimToken, claimExpiresAt, claimedAt],
      );
      const attempt = updated.rows[0]?.attempt_count;
      if (updated.rowCount !== 1 || !Number.isSafeInteger(attempt) || attempt < 1) invalid();
      return Object.freeze({ kind: "ACQUIRED" as const, request: row.request, attempt });
    });
  }

  async heartbeat(input: Parameters<SteamWorkflowOperationPersistence["heartbeat"]>[0]): Promise<void> {
    validateTenantOperation(input.tenantId, input.operationId);
    validateUuid(input.claimToken);
    const heartbeatAt = validTime(input.heartbeatAt);
    const claimExpiresAt = validTime(input.claimExpiresAt);
    if (Date.parse(claimExpiresAt) <= Date.parse(heartbeatAt)
      || Date.parse(claimExpiresAt) - Date.parse(heartbeatAt) > 15 * 60_000) invalid();
    await this.#transaction(input.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE deviludo.steam_workflow_operations
            SET claim_expires_at = $5::timestamptz, updated_at = $4::timestamptz
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND state = 'RUNNING' AND claim_token = $3::uuid
            AND claim_expires_at > $4::timestamptz
            AND claim_expires_at < $5::timestamptz`,
        [input.tenantId, input.operationId, input.claimToken, heartbeatAt, claimExpiresAt],
      );
      if (updated.rowCount !== 1) invalid();
    });
  }

  async complete(input: Parameters<SteamWorkflowOperationPersistence["complete"]>[0]): Promise<SteamWorkflowOperationStatus> {
    validateTenantOperation(input.tenantId, input.operationId);
    validateUuid(input.claimToken);
    const completedAt = validTime(input.completedAt);
    return this.#transaction(input.tenantId, async (client) => {
      const row = parseRow(await selectById(client, input.tenantId, input.operationId));
      const completed = validateSteamWorkflowOperationStatus({
        status: "COMPLETED", kind: row.request.kind, operationId: row.id,
        operationKey: row.operation_key, requestDigest: row.request_digest, receipt: input.receipt,
      }, row.request);
      if (row.state === "COMPLETED") {
        const existing = statusFromRow(row);
        if (sha256Canonical(existing) !== sha256Canonical(completed)) invalid();
        return existing;
      }
      requireActiveClaim(row, input.claimToken, completedAt);
      const updated = await client.query(
        `UPDATE deviludo.steam_workflow_operations
            SET state = 'COMPLETED', claim_token = NULL, claim_expires_at = NULL,
                receipt = $4::jsonb, completed_at = $5::timestamptz, updated_at = $5::timestamptz
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND state = 'RUNNING' AND claim_token = $3::uuid
            AND claim_expires_at > $5::timestamptz`,
        [input.tenantId, input.operationId, input.claimToken, JSON.stringify(input.receipt), completedAt],
      );
      if (updated.rowCount !== 1) invalid();
      return completed;
    });
  }

  async fail(input: Parameters<SteamWorkflowOperationPersistence["fail"]>[0]): Promise<SteamWorkflowOperationStatus> {
    validateTenantOperation(input.tenantId, input.operationId);
    validateUuid(input.claimToken);
    if (!ERROR_CODE.test(input.errorCode) || input.terminal !== true) invalid();
    const completedAt = validTime(input.completedAt);
    return this.#transaction(input.tenantId, async (client) => {
      const row = parseRow(await selectById(client, input.tenantId, input.operationId));
      requireActiveClaim(row, input.claimToken, completedAt);
      const failed = validateSteamWorkflowOperationStatus({
        status: "FAILED", kind: row.request.kind, operationId: row.id,
        operationKey: row.operation_key, requestDigest: row.request_digest,
        errorCode: input.errorCode, terminal: true, receipt: null,
      }, row.request);
      const updated = await client.query(
        `UPDATE deviludo.steam_workflow_operations
            SET state = 'FAILED', claim_token = NULL, claim_expires_at = NULL,
                error_code = $4, terminal = true,
                completed_at = $5::timestamptz, updated_at = $5::timestamptz
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND state = 'RUNNING' AND claim_token = $3::uuid
            AND claim_expires_at > $5::timestamptz`,
        [input.tenantId, input.operationId, input.claimToken, input.errorCode, completedAt],
      );
      if (updated.rowCount !== 1) invalid();
      return failed;
    });
  }

  async release(input: Parameters<SteamWorkflowOperationPersistence["release"]>[0]): Promise<void> {
    validateTenantOperation(input.tenantId, input.operationId);
    validateUuid(input.claimToken);
    const releasedAt = validTime(input.releasedAt);
    const retryAt = validTime(input.retryAt);
    if (Date.parse(retryAt) <= Date.parse(releasedAt)
      || Date.parse(retryAt) - Date.parse(releasedAt) > 15 * 60_000) invalid();
    await this.#transaction(input.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE deviludo.steam_workflow_operations
            SET state = 'PENDING', claim_token = NULL, claim_expires_at = NULL,
                updated_at = $4::timestamptz, available_at = $5::timestamptz
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND state = 'RUNNING' AND claim_token = $3::uuid`,
        [input.tenantId, input.operationId, input.claimToken, releasedAt, retryAt],
      );
      if (updated.rowCount !== 1) invalid();
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
      try { await client.query("ROLLBACK"); } catch { /* preserve operation failure */ }
      throw error;
    } finally { client.release(); }
  }
}

const SELECT_OPERATION = `SELECT id::text, tenant_id::text, project_id::text,
                                  submitter_spiffe_id, workflow_id, run_id::text,
                                  kind, operation_key, request_digest::text,
                                  payload_digest::text, request_payload, state,
                                  claim_token::text, claim_expires_at::text,
                                  attempt_count, receipt, error_code, terminal,
                                  created_at::text, updated_at::text, completed_at::text,
                                  available_at::text, last_enqueued_at::text, enqueue_count`;

async function selectByOperationKey(client: PostgresWorkflowClient, tenantId: string, operationKey: string): Promise<OperationRow> {
  const selected = await client.query<OperationRow>(
    `${SELECT_OPERATION}
       FROM deviludo.steam_workflow_operations
      WHERE tenant_id = $1::uuid AND operation_key = $2
      FOR UPDATE`,
    [tenantId, operationKey],
  );
  if (selected.rows.length !== 1) invalid();
  return selected.rows[0]!;
}

async function selectById(client: PostgresWorkflowClient, tenantId: string, operationId: string): Promise<OperationRow> {
  const selected = await client.query<OperationRow>(
    `${SELECT_OPERATION}
       FROM deviludo.steam_workflow_operations
      WHERE tenant_id = $1::uuid AND id = $2::uuid
      FOR UPDATE`,
    [tenantId, operationId],
  );
  if (selected.rows.length !== 1) invalid();
  return selected.rows[0]!;
}

type ParsedRow = OperationRow & { readonly request: SteamWorkflowOperationRequest };

function parseRow(value: OperationRow): ParsedRow {
  const request = parseSteamWorkflowOperationRequest(jsonValue(value.request_payload));
  if (!UUID.test(value.id) || !UUID.test(value.tenant_id) || !UUID.test(value.project_id) || !UUID.test(value.run_id)
    || !["PRIVATE_BETA_UPLOAD", "DEFAULT_BRANCH_PUBLISH"].includes(value.kind)
    || !/^workflow-job:[a-f0-9-]{36}$/.test(value.operation_key)
    || !SHA256.test(value.request_digest) || !SHA256.test(value.payload_digest)
    || !["PENDING", "RUNNING", "COMPLETED", "FAILED"].includes(value.state)
    || !Number.isInteger(value.attempt_count) || value.attempt_count < 0
    || !Number.isInteger(value.enqueue_count) || value.enqueue_count < 1
    || !Number.isFinite(Date.parse(value.created_at)) || !Number.isFinite(Date.parse(value.updated_at))
    || !Number.isFinite(Date.parse(value.available_at)) || !Number.isFinite(Date.parse(value.last_enqueued_at))
    || request.tenantId !== value.tenant_id || request.projectId !== value.project_id
    || request.workflowId !== value.workflow_id || request.runId !== value.run_id
    || request.kind !== value.kind || request.operationKey !== value.operation_key
    || request.requestDigest !== value.request_digest || sha256Canonical(request) !== value.payload_digest) invalid();
  validateSpiffe(value.submitter_spiffe_id);
  return { ...value, request };
}

function statusFromRow(row: ParsedRow): SteamWorkflowOperationStatus {
  const binding = {
    kind: row.request.kind,
    operationId: row.id,
    operationKey: row.operation_key,
    requestDigest: row.request_digest,
  } as const;
  if (row.state === "PENDING" || row.state === "RUNNING") {
    if (row.receipt !== null || row.error_code !== null || row.terminal !== null || row.completed_at !== null
      || row.state === "PENDING" && (row.claim_token !== null || row.claim_expires_at !== null)
      || row.state === "RUNNING" && (!row.claim_token || !UUID.test(row.claim_token)
        || !row.claim_expires_at || !Number.isFinite(Date.parse(row.claim_expires_at)))) invalid();
    return validateSteamWorkflowOperationStatus({ status: "RUNNING", ...binding, receipt: null }, row.request);
  }
  if (!row.completed_at || !Number.isFinite(Date.parse(row.completed_at)) || row.claim_token !== null || row.claim_expires_at !== null) invalid();
  if (row.state === "COMPLETED") {
    if (row.receipt === null || row.error_code !== null || row.terminal !== null) invalid();
    return validateSteamWorkflowOperationStatus({ status: "COMPLETED", ...binding, receipt: jsonValue(row.receipt) }, row.request);
  }
  if (row.receipt !== null || !row.error_code || !ERROR_CODE.test(row.error_code) || row.terminal !== true) invalid();
  return validateSteamWorkflowOperationStatus({
    status: "FAILED", ...binding, errorCode: row.error_code, terminal: true, receipt: null,
  }, row.request);
}

function validateRequestBinding(
  row: ParsedRow,
  request: SteamWorkflowOperationRequest,
  submitterSpiffeId: string,
  payloadDigest: string,
): void {
  if (row.submitter_spiffe_id !== submitterSpiffeId || row.payload_digest !== payloadDigest
    || sha256Canonical(row.request) !== sha256Canonical(request)) invalid();
}

function requireActiveClaim(row: ParsedRow, claimToken: string, at: string): void {
  if (row.state !== "RUNNING" || row.claim_token !== claimToken || !row.claim_expires_at
    || Date.parse(row.claim_expires_at) <= Date.parse(at)) invalid();
}

function validateLookup(value: SteamWorkflowOperationLookup): void {
  validateTenantOperation(value.tenantId, value.operationId);
  if (!/^workflow-job:[a-f0-9-]{36}$/.test(value.operationKey) || !SHA256.test(value.requestDigest)) invalid();
}

function validateTenantOperation(tenantId: string, operationId: string): void {
  validateUuid(tenantId);
  validateUuid(operationId);
}

function validateUuid(value: string): void { if (!UUID.test(value)) invalid(); }

function validateSpiffe(value: string): void {
  if (typeof value !== "string" || !value.startsWith("spiffe://") || value.length > 512) invalid();
  const url = new URL(value);
  if (url.protocol !== "spiffe:" || url.username || url.password || url.search || url.hash || url.toString() !== value) invalid();
}

function validTime(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch { invalid(); }
}

function invalid(): never { throw new Error("Steam workflow operation persistence is invalid"); }
