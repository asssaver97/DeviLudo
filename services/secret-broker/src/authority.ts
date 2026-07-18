import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { SecretBrokerConflictError, SecretBrokerValidationError, type InferenceCredentialAuthority } from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SECRET_REF = /^vault:\/\/kv\/deviludo\/records\/[a-f0-9-]{36}$/;

type CatalogCredential = {
  readonly id: string;
  readonly scope: "platform" | "tenant";
  readonly scopeId: string;
  readonly secretRef: string;
  readonly state: "ACTIVE" | "PREVIOUS" | "REVOKED";
};
type CatalogProvider = {
  readonly id: string;
  readonly credentialVersionId: string;
  readonly state: string;
};
type CatalogProfile = {
  readonly providerRevisionId: string;
  readonly credentialVersionId: string;
  readonly scope: "platform" | "tenant" | "project";
  readonly scopeId: string;
  readonly state: string;
};
type Catalog = {
  readonly credentials: readonly CatalogCredential[];
  readonly providers: readonly CatalogProvider[];
  readonly profiles: readonly CatalogProfile[];
};

export class PostgresInferenceCredentialAuthority implements InferenceCredentialAuthority {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async resolveRun(input: Parameters<InferenceCredentialAuthority["resolveRun"]>[0]): Promise<string> {
    validateRun(input);
    return this.#transaction(input.tenantId, async (client) => {
      const authority = await client.query<{ credential_version_id: string }>(
        `SELECT authorization.credential_version_id
           FROM deviludo.inference_run_authorizations authorization
           JOIN deviludo.inference_provider_revisions provider
             ON provider.tenant_id = authorization.tenant_id
            AND provider.provider_revision_id = authorization.provider_revision_id
          WHERE authorization.tenant_id = $1::uuid
            AND authorization.project_id = $2::uuid
            AND authorization.run_id = $3::uuid
            AND authorization.provider_revision_id = $4
            AND authorization.credential_version_id = $5
            AND authorization.state = 'ACTIVE'
            AND authorization.expires_at > now()
            AND provider.credential_version_id = authorization.credential_version_id
            AND provider.state = 'ACTIVE'
          FOR SHARE OF authorization, provider`,
        [input.tenantId, input.projectId, input.runId, input.providerRevisionId, input.credentialVersionId],
      );
      if (authority.rows.length !== 1 || authority.rows[0]?.credential_version_id !== input.credentialVersionId) conflict();
      const catalog = await readCatalog(client);
      const credential = activeCredential(catalog, input.credentialVersionId);
      if (credential.scope === "tenant" && credential.scopeId !== input.tenantId) conflict();
      if (credential.scope === "platform" && credential.scopeId !== "global") conflict();
      return credential.secretRef;
    });
  }

  async resolveProbe(input: Parameters<InferenceCredentialAuthority["resolveProbe"]>[0]): Promise<string> {
    if (!SAFE_ID.test(input.providerRevisionId) || !SAFE_ID.test(input.credentialVersionId)) invalid();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const catalog = await readCatalog(client);
      const provider = catalog.providers.find((value) => value.id === input.providerRevisionId);
      if (!provider || provider.credentialVersionId !== input.credentialVersionId
        || !["VALIDATING", "READY", "ACTIVE"].includes(provider.state)) conflict();
      const profile = catalog.profiles.find((value) => value.providerRevisionId === provider.id
        && value.credentialVersionId === input.credentialVersionId
        && ["VALIDATING", "READY", "ACTIVE"].includes(value.state));
      if (!profile) conflict();
      const credential = activeCredential(catalog, input.credentialVersionId);
      if (profile.scope === "platform") {
        if (credential.scope !== "platform" || credential.scopeId !== "global") conflict();
      } else if (profile.scope === "tenant") {
        if (credential.scope !== "tenant" || credential.scopeId !== profile.scopeId) conflict();
      } else {
        if (credential.scope !== "tenant" || !UUID.test(profile.scopeId) || !UUID.test(credential.scopeId)) conflict();
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [credential.scopeId]);
        const project = await client.query<{ id: string }>(
          `SELECT id FROM deviludo.projects
            WHERE id = $1::uuid AND tenant_id = $2::uuid
            FOR SHARE`,
          [profile.scopeId, credential.scopeId],
        );
        if (project.rows.length !== 1 || project.rows[0]?.id !== profile.scopeId) conflict();
      }
      await client.query("COMMIT");
      return credential.secretRef;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve */ }
      throw error;
    } finally { client.release(); }
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try { const result = await client.query<{ ready: number }>("SELECT 1 AS ready"); if (result.rows[0]?.ready !== 1) conflict(); }
    finally { client.release(); }
  }

  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve */ }
      throw error;
    } finally { client.release(); }
  }
}

