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
import { RUNNER_FLEET_PROJECTION_SCHEMA_VERSION } from "../../../lib/runner/fleet-projection";
import { EVIDENCE_CATALOG_SCHEMA_VERSION } from "../../../lib/evidence/catalog-projection";
import { canonicalJson as canonicalEvidenceJson } from "../../runner-control/src/canonical";

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

test("projection replay accepts bounded repair takeover and pre-budget successor histories", () => {
  const bounded = repairHistoryMachine();
  for (let attempt = 1; attempt <= 3; attempt += 1) failAgentAttempt(bounded, "bounded", attempt);
  const takeover = bounded.current() as DeliverySnapshot;
  assert.equal(takeover.state, "WAITING_SPEC_APPROVAL");
  assert.deepEqual(parseDeliverySnapshot(takeover), takeover);

  const unbounded = repairHistoryMachine(null);
  for (let attempt = 1; attempt <= 4; attempt += 1) failAgentAttempt(unbounded, "unbounded", attempt);
  const legacy = unbounded.current() as DeliverySnapshot;
  assert.equal(legacy.state, "RESOLVING_AGENT_CONFIGURATION");
  assert.equal(legacy.repairAttempts, 4);
  assert.deepEqual(parseDeliverySnapshot(legacy), legacy);
});

test("projection replay preserves an explicit post-merge failure handoff", () => {
  const machine = new GameDeliveryWorkflow({ workflowId, tenantId, projectId, targetMatrix: ["linux"] });
  machine.signal({ signalId: "postmerge-ready-001", type: "SPEC_READY", specRevisionId: "spec-r1" });
  machine.signal({
    signalId: "postmerge-approved-001", type: "SPEC_APPROVED", approvedSpecRevisionId: "spec-r1",
    testPlanRevisionId: "plan-r1", approvalReceiptId: "approval-r1",
  });
  machine.signal({ signalId: "postmerge-lock-001", type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: "lock-r1" });
  machine.signal({ signalId: "postmerge-start-001", type: "AGENT_STARTED", runId: "run-r1" });
  machine.signal({ signalId: "postmerge-complete-001", type: "AGENT_COMPLETED", candidateCommitSha: "a".repeat(40), draftPullRequest: 17 });
  machine.signal({ signalId: "postmerge-candidate-pass-001", type: "E2E_PASSED", evidenceBundleId: "candidate-evidence-r1" });
  machine.signal({ signalId: "postmerge-accepted-001", type: "USER_ACCEPTED" });
  machine.signal({ signalId: "postmerge-merged-001", type: "MAIN_MERGED", mainCommitSha: "b".repeat(40) });
  const failed = machine.signal({
    signalId: "postmerge-main-failed-001", type: "MAIN_E2E_FAILED",
    evidenceBundleId: "main-failed-evidence-r1", repairPromptId: "repair:main-failed-r1",
  }) as DeliverySnapshot;

  assert.equal(failed.state, "WAITING_SPEC_APPROVAL");
  assert.equal(failed.mainCommitSha, null);
  assert.equal(failed.repairContext?.reason, "MAIN_GATE_FAILURE");
  assert.equal(failed.repairContext?.candidateCommitSha, "b".repeat(40));
  assert.deepEqual(parseDeliverySnapshot(failed), failed);
});

test("projection replay preserves a terminal cancellation history", () => {
  const machine = new GameDeliveryWorkflow({ workflowId, tenantId, projectId, targetMatrix: ["linux"] });
  machine.signal({ signalId: "cancel-ready-001", type: "SPEC_READY", specRevisionId: "spec-r1" });
  const cancelled = machine.signal({
    signalId: "cancel-terminal-001", type: "CANCEL", reason: "project owner withdrew delivery",
    expectedState: "WAITING_SPEC_APPROVAL", expectedHistoryLength: 1,
  }) as DeliverySnapshot;
  assert.equal(cancelled.state, "CANCELLED");
  assert.deepEqual(parseDeliverySnapshot(cancelled), cancelled);
  assert.throws(
    () => parseDeliverySnapshot({ ...cancelled, state: "READY_TO_PUBLISH" }),
    /does not match deterministic workflow replay/,
  );
});

function repairHistoryMachine(automaticRepairLimit: number | null = 3) {
  const machine = new GameDeliveryWorkflow({
    workflowId, tenantId, projectId, targetMatrix: ["linux"], automaticRepairLimit,
  });
  machine.signal({ signalId: `repair-${automaticRepairLimit ?? "legacy"}-ready`, type: "SPEC_READY", specRevisionId: "spec-r1" });
  machine.signal({
    signalId: `repair-${automaticRepairLimit ?? "legacy"}-approved`, type: "SPEC_APPROVED",
    approvedSpecRevisionId: "spec-r1", testPlanRevisionId: "plan-r1", approvalReceiptId: "approval-r1",
  });
  return machine;
}

