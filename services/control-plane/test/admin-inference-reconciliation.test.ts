import assert from "node:assert/strict";
import test from "node:test";
import { AdminService } from "../src/admin.service";
import { InMemoryAdminStore } from "../src/admin.store";
import { DevelopmentAgentSupplyChain } from "../src/agent-supply-chain";
import type { RequestActor } from "../src/contracts";
import { InferenceRequestReconciler } from "../src/inference-reconciliation";
import { InferenceGatewayProviderProbe } from "../src/provider-probe";
import { ProcessIsolatedSecretVault } from "../src/secret-vault";

const tenantId = "11111111-1111-4111-8111-111111111111";
const runId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const operationKey = "a".repeat(64);
const evidenceDigest = "b".repeat(64);

test("successful inference reconciliation commits one exact SecurityAdmin audit record", async () => {
  let received: unknown;
  const reconciler = new class extends InferenceRequestReconciler {
    async lookup() { return null; }
    async reconcile(input: Parameters<InferenceRequestReconciler["reconcile"]>[0]) {
      received = input;
      return {
        operationKey: input.operationKey,
        tenantId: input.tenantId,
        runId: input.runId,
        requestId: input.requestId,
        action: input.action,
        evidenceDigest: input.evidenceDigest,
        state: "COMPLETED" as const,
        usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.00048 },
        reconciledAt: "2026-07-18T00:00:00.000Z",
      };
    }
  }();
  const store = new InMemoryAdminStore();
  const service = new AdminService(
    store,
    new ProcessIsolatedSecretVault(),
    new InferenceGatewayProviderProbe(),
    new DevelopmentAgentSupplyChain(),
    reconciler,
  );
  const actor: RequestActor = {
    role: "SecurityAdmin",
    actorId: "security-admin@example.com",
    tenantId: null,
    projectId: null,
    requestId: "admin-request-1",
    mutation: {
      identityDigest: operationKey,
      requestFingerprint: "c".repeat(64),
      claimToken: "55555555-5555-4555-8555-555555555555",
    },
  };
  const receipt = await service.reconcileInferenceRequest(requestId, {
    tenantId, runId, action: "RECORD_USAGE", evidenceDigest,
    inputTokens: 120, outputTokens: 30,
  }, actor);
  assert.equal(receipt.state, "COMPLETED");
  assert.deepEqual(received, {
    operationKey, tenantId, runId, requestId, action: "RECORD_USAGE", evidenceDigest,
    reconciledBy: actor.actorId, inputTokens: 120, outputTokens: 30,
  });
  const audit = await service.auditLog({ ...actor, role: "Auditor", mutation: undefined });
  assert.equal(audit[0]?.action, "INFERENCE_REQUEST_RECONCILED");
  assert.equal(audit[0]?.resource, `inference-request:${requestId}`);
  assert.equal(audit[0]?.metadata.affectedTenantId, tenantId);
  assert.equal(audit[0]?.metadata.evidenceDigest, evidenceDigest);
});
