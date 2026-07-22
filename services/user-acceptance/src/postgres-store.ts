import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTOMATIC_REPAIR_LIMIT,
  type DeliveryRepairContext,
} from "../../../lib/orchestration/game-delivery";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import {
  parseSpecModelResult,
  type SpecDialogueMessage,
  type SpecDialogueSnapshot,
  type SpecModelResult,
} from "../../spec-dialogue/src/contracts";
import { canonicalSpecJson, specDigest } from "../../spec-dialogue/src/store";
import type { WorkflowActionCompletionReceipt } from "../../control-plane/src/workflow-action-completion-postgres";
import {
  type UserFeedbackBeginResult,
  type UserFeedbackClaim,
  type UserFeedbackCommand,
  type UserFeedbackDraft,
  type UserFeedbackReceipt,
  type UserFeedbackStore,
} from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type OperationRow = {
  operation_key: string;
  tenant_id: string;
  project_id: string;
  actor_id: string;
  request_digest: string;
  feedback: string;
  feedback_digest: string;
  workflow_id: string;
  action_id: string;
  previous_conversation_id: string;
  previous_spec_revision_id: string;
  previous_test_plan_revision_id: string;
  evidence_invalidation_id: string;
  signal_id: string;
  state: string;
  claim_token: string | null;
  claim_active: boolean;
  draft_snapshot: unknown | null;
  completion_receipt: unknown | null;
};

type AuthorityRow = {
  workflow_id: string;
  action_id: string;
  action_operation: "REQUEST_USER_ACCEPTANCE" | "REQUEST_SPEC_APPROVAL";
  binding: unknown;
  conversation_id: string;
  conversation_state: string;
  spec_aggregate_id: string;
  test_plan_aggregate_id: string;
  spec_revision_id: string;
  spec_revision: string | number;
  spec_state: string;
  spec_payload: unknown;
  spec_payload_digest: string;
  test_plan_revision_id: string;
  test_plan_revision: string | number;
  test_plan_state: string;
  test_plan_payload: unknown;
  test_plan_payload_digest: string;
  current_metadata: unknown;
};

type MessageRow = {
  id: string;
  sequence: string | number;
  role: string;
  content: string;
  created_at: string | Date;
};

export class PostgresUserFeedbackStore implements UserFeedbackStore {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async begin(command: UserFeedbackCommand): Promise<UserFeedbackBeginResult> {
    validateCommand(command);
    const requestDigest = specDigest(command);
    const feedbackDigest = specDigest(command.feedback);
    const proposedClaimToken = randomUUID();
    return this.#transaction(command.tenantId, async (client) => {
      const selected = await selectOperation(client, command.tenantId, command.operationKey, true);
      let row = selected;
      if (row) {
        if (!sameRequest(row, command, requestDigest, feedbackDigest)) return Object.freeze({ kind: "CONFLICT" as const });
        if (row.state === "COMPLETED") return Object.freeze({ kind: "COMPLETED" as const, receipt: parseReceipt(row.completion_receipt, command) });
        if (row.state === "DRAFT_READY") return Object.freeze({ kind: "DRAFT_READY" as const, draft: parseDraft(row.draft_snapshot, command) });
        if (row.state !== "GENERATING") invalid();
        if (row.claim_active) return Object.freeze({ kind: "BUSY" as const });
        const reclaimed = await client.query<{ claim_token: string }>(
          `UPDATE deviludo.user_feedback_operations
              SET claim_token = $3::uuid, claim_expires_at = now() + interval '3 minutes'
            WHERE tenant_id = $1::uuid AND operation_key = $2
              AND state = 'GENERATING' AND claim_expires_at <= now()
          RETURNING claim_token::text`,
          [command.tenantId, command.operationKey, proposedClaimToken],
        );
        if (reclaimed.rows.length !== 1) return Object.freeze({ kind: "BUSY" as const });
        row = Object.freeze({ ...row, claim_token: reclaimed.rows[0]!.claim_token, claim_active: true });
      } else {
        const authorities = await selectAuthority(client, command.tenantId, command.projectId, command.actorId, null);
        if (authorities.length !== 1) return Object.freeze({ kind: "CONFLICT" as const });
        const authority = parseAuthority(authorities[0]!);
        const evidenceInvalidationId = randomUUID();
        const signalId = `feedback-${randomUUID()}`;
        const inserted = await client.query(
          `INSERT INTO deviludo.user_feedback_operations
            (operation_key, tenant_id, project_id, actor_id, request_digest,
             feedback, feedback_digest, workflow_id, action_id,
             previous_conversation_id, previous_spec_revision_id,
             previous_test_plan_revision_id, evidence_invalidation_id,
             signal_id, state, claim_token, claim_expires_at)
           VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::uuid,
                   $10::uuid, $11::uuid, $12::uuid, $13::uuid, $14,
                   'GENERATING', $15::uuid, now() + interval '3 minutes')
           ON CONFLICT (operation_key) DO NOTHING`,
          [command.operationKey, command.tenantId, command.projectId, command.actorId,
            requestDigest, command.feedback, feedbackDigest, authority.workflowId,
            authority.actionId, authority.conversationId, authority.specRevisionId,
            authority.testPlanRevisionId, evidenceInvalidationId, signalId, proposedClaimToken],
        );
        if (inserted.rowCount !== 1) return Object.freeze({ kind: "CONFLICT" as const });
        row = await selectOperation(client, command.tenantId, command.operationKey, true);
        if (!row || !sameRequest(row, command, requestDigest, feedbackDigest)) invalid();
      }

