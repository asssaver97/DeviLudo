import { randomUUID } from "node:crypto";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { sha256Canonical } from "./canonical";
import type { CandidatePublicationRequest } from "./candidate-publication-contracts";
import type { CandidatePublicationAuthority, CandidateReceiptArchive } from "./candidate-publication-service";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type AuthorityRow = { tenant_id: string; project_id: string; run_id: string; run_state: string; resolution_digest: string;
  configuration_lock: unknown; spec_revision_id: string; source_baseline_receipt_id: string; baseline_commit_sha: string;
  baseline_source_digest: string; predecessor_run_id: string | null; predecessor_commit_sha: string | null;
  predecessor_source_digest: string | null; predecessor_pull_request: string | number | bigint | null;
  repository_binding_id: string; installation_id: string | number | bigint; repository_id: string | number | bigint;
  repository_node_id: string; owner_name: string; repository_name: string; default_branch: string };
type ReceiptRow = { id: string; receipt: unknown };

export class PostgresCandidatePublicationStore implements CandidatePublicationAuthority, CandidateReceiptArchive {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async resolve(request: CandidatePublicationRequest) {
    return this.#transaction(request.tenantId, async (client) => {
      const selected = await client.query<AuthorityRow>(
        `SELECT run.tenant_id::text, run.project_id::text, run.id::text AS run_id,
                run.state AS run_state, run.resolution_digest, run.configuration_lock,
                run.spec_revision_id::text, run.source_baseline_receipt_id::text,
                baseline.commit_sha AS baseline_commit_sha,
                baseline.source_digest AS baseline_source_digest,
                predecessor.run_id::text AS predecessor_run_id,
                predecessor.candidate_commit_sha AS predecessor_commit_sha,
                predecessor.source_digest AS predecessor_source_digest,
                predecessor.pull_request_number AS predecessor_pull_request,
                repository.id::text AS repository_binding_id,
                installation.installation_id, repository.repository_id,
                repository.repository_node_id, repository.owner_name,
                repository.repository_name, repository.default_branch
           FROM deviludo.agent_runs run
           JOIN deviludo.github_source_baseline_receipts baseline
             ON baseline.tenant_id = run.tenant_id AND baseline.project_id = run.project_id
            AND baseline.id = run.source_baseline_receipt_id
           JOIN deviludo.github_repository_bindings repository
             ON repository.tenant_id = baseline.tenant_id AND repository.project_id = baseline.project_id
            AND repository.id = baseline.repository_binding_id AND repository.status = 'ACTIVE'
           JOIN deviludo.github_installations installation
            ON installation.tenant_id = repository.tenant_id
            AND installation.id = repository.github_installation_id AND installation.status = 'ACTIVE'
           LEFT JOIN deviludo.github_candidate_receipts predecessor
             ON predecessor.tenant_id = run.tenant_id
            AND predecessor.project_id = run.project_id
            AND predecessor.run_id::text = run.configuration_lock #>> '{repairContext,fromRunConfigurationId}'
            AND predecessor.candidate_commit_sha = run.configuration_lock->>'commitSha'
            AND predecessor.source_digest = run.configuration_lock->>'sourceDigest'
            AND predecessor.pull_request_number::text = run.configuration_lock #>> '{repairContext,draftPullRequest}'
          WHERE run.tenant_id = $1::uuid AND run.project_id = $2::uuid AND run.id = $3::uuid
          FOR SHARE OF run, baseline, repository, installation`,
        [request.tenantId, request.projectId, request.runId],
      );
      const row = selected.rows[0]; if (selected.rows.length !== 1 || !row) invalid();
      const lock = record(row.configuration_lock); const artifact = request.artifact.payload;
      const baseAuthorized = authorizedCandidateBase(lock, row);
      if (row.tenant_id !== request.tenantId || row.project_id !== request.projectId || row.run_id !== request.runId
        || row.run_state !== "RUNNING" || row.resolution_digest !== request.resolutionDigest
        || lock.resolutionDigest !== request.resolutionDigest || lock.specRevisionId !== row.spec_revision_id
        || lock.sourceBaselineReceiptId !== row.source_baseline_receipt_id || !baseAuthorized
        || artifact.specRevisionId !== row.spec_revision_id || artifact.expectedBaseCommitSha !== lock.commitSha) invalid();
      return Object.freeze({ repositoryBindingId: row.repository_binding_id, specRevisionId: row.spec_revision_id,
        binding: Object.freeze({ tenantId: row.tenant_id, projectId: row.project_id,
          installationId: bigint(row.installation_id), repositoryId: safeNumber(row.repository_id),
          repositoryNodeId: text(row.repository_node_id, 256), owner: text(row.owner_name, 100),
          name: text(row.repository_name, 100), defaultBranch: text(row.default_branch, 255) }) });
    });
  }

  async persist(input: Parameters<CandidateReceiptArchive["persist"]>[0]): Promise<Readonly<{ receiptId: string }>> {
    const receiptId = randomUUID(); const request = input.request; const receipt = input.receipt;
    if (!UUID.test(input.repositoryBindingId) || !UUID.test(input.specRevisionId)
      || receipt.scmProxy !== "github-app-proxy-v1" || receipt.state !== "DRAFT"
      || receipt.tenantId !== request.tenantId || receipt.projectId !== request.projectId
      || receipt.artifactId !== request.artifact.payload.artifactId
      || receipt.artifactDigest !== request.artifact.payload.artifactDigest
      || receipt.baseCommitSha !== request.artifact.payload.expectedBaseCommitSha
      || receipt.sourceDigest !== request.artifact.payload.sourceDigest
      || !SHA1.test(receipt.candidateCommitSha) || receipt.candidateCommitSha === receipt.baseCommitSha
      || !SHA256.test(receipt.artifactDigest) || !SHA256.test(receipt.sourceDigest)
      || !Number.isSafeInteger(receipt.pullRequestNumber) || receipt.pullRequestNumber < 1) invalid();
    return this.#transaction(request.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.github_candidate_receipts
          (id, tenant_id, project_id, run_id, attempt_id, spec_revision_id,
           repository_binding_id, artifact_digest, base_commit_sha,
           candidate_branch, candidate_commit_sha, source_digest,
           pull_request_number, pull_request_node_id, pull_request_url,
           receipt, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid,
                 $7::uuid, $8, $9, $10, $11, $12, $13, $14, $15,
                 $16::jsonb, $17::timestamptz)
         ON CONFLICT (tenant_id, attempt_id) DO NOTHING`,
        [receiptId, request.tenantId, request.projectId, request.runId, request.attemptId,
          input.specRevisionId, input.repositoryBindingId, receipt.artifactDigest,
          receipt.baseCommitSha, receipt.candidateBranch, receipt.candidateCommitSha,
          receipt.sourceDigest, receipt.pullRequestNumber, receipt.pullRequestNodeId,
          receipt.pullRequestUrl, JSON.stringify(receipt), receipt.createdAt],
      );
      const selected = await client.query<ReceiptRow>(
        `SELECT id::text, receipt FROM deviludo.github_candidate_receipts
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND run_id = $3::uuid
            AND attempt_id = $4 FOR SHARE`,
        [request.tenantId, request.projectId, request.runId, request.attemptId],
      );
      const row = selected.rows[0];
      if (selected.rows.length !== 1 || !row || !UUID.test(row.id)
        || sha256Canonical(row.receipt) !== sha256Canonical(receipt)) invalid();
      return Object.freeze({ receiptId: row.id });
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT to_regclass('deviludo.agent_runs')::text AS agent_runs,
                to_regclass('deviludo.github_source_baseline_receipts')::text AS github_source_baseline_receipts,
                to_regclass('deviludo.github_repository_bindings')::text AS github_repository_bindings,
                to_regclass('deviludo.github_installations')::text AS github_installations,
                to_regclass('deviludo.github_candidate_receipts')::text AS github_candidate_receipts`,
      );
      assertReadyTables(result.rows[0], [
        "agent_runs", "github_source_baseline_receipts", "github_repository_bindings",
        "github_installations", "github_candidate_receipts",
      ]);
    } finally { client.release(); }
  }
  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const value = await operation(client); await client.query("COMMIT"); return value;
    } catch (error) { try { await client.query("ROLLBACK"); } catch { /* preserve original */ } throw error; }
    finally { client.release(); }
  }
}

