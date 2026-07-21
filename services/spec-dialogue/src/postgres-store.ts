import { randomUUID } from "node:crypto";
import { parseRunnerToolchainRevision } from "../../../lib/domain/runner-toolchain";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { parseSpecModelResult, type SpecApprovalCommand, type SpecApprovalReceipt, type SpecDialogueMessage, type SpecDialogueSnapshot, type SpecModelResult } from "./contracts";
import {
  canonicalSpecJson,
  specDigest,
  SpecDialogueStore,
  SpecDialogueToolchainUnavailable,
  type SpecDialogueClaim,
  type SpecDialogueClaimResult,
} from "./store";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

type ConversationRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  spec_aggregate_id: string;
  test_plan_aggregate_id: string;
  current_spec_revision_id: string | null;
  current_test_plan_revision_id: string | null;
  current_metadata: unknown | null;
  version: string | number;
  state: string;
};
type OperationRow = {
  request_digest: string;
  state: string;
  claim_token: string | null;
  claim_active: boolean;
  response: unknown | null;
};
type MessageRow = {
  id: string;
  sequence: string | number;
  role: string;
  content: string;
  created_at: string | Date;
};
type RevisionRow = {
  id: string;
  project_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  revision: string | number;
  state: string;
  payload: unknown;
  payload_digest: string;
};
type RunnerToolchainRow = {
  id: string;
  revision: string | number;
  payload: unknown;
  payload_digest: string;
};

export class PostgresSpecDialogueStore extends SpecDialogueStore {
  constructor(private readonly pool: PostgresWorkflowPool) { super(); }

