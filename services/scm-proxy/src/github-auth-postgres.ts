import type {
  GitHubAuthorizationIntent,
  GitHubAuthorizationStore,
  GitHubConnectionStatus,
} from "./github-auth-contracts";

export interface ScmPostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface ScmPostgresClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<ScmPostgresQueryResult<Row>>;
  release(): void;
}

export interface ScmPostgresPool {
  connect(): Promise<ScmPostgresClient>;
}

type IntentRow = Record<string, unknown> & {
  id: string;
  state_digest: string;
  tenant_id: string;
  user_subject: string;
  session_binding_digest: string;
  stage: "INSTALL" | "OAUTH";
  installation_id: string | number | bigint | null;
  pkce_verifier_secret_ref: string | null;
  return_path: string;
  status: GitHubAuthorizationIntent["status"];
  claim_token: string | null;
  claim_expires_at: string | Date | null;
  created_at: string | Date;
  expires_at: string | Date;
  completed_at: string | Date | null;
  failure_code: string | null;
};

export class PostgresGitHubAuthorizationStore implements GitHubAuthorizationStore {
  constructor(private readonly pool: ScmPostgresPool) {}

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT to_regclass('deviludo.github_installation_authorizations')::text AS authorizations,
                to_regclass('deviludo.github_installations')::text AS installations`,
      );
      const row = result.rows[0];
      if (row?.authorizations !== "deviludo.github_installation_authorizations"
        || row.installations !== "deviludo.github_installations") {
        throw new Error("GitHub authorization PostgreSQL schema is unavailable");
      }
    } finally { client.release(); }
  }

  async connectionStatus(input: {
    readonly tenantId: string;
    readonly githubUserId: number;
  }): Promise<GitHubConnectionStatus> {
    return this.#transaction(input.tenantId, async (client) => {
      const result = await client.query<Record<string, unknown> & {
        account_login: string;
        repository_selection: "all" | "selected";
        permissions: Record<string, string>;
        verified_at: string | Date;
        installation_count: string | number | bigint;
      }>(
        `SELECT account_login, repository_selection, permissions, verified_at,
                count(*) OVER () AS installation_count
           FROM deviludo.github_installations
          WHERE tenant_id = $1::uuid
            AND verified_by_github_user_id = $2::bigint
            AND status = 'ACTIVE'
          ORDER BY verified_at DESC, installation_id DESC
          LIMIT 1`,
        [input.tenantId, input.githubUserId],
      );
      const row = result.rows[0];
      if (!row) return Object.freeze({
        state: "NOT_CONNECTED" as const,
        installationCount: 0,
        accountLogin: null,
        repositorySelection: null,
        permissions: null,
        verifiedAt: null,
      });
      const installationCount = Number(row.installation_count);
      if (!Number.isSafeInteger(installationCount) || installationCount < 1
        || !row.account_login || !["all", "selected"].includes(row.repository_selection)
        || !row.permissions || typeof row.permissions !== "object" || Array.isArray(row.permissions)) {
        throw new Error("GitHub connection projection is invalid");
      }
      return Object.freeze({
        state: "CONNECTED" as const,
        installationCount,
        accountLogin: row.account_login,
        repositorySelection: row.repository_selection,
        permissions: Object.freeze({ ...row.permissions }),
        verifiedAt: iso(row.verified_at),
      });
    });
  }

  async create(intent: GitHubAuthorizationIntent): Promise<void> {
    await this.#transaction(intent.tenantId, (client) => insertIntent(client, intent));
  }

  async claim(input: Parameters<GitHubAuthorizationStore["claim"]>[0]): Promise<GitHubAuthorizationIntent> {
    return this.#transaction(input.tenantId, async (client) => {
      const claimed = await client.query<IntentRow>(
        `UPDATE deviludo.github_installation_authorizations
            SET status = 'CLAIMED', claim_token = $6::uuid,
                claim_expires_at = $8::timestamptz
          WHERE state_digest = $1
            AND stage = $2
            AND tenant_id = $3::uuid
            AND user_subject = $4
            AND session_binding_digest = $5
            AND status = 'PENDING'
            AND expires_at > $7::timestamptz
        RETURNING *`,
        [
          input.stateDigest,
          input.stage,
          input.tenantId,
          input.userId,
          input.sessionBindingDigest,
          input.claimToken,
          input.claimedAt,
          input.claimExpiresAt,
        ],
      );
      const row = claimed.rows[0];
      if (!row) throw new Error("GitHub authorization state is invalid, expired or already used");
      return parseIntent(row);
    });
  }

  async completeSetup(input: Parameters<GitHubAuthorizationStore["completeSetup"]>[0]): Promise<void> {
    await this.#transaction(input.oauthIntent.tenantId, async (client) => {
      const completed = await client.query(
        `UPDATE deviludo.github_installation_authorizations
            SET status = 'COMPLETED', completed_at = $4::timestamptz,
                claim_token = NULL, claim_expires_at = NULL
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND status = 'CLAIMED' AND claim_token = $3::uuid
        RETURNING id`,
        [input.oauthIntent.tenantId, input.intentId, input.claimToken, input.completedAt],
      );
      if (completed.rowCount !== 1) throw new Error("GitHub authorization setup claim was lost");
      await insertIntent(client, input.oauthIntent);
    });
  }

  async completeOAuth(input: Parameters<GitHubAuthorizationStore["completeOAuth"]>[0]): Promise<void> {
    await this.#transaction(input.tenantId, async (client) => {
      const installation = input.installation;
      const persisted = await client.query(
        `INSERT INTO deviludo.github_installations
          (tenant_id, installation_id, account_node_id, account_login,
           repository_selection, permissions, status, verified_at,
           verified_by_github_user_id, verified_by_github_user_node_id,
           verified_by_github_user_login)
         VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6::jsonb, 'ACTIVE',
                 $7::timestamptz, $8::bigint, $9, $10)
         ON CONFLICT (tenant_id, installation_id) DO UPDATE
           SET account_login = EXCLUDED.account_login,
               repository_selection = EXCLUDED.repository_selection,
               permissions = EXCLUDED.permissions,
               status = 'ACTIVE', verified_at = EXCLUDED.verified_at,
               verified_by_github_user_id = EXCLUDED.verified_by_github_user_id,
               verified_by_github_user_node_id = EXCLUDED.verified_by_github_user_node_id,
               verified_by_github_user_login = EXCLUDED.verified_by_github_user_login,
               updated_at = now()
         WHERE deviludo.github_installations.account_node_id = EXCLUDED.account_node_id
        RETURNING id`,
        [
          input.tenantId,
          installation.installationId,
          installation.accountNodeId,
          installation.accountLogin,
          installation.repositorySelection,
          JSON.stringify(installation.permissions),
          installation.verifiedAt,
          installation.githubUserId,
          installation.githubUserNodeId,
          installation.githubUserLogin,
        ],
      );
      if (persisted.rowCount !== 1) throw new Error("GitHub installation identity changed during authorization");
      const completed = await client.query(
        `UPDATE deviludo.github_installation_authorizations
            SET status = 'COMPLETED', completed_at = $4::timestamptz,
                claim_token = NULL, claim_expires_at = NULL
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND status = 'CLAIMED' AND claim_token = $3::uuid
        RETURNING id`,
        [input.tenantId, input.intentId, input.claimToken, input.completedAt],
      );
      if (completed.rowCount !== 1) throw new Error("GitHub OAuth authorization claim was lost");
    });
  }

  async fail(input: Parameters<GitHubAuthorizationStore["fail"]>[0]): Promise<void> {
    await this.#transaction(input.tenantId, async (client) => {
      await client.query(
        `UPDATE deviludo.github_installation_authorizations
            SET status = 'FAILED', failure_code = $4,
                completed_at = $5::timestamptz,
                claim_token = NULL, claim_expires_at = NULL
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND status = 'CLAIMED' AND claim_token = $3::uuid`,
        [input.tenantId, input.intentId, input.claimToken, input.failureCode, input.failedAt],
      );
    });
  }

  async #transaction<T>(tenantId: string, operation: (client: ScmPostgresClient) => Promise<T>): Promise<T> {
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

async function insertIntent(client: ScmPostgresClient, intent: GitHubAuthorizationIntent): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO deviludo.github_installation_authorizations
      (id, state_digest, tenant_id, user_subject, session_binding_digest,
       stage, installation_id, pkce_verifier_secret_ref, return_path,
       status, claim_token, claim_expires_at, created_at, expires_at,
       completed_at, failure_code)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::bigint, $8, $9,
             $10, $11::uuid, $12::timestamptz, $13::timestamptz,
             $14::timestamptz, $15::timestamptz, $16)
     RETURNING id`,
    [
      intent.id,
      intent.stateDigest,
      intent.tenantId,
      intent.userId,
      intent.sessionBindingDigest,
      intent.stage,
      intent.installationId,
      intent.pkceVerifierSecretRef,
      intent.returnPath,
      intent.status,
      intent.claimToken,
      intent.claimExpiresAt,
      intent.createdAt,
      intent.expiresAt,
      intent.completedAt,
      intent.failureCode,
    ],
  );
  if (inserted.rowCount !== 1) throw new Error("GitHub authorization intent could not be persisted");
}

function parseIntent(row: IntentRow): GitHubAuthorizationIntent {
  return Object.freeze({
    id: row.id,
    stateDigest: row.state_digest,
    tenantId: row.tenant_id,
    userId: row.user_subject,
    sessionBindingDigest: row.session_binding_digest,
    stage: row.stage,
    installationId: row.installation_id === null ? null : String(row.installation_id),
    pkceVerifierSecretRef: row.pkce_verifier_secret_ref,
    returnPath: row.return_path,
    status: row.status,
    claimToken: row.claim_token,
    claimExpiresAt: isoOrNull(row.claim_expires_at),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    completedAt: isoOrNull(row.completed_at),
    failureCode: row.failure_code,
  });
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("GitHub authorization timestamp is invalid");
  return date.toISOString();
}

function isoOrNull(value: string | Date | null): string | null {
  return value === null ? null : iso(value);
}
