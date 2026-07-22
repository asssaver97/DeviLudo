import { assertPinnedModelId } from "../../../lib/agent/providers";
import type { ModelRoles } from "../../../lib/agent/types";
import type { RunTokenBudget } from "../../../lib/security/credentials";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type {
  ActiveRunAuthorization,
  GatewayProviderRevision,
  GatewayUsage,
  GatewayUsageClaimBinding,
  InferenceReconciliationReceipt,
  InferenceReconciliationRequest,
  InferenceReconciliationStatus,
  InferenceReconciliationStore,
  ProviderRevisionRegistry,
  RunAuthorizationRegistry,
  UsageLedger,
} from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type RunRow = {
  tenant_id: string;
  project_id: string;
  run_id: string;
  profile_revision_id: string;
  provider_revision_id: string;
  credential_version_id: string;
  models: string[];
  budget: unknown;
  nonce: string;
  state: string;
};

type ProviderRow = {
  provider_revision_id: string;
  agent: string;
  protocol: string;
  base_url: string;
  approved_ports: Array<number | string>;
  authentication: string;
  models: unknown;
  credential_version_id: string;
  input_usd_per_million_tokens: string | number;
  output_usd_per_million_tokens: string | number;
  state: string;
};

type UsageRow = { input_tokens: string | number; output_tokens: string | number; cost_usd: string | number };
type UsageEventRow = UsageRow & {
  tenant_id: string;
  project_id: string;
  run_id: string;
  provider_revision_id: string;
  credential_version_id: string;
  model: string;
};
type ClaimRow = {
  request_id: string;
  tenant_id: string;
  project_id: string;
  run_id: string;
  provider_revision_id: string;
  credential_version_id: string;
  model: string;
  claim_token: string;
  state: string;
  expired: boolean;
};
type ReconciliationClaimRow = ClaimRow & {
  input_usd_per_million_tokens: string | number;
  output_usd_per_million_tokens: string | number;
  reconciliation_operation_key: string | null;
  reconciliation_payload_digest: string | null;
  reconciliation_action: string | null;
  reconciliation_evidence_digest: string | null;
  reconciled_by: string | null;
  reconciled_at: string | Date | null;
};
type UnresolvedClaimRow = ClaimRow & {
  claim_expires_at: string | Date;
  created_at: string | Date;
};

export class InferenceReconciliationConflict extends Error {
  constructor(readonly code: "RECONCILIATION_NOT_READY" | "RECONCILIATION_CONFLICT") {
    super("Inference request reconciliation was rejected");
  }
}