  async begin(command: SpecDialogueClaim["command"]): Promise<SpecDialogueClaimResult> {
    validateUuidBindings(command);
    const requestDigest = specDigest({
      tenantId: command.tenantId,
      projectId: command.projectId,
      conversationId: command.conversationId,
      actorId: command.actorId,
      expectedRevision: command.expectedRevision,
      message: command.message,
    });
    const claimToken = randomUUID();
    return this.#transaction(command.tenantId, async (client) => {
      await authorizeProjectWriter(client, command.tenantId, command.projectId, command.actorId);
      if (command.expectedRevision === 0) {
        await client.query(
          `INSERT INTO deviludo.spec_conversations
            (id, tenant_id, project_id, created_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
           ON CONFLICT (id) DO NOTHING`,
          [command.conversationId, command.tenantId, command.projectId, command.actorId],
        );
      }
      const selectedConversation = await client.query<ConversationRow>(conversationSelect(true), [command.tenantId, command.projectId, command.conversationId]);
      if (selectedConversation.rows.length !== 1) return Object.freeze({ kind: "CONFLICT" as const });
      const conversation = parseConversation(selectedConversation.rows[0]!);
      if (conversation.state !== "DRAFT") return Object.freeze({ kind: "CONFLICT" as const });

      await client.query(
        `INSERT INTO deviludo.spec_dialogue_operations
          (operation_key, tenant_id, project_id, conversation_id, actor_id,
           expected_revision, request_digest, state, claim_token, claim_expires_at)
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
                 'CLAIMED', $8::uuid, now() + interval '2 minutes')
         ON CONFLICT (operation_key) DO NOTHING`,
        [command.operationKey, command.tenantId, command.projectId, command.conversationId,
          command.actorId, command.expectedRevision, requestDigest, claimToken],
      );
      const selectedOperation = await client.query<OperationRow>(
        `SELECT request_digest, state, claim_token::text,
                COALESCE(claim_expires_at > now(), false) AS claim_active,
                response
           FROM deviludo.spec_dialogue_operations
          WHERE operation_key = $1 AND tenant_id = $2::uuid
          FOR UPDATE`,
        [command.operationKey, command.tenantId],
      );
      if (selectedOperation.rows.length !== 1) invalid();
      const operation = selectedOperation.rows[0]!;
      if (operation.request_digest !== requestDigest) return Object.freeze({ kind: "CONFLICT" as const });
      if (operation.state === "COMPLETED") {
        return Object.freeze({ kind: "REPLAY" as const, snapshot: parseStoredSnapshot(operation.response, command) });
      }
      if (operation.state !== "CLAIMED") invalid();
      let ownedToken = operation.claim_token;
      if (ownedToken !== claimToken) {
        if (operation.claim_active) return Object.freeze({ kind: "BUSY" as const });
        const reclaimed = await client.query<{ claim_token: string }>(
          `UPDATE deviludo.spec_dialogue_operations
              SET claim_token = $3::uuid, claim_expires_at = now() + interval '2 minutes'
            WHERE operation_key = $1 AND tenant_id = $2::uuid
              AND state = 'CLAIMED' AND claim_expires_at <= now()
          RETURNING claim_token::text`,
          [command.operationKey, command.tenantId, claimToken],
        );
        if (reclaimed.rows.length !== 1) return Object.freeze({ kind: "BUSY" as const });
        ownedToken = reclaimed.rows[0]!.claim_token;
      }
      if (conversation.version !== command.expectedRevision) return Object.freeze({ kind: "CONFLICT" as const });
      const history = await readMessages(client, command.tenantId, command.conversationId);
      const current = await readCurrentResult(client, conversation);
      return Object.freeze({
        kind: "ACQUIRED" as const,
        claim: Object.freeze({ claimToken: ownedToken!, command, history, current }),
      });
    });
  }

  async complete(claim: SpecDialogueClaim, value: SpecModelResult): Promise<SpecDialogueSnapshot> {
    validateUuidBindings(claim.command);
    const result = parseSpecModelResult(value);
    return this.#transaction(claim.command.tenantId, async (client) => {
      const selectedOperation = await client.query<OperationRow>(
        `SELECT request_digest, state, claim_token::text,
                COALESCE(claim_expires_at > now(), false) AS claim_active,
                response
           FROM deviludo.spec_dialogue_operations
          WHERE operation_key = $1 AND tenant_id = $2::uuid
          FOR UPDATE`,
        [claim.command.operationKey, claim.command.tenantId],
      );
      if (selectedOperation.rows.length !== 1) invalid();
      const operation = selectedOperation.rows[0]!;
      if (operation.state === "COMPLETED") return parseStoredSnapshot(operation.response, claim.command);
      if (operation.state !== "CLAIMED" || operation.claim_token !== claim.claimToken || !operation.claim_active) invalid();
      const selectedConversation = await client.query<ConversationRow>(conversationSelect(true), [claim.command.tenantId, claim.command.projectId, claim.command.conversationId]);
      if (selectedConversation.rows.length !== 1) invalid();
      const conversation = parseConversation(selectedConversation.rows[0]!);
      if (conversation.state !== "DRAFT" || conversation.version !== claim.command.expectedRevision) invalid();
      const revision = conversation.version + 1;
      const specRevisionId = randomUUID();
      const testPlanRevisionId = randomUUID();
      const specPayload = Object.freeze({ schemaVersion: "deviludo.game-spec.v1", conversationId: claim.command.conversationId, revision, spec: result.spec });
      const testPlanPayload = Object.freeze({ schemaVersion: "deviludo.test-plan.v1", conversationId: claim.command.conversationId, revision, testPlan: result.testPlan });
      const specPayloadDigest = specDigest(specPayload);
      const testPlanPayloadDigest = specDigest(testPlanPayload);
      await insertRevision(client, {
        id: specRevisionId, tenantId: claim.command.tenantId, projectId: claim.command.projectId,
        aggregateType: "GAME_SPEC", aggregateId: conversation.specAggregateId, revision,
        payload: specPayload, payloadDigest: specPayloadDigest,
        previousRevisionId: conversation.currentSpecRevisionId, createdBy: claim.command.actorId,
      });
      await insertRevision(client, {
        id: testPlanRevisionId, tenantId: claim.command.tenantId, projectId: claim.command.projectId,
        aggregateType: "TEST_PLAN", aggregateId: conversation.testPlanAggregateId, revision,
        payload: testPlanPayload, payloadDigest: testPlanPayloadDigest,
        previousRevisionId: conversation.currentTestPlanRevisionId, createdBy: claim.command.actorId,
      });
      // Feedback iterations inherit the aggregate revision but begin a fresh
      // conversation, so message sequence is conversation-local rather than
      // derived from the aggregate revision number.
      const sequence = claim.history.length + 1;
      const insertedMessages = await client.query(
        `INSERT INTO deviludo.spec_conversation_messages
          (tenant_id, project_id, conversation_id, operation_key, sequence,
           role, content, content_digest, created_by)
         VALUES
          ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'user', $6, $7, $8),
          ($1::uuid, $2::uuid, $3::uuid, $4, $9, 'assistant', $10, $11, 'spec-model-broker')`,
        [claim.command.tenantId, claim.command.projectId, claim.command.conversationId,
          claim.command.operationKey, sequence, claim.command.message, specDigest(claim.command.message),
          claim.command.actorId, sequence + 1, result.assistantMessage, specDigest(result.assistantMessage)],
      );
      if (insertedMessages.rowCount !== 2) invalid();
      const metadata = { assistantMessage: result.assistantMessage, completeness: result.completeness, openQuestions: result.openQuestions };
      const updated = await client.query(
        `UPDATE deviludo.spec_conversations
            SET current_spec_revision_id = $4::uuid,
                current_test_plan_revision_id = $5::uuid,
                current_metadata = $6::jsonb,
                version = version + 1, updated_at = now()
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
            AND state = 'DRAFT' AND version = $7`,
        [claim.command.tenantId, claim.command.projectId, claim.command.conversationId,
          specRevisionId, testPlanRevisionId, JSON.stringify(metadata), claim.command.expectedRevision],
      );
      if (updated.rowCount !== 1) invalid();
      const messages = await readMessages(client, claim.command.tenantId, claim.command.conversationId);
      const snapshot: SpecDialogueSnapshot = Object.freeze({
        tenantId: claim.command.tenantId,
        projectId: claim.command.projectId,
        conversationId: claim.command.conversationId,
        revision,
        state: "DRAFT",
        specRevisionId,
        specDigest: specPayloadDigest,
        testPlanRevisionId,
        testPlanDigest: testPlanPayloadDigest,
        messages,
        result,
      });
      const completed = await client.query(
        `UPDATE deviludo.spec_dialogue_operations
            SET state = 'COMPLETED', claim_token = NULL, claim_expires_at = NULL,
                response = $4::jsonb, completed_at = now()
          WHERE operation_key = $1 AND tenant_id = $2::uuid
            AND state = 'CLAIMED' AND claim_token = $3::uuid`,
        [claim.command.operationKey, claim.command.tenantId, claim.claimToken, JSON.stringify(snapshot)],
      );
      if (completed.rowCount !== 1) invalid();
      return snapshot;
    });
  }

  async release(claim: SpecDialogueClaim): Promise<void> {
    await this.#transaction(claim.command.tenantId, async (client) => {
      await client.query(
        `UPDATE deviludo.spec_dialogue_operations
            SET claim_expires_at = now()
          WHERE operation_key = $1 AND tenant_id = $2::uuid
            AND state = 'CLAIMED' AND claim_token = $3::uuid`,
        [claim.command.operationKey, claim.command.tenantId, claim.claimToken],
      );
    });
  }

  async approve(command: SpecApprovalCommand): Promise<SpecApprovalReceipt> {
    validateUuidBindings(command);
    if (!UUID.test(command.specRevisionId) || !UUID.test(command.testPlanRevisionId)) invalid();
    const requestDigest = specDigest(command);
    const claimToken = randomUUID();
    return this.#transaction(command.tenantId, async (client) => {
      await authorizeProjectWriter(client, command.tenantId, command.projectId, command.actorId);
      await client.query(
        `INSERT INTO deviludo.spec_dialogue_operations
          (operation_key, tenant_id, project_id, conversation_id, actor_id,
           expected_revision, request_digest, state, claim_token, claim_expires_at)
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
                 'CLAIMED', $8::uuid, now() + interval '2 minutes')
         ON CONFLICT (operation_key) DO NOTHING`,
        [command.operationKey, command.tenantId, command.projectId, command.conversationId,
          command.actorId, command.expectedRevision, requestDigest, claimToken],
      );
      const selectedOperation = await client.query<OperationRow>(
        `SELECT request_digest, state, claim_token::text,
                COALESCE(claim_expires_at > now(), false) AS claim_active,
                response
           FROM deviludo.spec_dialogue_operations
          WHERE operation_key = $1 AND tenant_id = $2::uuid
          FOR UPDATE`,
        [command.operationKey, command.tenantId],
      );
      if (selectedOperation.rows.length !== 1) invalid();
      const operation = selectedOperation.rows[0]!;
      if (operation.request_digest !== requestDigest) invalid();
      if (operation.state === "COMPLETED") return parseStoredApproval(operation.response, command);
      if (operation.state !== "CLAIMED" || operation.claim_token !== claimToken || !operation.claim_active) invalid();
      const selectedConversation = await client.query<ConversationRow>(conversationSelect(true), [command.tenantId, command.projectId, command.conversationId]);
      if (selectedConversation.rows.length !== 1) invalid();
      const conversation = parseConversation(selectedConversation.rows[0]!);
      if (conversation.state !== "DRAFT" || conversation.version !== command.expectedRevision
        || conversation.currentSpecRevisionId !== command.specRevisionId
        || conversation.currentTestPlanRevisionId !== command.testPlanRevisionId) invalid();
      const current = await readCurrentResult(client, conversation);
      if (!current) invalid();
      const toolchain = await resolveRunnerToolchain(client, {
        tenantId: command.tenantId,
        projectId: command.projectId,
        godotVersion: current.spec.godotVersion,
        targetMatrix: current.spec.targetPlatforms,
      });
      const revision = conversation.version + 1;
      const specRevisionId = randomUUID();
      const testPlanRevisionId = randomUUID();
      const specPayload = Object.freeze({ schemaVersion: "deviludo.game-spec.v1", conversationId: command.conversationId, revision, spec: current.spec });
      const testPlanPayload = Object.freeze({ schemaVersion: "deviludo.test-plan.v1", conversationId: command.conversationId, revision, testPlan: current.testPlan });
      const specPayloadDigest = specDigest(specPayload);
      const testPlanPayloadDigest = specDigest(testPlanPayload);
      await insertRevision(client, {
        id: specRevisionId, tenantId: command.tenantId, projectId: command.projectId,
        aggregateType: "GAME_SPEC", aggregateId: conversation.specAggregateId, revision,
        state: "APPROVED", payload: specPayload, payloadDigest: specPayloadDigest,
        previousRevisionId: command.specRevisionId, createdBy: command.actorId,
      });
      await insertRevision(client, {
        id: testPlanRevisionId, tenantId: command.tenantId, projectId: command.projectId,
        aggregateType: "TEST_PLAN", aggregateId: conversation.testPlanAggregateId, revision,
        state: "FROZEN", payload: testPlanPayload, payloadDigest: testPlanPayloadDigest,
        previousRevisionId: command.testPlanRevisionId, createdBy: command.actorId,
      });
      const bound = await client.query(
        `INSERT INTO deviludo.approved_test_plan_bindings
          (tenant_id, project_id, spec_revision_id, test_plan_revision_id,
           test_plan_digest, target_matrix, required_godot_version,
           runner_toolchain_revision_id, runner_toolchain_digest,
           approved_by, approved_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::text[], $7,
                 $8::uuid, $9, $10, now())`,
        [command.tenantId, command.projectId, specRevisionId, testPlanRevisionId,
          testPlanPayloadDigest, current.spec.targetPlatforms, current.spec.godotVersion,
          toolchain.id, toolchain.digest, command.actorId],
      );
      if (bound.rowCount !== 1) invalid();
      const updated = await client.query<{ updated_at: string | Date }>(
        `UPDATE deviludo.spec_conversations
            SET current_spec_revision_id = $4::uuid,
                current_test_plan_revision_id = $5::uuid,
                version = version + 1, state = 'APPROVED', updated_at = now()
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
            AND state = 'DRAFT' AND version = $6
        RETURNING updated_at`,
        [command.tenantId, command.projectId, command.conversationId, specRevisionId, testPlanRevisionId, command.expectedRevision],
      );
      if (updated.rows.length !== 1) invalid();
      const approvedAt = new Date(updated.rows[0]!.updated_at);
      if (!Number.isFinite(approvedAt.getTime())) invalid();
      const receipt: SpecApprovalReceipt = Object.freeze({
        operationKey: command.operationKey, tenantId: command.tenantId, projectId: command.projectId,
        conversationId: command.conversationId, revision, state: "APPROVED",
        specRevisionId, specDigest: specPayloadDigest, testPlanRevisionId,
        testPlanDigest: testPlanPayloadDigest,
        targetMatrix: Object.freeze([...current.spec.targetPlatforms]),
        godotVersion: current.spec.godotVersion, approvedAt: approvedAt.toISOString(),
      });
      const completed = await client.query(
        `UPDATE deviludo.spec_dialogue_operations
            SET state = 'COMPLETED', claim_token = NULL, claim_expires_at = NULL,
                response = $4::jsonb, completed_at = now()
          WHERE operation_key = $1 AND tenant_id = $2::uuid
            AND state = 'CLAIMED' AND claim_token = $3::uuid`,
        [command.operationKey, command.tenantId, claimToken, JSON.stringify(receipt)],
      );
      if (completed.rowCount !== 1) invalid();
      return receipt;
    });
  }

  async read(input: { tenantId: string; projectId: string; conversationId: string }): Promise<SpecDialogueSnapshot | null> {
    validateUuidBindings(input);
    return this.#transaction(input.tenantId, async (client) => {
      const selected = await client.query<ConversationRow>(conversationSelect(false), [input.tenantId, input.projectId, input.conversationId]);
      if (selected.rows.length === 0) return null;
      if (selected.rows.length !== 1) invalid();
      const conversation = parseConversation(selected.rows[0]!);
      const messages = await readMessages(client, input.tenantId, input.conversationId);
      const result = await readCurrentResult(client, conversation);
      if (conversation.version === 0) return Object.freeze({
        ...input, revision: 0, state: "DRAFT", specRevisionId: null, specDigest: null,
        testPlanRevisionId: null, testPlanDigest: null, messages, result: null,
      });
      const revisions = await readRevisionPair(client, conversation);
      return Object.freeze({
        ...input, revision: conversation.version,
        state: conversation.state === "APPROVED" ? "APPROVED" : "DRAFT",
        specRevisionId: revisions.spec.id, specDigest: revisions.spec.payload_digest,
        testPlanRevisionId: revisions.plan.id, testPlanDigest: revisions.plan.payload_digest,
        messages, result,
      });
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query("SELECT 1 AS spec_dialogue_store_probe"); }
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

