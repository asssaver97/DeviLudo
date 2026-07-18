import { randomUUID } from "node:crypto";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { sha256Canonical } from "./canonical";
import type { AcceptedCandidateEvidence, GitHubCandidateReceipt, GitHubRepositoryBinding } from "./github-contracts";
import type { AuthoritativeMergeContext, ScmMergeAuthority, ScmMergeCommand, ScmMergeReceiptArchive } from "./merge-service";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type AuthorityRow = {
  acceptance_operation_key: string; actor_id: string; accepted_at: string | Date;
  repository_binding_id: string; installation_id: string | number | bigint; repository_id: string | number | bigint;
  repository_node_id: string; owner_name: string; repository_name: string; default_branch: string;
  candidate_receipt_id: string; candidate_receipt: unknown; candidate_commit_sha: string; candidate_source_digest: string;
  pull_request_number: string | number | bigint; evidence_bundle_id: string; evidence_bundle_digest: string; spec_revision_id: string;
};
type MergeRow = { id: string; receipt: unknown; candidate_receipt_id: string; acceptance_signal_id: string; evidence_bundle_id: string };

export class PostgresScmMergeStore implements ScmMergeAuthority, ScmMergeReceiptArchive {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async resolve(request: ScmMergeCommand): Promise<AuthoritativeMergeContext> {
    const jobId = request.operationKey.slice("workflow-job:".length);
    return this.#transaction(request.tenantId, async (client) => {
      const selected = await client.query<AuthorityRow>(
        `SELECT acceptance.operation_key AS acceptance_operation_key,
                acceptance.actor_id, acceptance.accepted_at,
                repository.id::text AS repository_binding_id,
                installation.installation_id, repository.repository_id,
                repository.repository_node_id, repository.owner_name,
                repository.repository_name, repository.default_branch,
                candidate.id::text AS candidate_receipt_id,
                candidate.receipt AS candidate_receipt,
                candidate.candidate_commit_sha,
                candidate.source_digest AS candidate_source_digest,
                candidate.pull_request_number,
                evidence.id::text AS evidence_bundle_id,
                evidence.bundle_digest AS evidence_bundle_digest,
                spec.id::text AS spec_revision_id
           FROM deviludo.workflow_command_jobs job
           JOIN deviludo.user_candidate_acceptances acceptance
             ON acceptance.tenant_id = job.tenant_id
            AND acceptance.project_id = job.project_id
            AND acceptance.workflow_id = job.workflow_id
            AND acceptance.signal_id = $11
            AND acceptance.state = 'COMPLETED'
           JOIN deviludo.workflow_control_actions action
             ON action.tenant_id = acceptance.tenant_id
            AND action.project_id = acceptance.project_id
            AND action.workflow_id = acceptance.workflow_id
            AND action.id = acceptance.action_id
            AND action.operation = 'REQUEST_USER_ACCEPTANCE'
            AND action.status = 'COMPLETED'
           JOIN deviludo.workflow_signal_outbox signal
             ON signal.tenant_id = acceptance.tenant_id
            AND signal.project_id = acceptance.project_id
            AND signal.workflow_id = acceptance.workflow_id
            AND signal.action_id = acceptance.action_id
            AND signal.signal_id = acceptance.signal_id
            AND signal.state = 'DELIVERED'
            AND signal.signal->>'type' = 'USER_ACCEPTED'
           JOIN deviludo.github_candidate_receipts candidate
             ON candidate.tenant_id = acceptance.tenant_id
            AND candidate.project_id = acceptance.project_id
            AND candidate.id = acceptance.candidate_receipt_id
            AND candidate.run_id = $7::uuid
            AND candidate.spec_revision_id = acceptance.spec_revision_id
            AND candidate.candidate_commit_sha = acceptance.candidate_commit_sha
            AND candidate.pull_request_number = acceptance.draft_pull_request
           JOIN deviludo.github_repository_bindings repository
             ON repository.tenant_id = candidate.tenant_id
            AND repository.project_id = candidate.project_id
            AND repository.id = candidate.repository_binding_id
            AND repository.status = 'ACTIVE'
           JOIN deviludo.github_installations installation
             ON installation.tenant_id = repository.tenant_id
            AND installation.id = repository.github_installation_id
            AND installation.status = 'ACTIVE'
           JOIN deviludo.evidence_bundles evidence
             ON evidence.tenant_id = acceptance.tenant_id
            AND evidence.project_id = acceptance.project_id
            AND evidence.id = acceptance.evidence_bundle_id
            AND evidence.status = 'PASSED' AND evidence.invalidated_at IS NULL
            AND evidence.commit_sha = candidate.candidate_commit_sha
            AND evidence.source_digest = candidate.source_digest
           JOIN deviludo.e2e_attempts attempt
             ON attempt.tenant_id = evidence.tenant_id
            AND attempt.project_id = evidence.project_id
            AND attempt.id = evidence.attempt_id
            AND attempt.run_id = candidate.run_id
            AND attempt.workflow_id = acceptance.workflow_id
            AND attempt.mode = 'CANDIDATE' AND attempt.state = 'PASSED'
            AND attempt.commit_sha = candidate.candidate_commit_sha
            AND attempt.source_digest = candidate.source_digest
            AND attempt.draft_pull_request = candidate.pull_request_number
            AND attempt.binding->>'specRevisionId' = acceptance.spec_revision_id::text
           JOIN deviludo.immutable_revisions spec
             ON spec.tenant_id = acceptance.tenant_id
            AND spec.project_id = acceptance.project_id
            AND spec.id = acceptance.spec_revision_id
            AND spec.aggregate_type = 'GAME_SPEC' AND spec.state = 'APPROVED'
          WHERE job.id = $1::uuid AND job.tenant_id = $2::uuid
            AND job.project_id = $3::uuid AND job.workflow_id = $4
            AND job.destination = 'scm-proxy'
            AND job.operation = 'MERGE_DRAFT_PULL_REQUEST'
            AND job.request_digest = $5 AND job.state = 'RUNNING'
            AND candidate.candidate_commit_sha = $6
            AND candidate.run_id = $7::uuid
            AND candidate.spec_revision_id = $8::uuid
            AND candidate.pull_request_number = $9
            AND evidence.id = $10::uuid
            AND acceptance.signal_id = $11
          FOR SHARE OF job, acceptance, action, signal, candidate, repository,
                       installation, evidence, attempt, spec`,
        [jobId, request.tenantId, request.projectId, request.workflowId, request.requestDigest,
          request.candidateCommitSha, request.runId, request.specRevisionId,
          request.pullRequestNumber, request.evidenceBundleId, request.acceptanceSignalId],
      );
      const row = only(selected.rows);
      return authority(row, request);
    });
  }

  async verify(input: Readonly<{ binding: GitHubRepositoryBinding; candidate: GitHubCandidateReceipt; evidence: AcceptedCandidateEvidence }>): Promise<boolean> {
    try {
      return await this.#transaction(input.binding.tenantId, async (client) => {
        const selected = await client.query<{ count: string | number }>(
          `SELECT count(*) AS count
             FROM deviludo.github_candidate_receipts candidate
             JOIN deviludo.github_repository_bindings repository
               ON repository.tenant_id = candidate.tenant_id
              AND repository.project_id = candidate.project_id
              AND repository.id = candidate.repository_binding_id
              AND repository.status = 'ACTIVE'
             JOIN deviludo.evidence_bundles evidence
               ON evidence.tenant_id = candidate.tenant_id
              AND evidence.project_id = candidate.project_id
              AND evidence.id = $4::uuid
              AND evidence.status = 'PASSED' AND evidence.invalidated_at IS NULL
              AND evidence.commit_sha = candidate.candidate_commit_sha
              AND evidence.source_digest = candidate.source_digest
              AND evidence.bundle_digest = $5
            WHERE candidate.tenant_id = $1::uuid AND candidate.project_id = $2::uuid
              AND repository.repository_node_id = $3
              AND candidate.candidate_commit_sha = $6
              AND candidate.source_digest = $7
              AND candidate.spec_revision_id = $8::uuid`,
          [input.binding.tenantId, input.binding.projectId, input.binding.repositoryNodeId,
            input.evidence.evidenceBundleId, input.evidence.evidenceBundleDigest,
            input.candidate.candidateCommitSha, input.candidate.sourceDigest, input.evidence.specRevisionId],
        );
        return Number(selected.rows[0]?.count) === 1;
      });
    } catch { return false; }
  }

  async persist(input: Parameters<ScmMergeReceiptArchive["persist"]>[0]): Promise<Readonly<{ receiptId: string }>> {
    validateMerge(input);
    const id = randomUUID(); const { request, authority, receipt } = input;
    return this.#transaction(request.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.github_merge_receipts
          (id, tenant_id, project_id, candidate_receipt_id, acceptance_nonce,
           evidence_bundle_digest, candidate_commit_sha, merge_commit_sha,
           default_branch_head_sha, requires_fresh_main_snapshot, receipt,
           merged_at, main_source_digest, acceptance_operation_key,
           workflow_id, run_id, spec_revision_id, evidence_bundle_id,
           acceptance_signal_id, workflow_request_digest)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
                 $9, $10, $11::jsonb, $12::timestamptz, $13, $14, $15,
                 $16::uuid, $17::uuid, $18::uuid, $19, $20)
         ON CONFLICT (candidate_receipt_id) DO NOTHING`,
        [id, request.tenantId, request.projectId, authority.candidateReceiptId,
          authority.acceptanceOperationKey, receipt.evidenceBundleDigest,
          receipt.candidateCommitSha, receipt.mergeCommitSha, receipt.defaultBranchHeadSha,
          receipt.requiresFreshMainSnapshot, JSON.stringify(receipt), receipt.mergedAt,
          receipt.mainSourceDigest, authority.acceptanceOperationKey, request.workflowId,
          request.runId, request.specRevisionId, request.evidenceBundleId,
          request.acceptanceSignalId, request.requestDigest],
      );
      const selected = await client.query<MergeRow>(
        `SELECT id::text, receipt, candidate_receipt_id::text,
                acceptance_signal_id, evidence_bundle_id::text
           FROM deviludo.github_merge_receipts
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
            AND candidate_receipt_id = $3::uuid FOR SHARE`,
        [request.tenantId, request.projectId, authority.candidateReceiptId],
      );
      const row = only(selected.rows);
      if (!UUID.test(row.id) || row.candidate_receipt_id !== authority.candidateReceiptId
        || row.acceptance_signal_id !== request.acceptanceSignalId || row.evidence_bundle_id !== request.evidenceBundleId
        || sha256Canonical(row.receipt) !== sha256Canonical(receipt)) invalid();
      return Object.freeze({ receiptId: row.id });
    });
  }

  async probe(): Promise<void> { const client = await this.pool.connect(); try { await client.query("SELECT 1 AS scm_merge_store_probe"); } finally { client.release(); } }
  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client); await client.query("COMMIT"); return result; }
    catch (error) { try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ } throw error; }
    finally { client.release(); }
  }
}

function authority(row: AuthorityRow, request: ScmMergeCommand): AuthoritativeMergeContext {
  if (!/^[a-f0-9]{64}$/.test(row.acceptance_operation_key) || typeof row.actor_id !== "string" || row.actor_id.length < 1
    || !Number.isFinite(Date.parse(String(row.accepted_at))) || !UUID.test(row.repository_binding_id)
    || !UUID.test(row.candidate_receipt_id) || row.candidate_commit_sha !== request.candidateCommitSha
    || row.candidate_source_digest.length !== 64 || Number(row.pull_request_number) !== request.pullRequestNumber
    || row.evidence_bundle_id !== request.evidenceBundleId || !SHA256.test(row.evidence_bundle_digest)
    || row.spec_revision_id !== request.specRevisionId) invalid();
  const binding = bindingFrom(row, request); const candidate = candidateFrom(row.candidate_receipt, binding, row, request);
  const evidence: AcceptedCandidateEvidence = Object.freeze({ evidenceBundleId: row.evidence_bundle_id,
    evidenceBundleDigest: row.evidence_bundle_digest, candidateCommitSha: candidate.candidateCommitSha,
    sourceDigest: candidate.sourceDigest, specRevisionId: row.spec_revision_id, status: "PASSED", valid: true });
  return Object.freeze({ acceptanceOperationKey: row.acceptance_operation_key, acceptedBy: row.actor_id,
    acceptedAt: new Date(row.accepted_at).toISOString(), repositoryBindingId: row.repository_binding_id,
    binding, candidateReceiptId: row.candidate_receipt_id, candidate, evidence });
}
function bindingFrom(row: AuthorityRow, request: ScmMergeCommand): GitHubRepositoryBinding { return Object.freeze({
  tenantId: request.tenantId, projectId: request.projectId, installationId: positiveIntegerString(row.installation_id),
  repositoryId: positiveSafeInteger(row.repository_id), repositoryNodeId: text(row.repository_node_id, 256),
  owner: text(row.owner_name, 100), name: text(row.repository_name, 100), defaultBranch: text(row.default_branch, 255),
}); }
function candidateFrom(value: unknown, binding: GitHubRepositoryBinding, row: AuthorityRow, request: ScmMergeCommand): GitHubCandidateReceipt {
  const body = record(value);
  if (body.scmProxy !== "github-app-proxy-v1" || body.tenantId !== request.tenantId || body.projectId !== request.projectId
    || body.installationId !== binding.installationId || body.repositoryId !== binding.repositoryId
    || body.repositoryNodeId !== binding.repositoryNodeId || body.candidateCommitSha !== request.candidateCommitSha
    || body.sourceDigest !== row.candidate_source_digest || body.pullRequestNumber !== request.pullRequestNumber
    || body.state !== "DRAFT" || !Array.isArray(body.changedFiles)) invalid();
  return Object.freeze(body as unknown as GitHubCandidateReceipt);
}
function validateMerge(input: Parameters<ScmMergeReceiptArchive["persist"]>[0]): void { const { request, authority, receipt } = input;
  if (receipt.scmProxy !== "github-app-proxy-v1" || receipt.tenantId !== request.tenantId || receipt.projectId !== request.projectId
    || receipt.repositoryNodeId !== authority.binding.repositoryNodeId || receipt.pullRequestNumber !== request.pullRequestNumber
    || receipt.candidateCommitSha !== request.candidateCommitSha || !SHA1.test(receipt.mergeCommitSha)
    || !SHA1.test(receipt.defaultBranchHeadSha) || !SHA256.test(receipt.mainSourceDigest)
    || receipt.requiresFreshMainSnapshot !== (receipt.defaultBranchHeadSha !== receipt.mergeCommitSha)
    || receipt.acceptanceNonce !== authority.acceptanceOperationKey
    || receipt.evidenceBundleDigest !== authority.evidence.evidenceBundleDigest) invalid(); }
function positiveIntegerString(value: string | number | bigint): string { const result = String(value); if (!/^[1-9][0-9]{0,19}$/.test(result)) invalid(); return result; }
function positiveSafeInteger(value: string | number | bigint): number { const result = Number(value); if (!Number.isSafeInteger(result) || result < 1) invalid(); return result; }
function text(value: string, max: number): string { if (typeof value !== "string" || value.length < 1 || value.length > max || /[\0\r\n]/.test(value)) invalid(); return value; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function only<T>(rows: readonly T[]): T { if (rows.length !== 1 || !rows[0]) invalid(); return rows[0]; }
function invalid(): never { throw new Error("PostgreSQL SCM merge authority is invalid"); }