      if (!row.claim_token || !UUID.test(row.claim_token)) invalid();
      const authorities = await selectAuthority(client, command.tenantId, command.projectId, command.actorId, row.action_id);
      if (authorities.length !== 1) return Object.freeze({ kind: "CONFLICT" as const });
      const authority = parseAuthority(authorities[0]!);
      if (authority.workflowId !== row.workflow_id || authority.actionId !== row.action_id
        || authority.conversationId !== row.previous_conversation_id
        || authority.specRevisionId !== row.previous_spec_revision_id
        || authority.testPlanRevisionId !== row.previous_test_plan_revision_id) invalid();
      const history = await readMessages(client, command.tenantId, authority.conversationId);
      return Object.freeze({
        kind: "ACQUIRED" as const,
        claim: Object.freeze({
          command,
          claimToken: row.claim_token,
          workflowId: authority.workflowId,
          actionId: authority.actionId,
          previousConversationId: authority.conversationId,
          previousSpecRevisionId: authority.specRevisionId,
          previousTestPlanRevisionId: authority.testPlanRevisionId,
          specAggregateId: authority.specAggregateId,
          testPlanAggregateId: authority.testPlanAggregateId,
          previousRevision: authority.revision,
          history,
          current: authority.current,
          evidenceInvalidationId: row.evidence_invalidation_id,
          signalId: row.signal_id,
        }),
      });
    });
  }

  async createDraft(claim: UserFeedbackClaim, generated: SpecModelResult): Promise<UserFeedbackDraft> {
    validateCommand(claim.command);
    const result = parseSpecModelResult(generated);
    return this.#transaction(claim.command.tenantId, async (client) => {
      const row = await selectOperation(client, claim.command.tenantId, claim.command.operationKey, true);
      if (!row || !sameClaim(row, claim)) invalid();
      if (row.state === "COMPLETED" || row.state === "DRAFT_READY") return parseDraft(row.draft_snapshot, claim.command);
      if (row.state !== "GENERATING" || row.claim_token !== claim.claimToken || !row.claim_active) invalid();
      const authorities = await selectAuthority(client, claim.command.tenantId, claim.command.projectId, claim.command.actorId, claim.actionId);
      if (authorities.length !== 1) invalid();
      const authority = parseAuthority(authorities[0]!);
      if (!sameAuthority(authority, claim)) invalid();

      const conversationId = randomUUID();
      const specRevisionId = randomUUID();
      const testPlanRevisionId = randomUUID();
      const revision = claim.previousRevision + 1;
      const createdAt = new Date().toISOString();
      const specPayload = Object.freeze({ schemaVersion: "deviludo.game-spec.v1", conversationId, revision, spec: result.spec });
      const testPlanPayload = Object.freeze({ schemaVersion: "deviludo.test-plan.v1", conversationId, revision, testPlan: result.testPlan });
      const specPayloadDigest = specDigest(specPayload);
      const testPlanPayloadDigest = specDigest(testPlanPayload);
      await insertRevision(client, {
        id: specRevisionId, tenantId: claim.command.tenantId, projectId: claim.command.projectId,
        aggregateType: "GAME_SPEC", aggregateId: claim.specAggregateId, revision,
        payload: specPayload, payloadDigest: specPayloadDigest,
        previousRevisionId: claim.previousSpecRevisionId, createdBy: claim.command.actorId,
      });
      await insertRevision(client, {
        id: testPlanRevisionId, tenantId: claim.command.tenantId, projectId: claim.command.projectId,
        aggregateType: "TEST_PLAN", aggregateId: claim.testPlanAggregateId, revision,
        payload: testPlanPayload, payloadDigest: testPlanPayloadDigest,
        previousRevisionId: claim.previousTestPlanRevisionId, createdBy: claim.command.actorId,
      });
      const metadata = Object.freeze({
        assistantMessage: result.assistantMessage,
        completeness: result.completeness,
        openQuestions: result.openQuestions,
      });
      const insertedConversation = await client.query(
        `INSERT INTO deviludo.spec_conversations
          (id, tenant_id, project_id, spec_aggregate_id, test_plan_aggregate_id,
           current_spec_revision_id, current_test_plan_revision_id,
           current_metadata, version, state, created_by, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $6::uuid, $7::uuid, $8::jsonb, $9, 'DRAFT', $10,
                 $11::timestamptz, $11::timestamptz)`,
        [conversationId, claim.command.tenantId, claim.command.projectId,
          claim.specAggregateId, claim.testPlanAggregateId, specRevisionId,
          testPlanRevisionId, JSON.stringify(metadata), revision,
          claim.command.actorId, createdAt],
      );
      if (insertedConversation.rowCount !== 1) invalid();

      const messages = Object.freeze([
        Object.freeze({ id: randomUUID(), sequence: 1, role: "user" as const, text: claim.command.feedback, createdAt }),
        Object.freeze({ id: randomUUID(), sequence: 2, role: "assistant" as const, text: result.assistantMessage, createdAt }),
      ]);
      const snapshot: SpecDialogueSnapshot = Object.freeze({
        tenantId: claim.command.tenantId,
        projectId: claim.command.projectId,
        conversationId,
        revision,
        state: "DRAFT",
        specRevisionId,
        specDigest: specPayloadDigest,
        testPlanRevisionId,
        testPlanDigest: testPlanPayloadDigest,
        messages,
        result,
      });
      const dialogueRequestDigest = specDigest({
        tenantId: claim.command.tenantId,
        projectId: claim.command.projectId,
        conversationId,
        actorId: claim.command.actorId,
        expectedRevision: claim.previousRevision,
        message: claim.command.feedback,
      });
      const insertedDialogue = await client.query(
        `INSERT INTO deviludo.spec_dialogue_operations
          (operation_key, tenant_id, project_id, conversation_id, actor_id,
           expected_revision, request_digest, state, response, completed_at)
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
                 'COMPLETED', $8::jsonb, $9::timestamptz)`,
        [claim.command.operationKey, claim.command.tenantId, claim.command.projectId,
          conversationId, claim.command.actorId, claim.previousRevision,
          dialogueRequestDigest, JSON.stringify(snapshot), createdAt],
      );
      if (insertedDialogue.rowCount !== 1) invalid();
      const insertedMessages = await client.query(
        `INSERT INTO deviludo.spec_conversation_messages
          (id, tenant_id, project_id, conversation_id, operation_key,
           sequence, role, content, content_digest, created_by, created_at)
         VALUES
          ($1::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 1, 'user', $7, $8, $9, $10::timestamptz),
          ($2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 2, 'assistant', $11, $12, 'spec-model-broker', $10::timestamptz)`,
        [messages[0]!.id, messages[1]!.id, claim.command.tenantId,
          claim.command.projectId, conversationId, claim.command.operationKey,
          claim.command.feedback, specDigest(claim.command.feedback), claim.command.actorId,
          createdAt, result.assistantMessage, specDigest(result.assistantMessage)],
      );
      if (insertedMessages.rowCount !== 2) invalid();
      const draft: UserFeedbackDraft = Object.freeze({
        operationKey: claim.command.operationKey,
        tenantId: claim.command.tenantId,
        projectId: claim.command.projectId,
        actorId: claim.command.actorId,
        workflowId: claim.workflowId,
        actionId: claim.actionId,
        previousSpecRevisionId: claim.previousSpecRevisionId,
        evidenceInvalidationId: claim.evidenceInvalidationId,
        signalId: claim.signalId,
        snapshot,
      });
      const updated = await client.query(
        `UPDATE deviludo.user_feedback_operations
            SET state = 'DRAFT_READY', claim_token = NULL, claim_expires_at = NULL,
                next_conversation_id = $4::uuid,
                next_spec_revision_id = $5::uuid,
                next_test_plan_revision_id = $6::uuid,
                draft_snapshot = $7::jsonb, draft_created_at = $8::timestamptz
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND state = 'GENERATING' AND claim_token = $3::uuid`,
        [claim.command.tenantId, claim.command.operationKey, claim.claimToken,
          conversationId, specRevisionId, testPlanRevisionId,
          JSON.stringify(draft), createdAt],
      );
      if (updated.rowCount !== 1) invalid();
      return draft;
    });
  }

  async release(claim: UserFeedbackClaim): Promise<void> {
    await this.#transaction(claim.command.tenantId, async (client) => {
      await client.query(
        `UPDATE deviludo.user_feedback_operations
            SET claim_expires_at = now()
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND state = 'GENERATING' AND claim_token = $3::uuid`,
        [claim.command.tenantId, claim.command.operationKey, claim.claimToken],
      );
    });
  }

  async complete(draft: UserFeedbackDraft, delivery: WorkflowActionCompletionReceipt): Promise<UserFeedbackReceipt> {
    validateDraftDelivery(draft, delivery);
    return this.#transaction(draft.tenantId, async (client) => {
      const row = await selectOperation(client, draft.tenantId, draft.operationKey, true);
      if (!row || row.project_id !== draft.projectId) invalid();
      if (row.state === "COMPLETED") return parseReceipt(row.completion_receipt, {
        operationKey: draft.operationKey, tenantId: draft.tenantId, projectId: draft.projectId,
        actorId: draft.actorId, feedback: row.feedback,
      });
      if (row.state !== "DRAFT_READY") invalid();
      const storedDraft = parseDraft(row.draft_snapshot, {
        operationKey: draft.operationKey, tenantId: draft.tenantId, projectId: draft.projectId,
        actorId: draft.actorId, feedback: row.feedback,
      });
      if (specDigest(storedDraft) !== specDigest(draft)) invalid();
      const receipt: UserFeedbackReceipt = Object.freeze({
        ...draft,
        state: "AWAITING_SPEC_APPROVAL",
        delivery: Object.freeze({ ...delivery }),
      });
      const updated = await client.query(
        `UPDATE deviludo.user_feedback_operations
            SET state = 'COMPLETED', completion_receipt = $3::jsonb,
                completed_at = now()
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND state = 'DRAFT_READY'`,
        [draft.tenantId, draft.operationKey, JSON.stringify(receipt)],
      );
      if (updated.rowCount !== 1) invalid();
      return receipt;
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT to_regclass('deviludo.users')::text AS users,
                to_regclass('deviludo.tenant_memberships')::text AS tenant_memberships,
                to_regclass('deviludo.workflow_control_actions')::text AS workflow_control_actions,
                to_regclass('deviludo.user_feedback_operations')::text AS user_feedback_operations,
                to_regclass('deviludo.immutable_revisions')::text AS immutable_revisions,
                to_regclass('deviludo.spec_conversations')::text AS spec_conversations,
                to_regclass('deviludo.spec_dialogue_operations')::text AS spec_dialogue_operations,
                to_regclass('deviludo.spec_conversation_messages')::text AS spec_conversation_messages`,
      );
      const row = result.rows[0];
      for (const table of [
        "users", "tenant_memberships", "workflow_control_actions", "user_feedback_operations",
        "immutable_revisions", "spec_conversations", "spec_dialogue_operations", "spec_conversation_messages",
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

async function selectOperation(client: PostgresWorkflowClient, tenantId: string, operationKey: string, lock: boolean): Promise<OperationRow | null> {
  const selected = await client.query<OperationRow>(
    `SELECT operation_key, tenant_id::text, project_id::text, actor_id,
            request_digest, feedback, feedback_digest, workflow_id,
            action_id::text, previous_conversation_id::text,
            previous_spec_revision_id::text, previous_test_plan_revision_id::text,
            evidence_invalidation_id::text, signal_id, state,
            claim_token::text, COALESCE(claim_expires_at > now(), false) AS claim_active,
            draft_snapshot, completion_receipt
       FROM deviludo.user_feedback_operations
      WHERE tenant_id = $1::uuid AND operation_key = $2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, operationKey],
  );
  if (selected.rows.length > 1) invalid();
  return selected.rows[0] ?? null;
}