/** Tenant-RLS registry and append-only usage ledger for the production Gateway. */
export class PostgresInferenceGatewayStore implements InferenceReconciliationStore {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async getRun(tenantId: string, runId: string): Promise<ActiveRunAuthorization | null> {
    validateTenantRun(tenantId, runId);
    return this.#transaction(tenantId, async (client) => {
      const selected = await client.query<RunRow>(
        `SELECT authorization.tenant_id::text, authorization.project_id::text,
                authorization.run_id::text,
                COALESCE(failover.to_profile_revision_id, authorization.profile_revision_id)
                  AS profile_revision_id,
                COALESCE(failover.to_provider_revision_id, authorization.provider_revision_id)
                  AS provider_revision_id,
                COALESCE(failover.to_credential_version_id, authorization.credential_version_id)
                  AS credential_version_id,
                COALESCE(failover.to_models, authorization.models) AS models,
                COALESCE(failover.to_budget, authorization.budget) AS budget,
                COALESCE(failover.authorization_nonce::text, authorization.nonce) AS nonce,
                authorization.state
           FROM deviludo.inference_run_authorizations authorization
           LEFT JOIN deviludo.agent_run_provider_failovers failover
             ON failover.tenant_id = authorization.tenant_id
            AND failover.project_id = authorization.project_id
            AND failover.run_id = authorization.run_id
          WHERE authorization.tenant_id = $1::uuid AND authorization.run_id = $2::uuid
            AND COALESCE(failover.authorization_expires_at, authorization.expires_at) > now()
          FOR SHARE OF authorization`,
        [tenantId, runId],
      );
      if (selected.rows.length === 0) return null;
      if (selected.rows.length !== 1) invalid();
      return parseRun(selected.rows[0]!);
    });
  }

  async getProvider(tenantId: string, providerRevisionId: string): Promise<GatewayProviderRevision | null> {
    if (!UUID.test(tenantId) || !SAFE_ID.test(providerRevisionId)) invalid();
    return this.#transaction(tenantId, async (client) => {
      const selected = await client.query<ProviderRow>(
        `SELECT provider_revision_id, agent, protocol, base_url, approved_ports,
                authentication, models, credential_version_id,
                input_usd_per_million_tokens::text,
                output_usd_per_million_tokens::text, state
           FROM deviludo.inference_provider_revisions
          WHERE tenant_id = $1::uuid AND provider_revision_id = $2
          FOR SHARE`,
        [tenantId, providerRevisionId],
      );
      if (selected.rows.length === 0) return null;
      if (selected.rows.length !== 1) invalid();
      return parseProvider(selected.rows[0]!);
    });
  }

  async getUsage(tenantId: string, runId: string): Promise<GatewayUsage> {
    validateTenantRun(tenantId, runId);
    return this.#transaction(tenantId, async (client) => {
      const selected = await client.query<UsageRow>(
        `SELECT COALESCE(sum(input_tokens), 0)::text AS input_tokens,
                COALESCE(sum(output_tokens), 0)::text AS output_tokens,
                COALESCE(sum(cost_usd), 0)::text AS cost_usd
           FROM deviludo.inference_usage_events
          WHERE tenant_id = $1::uuid AND run_id = $2::uuid`,
        [tenantId, runId],
      );
      if (selected.rows.length !== 1) invalid();
      return parseUsage(selected.rows[0]!);
    });
  }

  async claim(input: GatewayUsageClaimBinding): Promise<"ACQUIRED" | "BUSY" | "INDETERMINATE" | "BUDGET_EXHAUSTED"> {
    validateClaimBinding(input);
    return this.#transaction(input.tenantId, async (client) => {
      const runResult = await client.query<RunRow>(
        `SELECT authorization.tenant_id::text, authorization.project_id::text,
                authorization.run_id::text,
                COALESCE(failover.to_profile_revision_id, authorization.profile_revision_id)
                  AS profile_revision_id,
                COALESCE(failover.to_provider_revision_id, authorization.provider_revision_id)
                  AS provider_revision_id,
                COALESCE(failover.to_credential_version_id, authorization.credential_version_id)
                  AS credential_version_id,
                COALESCE(failover.to_models, authorization.models) AS models,
                COALESCE(failover.to_budget, authorization.budget) AS budget,
                COALESCE(failover.authorization_nonce::text, authorization.nonce) AS nonce,
                authorization.state
           FROM deviludo.inference_run_authorizations authorization
           LEFT JOIN deviludo.agent_run_provider_failovers failover
             ON failover.tenant_id = authorization.tenant_id
            AND failover.project_id = authorization.project_id
            AND failover.run_id = authorization.run_id
          WHERE authorization.tenant_id = $1::uuid AND authorization.run_id = $2::uuid
            AND COALESCE(failover.authorization_expires_at, authorization.expires_at) > now()
          FOR UPDATE OF authorization`,
        [input.tenantId, input.runId],
      );
      if (runResult.rows.length !== 1) invalid();
      const run = parseRun(runResult.rows[0]!);
      if (run.state !== "ACTIVE" || run.projectId !== input.projectId
        || run.providerRevisionId !== input.providerRevisionId
        || run.credentialVersionId !== input.credentialVersionId
        || !run.models.includes(input.model)) invalid();
      const unresolved = await client.query<ClaimRow>(
        `SELECT request_id::text, tenant_id::text, project_id::text, run_id::text,
                provider_revision_id, credential_version_id, model, claim_token::text,
                state, claim_expires_at <= now() AS expired
           FROM deviludo.inference_request_claims
          WHERE tenant_id = $1::uuid AND run_id = $2::uuid
            AND state IN ('ACTIVE', 'INDETERMINATE')
          FOR UPDATE`,
        [input.tenantId, input.runId],
      );
      if (unresolved.rows.length > 1) invalid();
      const existing = unresolved.rows[0];
      if (existing) {
        validateClaimRow(existing);
        if (existing.tenant_id !== input.tenantId || existing.run_id !== input.runId) invalid();
        if (existing.state === "INDETERMINATE") return "INDETERMINATE";
        if (!existing.expired) return "BUSY";
        const abandoned = await client.query(
          `UPDATE deviludo.inference_request_claims
              SET state = 'INDETERMINATE'
            WHERE tenant_id = $1::uuid AND request_id = $2::uuid
              AND claim_token = $3::uuid AND state = 'ACTIVE'`,
          [input.tenantId, existing.request_id, existing.claim_token],
        );
        if (abandoned.rowCount !== 1) invalid();
        return "INDETERMINATE";
      }
      const usageResult = await client.query<UsageRow>(
        `SELECT COALESCE(sum(input_tokens), 0)::text AS input_tokens,
                COALESCE(sum(output_tokens), 0)::text AS output_tokens,
                COALESCE(sum(cost_usd), 0)::text AS cost_usd
           FROM deviludo.inference_usage_events
          WHERE tenant_id = $1::uuid AND run_id = $2::uuid`,
        [input.tenantId, input.runId],
      );
      if (usageResult.rows.length !== 1) invalid();
      if (budgetExhausted(run.budget, parseUsage(usageResult.rows[0]!))) return "BUDGET_EXHAUSTED";
      const inserted = await client.query(
        `INSERT INTO deviludo.inference_request_claims
          (request_id, tenant_id, project_id, run_id, provider_revision_id,
           credential_version_id, model, claim_token, state, claim_expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
                 $8::uuid, 'ACTIVE', now() + make_interval(secs => $9::double precision))`,
        [
          input.requestId, input.tenantId, input.projectId, input.runId,
          input.providerRevisionId, input.credentialVersionId, input.model,
          input.claimToken, input.leaseSeconds,
        ],
      );
      if (inserted.rowCount !== 1) invalid();
      return "ACQUIRED";
    });
  }

  async complete(input: GatewayUsageClaimBinding & Readonly<{ usage: GatewayUsage }>): Promise<void> {
    validateClaimBinding(input);
    parseUsage({ input_tokens: input.usage.inputTokens, output_tokens: input.usage.outputTokens, cost_usd: input.usage.costUsd });
    await this.#transaction(input.tenantId, async (client) => {
      const selected = await client.query<ClaimRow>(
        `SELECT request_id::text, tenant_id::text, project_id::text, run_id::text,
                provider_revision_id, credential_version_id, model, claim_token::text,
                state, claim_expires_at <= now() AS expired
           FROM deviludo.inference_request_claims
          WHERE tenant_id = $1::uuid AND request_id = $2::uuid
          FOR UPDATE`,
        [input.tenantId, input.requestId],
      );
      if (selected.rows.length !== 1) invalid();
      const claim = selected.rows[0]!;
      assertClaimBinding(claim, input);
      if (claim.state === "COMPLETED") {
        await assertUsageReplay(client, input);
        return;
      }
      if (claim.state !== "ACTIVE" || claim.expired) invalid();
      const inserted = await client.query(
        `INSERT INTO deviludo.inference_usage_events
          (request_id, tenant_id, project_id, run_id, provider_revision_id,
           credential_version_id, model, input_tokens, output_tokens, cost_usd)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10)`,
        [
          input.requestId, input.tenantId, input.projectId, input.runId,
          input.providerRevisionId, input.credentialVersionId, input.model,
          input.usage.inputTokens, input.usage.outputTokens, input.usage.costUsd,
        ],
      );
      if (inserted.rowCount !== 1) invalid();
      const completed = await client.query(
        `UPDATE deviludo.inference_request_claims
            SET state = 'COMPLETED', completed_at = now()
          WHERE tenant_id = $1::uuid AND request_id = $2::uuid
            AND claim_token = $3::uuid AND state = 'ACTIVE'`,
        [input.tenantId, input.requestId, input.claimToken],
      );
      if (completed.rowCount !== 1) invalid();
    });
  }

  async release(input: GatewayUsageClaimBinding): Promise<void> { await this.#transition(input, "RELEASED"); }
  async abandon(input: GatewayUsageClaimBinding): Promise<void> { await this.#transition(input, "INDETERMINATE"); }

  async lookup(tenantId: string, runId: string): Promise<InferenceReconciliationStatus | null> {
    validateTenantRun(tenantId, runId);
    return this.#transaction(tenantId, async (client) => {
      const run = await client.query<{ run_id: string }>(
        `SELECT run_id::text
          FROM deviludo.inference_run_authorizations
          WHERE tenant_id = $1::uuid AND run_id = $2::uuid
          FOR SHARE`,
        [tenantId, runId],
      );
      if (run.rows.length === 0) return null;
      if (run.rows.length !== 1 || run.rows[0]!.run_id !== runId) invalid();
      const selected = await client.query<UnresolvedClaimRow>(
        `SELECT request_id::text, tenant_id::text, project_id::text,
                run_id::text, provider_revision_id, credential_version_id,
                model, claim_token::text, state,
                claim_expires_at <= now() AS expired,
                claim_expires_at, created_at
           FROM deviludo.inference_request_claims
          WHERE tenant_id = $1::uuid AND run_id = $2::uuid
            AND state IN ('ACTIVE', 'INDETERMINATE')
          FOR SHARE`,
        [tenantId, runId],
      );
      if (selected.rows.length === 0) return null;
      if (selected.rows.length !== 1) invalid();
      const claim = selected.rows[0]!;
      validateClaimRow(claim);
      if (claim.state !== "ACTIVE" && claim.state !== "INDETERMINATE") invalid();
      const state: InferenceReconciliationStatus["state"] = claim.state === "ACTIVE" && claim.expired
        ? "INDETERMINATE"
        : claim.state;
      return Object.freeze({
        tenantId,
        runId,
        requestId: claim.request_id,
        providerRevisionId: claim.provider_revision_id,
        model: claim.model,
        state,
        claimExpiresAt: isoDate(claim.claim_expires_at),
        createdAt: isoDate(claim.created_at),
      });
    });
  }

  async reconcile(input: InferenceReconciliationRequest): Promise<InferenceReconciliationReceipt> {
    validateReconciliation(input);
    const payloadDigest = reconciliationPayloadDigest(input);
    return this.#transaction(input.tenantId, async (client) => {
      const run = await client.query<{ run_id: string }>(
        `SELECT run_id::text
           FROM deviludo.inference_run_authorizations
          WHERE tenant_id = $1::uuid AND run_id = $2::uuid
          FOR UPDATE`,
        [input.tenantId, input.runId],
      );
      if (run.rows.length !== 1 || run.rows[0]!.run_id !== input.runId) invalid();
      const selected = await client.query<ReconciliationClaimRow>(
        `SELECT claim.request_id::text, claim.tenant_id::text,
                claim.project_id::text, claim.run_id::text,
                claim.provider_revision_id, claim.credential_version_id,
                claim.model, claim.claim_token::text, claim.state,
                claim.claim_expires_at <= now() AS expired,
                claim.reconciliation_operation_key,
                claim.reconciliation_payload_digest,
                claim.reconciliation_action,
                claim.reconciliation_evidence_digest,
                claim.reconciled_by, claim.reconciled_at,
                provider.input_usd_per_million_tokens::text,
                provider.output_usd_per_million_tokens::text
           FROM deviludo.inference_request_claims claim
           JOIN deviludo.inference_provider_revisions provider
             ON provider.tenant_id = claim.tenant_id
            AND provider.provider_revision_id = claim.provider_revision_id
          WHERE claim.tenant_id = $1::uuid AND claim.run_id = $2::uuid
            AND claim.request_id = $3::uuid
          FOR UPDATE OF claim`,
        [input.tenantId, input.runId, input.requestId],
      );
      if (selected.rows.length !== 1) throw new InferenceReconciliationConflict("RECONCILIATION_NOT_READY");
      const claim = selected.rows[0]!;
      validateReconciliationClaim(claim, input);
      if (claim.reconciliation_operation_key !== null) {
        return replayReconciliation(client, claim, input, payloadDigest);
      }
      if (claim.state === "ACTIVE") {
        if (!claim.expired) throw new InferenceReconciliationConflict("RECONCILIATION_NOT_READY");
        const expired = await client.query(
          `UPDATE deviludo.inference_request_claims
              SET state = 'INDETERMINATE'
            WHERE tenant_id = $1::uuid AND run_id = $2::uuid
              AND request_id = $3::uuid AND state = 'ACTIVE'
              AND claim_expires_at <= now()`,
          [input.tenantId, input.runId, input.requestId],
        );
        if (expired.rowCount !== 1) throw new InferenceReconciliationConflict("RECONCILIATION_CONFLICT");
      } else if (claim.state !== "INDETERMINATE") {
        throw new InferenceReconciliationConflict("RECONCILIATION_CONFLICT");
      }

      const usage = reconciledUsage(input, claim);
      if (input.action === "RECORD_USAGE") {
        const inserted = await client.query(
          `INSERT INTO deviludo.inference_usage_events
            (request_id, tenant_id, project_id, run_id, provider_revision_id,
             credential_version_id, model, input_tokens, output_tokens, cost_usd)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10)`,
          [
            input.requestId, input.tenantId, claim.project_id, input.runId,
            claim.provider_revision_id, claim.credential_version_id, claim.model,
            usage.inputTokens, usage.outputTokens, usage.costUsd,
          ],
        );
        if (inserted.rowCount !== 1) invalid();
      } else {
        await assertNoUsageEvent(client, input.tenantId, input.requestId);
      }
      const state = input.action === "RECORD_USAGE" ? "COMPLETED" : "RELEASED";
      const updated = await client.query<{ reconciled_at: string | Date }>(
        `UPDATE deviludo.inference_request_claims
            SET state = $4,
                completed_at = CASE WHEN $4 = 'COMPLETED' THEN now() ELSE NULL END,
                reconciliation_operation_key = $5,
                reconciliation_payload_digest = $6,
                reconciliation_action = $7,
                reconciliation_evidence_digest = $8,
                reconciled_by = $9,
                reconciled_at = now()
          WHERE tenant_id = $1::uuid AND run_id = $2::uuid
            AND request_id = $3::uuid AND state = 'INDETERMINATE'
        RETURNING reconciled_at`,
        [
          input.tenantId, input.runId, input.requestId, state,
          input.operationKey, payloadDigest, input.action,
          input.evidenceDigest, input.reconciledBy,
        ],
      );
      if (updated.rows.length !== 1) throw new InferenceReconciliationConflict("RECONCILIATION_CONFLICT");
      return reconciliationReceipt(input, state, usage, updated.rows[0]!.reconciled_at);
    });
  }

  async #transition(input: GatewayUsageClaimBinding, target: "RELEASED" | "INDETERMINATE"): Promise<void> {
    validateClaimBinding(input);
    await this.#transaction(input.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE deviludo.inference_request_claims
            SET state = $4
          WHERE tenant_id = $1::uuid AND request_id = $2::uuid
            AND claim_token = $3::uuid AND state = 'ACTIVE'`,
        [input.tenantId, input.requestId, input.claimToken, target],
      );
      if (updated.rowCount === 1) return;
      const selected = await client.query<ClaimRow>(
        `SELECT request_id::text, tenant_id::text, project_id::text, run_id::text,
                provider_revision_id, credential_version_id, model, claim_token::text,
                state, claim_expires_at <= now() AS expired
           FROM deviludo.inference_request_claims
          WHERE tenant_id = $1::uuid AND request_id = $2::uuid
          FOR SHARE`,
        [input.tenantId, input.requestId],
      );
      if (selected.rows.length !== 1) invalid();
      const claim = selected.rows[0]!;
      assertClaimBinding(claim, input);
      if (claim.state !== target && !(target === "INDETERMINATE" && claim.state === "COMPLETED")) invalid();
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT to_regclass('deviludo.inference_run_authorizations')::text AS inference_run_authorizations,
                to_regclass('deviludo.agent_run_provider_failovers')::text AS agent_run_provider_failovers,
                to_regclass('deviludo.inference_provider_revisions')::text AS inference_provider_revisions,
                to_regclass('deviludo.inference_usage_events')::text AS inference_usage_events,
                to_regclass('deviludo.inference_request_claims')::text AS inference_request_claims`,
      );
      assertReadyTables(result.rows[0], [
        "inference_run_authorizations", "agent_run_provider_failovers", "inference_provider_revisions",
        "inference_usage_events", "inference_request_claims",
      ]);
    }
    finally { client.release(); }
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
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

