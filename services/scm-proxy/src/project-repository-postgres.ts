import type { ScmPostgresClient, ScmPostgresPool } from "./github-auth-postgres";
import type {
  AuthorizedGitHubInstallation,
  BoundProjectReceipt,
  CreateBoundProjectCommand,
  GitHubRepositoryCatalogItem,
  ProjectRepositoryOnboardingStore,
  ProjectRepositoryPrincipal,
} from "./project-repository-contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

type OperationRow = Record<string, unknown> & {
  actor_id: string;
  github_user_id: string | number | bigint;
  request_digest: string;
  status: "CLAIMED" | "COMPLETED";
  claim_token: string | null;
  claim_active: boolean;
  response: unknown | null;
};

export class PostgresProjectRepositoryOnboardingStore implements ProjectRepositoryOnboardingStore {
  constructor(private readonly pool: ScmPostgresPool) {}

  async authorizedInstallations(principal: ProjectRepositoryPrincipal): Promise<readonly AuthorizedGitHubInstallation[]> {
    return this.#transaction(principal.tenantId, async (client) => {
      const result = await client.query<Record<string, unknown> & {
        id: string; installation_id: string | number | bigint; account_login: string;
      }>(
        `SELECT id::text, installation_id, account_login
           FROM deviludo.github_installations
          WHERE tenant_id = $1::uuid AND status = 'ACTIVE'
            AND verified_by_github_user_id = $2::bigint
          ORDER BY installation_id`,
        [principal.tenantId, principal.githubUserId],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({
        installationRecordId: uuid(row.id),
        installationId: positiveId(row.installation_id),
        accountLogin: text(row.account_login, 100),
      })));
    });
  }

  async claim(command: CreateBoundProjectCommand, requestDigest: string, claimToken: string): Promise<
    | { readonly kind: "ACQUIRED" }
    | { readonly kind: "BUSY" }
    | { readonly kind: "REPLAY"; readonly receipt: BoundProjectReceipt }
    | { readonly kind: "CONFLICT" }
  > {
    return this.#transaction(command.principal.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.project_creation_operations
          (tenant_id, idempotency_key, actor_id, github_user_id,
           request_digest, status, claim_token, claim_expires_at)
         VALUES ($1::uuid, $2, $3, $4::bigint, $5, 'CLAIMED', $6::uuid,
                 now() + interval '2 minutes')
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
        [command.principal.tenantId, command.idempotencyKey, command.principal.userId,
          command.principal.githubUserId, requestDigest, claimToken],
      );
      const selected = await client.query<OperationRow>(operationSelect, [command.principal.tenantId, command.idempotencyKey]);
      const row = selected.rows[0];
      if (!row || row.request_digest !== requestDigest || row.actor_id !== command.principal.userId
        || positiveId(row.github_user_id) !== String(command.principal.githubUserId)) return Object.freeze({ kind: "CONFLICT" as const });
      if (row.status === "COMPLETED") {
        return Object.freeze({ kind: "REPLAY" as const, receipt: parseReceipt(row.response, command) });
      }
      if (row.claim_token === claimToken) return Object.freeze({ kind: "ACQUIRED" as const });
      if (row.status !== "CLAIMED" || row.claim_active) return Object.freeze({ kind: "BUSY" as const });
      const reclaimed = await client.query(
        `UPDATE deviludo.project_creation_operations
            SET claim_token = $3::uuid, claim_expires_at = now() + interval '2 minutes'
          WHERE tenant_id = $1::uuid AND idempotency_key = $2
            AND status = 'CLAIMED' AND claim_expires_at <= now()`,
        [command.principal.tenantId, command.idempotencyKey, claimToken],
      );
      return Object.freeze({ kind: reclaimed.rowCount === 1 ? "ACQUIRED" as const : "BUSY" as const });
    });
  }

  async complete(input: {
    readonly command: CreateBoundProjectCommand;
    readonly requestDigest: string;
    readonly claimToken: string;
    readonly projectId: string;
    readonly repositoryBindingId: string;
    readonly repository: GitHubRepositoryCatalogItem;
    readonly createdAt: string;
  }): Promise<BoundProjectReceipt> {
    const tenantId = input.command.principal.tenantId;
    return this.#transaction(tenantId, async (client) => {
      const selected = await client.query<OperationRow>(operationSelect, [tenantId, input.command.idempotencyKey]);
      const operation = selected.rows[0];
      if (!operation || operation.status !== "CLAIMED" || operation.claim_token !== input.claimToken
        || !operation.claim_active || operation.request_digest !== input.requestDigest
        || operation.actor_id !== input.command.principal.userId
        || positiveId(operation.github_user_id) !== String(input.command.principal.githubUserId)) invalid();
      const installation = await client.query<Record<string, unknown> & { id: string; installation_id: string | number | bigint }>(
        `SELECT id::text, installation_id
           FROM deviludo.github_installations
          WHERE tenant_id = $1::uuid AND installation_id = $2::bigint
            AND status = 'ACTIVE' AND verified_by_github_user_id = $3::bigint
          FOR SHARE`,
        [tenantId, input.command.installationId, input.command.principal.githubUserId],
      );
      const installationRow = installation.rows[0];
      if (!installationRow || positiveId(installationRow.installation_id) !== input.command.installationId) invalid();
      const installationRecordId = uuid(installationRow.id);
      const insertedProject = await client.query(
        `INSERT INTO deviludo.projects
          (id, tenant_id, slug, name, github_installation_id,
           github_repository_node_id, default_branch, created_by, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
        [input.projectId, tenantId, input.command.slug, input.command.name,
          input.command.installationId, input.repository.repositoryNodeId,
          input.repository.defaultBranch, input.command.principal.userId, input.createdAt],
      );
      if (insertedProject.rowCount !== 1) invalid();
      const insertedBinding = await client.query(
        `INSERT INTO deviludo.github_repository_bindings
          (id, tenant_id, project_id, github_installation_id, repository_id,
           repository_node_id, owner_name, repository_name, default_branch,
           status, bound_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::bigint,
                 $6, $7, $8, $9, 'ACTIVE', $10::timestamptz)`,
        [input.repositoryBindingId, tenantId, input.projectId, installationRecordId,
          input.repository.repositoryId, input.repository.repositoryNodeId,
          input.repository.owner, input.repository.name, input.repository.defaultBranch, input.createdAt],
      );
      if (insertedBinding.rowCount !== 1) invalid();
      const receipt: BoundProjectReceipt = Object.freeze({
        projectId: input.projectId,
        tenantId,
        slug: input.command.slug,
        name: input.command.name,
        repositoryBindingId: input.repositoryBindingId,
        installationId: input.command.installationId,
        repositoryId: input.repository.repositoryId,
        repositoryNodeId: input.repository.repositoryNodeId,
        owner: input.repository.owner,
        repositoryName: input.repository.name,
        defaultBranch: input.repository.defaultBranch,
        createdAt: iso(input.createdAt),
      });
      const completed = await client.query(
        `UPDATE deviludo.project_creation_operations
            SET status = 'COMPLETED', claim_token = NULL, claim_expires_at = NULL,
                response = $4::jsonb, completed_at = $5::timestamptz
          WHERE tenant_id = $1::uuid AND idempotency_key = $2
            AND status = 'CLAIMED' AND claim_token = $3::uuid
            AND claim_expires_at > now()`,
        [tenantId, input.command.idempotencyKey, input.claimToken, JSON.stringify(receipt), input.createdAt],
      );
      if (completed.rowCount !== 1) invalid();
      return receipt;
    });
  }

  async release(tenantId: string, idempotencyKey: string, claimToken: string): Promise<void> {
    await this.#transaction(tenantId, async (client) => {
      await client.query(
        `DELETE FROM deviludo.project_creation_operations
          WHERE tenant_id = $1::uuid AND idempotency_key = $2
            AND status = 'CLAIMED' AND claim_token = $3::uuid`,
        [tenantId, idempotencyKey, claimToken],
      );
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ table_name: string | null }>(
        "SELECT to_regclass('deviludo.project_creation_operations')::text AS table_name",
      );
      if (result.rows[0]?.table_name !== "deviludo.project_creation_operations") invalid();
    } finally { client.release(); }
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
      try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
      throw error;
    } finally { client.release(); }
  }
}

const operationSelect = `SELECT actor_id, github_user_id, request_digest, status,
       claim_token::text, COALESCE(claim_expires_at > now(), false) AS claim_active,
       response
  FROM deviludo.project_creation_operations
 WHERE tenant_id = $1::uuid AND idempotency_key = $2
 FOR UPDATE`;

function parseReceipt(value: unknown, command: CreateBoundProjectCommand): BoundProjectReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  const expected = ["createdAt", "defaultBranch", "installationId", "name", "owner", "projectId", "repositoryBindingId", "repositoryId", "repositoryName", "repositoryNodeId", "slug", "tenantId"];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expected.sort())
    || body.tenantId !== command.principal.tenantId || body.slug !== command.slug || body.name !== command.name
    || body.installationId !== command.installationId || body.repositoryId !== command.repositoryId
    || typeof body.projectId !== "string" || !UUID.test(body.projectId)
    || typeof body.repositoryBindingId !== "string" || !UUID.test(body.repositoryBindingId)
    || typeof body.repositoryNodeId !== "string" || typeof body.owner !== "string"
    || typeof body.repositoryName !== "string" || typeof body.defaultBranch !== "string"
    || typeof body.createdAt !== "string") invalid();
  iso(body.createdAt);
  return Object.freeze({ ...(body as unknown as BoundProjectReceipt) });
}

function positiveId(value: unknown): string { const result = String(value); if (!/^\d{1,20}$/.test(result) || result === "0") invalid(); return result; }
function text(value: unknown, maximum: number): string { if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid(); return value; }
function uuid(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) invalid(); return value; }
function iso(value: string): string { const date = new Date(value); if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid(); return value; }
function invalid(): never { throw new Error("Project repository PostgreSQL binding is invalid"); }