async function selectAuthority(
  client: PostgresWorkflowClient,
  tenantId: string,
  projectId: string,
  actorId: string,
  actionId: string | null,
): Promise<readonly AuthorityRow[]> {
  const selected = await client.query<AuthorityRow>(
    `SELECT action.workflow_id, action.id::text AS action_id,
            action.operation AS action_operation, action.binding,
            conversation.id::text AS conversation_id,
            conversation.state AS conversation_state,
            conversation.spec_aggregate_id::text,
            conversation.test_plan_aggregate_id::text,
            spec.id::text AS spec_revision_id, spec.revision AS spec_revision,
            spec.state AS spec_state, spec.payload AS spec_payload,
            spec.payload_digest AS spec_payload_digest,
            plan.id::text AS test_plan_revision_id,
            plan.revision AS test_plan_revision,
            plan.state AS test_plan_state, plan.payload AS test_plan_payload,
            plan.payload_digest AS test_plan_payload_digest,
            conversation.current_metadata
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
        AND spec.aggregate_type = 'GAME_SPEC'
       JOIN deviludo.spec_conversations conversation
         ON conversation.tenant_id = spec.tenant_id
        AND conversation.project_id = spec.project_id
        AND conversation.spec_aggregate_id = spec.aggregate_id
        AND conversation.current_spec_revision_id = spec.id
       JOIN deviludo.immutable_revisions plan
         ON plan.tenant_id = conversation.tenant_id
        AND plan.project_id = conversation.project_id
        AND plan.id = conversation.current_test_plan_revision_id
        AND plan.aggregate_type = 'TEST_PLAN'
        AND plan.aggregate_id = conversation.test_plan_aggregate_id
      WHERE action.tenant_id = $1::uuid AND action.project_id = $2::uuid
        AND (action.operation = 'REQUEST_USER_ACCEPTANCE' OR (
          action.operation = 'REQUEST_SPEC_APPROVAL'
          AND action.binding->>'state' = 'WAITING_SPEC_APPROVAL'
          AND (
            action.binding->'repairContext'->>'reason' IN ('MAIN_GATE_FAILURE', 'STEAM_INSTALL_FAILURE')
            OR (action.binding->'repairContext'->>'attempt' ~ '^[0-9]+$'
              AND (action.binding->'repairContext'->>'attempt')::integer >= ${DEFAULT_AUTOMATIC_REPAIR_LIMIT})
          )
        ))
        AND action.status = 'WAITING'
        AND ($4::text IS NULL OR action.id::text = $4)
        AND conversation.state = 'APPROVED'
        AND spec.state = 'APPROVED' AND plan.state = 'FROZEN'
        AND spec.revision = plan.revision
        AND NOT EXISTS (
          SELECT 1 FROM deviludo.spec_conversations draft
           WHERE draft.tenant_id = action.tenant_id
             AND draft.project_id = action.project_id AND draft.state = 'DRAFT'
        )
      ORDER BY action.created_at DESC
      LIMIT 2
      FOR SHARE OF action, actor, membership, spec, conversation, plan`,
    [tenantId, projectId, actorId, actionId],
  );
  return selected.rows;
}

