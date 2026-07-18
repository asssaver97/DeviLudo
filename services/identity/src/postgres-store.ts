import type {
  IdentityInvitation,
  IdentityLoginIntent,
  IdentityStore,
  PlatformRole,
  StoredIdentityPrincipal,
} from "./contracts";

export interface IdentityPostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}
export interface IdentityPostgresClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<IdentityPostgresQueryResult<Row>>;
  release(): void;
}
export interface IdentityPostgresPool { connect(): Promise<IdentityPostgresClient> }

type LoginRow = Record<string, unknown> & {
  id: string; tenant_id: string; invitation_id: string; state_digest: string; browser_binding_digest: string;
  pkce_verifier_secret_ref: string; status: IdentityLoginIntent["status"]; claim_token: string | null;
  claim_expires_at: string | Date | null; created_at: string | Date; expires_at: string | Date;
  completed_at: string | Date | null; failure_code: string | null;
};
type PrincipalRow = Record<string, unknown> & {
  tenant_id: string; tenant_slug: string; tenant_name: string; user_id: string; membership_id: string;
  role: PlatformRole; github_user_id: string | number | bigint; github_node_id: string; github_login: string;
  display_name: string; avatar_url: string;
};

export class PostgresIdentityStore implements IdentityStore {
  constructor(private readonly pool: IdentityPostgresPool) {}

