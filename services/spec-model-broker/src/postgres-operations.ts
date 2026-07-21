import { parseSpecModelResult } from "../../spec-dialogue/src/contracts";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { canonical, resultDigest, validateProviderBinding, validateUsage } from "./contract";
import type { SpecModelOperationClaim, SpecModelOperationLookup, SpecModelOperationStore } from "./contracts";
import { SpecModelRequestError } from "./contracts";

type OperationRow = {
  tenant_id: string;
  project_id: string;
  conversation_id: string;
  operation_key: string;
  request_digest: string;
  profile_revision_id: string;
  provider_revision_id: string;
  credential_version_id: string;
  agent: string;
  protocol: string;
  base_url: string;
  approved_ports: Array<number | string>;
  authentication: string;
  model: string;
  policy_digest: string;
  state: string;
  claim_token: string | null;
  expired: boolean;
  result: unknown | null;
  result_digest: string | null;
  usage: unknown | null;
};

export class PostgresSpecModelOperationStore implements SpecModelOperationStore {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async lookup(input: Parameters<SpecModelOperationStore["lookup"]>[0]): Promise<SpecModelOperationLookup> {
    return this.transaction(input.tenantId, async (client) => {
      const selected = await selectOperation(client, input.tenantId, input.operationKey);
      if (!selected) return null;
      assertRequest(selected, input);
      if (selected.state === "COMPLETED") return completed(selected);
      if (selected.state === "INDETERMINATE") return Object.freeze({ kind: "INDETERMINATE" });
      if (selected.state === "RELEASED") return Object.freeze({ kind: "RETRY" });
      if (selected.state !== "CLAIMED") invalid();
      if (selected.expired) {
        const changed = await client.query(
          `UPDATE deviludo.spec_model_generation_operations
              SET state = 'INDETERMINATE', claim_token = NULL, claim_expires_at = NULL
            WHERE tenant_id = $1::uuid AND operation_key = $2
              AND state = 'CLAIMED' AND claim_token = $3::uuid`,
          [input.tenantId, input.operationKey, selected.claim_token],
        );
        if (changed.rowCount !== 1) invalid();
        return Object.freeze({ kind: "INDETERMINATE" });
      }
      return Object.freeze({ kind: "BUSY" });
    });
  }

  async claim(input: Parameters<SpecModelOperationStore["claim"]>[0]): Promise<SpecModelOperationClaim> {
    const provider = validateProviderBinding(input.provider);
    return this.transaction(input.tenantId, async (client) => {
      const conversation = await client.query<{ id: string; state: string }>(
        `SELECT id::text, state FROM deviludo.spec_conversations
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
          FOR SHARE`,
        [input.tenantId, input.projectId, input.conversationId],
      );
      if (conversation.rows.length !== 1 || conversation.rows[0]?.id !== input.conversationId
        || conversation.rows[0]?.state !== "DRAFT") invalid();
      await client.query(
        `INSERT INTO deviludo.spec_model_generation_operations
          (tenant_id, project_id, conversation_id, operation_key, request_digest,
           profile_revision_id, provider_revision_id, credential_version_id,
           agent, protocol, base_url, approved_ports, authentication, model,
           policy_digest, state, claim_token, claim_expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
                 $9, $10, $11, $12::integer[], $13, $14, $15,
                 'CLAIMED', $16::uuid, now() + make_interval(secs => $17::double precision))
         ON CONFLICT (tenant_id, operation_key) DO NOTHING`,
        [
          input.tenantId, input.projectId, input.conversationId, input.operationKey, input.requestDigest,
          provider.profileRevisionId, provider.providerRevisionId, provider.credentialVersionId,
          provider.agent, provider.protocol, provider.baseUrl, [...provider.approvedPorts],
          provider.authentication, provider.model, provider.policyDigest, input.claimToken, input.leaseSeconds,
        ],
      );
      const selected = await selectOperation(client, input.tenantId, input.operationKey);
      if (!selected) invalid();
      assertRequest(selected, input);
      assertProvider(selected, provider);
      if (selected.state === "COMPLETED") return completed(selected);
      if (selected.state === "INDETERMINATE") return Object.freeze({ kind: "INDETERMINATE" });
      if (selected.state === "CLAIMED") {
        if (selected.expired) {
          await markIndeterminate(client, input.tenantId, input.operationKey, selected.claim_token);
          return Object.freeze({ kind: "INDETERMINATE" });
        }
        if (selected.claim_token === input.claimToken) return Object.freeze({ kind: "CLAIMED", claimToken: input.claimToken });
        return Object.freeze({ kind: "BUSY" });
      }
      if (selected.state !== "RELEASED") invalid();
      const reclaimed = await client.query(
        `UPDATE deviludo.spec_model_generation_operations
            SET state = 'CLAIMED', claim_token = $3::uuid,
                claim_expires_at = now() + make_interval(secs => $4::double precision)
          WHERE tenant_id = $1::uuid AND operation_key = $2 AND state = 'RELEASED'`,
        [input.tenantId, input.operationKey, input.claimToken, input.leaseSeconds],
      );
      if (reclaimed.rowCount !== 1) invalid();
      return Object.freeze({ kind: "CLAIMED", claimToken: input.claimToken });
    });
  }

