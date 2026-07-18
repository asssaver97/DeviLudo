import assert from "node:assert/strict";
import test from "node:test";
import {
  DurableSteamWorkflowOperationService,
  SteamWorkflowExecutionError,
  SteamWorkflowOperationWorker,
  type SteamWorkflowOperationPersistence,
} from "../src/workflow-broker-operations";
import type {
  SteamPrivateBetaOperationRequest,
  SteamWorkflowOperationStatus,
} from "../src/workflow-broker-http";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const claimToken = "55555555-5555-4555-8555-555555555555";
const evidenceId = "66666666-6666-4666-8666-666666666666";
const mfaId = "77777777-7777-4777-8777-777777777777";
const requestDigest = "a".repeat(64);
const operationKey = "workflow-job:88888888-8888-4888-8888-888888888888";
const now = "2030-01-01T00:00:00.000Z";
const identity = Object.freeze({
  spiffeId: "spiffe://deviludo.internal/temporal-steam-publisher",
  certificateFingerprint: "9".repeat(64), certificateSerial: "01",
  certificateNotAfter: "2099-01-02T00:00:00.000Z",
});
const request: SteamPrivateBetaOperationRequest = Object.freeze({
  schemaVersion: "deviludo.steam-workflow.v1",
  kind: "PRIVATE_BETA_UPLOAD",
  operationKey, requestDigest, tenantId, projectId, workflowId: "delivery-001", runId,
  mainCommitSha: "b".repeat(40), mainEvidenceBundleId: evidenceId, mfaApprovalId: mfaId,
  targetMatrix: Object.freeze(["linux", "windows"] as const),
});
const running: SteamWorkflowOperationStatus = Object.freeze({
  status: "RUNNING", kind: request.kind, operationId, operationKey, requestDigest, receipt: null,
});
const receipt = Object.freeze({
  receiptId: "steam-upload-receipt-001", runId, mainCommitSha: request.mainCommitSha,
  mainEvidenceBundleId: evidenceId, mfaApprovalId: mfaId,
  targetMatrix: Object.freeze(["linux", "windows"] as const), buildId: "91234567",
});
const completed: SteamWorkflowOperationStatus = Object.freeze({
  status: "COMPLETED", kind: request.kind, operationId, operationKey, requestDigest, receipt,
});

test("durable Steam Broker service persists before idempotent dispatch and reads the same operation", async () => {
  const events: string[] = [];
  const persistence = {
    async reserve(input: Parameters<SteamWorkflowOperationPersistence["reserve"]>[0]) {
      events.push("reserve");
      assert.equal(input.operationId, operationId);
      assert.equal(input.submitterSpiffeId, identity.spiffeId);
      assert.equal(input.createdAt, now);
      return { created: true, status: running };
    },
    async find(lookup: Parameters<SteamWorkflowOperationPersistence["find"]>[0]) {
      events.push("find");
      assert.deepEqual(lookup, { tenantId, operationId, operationKey, requestDigest });
      return running;
    },
    async probe() { events.push("store-probe"); },
  } as unknown as SteamWorkflowOperationPersistence;
  const dispatcher = {
    async enqueue(input: unknown) {
      events.push("enqueue");
      assert.deepEqual(input, { tenantId, operationId, operationKey, requestDigest });
    },
    async probe() { events.push("dispatcher-probe"); },
  };
  const service = new DurableSteamWorkflowOperationService(persistence, dispatcher, {
    now: () => new Date(now), operationId: () => operationId,
  });
  assert.deepEqual(await service.submit(identity, request), running);
  assert.deepEqual(events.slice(0, 2), ["reserve", "enqueue"]);
  assert.deepEqual(await service.get(identity, { tenantId, operationId, operationKey, requestDigest }), running);
  await service.probe();
  assert.ok(events.includes("store-probe"));
  assert.ok(events.includes("dispatcher-probe"));
});

test("durable Steam Broker does not redispatch a terminal operation", async () => {
  let enqueued = 0;
  const persistence = {
    async reserve() { return { created: false, status: completed }; },
    async probe() {},
  } as unknown as SteamWorkflowOperationPersistence;
  const service = new DurableSteamWorkflowOperationService(persistence, {
    async enqueue() { enqueued += 1; }, async probe() {},
  }, { now: () => new Date(now), operationId: () => operationId });
  assert.deepEqual(await service.submit(identity, request), completed);
  assert.equal(enqueued, 0);
});

