import assert from "node:assert/strict";
import test from "node:test";
import { parseInferenceReconciliationRequest, StrictGatewayInferenceReconciliation } from "../src/reconciliation";

const base = {
  operationKey: "a".repeat(64),
  tenantId: "11111111-1111-4111-8111-111111111111",
  runId: "33333333-3333-4333-8333-333333333333",
  requestId: "44444444-4444-4444-8444-444444444444",
  evidenceDigest: "b".repeat(64),
  reconciledBy: "security-admin@example.com",
};

test("reconciliation parser keeps no-usage and recorded-usage outcomes disjoint", () => {
  const noUsage = parseInferenceReconciliationRequest({ ...base, action: "CONFIRM_NO_USAGE" });
  assert.equal(noUsage.action, "CONFIRM_NO_USAGE");
  const usage = parseInferenceReconciliationRequest({
    ...base, action: "RECORD_USAGE", inputTokens: 10, outputTokens: 4,
  });
  assert.equal(usage.inputTokens, 10);
  assert.throws(
    () => parseInferenceReconciliationRequest({ ...base, action: "CONFIRM_NO_USAGE", inputTokens: 0, outputTokens: 0 }),
    /invalid/,
  );
  assert.throws(
    () => parseInferenceReconciliationRequest({ ...base, action: "RECORD_USAGE", inputTokens: 0, outputTokens: 0 }),
    /invalid/,
  );
  assert.throws(
    () => parseInferenceReconciliationRequest({ ...base, action: "CONFIRM_NO_USAGE", secret: "must-not-pass" }),
    /invalid/,
  );
});

test("strict reconciliation forwards only a fully parsed immutable request", async () => {
  let received: unknown;
  const service = new StrictGatewayInferenceReconciliation({
    async lookup() { return null; },
    async reconcile(input) {
      received = input;
      return {
        ...input, state: "RELEASED", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        reconciledAt: "2026-07-18T00:00:00.000Z",
      };
    },
  });
  const result = await service.run({ ...base, action: "CONFIRM_NO_USAGE" });
  assert.equal(result.state, "RELEASED");
  assert.deepEqual(received, { ...base, action: "CONFIRM_NO_USAGE" });
});

test("strict reconciliation lookup accepts only a tenant and run UUID", async () => {
  const service = new StrictGatewayInferenceReconciliation({
    async lookup(tenantId, runId) {
      assert.equal(tenantId, base.tenantId);
      assert.equal(runId, base.runId);
      return null;
    },
    async reconcile() { throw new Error("must not run"); },
  });
  assert.equal(await service.lookup({ tenantId: base.tenantId, runId: base.runId }), null);
  await assert.rejects(async () => service.lookup({ tenantId: base.tenantId, runId: base.runId, requestId: base.requestId }), /invalid/);
});