function failAgentAttempt(machine: GameDeliveryWorkflow, prefix: string, attempt: number) {
  machine.signal({ signalId: `${prefix}-lock-${attempt}`, type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: `${prefix}-lock-${attempt}` });
  machine.signal({ signalId: `${prefix}-start-${attempt}`, type: "AGENT_STARTED", runId: `${prefix}-run-${attempt}` });
  machine.signal({ signalId: `${prefix}-failed-${attempt}`, type: "AGENT_FAILED", diagnosticId: `${prefix}-diagnostic-${attempt}` });
}

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
  async readRunnerFleet(readTenantId: string, readProjectId: string) {
    if (readTenantId !== tenantId || readProjectId !== projectId) return null;
    return {
      schemaVersion: RUNNER_FLEET_PROJECTION_SCHEMA_VERSION,
      tenantId,
      projectId,
      observedAt: "2026-07-18T00:00:00.000Z",
      runners: [],
    } as const;
  }
  async readEvidenceCatalog(readTenantId: string, readProjectId: string) {
    if (readTenantId !== tenantId || readProjectId !== projectId) return null;
    return {
      schemaVersion: EVIDENCE_CATALOG_SCHEMA_VERSION,
      tenantId,
      projectId,
      observedAt: "2026-07-18T00:00:00.000Z",
      entries: [],
    } as const;
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

  const fleetRead = { ...read, path: `/v1/runner-fleet/${projectId}` };
  assert.equal((await handler({ ...fleetRead, socket: writerId })).status, 403);
  const fleet = await handler({ ...fleetRead, socket: readerId });
  assert.equal(fleet.status, 200);
  assert.deepEqual((fleet.body.data as { runners: unknown[] }).runners, []);

  const evidenceRead = { ...read, path: `/v1/evidence-catalog/${projectId}` };
  assert.equal((await handler({ ...evidenceRead, socket: writerId })).status, 403);
  const evidence = await handler({ ...evidenceRead, socket: readerId });
  assert.equal(evidence.status, 200);
  assert.deepEqual((evidence.body.data as { entries: unknown[] }).entries, []);
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

test("PostgreSQL Runner Fleet projection exposes only the latest project-bound lease per platform", async () => {
  const statements: string[] = [];
  const rows = [
    {
      runner_id: "runner-linux-01", platform: "linux", architecture: "x86_64", capability_digest: "a".repeat(64),
      registration_state: "ONLINE", last_seen_at: "2026-07-18T00:04:30.000Z", certificate_not_after: "2027-07-18T00:00:00.000Z",
      attempt_id: "66666666-6666-4666-8666-666666666666", lease_state: "RUNNING", fencing_token: "19",
      lease_expires_at: "2026-07-18T00:10:00.000Z", updated_at: "2026-07-18T00:04:31.000Z",
    },
    {
      runner_id: "runner-macos-01", platform: "macos", architecture: "arm64", capability_digest: "b".repeat(64),
      registration_state: "ONLINE", last_seen_at: "2026-07-17T23:50:00.000Z", certificate_not_after: "2027-07-18T00:00:00.000Z",
      attempt_id: "77777777-7777-4777-8777-777777777777", lease_state: "PASSED", fencing_token: "21",
      lease_expires_at: "2026-07-18T00:03:00.000Z", updated_at: "2026-07-18T00:02:00.000Z",
    },
  ];
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string) {
      statements.push(text);
      const result = text.includes("AS project_exists")
        ? [{ project_exists: true, observed_at: "2026-07-18T00:05:00.000Z" }]
        : text.includes("DISTINCT ON (lease.platform)") ? rows : [];
      return { rowCount: result.length, rows: result as unknown as readonly Row[] };
    },
    release() {},
  };
  const store = new PostgresDeliveryProjectionStore({ async connect() { return client; } });
  const fleet = await store.readRunnerFleet(tenantId, projectId);
  assert.equal(fleet?.runners[0]?.runnerId, "runner-linux-01");
  assert.equal(fleet?.runners[0]?.connectivity, "READY");
  assert.equal(fleet?.runners[1]?.connectivity, "STALE");
  assert.equal(fleet?.runners[0]?.fencingToken, "19");
  assert.match(statements.find((statement) => statement.includes("DISTINCT ON")) ?? "", /lease\.tenant_id = \$1::uuid AND lease\.project_id = \$2::uuid/);
  assert.ok(statements.findIndex((statement) => statement.includes("set_config('app.tenant_id'"))
    < statements.findIndex((statement) => statement.includes("DISTINCT ON")));
});

