import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DELIVERY_PROJECTION_SCHEMA_VERSION,
  canonicalDeliveryJson,
  deliveryProjectionKey,
  parseDeliveryProjectionRequest,
  parseDeliverySnapshot,
  type DeliveryProjectionRequest,
} from "../../../lib/orchestration/delivery-projection";
import { GameDeliveryWorkflow, type DeliverySnapshot } from "../../../lib/orchestration/game-delivery";
import { createDeliveryProjectionHandler } from "../src/http";
import {
  DeliveryProjectionConflictError,
  PostgresDeliveryProjectionStore,
  type DeliveryProjectionStore,
  type DeliveryProjectionView,
} from "../src/store";
import type { PostgresQueryResult, PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const workflowId = "delivery-33333333-3333-4333-8333-333333333333";
const writerId = "spiffe://deviludo.internal/control/temporal-worker";
const readerId = "spiffe://deviludo.internal/control/web";

function snapshots() {
  const machine = new GameDeliveryWorkflow({ workflowId, tenantId, projectId, targetMatrix: ["linux", "macos", "windows"] });
  const initial = machine.current() as DeliverySnapshot;
  const waiting = machine.signal({ signalId: "signal:spec-ready:0001", type: "SPEC_READY", specRevisionId: "spec-revision-001" }) as DeliverySnapshot;
  return { initial, waiting };
}

function request(snapshot: DeliverySnapshot): DeliveryProjectionRequest {
  return Object.freeze({
    schemaVersion: DELIVERY_PROJECTION_SCHEMA_VERSION,
    projectionKey: deliveryProjectionKey(snapshot),
    snapshot,
  });
}

test("projection parser accepts only the exact deterministic replay", () => {
  const { initial, waiting } = snapshots();
  assert.deepEqual(parseDeliverySnapshot(initial), initial);
  assert.deepEqual(parseDeliveryProjectionRequest(request(waiting)), request(waiting));
  assert.throws(() => parseDeliverySnapshot({ ...waiting, state: "RELEASED" }), /does not match deterministic workflow replay/);
  const history = structuredClone(waiting.history) as unknown as Array<Record<string, unknown>>;
  history[0] = { ...history[0], signal: { ...(history[0]!.signal as object), apiKey: "must-not-pass" } };
  assert.throws(() => parseDeliverySnapshot({ ...waiting, history }), /fields are invalid/);
  assert.throws(() => parseDeliveryProjectionRequest({ ...request(waiting), projectionKey: "wrong" }), /binding is invalid/);
});

test("projection replay remains compatible with pre-patch terminal-run repair histories", () => {
  const machine = new GameDeliveryWorkflow({
    workflowId, tenantId, projectId, targetMatrix: ["linux"], automaticRepairSuccessorRuns: false,
  });
  machine.signal({ signalId: "legacy-001", type: "SPEC_READY", specRevisionId: "spec-r1" });
  machine.signal({ signalId: "legacy-002", type: "SPEC_APPROVED", approvedSpecRevisionId: "spec-r1", testPlanRevisionId: "plan-r1", approvalReceiptId: "approval-r1" });
  machine.signal({ signalId: "legacy-003", type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: "lock-r1" });
  machine.signal({ signalId: "legacy-004", type: "AGENT_STARTED", runId: "run-r1" });
  machine.signal({ signalId: "legacy-005", type: "AGENT_COMPLETED", candidateCommitSha: "a".repeat(40), draftPullRequest: 17 });
  const legacy = machine.signal({ signalId: "legacy-006", type: "E2E_FAILED", evidenceBundleId: "evidence-r1", repairPromptId: "repair:r1" }) as DeliverySnapshot;
  assert.equal(legacy.state, "DEVELOPMENT_QUEUED");
  assert.equal(legacy.repairContext, null);
  assert.deepEqual(parseDeliverySnapshot(legacy), legacy);
});

class MemoryStore implements DeliveryProjectionStore {
  current: DeliveryProjectionView | null = null;
  async persist(input: DeliveryProjectionRequest) {
    const snapshotDigest = createHash("sha256").update(canonicalDeliveryJson(input.snapshot)).digest("hex");
    this.current = { snapshot: input.snapshot, snapshotDigest, projectedAt: "2026-07-18T00:00:00.000Z" };
    return {
      receiptId: "44444444-4444-4444-8444-444444444444",
      acceptedAt: this.current.projectedAt,
      projectionKey: input.projectionKey,
      workflowId: input.snapshot.workflowId,
      sequence: input.snapshot.history.length,
      state: input.snapshot.state,
      snapshotDigest,
      replayed: false,
    };
  }
  async read(readTenantId: string, readProjectId: string) {
    return readTenantId === tenantId && readProjectId === projectId ? this.current : null;
  }
  async probe() {}
}

test("mTLS projection ingress separates Temporal writes from Web reads", async () => {
  const store = new MemoryStore();
  const handler = createDeliveryProjectionHandler({
    store,
    writerSpiffeIds: new Set([writerId]),
    readerSpiffeIds: new Set([readerId]),
    extractIdentity(socket) { return identity(String(socket)); },
  });
  const projection = request(snapshots().initial);
  const base = {
    path: "/v1/delivery-projections",
    rawBody: JSON.stringify(projection),
    headers: {
      "content-type": "application/json",
      "idempotency-key": projection.projectionKey,
      "x-deviludo-workflow-id": workflowId,
    },
  } as const;
  const forbiddenWrite = await handler({ ...base, method: "POST", socket: readerId });
  assert.equal(forbiddenWrite.status, 403);
  const accepted = await handler({ ...base, method: "POST", socket: writerId });
  assert.equal(accepted.status, 201);

  const read = {
    method: "GET",
    path: `/v1/delivery-projections/${projectId}`,
    headers: { "x-deviludo-tenant-id": tenantId },
    rawBody: "",
  } as const;
  assert.equal((await handler({ ...read, socket: writerId })).status, 403);
  const result = await handler({ ...read, socket: readerId });
  assert.equal(result.status, 200);
  assert.deepEqual((result.body.data as DeliveryProjectionView).snapshot, projection.snapshot);
});

test("projection ingress rejects identity overlap and transport drift", async () => {
  const store = new MemoryStore();
  assert.throws(() => createDeliveryProjectionHandler({
    store,
    writerSpiffeIds: new Set([writerId]),
    readerSpiffeIds: new Set([writerId]),
  }), /must be separated/);
  const handler = createDeliveryProjectionHandler({
    store,
    writerSpiffeIds: new Set([writerId]),
    readerSpiffeIds: new Set([readerId]),
    extractIdentity(socket) { return identity(String(socket)); },
  });
  const projection = request(snapshots().initial);
  const response = await handler({
    method: "POST",
    path: "/v1/delivery-projections",
    socket: writerId,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "drifted",
      "x-deviludo-workflow-id": workflowId,
    },
    rawBody: JSON.stringify(projection),
  });
  assert.equal(response.status, 400);
});

