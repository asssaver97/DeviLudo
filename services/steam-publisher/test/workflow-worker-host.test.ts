import assert from "node:assert/strict";
import test from "node:test";
import type { SteamWorkflowOperationSource } from "../src/postgres-workflow-dispatch";
import type { SteamWorkflowOperationStatus } from "../src/workflow-broker-http";
import {
  PollingSteamWorkflowWorkerHost,
  SteamWorkflowOperationProcessor,
} from "../src/workflow-worker-host";

const tenantId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const status: SteamWorkflowOperationStatus = Object.freeze({
  status: "COMPLETED",
  kind: "DEFAULT_BRANCH_PUBLISH",
  operationId,
  operationKey: "workflow-job:33333333-3333-4333-8333-333333333333",
  requestDigest: "a".repeat(64),
  receipt: Object.freeze({
    receiptId: "default-publication-001",
    releaseId: "44444444-4444-4444-8444-444444444444",
    runId: "55555555-5555-4555-8555-555555555555",
    betaBuildId: "91234567",
    defaultBranchBuildId: "91234567",
    externalApprovalIds: Object.freeze(["valve-1", "first-1", "confirm-1"]),
  }),
});

test("Steam Worker processor resolves only an opaque queue identity and returns a terminal result", async () => {
  const events: string[] = [];
  const source: SteamWorkflowOperationSource = {
    async next(receivedTenantId) {
      events.push("next");
      assert.equal(receivedTenantId, tenantId);
      return { tenantId, operationId };
    },
    async probe() { events.push("source-probe"); },
  };
  const processor = new SteamWorkflowOperationProcessor(source, {
    async execute(input) {
      events.push("execute");
      assert.deepEqual(input, { tenantId, operationId });
      return status;
    },
    async probe() { events.push("worker-probe"); },
  });
  assert.deepEqual(await processor.processOne(tenantId), {
    kind: "TERMINAL", operationId, status: "COMPLETED",
  });
  await processor.probe();
  assert.deepEqual(events, ["next", "execute", "source-probe", "worker-probe"]);
});

test("polling Steam Worker probes, drains sorted tenant scope and stops without leaking failures", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  let cycles = 0;
  const processor = {
    async probe() { events.push("probe"); },
    async processOne(receivedTenantId: string) {
      assert.equal(receivedTenantId, tenantId);
      cycles += 1;
      if (cycles === 1) throw new Error("sensitive-upstream-error");
      return { kind: "IDLE" as const };
    },
  } as SteamWorkflowOperationProcessor;
  const host = new PollingSteamWorkflowWorkerHost(processor, [tenantId], {
    pollIntervalMs: 100,
    retryIntervalMs: 100,
    diagnostic(event) { events.push(event); },
    async wait(milliseconds) {
      assert.equal(milliseconds, 100);
      if (cycles >= 2) controller.abort();
    },
  });
  await host.run(controller.signal);
  assert.deepEqual(events, ["probe", "READY", "CYCLE_FAILED", "STOPPED"]);
  assert.equal(JSON.stringify(events).includes("sensitive-upstream-error"), false);
});

test("polling Steam Worker rejects unsorted or duplicate tenant scopes", () => {
  const processor = {} as SteamWorkflowOperationProcessor;
  const second = "00000000-0000-4000-8000-000000000000";
  assert.throws(() => new PollingSteamWorkflowWorkerHost(processor, [tenantId, second]), /host is invalid/);
  assert.throws(() => new PollingSteamWorkflowWorkerHost(processor, [tenantId, tenantId]), /host is invalid/);
});