  async complete(input: Parameters<SpecModelOperationStore["complete"]>[0]): Promise<void> {
    const result = parseSpecModelResult(input.result);
    const usage = validateUsage(input.usage);
    const digest = resultDigest(result);
    await this.transaction(input.tenantId, async (client) => {
      const selected = await selectOperation(client, input.tenantId, input.operationKey);
      if (!selected) invalid();
      if (selected.state === "COMPLETED") {
        const replay = completed(selected);
        if (canonical(replay.result) !== canonical(result) || canonical(selected.usage) !== canonical(usage)) invalid();
        return;
      }
      if (selected.state !== "CLAIMED" || selected.claim_token !== input.claimToken || selected.expired) invalid();
      const changed = await client.query(
        `UPDATE deviludo.spec_model_generation_operations
            SET state = 'COMPLETED', claim_token = NULL, claim_expires_at = NULL,
                result = $4::jsonb, result_digest = $5, usage = $6::jsonb,
                completed_at = now()
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND claim_token = $3::uuid AND state = 'CLAIMED'
            AND claim_expires_at > now()`,
        [input.tenantId, input.operationKey, input.claimToken, JSON.stringify(result), digest, JSON.stringify(usage)],
      );
      if (changed.rowCount !== 1) invalid();
    });
  }

  async release(input: Parameters<SpecModelOperationStore["release"]>[0]): Promise<void> {
    await this.transition(input, "RELEASED");
  }
  async abandon(input: Parameters<SpecModelOperationStore["abandon"]>[0]): Promise<void> {
    await this.transition(input, "INDETERMINATE");
  }
  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ ready: number }>("SELECT 1 AS ready");
      if (result.rows.length !== 1 || result.rows[0]?.ready !== 1) invalid();
    } finally { client.release(); }
  }

  private async transition(
    input: { tenantId: string; operationKey: string; claimToken: string },
    state: "RELEASED" | "INDETERMINATE",
  ): Promise<void> {
    await this.transaction(input.tenantId, async (client) => {
      const selected = await selectOperation(client, input.tenantId, input.operationKey);
      if (!selected) invalid();
      if (selected.state === state) return;
      if (selected.state !== "CLAIMED" || selected.claim_token !== input.claimToken) invalid();
      const changed = await client.query(
        `UPDATE deviludo.spec_model_generation_operations
            SET state = $4, claim_token = NULL, claim_expires_at = NULL
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND claim_token = $3::uuid AND state = 'CLAIMED'`,
        [input.tenantId, input.operationKey, input.claimToken, state],
      );
      if (changed.rowCount !== 1) invalid();
    });
  }

  private async transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve operation error */ }
      throw error;
    } finally { client.release(); }
  }
}

async function selectOperation(client: PostgresWorkflowClient, tenantId: string, operationKey: string): Promise<OperationRow | null> {
  const selected = await client.query<OperationRow>(
    `SELECT tenant_id::text, project_id::text, conversation_id::text,
            operation_key, request_digest, profile_revision_id,
            provider_revision_id, credential_version_id, agent, protocol,
            base_url, approved_ports, authentication, model, policy_digest,
            state, claim_token::text, claim_expires_at <= now() AS expired,
            result, result_digest, usage
       FROM deviludo.spec_model_generation_operations
      WHERE tenant_id = $1::uuid AND operation_key = $2
      FOR UPDATE`,
    [tenantId, operationKey],
  );
  if (selected.rows.length > 1) invalid();
  return selected.rows[0] ?? null;
}

function completed(row: OperationRow): Readonly<{ kind: "COMPLETED"; result: ReturnType<typeof parseSpecModelResult> }> {
  if (row.result === null || row.result_digest === null || row.usage === null) invalid();
  const result = parseSpecModelResult(row.result);
  if (resultDigest(result) !== row.result_digest) invalid();
  validateUsage(recordUsage(row.usage));
  return Object.freeze({ kind: "COMPLETED", result });
}

function assertRequest(row: OperationRow, input: {
  tenantId: string; projectId: string; conversationId: string; operationKey: string; requestDigest: string;
}): void {
  if (row.tenant_id !== input.tenantId || row.project_id !== input.projectId
    || row.conversation_id !== input.conversationId || row.operation_key !== input.operationKey
    || row.request_digest !== input.requestDigest) invalid();
}

function assertProvider(row: OperationRow, provider: Parameters<typeof validateProviderBinding>[0]): void {
  const selected = validateProviderBinding({
    profileRevisionId: row.profile_revision_id,
    providerRevisionId: row.provider_revision_id,
    credentialVersionId: row.credential_version_id,
    agent: row.agent as "claude-code" | "codex-cli",
    protocol: row.protocol as "anthropic-messages" | "openai-responses",
    baseUrl: row.base_url,
    approvedPorts: row.approved_ports.map(Number),
    authentication: row.authentication as "bearer" | "x-api-key" | "authorization-bearer",
    model: row.model,
    policyDigest: row.policy_digest,
  });
  if (canonical(selected) !== canonical(provider)) invalid();
}

async function markIndeterminate(
  client: PostgresWorkflowClient,
  tenantId: string,
  operationKey: string,
  claimToken: string | null,
): Promise<void> {
  if (!claimToken) invalid();
  const changed = await client.query(
    `UPDATE deviludo.spec_model_generation_operations
        SET state = 'INDETERMINATE', claim_token = NULL, claim_expires_at = NULL
      WHERE tenant_id = $1::uuid AND operation_key = $2
        AND state = 'CLAIMED' AND claim_token = $3::uuid`,
    [tenantId, operationKey, claimToken],
  );
  if (changed.rowCount !== 1) invalid();
}

function recordUsage(value: unknown): { inputTokens: number; outputTokens: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["inputTokens", "outputTokens"])) invalid();
  return { inputTokens: Number(body.inputTokens), outputTokens: Number(body.outputTokens) };
}
function invalid(): never { throw new SpecModelRequestError("Specification model PostgreSQL operation is invalid"); }
