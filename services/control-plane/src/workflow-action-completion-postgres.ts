import { createHash } from "node:crypto";
import { DEFAULT_AUTOMATIC_REPAIR_LIMIT } from "../../../lib/orchestration/game-delivery";
import type { DeliverySignal } from "../../temporal/src/contracts";
import { assertDeliverySignal } from "../../temporal/src/contracts";
import type {
  ControlPlaneWorkflowAction,
  ControlPlaneWorkflowBinding,
} from "./workflow-handler";
import type {
  ControlPlaneWorkflowSqlClient,
  ControlPlaneWorkflowSqlPool,
} from "./workflow-action-postgres";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const STEAM_AUTHORITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type WorkflowActionCompletionSource =
  | "SPEC_SERVICE"
  | "AGENT_CONFIGURATION_SERVICE"
  | "USER_ACCEPTANCE_SERVICE"
  | "PROVIDER_MONITOR"
  | "MFA_BROKER"
  | "STEAM_APPROVAL_MONITOR";

export class WorkflowActionCompletionValidationError extends Error {}
export class WorkflowActionCompletionConflictError extends Error {}

export interface WorkflowActionCompletionReceipt {
  readonly actionId: string;
  readonly outboxId: string;
  readonly workflowId: string;
  readonly signalId: string;
  readonly signalDigest: string;
  readonly state: "PENDING_DELIVERY" | "DELIVERED";
  readonly replayed: boolean;
}

export interface WorkflowActionCompletionPort {
  complete(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly workflowId: string;
    readonly actionId: string;
    readonly source: WorkflowActionCompletionSource;
    readonly sourceReceiptId: string;
    readonly signal: DeliverySignal;
  }): Promise<WorkflowActionCompletionReceipt>;
}

type ActionRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  operation: ControlPlaneWorkflowAction;
  status: "WAITING" | "ACKNOWLEDGED" | "COMPLETED" | "INVALIDATED";
  binding: ControlPlaneWorkflowBinding;
  completion_signal_id: string | null;
  completion_signal_digest: string | null;
  completion_source: WorkflowActionCompletionSource | null;
  completion_receipt_id: string | null;
};

type OutboxRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  action_id: string;
  signal_id: string;
  signal_digest: string;
  signal: unknown;
  state: "PENDING" | "DELIVERING" | "RETRYABLE_FAILED" | "DELIVERED";
};
type SpecReadyAuthorityRow = {
  draft_spec_revision_id: string;
  draft_state: string;
  conversation_state: string;
  current_spec_revision_id: string;
  approved_previous_revision_id: string | null;
};
type SpecApprovalAuthorityRow = {
  approved_spec_revision_id: string;
  draft_spec_revision_id: string;
  approved_spec_state: string;
  test_plan_revision_id: string;
  test_plan_state: string;
  conversation_state: string;
  current_spec_revision_id: string;
  current_test_plan_revision_id: string;
  operation_state: string;
  operation_response: unknown;
};
type RunConfigurationAuthorityRow = {
  run_id: string;
  state: string;
  configuration_lock: unknown;
};

type CandidateAcceptanceAuthorityRow = {
  candidate_receipt_id: string;
  candidate_run_id: string;
  candidate_spec_revision_id: string;
  candidate_commit_sha: string;
  candidate_source_digest: string;
  candidate_pull_request: string | number;
  attempt_id: string;
  attempt_state: string;
  attempt_mode: string;
  attempt_workflow_id: string;
  attempt_commit_sha: string;
  attempt_source_digest: string;
  attempt_binding: unknown;
  evidence_id: string;
  evidence_commit_sha: string;
  evidence_source_digest: string;
  evidence_status: string;
  evidence_invalidated_at: string | null;
  evidence_binding: unknown;
};
type FeedbackSpecAuthorityRow = {
  next_spec_revision_id: string;
  next_spec_state: string;
  next_spec_revision: number;
  next_previous_revision_id: string | null;
  previous_spec_revision_id: string;
  previous_spec_state: string;
  previous_spec_revision: number;
  conversation_state: string;
  current_spec_revision_id: string;
  current_test_plan_revision_id: string | null;
};
type FeedbackInvalidationRow = {
  id: string;
  candidate_receipt_id: string;
  evidence_bundle_id: string;
  previous_spec_revision_id: string;
  next_spec_revision_id: string;
  source_receipt_id: string;
  reason: string;
  receipt_digest: string;
  receipt: unknown;
  invalidated_at: string;
};
type HumanRepairOperationRow = {
  operation_key: string;
  project_id: string;
  workflow_id: string;
  action_id: string;
  previous_spec_revision_id: string;
  evidence_invalidation_id: string;
  signal_id: string;
  state: string;
  next_spec_revision_id: string;
  draft_snapshot: unknown;
};

type ExternalApprovalSignal = Extract<DeliverySignal, { type: "EXTERNAL_APPROVED" }>;
type ExternalApprovalAuthorityRow = {
  release_id: string;
  release_state: string;
  external_gate: string;
  build_receipt_id: string;
  build_state: string;
  steam_install_evidence_bundle_digest: string | null;
  evidence_id: string;
  evidence_bundle_digest: string;
  release_target_matrix: string[];
  attempt_target_matrix: string[];
};
type ExternalApprovalReceiptRow = {
  id: string;
  release_id: string;
  workflow_id: string;
  signal_id: string;
  gate: string;
  approval_id: string;
  verifier_subject: string;
  evidence_digest: string;
  receipt: unknown;
};

/**
 * Atomically completes one server-authoritative wait and records its exact
 * Temporal signal. Callers are internal brokers/monitors, never browsers.
 */
export class PostgresWorkflowActionCompletionStore implements WorkflowActionCompletionPort {
  constructor(private readonly pool: ControlPlaneWorkflowSqlPool) {}

