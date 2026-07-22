import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { WorkflowActionCompletionPort } from "../../control-plane/src/workflow-action-completion-postgres";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import {
  parseSpecWorkflowApprovalRequest,
  specWorkflowEventKey,
  specWorkflowRequestDigest,
  type SpecWorkflowEvent,
} from "../src/contracts";
import { createSpecWorkflowHandler } from "../src/ingress-http";
import { PostgresSpecWorkflowBridgeStore, type SpecDeliveryWorkflow } from "../src/postgres-store";
import { SpecWorkflowBridgeService, TemporalSpecWorkflowPort } from "../src/service";
import { SpecWorkflowBridgeWorker } from "../src/worker";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const draftSpecRevisionId = "44444444-4444-4444-8444-444444444444";
const draftTestPlanRevisionId = "55555555-5555-4555-8555-555555555555";
const approvedSpecRevisionId = "66666666-6666-4666-8666-666666666666";
const approvedTestPlanRevisionId = "77777777-7777-4777-8777-777777777777";
const actionId = "88888888-8888-4888-8888-888888888888";
const outboxId = "99999999-9999-4999-8999-999999999999";
const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operationKey = "b".repeat(64);

const approval = Object.freeze({
  schemaVersion: "deviludo.spec-workflow-approval.v1" as const,
  operationKey, tenantId, projectId, conversationId,
  draftSpecRevisionId, draftTestPlanRevisionId,
  approvedSpecRevisionId, approvedSpecDigest: "c".repeat(64),
  approvedTestPlanRevisionId, approvedTestPlanDigest: "d".repeat(64),
  targetMatrix: ["linux", "windows"] as const,
  godotVersion: "4.5.0", approvedAt: "2026-07-18T10:00:00.000Z",
});

test("approval contract is exact, version-pinned and canonical", () => {
  const parsed = parseSpecWorkflowApprovalRequest(approval);
  assert.deepEqual(parsed.targetMatrix, ["linux", "windows"]);
  assert.match(specWorkflowRequestDigest(parsed), /^[a-f0-9]{64}$/);
  assert.notEqual(specWorkflowEventKey(operationKey, "SPEC_READY"), specWorkflowEventKey(operationKey, "SPEC_APPROVED"));
  assert.throws(() => parseSpecWorkflowApprovalRequest({ ...approval, extra: true }));
  assert.throws(() => parseSpecWorkflowApprovalRequest({ ...approval, targetMatrix: ["windows", "linux"] }));
  assert.throws(() => parseSpecWorkflowApprovalRequest({ ...approval, godotVersion: "latest" }));
});

test("PostgreSQL enqueue re-resolves approval authority under tenant RLS and creates ordered durable events", async () => {
  const statements: string[] = [];
  const requestDigest = specWorkflowRequestDigest(approval);
  const readyDigest = digest(`SPEC_READY\0${requestDigest}`);
  const approvedDigest = digest(`SPEC_APPROVED\0${requestDigest}`);
  const readyEventKey = specWorkflowEventKey(operationKey, "SPEC_READY");
  const approvalEventKey = specWorkflowEventKey(operationKey, "SPEC_APPROVED");
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(sql: string) {
      statements.push(sql);
      if (sql.includes("FROM deviludo.spec_conversations conversation")) return rows<Row>([{
        conversation_id: conversationId, conversation_state: "APPROVED",
        current_spec_revision_id: approvedSpecRevisionId,
        current_test_plan_revision_id: approvedTestPlanRevisionId,
        draft_spec_revision_id: draftSpecRevisionId,
        draft_test_plan_revision_id: draftTestPlanRevisionId,
        spec_digest: approval.approvedSpecDigest, test_plan_digest: approval.approvedTestPlanDigest,
        target_matrix: [...approval.targetMatrix], required_godot_version: approval.godotVersion,
        operation_state: "COMPLETED", operation_response: {
          operationKey, specRevisionId: approvedSpecRevisionId,
          testPlanRevisionId: approvedTestPlanRevisionId,
          specDigest: approval.approvedSpecDigest, testPlanDigest: approval.approvedTestPlanDigest,
        },
      }]);
      if (sql.includes("FROM deviludo.spec_delivery_workflows")) return rows<Row>([{
        tenant_id: tenantId, project_id: projectId, workflow_id: `delivery-${projectId}`,
        target_matrix: [...approval.targetMatrix], temporal_run_id: null, state: "PENDING_START",
      }]);
      if (sql.includes("FROM deviludo.spec_workflow_events")) return rows<Row>([
        eventRow(readyEventKey, "SPEC_READY", readyDigest),
        eventRow(approvalEventKey, "SPEC_APPROVED", approvedDigest),
      ]);
      if (sql.includes("INSERT INTO deviludo.spec_workflow_events")) return result<Row>(1);
      return result<Row>(sql.includes("INSERT INTO deviludo.spec_delivery_workflows") ? 1 : 0);
    },
    release() { statements.push("RELEASE"); },
  };
  const receipt = await new PostgresSpecWorkflowBridgeStore(pool(client)).enqueue(approval);
  assert.equal(receipt.workflowId, `delivery-${projectId}`);
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.state, "PENDING_DELIVERY");
  assert.match(statements[0] ?? "", /^BEGIN$/);
  assert.match(statements[1] ?? "", /set_config\('app\.tenant_id'/);
  assert.ok(statements.some((sql) => sql.includes("operation.operation_key = $4")));
  assert.ok(statements.some((sql) => sql.includes("INSERT INTO deviludo.spec_workflow_events")));
  assert.equal(statements.at(-2), "COMMIT");
  assert.equal(statements.at(-1), "RELEASE");
});

