import { assertPinnedModelId } from "../../../lib/agent/providers";
import type { ModelRoles } from "../../../lib/agent/types";
import type { RunTokenBudget } from "../../../lib/security/credentials";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type {
  ActiveRunAuthorization,
  GatewayProviderRevision,
  GatewayUsage,
  ProviderRevisionRegistry,
  RunAuthorizationRegistry,
  UsageLedger,
} from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

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

/** Tenant-RLS registry and append-only usage ledger for the production Gateway. */
export class PostgresInferenceGatewayStore {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async getRun(tenantId: string, runId: string): Promise<ActiveRunAuthorization | null> {
    validateTenantRun(tenantId, runId);
    return this.#transaction(tenantId, async (client) => {
      const selected = await client.query<RunRow>(
        `SELECT tenant_id::text, project_id::text, run_id::text,
                profile_revision_id, provider_revision_id, credential_version_id,
                models, budget, nonce, state
           FROM deviludo.inference_run_authorizations
          WHERE tenant_id = $1::uuid AND run_id = $2::uuid
            AND expires_at > now()
          FOR SHARE`,
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

  async record(input: Parameters<UsageLedger["record"]>[0]): Promise<void> {
    validateUsageInput(input);
    await this.#transaction(input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.inference_usage_events
          (request_id, tenant_id, project_id, run_id, provider_revision_id,
           credential_version_id, model, input_tokens, output_tokens, cost_usd)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (request_id) DO NOTHING`,
        [
          input.requestId, input.tenantId, input.projectId, input.runId,
          input.providerRevisionId, input.credentialVersionId, input.model,
          input.usage.inputTokens, input.usage.outputTokens, input.usage.costUsd,
        ],
      );
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
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query("SELECT 1 AS inference_gateway_store_probe"); }
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
      record: (input) => store.record(input),
    },
  });
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
function validateUsageInput(input: Parameters<UsageLedger["record"]>[0]): void {
  validateTenantRun(input.tenantId, input.runId);
  if (!UUID.test(input.requestId) || !UUID.test(input.projectId) || !SAFE_ID.test(input.providerRevisionId)
    || !SAFE_ID.test(input.credentialVersionId) || pinned(input.model) !== input.model) invalid();
  parseUsage({ input_tokens: input.usage.inputTokens, output_tokens: input.usage.outputTokens, cost_usd: input.usage.costUsd });
}
function validateTenantRun(tenantId: string, runId: string): void { if (!UUID.test(tenantId) || !UUID.test(runId)) invalid(); }
function pinned(value: unknown): string { if (typeof value !== "string") invalid(); try { return assertPinnedModelId(value); } catch { invalid(); } }
function safeNumber(value: unknown): number { const parsed = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : NaN; if (!Number.isFinite(parsed) || parsed < 0) invalid(); return parsed; }
function safeInteger(value: unknown, minimum: number, maximum: number): number { const parsed = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : NaN; if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) invalid(); return parsed; }
function strictString(value: unknown, maximum: number): string { if (typeof value !== "string" || value.length < 1 || value.length > maximum || /\0/.test(value)) invalid(); return value; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function invalid(): never { throw new Error("Inference Gateway PostgreSQL state is invalid"); }