  async createInvitation(invitation: IdentityInvitation): Promise<void> {
    await this.#transaction(invitation.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO deviludo.tenant_invitations
          (id, tenant_id, token_digest, role, state, login_intent_id, claim_expires_at,
           expires_at, created_by, created_at)
         SELECT $1::uuid, $2::uuid, $3, $4, 'ACTIVE', NULL, NULL, $5::timestamptz, $6, $7::timestamptz
           FROM deviludo.tenants
          WHERE id = $2::uuid AND status = 'ACTIVE'
         RETURNING id`,
        [invitation.id, invitation.tenantId, invitation.tokenDigest, invitation.role,
          invitation.expiresAt, invitation.createdBy, invitation.createdAt],
      );
      if (result.rowCount !== 1) throw new Error("Identity invitation tenant is unavailable");
    });
  }

  async beginLogin(input: Parameters<IdentityStore["beginLogin"]>[0]): Promise<void> {
    await this.#transaction(input.tenantId, async (client) => {
      const invitation = await client.query<{ id: string } & Record<string, unknown>>(
        `UPDATE deviludo.tenant_invitations
            SET state = 'CLAIMED', login_intent_id = $4::uuid, claim_expires_at = $5::timestamptz
          WHERE tenant_id = $1::uuid AND token_digest = $2
            AND expires_at > $3::timestamptz
            AND (state = 'ACTIVE' OR (state = 'CLAIMED' AND claim_expires_at <= $3::timestamptz))
        RETURNING id`,
        [input.tenantId, input.invitationTokenDigest, input.at, input.intent.id, input.intent.expiresAt],
      );
      const invitationId = invitation.rows[0]?.id;
      if (!invitationId) throw new Error("Identity invitation is invalid, expired, revoked or already used");
      const intent = input.intent;
      const inserted = await client.query(
        `INSERT INTO deviludo.identity_login_intents
          (id, tenant_id, invitation_id, state_digest, browser_binding_digest,
           pkce_verifier_secret_ref, status, claim_token, claim_expires_at,
           created_at, expires_at, completed_at, failure_code)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'PENDING', NULL, NULL,
                 $7::timestamptz, $8::timestamptz, NULL, NULL)
         RETURNING id`,
        [intent.id, input.tenantId, invitationId, intent.stateDigest, intent.browserBindingDigest,
          intent.pkceVerifierSecretRef, intent.createdAt, intent.expiresAt],
      );
      if (inserted.rowCount !== 1) throw new Error("Identity login intent could not be persisted");
    });
  }

  async claimLogin(input: Parameters<IdentityStore["claimLogin"]>[0]): Promise<IdentityLoginIntent> {
    return this.#transaction(input.tenantId, async (client) => {
      const result = await client.query<LoginRow>(
        `UPDATE deviludo.identity_login_intents AS login
            SET status = 'CLAIMED', claim_token = $4::uuid, claim_expires_at = $6::timestamptz
           FROM deviludo.tenant_invitations AS invitation
          WHERE login.tenant_id = $1::uuid AND login.state_digest = $2
            AND login.browser_binding_digest = $3 AND login.status = 'PENDING'
            AND login.expires_at > $5::timestamptz
            AND invitation.id = login.invitation_id AND invitation.tenant_id = login.tenant_id
            AND invitation.state = 'CLAIMED' AND invitation.login_intent_id = login.id
            AND invitation.expires_at > $5::timestamptz
        RETURNING login.*`,
        [input.tenantId, input.stateDigest, input.browserBindingDigest, input.claimToken,
          input.claimedAt, input.claimExpiresAt],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Identity OAuth state is invalid, expired or already used");
      return parseLogin(row);
    });
  }

  async completeLogin(input: Parameters<IdentityStore["completeLogin"]>[0]): Promise<StoredIdentityPrincipal> {
    return this.#transaction(input.tenantId, async (client) => {
      const authority = await client.query<{ invitation_id: string; role: PlatformRole } & Record<string, unknown>>(
        `SELECT login.invitation_id, invitation.role
           FROM deviludo.identity_login_intents AS login
           JOIN deviludo.tenant_invitations AS invitation
             ON invitation.id = login.invitation_id AND invitation.tenant_id = login.tenant_id
          WHERE login.tenant_id = $1::uuid AND login.id = $2::uuid
            AND login.status = 'CLAIMED' AND login.claim_token = $3::uuid
            AND login.claim_expires_at > $4::timestamptz
            AND invitation.state = 'CLAIMED' AND invitation.login_intent_id = login.id
            AND invitation.expires_at > $4::timestamptz
          FOR UPDATE OF login, invitation`,
        [input.tenantId, input.intentId, input.claimToken, input.completedAt],
      );
      const authorization = authority.rows[0];
      if (!authorization) throw new Error("Identity login claim was lost or expired");
      const identity = input.identity;
      const user = await client.query<{ id: string } & Record<string, unknown>>(
        `INSERT INTO deviludo.users
          (tenant_id, github_user_id, github_node_id, github_login, display_name, avatar_url, status,
           created_at, updated_at)
         VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6, 'ACTIVE', $7::timestamptz, $7::timestamptz)
         ON CONFLICT (tenant_id, github_user_id) DO UPDATE
           SET github_login = EXCLUDED.github_login, display_name = EXCLUDED.display_name,
               avatar_url = EXCLUDED.avatar_url, updated_at = EXCLUDED.updated_at
         WHERE deviludo.users.github_node_id = EXCLUDED.github_node_id
           AND deviludo.users.status = 'ACTIVE'
        RETURNING id`,
        [input.tenantId, identity.githubUserId, identity.githubNodeId, identity.githubLogin,
          identity.displayName, identity.avatarUrl, input.completedAt],
      );
      const userId = user.rows[0]?.id;
      if (!userId) throw new Error("GitHub account identity conflicts with an existing platform account");
      const membership = await client.query<{ id: string } & Record<string, unknown>>(
        `INSERT INTO deviludo.tenant_memberships
          (tenant_id, user_id, role, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'ACTIVE', $4::timestamptz, $4::timestamptz)
         ON CONFLICT (tenant_id, user_id) DO UPDATE
           SET status = 'ACTIVE', updated_at = EXCLUDED.updated_at
         WHERE deviludo.tenant_memberships.role = EXCLUDED.role
        RETURNING id`,
        [input.tenantId, userId, authorization.role, input.completedAt],
      );
      const membershipId = membership.rows[0]?.id;
      if (!membershipId) throw new Error("Invitation role conflicts with the existing tenant membership");
      const session = input.session;
      const insertedSession = await client.query(
        `INSERT INTO deviludo.platform_sessions
          (id, tenant_id, user_id, membership_id, token_digest, browser_binding_digest,
           state, created_at, expires_at, last_seen_at, revoked_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'ACTIVE',
                 $7::timestamptz, $8::timestamptz, $7::timestamptz, NULL)
         RETURNING id`,
        [session.id, input.tenantId, userId, membershipId, session.tokenDigest,
          session.browserBindingDigest, session.createdAt, session.expiresAt],
      );
      if (insertedSession.rowCount !== 1) throw new Error("Platform session could not be persisted");
      const completed = await client.query(
        `UPDATE deviludo.identity_login_intents
            SET status = 'COMPLETED', claim_token = NULL, claim_expires_at = NULL,
                completed_at = $4::timestamptz
          WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'CLAIMED' AND claim_token = $3::uuid`,
        [input.tenantId, input.intentId, input.claimToken, input.completedAt],
      );
      if (completed.rowCount !== 1) throw new Error("Identity login completion lost its claim");
      const consumed = await client.query(
        `UPDATE deviludo.tenant_invitations
            SET state = 'CONSUMED', claim_expires_at = NULL, consumed_by_user_id = $3::uuid,
                consumed_at = $4::timestamptz
          WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'CLAIMED'`,
        [input.tenantId, authorization.invitation_id, userId, input.completedAt],
      );
      if (consumed.rowCount !== 1) throw new Error("Identity invitation could not be consumed");
      const principal = await client.query<PrincipalRow>(principalSql("membership.id = $2::uuid"), [input.tenantId, membershipId]);
      if (!principal.rows[0]) throw new Error("Platform principal could not be resolved after login");
      return parsePrincipal(principal.rows[0]);
    });
  }

  async failLogin(input: Parameters<IdentityStore["failLogin"]>[0]): Promise<void> {
    await this.#transaction(input.tenantId, async (client) => {
      const failed = await client.query<{ invitation_id: string } & Record<string, unknown>>(
        `UPDATE deviludo.identity_login_intents
            SET status = 'FAILED', claim_token = NULL, claim_expires_at = NULL,
                completed_at = $4::timestamptz, failure_code = $5
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND status = 'CLAIMED' AND claim_token = $3::uuid
        RETURNING invitation_id`,
        [input.tenantId, input.intentId, input.claimToken, input.failedAt, input.failureCode],
      );
      const invitationId = failed.rows[0]?.invitation_id;
      if (invitationId) {
        await client.query(
          `UPDATE deviludo.tenant_invitations
              SET state = 'ACTIVE', login_intent_id = NULL, claim_expires_at = NULL
            WHERE tenant_id = $1::uuid AND id = $2::uuid
              AND state = 'CLAIMED' AND login_intent_id = $3::uuid`,
          [input.tenantId, invitationId, input.intentId],
        );
      }
    });
  }

  async resolveSession(input: Parameters<IdentityStore["resolveSession"]>[0]): Promise<StoredIdentityPrincipal> {
    return this.#transaction(input.tenantId, async (client) => {
      const result = await client.query<PrincipalRow>(
        `${principalSql("session.token_digest = $2 AND session.browser_binding_digest = $3")}
           AND session.state = 'ACTIVE' AND session.expires_at > $4::timestamptz
           AND tenant.status = 'ACTIVE' AND account.status = 'ACTIVE' AND membership.status = 'ACTIVE'`,
        [input.tenantId, input.tokenDigest, input.browserBindingDigest, input.at],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Platform session is invalid, expired, revoked or suspended");
      await client.query(
        `UPDATE deviludo.platform_sessions SET last_seen_at = $4::timestamptz
          WHERE tenant_id = $1::uuid AND token_digest = $2 AND browser_binding_digest = $3
            AND state = 'ACTIVE' AND expires_at > $4::timestamptz`,
        [input.tenantId, input.tokenDigest, input.browserBindingDigest, input.at],
      );
      return parsePrincipal(row);
    });
  }

  async revokeSession(input: Parameters<IdentityStore["revokeSession"]>[0]): Promise<boolean> {
    return this.#transaction(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE deviludo.platform_sessions SET state = 'REVOKED', revoked_at = $4::timestamptz
          WHERE tenant_id = $1::uuid AND token_digest = $2 AND browser_binding_digest = $3
            AND state = 'ACTIVE' RETURNING id`,
        [input.tenantId, input.tokenDigest, input.browserBindingDigest, input.revokedAt],
      );
      return result.rowCount === 1;
    });
  }

  async #transaction<T>(tenantId: string, operation: (client: IdentityPostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
      throw error;
    } finally { client.release(); }
  }
}

