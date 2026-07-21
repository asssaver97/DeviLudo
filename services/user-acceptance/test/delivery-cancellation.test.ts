import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowSignalPort } from "../../temporal/src/job-processor";
import type { PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import { specDigest } from "../../spec-dialogue/src/store";
import { createUserAcceptanceHandler } from "../src/ingress-http";
import {
  DeliveryCancellationConflict,
  DeliveryCancellationRequestError,
  DeliveryCancellationService,
  PostgresDeliveryCancellationStore,
  type DeliveryCancellationDecision,
  type DeliveryCancellationReceipt,
  type DeliveryCancellationStore,
} from "../src/delivery-cancellation";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const workflowId = "delivery-33333333-3333-4333-8333-333333333333";
const actorId = "55555555-5555-4555-8555-555555555555";
const command = Object.freeze({
  operationKey: "a".repeat(64),
  tenantId,
  projectId,
  actorId,
  reason: "需求方向已改变，停止本轮开发。",
});
const decision: DeliveryCancellationDecision = Object.freeze({
  ...command,
  workflowId,
  projectionSequence: 7,
  projectionKey: `delivery-projection:${"b".repeat(64)}`,
  projectionState: "DEVELOPING",
  projectionDigest: "c".repeat(64),
  signalId: "cancel-44444444-4444-4444-8444-444444444444",
  requestedAt: "2026-07-21T06:00:00.000Z",
});

test("delivery cancellation emits only a projection-bound idempotent Temporal signal", async () => {
  const signals: Parameters<WorkflowSignalPort["signal"]>[] = [];
  const store = new MemoryCancellationStore();
  const service = new DeliveryCancellationService(store, {
    async signal(...input) { signals.push(input); },
  });
  const receipt = await service.cancel(command);
  assert.equal(receipt.state, "CANCEL_REQUESTED");
  assert.equal(store.completed, 1);
  assert.deepEqual(signals, [[workflowId, {
    signalId: decision.signalId,
    type: "CANCEL",
    reason: command.reason,
    expectedState: "DEVELOPING",
    expectedHistoryLength: 7,
  }]]);
  assert.equal("workflowId" in command, false);
  assert.equal("expectedState" in command, false);
});

test("completed cancellation replay never sends a second Temporal signal", async () => {
  const receipt: DeliveryCancellationReceipt = Object.freeze({
    ...decision,
    state: "CANCEL_REQUESTED",
    deliveredAt: "2026-07-21T06:00:01.000Z",
  });
  let signalCalls = 0;
  const service = new DeliveryCancellationService({
    async begin() { return { kind: "COMPLETED", receipt }; },
    async complete() { throw new Error("unused"); },
    async probe() {},
  }, { async signal() { signalCalls += 1; } });
  assert.deepEqual(await service.cancel(command), receipt);
  assert.equal(signalCalls, 0);
});

test("delivery cancellation rejects browser authority and an irreversible-boundary conflict", async () => {
  const service = new DeliveryCancellationService(new MemoryCancellationStore(), { async signal() {} });
  await assert.rejects(
    service.cancel({ ...command, workflowId }),
    DeliveryCancellationRequestError,
  );
  await assert.rejects(
    new DeliveryCancellationService({
      async begin() { return { kind: "CONFLICT" }; },
      async complete() { throw new Error("unused"); },
      async probe() {},
    }, { async signal() {} }).cancel(command),
    DeliveryCancellationConflict,
  );
});

test("PostgreSQL cancellation derives active workflow and exact projection under tenant RLS", async () => {
  let inserted: readonly unknown[] | undefined;
  const statements: string[] = [];
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      statements.push(sql);
      if (sql.includes("FROM deviludo.delivery_cancellation_requests")) {
        if (!inserted) return rows<Row>([]);
        return rows<Row>([{
          operation_key: command.operationKey,
          tenant_id: tenantId,
          project_id: projectId,
          actor_id: command.actorId,
          request_digest: specDigest(command),
          reason: command.reason,
          workflow_id: workflowId,
          projection_sequence: 7,
          projection_key: decision.projectionKey,
          projection_state: "DEVELOPING",
          projection_digest: decision.projectionDigest,
          signal_id: inserted[11],
          state: "PENDING_DELIVERY",
          requested_at: inserted[12],
          completion_receipt: null,
        }]);
      }
      if (sql.includes("FROM deviludo.delivery_state_projections projection")) return rows<Row>([{
        workflow_id: workflowId,
        projection_sequence: 7,
        projection_key: decision.projectionKey,
        projection_state: "DEVELOPING",
        projection_digest: decision.projectionDigest,
      }]);
      if (sql.includes("INSERT INTO deviludo.delivery_cancellation_requests")) {
        inserted = values;
        return result<Row>(1);
      }
      return result<Row>(0);
    },
    release() { statements.push("RELEASE"); },
  };
  const store = new PostgresDeliveryCancellationStore({ async connect() { return client; } });
  const outcome = await store.begin(command);
  assert.equal(outcome.kind, "PENDING_DELIVERY");
  if (outcome.kind !== "PENDING_DELIVERY") throw new Error("cancellation decision missing");
  assert.equal(outcome.decision.workflowId, workflowId);
  assert.equal(outcome.decision.projectionState, "DEVELOPING");
  assert.match(outcome.decision.signalId, /^cancel-[a-f0-9-]{36}$/);
  assert.match(statements[1] ?? "", /set_config\('app\.tenant_id'/);
  const authorityQuery = statements.find((value) => value.includes("delivery_state_projections")) ?? "";
  assert.match(authorityQuery, /delivery\.state = 'ACTIVE'/);
  assert.match(authorityQuery, /membership\.role IN \('TenantAdmin', 'ProjectOwner'\)/);
  assert.match(authorityQuery, /membership\.status = 'ACTIVE'/);
  assert.match(authorityQuery, /projection\.state NOT IN \('READY_TO_PUBLISH', 'RELEASED', 'CANCELLED'\)/);
  assert.match(authorityQuery, /FOR SHARE OF projection, delivery, membership/);
});