test("PostgreSQL projection store sets tenant RLS and advances without gaps", async () => {
  const machine = new GameDeliveryWorkflow({ workflowId, tenantId, projectId, targetMatrix: ["linux", "macos", "windows"] });
  const initial = machine.current() as DeliverySnapshot;
  const waiting = machine.signal({ signalId: "signal:spec-ready:0002", type: "SPEC_READY", specRevisionId: "spec-revision-002" }) as DeliverySnapshot;
  const resolving = machine.signal({
    signalId: "signal:spec-approved:0002",
    type: "SPEC_APPROVED",
    approvedSpecRevisionId: "spec-revision-002",
    testPlanRevisionId: "test-plan-revision-002",
    approvalReceiptId: "approval-receipt-002",
  }) as DeliverySnapshot;
  const database = new ProjectionDatabase();
  const store = new PostgresDeliveryProjectionStore({ async connect() { return database.client(); } });

  assert.equal((await store.persist(request(initial))).replayed, false);
  assert.equal((await store.persist(request(initial))).replayed, true);
  await assert.rejects(store.persist(request(resolving)), DeliveryProjectionConflictError);
  assert.equal((await store.persist(request(waiting))).sequence, 1);
  assert.deepEqual((await store.read(tenantId, projectId))?.snapshot, waiting);
  assert.ok(database.statements.some((statement) => statement.includes("set_config('app.tenant_id'")));
  const firstTableStatement = database.statements.findIndex((statement) => statement.includes("deviludo.delivery_state_"));
  const firstTenantStatement = database.statements.findIndex((statement) => statement.includes("set_config('app.tenant_id'"));
  assert.ok(firstTenantStatement >= 0 && firstTenantStatement < firstTableStatement);
});

