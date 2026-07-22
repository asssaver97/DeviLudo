import type { SteamBuildSession } from "./contracts";
import type {
  SteamPlatformDepots,
  SteamProjectConfigurationIntent,
  SteamProjectConfigurationStore,
  SteamProjectReleaseConfiguration,
} from "./project-configuration-contracts";
import type { SteamPostgresClient, SteamPostgresPool } from "./enrollment-postgres";
import { probeSteamPostgresTables } from "./postgres-readiness";

type IntentRow = Record<string, unknown> & {
  id: string; tenant_id: string; project_id: string; user_subject: string; session_binding_digest: string;
  steam_build_session_id: string; idempotency_key: string; request_digest: string;
  state: SteamProjectConfigurationIntent["state"]; release_configuration_id: string | null;
  created_at: string | Date; expires_at: string | Date; completed_at: string | Date | null;
  account_id: string; account_name: string; config_vdf_secret_ref: string; credential_version_id: string;
  allowed_app_ids: string[]; permissions: SteamBuildSession["permissions"];
  session_state: SteamBuildSession["state"]; verified_at: string | Date; session_expires_at: string | Date;
};

type ConfigurationRow = Record<string, unknown> & {
  id: string; project_id: string; revision: number; steam_app_id: string; beta_branch: string;
  platform_depots: unknown; steam_build_session_id: string; session_state: SteamBuildSession["state"];
  session_expires_at: string | Date; account_name: string; created_at: string | Date;
};

const SELECT_INTENT = `SELECT i.*, s.account_id, s.account_name, s.config_vdf_secret_ref,
       s.credential_version_id, s.allowed_app_ids, s.permissions,
       s.state AS session_state, s.verified_at, s.expires_at AS session_expires_at
  FROM deviludo.steam_project_configuration_intents i
  JOIN deviludo.steam_build_sessions s
    ON s.tenant_id = i.tenant_id AND s.id = i.steam_build_session_id`;

const SELECT_CONFIGURATION = `SELECT r.id, r.project_id, r.revision, r.steam_app_id,
       r.beta_branch, d.platform_depots, r.steam_build_session_id,
       s.state AS session_state, s.expires_at AS session_expires_at,
       s.account_name, r.created_at
  FROM deviludo.steam_project_release_configurations r
  JOIN deviludo.steam_project_depot_configurations d
    ON d.tenant_id = r.tenant_id AND d.project_id = r.project_id
   AND d.id = r.depot_configuration_id AND d.state = 'ACTIVE'
  JOIN deviludo.steam_build_sessions s
    ON s.tenant_id = r.tenant_id AND s.id = r.steam_build_session_id
 WHERE r.state = 'ACTIVE'`;

export class PostgresSteamProjectConfigurationStore implements SteamProjectConfigurationStore {
  constructor(private readonly pool: SteamPostgresPool) {}

  async probe(): Promise<void> {
    await probeSteamPostgresTables(this.pool, [
      "projects", "steam_build_sessions", "steam_enrollments", "steam_project_configuration_intents",
      "steam_project_depot_configurations", "steam_project_release_configurations", "tenant_memberships", "users",
    ], () => new Error("Steam project configuration schema is unavailable"));
  }