test("mTLS ingress exposes the cancellation command without accepting workflow authority", async () => {
  const identity = {
    spiffeId: "spiffe://deviludo.internal/web",
    certificateFingerprint: "d".repeat(64),
    certificateSerial: "01",
    certificateNotAfter: "2030-01-01T00:00:00.000Z",
  };
  const handler = createUserAcceptanceHandler({
    service: { async submit() { throw new Error("unused"); }, async probe() {} },
    acceptance: { async accept() { throw new Error("unused"); }, async probe() {} },
    cancellation: new DeliveryCancellationService(new MemoryCancellationStore(), { async signal() {} }),
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => identity,
  });
  const response = await handler({
    method: "POST",
    path: "/v1/delivery-cancellations",
    headers: { "content-type": "application/json" },
    socket: {},
    rawBody: JSON.stringify(command),
  });
  assert.equal(response.status, 201);
  assert.equal((response.body.data as DeliveryCancellationReceipt).state, "CANCEL_REQUESTED");
  const injected = await handler({
    method: "POST",
    path: "/v1/delivery-cancellations",
    headers: { "content-type": "application/json" },
    socket: {},
    rawBody: JSON.stringify({ ...command, projectionState: "DEVELOPING" }),
  });
  assert.equal(injected.status, 400);
});

class MemoryCancellationStore implements DeliveryCancellationStore {
  completed = 0;
  async begin() { return Object.freeze({ kind: "PENDING_DELIVERY" as const, decision }); }
  async complete(value: DeliveryCancellationDecision) {
    this.completed += 1;
    return Object.freeze({
      ...value,
      state: "CANCEL_REQUESTED" as const,
      deliveredAt: "2026-07-21T06:00:01.000Z",
    });
  }
  async probe() {}
}

function rows<Row extends Record<string, unknown>>(values: readonly Record<string, unknown>[]) {
  return { rowCount: values.length, rows: values as readonly Row[] };
}
function result<Row extends Record<string, unknown>>(rowCount: number) {
  return { rowCount, rows: [] as readonly Row[] };
}
