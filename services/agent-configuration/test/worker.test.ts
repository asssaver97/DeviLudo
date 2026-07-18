import assert from "node:assert/strict";
import test from "node:test";
import { AgentConfigurationWorker } from "../src/worker";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";

test("Agent configuration worker drains assigned tenants in canonical order", async () => {
  const calls: string[] = [];
  const remaining = new Map([[tenantA, 2], [tenantB, 1]]);
  const worker = new AgentConfigurationWorker({
    async processTenantOnce(tenantId) {
      calls.push(tenantId);
      const value = remaining.get(tenantId) ?? 0;
      if (value === 0) return "IDLE";
      remaining.set(tenantId, value - 1);
      return "COMPLETED";
    },
  }, {
    async listTenantIds() { return [tenantA, tenantB]; },
  });
  assert.equal(await worker.runCycle(), 3);
  assert.deepEqual(calls, [tenantA, tenantA, tenantA, tenantB, tenantB]);
});

test("Agent configuration worker rejects unsigned assignment shape before database work", async () => {
  let calls = 0;
  const worker = new AgentConfigurationWorker({ async processTenantOnce() { calls += 1; return "IDLE"; } }, {
    async listTenantIds() { return [tenantB, tenantA]; },
  });
  await assert.rejects(worker.runCycle(), /assignment/);
  assert.equal(calls, 0);
});