  async findStatus(input: Parameters<SteamProjectConfigurationStore["findStatus"]>[0]) {
    return this.#transaction(input.tenantId, async (client) => {
      const [configuration, intent] = await Promise.all([
        client.query<ConfigurationRow>(`${SELECT_CONFIGURATION}
          AND r.tenant_id = $1::uuid AND r.project_id = $2::uuid`, [input.tenantId, input.projectId]),
        client.query<IntentRow>(`${SELECT_INTENT}
          WHERE i.tenant_id = $1::uuid AND i.project_id = $2::uuid
            AND i.user_subject = $3 AND i.session_binding_digest = $4
            AND i.state = 'CONFIGURING' AND i.expires_at > $5::timestamptz
          ORDER BY i.created_at DESC, i.id DESC LIMIT 1`,
        [input.tenantId, input.projectId, input.userId, input.sessionBindingDigest, input.at]),
      ]);
      return Object.freeze({ activeConfiguration: configuration.rows[0] ? parseConfiguration(configuration.rows[0]) : null,
        pendingIntent: intent.rows[0] ? parseIntent(intent.rows[0]) : null });
    });
  }

  async createIntent(input: Parameters<SteamProjectConfigurationStore["createIntent"]>[0]): Promise<SteamProjectConfigurationIntent> {
    return this.#transaction(input.tenantId, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO deviludo.steam_project_configuration_intents
          (id, tenant_id, project_id, user_subject, session_binding_digest,
           steam_build_session_id, idempotency_key, request_digest, state, created_at, expires_at)
         SELECT $1::uuid, $2::uuid, $3::uuid, $4, $5, s.id, $6, $7, 'CONFIGURING',
                $8::timestamptz, $9::timestamptz
           FROM deviludo.projects p
           JOIN deviludo.users actor
             ON actor.tenant_id = p.tenant_id AND actor.id::text = $4
            AND actor.status = 'ACTIVE'
           JOIN deviludo.tenant_memberships membership
             ON membership.tenant_id = actor.tenant_id AND membership.user_id = actor.id
            AND membership.status = 'ACTIVE' AND membership.role = 'ProjectOwner'
           JOIN deviludo.steam_enrollments e
             ON e.tenant_id = p.tenant_id AND e.user_subject = $4 AND e.state = 'READY'
           JOIN deviludo.steam_build_sessions s
             ON s.tenant_id = e.tenant_id AND s.id = e.build_session_id
          WHERE p.tenant_id = $2::uuid AND p.id = $3::uuid
            AND s.state = 'ACTIVE' AND s.expires_at > $8::timestamptz
          ORDER BY e.completed_at DESC, e.id DESC
          LIMIT 1
         ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
           SET idempotency_key = EXCLUDED.idempotency_key
         WHERE deviludo.steam_project_configuration_intents.request_digest = EXCLUDED.request_digest
         RETURNING id`,
        [input.id, input.tenantId, input.projectId, input.userId, input.sessionBindingDigest,
          input.idempotencyKey, input.requestDigest, input.createdAt, input.expiresAt],
      );
      const id = inserted.rows[0]?.id;
      if (!id) {
        const conflict = await client.query<{ request_digest: string }>(
          `SELECT request_digest FROM deviludo.steam_project_configuration_intents
            WHERE tenant_id = $1::uuid AND idempotency_key = $2`, [input.tenantId, input.idempotencyKey]);
        if (conflict.rows[0] && conflict.rows[0].request_digest !== input.requestDigest) {
          throw new Error("Steam project configuration idempotency key conflicts with another request");
        }
        throw new Error("Steam project configuration requires an authorized active build session");
      }
      const found = await client.query<IntentRow>(`${SELECT_INTENT}
        WHERE i.tenant_id = $1::uuid AND i.id = $2::uuid`, [input.tenantId, id]);
      if (!found.rows[0]) throw new Error("Steam project configuration intent could not be read");
      return parseIntent(found.rows[0]);
    });
  }

  async findIntent(input: Parameters<SteamProjectConfigurationStore["findIntent"]>[0]): Promise<SteamProjectConfigurationIntent> {
    return this.#transaction(input.tenantId, async (client) => {
      const found = await client.query<IntentRow>(`${SELECT_INTENT}
        WHERE i.tenant_id = $1::uuid AND i.project_id = $2::uuid AND i.id = $3::uuid
          AND i.user_subject = $4 AND i.session_binding_digest = $5
          AND EXISTS (
            SELECT 1
              FROM deviludo.users actor
              JOIN deviludo.tenant_memberships membership
                ON membership.tenant_id = actor.tenant_id AND membership.user_id = actor.id
               AND membership.status = 'ACTIVE' AND membership.role = 'ProjectOwner'
             WHERE actor.tenant_id = i.tenant_id AND actor.id::text = i.user_subject
               AND actor.status = 'ACTIVE'
          )`,
      [input.tenantId, input.projectId, input.intentId, input.userId, input.sessionBindingDigest]);
      if (!found.rows[0]) throw new Error("Steam project configuration intent principal does not match");
      return parseIntent(found.rows[0]);
    });
  }

  async complete(input: Parameters<SteamProjectConfigurationStore["complete"]>[0]): Promise<SteamProjectReleaseConfiguration> {
    return this.#transaction(input.tenantId, async (client) => {
      await client.query(`SELECT id FROM deviludo.projects
        WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`, [input.tenantId, input.projectId]);
      const locked = await client.query<IntentRow>(`${SELECT_INTENT}
        JOIN deviludo.users actor
          ON actor.tenant_id = i.tenant_id AND actor.id::text = i.user_subject
         AND actor.status = 'ACTIVE'
        JOIN deviludo.tenant_memberships membership
          ON membership.tenant_id = actor.tenant_id AND membership.user_id = actor.id
         AND membership.status = 'ACTIVE' AND membership.role = 'ProjectOwner'
        WHERE i.tenant_id = $1::uuid AND i.project_id = $2::uuid AND i.id = $3::uuid
          AND i.user_subject = $4 AND i.session_binding_digest = $5
        FOR UPDATE OF i
        FOR SHARE OF actor, membership`,
      [input.tenantId, input.projectId, input.intentId, input.userId, input.sessionBindingDigest]);
      const intent = locked.rows[0];
      if (!intent) throw new Error("Steam project configuration intent principal does not match");
      if (intent.state === "COMPLETED" && intent.release_configuration_id) {
        return this.#configuration(client, input.tenantId, input.projectId, intent.release_configuration_id);
      }
      if (intent.state !== "CONFIGURING" || Date.parse(iso(intent.expires_at)) <= Date.parse(input.at)
        || intent.session_state !== "ACTIVE" || Date.parse(iso(intent.session_expires_at)) <= Date.parse(input.at)
        || !intent.allowed_app_ids.includes(input.steamAppId)
        || !intent.permissions.includes("EditAppMetadata") || !intent.permissions.includes("PublishAppChanges")) {
        throw new Error("Steam project configuration intent is no longer authorized");
      }
      await client.query(`UPDATE deviludo.steam_project_release_configurations
        SET state = 'SUPERSEDED', superseded_at = $3::timestamptz
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND state = 'ACTIVE'`,
      [input.tenantId, input.projectId, input.at]);
      await client.query(`UPDATE deviludo.steam_project_depot_configurations
        SET state = 'SUPERSEDED', superseded_at = $3::timestamptz
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND state = 'ACTIVE'`,
      [input.tenantId, input.projectId, input.at]);
      const revisions = await client.query<{ depot_revision: number; release_revision: number }>(
        `SELECT COALESCE((SELECT max(revision) FROM deviludo.steam_project_depot_configurations
                          WHERE tenant_id = $1::uuid AND project_id = $2::uuid), 0) + 1 AS depot_revision,
                COALESCE((SELECT max(revision) FROM deviludo.steam_project_release_configurations
                          WHERE tenant_id = $1::uuid AND project_id = $2::uuid), 0) + 1 AS release_revision`,
        [input.tenantId, input.projectId],
      );
      const revision = revisions.rows[0];
      if (!revision) throw new Error("Steam project configuration revision could not be allocated");
      await client.query(`INSERT INTO deviludo.steam_project_depot_configurations
        (id, tenant_id, project_id, steam_app_id, revision, platform_depots,
         configuration_digest, state, created_by, created_at)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, 'ACTIVE', $8, $9::timestamptz)`,
      [input.depotConfigurationId, input.tenantId, input.projectId, input.steamAppId,
        revision.depot_revision, JSON.stringify(input.platformDepots), input.depotConfigurationDigest, input.createdBy, input.at]);
      await client.query(`INSERT INTO deviludo.steam_project_release_configurations
        (id, tenant_id, project_id, revision, steam_app_id, steam_build_session_id,
         depot_configuration_id, beta_branch, branch_password_secret_ref,
         configuration_digest, state, created_by, created_at)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::uuid, $8, $9,
                $10, 'ACTIVE', $11, $12::timestamptz)`,
      [input.releaseConfigurationId, input.tenantId, input.projectId, revision.release_revision,
        input.steamAppId, intent.steam_build_session_id, input.depotConfigurationId,
        input.betaBranch, input.branchPasswordSecretRef, input.releaseConfigurationDigest, input.createdBy, input.at]);
      const completed = await client.query(`UPDATE deviludo.steam_project_configuration_intents
        SET state = 'COMPLETED', release_configuration_id = $4::uuid, completed_at = $5::timestamptz
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid AND state = 'CONFIGURING'`,
      [input.tenantId, input.projectId, input.intentId, input.releaseConfigurationId, input.at]);
      if (completed.rowCount !== 1) throw new Error("Steam project configuration completion was rejected");
      return this.#configuration(client, input.tenantId, input.projectId, input.releaseConfigurationId);
    });
  }

  async #configuration(client: SteamPostgresClient, tenantId: string, projectId: string, configurationId: string) {
    const found = await client.query<ConfigurationRow>(`${SELECT_CONFIGURATION}
      AND r.tenant_id = $1::uuid AND r.project_id = $2::uuid AND r.id = $3::uuid`,
    [tenantId, projectId, configurationId]);
    if (!found.rows[0]) throw new Error("Steam project release configuration could not be read");
    return parseConfiguration(found.rows[0]);
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
      try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
      throw error;
    } finally { client.release(); }
  }
}

function parseIntent(row: IntentRow): SteamProjectConfigurationIntent {
  const buildSession = parseSession(row);
  return Object.freeze({ id: row.id, tenantId: row.tenant_id, projectId: row.project_id, userId: row.user_subject,
    sessionBindingDigest: row.session_binding_digest, idempotencyKey: row.idempotency_key, requestDigest: row.request_digest,
    state: row.state, buildSession, releaseConfigurationId: row.release_configuration_id,
    createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), completedAt: row.completed_at ? iso(row.completed_at) : null });
}

function parseSession(row: IntentRow): SteamBuildSession {
  if (!Array.isArray(row.allowed_app_ids) || !Array.isArray(row.permissions)) throw new Error("Steam project build session is incomplete");
  return Object.freeze({ id: row.steam_build_session_id, tenantId: row.tenant_id, accountId: row.account_id,
    accountName: row.account_name, configVdfSecretRef: row.config_vdf_secret_ref,
    credentialVersionId: row.credential_version_id, allowedAppIds: Object.freeze([...row.allowed_app_ids]),
    permissions: Object.freeze([...row.permissions]), state: row.session_state,
    verifiedAt: iso(row.verified_at), expiresAt: iso(row.session_expires_at) });
}

function parseConfiguration(row: ConfigurationRow): SteamProjectReleaseConfiguration {
  return Object.freeze({ id: row.id, projectId: row.project_id, revision: integer(row.revision),
    steamAppId: row.steam_app_id, betaBranch: row.beta_branch, platformDepots: depots(row.platform_depots),
    buildSessionId: row.steam_build_session_id, buildSessionState: row.session_state,
    buildSessionExpiresAt: iso(row.session_expires_at), accountName: row.account_name, createdAt: iso(row.created_at) });
}

function depots(value: unknown): SteamPlatformDepots {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Steam project depots are invalid");
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["windows", "linux", "macos"].includes(key))
    || Object.values(record).some((item) => typeof item !== "string")) throw new Error("Steam project depots are invalid");
  return Object.freeze({ ...record }) as SteamPlatformDepots;
}
function integer(value: number): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Steam project revision is invalid"); return parsed; }
function iso(value: string | Date): string { const date = value instanceof Date ? value : new Date(value); if (!Number.isFinite(date.getTime())) throw new Error("Steam project timestamp is invalid"); return date.toISOString(); }
