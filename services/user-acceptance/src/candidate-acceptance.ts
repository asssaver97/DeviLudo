import { randomUUID } from "node:crypto";
import type { WorkflowActionCompletionPort, WorkflowActionCompletionReceipt } from "../../control-plane/src/workflow-action-completion-postgres";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { specDigest } from "../../spec-dialogue/src/store";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

export interface CandidateAcceptanceCommand {
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
}

export interface CandidateAcceptanceDecision {
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly workflowId: string;
  readonly actionId: string;
  readonly specRevisionId: string;
  readonly candidateReceiptId: string;
  readonly candidateCommitSha: string;
  readonly draftPullRequest: number;
  readonly evidenceBundleId: string;
  readonly signalId: string;
  readonly acceptedAt: string;
}

export interface CandidateAcceptanceReceipt extends CandidateAcceptanceDecision {
  readonly state: "MERGE_QUEUED";
  readonly delivery: WorkflowActionCompletionReceipt;
}

export type CandidateAcceptanceBegin =
  | { readonly kind: "PENDING_DELIVERY"; readonly decision: CandidateAcceptanceDecision }
  | { readonly kind: "COMPLETED"; readonly receipt: CandidateAcceptanceReceipt }
  | { readonly kind: "CONFLICT" };

export interface CandidateAcceptanceStore {
  begin(command: CandidateAcceptanceCommand): Promise<CandidateAcceptanceBegin>;
  complete(decision: CandidateAcceptanceDecision, delivery: WorkflowActionCompletionReceipt): Promise<CandidateAcceptanceReceipt>;
  probe(): Promise<void>;
}

export class CandidateAcceptanceService {
  constructor(
    private readonly store: CandidateAcceptanceStore,
    private readonly completions: WorkflowActionCompletionPort,
  ) {}

  async accept(value: unknown): Promise<CandidateAcceptanceReceipt> {
    const command = parseCandidateAcceptanceCommand(value);
    const outcome = await this.store.begin(command);
    if (outcome.kind === "COMPLETED") return outcome.receipt;
    if (outcome.kind === "CONFLICT") throw new CandidateAcceptanceConflict();
    const delivery = await this.completions.complete({
      tenantId: outcome.decision.tenantId,
      projectId: outcome.decision.projectId,
      workflowId: outcome.decision.workflowId,
      actionId: outcome.decision.actionId,
      source: "USER_ACCEPTANCE_SERVICE",
      sourceReceiptId: outcome.decision.operationKey,
      signal: Object.freeze({ signalId: outcome.decision.signalId, type: "USER_ACCEPTED" as const }),
    });
    return this.store.complete(outcome.decision, delivery);
  }

  probe(): Promise<void> { return this.store.probe(); }
}

