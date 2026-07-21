import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import type { DeliverySnapshot, DeliverySignal } from "../../temporal/src/contracts";
import type { ClaimedWorkflowJob } from "../../temporal/src/postgres-queue";
import {
  ControlPlaneWorkflowHandler,
  type ControlPlaneWorkflowAction,
  type ControlPlaneWorkflowActionReceipt,
  type ControlPlaneWorkflowPort,
} from "../src/workflow-handler";
import {
  PostgresControlPlaneWorkflowActionStore,
  type ControlPlaneWorkflowSqlClient,
} from "../src/workflow-action-postgres";
import { PostgresWorkflowActionCompletionStore } from "../src/workflow-action-completion-postgres";
import {
  PostgresWorkflowSignalOutbox,
  WorkflowSignalOutboxProcessor,
  type WorkflowSignalOutboxPort,
} from "../src/workflow-signal-outbox";
import {
  registerWorkflowActionCompletionRoute,
  workflowCompletionSourceMapFromEnv,
} from "../src/workflow-action-completion-http";

const digest = "b".repeat(64);
const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const releaseId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const releaseConfigurationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const base: DeliverySnapshot = Object.freeze({
  workflowId: "delivery-001", tenantId: "tenant-001", projectId: "project-001", state: "IDEATION",
  specRevisionId: null, testPlanRevisionId: null, specApprovalReceiptId: null,
  lockedRunConfigurationId: null, runId: null, candidateCommitSha: null,
  draftPullRequest: null, mainCommitSha: null, evidenceBundleId: null, candidateEvidenceBundleId: null,
  mainEvidenceBundleId: null, steamInstallEvidenceBundleId: null, mfaApprovalId: null, steamBuildId: null,
  steamReleaseId: null, defaultBranchBuildId: null, targetMatrix: Object.freeze(["linux", "macos", "windows"] as const),
  iteration: 1, repairAttempts: 0, waitingProviderRevisionId: null, externalGate: null,
  repairContext: null,
  externalApprovals: Object.freeze([]), history: Object.freeze([]),
});

function snapshotFor(operation: ControlPlaneWorkflowAction): DeliverySnapshot {
  if (operation === "CONTINUE_IDEA_DIALOGUE") return base;
  if (operation === "REQUEST_SPEC_APPROVAL") return Object.freeze({ ...base, state: "WAITING_SPEC_APPROVAL", specRevisionId: "spec-r1" });
  if (operation === "RESOLVE_AGENT_RUN_CONFIGURATION") return Object.freeze({
    ...base, state: "RESOLVING_AGENT_CONFIGURATION", specRevisionId: "approved-spec-r2",
    testPlanRevisionId: "approved-plan-r2", specApprovalReceiptId: "spec-approval-r2",
  });
  if (operation === "WAIT_FOR_PROVIDER") return Object.freeze({
    ...base, state: "WAITING_PROVIDER", lockedRunConfigurationId: "lock-r1", waitingProviderRevisionId: "provider-r7",
  });
  if (operation === "REQUEST_USER_ACCEPTANCE") return Object.freeze({
    ...base, state: "WAITING_USER_ACCEPTANCE", specRevisionId: "spec-r1", candidateCommitSha: "c".repeat(40),
    draftPullRequest: 91, evidenceBundleId: "candidate-evidence-1", candidateEvidenceBundleId: "candidate-evidence-1",
  });
  if (operation === "REQUEST_FRESH_MFA") return Object.freeze({
    ...base, state: "WAITING_MFA", mainCommitSha: "d".repeat(40), evidenceBundleId: "main-evidence-1",
    mainEvidenceBundleId: "main-evidence-1", runId,
  });
  if (operation === "WAIT_FOR_EXTERNAL_APPROVAL") return Object.freeze({
    ...base, state: "EXTERNAL_APPROVAL_REQUIRED", steamBuildId: "91234567", evidenceBundleId: "steam-evidence-1",
    steamInstallEvidenceBundleId: "steam-evidence-1", externalGate: "VALVE_REVIEW",
  });
  const cancelSignal: DeliverySignal = Object.freeze({
    signalId: "cancel-signal-0001", type: "CANCEL", reason: "user cancelled",
    expectedState: "IDEATION", expectedHistoryLength: 0,
  });
  return Object.freeze({
    ...base, state: "CANCELLED", lockedRunConfigurationId: runId, runId,
    steamReleaseId: releaseId, steamBuildId: "91234567",
    history: Object.freeze([{ sequence: 1, signal: cancelSignal, resultingState: "CANCELLED" as const }]),
  });
}

function job(operation: ControlPlaneWorkflowAction, value = snapshotFor(operation)): ClaimedWorkflowJob {
  const common = {
    id: "11111111-1111-4111-8111-111111111111", tenantId: value.tenantId, projectId: value.projectId,
    workflowId: value.workflowId, destination: "control-plane" as const, operation, requestDigest: digest,
    attempt: 1, claimToken: "22222222-2222-4222-8222-222222222222", claimExpiresAt: "2099-01-01T00:10:00.000Z",
  };
  if (operation === "CANCEL_DELIVERY") return Object.freeze({ ...common, request: {
    kind: "CANCEL" as const, destination: "control-plane" as const, payload: {
      idempotencyKey: "delivery-001:1:CANCELLED:CANCEL_DELIVERY", workflowId: value.workflowId,
      tenantId: value.tenantId, projectId: value.projectId, destination: "control-plane" as const,
      reason: "user cancelled", snapshot: value,
    },
  } });
  return Object.freeze({ ...common, request: {
    kind: "COMMAND" as const, destination: "control-plane" as const, payload: {
      idempotencyKey: `delivery-001:${value.history.length}:${value.state}:${operation}`, workflowId: value.workflowId,
      tenantId: value.tenantId, projectId: value.projectId, destination: "control-plane" as const,
      command: operation, snapshot: value,
    },
  } });
}

function receipt(operation: ControlPlaneWorkflowAction): ControlPlaneWorkflowActionReceipt {
  return {
    receiptId: `control-receipt-${operation.toLowerCase()}`, actionId: `control-action-${operation.toLowerCase()}`,
    operation, requestDigest: digest, status: operation === "CANCEL_DELIVERY" ? "ACKNOWLEDGED" : "WAITING",
    cancellationRevocationId: operation === "CANCEL_DELIVERY" ? "33333333-3333-4333-8333-333333333333" : null,
  };
}

const releases = Object.freeze({
  async ensure(input: {
    workflowId: string;
    runId: string;
    mainCommitSha: string;
    mainEvidenceBundleId: string;
    targetMatrix: readonly ("windows" | "linux" | "macos")[];
  }) {
    return Object.freeze({
      releaseId,
      workflowId: input.workflowId,
      runId: input.runId,
      mainCommitSha: input.mainCommitSha,
      mainEvidenceBundleId: input.mainEvidenceBundleId,
      releaseConfigurationId,
      targetMatrix: input.targetMatrix,
      state: "WAITING_MFA" as const,
    });
  },
});