function assertReadyTables(row: Record<string, unknown> | undefined, tables: readonly string[]): void {
  if (!row || tables.some((table) => row[table] !== `deviludo.${table}`)) invalid();
}

function authorizedCandidateBase(lock: Readonly<Record<string, unknown>>, row: AuthorityRow): boolean {
  const repair = lock.repairContext === null || lock.repairContext === undefined
    ? null : record(lock.repairContext);
  if (repair === null || repair.reason === "AGENT_FAILURE") {
    return lock.commitSha === row.baseline_commit_sha && lock.sourceDigest === row.baseline_source_digest;
  }
  return repair.reason === "E2E_FAILURE"
    && repair.fromRunConfigurationId === row.predecessor_run_id
    && repair.candidateCommitSha === row.predecessor_commit_sha
    && repair.draftPullRequest === Number(row.predecessor_pull_request)
    && lock.commitSha === row.predecessor_commit_sha
    && lock.sourceDigest === row.predecessor_source_digest;
}

function bigint(value: string | number | bigint): string { const selected = String(value); if (!/^[1-9][0-9]{0,19}$/.test(selected)) invalid(); return selected; }
function safeNumber(value: string | number | bigint): number { const selected = Number(value); if (!Number.isSafeInteger(selected) || selected < 1) invalid(); return selected; }
function text(value: string, maximum: number): string { if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\0\r\n]/.test(value)) invalid(); return value; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function invalid(): never { throw new Error("PostgreSQL candidate publication authority is invalid"); }