test("PostgreSQL enqueue rolls back before event creation when authoritative approval is absent", async () => {
  const statements: string[] = [];
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(sql: string) {
      statements.push(sql);
      if (sql.includes("FROM deviludo.spec_conversations conversation")) return rows<Row>([]);
      return result<Row>(0);
    },
    release() { statements.push("RELEASE"); },
  };
  await assert.rejects(new PostgresSpecWorkflowBridgeStore(pool(client)).enqueue(approval), /authority conflicts/);
  assert.equal(statements.includes("ROLLBACK"), true);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO deviludo.spec_workflow_events")), false);
});

test("a feedback iteration queues only approval and cannot deadlock on another initial-ready action", async () => {
  const approvalEventKey = specWorkflowEventKey(operationKey, "SPEC_APPROVED");
  const approvalDigest = digest(`SPEC_APPROVED\0${specWorkflowRequestDigest(approval)}`);
  const insertedEventTypes: unknown[] = [];
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      if (sql.includes("FROM deviludo.spec_conversations conversation")) return rows<Row>([{
        conversation_id: conversationId, conversation_state: "APPROVED",
        current_spec_revision_id: approvedSpecRevisionId,
        current_test_plan_revision_id: approvedTestPlanRevisionId,
        draft_spec_revision_id: draftSpecRevisionId, draft_test_plan_revision_id: draftTestPlanRevisionId,
        spec_digest: approval.approvedSpecDigest, test_plan_digest: approval.approvedTestPlanDigest,
        target_matrix: [...approval.targetMatrix], required_godot_version: approval.godotVersion,
        operation_state: "COMPLETED", operation_response: { operationKey,
          specRevisionId: approvedSpecRevisionId, testPlanRevisionId: approvedTestPlanRevisionId,
          specDigest: approval.approvedSpecDigest, testPlanDigest: approval.approvedTestPlanDigest },
      }]);
      if (sql.includes("FROM deviludo.spec_delivery_workflows")) return rows<Row>([{
        tenant_id: tenantId, project_id: projectId, workflow_id: `delivery-${projectId}`,
        target_matrix: [...approval.targetMatrix], temporal_run_id: "temporal-run-previous", state: "ACTIVE",
      }]);
      if (sql.includes("FROM deviludo.spec_workflow_events")) return rows<Row>([
        eventRow(approvalEventKey, "SPEC_APPROVED", approvalDigest),
      ]);
      if (sql.includes("INSERT INTO deviludo.spec_delivery_workflows")) return result<Row>(0);
      if (sql.includes("INSERT INTO deviludo.spec_workflow_events")) {
        insertedEventTypes.push(values?.[5]);
        return result<Row>(1);
      }
      return result<Row>(0);
    },
    release() {},
  };
  const receipt = await new PostgresSpecWorkflowBridgeStore(pool(client)).enqueue(approval);
  assert.equal(receipt.readyEventKey, null);
  assert.equal(receipt.approvalEventKey, approvalEventKey);
  assert.deepEqual(insertedEventTypes, ["SPEC_APPROVED"]);
});