test("Steam operation Worker heartbeats and commits only an exact request-bound receipt", async () => {
  const events: string[] = [];
  const persistence = {
    async claim(input: Parameters<SteamWorkflowOperationPersistence["claim"]>[0]) {
      events.push("claim");
      assert.equal(input.claimToken, claimToken);
      assert.equal(input.claimedAt, now);
      assert.equal(input.claimExpiresAt, "2030-01-01T00:05:00.000Z");
      return { kind: "ACQUIRED" as const, request, attempt: 1 };
    },
    async heartbeat(input: Parameters<SteamWorkflowOperationPersistence["heartbeat"]>[0]) {
      events.push("heartbeat");
      assert.equal(input.claimToken, claimToken);
    },
    async complete(input: Parameters<SteamWorkflowOperationPersistence["complete"]>[0]) {
      events.push("complete");
      assert.deepEqual(input.receipt, receipt);
      return completed;
    },
    async probe() { events.push("store-probe"); },
  } as SteamWorkflowOperationPersistence;
  const worker = new SteamWorkflowOperationWorker(persistence, {
    async execute(received, context) {
      events.push("execute");
      assert.deepEqual(received, request);
      await context.heartbeat();
      return receipt;
    },
    async probe() { events.push("executor-probe"); },
  }, { now: () => new Date(now), claimToken: () => claimToken });
  assert.deepEqual(await worker.execute({ tenantId, operationId }), completed);
  assert.deepEqual(events.slice(0, 4), ["claim", "execute", "heartbeat", "complete"]);
  await worker.probe();
  assert.ok(events.includes("store-probe"));
  assert.ok(events.includes("executor-probe"));
});

test("Steam operation Worker fences duplicate, terminal, invalid and retryable execution paths", async () => {
  let executions = 0;
  const busy = new SteamWorkflowOperationWorker({
    async claim() { return { kind: "BUSY", status: running }; },
  } as unknown as SteamWorkflowOperationPersistence, {
    async execute() { executions += 1; return receipt; }, async probe() {},
  }, { claimToken: () => claimToken });
  assert.deepEqual(await busy.execute({ tenantId, operationId }), running);
  assert.equal(executions, 0);

  const retries: Array<{ releasedAt: string; retryAt: string }> = [];
  const retryPersistence = {
    async claim() { return { kind: "ACQUIRED" as const, request, attempt: 1 }; },
    async release(input: Parameters<SteamWorkflowOperationPersistence["release"]>[0]) {
      retries.push({ releasedAt: input.releasedAt, retryAt: input.retryAt });
    },
  } as unknown as SteamWorkflowOperationPersistence;
  const retrying = new SteamWorkflowOperationWorker(retryPersistence, {
    async execute() { throw new SteamWorkflowExecutionError("STEAM_UPSTREAM_UNAVAILABLE", false); },
    async probe() {},
  }, { claimToken: () => claimToken, now: () => new Date(now) });
  await assert.rejects(retrying.execute({ tenantId, operationId }), /STEAM_UPSTREAM_UNAVAILABLE/);
  assert.deepEqual(retries, [{ releasedAt: now, retryAt: "2030-01-01T00:00:05.000Z" }]);

  let failures = 0;
  const terminal = new SteamWorkflowOperationWorker({
    async claim() { return { kind: "ACQUIRED" as const, request, attempt: 1 }; },
    async fail(input: Parameters<SteamWorkflowOperationPersistence["fail"]>[0]) {
      failures += 1;
      assert.equal(input.errorCode, "STEAM_AUTHORIZATION_REVOKED");
      return { ...running, status: "FAILED", errorCode: input.errorCode, terminal: true } as SteamWorkflowOperationStatus;
    },
  } as unknown as SteamWorkflowOperationPersistence, {
    async execute() { throw new SteamWorkflowExecutionError("STEAM_AUTHORIZATION_REVOKED", true); },
    async probe() {},
  }, { claimToken: () => claimToken });
  assert.equal((await terminal.execute({ tenantId, operationId })).status, "FAILED");
  assert.equal(failures, 1);

  const drifted = new SteamWorkflowOperationWorker(retryPersistence, {
    async execute() { return { ...receipt, runId: projectId }; }, async probe() {},
  }, { claimToken: () => claimToken, now: () => new Date(now) });
  await assert.rejects(drifted.execute({ tenantId, operationId }), /invalid/);
  assert.equal(retries.length, 2);
});