function principalSql(predicate: string): string {
  return `SELECT tenant.id AS tenant_id, tenant.slug AS tenant_slug, tenant.name AS tenant_name,
                 account.id AS user_id, membership.id AS membership_id, membership.role,
                 account.github_user_id, account.github_node_id, account.github_login,
                 account.display_name, account.avatar_url
            FROM deviludo.platform_sessions AS session
            JOIN deviludo.tenants AS tenant ON tenant.id = session.tenant_id
            JOIN deviludo.users AS account ON account.id = session.user_id AND account.tenant_id = session.tenant_id
            JOIN deviludo.tenant_memberships AS membership
              ON membership.id = session.membership_id AND membership.user_id = account.id
             AND membership.tenant_id = session.tenant_id
           WHERE session.tenant_id = $1::uuid AND ${predicate}`;
}
function parseLogin(row: LoginRow): IdentityLoginIntent {
  return Object.freeze({
    id: row.id, tenantId: row.tenant_id, invitationId: row.invitation_id, stateDigest: row.state_digest,
    browserBindingDigest: row.browser_binding_digest, pkceVerifierSecretRef: row.pkce_verifier_secret_ref,
    status: row.status, claimToken: row.claim_token, claimExpiresAt: isoOrNull(row.claim_expires_at),
    createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), completedAt: isoOrNull(row.completed_at),
    failureCode: row.failure_code,
  });
}
function parsePrincipal(row: PrincipalRow): StoredIdentityPrincipal {
  const githubUserId = Number(row.github_user_id);
  if (!Number.isSafeInteger(githubUserId) || githubUserId < 1) throw new Error("Stored GitHub user ID is invalid");
  return Object.freeze({
    tenantId: row.tenant_id, tenantSlug: row.tenant_slug, tenantName: row.tenant_name,
    userId: row.user_id, membershipId: row.membership_id, role: row.role, githubUserId,
    githubNodeId: row.github_node_id, githubLogin: row.github_login, displayName: row.display_name,
    avatarUrl: row.avatar_url,
  });
}
function iso(value: string | Date): string { const result = value instanceof Date ? value : new Date(value); if (!Number.isFinite(result.getTime())) throw new Error("Identity timestamp is invalid"); return result.toISOString(); }
function isoOrNull(value: string | Date | null): string | null { return value === null ? null : iso(value); }