  async complete(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly workflowId: string;
    readonly actionId: string;
    readonly source: WorkflowActionCompletionSource;
    readonly sourceReceiptId: string;
    readonly signal: DeliverySignal;
  }): Promise<WorkflowActionCompletionReceipt> {
    validateInput(input);
    const signalDigest = digest(input.signal);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.tenantId]);
      const actionResult = await client.query<ActionRow>(
        `SELECT id, tenant_id, project_id, workflow_id, operation, status,
                binding, completion_signal_id, completion_signal_digest,
                completion_source, completion_receipt_id
           FROM deviludo.workflow_control_actions
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [input.tenantId, input.actionId],
      );
      const action = actionResult.rows[0];
      if (!action || action.project_id !== input.projectId || action.workflow_id !== input.workflowId) {
        throw new WorkflowActionCompletionConflictError("Workflow control action is unavailable in the authorized binding");
      }
      validateSignalBinding(action.operation, action.binding, input.source, input.signal);
      if (action.status === "INVALIDATED" || action.status === "ACKNOWLEDGED") {
        throw new WorkflowActionCompletionConflictError("Workflow control action cannot be completed");
      }
      if (action.status === "COMPLETED") {
        assertReplay(action, input, signalDigest);
      } else if (action.status !== "WAITING") {
        throw new WorkflowActionCompletionConflictError("Workflow control action state is invalid");
      }

      if (input.source === "SPEC_SERVICE"
        && (input.signal.type === "SPEC_READY" || input.signal.type === "SPEC_APPROVED")) {
        await this.#assertSpecAuthority(client, action, input.signal);
      }
      if (input.source === "AGENT_CONFIGURATION_SERVICE"
        && input.signal.type === "RUN_CONFIGURATION_LOCKED") {
        await this.#assertRunConfigurationAuthority(client, action, input.signal.lockedRunConfigurationId);
      }

      if (input.source === "USER_ACCEPTANCE_SERVICE"
        && (input.signal.type === "USER_ACCEPTED" || input.signal.type === "USER_FEEDBACK")) {
        if (action.operation === "REQUEST_SPEC_APPROVAL" && input.signal.type === "USER_FEEDBACK") {
          await this.#assertHumanRepairRevision(client, action, input, input.signal);
        } else {
          await this.#recordUserAcceptance(client, action, input, input.signal);
        }
      }

      if (input.source === "STEAM_APPROVAL_MONITOR" && input.signal.type === "EXTERNAL_APPROVED") {
        await this.#recordExternalApproval(client, action, input, input.signal);
      }

      await client.query(
        `INSERT INTO deviludo.workflow_signal_outbox
          (tenant_id, project_id, workflow_id, action_id, signal_id,
           signal_digest, signal)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::jsonb)
         ON CONFLICT (tenant_id, signal_id) DO NOTHING`,
        [
          input.tenantId, input.projectId, input.workflowId, input.actionId,
          input.signal.signalId, signalDigest, JSON.stringify(input.signal),
        ],
      );
      const outboxResult = await client.query<OutboxRow>(
        `SELECT id, tenant_id, project_id, workflow_id, action_id,
                signal_id, signal_digest, signal, state
           FROM deviludo.workflow_signal_outbox
          WHERE tenant_id = $1::uuid AND signal_id = $2
          FOR UPDATE`,
        [input.tenantId, input.signal.signalId],
      );
      const outbox = outboxResult.rows[0];
      assertOutbox(outbox, input, signalDigest);
      const replayed = action.status === "COMPLETED";
      if (!replayed) {
        const updated = await client.query(
          `UPDATE deviludo.workflow_control_actions
              SET status = 'COMPLETED', completion_signal_id = $3,
                  completion_signal_digest = $4,
                  completion_source = $5, completion_receipt_id = $6,
                  completed_at = now()
            WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'WAITING'
          RETURNING id`,
          [
            input.tenantId, input.actionId, input.signal.signalId, signalDigest,
            input.source, input.sourceReceiptId,
          ],
        );
        if (updated.rows.length !== 1) {
          throw new WorkflowActionCompletionConflictError("Workflow control action completion race was lost");
        }
      }
      await client.query("COMMIT");
      return Object.freeze({
        actionId: input.actionId,
        outboxId: outbox.id,
        workflowId: input.workflowId,
        signalId: input.signal.signalId,
        signalDigest,
        state: outbox.state === "DELIVERED" ? "DELIVERED" : "PENDING_DELIVERY",
        replayed,
      });
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #assertSpecAuthority(
    client: ControlPlaneWorkflowSqlClient,
    action: ActionRow,
    signal: Extract<DeliverySignal, { type: "SPEC_READY" | "SPEC_APPROVED" }>,
  ): Promise<void> {
    if (signal.type === "SPEC_READY") {
      if (!UUID.test(signal.specRevisionId)) invalidAuthority();
      const selected = await client.query<SpecReadyAuthorityRow>(
        `SELECT draft.id::text AS draft_spec_revision_id,
                draft.state AS draft_state,
                conversation.state AS conversation_state,
                conversation.current_spec_revision_id::text,
                approved.previous_revision_id::text AS approved_previous_revision_id
           FROM deviludo.immutable_revisions draft
           JOIN deviludo.spec_conversations conversation
             ON conversation.tenant_id = draft.tenant_id
            AND conversation.project_id = draft.project_id
            AND conversation.spec_aggregate_id = draft.aggregate_id
           LEFT JOIN deviludo.immutable_revisions approved
             ON approved.id = conversation.current_spec_revision_id
            AND approved.tenant_id = draft.tenant_id
            AND approved.project_id = draft.project_id
            AND approved.aggregate_type = 'GAME_SPEC'
          WHERE draft.tenant_id = $1::uuid AND draft.project_id = $2::uuid
            AND draft.id = $3::uuid AND draft.aggregate_type = 'GAME_SPEC'
          FOR SHARE OF draft, conversation, approved`,
        [action.tenant_id, action.project_id, signal.specRevisionId],
      );
      const row = selected.rows[0];
      if (selected.rows.length !== 1 || !row || row.draft_spec_revision_id !== signal.specRevisionId
        || row.draft_state !== "DRAFT" || (row.current_spec_revision_id !== signal.specRevisionId
          && row.approved_previous_revision_id !== signal.specRevisionId)
        || (row.conversation_state !== "DRAFT" && row.conversation_state !== "APPROVED")) {
        throw new WorkflowActionCompletionConflictError("Specification-ready authority is unavailable");
      }
      return;
    }

    if (!UUID.test(signal.approvedSpecRevisionId) || !UUID.test(signal.testPlanRevisionId)
      || !SHA256.test(signal.approvalReceiptId)) invalidAuthority();
    const selected = await client.query<SpecApprovalAuthorityRow>(
      `SELECT spec.id::text AS approved_spec_revision_id,
              spec.previous_revision_id::text AS draft_spec_revision_id,
              spec.state AS approved_spec_state,
              plan.id::text AS test_plan_revision_id,
              plan.state AS test_plan_state,
              conversation.state AS conversation_state,
              conversation.current_spec_revision_id::text,
              conversation.current_test_plan_revision_id::text,
              operation.state AS operation_state,
              operation.response AS operation_response
         FROM deviludo.immutable_revisions spec
         JOIN deviludo.spec_conversations conversation
           ON conversation.tenant_id = spec.tenant_id
          AND conversation.project_id = spec.project_id
          AND conversation.spec_aggregate_id = spec.aggregate_id
          AND conversation.current_spec_revision_id = spec.id
         JOIN deviludo.immutable_revisions plan
           ON plan.id = $4::uuid AND plan.tenant_id = spec.tenant_id
          AND plan.project_id = spec.project_id
          AND plan.aggregate_id = conversation.test_plan_aggregate_id
          AND plan.aggregate_type = 'TEST_PLAN'
         JOIN deviludo.approved_test_plan_bindings binding
           ON binding.tenant_id = spec.tenant_id
          AND binding.project_id = spec.project_id
          AND binding.spec_revision_id = spec.id
          AND binding.test_plan_revision_id = plan.id
         JOIN deviludo.spec_dialogue_operations operation
           ON operation.operation_key = $5
          AND operation.tenant_id = spec.tenant_id
          AND operation.project_id = spec.project_id
          AND operation.conversation_id = conversation.id
        WHERE spec.tenant_id = $1::uuid AND spec.project_id = $2::uuid
          AND spec.id = $3::uuid AND spec.aggregate_type = 'GAME_SPEC'
        FOR SHARE OF spec, conversation, plan, binding, operation`,
      [action.tenant_id, action.project_id, signal.approvedSpecRevisionId,
        signal.testPlanRevisionId, signal.approvalReceiptId],
    );
    const row = selected.rows[0];
    const response = row ? record(row.operation_response) : {};
    if (selected.rows.length !== 1 || !row
      || row.approved_spec_revision_id !== signal.approvedSpecRevisionId
      || row.draft_spec_revision_id !== action.binding.specRevisionId
      || row.approved_spec_state !== "APPROVED"
      || row.test_plan_revision_id !== signal.testPlanRevisionId || row.test_plan_state !== "FROZEN"
      || row.conversation_state !== "APPROVED"
      || row.current_spec_revision_id !== signal.approvedSpecRevisionId
      || row.current_test_plan_revision_id !== signal.testPlanRevisionId
      || row.operation_state !== "COMPLETED"
      || response.operationKey !== signal.approvalReceiptId
      || response.specRevisionId !== signal.approvedSpecRevisionId
      || response.testPlanRevisionId !== signal.testPlanRevisionId) {
      throw new WorkflowActionCompletionConflictError("Specification approval authority is unavailable");
    }
  }

  async #assertRunConfigurationAuthority(
    client: ControlPlaneWorkflowSqlClient,
    action: ActionRow,
    lockedRunConfigurationId: string,
  ): Promise<void> {
    if (!UUID.test(lockedRunConfigurationId)) invalidAuthority();
    const selected = await client.query<RunConfigurationAuthorityRow>(
      `SELECT id::text AS run_id, state, configuration_lock
         FROM deviludo.agent_runs
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
        FOR SHARE`,
      [action.tenant_id, action.project_id, lockedRunConfigurationId],
    );
    const row = selected.rows[0];
    const lock = row ? record(row.configuration_lock) : {};
    if (selected.rows.length !== 1 || !row || row.run_id !== lockedRunConfigurationId
      || row.state !== "QUEUED" || lock.specRevisionId !== action.binding.specRevisionId
      || lock.testPlanRevisionId !== action.binding.testPlanRevisionId
      || lock.specApprovalReceiptId !== action.binding.specApprovalReceiptId) {
      throw new WorkflowActionCompletionConflictError("Agent run configuration authority is unavailable");
    }
  }

  async #recordUserAcceptance(
    client: ControlPlaneWorkflowSqlClient,
    action: ActionRow,
    input: Parameters<WorkflowActionCompletionPort["complete"]>[0],
    signal: Extract<DeliverySignal, { type: "USER_ACCEPTED" | "USER_FEEDBACK" }>,
  ): Promise<void> {
    const specRevisionId = action.binding.specRevisionId;
    const evidenceBundleId = action.binding.evidenceBundleId;
    const candidateCommitSha = action.binding.candidateCommitSha;
    const draftPullRequest = action.binding.draftPullRequest;
    if (!specRevisionId || !UUID.test(specRevisionId) || !evidenceBundleId || !UUID.test(evidenceBundleId)
      || !candidateCommitSha || !/^[a-f0-9]{40}$/.test(candidateCommitSha)
      || !Number.isSafeInteger(draftPullRequest) || (draftPullRequest as number) < 1) invalidAuthority();
    const selected = await client.query<CandidateAcceptanceAuthorityRow>(
      `SELECT candidate.id::text AS candidate_receipt_id,
              candidate.run_id::text AS candidate_run_id,
              candidate.spec_revision_id::text AS candidate_spec_revision_id,
              candidate.candidate_commit_sha,
              candidate.source_digest AS candidate_source_digest,
              candidate.pull_request_number AS candidate_pull_request,
              attempt.id::text AS attempt_id,
              attempt.state AS attempt_state,
              attempt.mode AS attempt_mode,
              attempt.workflow_id AS attempt_workflow_id,
              attempt.commit_sha AS attempt_commit_sha,
              attempt.source_digest AS attempt_source_digest,
              attempt.binding AS attempt_binding,
              evidence.id::text AS evidence_id,
              evidence.commit_sha AS evidence_commit_sha,
              evidence.source_digest AS evidence_source_digest,
              evidence.status AS evidence_status,
              evidence.invalidated_at::text AS evidence_invalidated_at,
              evidence.binding AS evidence_binding
         FROM deviludo.github_candidate_receipts candidate
         JOIN deviludo.e2e_attempts attempt
           ON attempt.tenant_id = candidate.tenant_id
          AND attempt.project_id = candidate.project_id
          AND attempt.run_id = candidate.run_id
          AND attempt.workflow_id = $3
          AND attempt.mode = 'CANDIDATE'
          AND attempt.commit_sha = candidate.candidate_commit_sha
          AND attempt.source_digest = candidate.source_digest
          AND attempt.draft_pull_request = candidate.pull_request_number
         JOIN deviludo.evidence_bundles evidence
           ON evidence.tenant_id = attempt.tenant_id
          AND evidence.project_id = attempt.project_id
          AND evidence.attempt_id = attempt.id
          AND evidence.id = $7::uuid
        WHERE candidate.tenant_id = $1::uuid AND candidate.project_id = $2::uuid
          AND candidate.spec_revision_id = $4::uuid
          AND candidate.candidate_commit_sha = $5
          AND candidate.pull_request_number = $6::bigint
          AND attempt.state = 'PASSED' AND evidence.status = 'PASSED'
        FOR UPDATE OF evidence`,
      [action.tenant_id, action.project_id, action.workflow_id, specRevisionId,
        candidateCommitSha, draftPullRequest, evidenceBundleId],
    );
    const authority = selected.rows[0];
    const attemptBinding = authority ? record(authority.attempt_binding) : {};
    const evidenceBinding = authority ? record(authority.evidence_binding) : {};
    if (selected.rows.length !== 1 || !authority || !UUID.test(authority.candidate_receipt_id)
      || !UUID.test(authority.candidate_run_id) || !UUID.test(authority.attempt_id)
      || authority.candidate_spec_revision_id !== specRevisionId
      || authority.candidate_commit_sha !== candidateCommitSha
      || Number(authority.candidate_pull_request) !== draftPullRequest
      || authority.attempt_state !== "PASSED" || authority.attempt_mode !== "CANDIDATE"
      || authority.attempt_workflow_id !== action.workflow_id
      || authority.attempt_commit_sha !== candidateCommitSha
      || authority.evidence_commit_sha !== candidateCommitSha
      || authority.attempt_source_digest !== authority.candidate_source_digest
      || authority.evidence_source_digest !== authority.candidate_source_digest
      || authority.evidence_id !== evidenceBundleId || authority.evidence_status !== "PASSED"
      || attemptBinding.specRevisionId !== specRevisionId
      || evidenceBinding.specRevisionId !== specRevisionId) {
      throw new WorkflowActionCompletionConflictError("Candidate acceptance evidence authority is unavailable");
    }
    if (signal.type === "USER_ACCEPTED") {
      if (authority.evidence_invalidated_at !== null) {
        throw new WorkflowActionCompletionConflictError("Candidate acceptance evidence has been invalidated");
      }
      return;
    }
    await this.#recordFeedbackInvalidation(client, action, input, signal, authority);
  }

  async #assertHumanRepairRevision(
    client: ControlPlaneWorkflowSqlClient,
    action: ActionRow,
    input: Parameters<WorkflowActionCompletionPort["complete"]>[0],
    signal: Extract<DeliverySignal, { type: "USER_FEEDBACK" }>,
  ): Promise<void> {
    if (!isHumanRepairBinding(action.binding)
      || !UUID.test(signal.nextSpecRevisionId) || !UUID.test(signal.evidenceInvalidationId)) invalidAuthority();
    const operationResult = await client.query<HumanRepairOperationRow>(
      `SELECT operation_key, project_id::text, workflow_id, action_id::text,
              previous_spec_revision_id::text, evidence_invalidation_id::text,
              signal_id, state, next_spec_revision_id::text, draft_snapshot
         FROM deviludo.user_feedback_operations
        WHERE tenant_id = $1::uuid AND operation_key = $2
        FOR SHARE`,
      [action.tenant_id, input.sourceReceiptId],
    );
    const operation = operationResult.rows[0];
    const draft = operation ? record(operation.draft_snapshot) : {};
    if (operationResult.rows.length !== 1 || !operation
      || operation.operation_key !== input.sourceReceiptId
      || operation.project_id !== action.project_id || operation.workflow_id !== action.workflow_id
      || operation.action_id !== action.id
      || operation.previous_spec_revision_id !== action.binding.specRevisionId
      || operation.evidence_invalidation_id !== signal.evidenceInvalidationId
      || operation.signal_id !== signal.signalId
      || (operation.state !== "DRAFT_READY" && operation.state !== "COMPLETED")
      || operation.next_spec_revision_id !== signal.nextSpecRevisionId
      || draft.specRevisionId !== signal.nextSpecRevisionId) {
      throw new WorkflowActionCompletionConflictError("Human repair revision authority is unavailable");
    }

    const specResult = await client.query<FeedbackSpecAuthorityRow>(
      `SELECT next.id::text AS next_spec_revision_id,
              next.state AS next_spec_state,
              next.revision AS next_spec_revision,
              next.previous_revision_id::text AS next_previous_revision_id,
              previous.id::text AS previous_spec_revision_id,
              previous.state AS previous_spec_state,
              previous.revision AS previous_spec_revision,
              conversation.state AS conversation_state,
              conversation.current_spec_revision_id::text,
              conversation.current_test_plan_revision_id::text
         FROM deviludo.immutable_revisions next
         JOIN deviludo.immutable_revisions previous
           ON previous.tenant_id = next.tenant_id
          AND previous.project_id = next.project_id
          AND previous.id = next.previous_revision_id
          AND previous.aggregate_type = 'GAME_SPEC'
          AND previous.aggregate_id = next.aggregate_id
         JOIN deviludo.spec_conversations conversation
           ON conversation.tenant_id = next.tenant_id
          AND conversation.project_id = next.project_id
          AND conversation.spec_aggregate_id = next.aggregate_id
          AND conversation.current_spec_revision_id = next.id
        WHERE next.tenant_id = $1::uuid AND next.project_id = $2::uuid
          AND next.id = $3::uuid AND next.aggregate_type = 'GAME_SPEC'
          AND next.previous_revision_id = $4::uuid
        FOR SHARE OF next, previous, conversation`,
      [action.tenant_id, action.project_id, signal.nextSpecRevisionId, action.binding.specRevisionId],
    );
    const spec = specResult.rows[0];
    if (specResult.rows.length !== 1 || !spec
      || spec.next_spec_revision_id !== signal.nextSpecRevisionId
      || spec.next_spec_state !== "DRAFT"
      || spec.next_previous_revision_id !== action.binding.specRevisionId
      || spec.previous_spec_revision_id !== action.binding.specRevisionId
      || spec.previous_spec_state !== "APPROVED"
      || spec.next_spec_revision !== spec.previous_spec_revision + 1
      || spec.conversation_state !== "DRAFT"
      || spec.current_spec_revision_id !== signal.nextSpecRevisionId
      || !spec.current_test_plan_revision_id) {
      throw new WorkflowActionCompletionConflictError("Human repair specification revision authority is unavailable");
    }
  }

  async #recordFeedbackInvalidation(
    client: ControlPlaneWorkflowSqlClient,
    action: ActionRow,
    input: Parameters<WorkflowActionCompletionPort["complete"]>[0],
    signal: Extract<DeliverySignal, { type: "USER_FEEDBACK" }>,
    authority: CandidateAcceptanceAuthorityRow,
  ): Promise<void> {
    if (!UUID.test(signal.nextSpecRevisionId) || !UUID.test(signal.evidenceInvalidationId)) invalidAuthority();
    const specResult = await client.query<FeedbackSpecAuthorityRow>(
      `SELECT next.id::text AS next_spec_revision_id,
              next.state AS next_spec_state,
              next.revision AS next_spec_revision,
              next.previous_revision_id::text AS next_previous_revision_id,
              previous.id::text AS previous_spec_revision_id,
              previous.state AS previous_spec_state,
              previous.revision AS previous_spec_revision,
              conversation.state AS conversation_state,
              conversation.current_spec_revision_id::text,
              conversation.current_test_plan_revision_id::text
         FROM deviludo.immutable_revisions next
         JOIN deviludo.immutable_revisions previous
           ON previous.tenant_id = next.tenant_id
          AND previous.project_id = next.project_id
          AND previous.id = next.previous_revision_id
          AND previous.aggregate_type = 'GAME_SPEC'
          AND previous.aggregate_id = next.aggregate_id
         JOIN deviludo.spec_conversations conversation
           ON conversation.tenant_id = next.tenant_id
          AND conversation.project_id = next.project_id
          AND conversation.spec_aggregate_id = next.aggregate_id
          AND conversation.current_spec_revision_id = next.id
        WHERE next.tenant_id = $1::uuid AND next.project_id = $2::uuid
          AND next.id = $3::uuid AND next.aggregate_type = 'GAME_SPEC'
          AND next.previous_revision_id = $4::uuid
        FOR SHARE OF next, previous, conversation`,
      [action.tenant_id, action.project_id, signal.nextSpecRevisionId, action.binding.specRevisionId],
    );
    const spec = specResult.rows[0];
    if (specResult.rows.length !== 1 || !spec
      || spec.next_spec_revision_id !== signal.nextSpecRevisionId
      || spec.next_spec_state !== "DRAFT"
      || spec.next_previous_revision_id !== action.binding.specRevisionId
      || spec.previous_spec_revision_id !== action.binding.specRevisionId
      || spec.previous_spec_state !== "APPROVED"
      || spec.next_spec_revision !== spec.previous_spec_revision + 1
      || spec.conversation_state !== "DRAFT"
      || spec.current_spec_revision_id !== signal.nextSpecRevisionId
      || !spec.current_test_plan_revision_id) {
      throw new WorkflowActionCompletionConflictError("Feedback specification revision authority is unavailable");
    }
    const receipt = Object.freeze({
      schemaVersion: "deviludo.feedback-evidence-invalidation.v1",
      source: input.source,
      sourceReceiptId: input.sourceReceiptId,
      actionId: input.actionId,
      workflowId: input.workflowId,
      candidateReceiptId: authority.candidate_receipt_id,
      candidateCommitSha: authority.candidate_commit_sha,
      draftPullRequest: Number(authority.candidate_pull_request),
      evidenceBundleId: authority.evidence_id,
      previousSpecRevisionId: action.binding.specRevisionId,
      nextSpecRevisionId: signal.nextSpecRevisionId,
      reason: "USER_FEEDBACK",
    });
    const receiptDigest = digest(receipt);
    if (action.status === "WAITING") {
      if (authority.evidence_invalidated_at !== null) {
        throw new WorkflowActionCompletionConflictError("Candidate feedback evidence was already invalidated");
      }
      await client.query(
        `INSERT INTO deviludo.workflow_feedback_invalidations
          (id, tenant_id, project_id, workflow_id, action_id,
           candidate_receipt_id, evidence_bundle_id, previous_spec_revision_id,
           next_spec_revision_id, source_receipt_id, reason, receipt_digest, receipt)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid,
                 $7::uuid, $8::uuid, $9::uuid, $10, 'USER_FEEDBACK', $11, $12::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [signal.evidenceInvalidationId, action.tenant_id, action.project_id,
          action.workflow_id, action.id, authority.candidate_receipt_id, authority.evidence_id,
          action.binding.specRevisionId, signal.nextSpecRevisionId, input.sourceReceiptId,
          receiptDigest, JSON.stringify(receipt)],
      );
    }
    const storedResult = await client.query<FeedbackInvalidationRow>(
      `SELECT id::text, candidate_receipt_id::text, evidence_bundle_id::text,
              previous_spec_revision_id::text, next_spec_revision_id::text,
              source_receipt_id, reason, receipt_digest, receipt,
              invalidated_at::text
         FROM deviludo.workflow_feedback_invalidations
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
        FOR SHARE`,
      [action.tenant_id, action.project_id, signal.evidenceInvalidationId],
    );
    const stored = storedResult.rows[0];
    const storedReceipt = typeof stored?.receipt === "string"
      ? JSON.parse(stored.receipt) as unknown : stored?.receipt;
    if (storedResult.rows.length !== 1 || !stored
      || stored.id !== signal.evidenceInvalidationId
      || stored.candidate_receipt_id !== authority.candidate_receipt_id
      || stored.evidence_bundle_id !== authority.evidence_id
      || stored.previous_spec_revision_id !== action.binding.specRevisionId
      || stored.next_spec_revision_id !== signal.nextSpecRevisionId
      || stored.source_receipt_id !== input.sourceReceiptId
      || stored.reason !== "USER_FEEDBACK" || stored.receipt_digest !== receiptDigest
      || digest(storedReceipt) !== receiptDigest || !stored.invalidated_at) {
      throw new WorkflowActionCompletionConflictError("Feedback invalidation receipt idempotency binding mismatch");
    }
    if (action.status === "COMPLETED") {
      if (authority.evidence_invalidated_at !== stored.invalidated_at) {
        throw new WorkflowActionCompletionConflictError("Feedback invalidation replay conflicts with evidence state");
      }
      return;
    }
    const invalidated = await client.query(
      `UPDATE deviludo.evidence_bundles
          SET invalidated_at = $4::timestamptz
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
          AND status = 'PASSED' AND invalidated_at IS NULL
      RETURNING id`,
      [action.tenant_id, action.project_id, authority.evidence_id, stored.invalidated_at],
    );
    if (invalidated.rows.length !== 1) {
      throw new WorkflowActionCompletionConflictError("Candidate evidence invalidation race was lost");
    }
  }

  async #recordExternalApproval(
    client: ControlPlaneWorkflowSqlClient,
    action: ActionRow,
    input: Parameters<WorkflowActionCompletionPort["complete"]>[0],
    signal: ExternalApprovalSignal,
  ): Promise<void> {
    const evidenceBundleId = action.binding.evidenceBundleId;
    const steamBuildId = action.binding.steamBuildId;
    if (!evidenceBundleId || !UUID.test(evidenceBundleId) || !steamBuildId
      || !STEAM_AUTHORITY_ID.test(signal.approvalId) || action.binding.externalGate !== signal.gate) {
      throw new WorkflowActionCompletionValidationError("External approval authority binding is invalid");
    }
    const authorityResult = await client.query<ExternalApprovalAuthorityRow>(
      `SELECT release.id::text AS release_id,
              release.state AS release_state,
              release.external_gate,
              release.target_matrix AS release_target_matrix,
              build.id::text AS build_receipt_id,
              build.state AS build_state,
              build.steam_install_evidence_bundle_digest,
              evidence.id::text AS evidence_id,
              evidence.bundle_digest AS evidence_bundle_digest,
              attempt.target_matrix AS attempt_target_matrix
         FROM deviludo.steam_build_receipts build
         JOIN deviludo.steam_releases release
           ON release.tenant_id = build.tenant_id
          AND release.project_id = build.project_id
          AND release.id = build.release_id
         JOIN deviludo.evidence_bundles evidence
           ON evidence.tenant_id = build.tenant_id
          AND evidence.project_id = build.project_id
          AND evidence.id = $5::uuid
         JOIN deviludo.e2e_attempts attempt
           ON attempt.tenant_id = evidence.tenant_id
          AND attempt.project_id = evidence.project_id
          AND attempt.id = evidence.attempt_id
        WHERE build.tenant_id = $1::uuid AND build.project_id = $2::uuid
          AND release.workflow_id = $3 AND build.build_id = $4
          AND attempt.workflow_id = $3 AND attempt.mode = 'STEAM_CLEAN_INSTALL'
          AND attempt.steam_build_id = build.build_id AND attempt.state = 'PASSED'
          AND evidence.status = 'PASSED' AND evidence.invalidated_at IS NULL
          AND build.state = 'EXTERNAL_APPROVAL_REQUIRED'
          AND build.steam_install_evidence_bundle_digest = evidence.bundle_digest
          AND release.main_commit_sha = attempt.commit_sha
          AND build.source_digest = attempt.source_digest
          AND release.run_id = attempt.run_id
        FOR UPDATE OF build, release`,
      [input.tenantId, input.projectId, input.workflowId, steamBuildId, evidenceBundleId],
    );
    if (authorityResult.rows.length !== 1) {
      throw new WorkflowActionCompletionConflictError("External approval release authority is unavailable");
    }
    const authority = authorityResult.rows[0]!;
    if (!UUID.test(authority.release_id) || !UUID.test(authority.build_receipt_id)
      || authority.evidence_id !== evidenceBundleId || !SHA256.test(authority.evidence_bundle_digest)
      || authority.steam_install_evidence_bundle_digest !== authority.evidence_bundle_digest
      || authority.build_state !== "EXTERNAL_APPROVAL_REQUIRED"
      || JSON.stringify(authority.release_target_matrix) !== JSON.stringify(authority.attempt_target_matrix)) {
      throw new WorkflowActionCompletionConflictError("External approval evidence binding conflicts with the release");
    }
    const receipt = Object.freeze({
      schemaVersion: "deviludo.external-approval.v1",
      source: input.source,
      sourceReceiptId: input.sourceReceiptId,
      actionId: input.actionId,
      workflowId: input.workflowId,
      releaseId: authority.release_id,
      buildReceiptId: authority.build_receipt_id,
      steamBuildId,
      installEvidenceBundleId: evidenceBundleId,
      installEvidenceBundleDigest: authority.evidence_bundle_digest,
      signal: Object.freeze({ ...signal }),
    });
    const evidenceDigest = digest(receipt);
    if (action.status === "WAITING") {
      if (authority.release_state !== "EXTERNAL_APPROVAL_REQUIRED" || authority.external_gate !== signal.gate) {
        throw new WorkflowActionCompletionConflictError("External approval arrived for a stale gate");
      }
      await client.query(
        `INSERT INTO deviludo.workflow_external_approval_receipts
          (tenant_id, project_id, release_id, workflow_id, signal_id, gate,
           approval_id, verifier_subject, evidence_digest, receipt, verified_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb, now())
         ON CONFLICT (release_id, gate) DO NOTHING`,
        [input.tenantId, input.projectId, authority.release_id, input.workflowId,
          signal.signalId, signal.gate, signal.approvalId, input.source, evidenceDigest, JSON.stringify(receipt)],
      );
    }
    const storedResult = await client.query<ExternalApprovalReceiptRow>(
      `SELECT id::text, release_id::text, workflow_id, signal_id, gate,
              approval_id, verifier_subject, evidence_digest, receipt
         FROM deviludo.workflow_external_approval_receipts
        WHERE tenant_id = $1::uuid AND release_id = $2::uuid AND gate = $3
        FOR SHARE`,
      [input.tenantId, authority.release_id, signal.gate],
    );
    const stored = storedResult.rows[0];
    const storedReceipt = typeof stored?.receipt === "string" ? JSON.parse(stored.receipt) as unknown : stored?.receipt;
    if (storedResult.rows.length !== 1 || !stored || !UUID.test(stored.id)
      || stored.release_id !== authority.release_id || stored.workflow_id !== input.workflowId
      || stored.signal_id !== signal.signalId || stored.gate !== signal.gate
      || stored.approval_id !== signal.approvalId || stored.verifier_subject !== input.source
      || stored.evidence_digest !== evidenceDigest || digest(storedReceipt) !== evidenceDigest) {
      throw new WorkflowActionCompletionConflictError("External approval receipt idempotency binding mismatch");
    }
    if (action.status === "COMPLETED") {
      if (!isDownstreamGate(authority.release_state, authority.external_gate, signal.gate)) {
        throw new WorkflowActionCompletionConflictError("External approval replay conflicts with release state");
      }
      return;
    }
    const next = nextGate(signal.gate);
    const updated = await client.query(
      `UPDATE deviludo.steam_releases
          SET state = $4, external_gate = $5, version = version + 1
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
          AND state = 'EXTERNAL_APPROVAL_REQUIRED' AND external_gate = $6
      RETURNING id`,
      [input.tenantId, input.projectId, authority.release_id, next.state, next.gate, signal.gate],
    );
    if (updated.rows.length !== 1) {
      throw new WorkflowActionCompletionConflictError("External approval lifecycle transition was lost");
    }
  }
}