async function authorizeProjectWriter(
  client: PostgresWorkflowClient,
  tenantId: string,
  projectId: string,
  actorId: string,
): Promise<void> {
  const authorized = await client.query<{ id: string }>(
    `SELECT project.id::text
       FROM deviludo.projects project
       JOIN deviludo.users actor
         ON actor.tenant_id = project.tenant_id
        AND actor.id::text = $3 AND actor.status = 'ACTIVE'
       JOIN deviludo.tenant_memberships membership
         ON membership.tenant_id = actor.tenant_id
        AND membership.user_id = actor.id
        AND membership.status = 'ACTIVE'
        AND membership.role IN ('TenantAdmin', 'ProjectOwner')
      WHERE project.tenant_id = $1::uuid AND project.id = $2::uuid
      FOR SHARE OF project, actor, membership`,
    [tenantId, projectId, actorId],
  );
  if (authorized.rows.length !== 1 || authorized.rows[0]!.id !== projectId) invalid();
}

function conversationSelect(lock: boolean): string {
  return `SELECT id::text, tenant_id::text, project_id::text,
                 spec_aggregate_id::text, test_plan_aggregate_id::text,
                 current_spec_revision_id::text, current_test_plan_revision_id::text,
                 current_metadata, version, state
            FROM deviludo.spec_conversations
           WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid${lock ? " FOR UPDATE" : " FOR SHARE"}`;
}

