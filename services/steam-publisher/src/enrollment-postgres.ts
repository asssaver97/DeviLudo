import type { SteamBuildSession } from "./contracts";
import type { SteamEnrollmentRecord, SteamEnrollmentStore } from "./enrollment-contracts";

export interface SteamPostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface SteamPostgresClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SteamPostgresQueryResult<Row>>;
  release(): void;
}

export interface SteamPostgresPool {
  connect(): Promise<SteamPostgresClient>;
}

type EnrollmentRow = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  user_subject: string;
  session_binding_digest: string;
  idempotency_key: string;
  request_digest: string;
  state: SteamEnrollmentRecord["state"];
  challenge_secret_ref: string | null;
  created_at: string | Date;
  expires_at: string | Date;
  completed_at: string | Date | null;
  session_id: string | null;
  account_id: string | null;
  account_name: string | null;
  config_vdf_secret_ref: string | null;
  credential_version_id: string | null;
  allowed_app_ids: string[] | null;
  permissions: SteamBuildSession["permissions"] | null;
  session_state: SteamBuildSession["state"] | null;
  verified_at: string | Date | null;
  session_expires_at: string | Date | null;
};

const SELECT_ENROLLMENT = `SELECT e.*,
       s.id AS session_id, s.account_id, s.account_name,
       s.config_vdf_secret_ref, s.credential_version_id,
       s.allowed_app_ids, s.permissions, s.state AS session_state,
       s.verified_at, s.expires_at AS session_expires_at
  FROM deviludo.steam_enrollments e
  LEFT JOIN deviludo.steam_build_sessions s ON s.id = e.build_session_id`;

export class PostgresSteamEnrollmentStore implements SteamEnrollmentStore {
  constructor(private readonly pool: SteamPostgresPool) {}

  async create(input: Parameters<SteamEnrollmentStore["create"]>[0]): Promise<SteamEnrollmentRecord> {
    return this.#transaction(input.tenantId, async (client) => {
      const inserted = await client.query<EnrollmentRow>(
        `INSERT INTO deviludo.steam_enrollments
          (id, tenant_id, user_subject, session_binding_digest,
           idempotency_key, request_digest, state, created_at, expires_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6,
                 'WAITING_CREDENTIALS', $7::timestamptz, $8::timestamptz)
         ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
           SET idempotency_key = EXCLUDED.idempotency_key
         WHERE deviludo.steam_enrollments.request_digest = EXCLUDED.request_digest
         RETURNING *, NULL::uuid AS session_id, NULL::text AS account_id,
                   NULL::text AS account_name, NULL::text AS config_vdf_secret_ref,
                   NULL::uuid AS credential_version_id, NULL::text[] AS allowed_app_ids,
                   NULL::text[] AS permissions, NULL::text AS session_state,
                   NULL::timestamptz AS verified_at,
                   NULL::timestamptz AS session_expires_at`,
        [
          input.id,
          input.tenantId,
          input.userId,
          input.sessionBindingDigest,
          input.idempotencyKey,
          input.requestDigest,
          input.createdAt,
          input.expiresAt,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("Steam enrollment idempotency key conflicts with another request");
      return parseEnrollment(row);
    });
  }