function parseAuthority(row: AuthorityRow) {
  const revision = Number(row.spec_revision);
  const planRevision = Number(row.test_plan_revision);
  const binding = object(row.binding);
  const humanRepair = isHumanRepairAuthority(row.action_operation, binding);
  if (!UUID.test(row.action_id) || !UUID.test(row.conversation_id)
    || !UUID.test(row.spec_aggregate_id) || !UUID.test(row.test_plan_aggregate_id)
    || !UUID.test(row.spec_revision_id) || !UUID.test(row.test_plan_revision_id)
    || row.conversation_state !== "APPROVED" || row.spec_state !== "APPROVED"
    || row.test_plan_state !== "FROZEN" || !Number.isSafeInteger(revision)
    || revision < 1 || planRevision !== revision
    || binding.specRevisionId !== row.spec_revision_id
    || (!humanRepair && (typeof binding.candidateCommitSha !== "string" || !SHA1.test(binding.candidateCommitSha)))
    || (!humanRepair && (!Number.isSafeInteger(binding.draftPullRequest) || (binding.draftPullRequest as number) < 1))
    || (!humanRepair && (typeof binding.evidenceBundleId !== "string" || !UUID.test(binding.evidenceBundleId)))
    || !SHA256.test(row.spec_payload_digest) || !SHA256.test(row.test_plan_payload_digest)
    || specDigest(row.spec_payload) !== row.spec_payload_digest
    || specDigest(row.test_plan_payload) !== row.test_plan_payload_digest) invalid();
  const metadata = object(row.current_metadata);
  const spec = object(row.spec_payload);
  const plan = object(row.test_plan_payload);
  const current = parseSpecModelResult({
    assistantMessage: metadata.assistantMessage,
    completeness: metadata.completeness,
    openQuestions: metadata.openQuestions,
    spec: spec.spec,
    testPlan: plan.testPlan,
  });
  return Object.freeze({
    workflowId: row.workflow_id,
    actionId: row.action_id,
    conversationId: row.conversation_id,
    specAggregateId: row.spec_aggregate_id,
    testPlanAggregateId: row.test_plan_aggregate_id,
    specRevisionId: row.spec_revision_id,
    testPlanRevisionId: row.test_plan_revision_id,
    revision,
    current,
  });
}