test("control-plane workflow handler registers every user or external wait with exact bindings", async () => {
  const observed: Parameters<ControlPlaneWorkflowPort["ensureAction"]>[0][] = [];
  const handler = new ControlPlaneWorkflowHandler({ async ensureAction(input) {
    observed.push(input);
    return receipt(input.operation);
  } }, releases);
  const operations: ControlPlaneWorkflowAction[] = [
    "CONTINUE_IDEA_DIALOGUE", "REQUEST_SPEC_APPROVAL", "RESOLVE_AGENT_RUN_CONFIGURATION",
    "WAIT_FOR_PROVIDER", "REQUEST_USER_ACCEPTANCE",
    "REQUEST_FRESH_MFA", "WAIT_FOR_EXTERNAL_APPROVAL", "CANCEL_DELIVERY",
  ];
  for (const operation of operations) {
    const outcome = await handler.execute(job(operation), { async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; } });
    assert.equal(outcome.result.operation, operation);
    if (operation === "REQUEST_FRESH_MFA") {
      assert.deepEqual(outcome.signal, { type: "RELEASE_PREPARED", releaseId });
    } else {
      assert.equal("signal" in outcome, false);
    }
  }
  assert.equal(observed[2]?.binding.testPlanRevisionId, "approved-plan-r2");
  assert.equal(observed[3]?.binding.providerRevisionId, "provider-r7");
  assert.equal(observed[4]?.binding.candidateCommitSha, "c".repeat(40));
  assert.equal(observed[5]?.binding.mainCommitSha, "d".repeat(40));
  assert.equal(observed[5]?.binding.releaseId, releaseId);
  assert.equal(observed[6]?.binding.externalGate, "VALVE_REVIEW");
  assert.equal(observed[7]?.binding.cancellationReason, "user cancelled");
  assert.equal(observed[7]?.binding.lockedRunConfigurationId, runId);
  assert.equal(observed[7]?.binding.releaseId, releaseId);
  assert.equal(observed[7]?.binding.steamBuildId, "91234567");
});

test("control-plane workflow handler never emits an approval signal from a registered user wait", async () => {
  const handler = new ControlPlaneWorkflowHandler({ async ensureAction(input) { return receipt(input.operation); } }, releases);
  const outcome = await handler.execute(job("REQUEST_USER_ACCEPTANCE"), {
    async heartbeat() { return "renewed"; }, async emitSignal() { throw new Error("must not emit"); },
  });
  assert.equal("signal" in outcome, false);
  assert.equal(outcome.result.status, "WAITING");
});

test("control-plane binds an automatic E2E repair to the exact predecessor and evidence", async () => {
  const repairContext = Object.freeze({
    attempt: 2,
    reason: "E2E_FAILURE" as const,
    fromRunConfigurationId: "33333333-3333-4333-8333-333333333333",
    diagnosticId: null,
    evidenceBundleId: "44444444-4444-4444-8444-444444444444",
    repairPromptId: `repair:${"a".repeat(64)}`,
    candidateCommitSha: "c".repeat(40),
    draftPullRequest: 91,
  });
  const repairSnapshot = Object.freeze({
    ...snapshotFor("RESOLVE_AGENT_RUN_CONFIGURATION"), repairAttempts: 2, repairContext,
  });
  const observed: Parameters<ControlPlaneWorkflowPort["ensureAction"]>[0][] = [];
  const handler = new ControlPlaneWorkflowHandler({
    async ensureAction(input) { observed.push(input); return receipt(input.operation); },
  }, releases);
  await handler.execute(job("RESOLVE_AGENT_RUN_CONFIGURATION", repairSnapshot), {
    async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; },
  });
  assert.deepEqual(observed[0]?.binding.repairContext, repairContext);
});

test("control-plane registers post-merge failure as an immediate human revision wait", async () => {
  const repairContext = Object.freeze({
    attempt: 1,
    reason: "MAIN_GATE_FAILURE" as const,
    fromRunConfigurationId: "33333333-3333-4333-8333-333333333333",
    diagnosticId: null,
    evidenceBundleId: "44444444-4444-4444-8444-444444444444",
    repairPromptId: `repair:${"a".repeat(64)}`,
    candidateCommitSha: "d".repeat(40),
    draftPullRequest: null,
  });
  const snapshot = Object.freeze({
    ...snapshotFor("REQUEST_SPEC_APPROVAL"), repairAttempts: 1, repairContext,
  });
  const observed: Parameters<ControlPlaneWorkflowPort["ensureAction"]>[0][] = [];
  const handler = new ControlPlaneWorkflowHandler({
    async ensureAction(input) { observed.push(input); return receipt(input.operation); },
  }, releases);
  await handler.execute(job("REQUEST_SPEC_APPROVAL", snapshot), {
    async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; },
  });
  assert.deepEqual(observed[0]?.binding.repairContext, repairContext);
});

test("control-plane workflow handler rejects state, receipt and cancellation drift terminally", async () => {
  const handler = new ControlPlaneWorkflowHandler({ async ensureAction(input) { return receipt(input.operation); } }, releases);
  await assert.rejects(handler.execute(job("REQUEST_SPEC_APPROVAL", base), {
    async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; },
  }), /CONTROL_PLANE_BINDING_INVALID/);

  const drift = new ControlPlaneWorkflowHandler({ async ensureAction(input) {
    return { ...receipt(input.operation), requestDigest: "a".repeat(64) };
  } }, releases);
  await assert.rejects(drift.execute(job("REQUEST_FRESH_MFA"), {
    async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; },
  }), /CONTROL_PLANE_RECEIPT_DRIFT/);

  const invalidCancel = Object.freeze({ ...snapshotFor("CANCEL_DELIVERY"), history: Object.freeze([]) });
  await assert.rejects(handler.execute(job("CANCEL_DELIVERY", invalidCancel), {
    async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; },
  }), /CONTROL_PLANE_BINDING_INVALID/);

  const tooLate = snapshotFor("CANCEL_DELIVERY");
  const tooLateCancel = Object.freeze({
    ...tooLate,
    history: Object.freeze([
      { sequence: 1, signal: Object.freeze({ signalId: "publish-ready", type: "EXTERNAL_APPROVED" as const,
        gate: "DEFAULT_BRANCH_CONFIRMATION" as const, approvalId: "approval-final" }), resultingState: "READY_TO_PUBLISH" as const },
      { sequence: 2, signal: tooLate.history[0]!.signal, resultingState: "CANCELLED" as const },
    ]),
  });
  await assert.rejects(handler.execute(job("CANCEL_DELIVERY", tooLateCancel), {
    async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; },
  }), /CONTROL_PLANE_BINDING_INVALID/);
});