export class MemoryInferenceCredentialAuthority implements InferenceCredentialAuthority {
  constructor(
    readonly runSecretRef: string,
    readonly probeSecretRef = runSecretRef,
  ) {}
  async resolveRun(): Promise<string> { return this.runSecretRef; }
  async resolveProbe(): Promise<string> { return this.probeSecretRef; }
  async probe(): Promise<void> {}
}

async function readCatalog(client: PostgresWorkflowClient): Promise<Catalog> {
  const result = await client.query<{ payload: unknown }>(
    `SELECT payload FROM deviludo.admin_catalog_state WHERE singleton = true FOR SHARE`,
  );
  const payload = record(result.rows[0]?.payload);
  if (!Array.isArray(payload.credentials) || !Array.isArray(payload.providers) || !Array.isArray(payload.profiles)) conflict();
  return Object.freeze({
    credentials: payload.credentials.map(parseCredential),
    providers: payload.providers.map(parseProvider),
    profiles: payload.profiles.map(parseProfile),
  });
}
function parseCredential(value: unknown): CatalogCredential {
  const body = record(value);
  if (typeof body.id !== "string" || !SAFE_ID.test(body.id)
    || (body.scope !== "platform" && body.scope !== "tenant")
    || typeof body.scopeId !== "string" || !body.scopeId
    || typeof body.secretRef !== "string" || !SECRET_REF.test(body.secretRef)
    || !["ACTIVE", "PREVIOUS", "REVOKED"].includes(String(body.state))) conflict();
  return body as unknown as CatalogCredential;
}
function parseProvider(value: unknown): CatalogProvider {
  const body = record(value);
  if (typeof body.id !== "string" || !SAFE_ID.test(body.id)
    || typeof body.credentialVersionId !== "string" || !SAFE_ID.test(body.credentialVersionId)
    || typeof body.state !== "string") conflict();
  return body as unknown as CatalogProvider;
}
function parseProfile(value: unknown): CatalogProfile {
  const body = record(value);
  if (typeof body.providerRevisionId !== "string" || !SAFE_ID.test(body.providerRevisionId)
    || typeof body.credentialVersionId !== "string" || !SAFE_ID.test(body.credentialVersionId)
    || !["platform", "tenant", "project"].includes(String(body.scope))
    || typeof body.scopeId !== "string" || !body.scopeId || typeof body.state !== "string") conflict();
  return body as unknown as CatalogProfile;
}
function activeCredential(catalog: Catalog, id: string): CatalogCredential {
  const credential = catalog.credentials.find((value) => value.id === id);
  if (!credential || credential.state !== "ACTIVE") conflict();
  return credential;
}
function validateRun(value: Parameters<InferenceCredentialAuthority["resolveRun"]>[0]): void {
  if (!UUID.test(value.tenantId) || !UUID.test(value.projectId) || !UUID.test(value.runId)
    || !SAFE_ID.test(value.providerRevisionId) || !SAFE_ID.test(value.credentialVersionId)) invalid();
}
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) conflict(); return value as Record<string, unknown>; }
function invalid(): never { throw new SecretBrokerValidationError("Inference credential binding is invalid"); }
function conflict(): never { throw new SecretBrokerConflictError("Inference credential authority rejected the binding"); }