export class PostgresCandidateAcceptanceStore implements CandidateAcceptanceStore {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async begin(command: CandidateAcceptanceCommand): Promise<CandidateAcceptanceBegin> {
    validateCommand(command);
    const requestDigest = specDigest(command);
    return this.#transaction(command.tenantId, async (client) => {
      let row = await selectDecision(client, command.tenantId, command.operationKey, true);
      if (row) return parseExisting(row, command, requestDigest);
      const authorities = await client.query<AuthorityRow>(
        `SELECT action.workflow_id, action.id::text AS action_id,
                spec.id::text AS spec_revision_id,
                candidate.id::text AS candidate_receipt_id,
                candidate.candidate_commit_sha,
                candidate.pull_request_number,
                evidence.id::text AS evidence_bundle_id
           FROM deviludo.workflow_control_actions action
           JOIN deviludo.users actor
             ON actor.tenant_id = action.tenant_id
            AND actor.id::text = $3 AND actor.status = 'ACTIVE'
           JOIN deviludo.tenant_memberships membership
             ON membership.tenant_id = actor.tenant_id
            AND membership.user_id = actor.id
            AND membership.status = 'ACTIVE'
            AND membership.role IN ('TenantAdmin', 'ProjectOwner')
           JOIN deviludo.immutable_revisions spec
             ON spec.tenant_id = action.tenant_id
            AND spec.project_id = action.project_id
            AND spec.id::text = action.binding->>'specRevisionId'
            AND spec.aggregate_type = 'GAME_SPEC' AND spec.state = 'APPROVED'
           JOIN deviludo.github_candidate_receipts candidate
             ON candidate.tenant_id = action.tenant_id
            AND candidate.project_id = action.project_id
            AND candidate.spec_revision_id = spec.id
            AND candidate.candidate_commit_sha = action.binding->>'candidateCommitSha'
            AND candidate.pull_request_number::text = action.binding->>'draftPullRequest'
           JOIN deviludo.e2e_attempts attempt
             ON attempt.tenant_id = candidate.tenant_id
            AND attempt.project_id = candidate.project_id
            AND attempt.run_id = candidate.run_id
            AND attempt.workflow_id = action.workflow_id
            AND attempt.mode = 'CANDIDATE' AND attempt.state = 'PASSED'
            AND attempt.commit_sha = candidate.candidate_commit_sha
            AND attempt.source_digest = candidate.source_digest
            AND attempt.draft_pull_request = candidate.pull_request_number
            AND attempt.binding->>'specRevisionId' = spec.id::text
           JOIN deviludo.evidence_bundles evidence
             ON evidence.tenant_id = attempt.tenant_id
            AND evidence.project_id = attempt.project_id
            AND evidence.attempt_id = attempt.id
            AND evidence.id::text = action.binding->>'evidenceBundleId'
            AND evidence.status = 'PASSED' AND evidence.invalidated_at IS NULL
            AND evidence.commit_sha = candidate.candidate_commit_sha
            AND evidence.source_digest = candidate.source_digest
            AND evidence.binding->>'specRevisionId' = spec.id::text
          WHERE action.tenant_id = $1::uuid AND action.project_id = $2::uuid
            AND action.operation = 'REQUEST_USER_ACCEPTANCE'
            AND action.status = 'WAITING'
          ORDER BY action.created_at DESC
          LIMIT 2
          FOR SHARE OF action, actor, membership, spec, candidate, attempt, evidence`,
        [command.tenantId, command.projectId, command.actorId],
      );
      if (authorities.rows.length !== 1) return Object.freeze({ kind: "CONFLICT" as const });
      const authority = parseAuthority(authorities.rows[0]!);
      const decision: CandidateAcceptanceDecision = Object.freeze({
        operationKey: command.operationKey,
        tenantId: command.tenantId,
        projectId: command.projectId,
        actorId: command.actorId,
        workflowId: authority.workflow_id,
        actionId: authority.action_id,
        specRevisionId: authority.spec_revision_id,
        candidateReceiptId: authority.candidate_receipt_id,
        candidateCommitSha: authority.candidate_commit_sha,
        draftPullRequest: Number(authority.pull_request_number),
        evidenceBundleId: authority.evidence_bundle_id,
        signalId: `accepted-${randomUUID()}`,
        acceptedAt: new Date().toISOString(),
      });
      const inserted = await client.query(
        `INSERT INTO deviludo.user_candidate_acceptances
          (operation_key, tenant_id, project_id, actor_id, request_digest,
           workflow_id, action_id, spec_revision_id, candidate_receipt_id,
           candidate_commit_sha, draft_pull_request, evidence_bundle_id,
           signal_id, state, accepted_at)
         VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid,
                 $8::uuid, $9::uuid, $10, $11, $12::uuid, $13,
                 'PENDING_DELIVERY', $14::timestamptz)
         ON CONFLICT DO NOTHING`,
        [decision.operationKey, decision.tenantId, decision.projectId,
          decision.actorId, requestDigest, decision.workflowId, decision.actionId,
          decision.specRevisionId, decision.candidateReceiptId,
          decision.candidateCommitSha, decision.draftPullRequest,
          decision.evidenceBundleId, decision.signalId, decision.acceptedAt],
      );
      if (inserted.rowCount !== 1) return Object.freeze({ kind: "CONFLICT" as const });
      row = await selectDecision(client, command.tenantId, command.operationKey, true);
      if (!row) invalid();
      return parseExisting(row, command, requestDigest);
    });
  }

  async complete(decision: CandidateAcceptanceDecision, delivery: WorkflowActionCompletionReceipt): Promise<CandidateAcceptanceReceipt> {
    if (delivery.actionId !== decision.actionId || delivery.workflowId !== decision.workflowId
      || delivery.signalId !== decision.signalId || !UUID.test(delivery.outboxId)
      || !SHA256.test(delivery.signalDigest)) invalid();
    return this.#transaction(decision.tenantId, async (client) => {
      const row = await selectDecision(client, decision.tenantId, decision.operationKey, true);
      if (!row || specDigest(parseDecision(row)) !== specDigest(decision)) invalid();
      if (row.state === "COMPLETED") return parseReceipt(row.completion_receipt, decision);
      if (row.state !== "PENDING_DELIVERY") invalid();
      const receipt: CandidateAcceptanceReceipt = Object.freeze({
        ...decision,
        state: "MERGE_QUEUED",
        delivery: Object.freeze({ ...delivery }),
      });
      const updated = await client.query(
        `UPDATE deviludo.user_candidate_acceptances
            SET state = 'COMPLETED', completion_receipt = $3::jsonb,
                completed_at = now()
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND state = 'PENDING_DELIVERY'`,
        [decision.tenantId, decision.operationKey, JSON.stringify(receipt)],
      );
      if (updated.rowCount !== 1) invalid();
      return receipt;
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT to_regclass('deviludo.workflow_control_actions')::text AS workflow_control_actions,
                to_regclass('deviludo.users')::text AS users,
                to_regclass('deviludo.tenant_memberships')::text AS tenant_memberships,
                to_regclass('deviludo.immutable_revisions')::text AS immutable_revisions,
                to_regclass('deviludo.github_candidate_receipts')::text AS github_candidate_receipts,
                to_regclass('deviludo.e2e_attempts')::text AS e2e_attempts,
                to_regclass('deviludo.evidence_bundles')::text AS evidence_bundles,
                to_regclass('deviludo.user_candidate_acceptances')::text AS user_candidate_acceptances`,
      );
      const row = result.rows[0];
      for (const table of [
        "workflow_control_actions", "users", "tenant_memberships", "immutable_revisions",
        "github_candidate_receipts", "e2e_attempts", "evidence_bundles", "user_candidate_acceptances",
      ]) {
        if (row?.[table] !== `deviludo.${table}`) invalid();
      }
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
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally { client.release(); }
  }
}

export class CandidateAcceptanceConflict extends Error {
  readonly code = "CANDIDATE_ACCEPTANCE_CONFLICT";
  constructor() { super("Candidate acceptance conflicts with the authoritative waiting action"); }
}
export class CandidateAcceptanceRequestError extends Error {
  readonly code = "INVALID_CANDIDATE_ACCEPTANCE_REQUEST";
  constructor() { super("Candidate acceptance request is invalid"); }
}

type AuthorityRow = {
  workflow_id: string;
  action_id: string;
  spec_revision_id: string;
  candidate_receipt_id: string;
  candidate_commit_sha: string;
  pull_request_number: string | number;
  evidence_bundle_id: string;
};
type DecisionRow = {
  operation_key: string;
  tenant_id: string;
  project_id: string;
  actor_id: string;
  request_digest: string;
  workflow_id: string;
  action_id: string;
  spec_revision_id: string;
  candidate_receipt_id: string;
  candidate_commit_sha: string;
  draft_pull_request: string | number;
  evidence_bundle_id: string;
  signal_id: string;
  state: string;
  accepted_at: string | Date;
  completion_receipt: unknown | null;
};

async function selectDecision(client: PostgresWorkflowClient, tenantId: string, operationKey: string, lock: boolean): Promise<DecisionRow | null> {
  const selected = await client.query<DecisionRow>(
    `SELECT operation_key, tenant_id::text, project_id::text, actor_id,
            request_digest, workflow_id, action_id::text,
            spec_revision_id::text, candidate_receipt_id::text,
            candidate_commit_sha, draft_pull_request,
            evidence_bundle_id::text, signal_id, state, accepted_at,
            completion_receipt
       FROM deviludo.user_candidate_acceptances
      WHERE tenant_id = $1::uuid AND operation_key = $2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, operationKey],
  );
  if (selected.rows.length > 1) invalid();
  return selected.rows[0] ?? null;
}

