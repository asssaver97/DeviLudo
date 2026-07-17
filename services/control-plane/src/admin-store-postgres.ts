import type { OnApplicationShutdown } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import type {
  AgentVersionRecord,
  AuditRecord,
  CredentialVersionRecord,
  InstallationRecord,
  ProfileRevisionRecord,
  ProviderRevisionRecord,
} from "./contracts";
import {
  AdminStore,
  emptyAdminCatalogState,
  InMemoryAdminStore,
  type AdminCatalogState,
  type AdminMutationCompletion,
} from "./admin.store";
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

export class PostgresAdminStore extends AdminStore implements OnApplicationShutdown {
  constructor(private readonly pool: Pool) {
    super();
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
  loadRecords(payload.installations, state.installations, "installation");
  loadRecords(payload.providers, state.providers, "provider");
  loadRecords(payload.profiles, state.profiles, "profile");
  loadRecords(payload.credentials, state.credentials, "credential");
  if (!Array.isArray(payload.defaults)) throw new Error("Administrator catalog defaults are invalid");
  for (const entry of payload.defaults) {
    if (!Array.isArray(entry) || entry.length !== 2 || !entry.every((item) => typeof item === "string")) {
      throw new Error("Administrator catalog default is invalid");
    }
    state.defaults.set(entry[0], entry[1]);
  }
  state.audit.push(...audit);
  return state;
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
