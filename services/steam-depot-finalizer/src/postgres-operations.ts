import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import {
  parseSteamDepotFinalizationRequest,
  steamDepotFinalizationReceiptDigest,
  validateSteamDepotFinalizationReceipt,
} from "./contract";
import type { SteamDepotFinalizationOperationStore, SteamDepotFinalizationRequest } from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

type OperationRow = {
  tenant_id: string;
  operation_key: string;
  request_digest: string;
  project_id: string;
  release_id: string;
  platform: string;
  request_payload: unknown;
  state: string;
  claim_token: string | null;
  claim_expires_at: string | null;
  attempt_count: number;
  receipt: unknown | null;
  receipt_digest: string | null;
};

export class PostgresSteamDepotFinalizationOperations implements SteamDepotFinalizationOperationStore {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async claim(input: Parameters<SteamDepotFinalizationOperationStore["claim"]>[0]) {
    const request = parseSteamDepotFinalizationRequest(input.request);
    if (!UUID.test(input.claimToken)) invalid();
    const claimedAt = validTime(input.claimedAt);
    const claimExpiresAt = validTime(input.claimExpiresAt);
    const lease = Date.parse(claimExpiresAt) - Date.parse(claimedAt);
    if (lease < 60_000 || lease > 60 * 60_000) invalid();
    return this.#transaction(request.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.steam_depot_finalization_operations
          (tenant_id, operation_key, request_digest, project_id, release_id, main_commit_sha,
           evidence_bundle_digest, platform, source_object_key, source_artifact_digest,
           request_payload, state, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10,
                 $11::jsonb, 'PENDING', $12::timestamptz, $12::timestamptz)
         ON CONFLICT (tenant_id, operation_key) DO NOTHING`,
        [request.tenantId, request.operationKey, request.requestDigest, request.projectId, request.releaseId,
          request.mainCommitSha, request.evidenceBundleDigest, request.platform, request.sourceObjectKey,
          request.sourceArtifactDigest, JSON.stringify(request), claimedAt],
      );
      const row = parseRow(await select(client, request));
      validateRowBinding(row, request);
      if (row.state === "COMPLETED") {
        if (!row.receipt || !row.receipt_digest) invalid();
        const receipt = validateSteamDepotFinalizationReceipt(row.receipt, request);
        if (steamDepotFinalizationReceiptDigest(receipt) !== row.receipt_digest) invalid();
        return Object.freeze({ kind: "REPLAY" as const, receipt });
      }
      if (row.state === "RUNNING" && Date.parse(row.claim_expires_at ?? "") > Date.parse(claimedAt)) {
        return Object.freeze({ kind: "BUSY" as const });
      }
      const updated = await client.query<{ attempt_count: number }>(
        `UPDATE deviludo.steam_depot_finalization_operations
            SET state = 'RUNNING', claim_token = $3::uuid, claim_expires_at = $4::timestamptz,
                attempt_count = attempt_count + 1, updated_at = $5::timestamptz
          WHERE tenant_id = $1::uuid AND operation_key = $2 AND state IN ('PENDING', 'RUNNING')
            AND (claim_token IS NULL OR claim_expires_at <= $5::timestamptz)
        RETURNING attempt_count`,
        [request.tenantId, request.operationKey, input.claimToken, claimExpiresAt, claimedAt],
      );
      const attempt = updated.rows[0]?.attempt_count;
      if (updated.rowCount !== 1 || !Number.isSafeInteger(attempt) || attempt < 1) invalid();
      return Object.freeze({ kind: "ACQUIRED" as const, attempt });
    });
  }

  async complete(input: Parameters<SteamDepotFinalizationOperationStore["complete"]>[0]): Promise<void> {
    const request = parseSteamDepotFinalizationRequest(input.request);
    const receipt = validateSteamDepotFinalizationReceipt(input.receipt, request);
    if (!UUID.test(input.claimToken) || !SHA256.test(input.receiptDigest)
      || steamDepotFinalizationReceiptDigest(receipt) !== input.receiptDigest) invalid();
    const completedAt = validTime(input.completedAt);
    await this.#transaction(request.tenantId, async (client) => {
      const row = parseRow(await select(client, request));
      validateRowBinding(row, request);
      if (row.state === "COMPLETED") {
        if (row.receipt_digest !== input.receiptDigest || !row.receipt
          || steamDepotFinalizationReceiptDigest(
            validateSteamDepotFinalizationReceipt(row.receipt, request),
          ) !== input.receiptDigest) invalid();
        return;
      }
      const updated = await client.query(
        `UPDATE deviludo.steam_depot_finalization_operations
            SET state = 'COMPLETED', claim_token = NULL, claim_expires_at = NULL,
                receipt = $4::jsonb, receipt_digest = $5,
                completed_at = $6::timestamptz, updated_at = $6::timestamptz
          WHERE tenant_id = $1::uuid AND operation_key = $2 AND state = 'RUNNING'
            AND claim_token = $3::uuid AND claim_expires_at > $6::timestamptz`,
        [request.tenantId, request.operationKey, input.claimToken,
          JSON.stringify(receipt), input.receiptDigest, completedAt],
      );
      if (updated.rowCount !== 1) invalid();
    });
  }

  async release(input: Parameters<SteamDepotFinalizationOperationStore["release"]>[0]): Promise<void> {
    const request = parseSteamDepotFinalizationRequest(input.request);
    if (!UUID.test(input.claimToken)) invalid();
    const releasedAt = validTime(input.releasedAt);
    await this.#transaction(request.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE deviludo.steam_depot_finalization_operations
            SET state = 'PENDING', claim_token = NULL, claim_expires_at = NULL,
                updated_at = $4::timestamptz
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND state = 'RUNNING' AND claim_token = $3::uuid`,
        [request.tenantId, request.operationKey, input.claimToken, releasedAt],
      );
      if (updated.rowCount !== 1) invalid();
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ ready: number }>("SELECT 1 AS ready");
      if (result.rows[0]?.ready !== 1) invalid();
    } finally { client.release(); }
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
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally { client.release(); }
  }
}