test("bridge starts one workflow then completes the exact control action through the outbox", async () => {
  const event = workflowEvent("SPEC_APPROVED");
  const calls: string[] = [];
  const store = {
    async claimNext(id: string) { calls.push(`claim:${id}`); return event; },
    async workflow() { return pendingWorkflow(); },
    async markStarted(input: { temporalRunId: string }) { calls.push(`started:${input.temporalRunId}`); return activeWorkflow(); },
    async findWaitingAction() { calls.push("action"); return actionId; },
    async completeEvent(_event: SpecWorkflowEvent, action: string, outbox: string) { calls.push(`complete:${action}:${outbox}`); },
    async release() { calls.push("release"); },
    async enqueue() { throw new Error("unused"); }, async probe() {},
  } as unknown as PostgresSpecWorkflowBridgeStore;
  const temporal = {
    async probe() {},
    async ensureStarted() { calls.push("temporal"); return { temporalRunId: "temporal-run-001" }; },
  };
  const completionInputs: Parameters<WorkflowActionCompletionPort["complete"]>[0][] = [];
  const completions: WorkflowActionCompletionPort = {
    async complete(input) {
      completionInputs.push(input);
      return { actionId, outboxId, workflowId: input.workflowId, signalId: input.signal.signalId,
        signalDigest: "e".repeat(64), state: "PENDING_DELIVERY", replayed: false };
    },
  };
  const outcome = await new SpecWorkflowBridgeService(store, temporal, completions).processTenantOnce(tenantId);
  assert.equal(outcome, "COMPLETED");
  assert.equal(completionInputs[0]?.source, "SPEC_SERVICE");
  assert.deepEqual(completionInputs[0]?.signal, {
    signalId: `spec-approved-${event.eventKey}`, type: "SPEC_APPROVED",
    approvedSpecRevisionId, testPlanRevisionId: approvedTestPlanRevisionId,
    approvalReceiptId: operationKey,
  });
  assert.deepEqual(calls, [
    `claim:${tenantId}`, "temporal", "started:temporal-run-001", "action",
    `complete:${actionId}:${outboxId}`,
  ]);
});

test("bridge releases a claim while Temporal has not exposed the matching wait", async () => {
  const event = workflowEvent("SPEC_READY");
  let released = 0;
  const store = {
    async claimNext() { return event; }, async workflow() { return activeWorkflow(); },
    async findWaitingAction() { return null; }, async release() { released += 1; },
  } as unknown as PostgresSpecWorkflowBridgeStore;
  const service = new SpecWorkflowBridgeService(store, {
    async probe() {}, async ensureStarted() { throw new Error("unused"); },
  }, {
    async complete() { throw new Error("unused"); },
  });
  assert.equal(await service.processTenantOnce(tenantId), "WAITING_ACTION");
  assert.equal(released, 1);
});

test("worker uses signed control-plane assignments and drains bounded events per tenant", async () => {
  const destinations: string[] = [];
  let calls = 0;
  const worker = new SpecWorkflowBridgeWorker({
    async processTenantOnce() { calls += 1; return calls < 3 ? "COMPLETED" : "IDLE"; },
  }, {
    async listTenantIds(destination) { destinations.push(destination); return [tenantId]; },
  }, 100);
  assert.equal(await worker.runCycle(), 2);
  assert.deepEqual(destinations, ["control-plane"]);
  assert.equal(calls, 3);
});

