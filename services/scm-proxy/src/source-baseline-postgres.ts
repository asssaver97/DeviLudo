import { randomUUID } from "node:crypto";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { GitHubRepositoryBinding } from "./github-contracts";
import {
  parseSourceBaselineReceipt,
  sourceBaselineRequestDigest,
  type SourceBaselineReceipt,
  type SourceBaselineRequest,
} from "./source-baseline-contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type AuthorityRow = {
  repository_binding_id: string;
  tenant_id: string;
  project_id: string;
  installation_id: string | number | bigint;
  repository_id: string | number | bigint;
  repository_node_id: string;
  owner_name: string;
  repository_name: string;
  default_branch: string;
  spec_revision_id: string;
  test_plan_revision_id: string;
  spec_approval_receipt_id: string;
};
type OperationRow = {
  request_digest: string;
  claim_token: string | null;
  claim_active: boolean;
  state: "PENDING" | "CLAIMED" | "COMPLETED";
  response: unknown | null;
};
type ReceiptRow = {
  id: string;
  operation_key: string;
  tenant_id: string;
  project_id: string;
  repository_binding_id: string;
  workflow_id: string;
  spec_revision_id: string;
  test_plan_revision_id: string;
  spec_approval_receipt_id: string;
  default_branch: string;
  commit_sha: string;
  source_digest: string;
  observed_at: string | Date;
};

export interface SourceBaselineClaim {
  readonly request: SourceBaselineRequest;
  readonly claimToken: string;
  readonly repositoryBindingId: string;
  readonly binding: GitHubRepositoryBinding;
}
export type SourceBaselineAcquireResult =
  | { readonly kind: "ACQUIRED"; readonly claim: SourceBaselineClaim }
  | { readonly kind: "BUSY" }
  | { readonly kind: "REPLAY"; readonly receipt: SourceBaselineReceipt };

