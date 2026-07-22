import type { SignedSteamPublishAuthorization } from "./contracts";
import type {
  ReleaseAuthorizationRecord,
  ReleaseAuthorizationStore,
} from "./release-authorization-contracts";
import type {
  SteamPostgresClient,
  SteamPostgresPool,
} from "./enrollment-postgres";
import { probeSteamPostgresTables } from "./postgres-readiness";

type AuthorizationRow = Record<string, unknown> & {
  approval_id: string;
  tenant_id: string;
  project_id: string;
  release_id: string;
  workflow_id: string;
  user_subject: string;
  session_binding_digest: string;
  idempotency_key: string;
  request_digest: string;
  state: ReleaseAuthorizationRecord["state"];
  main_commit_sha: string;
  evidence_bundle_digest: string;
  authorization_url: string | null;
  mfa_assertion_id: string | null;
  signed_authorization: unknown | null;
  created_at: string | Date;
  expires_at: string | Date;
  verified_at: string | Date | null;
  dispatched_at: string | Date | null;
};

export class PostgresReleaseAuthorizationStore implements ReleaseAuthorizationStore {
  constructor(private readonly pool: SteamPostgresPool) {}

  async reserve(input: Parameters<ReleaseAuthorizationStore["reserve"]>[0]) {
    return this.#transaction(input.tenantId, async (client) => {
      const result = await client.query<AuthorizationRow>(
        `INSERT INTO deviludo.steam_release_authorizations
          (approval_id, tenant_id, project_id, release_id, workflow_id,
           user_subject, session_binding_digest, idempotency_key,
           request_digest, state, main_commit_sha, evidence_bundle_digest,
           created_at, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
                 $6, $7, $8, $9, 'CREATING', $10, $11,
                 $12::timestamptz, $13::timestamptz)
         ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
           SET idempotency_key = EXCLUDED.idempotency_key
         WHERE deviludo.steam_release_authorizations.request_digest = EXCLUDED.request_digest
         RETURNING *`,
        [
          input.approvalId,
          input.tenantId,
          input.snapshot.projectId,
          input.snapshot.releaseId,
          input.snapshot.workflowId,
          input.userId,
          input.sessionBindingDigest,
          input.idempotencyKey,
          input.requestDigest,
          input.snapshot.mainCommitSha,
          input.snapshot.evidenceBundleDigest,
          input.createdAt,
          input.expiresAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Release authorization idempotency key conflicts with another request");
      const record = parseRecord(row);
      if (record.requestDigest !== input.requestDigest) throw new Error("Release authorization idempotency key conflicts with another request");
      const kind = record.approvalId === input.approvalId ? "CREATED" as const : "EXISTING" as const;
      if (kind === "EXISTING" && record.state === "CREATING") throw new Error("Release authorization challenge is being created");
      return { kind, record };
    });
  }

