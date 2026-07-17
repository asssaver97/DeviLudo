import assert from "node:assert/strict";
import test from "node:test";
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

const digest = "b".repeat(64);
const base: DeliverySnapshot = Object.freeze({
  workflowId: "delivery-001", tenantId: "tenant-001", projectId: "project-001", state: "IDEATION",
  specRevisionId: null, lockedRunConfigurationId: null, runId: null, candidateCommitSha: null,
  draftPullRequest: null, mainCommitSha: null, evidenceBundleId: null, candidateEvidenceBundleId: null,
  mainEvidenceBundleId: null, steamInstallEvidenceBundleId: null, mfaApprovalId: null, steamBuildId: null,
  steamReleaseId: null, defaultBranchBuildId: null, targetMatrix: Object.freeze(["linux", "macos", "windows"] as const),
  iteration: 1, repairAttempts: 0, waitingProviderRevisionId: null, externalGate: null,
  externalApprovals: Object.freeze([]), history: Object.freeze([]),
});

function snapshotFor(operation: ControlPlaneWorkflowAction): DeliverySnapshot {
  if (operation === "CONTINUE_IDEA_DIALOGUE") return base;
  if (operation === "REQUEST_SPEC_APPROVAL") return Object.freeze({ ...base, state: "WAITING_SPEC_APPROVAL", specRevisionId: "spec-r1" });
  if (operation === "WAIT_FOR_PROVIDER") return Object.freeze({
    ...base, state: "WAITING_PROVIDER", lockedRunConfigurationId: "lock-r1", waitingProviderRevisionId: "provider-r7",
  });
  if (operation === "REQUEST_USER_ACCEPTANCE") return Object.freeze({
    ...base, state: "WAITING_USER_ACCEPTANCE", specRevisionId: "spec-r1", candidateCommitSha: "c".repeat(40),
    draftPullRequest: 91, evidenceBundleId: "candidate-evidence-1", candidateEvidenceBundleId: "candidate-evidence-1",
  });
  if (operation === "REQUEST_FRESH_MFA") return Object.freeze({
    ...base, state: "WAITING_MFA", mainCommitSha: "d".repeat(40), evidenceBundleId: "main-evidence-1",
    mainEvidenceBundleId: "main-evidence-1",
  });
  if (operation === "WAIT_FOR_EXTERNAL_APPROVAL") return Object.freeze({
    ...base, state: "EXTERNAL_APPROVAL_REQUIRED", steamBuildId: "91234567", evidenceBundleId: "steam-evidence-1",
    steamInstallEvidenceBundleId: "steam-evidence-1", externalGate: "VALVE_REVIEW",
  });
  const cancelSignal: DeliverySignal = Object.freeze({ signalId: "cancel-signal-0001", type: "CANCEL", reason: "user cancelled" });
  return Object.freeze({
    ...base, state: "CANCELLED", history: Object.freeze([{ sequence: 1, signal: cancelSignal, resultingState: "CANCELLED" as const }]),
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
  };
}

test("control-plane workflow handler registers every user or external wait with exact bindings", async () => {
  const observed: Parameters<ControlPlaneWorkflowPort["ensureAction"]>[0][] = [];
  const handler = new ControlPlaneWorkflowHandler({ async ensureAction(input) {
    observed.push(input);
    return receipt(input.operation);
  } });
  const operations: ControlPlaneWorkflowAction[] = [
    "CONTINUE_IDEA_DIALOGUE", "REQUEST_SPEC_APPROVAL", "WAIT_FOR_PROVIDER", "REQUEST_USER_ACCEPTANCE",
    "REQUEST_FRESH_MFA", "WAIT_FOR_EXTERNAL_APPROVAL", "CANCEL_DELIVERY",
  ];
  for (const operation of operations) {
    const outcome = await handler.execute(job(operation), { async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; } });
    assert.equal(outcome.result.operation, operation);
  }
  assert.equal(observed[2]?.binding.providerRevisionId, "provider-r7");
  assert.equal(observed[3]?.binding.candidateCommitSha, "c".repeat(40));
  assert.equal(observed[4]?.binding.mainCommitSha, "d".repeat(40));
  assert.equal(observed[5]?.binding.externalGate, "VALVE_REVIEW");
  assert.equal(observed[6]?.binding.cancellationReason, "user cancelled");
});

test("control-plane workflow handler never emits a completion signal from a registered wait", async () => {
  const handler = new ControlPlaneWorkflowHandler({ async ensureAction(input) { return receipt(input.operation); } });
  const outcome = await handler.execute(job("REQUEST_USER_ACCEPTANCE"), {
    async heartbeat() { return "renewed"; }, async emitSignal() { throw new Error("must not emit"); },
  });
  assert.equal("signal" in outcome, false);
  assert.equal(outcome.result.status, "WAITING");
});

test("control-plane workflow handler rejects state, receipt and cancellation drift terminally", async () => {
  const handler = new ControlPlaneWorkflowHandler({ async ensureAction(input) { return receipt(input.operation); } });
  await assert.rejects(handler.execute(job("REQUEST_SPEC_APPROVAL", base), {
    async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; },
  }), /CONTROL_PLANE_BINDING_INVALID/);

  const drift = new ControlPlaneWorkflowHandler({ async ensureAction(input) {
    return { ...receipt(input.operation), requestDigest: "a".repeat(64) };
  } });
  await assert.rejects(drift.execute(job("REQUEST_FRESH_MFA"), {
    async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; },
  }), /CONTROL_PLANE_RECEIPT_DRIFT/);

  const invalidCancel = Object.freeze({ ...snapshotFor("CANCEL_DELIVERY"), history: Object.freeze([]) });
  await assert.rejects(handler.execute(job("CANCEL_DELIVERY", invalidCancel), {
    async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; },
  }), /CONTROL_PLANE_BINDING_INVALID/);
});

test("Postgres control-plane action store applies RLS and replays only an exact binding", async () => {
  const sql: string[] = [];
  const values: (readonly unknown[] | undefined)[] = [];
  let released = false;
  const binding = Object.freeze({
    state: "WAITING_SPEC_APPROVAL", specRevisionId: "spec-r1", lockedRunConfigurationId: null,
    providerRevisionId: null, candidateCommitSha: null, draftPullRequest: null, evidenceBundleId: null,
    mainCommitSha: null, steamBuildId: null, externalGate: null, cancellationReason: null,
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
  assert.equal(result.actionId, `control-action:${row.id}`);
  assert.equal(heartbeats, 1);
  assert.equal(sql[0], "BEGIN");
  assert.equal(sql[1], "SELECT set_config('app.current_tenant', $1, true)");
  assert.deepEqual(values[1], [row.tenant_id]);
  assert.match(sql[2] ?? "", /INSERT INTO deviludo\.workflow_control_actions/);
  assert.equal(sql.at(-1), "COMMIT");
  assert.equal(released, true);
});

test("Postgres control-plane action store rolls back an idempotency collision", async () => {
  const sql: string[] = [];
  const binding = Object.freeze({
    state: "IDEATION", specRevisionId: null, lockedRunConfigurationId: null, providerRevisionId: null,
    candidateCommitSha: null, draftPullRequest: null, evidenceBundleId: null, mainCommitSha: null,
    steamBuildId: null, externalGate: null, cancellationReason: null,
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