test("Postgres control-plane action store applies RLS and replays only an exact binding", async () => {
  const sql: string[] = [];
  const values: (readonly unknown[] | undefined)[] = [];
  let released = false;
  const binding = Object.freeze({
    state: "WAITING_SPEC_APPROVAL", specRevisionId: "spec-r1", lockedRunConfigurationId: null,
    testPlanRevisionId: null, specApprovalReceiptId: null,
    providerRevisionId: null, candidateCommitSha: null, draftPullRequest: null, evidenceBundleId: null,
    mainCommitSha: null, releaseId: null, steamBuildId: null, externalGate: null, cancellationReason: null,
    repairContext: null,
  });
  const row = {
    id: "33333333-3333-4333-8333-333333333333", tenant_id: "11111111-1111-4111-8111-111111111111",
    project_id: "22222222-2222-4222-8222-222222222222", workflow_id: "delivery-001",
    operation_key: "workflow-job:44444444-4444-4444-8444-444444444444", request_digest: digest,
    operation: "REQUEST_SPEC_APPROVAL" as const, status: "WAITING" as const, binding,
  };
  const client: ControlPlaneWorkflowSqlClient = {
    async query<Row>(statement: string, parameters?: readonly unknown[]) {
      sql.push(statement);
      values.push(parameters);
      return { rows: (statement.includes("SELECT id, tenant_id") ? [row] : []) as Row[] };
    },
    release() { released = true; },
  };
  let heartbeats = 0;
  const store = new PostgresControlPlaneWorkflowActionStore({ async connect() { return client; } });
  const result = await store.ensureAction({
    operationKey: row.operation_key, requestDigest: digest, tenantId: row.tenant_id, projectId: row.project_id,
    workflowId: row.workflow_id, operation: row.operation, binding,
    async heartbeat() { heartbeats += 1; return "renewed"; },
  });
  assert.equal(result.actionId, row.id);
  assert.equal(heartbeats, 1);
  assert.equal(sql[0], "BEGIN");
  assert.equal(sql[1], "SELECT set_config('app.tenant_id', $1, true)");
  assert.deepEqual(values[1], [row.tenant_id]);
  assert.match(sql[2] ?? "", /INSERT INTO deviludo\.workflow_control_actions/);
  assert.equal(sql.at(-1), "COMMIT");
  assert.equal(released, true);
});

test("Postgres cancellation acknowledgement commits only with its exact cross-service revocation", async () => {
  const sql: string[] = [];
  const values: (readonly unknown[] | undefined)[] = [];
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const projectId = "22222222-2222-4222-8222-222222222222";
  const actionId = "33333333-3333-4333-8333-333333333333";
  const revocationId = "44444444-4444-4444-8444-444444444444";
  const operationKey = "workflow-job:55555555-5555-4555-8555-555555555555";
  const reason = "user cancelled";
  const reasonDigest = createHash("sha256").update(reason).digest("hex");
  const binding = Object.freeze({
    state: "CANCELLED", specRevisionId: null, testPlanRevisionId: null, specApprovalReceiptId: null,
    lockedRunConfigurationId: runId, providerRevisionId: null, candidateCommitSha: null,
    draftPullRequest: null, evidenceBundleId: null, mainCommitSha: null, releaseId,
    steamBuildId: "91234567", externalGate: null, cancellationReason: reason, repairContext: null,
  });
  const action = {
    id: actionId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
    operation_key: operationKey, request_digest: digest, operation: "CANCEL_DELIVERY" as const,
    status: "ACKNOWLEDGED" as const, binding,
  };
  const revocation = {
    id: revocationId, tenant_id: tenantId, project_id: projectId, workflow_id: action.workflow_id,
    action_id: actionId, operation_key: operationKey, request_digest: digest,
    run_id: runId, release_id: releaseId, steam_build_id: "91234567", reason_digest: reasonDigest,
  };
  const client: ControlPlaneWorkflowSqlClient = {
    async query<Row>(statement: string, parameters?: readonly unknown[]) {
      sql.push(statement); values.push(parameters);
      if (statement.includes("SELECT id, tenant_id")) return { rows: [action] as Row[] };
      if (statement.includes("FROM deviludo.delivery_cancellation_revocations")) return { rows: [revocation] as Row[] };
      return { rows: [] };
    },
    release() {},
  };
  const store = new PostgresControlPlaneWorkflowActionStore({ async connect() { return client; } });
  const result = await store.ensureAction({
    operationKey, requestDigest: digest, tenantId, projectId, workflowId: action.workflow_id,
    operation: "CANCEL_DELIVERY", binding, async heartbeat() { return "renewed"; },
  });
  assert.equal(result.cancellationRevocationId, revocationId);
  const replay = await store.ensureAction({
    operationKey, requestDigest: digest, tenantId, projectId, workflowId: action.workflow_id,
    operation: "CANCEL_DELIVERY", binding, async heartbeat() { return "renewed"; },
  });
  assert.equal(replay.cancellationRevocationId, revocationId);
  const insert = sql.findIndex((statement) => statement.includes("INSERT INTO deviludo.delivery_cancellation_revocations"));
  const select = sql.findIndex((statement) => statement.includes("FROM deviludo.delivery_cancellation_revocations"));
  assert.ok(insert > 0 && select > insert);
  assert.equal(sql.at(-1), "COMMIT");
  assert.equal(sql.filter((statement) => statement.includes("INSERT INTO deviludo.delivery_cancellation_revocations")).length, 2);
  assert.deepEqual(values[insert]?.slice(0, 9), [
    tenantId, projectId, action.workflow_id, actionId, operationKey, digest, runId, releaseId, "91234567",
  ]);
});

test("Postgres control-plane action store rolls back an idempotency collision", async () => {
  const sql: string[] = [];
  const binding = Object.freeze({
    state: "IDEATION", specRevisionId: null, lockedRunConfigurationId: null, providerRevisionId: null,
    testPlanRevisionId: null, specApprovalReceiptId: null,
    candidateCommitSha: null, draftPullRequest: null, evidenceBundleId: null, mainCommitSha: null,
    releaseId: null, steamBuildId: null, externalGate: null, cancellationReason: null,
    repairContext: null,
  });
  const client: ControlPlaneWorkflowSqlClient = {
    async query<Row>(statement: string) {
      sql.push(statement);
      const drifted = {
        id: "33333333-3333-4333-8333-333333333333", tenant_id: "11111111-1111-4111-8111-111111111111",
        project_id: "22222222-2222-4222-8222-222222222222", workflow_id: "delivery-001",
        operation_key: "workflow-job:44444444-4444-4444-8444-444444444444", request_digest: "a".repeat(64),
        operation: "CONTINUE_IDEA_DIALOGUE", status: "WAITING", binding,
      };
      return { rows: (statement.includes("SELECT id, tenant_id") ? [drifted] : []) as Row[] };
    },
    release() {},
  };
  const store = new PostgresControlPlaneWorkflowActionStore({ async connect() { return client; } });
  await assert.rejects(store.ensureAction({
    operationKey: "workflow-job:44444444-4444-4444-8444-444444444444", requestDigest: digest,
    tenantId: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222",
    workflowId: "delivery-001", operation: "CONTINUE_IDEA_DIALOGUE", binding,
    async heartbeat() { return "renewed"; },
  }), /idempotency binding mismatch/);
  assert.equal(sql.at(-1), "ROLLBACK");
});