/** PostgreSQL/RLS claim and append-only authority for one default-branch baseline. */
export class PostgresSourceBaselineStore {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async acquire(request: SourceBaselineRequest): Promise<SourceBaselineAcquireResult> {
    const requestDigest = sourceBaselineRequestDigest(request);
    const claimToken = randomUUID();
    return this.#transaction(request.tenantId, async (client) => {
      const authority = await sourceAuthority(client, request);
      await client.query(
        `INSERT INTO deviludo.github_source_baseline_operations
          (tenant_id, project_id, operation_key, request_digest, workflow_id,
           spec_revision_id, test_plan_revision_id, spec_approval_receipt_id,
           state, claim_token, claim_expires_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8,
                 'CLAIMED', $9::uuid, now() + interval '2 minutes')
         ON CONFLICT (tenant_id, operation_key) DO NOTHING`,
        [request.tenantId, request.projectId, request.operationKey, requestDigest,
          request.workflowId, request.specRevisionId, request.testPlanRevisionId,
          request.specApprovalReceiptId, claimToken],
      );
      const selected = await client.query<OperationRow>(
        `SELECT request_digest, claim_token::text,
                COALESCE(claim_expires_at > now(), false) AS claim_active,
                state, response
           FROM deviludo.github_source_baseline_operations
          WHERE tenant_id = $1::uuid AND operation_key = $2
          FOR UPDATE`,
        [request.tenantId, request.operationKey],
      );
      const row = selected.rows[0];
      if (selected.rows.length !== 1 || !row || row.request_digest !== requestDigest) conflict();
      if (row.state === "COMPLETED") {
        const receipt = parseSourceBaselineReceipt(row.response);
        assertReceiptRequest(receipt, request);
        return { kind: "REPLAY", receipt: Object.freeze({ ...receipt, replayed: true }) };
      }
      if (row.claim_token === claimToken) return acquired(request, claimToken, authority);
      if (row.state === "CLAIMED" && row.claim_active) return { kind: "BUSY" };
      const reclaimed = await client.query(
        `UPDATE deviludo.github_source_baseline_operations
            SET state = 'CLAIMED', claim_token = $3::uuid,
                claim_expires_at = now() + interval '2 minutes'
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND state <> 'COMPLETED'
            AND (state = 'PENDING' OR claim_expires_at <= now())
        RETURNING operation_key`,
        [request.tenantId, request.operationKey, claimToken],
      );
      return reclaimed.rowCount === 1 ? acquired(request, claimToken, authority) : { kind: "BUSY" };
    });
  }

  async complete(
    claim: SourceBaselineClaim,
    observed: Readonly<{ defaultBranch: string; commitSha: string; sourceDigest: string; observedAt: string }>,
  ): Promise<SourceBaselineReceipt> {
    validateObserved(observed);
    return this.#transaction(claim.request.tenantId, async (client) => {
      const authority = await sourceAuthority(client, claim.request);
      if (authority.repositoryBindingId !== claim.repositoryBindingId
        || JSON.stringify(authority.binding) !== JSON.stringify(claim.binding)
        || observed.defaultBranch !== authority.binding.defaultBranch) conflict();
      const operation = await client.query<OperationRow>(
        `SELECT request_digest, claim_token::text,
                COALESCE(claim_expires_at > now(), false) AS claim_active,
                state, response
           FROM deviludo.github_source_baseline_operations
          WHERE tenant_id = $1::uuid AND operation_key = $2
          FOR UPDATE`,
        [claim.request.tenantId, claim.request.operationKey],
      );
      const operationRow = operation.rows[0];
      if (operation.rows.length !== 1 || !operationRow
        || operationRow.request_digest !== sourceBaselineRequestDigest(claim.request)
        || operationRow.state !== "CLAIMED" || operationRow.claim_token !== claim.claimToken
        || !operationRow.claim_active) conflict();
      await client.query(
        `INSERT INTO deviludo.github_source_baseline_receipts
          (tenant_id, project_id, operation_key, repository_binding_id,
           workflow_id, spec_revision_id, test_plan_revision_id,
           spec_approval_receipt_id, default_branch, commit_sha, source_digest,
           request_digest, observed_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::uuid, $7::uuid,
                 $8, $9, $10, $11, $12, $13::timestamptz)
         ON CONFLICT (tenant_id, project_id, spec_revision_id) DO NOTHING`,
        [claim.request.tenantId, claim.request.projectId, claim.request.operationKey,
          claim.repositoryBindingId, claim.request.workflowId, claim.request.specRevisionId,
          claim.request.testPlanRevisionId, claim.request.specApprovalReceiptId,
          observed.defaultBranch, observed.commitSha, observed.sourceDigest,
          sourceBaselineRequestDigest(claim.request), observed.observedAt],
      );
      const stored = await client.query<ReceiptRow>(
        `SELECT id::text, operation_key, tenant_id::text, project_id::text,
                repository_binding_id::text, workflow_id, spec_revision_id::text,
                test_plan_revision_id::text, spec_approval_receipt_id,
                default_branch, commit_sha, source_digest, observed_at
           FROM deviludo.github_source_baseline_receipts
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
            AND spec_revision_id = $3::uuid
          FOR SHARE`,
        [claim.request.tenantId, claim.request.projectId, claim.request.specRevisionId],
      );
      const receipt = receiptFromRow(stored.rows[0], claim.request);
      if (receipt.repositoryBindingId !== claim.repositoryBindingId
        || receipt.defaultBranch !== observed.defaultBranch || receipt.commitSha !== observed.commitSha
        || receipt.sourceDigest !== observed.sourceDigest || receipt.observedAt !== observed.observedAt) conflict();
      const completed = await client.query(
        `UPDATE deviludo.github_source_baseline_operations
            SET state = 'COMPLETED', claim_token = NULL, claim_expires_at = NULL,
                response = $4::jsonb, completed_at = now()
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND state = 'CLAIMED' AND claim_token = $3::uuid
        RETURNING operation_key`,
        [claim.request.tenantId, claim.request.operationKey, claim.claimToken, JSON.stringify(receipt)],
      );
      if (completed.rowCount !== 1) conflict();
      return receipt;
    });
  }

  async release(claim: SourceBaselineClaim): Promise<void> {
    await this.#transaction(claim.request.tenantId, async (client) => {
      await client.query(
        `UPDATE deviludo.github_source_baseline_operations
            SET state = 'PENDING', claim_token = NULL, claim_expires_at = NULL
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND state = 'CLAIMED' AND claim_token = $3::uuid`,
        [claim.request.tenantId, claim.request.operationKey, claim.claimToken],
      );
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT to_regclass('deviludo.github_source_baseline_operations')::text AS github_source_baseline_operations,
                to_regclass('deviludo.github_source_baseline_receipts')::text AS github_source_baseline_receipts,
                to_regclass('deviludo.github_repository_bindings')::text AS github_repository_bindings,
                to_regclass('deviludo.github_installations')::text AS github_installations,
                to_regclass('deviludo.immutable_revisions')::text AS immutable_revisions,
                to_regclass('deviludo.approved_test_plan_bindings')::text AS approved_test_plan_bindings,
                to_regclass('deviludo.spec_dialogue_operations')::text AS spec_dialogue_operations`,
      );
      assertReadyTables(result.rows[0], [
        "github_source_baseline_operations", "github_source_baseline_receipts",
        "github_repository_bindings", "github_installations", "immutable_revisions",
        "approved_test_plan_bindings", "spec_dialogue_operations",
      ]);
    }
    finally { client.release(); }
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
      try { await client.query("ROLLBACK"); } catch { /* preserve authority error */ }
      throw error;
    } finally { client.release(); }
  }
}

function assertReadyTables(row: Record<string, unknown> | undefined, tables: readonly string[]): void {
  if (!row || tables.some((table) => row[table] !== `deviludo.${table}`)) conflict();
}

async function sourceAuthority(client: PostgresWorkflowClient, request: SourceBaselineRequest) {
  const selected = await client.query<AuthorityRow>(
    `SELECT repository.id::text AS repository_binding_id,
            repository.tenant_id::text, repository.project_id::text,
            installation.installation_id, repository.repository_id,
            repository.repository_node_id, repository.owner_name,
            repository.repository_name, repository.default_branch,
            spec.id::text AS spec_revision_id, plan.id::text AS test_plan_revision_id,
            operation.operation_key AS spec_approval_receipt_id
       FROM deviludo.github_repository_bindings repository
       JOIN deviludo.github_installations installation
         ON installation.id = repository.github_installation_id
        AND installation.tenant_id = repository.tenant_id
        AND installation.status = 'ACTIVE'
       JOIN deviludo.immutable_revisions spec
         ON spec.id = $3::uuid AND spec.tenant_id = repository.tenant_id
        AND spec.project_id = repository.project_id
        AND spec.aggregate_type = 'GAME_SPEC' AND spec.state = 'APPROVED'
       JOIN deviludo.immutable_revisions plan
         ON plan.id = $4::uuid AND plan.tenant_id = repository.tenant_id
        AND plan.project_id = repository.project_id
        AND plan.aggregate_type = 'TEST_PLAN' AND plan.state = 'FROZEN'
       JOIN deviludo.approved_test_plan_bindings binding
         ON binding.tenant_id = repository.tenant_id
        AND binding.project_id = repository.project_id
        AND binding.spec_revision_id = spec.id
        AND binding.test_plan_revision_id = plan.id
       JOIN deviludo.spec_dialogue_operations operation
         ON operation.operation_key = $5
        AND operation.tenant_id = repository.tenant_id
        AND operation.project_id = repository.project_id
        AND operation.state = 'COMPLETED'
        AND operation.response->>'operationKey' = operation.operation_key
        AND operation.response->>'specRevisionId' = spec.id::text
        AND operation.response->>'testPlanRevisionId' = plan.id::text
      WHERE repository.tenant_id = $1::uuid AND repository.project_id = $2::uuid
        AND repository.status = 'ACTIVE'
      FOR SHARE OF repository, installation, spec, plan, binding, operation`,
    [request.tenantId, request.projectId, request.specRevisionId,
      request.testPlanRevisionId, request.specApprovalReceiptId],
  );
  const row = selected.rows[0];
  if (selected.rows.length !== 1 || !row || row.tenant_id !== request.tenantId
    || row.project_id !== request.projectId || row.spec_revision_id !== request.specRevisionId
    || row.test_plan_revision_id !== request.testPlanRevisionId
    || row.spec_approval_receipt_id !== request.specApprovalReceiptId
    || !UUID.test(row.repository_binding_id)) conflict();
  return Object.freeze({
    repositoryBindingId: row.repository_binding_id,
    binding: Object.freeze({
      tenantId: row.tenant_id, projectId: row.project_id,
      installationId: positiveIntegerString(row.installation_id),
      repositoryId: positiveSafeNumber(row.repository_id),
      repositoryNodeId: safe(row.repository_node_id, 256),
      owner: safe(row.owner_name, 100), name: safe(row.repository_name, 100),
      defaultBranch: safe(row.default_branch, 255),
    }) satisfies GitHubRepositoryBinding,
  });
}

function acquired(request: SourceBaselineRequest, claimToken: string, authority: Awaited<ReturnType<typeof sourceAuthority>>) {
  return Object.freeze({ kind: "ACQUIRED" as const, claim: Object.freeze({
    request, claimToken, repositoryBindingId: authority.repositoryBindingId, binding: authority.binding,
  }) });
}
function receiptFromRow(row: ReceiptRow | undefined, request: SourceBaselineRequest): SourceBaselineReceipt {
  if (!row || !UUID.test(row.id) || row.operation_key !== request.operationKey
    || row.tenant_id !== request.tenantId || row.project_id !== request.projectId
    || row.workflow_id !== request.workflowId || row.spec_revision_id !== request.specRevisionId
    || row.test_plan_revision_id !== request.testPlanRevisionId
    || row.spec_approval_receipt_id !== request.specApprovalReceiptId) conflict();
  return parseSourceBaselineReceipt({
    schemaVersion: "deviludo.source-baseline-receipt.v1", operationKey: row.operation_key,
    tenantId: row.tenant_id, projectId: row.project_id, workflowId: row.workflow_id,
    specRevisionId: row.spec_revision_id, testPlanRevisionId: row.test_plan_revision_id,
    specApprovalReceiptId: row.spec_approval_receipt_id, sourceBaselineReceiptId: row.id,
    repositoryBindingId: row.repository_binding_id, defaultBranch: row.default_branch,
    commitSha: row.commit_sha, sourceDigest: row.source_digest,
    observedAt: new Date(row.observed_at).toISOString(), replayed: false,
  });
}
function assertReceiptRequest(receipt: SourceBaselineReceipt, request: SourceBaselineRequest): void {
  if (receipt.operationKey !== request.operationKey || receipt.tenantId !== request.tenantId
    || receipt.projectId !== request.projectId || receipt.workflowId !== request.workflowId
    || receipt.specRevisionId !== request.specRevisionId
    || receipt.testPlanRevisionId !== request.testPlanRevisionId
    || receipt.specApprovalReceiptId !== request.specApprovalReceiptId) conflict();
}
function validateObserved(value: Readonly<{ defaultBranch: string; commitSha: string; sourceDigest: string; observedAt: string }>): void {
  if (!value.defaultBranch || value.defaultBranch.length > 255 || /[\0\r\n]/.test(value.defaultBranch)
    || !SHA1.test(value.commitSha) || !SHA256.test(value.sourceDigest)
    || !Number.isFinite(Date.parse(value.observedAt))
    || new Date(value.observedAt).toISOString() !== value.observedAt) conflict();
}
function positiveIntegerString(value: string | number | bigint): string {
  const result = String(value); if (!/^[1-9][0-9]{0,19}$/.test(result)) conflict(); return result;
}
function positiveSafeNumber(value: string | number | bigint): number {
  const result = Number(value); if (!Number.isSafeInteger(result) || result < 1) conflict(); return result;
}
function safe(value: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\0\r\n]/.test(value)) conflict();
  return value;
}
function conflict(): never { throw new Error("Source baseline authority conflicts with persisted state"); }