function parseConversation(row: ConversationRow) {
  const version = Number(row.version);
  if (!UUID.test(row.id) || !UUID.test(row.tenant_id) || !UUID.test(row.project_id)
    || !UUID.test(row.spec_aggregate_id) || !UUID.test(row.test_plan_aggregate_id)
    || !Number.isSafeInteger(version) || version < 0
    || !["DRAFT", "APPROVED", "SUPERSEDED"].includes(row.state)) invalid();
  if ((version === 0) !== (row.current_spec_revision_id === null && row.current_test_plan_revision_id === null)) invalid();
  if (version > 0 && (!row.current_spec_revision_id || !UUID.test(row.current_spec_revision_id)
    || !row.current_test_plan_revision_id || !UUID.test(row.current_test_plan_revision_id))) invalid();
  return Object.freeze({
    id: row.id, tenantId: row.tenant_id, projectId: row.project_id,
    specAggregateId: row.spec_aggregate_id, testPlanAggregateId: row.test_plan_aggregate_id,
    currentSpecRevisionId: row.current_spec_revision_id, currentTestPlanRevisionId: row.current_test_plan_revision_id,
    currentMetadata: row.current_metadata, version, state: row.state,
  });
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
    if (!UUID.test(row.id) || sequence !== index + 1 || (row.role !== "user" && row.role !== "assistant")
      || typeof row.content !== "string" || row.content.length < 1 || row.content.length > 4_000
      || !Number.isFinite(createdAt.getTime())) invalid();
    return Object.freeze({ id: row.id, sequence, role: row.role, text: row.content, createdAt: createdAt.toISOString() });
  }));
}