test("workflow action completion atomically binds an authoritative signal to its outbox", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const projectId = "22222222-2222-4222-8222-222222222222";
  const actionId = "33333333-3333-4333-8333-333333333333";
  const outboxId = "44444444-4444-4444-8444-444444444444";
  const draftSpecRevisionId = "55555555-5555-4555-8555-555555555555";
  const approvedSpecRevisionId = "66666666-6666-4666-8666-666666666666";
  const testPlanRevisionId = "77777777-7777-4777-8777-777777777777";
  const approvalReceiptId = "e".repeat(64);
  const signal: DeliverySignal = Object.freeze({
    signalId: "spec-approved-signal-001",
    type: "SPEC_APPROVED",
    approvedSpecRevisionId,
    testPlanRevisionId,
    approvalReceiptId,
  });
  const statements: string[] = [];
  let inserted: readonly unknown[] | undefined;
  let outboxState: "PENDING" | "DELIVERED" = "PENDING";
  const action = {
    id: actionId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
    operation: "REQUEST_SPEC_APPROVAL", status: "WAITING",
    binding: {
      state: "WAITING_SPEC_APPROVAL", specRevisionId: draftSpecRevisionId, lockedRunConfigurationId: null,
      testPlanRevisionId: null, specApprovalReceiptId: null,
      providerRevisionId: null, candidateCommitSha: null, draftPullRequest: null,
      evidenceBundleId: null, mainCommitSha: null, releaseId: null, steamBuildId: null,
      externalGate: null, cancellationReason: null,
    },
    completion_signal_id: null, completion_signal_digest: null,
    completion_source: null, completion_receipt_id: null,
  };
  const client: ControlPlaneWorkflowSqlClient = {
    async query<Row>(statement: string, values?: readonly unknown[]) {
      statements.push(statement);
      if (statement.includes("INSERT INTO deviludo.workflow_signal_outbox")) inserted = values;
      if (statement.includes("FROM deviludo.workflow_control_actions")) return { rows: [action] as Row[] };
      if (statement.includes("FROM deviludo.immutable_revisions spec")) return { rows: [{
        approved_spec_revision_id: approvedSpecRevisionId,
        draft_spec_revision_id: draftSpecRevisionId,
        approved_spec_state: "APPROVED",
        test_plan_revision_id: testPlanRevisionId,
        test_plan_state: "FROZEN",
        conversation_state: "APPROVED",
        current_spec_revision_id: approvedSpecRevisionId,
        current_test_plan_revision_id: testPlanRevisionId,
        operation_state: "COMPLETED",
        operation_response: { operationKey: approvalReceiptId, specRevisionId: approvedSpecRevisionId, testPlanRevisionId },
      }] as Row[] };
      if (statement.includes("FROM deviludo.workflow_signal_outbox")) return { rows: [{
        id: outboxId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
        action_id: actionId, signal_id: signal.signalId, signal_digest: inserted?.[5],
        signal: JSON.parse(String(inserted?.[6])), state: outboxState,
      }] as Row[] };
      if (statement.includes("UPDATE deviludo.workflow_control_actions")) return { rows: [{ id: actionId }] as Row[] };
      return { rows: [] };
    },
    release() {},
  };
  const store = new PostgresWorkflowActionCompletionStore({ async connect() { return client; } });
  const receipt = await store.complete({
    tenantId, projectId, workflowId: "delivery-001", actionId,
    source: "SPEC_SERVICE", sourceReceiptId: "spec-approval-receipt-001", signal,
  });
  assert.equal(receipt.outboxId, outboxId);
  assert.equal(receipt.state, "PENDING_DELIVERY");
  assert.equal(receipt.replayed, false);
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements[1], "SELECT set_config('app.tenant_id', $1, true)");
  assert.equal(statements.at(-1), "COMMIT");
  assert.ok(statements.findIndex((value) => value.includes("INSERT INTO deviludo.workflow_signal_outbox"))
    < statements.findIndex((value) => value.includes("UPDATE deviludo.workflow_control_actions")));

  Object.assign(action, {
    status: "COMPLETED", completion_signal_id: signal.signalId,
    completion_signal_digest: receipt.signalDigest, completion_source: "SPEC_SERVICE",
    completion_receipt_id: "spec-approval-receipt-001",
  });
  outboxState = "DELIVERED";
  const replay = await store.complete({
    tenantId, projectId, workflowId: "delivery-001", actionId,
    source: "SPEC_SERVICE", sourceReceiptId: "spec-approval-receipt-001", signal,
  });
  assert.equal(replay.state, "DELIVERED");
  assert.equal(replay.replayed, true);
});

test("spec-ready completion accepts only a persisted draft linked to its tenant conversation", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const projectId = "22222222-2222-4222-8222-222222222222";
  const actionId = "33333333-3333-4333-8333-333333333333";
  const outboxId = "44444444-4444-4444-8444-444444444444";
  const draftId = "55555555-5555-4555-8555-555555555555";
  const signal: DeliverySignal = { signalId: "spec-ready-signal-001", type: "SPEC_READY", specRevisionId: draftId };
  let inserted: readonly unknown[] | undefined;
  const client: ControlPlaneWorkflowSqlClient = {
    async query<Row>(statement: string, values?: readonly unknown[]) {
      if (statement.includes("FROM deviludo.workflow_control_actions")) return { rows: [{
        id: actionId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
        operation: "CONTINUE_IDEA_DIALOGUE", status: "WAITING",
        binding: { state: "IDEATION", specRevisionId: null, testPlanRevisionId: null,
          specApprovalReceiptId: null, lockedRunConfigurationId: null, providerRevisionId: null,
          candidateCommitSha: null, draftPullRequest: null, evidenceBundleId: null,
          mainCommitSha: null, releaseId: null, steamBuildId: null, externalGate: null,
          cancellationReason: null }, completion_signal_id: null,
        completion_signal_digest: null, completion_source: null, completion_receipt_id: null,
      }] as Row[] };
      if (statement.includes("FROM deviludo.immutable_revisions draft")) return { rows: [{
        draft_spec_revision_id: draftId, draft_state: "DRAFT", conversation_state: "APPROVED",
        current_spec_revision_id: "66666666-6666-4666-8666-666666666666",
        approved_previous_revision_id: draftId,
      }] as Row[] };
      if (statement.includes("INSERT INTO deviludo.workflow_signal_outbox")) inserted = values;
      if (statement.includes("FROM deviludo.workflow_signal_outbox")) return { rows: [{
        id: outboxId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
        action_id: actionId, signal_id: signal.signalId, signal_digest: inserted?.[5],
        signal: JSON.parse(String(inserted?.[6])), state: "PENDING",
      }] as Row[] };
      if (statement.includes("UPDATE deviludo.workflow_control_actions")) return { rows: [{ id: actionId }] as Row[] };
      return { rows: [] };
    }, release() {},
  };
  const receipt = await new PostgresWorkflowActionCompletionStore({ async connect() { return client; } }).complete({
    tenantId, projectId, workflowId: "delivery-001", actionId,
    source: "SPEC_SERVICE", sourceReceiptId: "spec-ready-receipt-001", signal,
  });
  assert.equal(receipt.outboxId, outboxId);
});

