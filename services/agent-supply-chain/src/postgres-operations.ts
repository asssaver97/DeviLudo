import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { probePostgresRelations } from "../../temporal/src/postgres-readiness";
import type {
  AgentSupplyChainOperationPersistence,
  AgentSupplyChainRequest,
} from "./contracts";
import { parseAgentSupplyChainRequest, validateAgentSupplyChainOperationResult } from "./request-contract";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

type OperationRow = {
  operation_key: string;
  request_digest: string;
  kind: string;
  payload_digest: string;
  request_payload: unknown;
  state: string;
  claim_token: string | null;
  claim_expires_at: string | null;
  attempt_count: number;
  response_payload: unknown | null;
  response_digest: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export class PostgresAgentSupplyChainOperations implements AgentSupplyChainOperationPersistence {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async claim(input: Parameters<AgentSupplyChainOperationPersistence["claim"]>[0]) {
    validateBinding(input.operationKey, input.requestDigest, input.payloadDigest, input.claimToken);
    const request = parseAgentSupplyChainRequest(input.request);
    const claimedAt = validTime(input.claimedAt);
    const claimExpiresAt = validTime(input.claimExpiresAt);
    const lease = Date.parse(claimExpiresAt) - Date.parse(claimedAt);
    if (lease < 30_000 || lease > 10 * 60_000) invalid();
    return this.#transaction(async (client) => {
      await client.query(
        `INSERT INTO deviludo.agent_supply_chain_operations
          (operation_key, request_digest, kind, payload_digest, request_payload,
           state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', $6::timestamptz, $6::timestamptz)
         ON CONFLICT (operation_key) DO NOTHING`,
        [input.operationKey, input.requestDigest, input.kind, input.payloadDigest, JSON.stringify(request), claimedAt],
      );
      const row = parseRow(await select(client, input.operationKey));
      validateRowBinding(row, input, request);
      if (row.state === "COMPLETED") {
        if (!row.response_payload || !row.response_digest) invalid();
        const response = validateAgentSupplyChainOperationResult(row.response_payload, request);
        if (sha256Canonical(response) !== row.response_digest) invalid();
        return Object.freeze({ kind: "REPLAY" as const, response });
      }
      if (row.state === "RUNNING" && Date.parse(row.claim_expires_at ?? "") > Date.parse(claimedAt)) {
        return Object.freeze({ kind: "BUSY" as const });
      }
      const updated = await client.query<{ attempt_count: number }>(
        `UPDATE deviludo.agent_supply_chain_operations
            SET state = 'RUNNING', claim_token = $2::uuid, claim_expires_at = $3::timestamptz,
                attempt_count = attempt_count + 1, updated_at = $4::timestamptz
          WHERE operation_key = $1 AND state IN ('PENDING', 'RUNNING')
            AND (claim_token IS NULL OR claim_expires_at <= $4::timestamptz)
        RETURNING attempt_count`,
        [input.operationKey, input.claimToken, claimExpiresAt, claimedAt],
      );
      const attempt = updated.rows[0]?.attempt_count;
      if (updated.rowCount !== 1 || !Number.isSafeInteger(attempt) || attempt < 1) invalid();
      return Object.freeze({ kind: "ACQUIRED" as const, attempt });
    });
  }

  async complete(input: Parameters<AgentSupplyChainOperationPersistence["complete"]>[0]): Promise<void> {
    if (!SHA256.test(input.operationKey) || !SHA256.test(input.responseDigest) || !UUID.test(input.claimToken)) invalid();
    const completedAt = validTime(input.completedAt);
    await this.#transaction(async (client) => {
      const row = parseRow(await select(client, input.operationKey));
      const request = parseAgentSupplyChainRequest(row.request_payload);
      const response = validateAgentSupplyChainOperationResult(input.response, request);
      if (sha256Canonical(response) !== input.responseDigest) invalid();
      if (row.state === "COMPLETED") {
        if (row.response_digest !== input.responseDigest || sha256Canonical(row.response_payload) !== input.responseDigest) invalid();
        return;
      }
      const updated = await client.query(
        `UPDATE deviludo.agent_supply_chain_operations
            SET state = 'COMPLETED', claim_token = NULL, claim_expires_at = NULL,
                response_payload = $3::jsonb, response_digest = $4,
                completed_at = $5::timestamptz, updated_at = $5::timestamptz
          WHERE operation_key = $1 AND state = 'RUNNING' AND claim_token = $2::uuid
            AND claim_expires_at > $5::timestamptz`,
        [input.operationKey, input.claimToken, JSON.stringify(response), input.responseDigest, completedAt],
      );
      if (updated.rowCount !== 1) invalid();
    });
  }

  async release(input: Parameters<AgentSupplyChainOperationPersistence["release"]>[0]): Promise<void> {
    if (!SHA256.test(input.operationKey) || !UUID.test(input.claimToken)) invalid();
    const releasedAt = validTime(input.releasedAt);
    await this.#transaction(async (client) => {
      const updated = await client.query(
        `UPDATE deviludo.agent_supply_chain_operations
            SET state = 'PENDING', claim_token = NULL, claim_expires_at = NULL,
                updated_at = $3::timestamptz
          WHERE operation_key = $1 AND state = 'RUNNING' AND claim_token = $2::uuid`,
        [input.operationKey, input.claimToken, releasedAt],
      );
      if (updated.rowCount !== 1) invalid();
    });
  }

  async probe(): Promise<void> {
    await probePostgresRelations(this.pool, ["agent_supply_chain_operations"],
      () => new Error("PostgreSQL Agent supply-chain operation is invalid"));
  }

  async #transaction<T>(operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally { client.release(); }
  }
}