  async activate(input: Parameters<ReleaseAuthorizationStore["activate"]>[0]) {
    return this.#update(
      input.tenantId,
      `UPDATE deviludo.steam_release_authorizations
          SET state = 'MFA_REQUIRED', authorization_url = $3
        WHERE approval_id = $1::uuid AND tenant_id = $2::uuid AND state = 'CREATING'
      RETURNING *`,
      [input.approvalId, input.tenantId, input.authorizationUrl],
      "Release authorization activation was rejected",
    );
  }

  async find(input: Parameters<ReleaseAuthorizationStore["find"]>[0]) {
    return this.#transaction(input.tenantId, async (client) => {
      const result = await client.query<AuthorizationRow>(
        `SELECT * FROM deviludo.steam_release_authorizations
          WHERE approval_id = $1::uuid AND tenant_id = $2::uuid`,
        [input.approvalId, input.tenantId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Release authorization was not found");
      return parseRecord(row);
    });
  }

  async markVerified(input: Parameters<ReleaseAuthorizationStore["markVerified"]>[0]) {
    return this.#update(
      input.tenantId,
      `UPDATE deviludo.steam_release_authorizations
          SET state = 'VERIFIED', mfa_assertion_id = $3,
              signed_authorization = $4::jsonb, verified_at = $5::timestamptz
        WHERE approval_id = $1::uuid AND tenant_id = $2::uuid
          AND state = 'MFA_REQUIRED' AND expires_at > $5::timestamptz
      RETURNING *`,
      [input.approvalId, input.tenantId, input.mfaAssertionId, JSON.stringify(input.authorization), input.verifiedAt],
      "Release authorization verification was rejected",
    );
  }

  async markDispatched(input: Parameters<ReleaseAuthorizationStore["markDispatched"]>[0]) {
    return this.#update(
      input.tenantId,
      `UPDATE deviludo.steam_release_authorizations
          SET state = 'DISPATCHED', dispatched_at = $3::timestamptz
        WHERE approval_id = $1::uuid AND tenant_id = $2::uuid AND state = 'VERIFIED'
      RETURNING *`,
      [input.approvalId, input.tenantId, input.dispatchedAt],
      "Release authorization dispatch was rejected",
    );
  }

  async fail(input: Parameters<ReleaseAuthorizationStore["fail"]>[0]): Promise<void> {
    await this.#transaction(input.tenantId, async (client) => {
      await client.query(
        `UPDATE deviludo.steam_release_authorizations SET state = 'FAILED'
          WHERE approval_id = $1::uuid AND tenant_id = $2::uuid AND state = 'CREATING'`,
        [input.approvalId, input.tenantId],
      );
    });
  }

  async probe(): Promise<void> {
    await probeSteamPostgresTables(this.pool, ["steam_release_authorizations"],
      () => new Error("Steam release authorization schema is unavailable"));
  }

  async #update(
    tenantId: string,
    sql: string,
    values: readonly unknown[],
    failure: string,
  ): Promise<ReleaseAuthorizationRecord> {
    return this.#transaction(tenantId, async (client) => {
      const result = await client.query<AuthorizationRow>(sql, values);
      const row = result.rows[0];
      if (!row) throw new Error(failure);
      return parseRecord(row);
    });
  }

  async #transaction<T>(tenantId: string, operation: (client: SteamPostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the primary error */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

function parseRecord(row: AuthorizationRow): ReleaseAuthorizationRecord {
  return Object.freeze({
    approvalId: row.approval_id,
    tenantId: row.tenant_id,
    userId: row.user_subject,
    sessionBindingDigest: row.session_binding_digest,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    snapshot: Object.freeze({
      tenantId: row.tenant_id,
      projectId: row.project_id,
      releaseId: row.release_id,
      workflowId: row.workflow_id,
      acceptedBy: row.user_subject,
      state: "WAITING_MFA" as const,
      mainCommitSha: row.main_commit_sha,
      evidenceBundleDigest: row.evidence_bundle_digest,
    }),
    state: row.state,
    authorizationUrl: row.authorization_url,
    mfaAssertionId: row.mfa_assertion_id,
    signedAuthorization: row.signed_authorization === null ? null : parseAuthorization(row.signed_authorization),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    verifiedAt: row.verified_at === null ? null : iso(row.verified_at),
    dispatchedAt: row.dispatched_at === null ? null : iso(row.dispatched_at),
  });
}

function parseAuthorization(value: unknown): SignedSteamPublishAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored Steam publish authorization is invalid");
  const artifact = value as Record<string, unknown>;
  if (typeof artifact.keyId !== "string" || typeof artifact.signature !== "string"
    || !artifact.claims || typeof artifact.claims !== "object" || Array.isArray(artifact.claims)) {
    throw new Error("Stored Steam publish authorization is invalid");
  }
  return Object.freeze({
    keyId: artifact.keyId,
    signature: artifact.signature,
    claims: Object.freeze({ ...(artifact.claims as SignedSteamPublishAuthorization["claims"]) }),
  });
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Release authorization timestamp is invalid");
  return date.toISOString();
}