function validateInput(input: Parameters<PostgresWorkflowActionCompletionStore["complete"]>[0]): void {
  for (const value of [input.tenantId, input.projectId, input.actionId]) {
    if (!UUID.test(value)) {
      throw new WorkflowActionCompletionValidationError("Workflow action completion UUID binding is invalid");
    }
  }
  if (!SAFE_ID.test(input.workflowId) || !SAFE_ID.test(input.sourceReceiptId)) {
    throw new WorkflowActionCompletionValidationError("Workflow action completion identity is invalid");
  }
  try {
    assertDeliverySignal(input.signal);
  } catch {
    throw new WorkflowActionCompletionValidationError("Workflow action completion delivery signal is invalid");
  }
}

function validateSignalBinding(
  operation: ControlPlaneWorkflowAction,
  binding: ControlPlaneWorkflowBinding,
  source: WorkflowActionCompletionSource,
  signal: DeliverySignal,
): void {
  if (operation === "REQUEST_SPEC_APPROVAL"
    && source === "USER_ACCEPTANCE_SERVICE"
    && signal.type === "USER_FEEDBACK"
    && binding.specRevisionId
    && signal.nextSpecRevisionId !== binding.specRevisionId
    && isHumanRepairBinding(binding)) return;
  const allowedSource: Record<Exclude<ControlPlaneWorkflowAction, "CANCEL_DELIVERY">, WorkflowActionCompletionSource> = {
    CONTINUE_IDEA_DIALOGUE: "SPEC_SERVICE",
    REQUEST_SPEC_APPROVAL: "SPEC_SERVICE",
    RESOLVE_AGENT_RUN_CONFIGURATION: "AGENT_CONFIGURATION_SERVICE",
    WAIT_FOR_PROVIDER: "PROVIDER_MONITOR",
    REQUEST_USER_ACCEPTANCE: "USER_ACCEPTANCE_SERVICE",
    REQUEST_FRESH_MFA: "MFA_BROKER",
    WAIT_FOR_EXTERNAL_APPROVAL: "STEAM_APPROVAL_MONITOR",
  };
  if (operation === "CANCEL_DELIVERY" || source !== allowedSource[operation]) invalidBinding();
  if (operation === "CONTINUE_IDEA_DIALOGUE" && signal.type === "SPEC_READY") return;
  if (operation === "REQUEST_SPEC_APPROVAL" && signal.type === "SPEC_APPROVED"
    && binding.specRevisionId && signal.approvedSpecRevisionId !== binding.specRevisionId
    && signal.testPlanRevisionId && signal.approvalReceiptId) return;
  if (operation === "RESOLVE_AGENT_RUN_CONFIGURATION" && signal.type === "RUN_CONFIGURATION_LOCKED"
    && binding.specRevisionId && binding.testPlanRevisionId && binding.specApprovalReceiptId) return;
  if (operation === "WAIT_FOR_PROVIDER" && signal.type === "PROVIDER_RESTORED"
    && signal.providerRevisionId === binding.providerRevisionId) return;
  if (operation === "REQUEST_USER_ACCEPTANCE"
    && (signal.type === "USER_ACCEPTED" || signal.type === "USER_FEEDBACK")
    && binding.specRevisionId && binding.candidateCommitSha
    && binding.draftPullRequest && binding.evidenceBundleId) return;
  if (operation === "REQUEST_FRESH_MFA" && signal.type === "MFA_APPROVED"
    && binding.mainCommitSha && binding.evidenceBundleId) return;
  if (operation === "WAIT_FOR_EXTERNAL_APPROVAL" && signal.type === "EXTERNAL_APPROVED"
    && signal.gate === binding.externalGate && binding.steamBuildId && binding.evidenceBundleId) return;
  invalidBinding();
}