async function readCurrentResult(client: PostgresWorkflowClient, conversation: ReturnType<typeof parseConversation>): Promise<SpecModelResult | null> {
  if (conversation.version === 0) return null;
  const revisions = await readRevisionPair(client, conversation);
  if (specDigest(revisions.spec.payload) !== revisions.spec.payload_digest || specDigest(revisions.plan.payload) !== revisions.plan.payload_digest) invalid();
  const specWrapper = object(revisions.spec.payload);
  const planWrapper = object(revisions.plan.payload);
  const metadata = object(conversation.currentMetadata);
  return parseSpecModelResult({
    assistantMessage: metadata.assistantMessage,
    completeness: metadata.completeness,
    openQuestions: metadata.openQuestions,
    spec: specWrapper.spec,
    testPlan: planWrapper.testPlan,
  });
}

async function resolveRunnerToolchain(
  client: PostgresWorkflowClient,
  input: Readonly<{
    tenantId: string;
    projectId: string;
    godotVersion: string;
    targetMatrix: SpecModelResult["spec"]["targetPlatforms"];
  }>,
): Promise<Readonly<{ id: string; digest: string }>> {
  const selected = await client.query<RunnerToolchainRow>(
    `SELECT id::text, revision, payload, payload_digest
       FROM deviludo.runner_toolchain_revisions
      WHERE tenant_id = $1::uuid
        AND project_id = $2::uuid
        AND payload->>'schemaVersion' = 'deviludo.runner-toolchain.v1'
        AND payload->>'requiredGodotVersion' = $3
        AND jsonb_typeof(payload->'exportTemplates') = 'object'
        AND (SELECT array_agg(key ORDER BY key)
               FROM jsonb_object_keys(payload->'exportTemplates') AS template_keys(key)) = $4::text[]
      ORDER BY revision DESC
      LIMIT 1
      FOR SHARE`,
    [input.tenantId, input.projectId, input.godotVersion, input.targetMatrix],
  );
  if (selected.rows.length === 0) throw new SpecDialogueToolchainUnavailable();
  if (selected.rows.length !== 1) invalid();
  const row = selected.rows[0]!;
  const revision = Number(row.revision);
  if (!UUID.test(row.id) || !Number.isSafeInteger(revision) || revision < 1
    || !SHA256.test(row.payload_digest) || specDigest(row.payload) !== row.payload_digest) invalid();
  const payload = parseRunnerToolchainRevision(row.payload, input.targetMatrix);
  if (payload.requiredGodotVersion !== input.godotVersion) invalid();
  return Object.freeze({ id: row.id, digest: row.payload_digest });
}