test("Agent configuration completion re-resolves the queued immutable lock before development", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const projectId = "22222222-2222-4222-8222-222222222222";
  const actionId = "33333333-3333-4333-8333-333333333333";
  const outboxId = "44444444-4444-4444-8444-444444444444";
  const runId = "55555555-5555-4555-8555-555555555555";
  const specId = "66666666-6666-4666-8666-666666666666";
  const planId = "77777777-7777-4777-8777-777777777777";
  const approvalId = "f".repeat(64);
  const signal: DeliverySignal = { signalId: "run-configuration-locked-001", type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: runId };
  let inserted: readonly unknown[] | undefined;
  const action = {
    id: actionId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
    operation: "RESOLVE_AGENT_RUN_CONFIGURATION", status: "WAITING",
    binding: { state: "RESOLVING_AGENT_CONFIGURATION", specRevisionId: specId,
      testPlanRevisionId: planId, specApprovalReceiptId: approvalId,
      lockedRunConfigurationId: null, providerRevisionId: null, candidateCommitSha: null,
      draftPullRequest: null, evidenceBundleId: null, mainCommitSha: null, releaseId: null,
      steamBuildId: null, externalGate: null, cancellationReason: null },
    completion_signal_id: null, completion_signal_digest: null,
    completion_source: null, completion_receipt_id: null,
  };
  let lock = { specRevisionId: specId, testPlanRevisionId: planId, specApprovalReceiptId: approvalId };
  const statements: string[] = [];
  const client: ControlPlaneWorkflowSqlClient = {
    async query<Row>(statement: string, values?: readonly unknown[]) {
      statements.push(statement);
      if (statement.includes("FROM deviludo.workflow_control_actions")) return { rows: [action] as Row[] };
      if (statement.includes("FROM deviludo.agent_runs")) return { rows: [{ run_id: runId, state: "QUEUED", configuration_lock: lock }] as Row[] };
      if (statement.includes("INSERT INTO deviludo.workflow_signal_outbox")) inserted = values;
      if (statement.includes("FROM deviludo.workflow_signal_outbox")) return { rows: [{
        id: outboxId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
        action_id: actionId, signal_id: signal.signalId, signal_digest: inserted?.[5],
        signal: JSON.parse(String(inserted?.[6])), state: "PENDING",
      }] as Row[] };
      if (statement.includes("UPDATE deviludo.workflow_control_actions")) return { rows: [{ id: actionId }] as Row[] };
      return { rows: [] };
    }, release() {},
  };
  const store = new PostgresWorkflowActionCompletionStore({ async connect() { return client; } });
  assert.equal((await store.complete({ tenantId, projectId, workflowId: "delivery-001", actionId,
    source: "AGENT_CONFIGURATION_SERVICE", sourceReceiptId: "configuration-lock-receipt-001", signal })).outboxId, outboxId);

  Object.assign(action, { status: "WAITING" });
  lock = { ...lock, testPlanRevisionId: "88888888-8888-4888-8888-888888888888" };
  inserted = undefined;
  await assert.rejects(store.complete({ tenantId, projectId, workflowId: "delivery-001", actionId,
    source: "AGENT_CONFIGURATION_SERVICE", sourceReceiptId: "configuration-lock-receipt-002",
    signal: { ...signal, signalId: "run-configuration-locked-002" } }), /configuration authority is unavailable/);
  assert.equal(statements.at(-1), "ROLLBACK");
});

test("user feedback atomically tombstones exact candidate evidence before signaling the new draft iteration", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const projectId = "22222222-2222-4222-8222-222222222222";
  const actionId = "33333333-3333-4333-8333-333333333333";
  const outboxId = "44444444-4444-4444-8444-444444444444";
  const currentSpecId = "55555555-5555-4555-8555-555555555555";
  const nextSpecId = "66666666-6666-4666-8666-666666666666";
  const evidenceId = "77777777-7777-4777-8777-777777777777";
  const invalidationId = "88888888-8888-4888-8888-888888888888";
  const candidateReceiptId = "99999999-9999-4999-8999-999999999999";
  const candidateRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const attemptId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const planId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const candidateSha = "d".repeat(40);
  const sourceDigest = "e".repeat(64);
  const invalidatedAt = "2030-01-01T00:00:00.000Z";
  const signal: DeliverySignal = Object.freeze({
    signalId: "user-feedback-signal-001", type: "USER_FEEDBACK",
    nextSpecRevisionId: nextSpecId, evidenceInvalidationId: invalidationId,
  });
  const action = {
    id: actionId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
    operation: "REQUEST_USER_ACCEPTANCE", status: "WAITING",
    binding: { state: "WAITING_USER_ACCEPTANCE", specRevisionId: currentSpecId,
      testPlanRevisionId: planId, specApprovalReceiptId: "f".repeat(64),
      lockedRunConfigurationId: candidateRunId, providerRevisionId: null,
      candidateCommitSha: candidateSha, draftPullRequest: 91, evidenceBundleId: evidenceId,
      mainCommitSha: null, releaseId: null, steamBuildId: null, externalGate: null,
      cancellationReason: null },
    completion_signal_id: null, completion_signal_digest: null,
    completion_source: null, completion_receipt_id: null,
  };
  let evidenceInvalidatedAt: string | null = null;
  let invalidationInsert: readonly unknown[] | undefined;
  let outboxInsert: readonly unknown[] | undefined;
  let evidenceUpdates = 0;
  const statements: string[] = [];
  const client: ControlPlaneWorkflowSqlClient = {
    async query<Row>(statement: string, values?: readonly unknown[]) {
      statements.push(statement);
      if (statement.includes("FROM deviludo.workflow_control_actions")) return { rows: [action] as Row[] };
      if (statement.includes("FROM deviludo.github_candidate_receipts candidate")) return { rows: [{
        candidate_receipt_id: candidateReceiptId, candidate_run_id: candidateRunId,
        candidate_spec_revision_id: currentSpecId, candidate_commit_sha: candidateSha,
        candidate_source_digest: sourceDigest, candidate_pull_request: "91",
        attempt_id: attemptId, attempt_state: "PASSED", attempt_mode: "CANDIDATE",
        attempt_workflow_id: "delivery-001", attempt_commit_sha: candidateSha,
        attempt_source_digest: sourceDigest, attempt_binding: { specRevisionId: currentSpecId },
        evidence_id: evidenceId, evidence_commit_sha: candidateSha,
        evidence_source_digest: sourceDigest, evidence_status: "PASSED",
        evidence_invalidated_at: evidenceInvalidatedAt,
        evidence_binding: { specRevisionId: currentSpecId },
      }] as Row[] };
      if (statement.includes("FROM deviludo.immutable_revisions next")) return { rows: [{
        next_spec_revision_id: nextSpecId, next_spec_state: "DRAFT", next_spec_revision: 8,
        next_previous_revision_id: currentSpecId, previous_spec_revision_id: currentSpecId,
        previous_spec_state: "APPROVED", previous_spec_revision: 7,
        conversation_state: "DRAFT", current_spec_revision_id: nextSpecId,
        current_test_plan_revision_id: planId,
      }] as Row[] };
      if (statement.includes("INSERT INTO deviludo.workflow_feedback_invalidations")) {
        invalidationInsert = values;
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("FROM deviludo.workflow_feedback_invalidations")) return { rows: [{
        id: invalidationId, candidate_receipt_id: candidateReceiptId,
        evidence_bundle_id: evidenceId, previous_spec_revision_id: currentSpecId,
        next_spec_revision_id: nextSpecId, source_receipt_id: "feedback-receipt-001",
        reason: "USER_FEEDBACK", receipt_digest: invalidationInsert?.[10],
        receipt: JSON.parse(String(invalidationInsert?.[11])), invalidated_at: invalidatedAt,
      }] as Row[] };
      if (statement.includes("UPDATE deviludo.evidence_bundles")) {
        evidenceUpdates += 1;
        evidenceInvalidatedAt = invalidatedAt;
        return { rows: [{ id: evidenceId }] as Row[] };
      }
      if (statement.includes("INSERT INTO deviludo.workflow_signal_outbox")) {
        outboxInsert = values;
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("FROM deviludo.workflow_signal_outbox")) return { rows: [{
        id: outboxId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
        action_id: actionId, signal_id: signal.signalId, signal_digest: outboxInsert?.[5],
        signal: JSON.parse(String(outboxInsert?.[6])), state: "PENDING",
      }] as Row[] };
      if (statement.includes("UPDATE deviludo.workflow_control_actions")) return { rows: [{ id: actionId }] as Row[] };
      return { rows: [] };
    }, release() {},
  };
  const store = new PostgresWorkflowActionCompletionStore({ async connect() { return client; } });
  const receipt = await store.complete({ tenantId, projectId, workflowId: "delivery-001", actionId,
    source: "USER_ACCEPTANCE_SERVICE", sourceReceiptId: "feedback-receipt-001", signal });
  assert.equal(receipt.outboxId, outboxId);
  assert.equal(evidenceUpdates, 1);
  assert.ok(statements.findIndex((value) => value.includes("UPDATE deviludo.evidence_bundles"))
    < statements.findIndex((value) => value.includes("INSERT INTO deviludo.workflow_signal_outbox")));

  Object.assign(action, {
    status: "COMPLETED", completion_signal_id: signal.signalId,
    completion_signal_digest: receipt.signalDigest, completion_source: "USER_ACCEPTANCE_SERVICE",
    completion_receipt_id: "feedback-receipt-001",
  });
  const replay = await store.complete({ tenantId, projectId, workflowId: "delivery-001", actionId,
    source: "USER_ACCEPTANCE_SERVICE", sourceReceiptId: "feedback-receipt-001", signal });
  assert.equal(replay.replayed, true);
  assert.equal(evidenceUpdates, 1);
});