test("PostgreSQL Evidence Catalog verifies immutable bindings without exposing archive object keys", async () => {
  const statements: string[] = [];
  const bundle = evidenceBundle();
  const binding = evidenceBinding();
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string) {
      statements.push(text);
      const result = text.includes("AS project_exists")
        ? [{ project_exists: true, observed_at: "2026-07-18T00:05:00.000Z" }]
        : text.includes("FROM deviludo.evidence_bundles") ? [{
          id: bundle.id,
          attempt_id: bundle.attemptId,
          commit_sha: bundle.commitSha,
          source_digest: bundle.sourceDigest,
          binding,
          manifest: bundle,
          bundle_digest: bundle.bundleDigest,
          status: bundle.status,
          invalidated_at: null,
          created_at: bundle.createdAt,
        }] : [];
      return { rowCount: result.length, rows: result as unknown as readonly Row[] };
    },
    release() {},
  };
  const store = new PostgresDeliveryProjectionStore({ async connect() { return client; } });
  const catalog = await store.readEvidenceCatalog(tenantId, projectId);
  assert.equal(catalog?.entries[0]?.bundle.bundleDigest, bundle.bundleDigest);
  assert.equal(catalog?.entries[0]?.binding.runnerToolchainRevisionId, binding.runnerToolchainRevisionId);
  assert.equal(catalog?.entries[0]?.invalidatedAt, null);
  assert.equal("objectKey" in (catalog?.entries[0] ?? {}), false);
  const query = statements.find((statement) => statement.includes("FROM deviludo.evidence_bundles")) ?? "";
  assert.match(query, /tenant_id = \$1::uuid AND project_id = \$2::uuid/);
  assert.doesNotMatch(query, /object_key/);
  assert.ok(statements.findIndex((statement) => statement.includes("set_config('app.tenant_id'"))
    < statements.findIndex((statement) => statement.includes("FROM deviludo.evidence_bundles")));

  const driftedClient: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string) {
      const result = text.includes("AS project_exists")
        ? [{ project_exists: true, observed_at: "2026-07-18T00:05:00.000Z" }]
        : text.includes("FROM deviludo.evidence_bundles") ? [{
          id: bundle.id, attempt_id: bundle.attemptId, commit_sha: "f".repeat(40), source_digest: bundle.sourceDigest,
          binding, manifest: bundle, bundle_digest: bundle.bundleDigest, status: bundle.status,
          invalidated_at: null, created_at: bundle.createdAt,
        }] : [];
      return { rowCount: result.length, rows: result as unknown as readonly Row[] };
    },
    release() {},
  };
  await assert.rejects(
    new PostgresDeliveryProjectionStore({ async connect() { return driftedClient; } }).readEvidenceCatalog(tenantId, projectId),
    DeliveryProjectionConflictError,
  );
});

function evidenceBundle() {
  const core = {
    id: "66666666-6666-4666-8666-666666666666",
    attemptId: "66666666-6666-4666-8666-666666666666",
    specRevisionId: "77777777-7777-4777-8777-777777777777",
    specDigest: "1".repeat(64),
    testPlanDigest: "2".repeat(64),
    commitSha: "a".repeat(40),
    sourceDigest: "3".repeat(64),
    targetMatrix: ["linux"],
    godotTestKitDigest: "4".repeat(64),
    buildManifestDigest: "5".repeat(64),
    sbomDigest: "6".repeat(64),
    vulnerabilityScanDigest: "7".repeat(64),
    assetLicenseLedgerDigest: "8".repeat(64),
    platformEvidence: [{
      platform: "linux", runnerId: "runner-linux-01", runnerCapabilityDigest: "9".repeat(64),
      exportDigest: "a".repeat(64), logsDigest: "b".repeat(64), junitDigest: "c".repeat(64),
      inputTimelineDigest: "d".repeat(64), screenshotManifestDigest: "e".repeat(64),
      videoManifestDigest: "f".repeat(64), status: "PASSED",
    }],
    status: "PASSED",
    valid: true,
    createdAt: "2026-07-18T00:04:00.000Z",
  } as const;
  return { ...core, bundleDigest: createHash("sha256").update(canonicalEvidenceJson(core)).digest("hex") };
}

function evidenceBinding() {
  return {
    schemaVersion: "deviludo.evidence-binding.v1",
    attemptId: "66666666-6666-4666-8666-666666666666",
    executionLockId: "88888888-8888-4888-8888-888888888888",
    executionLockDigest: "0".repeat(64),
    specRevisionId: "77777777-7777-4777-8777-777777777777",
    specDigest: "1".repeat(64),
    testPlanDigest: "2".repeat(64),
    runnerToolchainRevisionId: "99999999-9999-4999-8999-999999999999",
    runnerToolchainDigest: "a".repeat(64),
    commitSha: "a".repeat(40),
    sourceDigest: "3".repeat(64),
    targetMatrix: ["linux"],
  } as const;
}

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