async function readRevisionPair(client: PostgresWorkflowClient, conversation: ReturnType<typeof parseConversation>) {
  const selected = await client.query<RevisionRow>(
    `SELECT id::text, project_id::text, aggregate_type,
            aggregate_id::text, revision, state, payload, payload_digest
       FROM deviludo.immutable_revisions
      WHERE tenant_id = $1::uuid AND id IN ($2::uuid, $3::uuid)
      FOR SHARE`,
    [conversation.tenantId, conversation.currentSpecRevisionId, conversation.currentTestPlanRevisionId],
  );
  const spec = selected.rows.find((row) => row.id === conversation.currentSpecRevisionId);
  const plan = selected.rows.find((row) => row.id === conversation.currentTestPlanRevisionId);
  if (!spec || !plan || spec.project_id !== conversation.projectId || plan.project_id !== conversation.projectId
    || spec.aggregate_type !== "GAME_SPEC" || plan.aggregate_type !== "TEST_PLAN"
    || spec.aggregate_id !== conversation.specAggregateId || plan.aggregate_id !== conversation.testPlanAggregateId
    || Number(spec.revision) !== conversation.version || Number(plan.revision) !== conversation.version
    || !["DRAFT", "APPROVED"].includes(spec.state) || !["DRAFT", "FROZEN"].includes(plan.state)
    || (conversation.state === "DRAFT" && (spec.state !== "DRAFT" || plan.state !== "DRAFT"))
    || (conversation.state === "APPROVED" && (spec.state !== "APPROVED" || plan.state !== "FROZEN"))
    || !SHA256.test(spec.payload_digest) || !SHA256.test(plan.payload_digest)) invalid();
  return { spec, plan };
}