  async find(input: Parameters<SteamEnrollmentStore["find"]>[0]): Promise<SteamEnrollmentRecord> {
    return this.#transaction(input.tenantId, async (client) => {
      const found = await client.query<EnrollmentRow>(
        `${SELECT_ENROLLMENT}
          WHERE e.id = $1::uuid AND e.tenant_id = $2::uuid
            AND e.user_subject = $3 AND e.session_binding_digest = $4`,
        [input.enrollmentId, input.tenantId, input.userId, input.sessionBindingDigest],
      );
      const row = found.rows[0];
      if (!row) throw new Error("Steam enrollment principal does not match");
      return parseEnrollment(row);
    });
  }

  async saveChallenge(input: Parameters<SteamEnrollmentStore["saveChallenge"]>[0]): Promise<SteamEnrollmentRecord> {
    return this.#transaction(input.tenantId, async (client) => {
      const updated = await client.query<EnrollmentRow>(
        `UPDATE deviludo.steam_enrollments
            SET state = 'WAITING_STEAM_GUARD', challenge_secret_ref = $3
          WHERE id = $1::uuid AND tenant_id = $2::uuid
            AND state = 'WAITING_CREDENTIALS' AND expires_at > $4::timestamptz
        RETURNING *, NULL::uuid AS session_id, NULL::text AS account_id,
                  NULL::text AS account_name, NULL::text AS config_vdf_secret_ref,
                  NULL::uuid AS credential_version_id, NULL::text[] AS allowed_app_ids,
                  NULL::text[] AS permissions, NULL::text AS session_state,
                  NULL::timestamptz AS verified_at,
                  NULL::timestamptz AS session_expires_at`,
        [input.enrollmentId, input.tenantId, input.challengeSecretRef, input.at],
      );
      const row = updated.rows[0];
      if (!row) throw new Error("Steam enrollment transition was rejected");
      return parseEnrollment(row);
    });
  }

  async complete(input: Parameters<SteamEnrollmentStore["complete"]>[0]): Promise<SteamEnrollmentRecord> {
    return this.#transaction(input.tenantId, async (client) => {
      const session = input.session;
      const enrollment = await client.query(
        `SELECT id FROM deviludo.steam_enrollments
          WHERE id = $1::uuid AND tenant_id = $2::uuid
            AND state IN ('WAITING_CREDENTIALS', 'WAITING_STEAM_GUARD')
            AND expires_at > $3::timestamptz
          FOR UPDATE`,
        [input.enrollmentId, input.tenantId, input.at],
      );
      if (enrollment.rowCount !== 1) throw new Error("Steam enrollment completion was rejected");
      const credential = await client.query(
        `INSERT INTO deviludo.credential_versions
          (id, tenant_id, binding_id, secret_ref, fingerprint, masked_value, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'ACTIVE')
         RETURNING id`,
        [
          session.credentialVersionId,
          input.tenantId,
          input.credentialBindingId,
          session.configVdfSecretRef,
          input.fingerprint,
          input.maskedValue,
        ],
      );
      if (credential.rowCount !== 1) throw new Error("Steam credential metadata could not be persisted");
      const persistedSession = await client.query(
        `INSERT INTO deviludo.steam_build_sessions
          (id, tenant_id, account_id, account_name, config_vdf_secret_ref,
           credential_version_id, allowed_app_ids, permissions, state,
           verified_at, expires_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid,
                 $7::text[], $8::text[], 'ACTIVE',
                 $9::timestamptz, $10::timestamptz)
         RETURNING id`,
        [
          session.id,
          session.tenantId,
          session.accountId,
          session.accountName,
          session.configVdfSecretRef,
          session.credentialVersionId,
          session.allowedAppIds,
          session.permissions,
          session.verifiedAt,
          session.expiresAt,
        ],
      );
      if (persistedSession.rowCount !== 1) throw new Error("Steam build session could not be persisted");
      const completed = await client.query<EnrollmentRow>(
        `UPDATE deviludo.steam_enrollments
            SET state = 'READY', challenge_secret_ref = NULL,
                build_session_id = $3::uuid, completed_at = $4::timestamptz
          WHERE id = $1::uuid AND tenant_id = $2::uuid
        RETURNING *, $3::uuid AS session_id, $5::text AS account_id,
                  $6::text AS account_name, $7::text AS config_vdf_secret_ref,
                  $8::uuid AS credential_version_id, $9::text[] AS allowed_app_ids,
                  $10::text[] AS permissions, 'ACTIVE'::text AS session_state,
                  $11::timestamptz AS verified_at,
                  $12::timestamptz AS session_expires_at`,
        [
          input.enrollmentId,
          input.tenantId,
          session.id,
          input.at,
          session.accountId,
          session.accountName,
          session.configVdfSecretRef,
          session.credentialVersionId,
          session.allowedAppIds,
          session.permissions,
          session.verifiedAt,
          session.expiresAt,
        ],
      );
      const row = completed.rows[0];
      if (!row) throw new Error("Steam enrollment completion was rejected");
      return parseEnrollment(row);
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

function parseEnrollment(row: EnrollmentRow): SteamEnrollmentRecord {
  let buildSession: SteamBuildSession | null = null;
  if (row.session_id !== null) {
    if (!row.account_id || !row.account_name || !row.config_vdf_secret_ref || !row.credential_version_id
      || !row.allowed_app_ids || !row.permissions || !row.session_state || !row.verified_at || !row.session_expires_at) {
      throw new Error("Steam persisted build session is incomplete");
    }
    buildSession = Object.freeze({
      id: row.session_id,
      tenantId: row.tenant_id,
      accountId: row.account_id,
      accountName: row.account_name,
      configVdfSecretRef: row.config_vdf_secret_ref,
      credentialVersionId: row.credential_version_id,
      allowedAppIds: Object.freeze([...row.allowed_app_ids]),
      permissions: Object.freeze([...row.permissions]),
      state: row.session_state,
      verifiedAt: iso(row.verified_at),
      expiresAt: iso(row.session_expires_at),
    });
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_subject,
    sessionBindingDigest: row.session_binding_digest,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    state: row.state,
    challengeSecretRef: row.challenge_secret_ref,
    buildSession,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
  });
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Steam enrollment timestamp is invalid");
  return date.toISOString();
}