function parseExisting(row: DecisionRow, command: CandidateAcceptanceCommand, requestDigest: string): CandidateAcceptanceBegin {
  if (row.operation_key !== command.operationKey || row.tenant_id !== command.tenantId
    || row.project_id !== command.projectId || row.actor_id !== command.actorId
    || row.request_digest !== requestDigest) return Object.freeze({ kind: "CONFLICT" });
  const decision = parseDecision(row);
  if (row.state === "PENDING_DELIVERY") return Object.freeze({ kind: "PENDING_DELIVERY", decision });
  if (row.state === "COMPLETED") return Object.freeze({ kind: "COMPLETED", receipt: parseReceipt(row.completion_receipt, decision) });
  invalid();
}

function parseDecision(row: DecisionRow): CandidateAcceptanceDecision {
  const draftPullRequest = Number(row.draft_pull_request);
  const acceptedAt = new Date(row.accepted_at);
  if (!UUID.test(row.tenant_id) || !UUID.test(row.project_id) || !UUID.test(row.action_id)
    || !UUID.test(row.spec_revision_id) || !UUID.test(row.candidate_receipt_id)
    || !SHA1.test(row.candidate_commit_sha) || !Number.isSafeInteger(draftPullRequest)
    || draftPullRequest < 1 || !UUID.test(row.evidence_bundle_id)
    || !row.workflow_id || !row.signal_id || !Number.isFinite(acceptedAt.getTime())) invalid();
  return Object.freeze({
    operationKey: row.operation_key,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    actorId: row.actor_id,
    workflowId: row.workflow_id,
    actionId: row.action_id,
    specRevisionId: row.spec_revision_id,
    candidateReceiptId: row.candidate_receipt_id,
    candidateCommitSha: row.candidate_commit_sha,
    draftPullRequest,
    evidenceBundleId: row.evidence_bundle_id,
    signalId: row.signal_id,
    acceptedAt: acceptedAt.toISOString(),
  });
}