async function insertRevision(client: PostgresWorkflowClient, input: {
  id: string; tenantId: string; projectId: string; aggregateType: "GAME_SPEC" | "TEST_PLAN";
  state?: "DRAFT" | "APPROVED" | "FROZEN";
  aggregateId: string; revision: number; payload: unknown; payloadDigest: string;
  previousRevisionId: string | null; createdBy: string;
}): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO deviludo.immutable_revisions
      (id, tenant_id, project_id, aggregate_type, aggregate_id, revision,
       state, payload, payload_digest, previous_revision_id, created_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6,
             $11, $7::jsonb, $8, $9::uuid, $10)`,
    [input.id, input.tenantId, input.projectId, input.aggregateType, input.aggregateId,
      input.revision, canonicalSpecJson(input.payload), input.payloadDigest, input.previousRevisionId, input.createdBy, input.state ?? "DRAFT"],
  );
  if (inserted.rowCount !== 1) invalid();
}

function parseStoredSnapshot(value: unknown, command: SpecDialogueClaim["command"]): SpecDialogueSnapshot {
  const body = object(value);
  if (body.tenantId !== command.tenantId || body.projectId !== command.projectId || body.conversationId !== command.conversationId
    || !Number.isSafeInteger(body.revision) || (body.revision as number) < 1 || body.state !== "DRAFT"
    || typeof body.specRevisionId !== "string" || !UUID.test(body.specRevisionId)
    || typeof body.testPlanRevisionId !== "string" || !UUID.test(body.testPlanRevisionId)
    || typeof body.specDigest !== "string" || !SHA256.test(body.specDigest)
    || typeof body.testPlanDigest !== "string" || !SHA256.test(body.testPlanDigest)
    || !Array.isArray(body.messages)) invalid();
  const messages = body.messages.map((item) => {
    const message = object(item);
    if (typeof message.id !== "string" || !UUID.test(message.id) || !Number.isSafeInteger(message.sequence)
      || (message.role !== "user" && message.role !== "assistant") || typeof message.text !== "string"
      || typeof message.createdAt !== "string" || !Number.isFinite(Date.parse(message.createdAt))) invalid();
    return Object.freeze({ id: message.id, sequence: message.sequence as number, role: message.role, text: message.text, createdAt: new Date(message.createdAt).toISOString() });
  });
  return Object.freeze({
    tenantId: command.tenantId, projectId: command.projectId, conversationId: command.conversationId,
    revision: body.revision as number, state: "DRAFT",
    specRevisionId: body.specRevisionId, specDigest: body.specDigest,
    testPlanRevisionId: body.testPlanRevisionId, testPlanDigest: body.testPlanDigest,
    messages: Object.freeze(messages), result: parseSpecModelResult(body.result),
  });
}

function parseStoredApproval(value: unknown, command: SpecApprovalCommand): SpecApprovalReceipt {
  const body = object(value);
  if (body.operationKey !== command.operationKey || body.tenantId !== command.tenantId
    || body.projectId !== command.projectId || body.conversationId !== command.conversationId
    || !Number.isSafeInteger(body.revision) || (body.revision as number) !== command.expectedRevision + 1
    || body.state !== "APPROVED" || typeof body.specRevisionId !== "string" || !UUID.test(body.specRevisionId)
    || typeof body.testPlanRevisionId !== "string" || !UUID.test(body.testPlanRevisionId)
    || typeof body.specDigest !== "string" || !SHA256.test(body.specDigest)
    || typeof body.testPlanDigest !== "string" || !SHA256.test(body.testPlanDigest)
    || !Array.isArray(body.targetMatrix) || typeof body.godotVersion !== "string"
    || typeof body.approvedAt !== "string" || !Number.isFinite(Date.parse(body.approvedAt))) invalid();
  const targetMatrix = body.targetMatrix.map((item) => {
    if (item !== "windows" && item !== "linux" && item !== "macos") invalid();
    return item;
  });
  return Object.freeze({
    operationKey: command.operationKey, tenantId: command.tenantId, projectId: command.projectId,
    conversationId: command.conversationId, revision: body.revision as number, state: "APPROVED",
    specRevisionId: body.specRevisionId, specDigest: body.specDigest,
    testPlanRevisionId: body.testPlanRevisionId, testPlanDigest: body.testPlanDigest,
    targetMatrix: Object.freeze(targetMatrix), godotVersion: body.godotVersion,
    approvedAt: new Date(body.approvedAt).toISOString(),
  });
}

function validateUuidBindings(input: { tenantId: string; projectId: string; conversationId: string }): void {
  if (!UUID.test(input.tenantId) || !UUID.test(input.projectId) || !UUID.test(input.conversationId)) invalid();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function invalid(): never { throw new Error("Specification dialogue PostgreSQL binding is invalid"); }
