import type { OnApplicationShutdown } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import { isExactAdapterCompatibility } from "../../../lib/agent/adapter-registry";
import type {
  AgentUsageRecord,
  AgentUsageSummary,
  AgentVersionRecord,
  AuditRecord,
  CredentialVersionRecord,
  InstallationRecord,
  ProfileRevisionRecord,
  ProviderRevisionRecord,
  RequestActor,
} from "./contracts";
import {
  AdminStore,
  emptyAdminCatalogState,
  InMemoryAdminStore,
  type AdminCatalogState,
  type AdminMutationCompletion,
} from "./admin.store";
import { assertAdminCatalogReferences, assertAdminCatalogSchema } from "./admin-catalog-integrity";
import { validatePayload } from "./admin-idempotency";

interface CatalogPayload {
  readonly versions: readonly AgentVersionRecord[];
  readonly installations: readonly InstallationRecord[];
  readonly providers: readonly ProviderRevisionRecord[];
  readonly profiles: readonly ProfileRevisionRecord[];
  readonly credentials: readonly CredentialVersionRecord[];
  readonly defaults: readonly (readonly [string, string])[];
}

type CatalogRow = { revision: string | number; payload: unknown };
type AuditRow = {
  id: string;
  action: string;
  resource: string;
  actor_role: AuditRecord["actorRole"];
  actor_id: string;
  tenant_id: string | null;
  project_id: string | null;
  request_id: string;
  occurred_at: string | Date;
  metadata: unknown;
};
type UsageTotalsRow = {
  requests: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  cost_usd: string | number;
};
type UsageEventRow = {
  request_id: string;
  tenant_id: string;
  project_id: string;
  run_id: string;
  provider_revision_id: string;
  credential_version_id: string;
  model: string;
  input_tokens: string | number;
  output_tokens: string | number;
  cost_usd: string | number;
  recorded_at: string | Date;
};
type CredentialLastUsedRow = {
  credential_version_id: string;
  last_used_at: string | Date;
};

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class PostgresAdminStore extends AdminStore implements OnApplicationShutdown {
  constructor(private readonly pool: Pool) {
    super();
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const catalog = await this.#catalog(client, false);
      const state = deserializeCatalog(catalog.payload, []);
      const projectTenants = await authoritativeProjectTenants(client, state);
      assertAdminCatalogReferences(state, projectTenants, true);
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally { client.release(); }
  }

  async read<T>(operation: (state: AdminCatalogState) => T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const catalog = await this.#catalog(client, false);
      const audit = await client.query<AuditRow>(
        `SELECT id, action, resource, actor_role, actor_id, tenant_id,
                project_id, request_id, occurred_at, metadata
           FROM deviludo.admin_audit_records
          ORDER BY occurred_at DESC, id DESC
          LIMIT 5000`,
      );
      const state = deserializeCatalog(catalog.payload, audit.rows.map(parseAudit));
      const projectTenants = await authoritativeProjectTenants(client, state);
      assertAdminCatalogReferences(state, projectTenants, true);
      const result = operation(state);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async readUsage(actor: RequestActor): Promise<AgentUsageSummary> {
    const client = await this.pool.connect();
    const windowStartedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const parameters: unknown[] = [windowStartedAt];
      const predicates = ["recorded_at >= $1::timestamptz"];
      const credentialParameters: unknown[] = [];
      const credentialPredicates: string[] = [];
      if (actor.tenantId) {
        if (!UUID_PATTERN.test(actor.tenantId)) throw new Error("Administrator usage tenant scope is invalid");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [actor.tenantId]);
        parameters.push(actor.tenantId);
        predicates.push(`tenant_id = $${parameters.length}::uuid`);
        credentialParameters.push(actor.tenantId);
        credentialPredicates.push(`tenant_id = $${credentialParameters.length}::uuid`);
      } else {
        // A platform-wide administrator needs a global projection. A database
        // role without BYPASSRLS fails closed here and health reports telemetry
        // as unavailable instead of returning a partial aggregate.
        await client.query("SET LOCAL row_security = off");
      }
      if (actor.projectId) {
        if (!UUID_PATTERN.test(actor.projectId) || !actor.tenantId) {
          throw new Error("Administrator usage project scope is invalid");
        }
        parameters.push(actor.projectId);
        predicates.push(`project_id = $${parameters.length}::uuid`);
        credentialParameters.push(actor.projectId);
        credentialPredicates.push(`project_id = $${credentialParameters.length}::uuid`);
      }
      const where = predicates.join(" AND ");
      const totals = await client.query<UsageTotalsRow>(
        `SELECT count(*)::text AS requests,
                COALESCE(sum(input_tokens), 0)::text AS input_tokens,
                COALESCE(sum(output_tokens), 0)::text AS output_tokens,
                COALESCE(sum(cost_usd), 0)::text AS cost_usd
           FROM deviludo.inference_usage_events
          WHERE ${where}`,
        parameters,
      );
      const records = await client.query<UsageEventRow>(
        `SELECT request_id::text, tenant_id::text, project_id::text, run_id::text,
                provider_revision_id, credential_version_id, model,
                input_tokens::text, output_tokens::text, cost_usd::text, recorded_at
           FROM deviludo.inference_usage_events
          WHERE ${where}
          ORDER BY recorded_at DESC, request_id DESC
          LIMIT 50`,
        parameters,
      );
      const credentialUsage = await client.query<CredentialLastUsedRow>(
        `SELECT credential_version_id, max(recorded_at) AS last_used_at
           FROM deviludo.inference_usage_events
          WHERE ${credentialPredicates.length ? credentialPredicates.join(" AND ") : "TRUE"}
          GROUP BY credential_version_id
          ORDER BY credential_version_id`,
        credentialParameters,
      );
      const total = totals.rows[0];
      if (!total) throw new Error("Administrator usage aggregate is unavailable");
      const result: AgentUsageSummary = Object.freeze({
        available: true,
        source: "inference_usage_events",
        windowStartedAt,
        credentialLastUsedAt: Object.freeze(Object.fromEntries(credentialUsage.rows.map((row) => {
          const lastUsedAt = new Date(row.last_used_at).toISOString();
          if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$/.test(row.credential_version_id)
            || !Number.isFinite(Date.parse(lastUsedAt))) {
            throw new Error("Administrator credential usage projection is invalid");
          }
          return [row.credential_version_id, lastUsedAt];
        }))),
        totals: Object.freeze({
          requests: usageInteger(total.requests),
          inputTokens: usageInteger(total.input_tokens),
          outputTokens: usageInteger(total.output_tokens),
          costUsd: usageCost(total.cost_usd),
        }),
        records: Object.freeze(records.rows.map(parseUsageRecord)),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async countNonTerminalRuns(installationId: string): Promise<number> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$/.test(installationId)) {
      throw new Error("Agent installation identifier is invalid");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      // PlatformAgentAdmin retirement is intentionally global. A role without
      // BYPASSRLS fails here instead of observing an unsafe partial count.
      await client.query("SET LOCAL row_security = off");
      const selected = await client.query<{ active_count: string | number }>(
        `SELECT count(*) AS active_count
           FROM deviludo.agent_runs
          WHERE installation_id = $1
            AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`,
        [installationId],
      );
      const count = Number(selected.rows[0]?.active_count);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("Agent run retirement guard is unavailable");
      await client.query("COMMIT");
      return count;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async mutate<T>(
    operation: (state: AdminCatalogState) => T,
    completion?: AdminMutationCompletion<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const catalog = await this.#catalog(client, true);
      const state = deserializeCatalog(catalog.payload, []);
      const result = operation(state);
      const projectTenants = await authoritativeProjectTenants(client, state);
      assertAdminCatalogReferences(state, projectTenants, true);
      const completionPayload = completion ? completion.payload(result) : undefined;
      if (completion) validatePayload(completionPayload);
      const payload = serializeCatalog(state);
      validateCatalogSize(payload);
      const updated = await client.query(
        `UPDATE deviludo.admin_catalog_state
            SET revision = revision + 1, payload = $2::jsonb, updated_at = now()
          WHERE singleton = true AND revision = $1::bigint
        RETURNING revision`,
        [catalog.revision, JSON.stringify(payload)],
      );
      if (updated.rowCount !== 1) throw new Error("Administrator catalog revision was concurrently replaced");
      for (const record of [...state.audit].reverse()) await insertAudit(client, record);
      if (completion) {
        const completed = await client.query(
          `UPDATE deviludo.admin_idempotency_results
              SET state = 'COMPLETED', claim_token = NULL,
                  claim_expires_at = NULL, response_payload = $4::jsonb,
                  completed_at = now(), updated_at = now()
            WHERE identity_digest = $1 AND request_fingerprint = $2
              AND state = 'CLAIMED' AND claim_token = $3::uuid
          RETURNING identity_digest`,
          [
            completion.identityDigest,
            completion.requestFingerprint,
            completion.claimToken,
            JSON.stringify(completionPayload),
          ],
        );
        if (completed.rowCount !== 1) {
          throw new Error("Administrator idempotency claim was lost before catalog commit");
        }
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  async #catalog(client: PoolClient, lock: boolean): Promise<CatalogRow> {
    const selected = await client.query<CatalogRow>(
      `SELECT revision, payload
         FROM deviludo.admin_catalog_state
        WHERE singleton = true${lock ? " FOR UPDATE" : ""}`,
    );
    const row = selected.rows[0];
    if (!row || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 0) {
      throw new Error("Administrator catalog state is unavailable");
    }
    return row;
  }
}

export function createAdminStore(): AdminStore {
  if (process.env.NODE_ENV !== "production") return new InMemoryAdminStore();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for production admin persistence");
  const url = new URL(connectionString);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("DATABASE_URL must use PostgreSQL");
  const ca = process.env.DEVILUDO_POSTGRES_TLS_CA;
  return new PostgresAdminStore(new Pool({
    connectionString,
    application_name: "deviludo-control-plane-admin-catalog",
    max: 10,
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
  }));
}

function serializeCatalog(state: AdminCatalogState): CatalogPayload {
  return Object.freeze({
    versions: Object.freeze([...state.versions.values()]),
    installations: Object.freeze([...state.installations.values()]),
    providers: Object.freeze([...state.providers.values()]),
    profiles: Object.freeze([...state.profiles.values()]),
    credentials: Object.freeze([...state.credentials.values()]),
    defaults: Object.freeze([...state.defaults.entries()].map((entry) => Object.freeze(entry))),
  });
}

function deserializeCatalog(value: unknown, audit: readonly AuditRecord[]): AdminCatalogState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Administrator catalog payload is invalid");
  const payload = value as Partial<CatalogPayload>;
  const state = emptyAdminCatalogState();
  loadRecords(payload.versions, state.versions, "version");
  for (const version of state.versions.values()) normalizeAgentVersionCompatibility(version);
  loadRecords(payload.installations, state.installations, "installation");
  for (const installation of state.installations.values()) normalizeInstallationActivation(installation);
  loadRecords(payload.providers, state.providers, "provider");
  loadRecords(payload.profiles, state.profiles, "profile");
  loadRecords(payload.credentials, state.credentials, "credential");
  for (const credential of state.credentials.values()) normalizeCredentialTimestamps(credential);
  if (!Array.isArray(payload.defaults)) throw new Error("Administrator catalog defaults are invalid");
  for (const entry of payload.defaults) {
    if (!Array.isArray(entry) || entry.length !== 2 || !entry.every((item) => typeof item === "string")) {
      throw new Error("Administrator catalog default is invalid");
    }
    state.defaults.set(entry[0], entry[1]);
  }
  state.audit.push(...audit);
  assertAdminCatalogSchema(state);
  return state;
}

async function authoritativeProjectTenants(
  client: PoolClient,
  state: AdminCatalogState,
): Promise<ReadonlyMap<string, string>> {
  const projectIds = new Set<string>();
  for (const profile of state.profiles.values()) if (profile.scope === "project") projectIds.add(profile.scopeId);
  for (const scope of state.defaults.keys()) if (scope.startsWith("project:")) projectIds.add(scope.slice("project:".length));
  if (projectIds.size === 0) return new Map();
  if ([...projectIds].some((id) => !UUID_PATTERN.test(id))) throw new Error("Administrator catalog project identifier is invalid");
  await client.query("SET LOCAL row_security = off");
  const selected = await client.query<{ id: string; tenant_id: string }>(
    `SELECT id::text, tenant_id::text
       FROM deviludo.projects
      WHERE id = ANY($1::uuid[])
      ORDER BY id`,
    [[...projectIds].sort()],
  );
  const result = new Map<string, string>();
  for (const row of selected.rows) {
    if (!UUID_PATTERN.test(row.id) || !UUID_PATTERN.test(row.tenant_id) || !projectIds.has(row.id) || result.has(row.id)) {
      throw new Error("Administrator catalog project tenant binding is invalid");
    }
    result.set(row.id, row.tenant_id);
  }
  if (result.size !== projectIds.size) throw new Error("Administrator catalog project tenant binding is unavailable");
  return result;
}

function normalizeAgentVersionCompatibility(version: AgentVersionRecord): void {
  const mutable = version as unknown as {
    validatedAdapterVersion?: unknown;
    adapterCompatibility?: unknown;
  };
  if (mutable.validatedAdapterVersion === undefined) mutable.validatedAdapterVersion = null;
  if (mutable.adapterCompatibility === undefined) mutable.adapterCompatibility = null;
  if (mutable.validatedAdapterVersion === null && mutable.adapterCompatibility === null) return;
  if (typeof mutable.validatedAdapterVersion !== "string"
    || !mutable.adapterCompatibility || typeof mutable.adapterCompatibility !== "object"
    || Array.isArray(mutable.adapterCompatibility)
    || !isExactAdapterCompatibility(
      mutable.validatedAdapterVersion,
      mutable.adapterCompatibility as Readonly<{ min: string; maxExclusive: string }>,
    )) {
    throw new Error("Administrator catalog Agent version Adapter compatibility is invalid");
  }
}

function normalizeCredentialTimestamps(credential: CredentialVersionRecord): void {
  const mutable = credential as unknown as { createdAt?: unknown; rotatedAt?: unknown; lastUsedAt?: unknown };
  if (mutable.rotatedAt === undefined) mutable.rotatedAt = null;
  if (typeof mutable.createdAt !== "string" || !Number.isFinite(Date.parse(mutable.createdAt))) {
    throw new Error("Administrator catalog credential creation timestamp is invalid");
  }
  for (const field of ["rotatedAt", "lastUsedAt"] as const) {
    if (mutable[field] === undefined) mutable[field] = null;
    if (mutable[field] !== null
      && (typeof mutable[field] !== "string" || !Number.isFinite(Date.parse(mutable[field] as string)))) {
      throw new Error(`Administrator catalog credential ${field} timestamp is invalid`);
    }
  }
}

function normalizeInstallationActivation(installation: InstallationRecord): void {
  const mutable = installation as unknown as {
    activatedAt?: unknown;
    drainingAt?: unknown;
    retiredAt?: unknown;
    runtimeBinding?: unknown;
    fleetHealth?: unknown;
    state: InstallationRecord["state"];
    health: InstallationRecord["health"];
    rolloutPercent: InstallationRecord["rolloutPercent"];
    previousRolloutPercent: InstallationRecord["previousRolloutPercent"];
  };
  if (mutable.runtimeBinding === undefined) mutable.runtimeBinding = null;
  if (mutable.fleetHealth === undefined) mutable.fleetHealth = null;
  if ((mutable.runtimeBinding === null || mutable.fleetHealth === null)
    && ["READY", "CANARY", "ACTIVE", "DRAINING", "RETIRED"].includes(mutable.state)) {
    mutable.previousRolloutPercent = mutable.rolloutPercent;
    mutable.rolloutPercent = 0;
    mutable.state = "QUARANTINED";
    mutable.health = "UNHEALTHY";
  }
  if (mutable.activatedAt === undefined) {
    mutable.activatedAt = installation.state === "ACTIVE" && installation.health === "HEALTHY"
      && installation.rolloutPercent === 100
      ? installation.createdAt
      : null;
  }
  if (mutable.activatedAt !== null
    && (typeof mutable.activatedAt !== "string" || !Number.isFinite(Date.parse(mutable.activatedAt)))) {
    throw new Error("Administrator catalog installation activation timestamp is invalid");
  }
  for (const field of ["drainingAt", "retiredAt"] as const) {
    if (mutable[field] === undefined) mutable[field] = null;
    if (mutable[field] !== null
      && (typeof mutable[field] !== "string" || !Number.isFinite(Date.parse(mutable[field] as string)))) {
      throw new Error(`Administrator catalog installation ${field} timestamp is invalid`);
    }
  }
}

function loadRecords<T extends { readonly id: string }>(
  records: readonly T[] | undefined,
  target: Map<string, T>,
  label: string,
): void {
  if (!Array.isArray(records) || records.length > 100_000) throw new Error(`Administrator catalog ${label} records are invalid`);
  for (const record of records) {
    if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id || target.has(record.id)) {
      throw new Error(`Administrator catalog ${label} record is invalid`);
    }
    target.set(record.id, structuredClone(record));
  }
}

function validateCatalogSize(payload: CatalogPayload): void {
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 16 * 1024 * 1024) {
    throw new Error("Administrator catalog exceeds its storage limit");
  }
}