const SELECT = `SELECT operation_key::text, request_digest::text, kind, payload_digest::text,
                       request_payload, state, claim_token::text, claim_expires_at::text,
                       attempt_count, response_payload, response_digest::text,
                       created_at::text, updated_at::text, completed_at::text
                  FROM deviludo.agent_supply_chain_operations
                 WHERE operation_key = $1
                 FOR UPDATE`;

async function select(client: PostgresWorkflowClient, operationKey: string): Promise<OperationRow> {
  const result = await client.query<OperationRow>(SELECT, [operationKey]);
  if (result.rows.length !== 1) invalid();
  return result.rows[0]!;
}

function parseRow(value: OperationRow): OperationRow {
  if (!value || !SHA256.test(value.operation_key) || !SHA256.test(value.request_digest)
    || !SHA256.test(value.payload_digest) || !["DISCOVER", "VALIDATE", "BUILD", "ROLLOUT"].includes(value.kind)
    || !["PENDING", "RUNNING", "COMPLETED"].includes(value.state)
    || !Number.isSafeInteger(value.attempt_count) || value.attempt_count < 0) invalid();
  return value;
}

function validateRowBinding(
  row: OperationRow,
  input: Parameters<AgentSupplyChainOperationPersistence["claim"]>[0],
  request: AgentSupplyChainRequest,
): void {
  if (row.operation_key !== input.operationKey || row.request_digest !== input.requestDigest
    || row.kind !== input.kind || row.payload_digest !== input.payloadDigest
    || sha256Canonical(parseAgentSupplyChainRequest(row.request_payload)) !== sha256Canonical(request)) invalid();
}

function validateBinding(operationKey: string, requestDigest: string, payloadDigest: string, claimToken: string): void {
  if (!SHA256.test(operationKey) || !SHA256.test(requestDigest) || !SHA256.test(payloadDigest) || !UUID.test(claimToken)) invalid();
}

function validTime(value: string): string { if (!Number.isFinite(Date.parse(value))) invalid(); return value; }
function invalid(): never { throw new Error("PostgreSQL Agent supply-chain operation is invalid"); }
