import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { GitHubRepositoryBinding } from "./github-contracts";
import type { SourceSnapshotAuthority } from "./source-snapshot-service";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type AuthorityRow = {
  tenant_id: string;
  project_id: string;
  installation_id: string | number | bigint;
  repository_id: string | number | bigint;
  repository_node_id: string;
  owner_name: string;
  repository_name: string;
  default_branch: string;
  source_digest: string;
};

/** Resolves an SCM snapshot only from append-only GitHub receipts under tenant RLS. */
export class PostgresSourceSnapshotAuthority implements SourceSnapshotAuthority {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async resolve(input: Parameters<SourceSnapshotAuthority["resolve"]>[0]): Promise<Readonly<{
    binding: GitHubRepositoryBinding;
    sourceDigest: string;
  }>> {
    validateInput(input);
    return this.#transaction(input.tenantId, async (client) => {
      const selected = input.mode === "AGENT_BASELINE" ? await baselineReceipt(client, input)
        : input.mode === "CANDIDATE" ? await candidateReceipt(client, input) : await mainReceipt(client, input);
      if (selected.rows.length !== 1) invalid();
      const row = selected.rows[0]!;
      if (row.tenant_id !== input.tenantId || row.project_id !== input.projectId
        || row.source_digest !== input.sourceDigest) invalid();
      const installationId = positiveBigintString(row.installation_id);
      const repositoryId = safePositiveNumber(row.repository_id);
      const binding = Object.freeze({
        tenantId: row.tenant_id,
        projectId: row.project_id,
        installationId,
        repositoryId,
        repositoryNodeId: safeText(row.repository_node_id, 256),
        owner: safeText(row.owner_name, 100),
        name: safeText(row.repository_name, 100),
        defaultBranch: safeText(row.default_branch, 255),
      });
      return Object.freeze({ binding, sourceDigest: row.source_digest });
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT to_regclass('deviludo.github_candidate_receipts')::text AS github_candidate_receipts,
                to_regclass('deviludo.github_repository_bindings')::text AS github_repository_bindings,
                to_regclass('deviludo.github_installations')::text AS github_installations,
                to_regclass('deviludo.agent_runs')::text AS agent_runs,
                to_regclass('deviludo.github_source_baseline_receipts')::text AS github_source_baseline_receipts,
                to_regclass('deviludo.github_merge_receipts')::text AS github_merge_receipts`,
      );
      assertReadyTables(result.rows[0], [
        "github_candidate_receipts", "github_repository_bindings", "github_installations",
        "agent_runs", "github_source_baseline_receipts", "github_merge_receipts",
      ]);
    } finally { client.release(); }
  }

  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the authority error */ }
      throw error;
    } finally { client.release(); }
  }
}

function assertReadyTables(row: Record<string, unknown> | undefined, tables: readonly string[]): void {
  if (!row || tables.some((table) => row[table] !== `deviludo.${table}`)) invalid();
}

function candidateReceipt(
  client: PostgresWorkflowClient,
  input: Parameters<SourceSnapshotAuthority["resolve"]>[0],
) {
  return client.query<AuthorityRow>(
    `SELECT repository.tenant_id::text,
            repository.project_id::text,
            installation.installation_id,
            repository.repository_id,
            repository.repository_node_id,
            repository.owner_name,
            repository.repository_name,
            repository.default_branch,
            candidate.source_digest
       FROM deviludo.github_candidate_receipts candidate
       JOIN deviludo.github_repository_bindings repository
         ON repository.id = candidate.repository_binding_id
        AND repository.tenant_id = candidate.tenant_id
        AND repository.project_id = candidate.project_id
        AND repository.status = 'ACTIVE'
       JOIN deviludo.github_installations installation
         ON installation.id = repository.github_installation_id
        AND installation.tenant_id = repository.tenant_id
        AND installation.status = 'ACTIVE'
      WHERE candidate.tenant_id = $1::uuid
        AND candidate.project_id = $2::uuid
        AND candidate.run_id = $3::uuid
        AND candidate.candidate_commit_sha = $4
        AND candidate.source_digest = $5
      FOR SHARE OF candidate, repository, installation`,
    [input.tenantId, input.projectId, input.runId, input.commitSha, input.sourceDigest],
  );
}

function baselineReceipt(
  client: PostgresWorkflowClient,
  input: Parameters<SourceSnapshotAuthority["resolve"]>[0],
) {
  return client.query<AuthorityRow>(
    `SELECT repository.tenant_id::text,
            repository.project_id::text,
            installation.installation_id,
            repository.repository_id,
            repository.repository_node_id,
            repository.owner_name,
            repository.repository_name,
            repository.default_branch,
            CASE
              WHEN run.configuration_lock #>> '{repairContext,reason}' = 'E2E_FAILURE'
                THEN predecessor.source_digest
              ELSE baseline.source_digest
            END AS source_digest
       FROM deviludo.agent_runs run
       JOIN deviludo.github_source_baseline_receipts baseline
         ON baseline.tenant_id = run.tenant_id AND baseline.project_id = run.project_id
        AND baseline.id = run.source_baseline_receipt_id
       JOIN deviludo.github_repository_bindings repository
         ON repository.id = baseline.repository_binding_id
        AND repository.tenant_id = baseline.tenant_id
        AND repository.project_id = baseline.project_id
        AND repository.status = 'ACTIVE'
       JOIN deviludo.github_installations installation
         ON installation.id = repository.github_installation_id
        AND installation.tenant_id = repository.tenant_id
        AND installation.status = 'ACTIVE'
       LEFT JOIN deviludo.github_candidate_receipts predecessor
         ON predecessor.tenant_id = run.tenant_id
        AND predecessor.project_id = run.project_id
        AND predecessor.run_id::text = run.configuration_lock #>> '{repairContext,fromRunConfigurationId}'
        AND predecessor.candidate_commit_sha = run.configuration_lock->>'commitSha'
        AND predecessor.source_digest = run.configuration_lock->>'sourceDigest'
        AND predecessor.pull_request_number::text = run.configuration_lock #>> '{repairContext,draftPullRequest}'
      WHERE run.tenant_id = $1::uuid AND run.project_id = $2::uuid AND run.id = $3::uuid
        AND (
          (run.configuration_lock #>> '{repairContext,reason}' IS DISTINCT FROM 'E2E_FAILURE'
            AND baseline.commit_sha = $4 AND baseline.source_digest = $5)
          OR
          (run.configuration_lock #>> '{repairContext,reason}' = 'E2E_FAILURE'
            AND predecessor.candidate_commit_sha = $4 AND predecessor.source_digest = $5)
        )
      FOR SHARE OF run, baseline, repository, installation`,
    [input.tenantId, input.projectId, input.runId, input.commitSha, input.sourceDigest],
  );
}

function mainReceipt(
  client: PostgresWorkflowClient,
  input: Parameters<SourceSnapshotAuthority["resolve"]>[0],
) {
  return client.query<AuthorityRow>(
    `SELECT repository.tenant_id::text,
            repository.project_id::text,
            installation.installation_id,
            repository.repository_id,
            repository.repository_node_id,
            repository.owner_name,
            repository.repository_name,
            repository.default_branch,
            merge.main_source_digest AS source_digest
       FROM deviludo.github_merge_receipts merge
       JOIN deviludo.github_candidate_receipts candidate
         ON candidate.id = merge.candidate_receipt_id
        AND candidate.tenant_id = merge.tenant_id
        AND candidate.project_id = merge.project_id
       JOIN deviludo.github_repository_bindings repository
         ON repository.id = candidate.repository_binding_id
        AND repository.tenant_id = merge.tenant_id
        AND repository.project_id = merge.project_id
        AND repository.status = 'ACTIVE'
       JOIN deviludo.github_installations installation
         ON installation.id = repository.github_installation_id
        AND installation.tenant_id = repository.tenant_id
        AND installation.status = 'ACTIVE'
      WHERE merge.tenant_id = $1::uuid
        AND merge.project_id = $2::uuid
        AND candidate.run_id = $3::uuid
        AND merge.default_branch_head_sha = $4
        AND merge.main_source_digest = $5
      FOR SHARE OF merge, candidate, repository, installation`,
    [input.tenantId, input.projectId, input.runId, input.commitSha, input.sourceDigest],
  );
}

function validateInput(input: Parameters<SourceSnapshotAuthority["resolve"]>[0]): void {
  if (!UUID.test(input.tenantId) || !UUID.test(input.projectId) || !UUID.test(input.runId)
    || (input.mode !== "AGENT_BASELINE" && input.mode !== "CANDIDATE" && input.mode !== "MAIN_RELEASE_GATE")
    || !SHA1.test(input.commitSha) || !SHA256.test(input.sourceDigest)) invalid();
}

function positiveBigintString(value: string | number | bigint): string {
  const selected = String(value);
  if (!/^[1-9][0-9]{0,19}$/.test(selected)) invalid();
  return selected;
}

function safePositiveNumber(value: string | number | bigint): number {
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected < 1) invalid();
  return selected;
}

function safeText(value: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\0\r\n]/.test(value)) invalid();
  return value;
}

function invalid(): never {
  throw new Error("SCM source snapshot authority receipt is invalid");
}
