import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AdminService } from "../src/admin.service";
import { InMemoryAdminStore } from "../src/admin.store";
import { DevelopmentAgentSupplyChain } from "../src/agent-supply-chain";
import type { RequestActor } from "../src/contracts";
import { InferenceRequestReconciler } from "../src/inference-reconciliation";
import { InferenceGatewayProviderProbe, type ProviderProbeHttpRequest } from "../src/provider-probe";
import { ProcessIsolatedSecretVault } from "../src/secret-vault";
import { SpecModelBrokerReconciliationClient, SpecModelGenerationReconciler } from "../src/spec-model-reconciliation";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const generationOperationKey = "a".repeat(64);
const operationKey = "b".repeat(64);
const evidenceDigest = "c".repeat(64);
const input = {
  operationKey, tenantId, generationOperationKey, action: "RECORD_USAGE" as const,
  evidenceDigest, reconciledBy: "security-admin@example.com", inputTokens: 120, outputTokens: 30,
};

test("control-plane client pins the specification reconciliation mTLS routes and complete receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-spec-reconciliation-"));
  try {
    const key = join(directory, "client.key"); const certificate = join(directory, "client.crt"); const ca = join(directory, "ca.crt");
    await Promise.all([writeFile(key, Buffer.alloc(64, 1)), writeFile(certificate, Buffer.alloc(64, 2)), writeFile(ca, Buffer.alloc(64, 3))]);
    const calls: Array<{ url: string; request: ProviderProbeHttpRequest }> = [];
    const client = new SpecModelBrokerReconciliationClient({
      DEVILUDO_SPEC_MODEL_RECONCILIATION_URL: "https://spec-model.internal/v1/spec-generation-reconciliations",
      DEVILUDO_SPEC_MODEL_RECONCILIATION_TLS_KEY_FILE: key,
      DEVILUDO_SPEC_MODEL_RECONCILIATION_TLS_CERT_FILE: certificate,
      DEVILUDO_SPEC_MODEL_RECONCILIATION_CA_FILE: ca,
    }, async (url, request) => {
      calls.push({ url: url.href, request });
      if (url.pathname.endsWith("/lookup")) return { statusCode: 200, payload: status() };
      return { statusCode: 200, payload: receipt() };
    });
    assert.equal((await client.reconcile(input)).dispatchGeneration, 1);
    assert.equal(calls[0]?.url, "https://spec-model.internal/v1/spec-generation-reconciliations");
    assert.deepEqual(JSON.parse(calls[0]?.request.body ?? "null"), input);
    const lookup = await client.lookup(tenantId, generationOperationKey);
    assert.equal(lookup?.conversationId, conversationId);
    assert.equal(calls[1]?.url, "https://spec-model.internal/v1/spec-generation-reconciliations/lookup");
    assert.deepEqual(JSON.parse(calls[1]?.request.body ?? "null"), { tenantId, generationOperationKey });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("control-plane client rejects alternate routes and reconciliation receipt drift", async () => {
  const unsafe = new SpecModelBrokerReconciliationClient({
    DEVILUDO_SPEC_MODEL_RECONCILIATION_URL: "https://spec-model.internal/v1/spec-generations",
  }, async () => { throw new Error("must not connect"); });
  await assert.rejects(unsafe.reconcile(input), (error: unknown) => (error as { code?: string }).code === "INVALID_SPEC_MODEL_RECONCILIATION_BROKER");

  const directory = await mkdtemp(join(tmpdir(), "deviludo-spec-reconciliation-drift-"));
  try {
    const key = join(directory, "client.key"); const certificate = join(directory, "client.crt"); const ca = join(directory, "ca.crt");
    await Promise.all([writeFile(key, Buffer.alloc(64, 1)), writeFile(certificate, Buffer.alloc(64, 2)), writeFile(ca, Buffer.alloc(64, 3))]);
    const client = new SpecModelBrokerReconciliationClient({
      DEVILUDO_SPEC_MODEL_RECONCILIATION_URL: "https://spec-model.internal/v1/spec-generation-reconciliations",
      DEVILUDO_SPEC_MODEL_RECONCILIATION_TLS_KEY_FILE: key,
      DEVILUDO_SPEC_MODEL_RECONCILIATION_TLS_CERT_FILE: certificate,
      DEVILUDO_SPEC_MODEL_RECONCILIATION_CA_FILE: ca,
    }, async () => ({ statusCode: 200, payload: { ...receipt(), generationOperationKey: "d".repeat(64) } }));
    await assert.rejects(client.reconcile(input), (error: unknown) => (error as { code?: string }).code === "INVALID_SPEC_MODEL_RECONCILIATION_RESPONSE");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("SecurityAdmin specification reconciliation emits an exact tenant audit record", async () => {
  let received: unknown;
  const reconciler = new class extends SpecModelGenerationReconciler {
    async lookup() { return status(); }
    async reconcile(value: Parameters<SpecModelGenerationReconciler["reconcile"]>[0]) { received = value; return receipt(); }
  }();
  const store = new InMemoryAdminStore();
  const service = new AdminService(
    store, new ProcessIsolatedSecretVault(), new InferenceGatewayProviderProbe(), new DevelopmentAgentSupplyChain(),
    new class extends InferenceRequestReconciler { async lookup() { return null; } async reconcile(): Promise<never> { throw new Error("not used"); } }(),
    reconciler,
  );
  const actor: RequestActor = {
    role: "SecurityAdmin", actorId: input.reconciledBy, tenantId: null, projectId: null, requestId: "admin-request",
    mutation: { identityDigest: operationKey, requestFingerprint: "d".repeat(64), claimToken: "55555555-5555-4555-8555-555555555555" },
  };
  const result = await service.reconcileSpecModelGeneration(generationOperationKey, {
    tenantId, action: "RECORD_USAGE", evidenceDigest, inputTokens: 120, outputTokens: 30,
  }, actor);
  assert.equal(result.state, "RELEASED");
  assert.deepEqual(received, input);
  const audit = await service.auditLog({ ...actor, role: "Auditor", mutation: undefined });
  assert.equal(audit[0]?.action, "SPEC_MODEL_GENERATION_RECONCILED");
  assert.equal(audit[0]?.resource, `spec-model-generation:${generationOperationKey}`);
  assert.equal(audit[0]?.metadata.affectedTenantId, tenantId);
});

function status() {
  return {
    tenantId, projectId, conversationId, generationOperationKey, dispatchGeneration: 1,
    profileRevisionId: "profile-spec-r1", providerRevisionId: "provider-spec-r1",
    model: "claude-haiku-4-5-20251001", state: "INDETERMINATE" as const,
    createdAt: "2026-07-21T10:00:00.000Z",
  };
}
function receipt() {
  return {
    operationKey, tenantId, generationOperationKey, dispatchGeneration: 1,
    action: "RECORD_USAGE" as const, evidenceDigest, state: "RELEASED" as const,
    usage: { inputTokens: 120, outputTokens: 30 }, reconciledAt: "2026-07-21T10:01:00.000Z",
  };
}