function parseReceipt(value: unknown, decision: CandidateAcceptanceDecision): CandidateAcceptanceReceipt {
  const body = object(value);
  const delivery = object(body.delivery);
  if (body.state !== "MERGE_QUEUED" || specDigest(Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "state" && key !== "delivery"),
  )) !== specDigest(decision)
    || delivery.actionId !== decision.actionId || delivery.workflowId !== decision.workflowId
    || delivery.signalId !== decision.signalId || typeof delivery.outboxId !== "string"
    || !UUID.test(delivery.outboxId) || typeof delivery.signalDigest !== "string"
    || !SHA256.test(delivery.signalDigest)
    || (delivery.state !== "PENDING_DELIVERY" && delivery.state !== "DELIVERED")
    || typeof delivery.replayed !== "boolean") invalid();
  return Object.freeze({
    ...decision,
    state: "MERGE_QUEUED",
    delivery: Object.freeze({
      actionId: decision.actionId,
      outboxId: delivery.outboxId,
      workflowId: decision.workflowId,
      signalId: decision.signalId,
      signalDigest: delivery.signalDigest,
      state: delivery.state,
      replayed: delivery.replayed,
    }),
  });
}

function parseAuthority(row: AuthorityRow): AuthorityRow {
  const pullRequest = Number(row.pull_request_number);
  if (!row.workflow_id || !UUID.test(row.action_id) || !UUID.test(row.spec_revision_id)
    || !UUID.test(row.candidate_receipt_id) || !SHA1.test(row.candidate_commit_sha)
    || !Number.isSafeInteger(pullRequest) || pullRequest < 1 || !UUID.test(row.evidence_bundle_id)) invalid();
  return row;
}

function parseCandidateAcceptanceCommand(value: unknown): CandidateAcceptanceCommand {
  const body = object(value);
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["actorId", "operationKey", "projectId", "tenantId"])) requestInvalid();
  const command = Object.freeze({
    operationKey: string(body.operationKey),
    tenantId: string(body.tenantId),
    projectId: string(body.projectId),
    actorId: string(body.actorId),
  });
  validateCommand(command);
  return command;
}

function validateCommand(command: CandidateAcceptanceCommand): void {
  if (!SHA256.test(command.operationKey) || !UUID.test(command.tenantId)
    || !UUID.test(command.projectId) || !SAFE_ID.test(command.actorId)) requestInvalid();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) requestInvalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== "string") requestInvalid(); return value; }
function requestInvalid(): never { throw new CandidateAcceptanceRequestError(); }
function invalid(): never { throw new Error("Candidate acceptance authority is invalid"); }