function assertReadyTables(row: Record<string, unknown> | undefined, tables: readonly string[]): void {
  if (!row || tables.some((table) => row[table] !== `deviludo.${table}`)) invalid();
}

/** Explicit interface views avoid ambiguous two-argument overload resolution. */
export function inferenceGatewayRegistries(store: PostgresInferenceGatewayStore): Readonly<{
  runs: RunAuthorizationRegistry;
  providers: ProviderRevisionRegistry;
  usage: UsageLedger;
}> {
  return Object.freeze({
    runs: { get: (tenantId, runId) => store.getRun(tenantId, runId) },
    providers: { get: (tenantId, providerRevisionId) => store.getProvider(tenantId, providerRevisionId) },
    usage: {
      get: (tenantId, runId) => store.getUsage(tenantId, runId),
      claim: (input) => store.claim(input),
      complete: (input) => store.complete(input),
      release: (input) => store.release(input),
      abandon: (input) => store.abandon(input),
    },
  });
}

function validateReconciliation(input: InferenceReconciliationRequest): void {
  validateTenantRun(input.tenantId, input.runId);
  if (!UUID.test(input.requestId) || !SHA256.test(input.operationKey)
    || !SHA256.test(input.evidenceDigest) || !SAFE_ACTOR.test(input.reconciledBy)
    || (input.action !== "CONFIRM_NO_USAGE" && input.action !== "RECORD_USAGE")) invalid();
  if (input.action === "CONFIRM_NO_USAGE") {
    if (input.inputTokens !== undefined || input.outputTokens !== undefined) invalid();
    return;
  }
  if (!Number.isSafeInteger(input.inputTokens) || !Number.isSafeInteger(input.outputTokens)
    || input.inputTokens! < 0 || input.outputTokens! < 0
    || input.inputTokens! + input.outputTokens! < 1) invalid();
}