test("ingress accepts only the allow-listed mTLS specification workload", async () => {
  const identity = { spiffeId: "spiffe://deviludo.internal/spec-dialogue/primary", certificateFingerprint: "f".repeat(64), certificateSerial: "01", certificateNotAfter: "2030-01-01T00:00:00.000Z" };
  const service = { async enqueue() { return { workflowId: `delivery-${projectId}`, readyEventKey: "1".repeat(64), approvalEventKey: "2".repeat(64), state: "PENDING_DELIVERY" as const, replayed: false }; }, async probe() {} };
  const handler = createSpecWorkflowHandler({ service, allowedSpiffeIds: new Set([identity.spiffeId]), extractIdentity: () => identity });
  const response = await handler({ method: "POST", path: "/v1/spec-approvals", headers: { "content-type": "application/json", "idempotency-key": operationKey }, socket: {}, rawBody: JSON.stringify(approval) });
  assert.equal(response.status, 202);
  assert.equal((await handler({ method: "POST", path: "/v1/spec-approvals", headers: { "content-type": "application/json", "idempotency-key": "0".repeat(64) }, socket: {}, rawBody: JSON.stringify(approval) })).status, 400);
  const forbidden = createSpecWorkflowHandler({ service, allowedSpiffeIds: new Set(["spiffe://deviludo.internal/other"]), extractIdentity: () => identity });
  assert.equal((await forbidden({ method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" })).status, 403);
});

test("Bridge readiness requires its complete schema and live Temporal transport", async () => {
  const tables = [
    "spec_conversations", "immutable_revisions", "approved_test_plan_bindings", "spec_dialogue_operations",
    "spec_delivery_workflows", "spec_workflow_events", "workflow_control_actions", "workflow_signal_outbox",
  ] as const;
  let missing: string | null = null;
  let temporalAvailable = true;
  let temporalProbes = 0;
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(sql: string) {
      assert.match(sql, /to_regclass\('deviludo\.workflow_signal_outbox'\)/);
      const row = Object.fromEntries(tables.map((table) => [table, `deviludo.${table}`])) as Record<string, unknown>;
      if (missing) row[missing] = null;
      return rows<Row>([row]);
    },
    release() {},
  };
  const service = new SpecWorkflowBridgeService(
    new PostgresSpecWorkflowBridgeStore(pool(client)),
    {
      async probe() { temporalProbes += 1; if (!temporalAvailable) throw new Error("private Temporal failure"); },
      async ensureStarted() { throw new Error("unused"); },
    },
    { async complete() { throw new Error("unused"); } },
  );
  await service.probe();
  assert.equal(temporalProbes, 1);
  missing = "spec_workflow_events";
  await assert.rejects(service.probe(), /conflicts/);
  missing = null;
  temporalAvailable = false;
  await assert.rejects(service.probe(), /private Temporal failure/);
});

test("Temporal readiness binds transport and the configured namespace identity", async () => {
  const calls: string[] = [];
  const port = new TemporalSpecWorkflowPort({
    options: { namespace: "deviludo-production" },
    workflowService: {
      async getSystemInfo() { calls.push("system"); return {}; },
      async describeNamespace(input: { namespace: string }) {
        calls.push(`namespace:${input.namespace}`);
        return { namespaceInfo: { name: "deviludo-production" } };
      },
    },
  } as never);
  await port.probe();
  assert.deepEqual(calls.sort(), ["namespace:deviludo-production", "system"]);

  const drifted = new TemporalSpecWorkflowPort({
    options: { namespace: "deviludo-production" },
    workflowService: {
      async getSystemInfo() { return {}; },
      async describeNamespace() { return { namespaceInfo: { name: "another-namespace" } }; },
    },
  } as never);
  await assert.rejects(drifted.probe(), /namespace identity/);
});

function pendingWorkflow(): SpecDeliveryWorkflow {
  return { tenantId, projectId, workflowId: `delivery-${projectId}`, targetMatrix: approval.targetMatrix, temporalRunId: null, state: "PENDING_START" };
}
function activeWorkflow(): SpecDeliveryWorkflow {
  return { ...pendingWorkflow(), temporalRunId: "temporal-run-001", state: "ACTIVE" };
}
function workflowEvent(eventType: SpecWorkflowEvent["eventType"]): SpecWorkflowEvent {
  return {
    eventKey: specWorkflowEventKey(operationKey, eventType), tenantId, projectId,
    workflowId: `delivery-${projectId}`, conversationId, eventType,
    requestDigest: digest(`${eventType}\0${specWorkflowRequestDigest(approval)}`),
    payload: approval, claimToken,
  };
}
function eventRow(eventKey: string, eventType: SpecWorkflowEvent["eventType"], requestDigest: string) {
  return { event_key: eventKey, tenant_id: tenantId, project_id: projectId,
    workflow_id: `delivery-${projectId}`, conversation_id: conversationId,
    event_type: eventType, request_digest: requestDigest, payload: approval,
    state: "PENDING", claim_token: null, workflow_action_id: null, completion_outbox_id: null };
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function pool(client: PostgresWorkflowClient): PostgresWorkflowPool { return { async connect() { return client; } }; }
function rows<Row extends Record<string, unknown>>(value: readonly Record<string, unknown>[]) {
  return { rowCount: value.length, rows: value as readonly Row[] };
}
function result<Row extends Record<string, unknown>>(rowCount: number) {
  return { rowCount, rows: [] as readonly Row[] };
}
