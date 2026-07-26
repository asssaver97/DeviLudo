import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import {
  agentMicrovmCredentialRequestDigest,
  type AgentMicrovmCredentialImageRequest,
} from "./guest-credential-contracts";

type AuthorityRow = Readonly<{
  operation_state: string;
  attempt_id: string | null;
  run_state: string;
  configuration_lock: unknown;
  authorization_state: string;
  authorization_expires_at: string;
  failover_to_profile_revision_id: string | null;
  failover_to_provider_revision_id: string | null;
  failover_to_credential_version_id: string | null;
  failover_authorization_expires_at: string | null;
  provider_state: string;
}>;

export interface AgentMicrovmCredentialAuthority {
  authorize(request: AgentMicrovmCredentialImageRequest, at: string): Promise<void>;
  record(input: Readonly<{ request: AgentMicrovmCredentialImageRequest; requesterSpiffeId: string;
    imageDigest: string; imageSizeBytes: number; issuedAt: string }>): Promise<void>;
  probe(): Promise<void>;
}

/** Re-resolves the active AgentRun under tenant RLS before and after image construction. */
export class PostgresAgentMicrovmCredentialAuthority implements AgentMicrovmCredentialAuthority {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async authorize(request: AgentMicrovmCredentialImageRequest, at: string): Promise<void> {
    await this.#transaction(request.tenantId, async (client) => {
      assertAuthority(await selectAuthority(client, request, "FOR SHARE"), request, at);
    });
  }

  async record(input: Readonly<{ request: AgentMicrovmCredentialImageRequest; requesterSpiffeId: string;
    imageDigest: string; imageSizeBytes: number; issuedAt: string }>): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(input.imageDigest) || !Number.isSafeInteger(input.imageSizeBytes)
      || input.imageSizeBytes < 128 * 1024 || input.imageSizeBytes > 64 * 1024 * 1024
      || !validSpiffe(input.requesterSpiffeId) || !canonicalTimestamp(input.issuedAt)) invalid();
    await this.#transaction(input.request.tenantId, async (client) => {
      assertAuthority(await selectAuthority(client, input.request, "FOR SHARE"), input.request, input.issuedAt);
      const inserted = await client.query(
        `INSERT INTO deviludo.agent_microvm_credential_issuances
          (tenant_id, project_id, run_id, attempt_id, request_digest,
           native_request_digest, image_digest, image_size_bytes,
           attestation_key_id, requester_spiffe_id, expires_at, issued_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10,
                 $11::timestamptz, $12::timestamptz)`,
        [input.request.tenantId, input.request.projectId, input.request.runId, input.request.attemptId,
          agentMicrovmCredentialRequestDigest(input.request), input.request.nativeRequestDigest,
          input.imageDigest, input.imageSizeBytes, input.request.attestationKeyId,
          input.requesterSpiffeId, input.request.expiresAt, input.issuedAt],
      );
      if (inserted.rowCount !== 1) invalid();
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT to_regclass('deviludo.agent_microvm_credential_issuances')::text AS issuances,
                to_regclass('deviludo.agent_execution_operations')::text AS operations,
                to_regclass('deviludo.agent_runs')::text AS runs,
                to_regclass('deviludo.inference_run_authorizations')::text AS authorizations,
                to_regclass('deviludo.agent_run_provider_failovers')::text AS failovers,
                to_regclass('deviludo.inference_provider_revisions')::text AS providers`,
      );
      const row = result.rows[0];
      const expected = ["issuances", "operations", "runs", "authorizations", "failovers", "providers"];
      if (!row || expected.some((name) => row[name] !== `deviludo.${name === "issuances" ? "agent_microvm_credential_issuances"
        : name === "operations" ? "agent_execution_operations" : name === "runs" ? "agent_runs"
          : name === "authorizations" ? "inference_run_authorizations" : name === "failovers"
            ? "agent_run_provider_failovers" : "inference_provider_revisions"}`)) invalid();
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

async function selectAuthority(client: PostgresWorkflowClient, request: AgentMicrovmCredentialImageRequest,
  lock: string): Promise<AuthorityRow> {
  const result = await client.query<AuthorityRow>(
    `SELECT operation.state AS operation_state, operation.attempt_id::text,
            run.state AS run_state, run.configuration_lock,
            authorization.state AS authorization_state,
            to_char(authorization.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              AS authorization_expires_at,
            failover.to_profile_revision_id AS failover_to_profile_revision_id,
            failover.to_provider_revision_id AS failover_to_provider_revision_id,
            failover.to_credential_version_id AS failover_to_credential_version_id,
            to_char(failover.authorization_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              AS failover_authorization_expires_at,
            provider.state AS provider_state
       FROM deviludo.agent_execution_operations operation
       JOIN deviludo.agent_runs run
         ON run.tenant_id = operation.tenant_id AND run.project_id = operation.project_id
        AND run.id = operation.run_id
       JOIN deviludo.inference_run_authorizations authorization
         ON authorization.tenant_id = run.tenant_id AND authorization.project_id = run.project_id
        AND authorization.run_id = run.id
       LEFT JOIN deviludo.agent_run_provider_failovers failover
         ON failover.tenant_id = run.tenant_id AND failover.project_id = run.project_id
        AND failover.run_id = run.id
       JOIN deviludo.inference_provider_revisions provider
         ON provider.tenant_id = run.tenant_id
        AND provider.provider_revision_id = COALESCE(failover.to_provider_revision_id, authorization.provider_revision_id)
      WHERE operation.tenant_id = $1::uuid AND operation.project_id = $2::uuid
        AND operation.run_id = $3::uuid ${lock}`,
    [request.tenantId, request.projectId, request.runId],
  );
  if (result.rows.length !== 1 || !result.rows[0]) invalid();
  return result.rows[0];
}

function assertAuthority(row: AuthorityRow, request: AgentMicrovmCredentialImageRequest, at: string): void {
  if (!canonicalTimestamp(at) || row.operation_state !== "RUNNING" || row.run_state !== "RUNNING"
    || row.attempt_id !== request.attemptId || row.authorization_state !== "ACTIVE" || row.provider_state !== "ACTIVE") invalid();
  const lock = record(row.configuration_lock);
  const failoverValues = [row.failover_to_profile_revision_id, row.failover_to_provider_revision_id,
    row.failover_to_credential_version_id, row.failover_authorization_expires_at];
  if (failoverValues.some((value) => value !== null) && !failoverValues.every((value) => value !== null)) invalid();
  const hasFailover = failoverValues.every((value) => value !== null);
  const runtime = hasFailover ? record(lock.fallback) : lock;
  const expiresAt = hasFailover ? row.failover_authorization_expires_at : row.authorization_expires_at;
  if (runtime.profileRevisionId !== request.profileRevisionId || runtime.installationId !== request.installationId
    || runtime.agent !== request.agent || runtime.exactAgentVersion !== request.exactAgentVersion
    || runtime.adapterVersion !== request.adapterVersion || runtime.imageDigest !== request.workerImageDigest
    || runtime.providerRevisionId !== request.providerRevisionId
    || runtime.credentialVersionId !== request.credentialVersionId
    || expiresAt !== request.expiresAt || Date.parse(request.expiresAt) <= Date.parse(at) + 60_000
    || (hasFailover && (row.failover_to_profile_revision_id !== request.profileRevisionId
      || row.failover_to_provider_revision_id !== request.providerRevisionId
      || row.failover_to_credential_version_id !== request.credentialVersionId))) invalid();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function canonicalTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validSpiffe(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "spiffe:" && Boolean(url.hostname) && url.pathname !== "/"
      && !url.username && !url.password && !url.search && !url.hash && url.toString() === value; } catch { return false; }
}
function invalid(): never { throw new Error("Agent microVM credential authority is invalid"); }