test("human repair takeover accepts exhausted and immediate post-merge failure authorities", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const projectId = "22222222-2222-4222-8222-222222222222";
  const actionId = "33333333-3333-4333-8333-333333333333";
  const outboxId = "44444444-4444-4444-8444-444444444444";
  const currentSpecId = "55555555-5555-4555-8555-555555555555";
  const nextSpecId = "66666666-6666-4666-8666-666666666666";
  const planId = "77777777-7777-4777-8777-777777777777";
  const revisionReceiptId = "88888888-8888-4888-8888-888888888888";
  const operationKey = "a".repeat(64);
  const signal: DeliverySignal = Object.freeze({
    signalId: "human-repair-feedback-001", type: "USER_FEEDBACK",
    nextSpecRevisionId: nextSpecId, evidenceInvalidationId: revisionReceiptId,
  });
  const repairContexts = Object.freeze([
    Object.freeze({
      attempt: 3, reason: "AGENT_FAILURE" as const,
      fromRunConfigurationId: "run-configuration-failed-003",
      diagnosticId: "diagnostic-failed-003", evidenceBundleId: null,
      repairPromptId: null, candidateCommitSha: null, draftPullRequest: null,
    }),
    Object.freeze({
      attempt: 1, reason: "MAIN_GATE_FAILURE" as const,
      fromRunConfigurationId: "run-configuration-main-gate-001",
      diagnosticId: null, evidenceBundleId: "99999999-9999-4999-8999-999999999999",
      repairPromptId: `repair:${"b".repeat(64)}`, candidateCommitSha: "d".repeat(40), draftPullRequest: null,
    }),
  ]);
  for (const repairContext of repairContexts) {
    const action = {
    id: actionId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
    operation: "REQUEST_SPEC_APPROVAL", status: "WAITING",
    binding: {
      state: "WAITING_SPEC_APPROVAL", specRevisionId: currentSpecId,
      testPlanRevisionId: null, specApprovalReceiptId: null,
      lockedRunConfigurationId: null, providerRevisionId: null,
      candidateCommitSha: null, draftPullRequest: null, evidenceBundleId: null,
      mainCommitSha: null, releaseId: null, steamBuildId: null, externalGate: null,
      cancellationReason: null, repairContext,
    },
    completion_signal_id: null, completion_signal_digest: null,
    completion_source: null, completion_receipt_id: null,
  };
    let outboxInsert: readonly unknown[] | undefined;
    const statements: string[] = [];
    const client: ControlPlaneWorkflowSqlClient = {
    async query<Row>(statement: string, values?: readonly unknown[]) {
      statements.push(statement);
      if (statement.includes("FROM deviludo.workflow_control_actions")) return { rows: [action] as Row[] };
      if (statement.includes("FROM deviludo.user_feedback_operations")) return { rows: [{
        operation_key: operationKey, project_id: projectId, workflow_id: "delivery-001",
        action_id: actionId, previous_spec_revision_id: currentSpecId,
        evidence_invalidation_id: revisionReceiptId, signal_id: signal.signalId,
        state: "DRAFT_READY", next_spec_revision_id: nextSpecId,
        draft_snapshot: { specRevisionId: nextSpecId },
      }] as Row[] };
      if (statement.includes("FROM deviludo.immutable_revisions next")) return { rows: [{
        next_spec_revision_id: nextSpecId, next_spec_state: "DRAFT", next_spec_revision: 8,
        next_previous_revision_id: currentSpecId, previous_spec_revision_id: currentSpecId,
        previous_spec_state: "APPROVED", previous_spec_revision: 7,
        conversation_state: "DRAFT", current_spec_revision_id: nextSpecId,
        current_test_plan_revision_id: planId,
      }] as Row[] };
      if (statement.includes("INSERT INTO deviludo.workflow_signal_outbox")) {
        outboxInsert = values;
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("FROM deviludo.workflow_signal_outbox")) return { rows: [{
        id: outboxId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
        action_id: actionId, signal_id: signal.signalId, signal_digest: outboxInsert?.[5],
        signal: JSON.parse(String(outboxInsert?.[6])), state: "PENDING",
      }] as Row[] };
      if (statement.includes("UPDATE deviludo.workflow_control_actions")) return { rows: [{ id: actionId }] as Row[] };
      return { rows: [] };
    }, release() {},
  };
    const store = new PostgresWorkflowActionCompletionStore({ async connect() { return client; } });
    const completion = await store.complete({ tenantId, projectId, workflowId: "delivery-001", actionId,
      source: "USER_ACCEPTANCE_SERVICE", sourceReceiptId: operationKey, signal });
    assert.equal(completion.outboxId, outboxId);
    assert.equal(statements.some((statement) => statement.includes("github_candidate_receipts")), false);
    assert.ok(statements.findIndex((statement) => statement.includes("user_feedback_operations"))
      < statements.findIndex((statement) => statement.includes("workflow_signal_outbox")));
  }
});

