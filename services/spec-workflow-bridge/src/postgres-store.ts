import { createHash, randomUUID } from "node:crypto";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import {
  parseSpecWorkflowApprovalRequest,
  parseSpecWorkflowTargetMatrix,
  parseStoredSpecWorkflowRequest,
  specWorkflowEventKey,
  specWorkflowId,
  specWorkflowRequestDigest,
  type SpecWorkflowApprovalRequest,
  type SpecWorkflowEnqueueReceipt,
  type SpecWorkflowEvent,
  type SpecWorkflowPlatform,
} from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;

type AuthorityRow = {
  conversation_id: string;
  conversation_state: string;
  current_spec_revision_id: string;
  current_test_plan_revision_id: string;
  draft_spec_revision_id: string;
  draft_test_plan_revision_id: string;
  spec_digest: string;
  test_plan_digest: string;
  target_matrix: string[];
  required_godot_version: string;
  operation_state: string;
  operation_response: unknown;
};
type WorkflowRow = {
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  target_matrix: string[];
  temporal_run_id: string | null;
  state: "PENDING_START" | "ACTIVE" | "TERMINAL";
};
type EventRow = {
  event_key: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  conversation_id: string;
  event_type: "SPEC_READY" | "SPEC_APPROVED";
  request_digest: string;
  payload: unknown;
  state: "PENDING" | "CLAIMED" | "COMPLETED";
  claim_token: string | null;
  workflow_action_id: string | null;
  completion_outbox_id: string | null;
};
type ActionRow = { id: string; binding: unknown };

export interface SpecDeliveryWorkflow {
  readonly tenantId: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly targetMatrix: readonly SpecWorkflowPlatform[];
  readonly temporalRunId: string | null;
  readonly state: "PENDING_START" | "ACTIVE" | "TERMINAL";
}

/** Durable RLS store for approval-to-Temporal delivery. */
export class PostgresSpecWorkflowBridgeStore {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async enqueue(value: unknown): Promise<SpecWorkflowEnqueueReceipt> {
    const request = parseSpecWorkflowApprovalRequest(value);
    const workflowId = specWorkflowId(request.projectId);
    const readyEventKey = specWorkflowEventKey(request.operationKey, "SPEC_READY");
    const approvalEventKey = specWorkflowEventKey(request.operationKey, "SPEC_APPROVED");
    return this.#transaction(request.tenantId, async (client) => {
      await assertApprovalAuthority(client, request);
      const workflowInsert = await client.query(
        `INSERT INTO deviludo.spec_delivery_workflows
          (tenant_id, project_id, workflow_id, target_matrix)
         VALUES ($1::uuid, $2::uuid, $3, $4::text[])
         ON CONFLICT (tenant_id, project_id) DO NOTHING`,
        [request.tenantId, request.projectId, workflowId, request.targetMatrix],
      );
      const workflowResult = await client.query<WorkflowRow>(
        `SELECT tenant_id::text, project_id::text, workflow_id, target_matrix,
                temporal_run_id, state
           FROM deviludo.spec_delivery_workflows
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
          FOR UPDATE`,
        [request.tenantId, request.projectId],
      );
      const workflow = parseWorkflow(workflowResult.rows[0]);
      if (workflow.workflowId !== workflowId || !sameMatrix(workflow.targetMatrix, request.targetMatrix)
        || workflow.state === "TERMINAL") conflict();