async function insertAudit(client: PoolClient, record: AuditRecord): Promise<void> {
  await client.query(
    `INSERT INTO deviludo.admin_audit_records
      (id, action, resource, actor_role, actor_id, tenant_id, project_id,
       request_id, occurred_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb)`,
    [
      record.id, record.action, record.resource, record.actorRole, record.actorId,
      record.tenantId, record.projectId, record.requestId, record.at,
      JSON.stringify(record.metadata),
    ],
  );
}

function parseAudit(row: AuditRow): AuditRecord {
  const at = new Date(row.occurred_at).toISOString();
  if (!Number.isFinite(Date.parse(at)) || !row.metadata || typeof row.metadata !== "object" || Array.isArray(row.metadata)) {
    throw new Error("Administrator audit record is invalid");
  }
  return Object.freeze({
    id: row.id,
    action: row.action,
    resource: row.resource,
    actorRole: row.actor_role,
    actorId: row.actor_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    requestId: row.request_id,
    at,
    metadata: Object.freeze(structuredClone(row.metadata) as Record<string, unknown>),
  });
}

function parseUsageRecord(row: UsageEventRow): AgentUsageRecord {
  const recordedAt = new Date(row.recorded_at).toISOString();
  if (![row.request_id, row.tenant_id, row.project_id, row.run_id].every((value) => UUID_PATTERN.test(value))
    || !row.provider_revision_id || !row.credential_version_id || !row.model
    || !Number.isFinite(Date.parse(recordedAt))) {
    throw new Error("Administrator usage record is invalid");
  }
  return Object.freeze({
    requestId: row.request_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    runId: row.run_id,
    providerRevisionId: row.provider_revision_id,
    credentialVersionId: row.credential_version_id,
    model: row.model,
    inputTokens: usageInteger(row.input_tokens),
    outputTokens: usageInteger(row.output_tokens),
    costUsd: usageCost(row.cost_usd),
    recordedAt,
  });
}

function usageInteger(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Administrator usage token total is invalid");
  return parsed;
}

function usageCost(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Administrator usage cost total is invalid");
  return parsed;
}