test("user acceptance cannot merge evidence that feedback already invalidated", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const projectId = "22222222-2222-4222-8222-222222222222";
  const actionId = "33333333-3333-4333-8333-333333333333";
  const specId = "55555555-5555-4555-8555-555555555555";
  const evidenceId = "77777777-7777-4777-8777-777777777777";
  const candidateSha = "d".repeat(40);
  const sourceDigest = "e".repeat(64);
  const client: ControlPlaneWorkflowSqlClient = {
    async query<Row>(statement: string) {
      if (statement.includes("FROM deviludo.workflow_control_actions")) return { rows: [{
        id: actionId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
        operation: "REQUEST_USER_ACCEPTANCE", status: "WAITING",
        binding: { state: "WAITING_USER_ACCEPTANCE", specRevisionId: specId,
          candidateCommitSha: candidateSha, draftPullRequest: 91, evidenceBundleId: evidenceId },
        completion_signal_id: null, completion_signal_digest: null,
        completion_source: null, completion_receipt_id: null,
      }] as Row[] };
      if (statement.includes("FROM deviludo.github_candidate_receipts candidate")) return { rows: [{
        candidate_receipt_id: "99999999-9999-4999-8999-999999999999",
        candidate_run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        candidate_spec_revision_id: specId, candidate_commit_sha: candidateSha,
        candidate_source_digest: sourceDigest, candidate_pull_request: 91,
        attempt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", attempt_state: "PASSED",
        attempt_mode: "CANDIDATE", attempt_workflow_id: "delivery-001",
        attempt_commit_sha: candidateSha, attempt_source_digest: sourceDigest,
        attempt_binding: { specRevisionId: specId }, evidence_id: evidenceId,
        evidence_commit_sha: candidateSha, evidence_source_digest: sourceDigest,
        evidence_status: "PASSED", evidence_invalidated_at: "2030-01-01T00:00:00.000Z",
        evidence_binding: { specRevisionId: specId },
      }] as Row[] };
      return { rows: [] };
    }, release() {},
  };
  await assert.rejects(new PostgresWorkflowActionCompletionStore({ async connect() { return client; } }).complete({
    tenantId, projectId, workflowId: "delivery-001", actionId,
    source: "USER_ACCEPTANCE_SERVICE", sourceReceiptId: "acceptance-receipt-001",
    signal: { signalId: "user-accepted-signal-001", type: "USER_ACCEPTED" },
  }), /evidence has been invalidated/);
});

test("workflow action completion rejects a signal from the wrong authority", async () => {
  const client: ControlPlaneWorkflowSqlClient = {
    async query<Row>(statement: string) {
      if (statement.includes("FROM deviludo.workflow_control_actions")) return { rows: [{
        id: "33333333-3333-4333-8333-333333333333",
        tenant_id: "11111111-1111-4111-8111-111111111111",
        project_id: "22222222-2222-4222-8222-222222222222",
        workflow_id: "delivery-001", operation: "REQUEST_FRESH_MFA", status: "WAITING",
        binding: {
          state: "WAITING_MFA", specRevisionId: null, lockedRunConfigurationId: null,
          testPlanRevisionId: null, specApprovalReceiptId: null,
          providerRevisionId: null, candidateCommitSha: null, draftPullRequest: null,
          evidenceBundleId: "main-evidence-1", mainCommitSha: "d".repeat(40), releaseId, steamBuildId: null,
          externalGate: null, cancellationReason: null,
        },
        completion_signal_id: null, completion_signal_digest: null,
        completion_source: null, completion_receipt_id: null,
      }] as Row[] };
      return { rows: [] };
    },
    release() {},
  };
  const store = new PostgresWorkflowActionCompletionStore({ async connect() { return client; } });
  await assert.rejects(store.complete({
    tenantId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    workflowId: "delivery-001", actionId: "33333333-3333-4333-8333-333333333333",
    source: "USER_ACCEPTANCE_SERVICE", sourceReceiptId: "user-receipt-001",
    signal: { signalId: "mfa-approved-signal-001", type: "MFA_APPROVED", approvalId: "mfa-approval-001" },
  }), /signal binding is invalid/);
});

test("external approval completion appends the verified receipt and advances the exact release gate atomically", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const projectId = "22222222-2222-4222-8222-222222222222";
  const actionId = "33333333-3333-4333-8333-333333333333";
  const outboxId = "44444444-4444-4444-8444-444444444444";
  const evidenceId = "55555555-5555-4555-8555-555555555555";
  const buildReceiptId = "66666666-6666-4666-8666-666666666666";
  const externalReceiptId = "77777777-7777-4777-8777-777777777777";
  const installDigest = "d".repeat(64);
  const signal = Object.freeze({
    signalId: "external-valve-signal-001",
    type: "EXTERNAL_APPROVED" as const,
    gate: "VALVE_REVIEW" as const,
    approvalId: "valve-review-approval-001",
  });
  const action = {
    id: actionId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
    operation: "WAIT_FOR_EXTERNAL_APPROVAL", status: "WAITING",
    binding: {
      state: "EXTERNAL_APPROVAL_REQUIRED", specRevisionId: null, lockedRunConfigurationId: null,
      testPlanRevisionId: null, specApprovalReceiptId: null,
      providerRevisionId: null, candidateCommitSha: null, draftPullRequest: null,
      evidenceBundleId: evidenceId, mainCommitSha: null, releaseId: null, steamBuildId: "91234567",
      externalGate: "VALVE_REVIEW", cancellationReason: null,
    },
    completion_signal_id: null, completion_signal_digest: null,
    completion_source: null, completion_receipt_id: null,
  };
  const statements: string[] = [];
  let externalInsert: readonly unknown[] | undefined;
  let outboxInsert: readonly unknown[] | undefined;
  const client: ControlPlaneWorkflowSqlClient = {
    async query<Row>(statement: string, values: readonly unknown[] = []) {
      statements.push(statement);
      if (statement.includes("FROM deviludo.workflow_control_actions")) return { rows: [action] as Row[] };
      if (statement.includes("FROM deviludo.steam_build_receipts build")) return { rows: [{
        release_id: releaseId, release_state: "EXTERNAL_APPROVAL_REQUIRED", external_gate: "VALVE_REVIEW",
        build_receipt_id: buildReceiptId, build_state: "EXTERNAL_APPROVAL_REQUIRED",
        steam_install_evidence_bundle_digest: installDigest, evidence_id: evidenceId,
        evidence_bundle_digest: installDigest, release_target_matrix: ["linux"], attempt_target_matrix: ["linux"],
      }] as Row[] };
      if (statement.includes("INSERT INTO deviludo.workflow_external_approval_receipts")) {
        externalInsert = values;
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("FROM deviludo.workflow_external_approval_receipts")) return { rows: [{
        id: externalReceiptId, release_id: releaseId, workflow_id: "delivery-001",
        signal_id: signal.signalId, gate: signal.gate, approval_id: signal.approvalId,
        verifier_subject: "STEAM_APPROVAL_MONITOR", evidence_digest: externalInsert?.[8],
        receipt: JSON.parse(String(externalInsert?.[9])),
      }] as Row[] };
      if (statement.includes("UPDATE deviludo.steam_releases")) {
        assert.deepEqual(values.slice(3), ["EXTERNAL_APPROVAL_REQUIRED", "FIRST_RELEASE", "VALVE_REVIEW"]);
        return { rows: [{ id: releaseId }] as Row[] };
      }
      if (statement.includes("INSERT INTO deviludo.workflow_signal_outbox")) {
        outboxInsert = values;
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("FROM deviludo.workflow_signal_outbox")) return { rows: [{
        id: outboxId, tenant_id: tenantId, project_id: projectId, workflow_id: "delivery-001",
        action_id: actionId, signal_id: signal.signalId, signal_digest: outboxInsert?.[5],
        signal: JSON.parse(String(outboxInsert?.[6])), state: "PENDING",
      }] as Row[] };
      if (statement.includes("UPDATE deviludo.workflow_control_actions")) return { rows: [{ id: actionId }] as Row[] };
      return { rows: [] };
    },
    release() {},
  };
  const store = new PostgresWorkflowActionCompletionStore({ async connect() { return client; } });
  const receipt = await store.complete({
    tenantId, projectId, workflowId: "delivery-001", actionId,
    source: "STEAM_APPROVAL_MONITOR", sourceReceiptId: "steam-monitor-receipt-001", signal,
  });
  assert.equal(receipt.state, "PENDING_DELIVERY");
  assert.ok(statements.findIndex((value) => value.includes("workflow_external_approval_receipts"))
    < statements.findIndex((value) => value.includes("workflow_signal_outbox")));
  assert.equal(statements.at(-1), "COMMIT");
  assert.match(JSON.stringify(externalInsert), /steam-monitor-receipt-001/);
});