      const readyDigest = eventDigest("SPEC_READY", request);
      const approvalDigest = eventDigest("SPEC_APPROVED", request);
      const readyInsert = workflowInsert.rowCount === 1
        ? await insertEvent(client, request, workflowId, readyEventKey, "SPEC_READY", readyDigest)
        : null;
      const approvalInsert = await insertEvent(client, request, workflowId, approvalEventKey, "SPEC_APPROVED", approvalDigest);
      const events = await client.query<EventRow>(
        `SELECT event_key, tenant_id::text, project_id::text, workflow_id,
                conversation_id::text, event_type, request_digest, payload,
                state, claim_token::text, workflow_action_id::text,
                completion_outbox_id::text
           FROM deviludo.spec_workflow_events
          WHERE tenant_id = $1::uuid AND event_key IN ($2, $3)
          ORDER BY event_type DESC
          FOR SHARE`,
        [request.tenantId, readyEventKey, approvalEventKey],
      );
      if (events.rows.length < 1 || events.rows.length > 2) invalid();
      const readyRow = events.rows.find((row) => row.event_key === readyEventKey);
      const ready = readyRow ? parseEventRow(readyRow) : null;
      const approval = parseEventRow(events.rows.find((row) => row.event_key === approvalEventKey));
      if (ready) assertEventBinding(ready, request, workflowId, "SPEC_READY", readyDigest);
      else if (workflow.state !== "ACTIVE") conflict();
      assertEventBinding(approval, request, workflowId, "SPEC_APPROVED", approvalDigest);
      return Object.freeze({
        workflowId,
        readyEventKey: ready ? readyEventKey : null,
        approvalEventKey,
        state: (!ready || ready.state === "COMPLETED") && approval.state === "COMPLETED" ? "DELIVERED" : "PENDING_DELIVERY",
        replayed: (readyInsert === null || readyInsert.rowCount === 0) && approvalInsert.rowCount === 0,
      });
    });
  }

  async workflow(tenantId: string, projectId: string): Promise<SpecDeliveryWorkflow> {
    return this.#transaction(tenantId, async (client) => {
      const selected = await client.query<WorkflowRow>(
        `SELECT tenant_id::text, project_id::text, workflow_id, target_matrix,
                temporal_run_id, state
           FROM deviludo.spec_delivery_workflows
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
          FOR SHARE`,
        [tenantId, projectId],
      );
      return parseWorkflow(selected.rows[0]);
    });
  }

  async markStarted(input: { tenantId: string; projectId: string; workflowId: string; temporalRunId: string }): Promise<SpecDeliveryWorkflow> {
    if (!UUID.test(input.tenantId) || !UUID.test(input.projectId)
      || input.workflowId !== specWorkflowId(input.projectId) || !SAFE_RUN_ID.test(input.temporalRunId)) invalid();
    return this.#transaction(input.tenantId, async (client) => {
      await client.query(
        `UPDATE deviludo.spec_delivery_workflows
            SET temporal_run_id = $4, state = 'ACTIVE', started_at = now()
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
            AND workflow_id = $3 AND state = 'PENDING_START'`,
        [input.tenantId, input.projectId, input.workflowId, input.temporalRunId],
      );
      const selected = await client.query<WorkflowRow>(
        `SELECT tenant_id::text, project_id::text, workflow_id, target_matrix,
                temporal_run_id, state
           FROM deviludo.spec_delivery_workflows
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
          FOR UPDATE`,
        [input.tenantId, input.projectId],
      );
      const workflow = parseWorkflow(selected.rows[0]);
      if (workflow.workflowId !== input.workflowId || workflow.temporalRunId !== input.temporalRunId
        || workflow.state !== "ACTIVE") conflict();
      return workflow;
    });
  }

  async claimNext(tenantId: string): Promise<SpecWorkflowEvent | null> {
    if (!UUID.test(tenantId)) invalid();
    const claimToken = randomUUID();
    return this.#transaction(tenantId, async (client) => {
      const selected = await client.query<EventRow>(
        `SELECT event.event_key, event.tenant_id::text, event.project_id::text,
                event.workflow_id, event.conversation_id::text, event.event_type,
                event.request_digest, event.payload, event.state,
                event.claim_token::text, event.workflow_action_id::text,
                event.completion_outbox_id::text
           FROM deviludo.spec_workflow_events event
          WHERE event.tenant_id = $1::uuid
            AND (event.state = 'PENDING'
              OR (event.state = 'CLAIMED' AND event.claim_expires_at <= now()))
            AND (event.event_type = 'SPEC_READY' OR (
              EXISTS (
                SELECT 1 FROM deviludo.spec_delivery_workflows workflow
                 WHERE workflow.tenant_id = event.tenant_id
                   AND workflow.project_id = event.project_id
                   AND workflow.workflow_id = event.workflow_id
                   AND workflow.state = 'ACTIVE'
              ) AND (
                NOT EXISTS (
                  SELECT 1 FROM deviludo.spec_workflow_events ready
                   WHERE ready.tenant_id = event.tenant_id
                     AND ready.project_id = event.project_id
                     AND ready.event_type = 'SPEC_READY'
                     AND ready.payload->>'operationKey' = event.payload->>'operationKey'
                ) OR EXISTS (
                  SELECT 1 FROM deviludo.spec_workflow_events ready
                   WHERE ready.tenant_id = event.tenant_id
                     AND ready.project_id = event.project_id
                     AND ready.event_type = 'SPEC_READY'
                     AND ready.state = 'COMPLETED'
                     AND ready.payload->>'operationKey' = event.payload->>'operationKey'
                )
              )
            ))
          ORDER BY event.created_at ASC,
                   CASE event.event_type WHEN 'SPEC_READY' THEN 0 ELSE 1 END ASC
          LIMIT 1 FOR UPDATE OF event SKIP LOCKED`,
        [tenantId],
      );
      if (selected.rows.length === 0) return null;
      const event = parseEventRow(selected.rows[0]);
      const claimed = await client.query(
        `UPDATE deviludo.spec_workflow_events
            SET state = 'CLAIMED', claim_token = $3::uuid,
                claim_expires_at = now() + interval '2 minutes'
          WHERE tenant_id = $1::uuid AND event_key = $2
            AND (state = 'PENDING' OR claim_expires_at <= now())
        RETURNING event_key`,
        [tenantId, event.eventKey, claimToken],
      );
      if (claimed.rowCount !== 1) return null;
      return Object.freeze({ ...event, claimToken });
    });
  }

  async findWaitingAction(event: SpecWorkflowEvent): Promise<string | null> {
    validateClaim(event);
    return this.#transaction(event.tenantId, async (client) => {
      const operation = event.eventType === "SPEC_READY" ? "CONTINUE_IDEA_DIALOGUE" : "REQUEST_SPEC_APPROVAL";
      const selected = await client.query<ActionRow>(
        `SELECT id::text, binding
           FROM deviludo.workflow_control_actions
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
            AND workflow_id = $3 AND operation = $4 AND status = 'WAITING'
          ORDER BY created_at DESC LIMIT 1 FOR SHARE`,
        [event.tenantId, event.projectId, event.workflowId, operation],
      );
      if (selected.rows.length === 0) return null;
      if (selected.rows.length !== 1 || !UUID.test(selected.rows[0]!.id)) invalid();
      const binding = record(selected.rows[0]!.binding);
      if (event.eventType === "SPEC_READY") {
        if (binding.state !== "IDEATION" || binding.specRevisionId !== null) conflict();
      } else if (binding.state !== "WAITING_SPEC_APPROVAL"
        || binding.specRevisionId !== event.payload.draftSpecRevisionId) conflict();
      return selected.rows[0]!.id;
    });
  }

  async completeEvent(event: SpecWorkflowEvent, actionId: string, outboxId: string): Promise<void> {
    validateClaim(event);
    if (!UUID.test(actionId) || !UUID.test(outboxId)) invalid();
    await this.#transaction(event.tenantId, async (client) => {
      const completed = await client.query(
        `UPDATE deviludo.spec_workflow_events
            SET state = 'COMPLETED', claim_token = NULL, claim_expires_at = NULL,
                workflow_action_id = $4::uuid, completion_outbox_id = $5::uuid,
                completed_at = now()
          WHERE tenant_id = $1::uuid AND event_key = $2
            AND state = 'CLAIMED' AND claim_token = $3::uuid
        RETURNING event_key`,
        [event.tenantId, event.eventKey, event.claimToken, actionId, outboxId],
      );
      if (completed.rowCount !== 1) conflict();
    });
  }

  async release(event: SpecWorkflowEvent): Promise<void> {
    validateClaim(event);
    await this.#transaction(event.tenantId, async (client) => {
      await client.query(
        `UPDATE deviludo.spec_workflow_events
            SET state = 'PENDING', claim_token = NULL, claim_expires_at = NULL
          WHERE tenant_id = $1::uuid AND event_key = $2
            AND state = 'CLAIMED' AND claim_token = $3::uuid`,
        [event.tenantId, event.eventKey, event.claimToken],
      );
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT to_regclass('deviludo.spec_conversations')::text AS spec_conversations,
                to_regclass('deviludo.immutable_revisions')::text AS immutable_revisions,
                to_regclass('deviludo.approved_test_plan_bindings')::text AS approved_test_plan_bindings,
                to_regclass('deviludo.spec_dialogue_operations')::text AS spec_dialogue_operations,
                to_regclass('deviludo.spec_delivery_workflows')::text AS spec_delivery_workflows,
                to_regclass('deviludo.spec_workflow_events')::text AS spec_workflow_events,
                to_regclass('deviludo.workflow_control_actions')::text AS workflow_control_actions,
                to_regclass('deviludo.workflow_signal_outbox')::text AS workflow_signal_outbox`,
      );
      const row = result.rows[0];
      for (const table of [
        "spec_conversations", "immutable_revisions", "approved_test_plan_bindings", "spec_dialogue_operations",
        "spec_delivery_workflows", "spec_workflow_events", "workflow_control_actions", "workflow_signal_outbox",
      ]) {
        if (row?.[table] !== `deviludo.${table}`) conflict();
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

async function assertApprovalAuthority(client: PostgresWorkflowClient, request: SpecWorkflowApprovalRequest): Promise<void> {
  const selected = await client.query<AuthorityRow>(
    `SELECT conversation.id::text AS conversation_id,
            conversation.state AS conversation_state,
            conversation.current_spec_revision_id::text,
            conversation.current_test_plan_revision_id::text,
            spec.previous_revision_id::text AS draft_spec_revision_id,
            plan.previous_revision_id::text AS draft_test_plan_revision_id,
            spec.payload_digest AS spec_digest,
            plan.payload_digest AS test_plan_digest,
            binding.target_matrix,
            binding.required_godot_version,
            operation.state AS operation_state,
            operation.response AS operation_response
       FROM deviludo.spec_conversations conversation
       JOIN deviludo.immutable_revisions spec
         ON spec.id = conversation.current_spec_revision_id
        AND spec.tenant_id = conversation.tenant_id
        AND spec.project_id = conversation.project_id
        AND spec.aggregate_type = 'GAME_SPEC' AND spec.state = 'APPROVED'
       JOIN deviludo.immutable_revisions plan
         ON plan.id = conversation.current_test_plan_revision_id
        AND plan.tenant_id = conversation.tenant_id
        AND plan.project_id = conversation.project_id
        AND plan.aggregate_type = 'TEST_PLAN' AND plan.state = 'FROZEN'
       JOIN deviludo.approved_test_plan_bindings binding
         ON binding.tenant_id = conversation.tenant_id
        AND binding.project_id = conversation.project_id
        AND binding.spec_revision_id = spec.id
        AND binding.test_plan_revision_id = plan.id
       JOIN deviludo.spec_dialogue_operations operation
         ON operation.operation_key = $4
        AND operation.tenant_id = conversation.tenant_id
        AND operation.project_id = conversation.project_id
        AND operation.conversation_id = conversation.id
      WHERE conversation.tenant_id = $1::uuid
        AND conversation.project_id = $2::uuid
        AND conversation.id = $3::uuid
      FOR SHARE OF conversation, spec, plan, binding, operation`,
    [request.tenantId, request.projectId, request.conversationId, request.operationKey],
  );
  if (selected.rows.length !== 1) conflict();
  const row = selected.rows[0]!;
  const response = record(row.operation_response);
  if (row.conversation_id !== request.conversationId || row.conversation_state !== "APPROVED"
    || row.current_spec_revision_id !== request.approvedSpecRevisionId
    || row.current_test_plan_revision_id !== request.approvedTestPlanRevisionId
    || row.draft_spec_revision_id !== request.draftSpecRevisionId
    || row.draft_test_plan_revision_id !== request.draftTestPlanRevisionId
    || row.spec_digest !== request.approvedSpecDigest
    || row.test_plan_digest !== request.approvedTestPlanDigest
    || !sameMatrix(row.target_matrix, request.targetMatrix)
    || row.required_godot_version !== request.godotVersion
    || row.operation_state !== "COMPLETED"
    || response.operationKey !== request.operationKey
    || response.specRevisionId !== request.approvedSpecRevisionId
    || response.testPlanRevisionId !== request.approvedTestPlanRevisionId
    || response.specDigest !== request.approvedSpecDigest
    || response.testPlanDigest !== request.approvedTestPlanDigest) conflict();
}

async function insertEvent(
  client: PostgresWorkflowClient,
  request: SpecWorkflowApprovalRequest,
  workflowId: string,
  eventKey: string,
  eventType: SpecWorkflowEvent["eventType"],
  requestDigest: string,
) {
  return client.query(
    `INSERT INTO deviludo.spec_workflow_events
      (event_key, tenant_id, project_id, workflow_id, conversation_id,
       event_type, request_digest, payload)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::jsonb)
     ON CONFLICT (tenant_id, event_key) DO NOTHING`,
    [eventKey, request.tenantId, request.projectId, workflowId,
      request.conversationId, eventType, requestDigest, JSON.stringify(request)],
  );
}

function parseWorkflow(row: WorkflowRow | undefined): SpecDeliveryWorkflow {
  if (!row || !UUID.test(row.tenant_id) || !UUID.test(row.project_id)
    || row.workflow_id !== specWorkflowId(row.project_id)
    || !["PENDING_START", "ACTIVE", "TERMINAL"].includes(row.state)
    || (row.state === "PENDING_START") !== (row.temporal_run_id === null)
    || (row.temporal_run_id !== null && !SAFE_RUN_ID.test(row.temporal_run_id))) invalid();
  const targetMatrix = parseSpecWorkflowTargetMatrix(row.target_matrix);
  return Object.freeze({
    tenantId: row.tenant_id, projectId: row.project_id, workflowId: row.workflow_id,
    targetMatrix, temporalRunId: row.temporal_run_id, state: row.state,
  });
}

function parseEventRow(row: EventRow | undefined): Omit<SpecWorkflowEvent, "claimToken"> & { readonly state: EventRow["state"] } {
  if (!row || !SHA256.test(row.event_key) || !UUID.test(row.tenant_id) || !UUID.test(row.project_id)
    || row.workflow_id !== specWorkflowId(row.project_id) || !UUID.test(row.conversation_id)
    || (row.event_type !== "SPEC_READY" && row.event_type !== "SPEC_APPROVED")
    || !SHA256.test(row.request_digest) || !["PENDING", "CLAIMED", "COMPLETED"].includes(row.state)) invalid();
  return Object.freeze({
    eventKey: row.event_key, tenantId: row.tenant_id, projectId: row.project_id,
    workflowId: row.workflow_id, conversationId: row.conversation_id,
    eventType: row.event_type, requestDigest: row.request_digest,
    payload: parseStoredSpecWorkflowRequest(row.payload), state: row.state,
  });
}

function assertEventBinding(
  event: ReturnType<typeof parseEventRow>, request: SpecWorkflowApprovalRequest,
  workflowId: string, eventType: SpecWorkflowEvent["eventType"], requestDigest: string,
): void {
  if (event.tenantId !== request.tenantId || event.projectId !== request.projectId
    || event.workflowId !== workflowId || event.conversationId !== request.conversationId
    || event.eventType !== eventType || event.requestDigest !== requestDigest
    || specWorkflowRequestDigest(event.payload) !== specWorkflowRequestDigest(request)) conflict();
}

function validateClaim(event: SpecWorkflowEvent): void {
  if (!UUID.test(event.tenantId) || !UUID.test(event.projectId) || !UUID.test(event.conversationId)
    || !UUID.test(event.claimToken) || !SHA256.test(event.eventKey)
    || !SHA256.test(event.requestDigest) || event.workflowId !== specWorkflowId(event.projectId)
    || event.payload.tenantId !== event.tenantId || event.payload.projectId !== event.projectId
    || event.payload.conversationId !== event.conversationId) invalid();
}

function eventDigest(type: SpecWorkflowEvent["eventType"], request: SpecWorkflowApprovalRequest): string {
  return createHash("sha256").update(`${type}\0${specWorkflowRequestDigest(request)}`).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return record(JSON.parse(value) as unknown); } catch { invalid(); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function sameMatrix(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invalid(): never { throw new Error("Specification workflow PostgreSQL binding is invalid"); }
function conflict(): never { throw new Error("Specification workflow authority conflicts with persisted state"); }