function isHumanRepairAuthority(
  operation: AuthorityRow["action_operation"],
  binding: Record<string, unknown>,
): boolean {
  if (operation === "REQUEST_USER_ACCEPTANCE") return false;
  if (operation !== "REQUEST_SPEC_APPROVAL" || binding.state !== "WAITING_SPEC_APPROVAL") invalid();
  const repair = object(binding.repairContext) as Partial<DeliveryRepairContext>;
  const immediate = repair.reason === "MAIN_GATE_FAILURE" || repair.reason === "STEAM_INSTALL_FAILURE";
  if (!Number.isSafeInteger(repair.attempt) || (repair.attempt as number) < 1
    || (!immediate && (repair.attempt as number) < DEFAULT_AUTOMATIC_REPAIR_LIMIT)
    || (!immediate && repair.reason !== "AGENT_FAILURE" && repair.reason !== "E2E_FAILURE")
    || typeof repair.fromRunConfigurationId !== "string" || !repair.fromRunConfigurationId) invalid();
  return true;
}

async function readMessages(client: PostgresWorkflowClient, tenantId: string, conversationId: string): Promise<readonly SpecDialogueMessage[]> {
  const selected = await client.query<MessageRow>(
    `SELECT id::text, sequence, role, content, created_at
       FROM deviludo.spec_conversation_messages
      WHERE tenant_id = $1::uuid AND conversation_id = $2::uuid
      ORDER BY sequence ASC LIMIT 200`,
    [tenantId, conversationId],
  );
  return Object.freeze(selected.rows.map((row, index) => {
    const sequence = Number(row.sequence);
    const createdAt = new Date(row.created_at);
    if (!UUID.test(row.id) || sequence !== index + 1
      || (row.role !== "user" && row.role !== "assistant")
      || typeof row.content !== "string" || !row.content || row.content.length > 4_000
      || !Number.isFinite(createdAt.getTime())) invalid();
    return Object.freeze({
      id: row.id, sequence, role: row.role,
      text: row.content, createdAt: createdAt.toISOString(),
    });
  }));
}