async function select(
  client: PostgresWorkflowClient,
  request: SteamDepotFinalizationRequest,
): Promise<OperationRow> {
  const result = await client.query<OperationRow>(
    `SELECT tenant_id::text, operation_key, request_digest::text, project_id::text,
            release_id::text, platform, request_payload, state, claim_token::text,
            claim_expires_at::text, attempt_count, receipt, receipt_digest::text
       FROM deviludo.steam_depot_finalization_operations
      WHERE tenant_id = $1::uuid AND operation_key = $2
      FOR UPDATE`,
    [request.tenantId, request.operationKey],
  );
  if (result.rows.length !== 1) invalid();
  return result.rows[0]!;
}

function parseRow(row: OperationRow): OperationRow {
  if (!row || !UUID.test(row.tenant_id) || !SHA256.test(row.request_digest)
    || !UUID.test(row.project_id) || !UUID.test(row.release_id)
    || !["windows", "linux", "macos"].includes(row.platform)
    || !["PENDING", "RUNNING", "COMPLETED"].includes(row.state)
    || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0) invalid();
  return row;
}

function validateRowBinding(row: OperationRow, request: SteamDepotFinalizationRequest): void {
  const stored = parseSteamDepotFinalizationRequest(row.request_payload);
  if (row.tenant_id !== request.tenantId || row.operation_key !== request.operationKey
    || row.request_digest !== request.requestDigest || row.project_id !== request.projectId
    || row.release_id !== request.releaseId || row.platform !== request.platform
    || JSON.stringify(stored) !== JSON.stringify(request)) invalid();
}

function validTime(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}

function invalid(): never { throw new Error("PostgreSQL Steam depot finalization operation is invalid"); }