test("workflow signal outbox processor retries Temporal failures without changing signal identity", async () => {
  const item = {
    id: "44444444-4444-4444-8444-444444444444",
    tenantId: "11111111-1111-4111-8111-111111111111",
    workflowId: "delivery-001", signalId: "user-accepted-signal-001", signalDigest: "a".repeat(64),
    signal: { signalId: "user-accepted-signal-001", type: "USER_ACCEPTED" } as const,
    attempt: 1, claimToken: "55555555-5555-4555-8555-555555555555",
  };
  const events: string[] = [];
  const successful: WorkflowSignalOutboxPort = {
    async claimNext() { return item; },
    async complete() { events.push("complete"); },
    async fail() { throw new Error("must not fail"); },
  };
  const success = new WorkflowSignalOutboxProcessor(successful, {
    async signal(workflowId, value) {
      assert.equal(workflowId, item.workflowId);
      assert.equal(value.signalId, item.signalId);
      events.push("signal");
    },
  }, "control-signal-outbox-01");
  assert.deepEqual(await success.processOne(item.tenantId), {
    kind: "COMPLETED", jobId: item.id, signalId: item.signalId,
  });
  assert.deepEqual(events, ["signal", "complete"]);

  let failed: Parameters<WorkflowSignalOutboxPort["fail"]>[0] | undefined;
  const retry = new WorkflowSignalOutboxProcessor({
    async claimNext() { return item; }, async complete() { throw new Error("must not complete"); },
    async fail(input) { failed = input; },
  }, { async signal() { throw new Error("Temporal unavailable"); } }, "control-signal-outbox-01",
  () => new Date("2030-01-01T00:00:00.000Z"));
  assert.deepEqual(await retry.processOne(item.tenantId), {
    kind: "FAILED", jobId: item.id, terminal: false, errorCode: "TEMPORAL_SIGNAL_FAILED",
  });
  assert.equal(failed?.retryAt, "2030-01-01T00:00:05.000Z");
});

test("Postgres workflow signal outbox claims under tenant RLS with a fenced lease", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const signal = { signalId: "user-accepted-signal-001", type: "USER_ACCEPTED" } as const;
  const signalDigest = createHash("sha256")
    .update(JSON.stringify({ signalId: signal.signalId, type: signal.type }))
    .digest("hex");
  const statements: string[] = [];
  const values: (readonly unknown[] | undefined)[] = [];
  let released = false;
  const store = new PostgresWorkflowSignalOutbox({
    async connect() {
      return {
        async query<Row>(statement: string, parameters?: readonly unknown[]) {
          statements.push(statement);
          values.push(parameters);
          if (statement.includes("RETURNING item.id")) return { rows: [{
            id: "44444444-4444-4444-8444-444444444444", tenant_id: tenantId,
            workflow_id: "delivery-001", signal_id: signal.signalId, signal_digest: signalDigest,
            signal, attempt: 1, claim_token: "55555555-5555-4555-8555-555555555555",
          }] as Row[], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release() { released = true; },
      };
    },
  });
  const claimed = await store.claimNext({ tenantId, workerId: "control-signal-outbox-01", leaseSeconds: 60 });
  assert.equal(claimed?.signalId, signal.signalId);
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements[1], "SELECT set_config('app.tenant_id', $1, true)");
  assert.deepEqual(values[1], [tenantId]);
  assert.match(statements[2] ?? "", /FOR UPDATE SKIP LOCKED/);
  assert.match(statements[2] ?? "", /claim_expires_at = now\(\) \+ \(\$4::int \* interval '1 second'\)/);
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(released, true);
});

test("workflow action completion HTTP route derives authority outside the request body", async () => {
  const server = Fastify({ logger: false });
  let authorized = false;
  let observed: Record<string, unknown> | undefined;
  registerWorkflowActionCompletionRoute(server, {
    authorize() {
      if (!authorized) throw new Error("unauthorized");
      return "MFA_BROKER";
    },
    store: {
      async complete(input) {
        observed = input as unknown as Record<string, unknown>;
        return {
          actionId: input.actionId, outboxId: "44444444-4444-4444-8444-444444444444",
          workflowId: input.workflowId, signalId: input.signal.signalId,
          signalDigest: "a".repeat(64), state: "PENDING_DELIVERY", replayed: false,
        };
      },
    },
  });
  const payload = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    workflowId: "delivery-001", sourceReceiptId: "mfa-broker-receipt-001",
    signal: { signalId: "mfa-approved-signal-001", type: "MFA_APPROVED", approvalId: "approval-001" },
  };
  const unauthorized = await server.inject({
    method: "POST", url: "/v1/workflow-actions/33333333-3333-4333-8333-333333333333/complete", payload,
  });
  assert.equal(unauthorized.statusCode, 401);
  authorized = true;
  const accepted = await server.inject({
    method: "POST", url: "/v1/workflow-actions/33333333-3333-4333-8333-333333333333/complete", payload,
  });
  assert.equal(accepted.statusCode, 202);
  assert.equal(observed?.source, "MFA_BROKER");
  assert.equal("source" in payload, false);
  const spoofed = await server.inject({
    method: "POST", url: "/v1/workflow-actions/33333333-3333-4333-8333-333333333333/complete",
    payload: { ...payload, source: "SPEC_SERVICE" },
  });
  assert.equal(spoofed.statusCode, 400);
  const unknownSignal = await server.inject({
    method: "POST", url: "/v1/workflow-actions/33333333-3333-4333-8333-333333333333/complete",
    payload: { ...payload, signal: { signalId: "unknown-signal-001", type: "UNKNOWN" } },
  });
  assert.equal(unknownSignal.statusCode, 400);
  await server.close();
});

test("workflow completion SPIFFE source configuration accepts only fixed source roles", () => {
  const sources = workflowCompletionSourceMapFromEnv({
    DEVILUDO_WORKFLOW_COMPLETION_SPIFFE_SOURCES_JSON: JSON.stringify({
      "spiffe://deviludo.internal/broker/mfa": "MFA_BROKER",
      "spiffe://deviludo.internal/service/spec": "SPEC_SERVICE",
      "spiffe://deviludo.internal/service/agent-configuration": "AGENT_CONFIGURATION_SERVICE",
    }),
  });
  assert.equal(sources.get("spiffe://deviludo.internal/broker/mfa"), "MFA_BROKER");
  assert.equal(sources.get("spiffe://deviludo.internal/service/agent-configuration"), "AGENT_CONFIGURATION_SERVICE");
  assert.throws(() => workflowCompletionSourceMapFromEnv({
    DEVILUDO_WORKFLOW_COMPLETION_SPIFFE_SOURCES_JSON: JSON.stringify({
      "https://not-spiffe.example": "MFA_BROKER",
    }),
  }), /source map is invalid/);
});