class ProjectionDatabase {
  readonly statements: string[] = [];
  readonly events = new Map<string, Record<string, unknown>>();
  current: Record<string, unknown> | null = null;
  client(): PostgresWorkflowClient {
    return {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        const cast = (rowCount: number, rows: readonly Record<string, unknown>[]) => ({ rowCount, rows }) as unknown as PostgresQueryResult<Row>;
        this.statements.push(text);
        if (text.includes("FROM deviludo.spec_delivery_workflows")) {
          return cast(1, [{ target_matrix: ["linux", "macos", "windows"] }]);
        }
        if (text.includes("INSERT INTO deviludo.delivery_state_projection_events")) {
          const key = String(values?.[4]);
          if (!this.events.has(key)) this.events.set(key, {
            id: "55555555-5555-4555-8555-555555555555",
            tenant_id: values?.[0], project_id: values?.[1], workflow_id: values?.[2],
            projection_sequence: values?.[3], projection_key: key, state: values?.[5],
            snapshot_digest: values?.[6], snapshot: JSON.parse(String(values?.[7])),
            recorded_at: "2026-07-18T00:00:00.000Z",
          });
          return cast(1, []);
        }
        if (text.includes("FROM deviludo.delivery_state_projection_events")) {
          const row = this.events.get(String(values?.[1]));
          return cast(row ? 1 : 0, row ? [row] : []);
        }
        if (text.includes("FROM deviludo.delivery_state_projections")) {
          const row = this.current && this.current.tenant_id === values?.[0] && this.current.project_id === values?.[1]
            ? this.current : null;
          return cast(row ? 1 : 0, row ? [row] : []);
        }
        if (text.includes("INSERT INTO deviludo.delivery_state_projections")) {
          this.current = {
            tenant_id: values?.[0], project_id: values?.[1], workflow_id: values?.[2],
            projection_sequence: values?.[3], projection_key: values?.[4], state: values?.[5],
            snapshot_digest: values?.[6], snapshot: JSON.parse(String(values?.[7])), updated_at: values?.[8],
          };
          return cast(1, []);
        }
        if (text.includes("UPDATE deviludo.delivery_state_projections")) {
          if (!this.current || this.current.projection_sequence !== values?.[8]) return cast(0, []);
          this.current = {
            ...this.current,
            projection_sequence: values?.[3], projection_key: values?.[4], state: values?.[5],
            snapshot_digest: values?.[6], snapshot: JSON.parse(String(values?.[7])),
            updated_at: "2026-07-18T00:00:00.001Z",
          };
          return cast(1, [{ projection_key: values?.[4] }]);
        }
        if (text === "SELECT 1 AS ready") return cast(1, [{ ready: 1 }]);
        return cast(0, []);
      },
      release() {},
    };
  }
}

function identity(spiffeId: string) {
  return {
    spiffeId,
    certificateFingerprint: "AA:BB",
    certificateSerial: "01",
    certificateNotAfter: "2027-07-18T00:00:00.000Z",
  };
}