function isHumanRepairBinding(binding: ControlPlaneWorkflowBinding): boolean {
  const repair = binding.repairContext;
  return binding.state === "WAITING_SPEC_APPROVAL"
    && repair !== null
    && Number.isSafeInteger(repair.attempt)
    && repair.attempt >= DEFAULT_AUTOMATIC_REPAIR_LIMIT
    && (repair.reason === "AGENT_FAILURE" || repair.reason === "E2E_FAILURE")
    && Boolean(repair.fromRunConfigurationId);
}

function assertReplay(
  action: ActionRow,
  input: Parameters<PostgresWorkflowActionCompletionStore["complete"]>[0],
  signalDigest: string,
): void {
  if (action.completion_signal_id !== input.signal.signalId
    || action.completion_signal_digest !== signalDigest
    || action.completion_source !== input.source
    || action.completion_receipt_id !== input.sourceReceiptId) {
    throw new WorkflowActionCompletionConflictError(
      "Workflow control action completion was replayed with another authority binding",
    );
  }
}

function assertOutbox(
  outbox: OutboxRow | undefined,
  input: Parameters<PostgresWorkflowActionCompletionStore["complete"]>[0],
  signalDigest: string,
): asserts outbox is OutboxRow {
  const value = typeof outbox?.signal === "string" ? JSON.parse(outbox.signal) as unknown : outbox?.signal;
  if (!outbox || !UUID.test(outbox.id) || outbox.tenant_id !== input.tenantId
    || outbox.project_id !== input.projectId || outbox.workflow_id !== input.workflowId
    || outbox.action_id !== input.actionId || outbox.signal_id !== input.signal.signalId
    || outbox.signal_digest !== signalDigest || digest(value) !== signalDigest) {
    throw new WorkflowActionCompletionConflictError("Workflow signal outbox idempotency binding mismatch");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return record(JSON.parse(value) as unknown); }
    catch { invalidAuthority(); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidAuthority();
  return value as Record<string, unknown>;
}

function invalidAuthority(): never {
  throw new WorkflowActionCompletionValidationError("Workflow action completion authority is invalid");
}

function nextGate(gate: ExternalApprovalSignal["gate"]): Readonly<{ state: string; gate: string }> {
  if (gate === "VALVE_REVIEW") return Object.freeze({ state: "EXTERNAL_APPROVAL_REQUIRED", gate: "FIRST_RELEASE" });
  if (gate === "FIRST_RELEASE") return Object.freeze({ state: "EXTERNAL_APPROVAL_REQUIRED", gate: "DEFAULT_BRANCH_CONFIRMATION" });
  return Object.freeze({ state: "READY_TO_PUBLISH", gate: "NONE" });
}

function isDownstreamGate(state: string, gate: string, completed: ExternalApprovalSignal["gate"]): boolean {
  if (state === "READY_TO_PUBLISH" || state === "RELEASED") return gate === "NONE";
  if (state !== "EXTERNAL_APPROVAL_REQUIRED") return false;
  if (completed === "VALVE_REVIEW") return gate === "FIRST_RELEASE" || gate === "DEFAULT_BRANCH_CONFIRMATION";
  if (completed === "FIRST_RELEASE") return gate === "DEFAULT_BRANCH_CONFIRMATION";
  return false;
}

async function rollback(client: ControlPlaneWorkflowSqlClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
}

function invalidBinding(): never {
  throw new WorkflowActionCompletionValidationError("Workflow action completion signal binding is invalid");
}