function validateReconciliationClaim(row: ReconciliationClaimRow, input: InferenceReconciliationRequest): void {
  validateClaimRow(row);
  if (row.tenant_id !== input.tenantId || row.run_id !== input.runId || row.request_id !== input.requestId
    || !Number.isFinite(safeNumber(row.input_usd_per_million_tokens))
    || !Number.isFinite(safeNumber(row.output_usd_per_million_tokens))) invalid();
}

function reconciliationPayloadDigest(input: InferenceReconciliationRequest): string {
  return sha256Canonical({
    tenantId: input.tenantId,
    runId: input.runId,
    requestId: input.requestId,
    action: input.action,
    evidenceDigest: input.evidenceDigest,
    reconciledBy: input.reconciledBy,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
  });
}

function reconciledUsage(input: InferenceReconciliationRequest, claim: ReconciliationClaimRow): GatewayUsage {
  if (input.action === "CONFIRM_NO_USAGE") return Object.freeze({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const inputTokens = input.inputTokens!;
  const outputTokens = input.outputTokens!;
  const costUsd = (
    inputTokens * safeNumber(claim.input_usd_per_million_tokens)
    + outputTokens * safeNumber(claim.output_usd_per_million_tokens)
  ) / 1_000_000;
  return Object.freeze({ inputTokens, outputTokens, costUsd });
}

async function replayReconciliation(
  client: PostgresWorkflowClient,
  claim: ReconciliationClaimRow,
  input: InferenceReconciliationRequest,
  payloadDigest: string,
): Promise<InferenceReconciliationReceipt> {
  if (claim.reconciliation_operation_key !== input.operationKey
    || claim.reconciliation_payload_digest !== payloadDigest
    || claim.reconciliation_action !== input.action
    || claim.reconciliation_evidence_digest !== input.evidenceDigest
    || claim.reconciled_by !== input.reconciledBy || claim.reconciled_at === null
    || (claim.state !== "COMPLETED" && claim.state !== "RELEASED")
    || (input.action === "RECORD_USAGE") !== (claim.state === "COMPLETED")) {
    throw new InferenceReconciliationConflict("RECONCILIATION_CONFLICT");
  }
  let usage: GatewayUsage;
  if (claim.state === "COMPLETED") {
    const selected = await client.query<UsageRow>(
      `SELECT input_tokens::text, output_tokens::text, cost_usd::text
         FROM deviludo.inference_usage_events
        WHERE tenant_id = $1::uuid AND request_id = $2::uuid
        FOR SHARE`,
      [input.tenantId, input.requestId],
    );
    if (selected.rows.length !== 1) invalid();
    usage = parseUsage(selected.rows[0]!);
  } else {
    await assertNoUsageEvent(client, input.tenantId, input.requestId);
    usage = Object.freeze({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  }
  return reconciliationReceipt(input, claim.state, usage, claim.reconciled_at);
}

async function assertNoUsageEvent(client: PostgresWorkflowClient, tenantId: string, requestId: string): Promise<void> {
  const selected = await client.query<{ request_id: string }>(
    `SELECT request_id::text
       FROM deviludo.inference_usage_events
      WHERE tenant_id = $1::uuid AND request_id = $2::uuid
      FOR SHARE`,
    [tenantId, requestId],
  );
  if (selected.rows.length !== 0) invalid();
}

function reconciliationReceipt(
  input: InferenceReconciliationRequest,
  state: "COMPLETED" | "RELEASED",
  usage: GatewayUsage,
  reconciledAt: string | Date,
): InferenceReconciliationReceipt {
  const parsedAt = new Date(reconciledAt);
  if (!Number.isFinite(parsedAt.getTime())) invalid();
  const at = parsedAt.toISOString();
  return Object.freeze({
    operationKey: input.operationKey,
    tenantId: input.tenantId,
    runId: input.runId,
    requestId: input.requestId,
    action: input.action,
    evidenceDigest: input.evidenceDigest,
    state,
    usage,
    reconciledAt: at,
  });
}

function isoDate(value: string | Date): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalid();
  return parsed.toISOString();
}

function parseRun(row: RunRow): ActiveRunAuthorization {
  if (!UUID.test(row.tenant_id) || !UUID.test(row.project_id) || !UUID.test(row.run_id)
    || !SAFE_ID.test(row.profile_revision_id) || !SAFE_ID.test(row.provider_revision_id)
    || !SAFE_ID.test(row.credential_version_id) || !SAFE_ID.test(row.nonce)
    || (row.state !== "ACTIVE" && row.state !== "REVOKED" && row.state !== "COMPLETED")) invalid();
  const models = parseModelList(row.models);
  return Object.freeze({
    tenantId: row.tenant_id,
    projectId: row.project_id,
    runId: row.run_id,
    profileRevisionId: row.profile_revision_id,
    providerRevisionId: row.provider_revision_id,
    credentialVersionId: row.credential_version_id,
    models,
    budget: parseBudget(row.budget),
    nonce: row.nonce,
    state: row.state,
  });
}

function parseProvider(row: ProviderRow): GatewayProviderRevision {
  if (!SAFE_ID.test(row.provider_revision_id) || !SAFE_ID.test(row.credential_version_id)
    || (row.agent !== "claude-code" && row.agent !== "codex-cli")
    || (row.protocol !== "anthropic-messages" && row.protocol !== "openai-responses")
    || (row.authentication !== "bearer" && row.authentication !== "x-api-key" && row.authentication !== "authorization-bearer")
    || (row.state !== "ACTIVE" && row.state !== "DEGRADED" && row.state !== "DISABLED")) invalid();
  const approvedPorts = Object.freeze(row.approved_ports.map((value) => safeInteger(value, 1, 65_535)));
  if (approvedPorts.length < 1 || approvedPorts.length > 16 || new Set(approvedPorts).size !== approvedPorts.length) invalid();
  return Object.freeze({
    providerRevisionId: row.provider_revision_id,
    agent: row.agent,
    protocol: row.protocol,
    baseUrl: strictString(row.base_url, 2_048),
    approvedPorts,
    authentication: row.authentication,
    models: parseModels(row.models),
    credentialVersionId: row.credential_version_id,
    pricing: Object.freeze({
      inputUsdPerMillionTokens: safeNumber(row.input_usd_per_million_tokens),
      outputUsdPerMillionTokens: safeNumber(row.output_usd_per_million_tokens),
    }),
    state: row.state,
  });
}

function parseBudget(value: unknown): RunTokenBudget {
  const body = record(value);
  const maxCostUsd = safeNumber(body.maxCostUsd);
  const maxInputTokens = body.maxInputTokens === undefined ? undefined : safeInteger(body.maxInputTokens, 1, Number.MAX_SAFE_INTEGER);
  const maxOutputTokens = body.maxOutputTokens === undefined ? undefined : safeInteger(body.maxOutputTokens, 1, Number.MAX_SAFE_INTEGER);
  return Object.freeze({ maxCostUsd, ...(maxInputTokens === undefined ? {} : { maxInputTokens }), ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) });
}

function parseModels(value: unknown): ModelRoles {
  const body = record(value);
  const result = {
    primaryModel: pinned(body.primaryModel),
    planningModel: pinned(body.planningModel),
    smallFastModel: pinned(body.smallFastModel),
    subagentModel: pinned(body.subagentModel),
  };
  return Object.freeze(result);
}
function parseModelList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) invalid();
  const models = value.map(pinned);
  if (new Set(models).size !== models.length) invalid();
  return Object.freeze(models);
}
function parseUsage(row: UsageRow): GatewayUsage {
  return Object.freeze({
    inputTokens: safeInteger(row.input_tokens, 0, Number.MAX_SAFE_INTEGER),
    outputTokens: safeInteger(row.output_tokens, 0, Number.MAX_SAFE_INTEGER),
    costUsd: safeNumber(row.cost_usd),
  });
}
function validateClaimBinding(input: GatewayUsageClaimBinding): void {
  validateTenantRun(input.tenantId, input.runId);
  if (!UUID.test(input.requestId) || !UUID.test(input.claimToken) || !UUID.test(input.projectId)
    || !SAFE_ID.test(input.providerRevisionId) || !SAFE_ID.test(input.credentialVersionId)
    || pinned(input.model) !== input.model || !Number.isSafeInteger(input.leaseSeconds)
    || input.leaseSeconds < 30 || input.leaseSeconds > 15 * 60) invalid();
}
function validateClaimRow(row: ClaimRow): void {
  if (!UUID.test(row.request_id) || !UUID.test(row.tenant_id) || !UUID.test(row.project_id)
    || !UUID.test(row.run_id) || !UUID.test(row.claim_token) || !SAFE_ID.test(row.provider_revision_id)
    || !SAFE_ID.test(row.credential_version_id) || pinned(row.model) !== row.model
    || (row.state !== "ACTIVE" && row.state !== "COMPLETED" && row.state !== "RELEASED" && row.state !== "INDETERMINATE")
    || typeof row.expired !== "boolean") invalid();
}
function assertClaimBinding(row: ClaimRow, input: GatewayUsageClaimBinding): void {
  validateClaimRow(row);
  if (row.request_id !== input.requestId || row.claim_token !== input.claimToken
    || row.tenant_id !== input.tenantId || row.project_id !== input.projectId || row.run_id !== input.runId
    || row.provider_revision_id !== input.providerRevisionId || row.credential_version_id !== input.credentialVersionId
    || row.model !== input.model) invalid();
}
async function assertUsageReplay(
  client: PostgresWorkflowClient,
  input: GatewayUsageClaimBinding & Readonly<{ usage: GatewayUsage }>,
): Promise<void> {
  const selected = await client.query<UsageEventRow>(
    `SELECT tenant_id::text, project_id::text, run_id::text,
            provider_revision_id, credential_version_id, model,
            input_tokens::text, output_tokens::text, cost_usd::text
       FROM deviludo.inference_usage_events
      WHERE tenant_id = $2::uuid AND request_id = $1::uuid
      FOR SHARE`,
    [input.requestId, input.tenantId],
  );
  if (selected.rows.length !== 1) invalid();
  const row = selected.rows[0]!;
  const usage = parseUsage(row);
  if (row.tenant_id !== input.tenantId || row.project_id !== input.projectId || row.run_id !== input.runId
    || row.provider_revision_id !== input.providerRevisionId || row.credential_version_id !== input.credentialVersionId
    || row.model !== input.model || usage.inputTokens !== input.usage.inputTokens
    || usage.outputTokens !== input.usage.outputTokens || usage.costUsd !== input.usage.costUsd) invalid();
}
function budgetExhausted(budget: RunTokenBudget, usage: GatewayUsage): boolean {
  return usage.costUsd >= budget.maxCostUsd
    || (budget.maxInputTokens !== undefined && usage.inputTokens >= budget.maxInputTokens)
    || (budget.maxOutputTokens !== undefined && usage.outputTokens >= budget.maxOutputTokens);
}
function validateTenantRun(tenantId: string, runId: string): void { if (!UUID.test(tenantId) || !UUID.test(runId)) invalid(); }
function pinned(value: unknown): string { if (typeof value !== "string") invalid(); try { return assertPinnedModelId(value); } catch { invalid(); } }
function safeNumber(value: unknown): number { const parsed = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : NaN; if (!Number.isFinite(parsed) || parsed < 0) invalid(); return parsed; }
function safeInteger(value: unknown, minimum: number, maximum: number): number { const parsed = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : NaN; if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) invalid(); return parsed; }
function strictString(value: unknown, maximum: number): string { if (typeof value !== "string" || value.length < 1 || value.length > maximum || /\0/.test(value)) invalid(); return value; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function invalid(): never { throw new Error("Inference Gateway PostgreSQL state is invalid"); }