async function insertRevision(client: PostgresWorkflowClient, input: {
  id: string;
  tenantId: string;
  projectId: string;
  aggregateType: "GAME_SPEC" | "TEST_PLAN";
  aggregateId: string;
  revision: number;
  payload: unknown;
  payloadDigest: string;
  previousRevisionId: string;
  createdBy: string;
}): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO deviludo.immutable_revisions
      (id, tenant_id, project_id, aggregate_type, aggregate_id, revision,
       state, payload, payload_digest, previous_revision_id, created_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6,
             'DRAFT', $7::jsonb, $8, $9::uuid, $10)`,
    [input.id, input.tenantId, input.projectId, input.aggregateType,
      input.aggregateId, input.revision, canonicalSpecJson(input.payload),
      input.payloadDigest, input.previousRevisionId, input.createdBy],
  );
  if (inserted.rowCount !== 1) invalid();
}

function sameRequest(row: OperationRow, command: UserFeedbackCommand, requestDigest: string, feedbackDigest: string): boolean {
  return row.operation_key === command.operationKey && row.tenant_id === command.tenantId
    && row.project_id === command.projectId && row.actor_id === command.actorId
    && row.request_digest === requestDigest && row.feedback === command.feedback
    && row.feedback_digest === feedbackDigest;
}

function sameClaim(row: OperationRow, claim: UserFeedbackClaim): boolean {
  return row.project_id === claim.command.projectId && row.actor_id === claim.command.actorId
    && row.workflow_id === claim.workflowId && row.action_id === claim.actionId
    && row.previous_conversation_id === claim.previousConversationId
    && row.previous_spec_revision_id === claim.previousSpecRevisionId
    && row.previous_test_plan_revision_id === claim.previousTestPlanRevisionId
    && row.evidence_invalidation_id === claim.evidenceInvalidationId
    && row.signal_id === claim.signalId;
}

function sameAuthority(authority: ReturnType<typeof parseAuthority>, claim: UserFeedbackClaim): boolean {
  return authority.workflowId === claim.workflowId && authority.actionId === claim.actionId
    && authority.conversationId === claim.previousConversationId
    && authority.specAggregateId === claim.specAggregateId
    && authority.testPlanAggregateId === claim.testPlanAggregateId
    && authority.specRevisionId === claim.previousSpecRevisionId
    && authority.testPlanRevisionId === claim.previousTestPlanRevisionId
    && authority.revision === claim.previousRevision;
}

function parseDraft(value: unknown, command: UserFeedbackCommand): UserFeedbackDraft {
  const body = object(value);
  if (body.operationKey !== command.operationKey || body.tenantId !== command.tenantId
    || body.projectId !== command.projectId || body.actorId !== command.actorId
    || typeof body.workflowId !== "string" || !body.workflowId
    || typeof body.actionId !== "string" || !UUID.test(body.actionId)
    || typeof body.previousSpecRevisionId !== "string" || !UUID.test(body.previousSpecRevisionId)
    || typeof body.evidenceInvalidationId !== "string" || !UUID.test(body.evidenceInvalidationId)
    || typeof body.signalId !== "string" || !body.signalId) invalid();
  return Object.freeze({
    operationKey: command.operationKey,
    tenantId: command.tenantId,
    projectId: command.projectId,
    actorId: command.actorId,
    workflowId: body.workflowId,
    actionId: body.actionId,
    previousSpecRevisionId: body.previousSpecRevisionId,
    evidenceInvalidationId: body.evidenceInvalidationId,
    signalId: body.signalId,
    snapshot: parseSnapshot(body.snapshot, command),
  });
}

function parseSnapshot(value: unknown, command: UserFeedbackCommand): SpecDialogueSnapshot {
  const body = object(value);
  if (body.tenantId !== command.tenantId || body.projectId !== command.projectId
    || typeof body.conversationId !== "string" || !UUID.test(body.conversationId)
    || !Number.isSafeInteger(body.revision) || (body.revision as number) < 2
    || body.state !== "DRAFT"
    || typeof body.specRevisionId !== "string" || !UUID.test(body.specRevisionId)
    || typeof body.testPlanRevisionId !== "string" || !UUID.test(body.testPlanRevisionId)
    || typeof body.specDigest !== "string" || !SHA256.test(body.specDigest)
    || typeof body.testPlanDigest !== "string" || !SHA256.test(body.testPlanDigest)
    || !Array.isArray(body.messages) || body.messages.length !== 2) invalid();
  const messages = body.messages.map((item, index) => {
    const message = object(item);
    if (typeof message.id !== "string" || !UUID.test(message.id)
      || message.sequence !== index + 1
      || (message.role !== "user" && message.role !== "assistant")
      || typeof message.text !== "string" || !message.text || message.text.length > 4_000
      || typeof message.createdAt !== "string" || !Number.isFinite(Date.parse(message.createdAt))) invalid();
    return Object.freeze({
      id: message.id,
      sequence: message.sequence as number,
      role: message.role,
      text: message.text,
      createdAt: new Date(message.createdAt).toISOString(),
    });
  });
  if (messages[0]!.role !== "user" || messages[0]!.text !== command.feedback
    || messages[1]!.role !== "assistant") invalid();
  return Object.freeze({
    tenantId: command.tenantId,
    projectId: command.projectId,
    conversationId: body.conversationId,
    revision: body.revision as number,
    state: "DRAFT",
    specRevisionId: body.specRevisionId,
    specDigest: body.specDigest,
    testPlanRevisionId: body.testPlanRevisionId,
    testPlanDigest: body.testPlanDigest,
    messages: Object.freeze(messages),
    result: parseSpecModelResult(body.result),
  });
}

function parseReceipt(value: unknown, command: UserFeedbackCommand): UserFeedbackReceipt {
  const body = object(value);
  const draft = parseDraft(body, command);
  const delivery = object(body.delivery);
  if (body.state !== "AWAITING_SPEC_APPROVAL"
    || delivery.actionId !== draft.actionId || delivery.workflowId !== draft.workflowId
    || delivery.signalId !== draft.signalId
    || typeof delivery.outboxId !== "string" || !UUID.test(delivery.outboxId)
    || typeof delivery.signalDigest !== "string" || !SHA256.test(delivery.signalDigest)
    || (delivery.state !== "PENDING_DELIVERY" && delivery.state !== "DELIVERED")
    || typeof delivery.replayed !== "boolean") invalid();
  return Object.freeze({
    ...draft,
    state: "AWAITING_SPEC_APPROVAL",
    delivery: Object.freeze({
      actionId: draft.actionId,
      outboxId: delivery.outboxId,
      workflowId: draft.workflowId,
      signalId: draft.signalId,
      signalDigest: delivery.signalDigest,
      state: delivery.state,
      replayed: delivery.replayed,
    }),
  });
}

function validateDraftDelivery(draft: UserFeedbackDraft, delivery: WorkflowActionCompletionReceipt): void {
  if (delivery.actionId !== draft.actionId || delivery.workflowId !== draft.workflowId
    || delivery.signalId !== draft.signalId || !UUID.test(delivery.outboxId)
    || !SHA256.test(delivery.signalDigest)) invalid();
}

function validateCommand(command: UserFeedbackCommand): void {
  if (!UUID.test(command.tenantId) || !UUID.test(command.projectId)
    || !SHA256.test(command.operationKey)) invalid();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function invalid(): never { throw new Error("User feedback authority is invalid"); }
