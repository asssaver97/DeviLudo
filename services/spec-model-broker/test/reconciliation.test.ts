import assert from "node:assert/strict";
import test from "node:test";
import { createSpecModelBrokerHandler } from "../src/ingress-http";
import { MemorySpecModelOperationStore } from "../src/operation-memory";
import { StrictSpecModelReconciliationService, parseSpecModelReconciliationRequest } from "../src/reconciliation";
import type { SpecModelProviderBinding } from "../src/contracts";
import { SpecModelReconciliationConflictError } from "../src/contracts";
import { SpecModelBrokerService } from "../src/service";
import { MemorySpecModelProviderAuthority } from "../src/provider-authority";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const generationOperationKey = "a".repeat(64);
const reconciliationOperationKey = "b".repeat(64);
const evidenceDigest = "c".repeat(64);
const generationIdentity = "spiffe://deviludo.internal/control/spec-dialogue";
const reconciliationIdentity = "spiffe://deviludo.internal/control/security-admin-reconciliation";
const provider: SpecModelProviderBinding = Object.freeze({
  profileRevisionId: "profile-spec-r1", providerRevisionId: "provider-spec-r1",
  credentialVersionId: "credential-v1", agent: "claude-code", protocol: "anthropic-messages",
  baseUrl: "https://api.example.com/v1", approvedPorts: Object.freeze([443]),
  authentication: "x-api-key", model: "claude-haiku-4-5-20251001", policyDigest: "d".repeat(64),
});

test("reconciliation contract keeps no-usage and recorded-usage evidence disjoint", () => {
  assert.deepEqual(parseSpecModelReconciliationRequest(request("CONFIRM_NO_USAGE")), {
    operationKey: reconciliationOperationKey, tenantId, generationOperationKey,
    action: "CONFIRM_NO_USAGE", evidenceDigest, reconciledBy: "security-admin@example.com",
  });
  assert.deepEqual(parseSpecModelReconciliationRequest(request("RECORD_USAGE", 42, 17)), {
    operationKey: reconciliationOperationKey, tenantId, generationOperationKey,
    action: "RECORD_USAGE", evidenceDigest, reconciledBy: "security-admin@example.com",
    inputTokens: 42, outputTokens: 17,
  });
  assert.throws(() => parseSpecModelReconciliationRequest({ ...request("CONFIRM_NO_USAGE"), outputTokens: 1 }));
  assert.throws(() => parseSpecModelReconciliationRequest(request("RECORD_USAGE", 1, 0)));
});

test("an explicit no-usage reconciliation releases one generation and permits one fenced retry", async () => {
  const now = Date.parse("2026-07-21T10:00:00.000Z");
  const store = new MemorySpecModelOperationStore(() => now);
  await indeterminate(store);
  const reconciliation = new StrictSpecModelReconciliationService(store);
  const status = await reconciliation.lookup({ tenantId, generationOperationKey });
  assert.equal(status?.dispatchGeneration, 1);
  const first = await reconciliation.run(request("CONFIRM_NO_USAGE"));
  const replay = await reconciliation.run(request("CONFIRM_NO_USAGE"));
  assert.deepEqual(replay, first);
  assert.deepEqual(first.usage, { inputTokens: 0, outputTokens: 0 });
  assert.equal((await store.claim(claim("2"))).kind, "CLAIMED");
  const record = store.records.get(`${tenantId}\0${generationOperationKey}`);
  assert.equal(record?.dispatchGeneration, 2);
});

test("recorded usage is append-only and a second decision for the same dispatch conflicts", async () => {
  const store = new MemorySpecModelOperationStore(() => Date.parse("2026-07-21T10:00:00.000Z"));
  await indeterminate(store);
  const reconciliation = new StrictSpecModelReconciliationService(store);
  const receipt = await reconciliation.run(request("RECORD_USAGE", 120, 30));
  assert.deepEqual(receipt.usage, { inputTokens: 120, outputTokens: 30 });
  await assert.rejects(reconciliation.run({
    ...request("CONFIRM_NO_USAGE"), operationKey: "e".repeat(64),
  }), (error: unknown) => error instanceof SpecModelReconciliationConflictError);
});

test("generation and SecurityAdmin reconciliation identities are mutually exclusive at ingress", async () => {
  const store = new MemorySpecModelOperationStore();
  await indeterminate(store);
  const broker = new SpecModelBrokerService({
    store, authority: new MemorySpecModelProviderAuthority(provider), profileRevisionId: provider.profileRevisionId,
    generator: { async generate(): Promise<never> { throw new Error("not used"); }, async probe() {} },
  });
  const handler = createSpecModelBrokerHandler({
    service: broker, allowedSpiffeIds: new Set([generationIdentity]),
    reconciliation: new StrictSpecModelReconciliationService(store),
    reconciliationSpiffeIds: new Set([reconciliationIdentity]),
    extractIdentity: (socket) => ({ spiffeId: String(socket) }),
  });
  const reconcile = (socket: string) => handler({
    method: "POST", path: "/v1/spec-generation-reconciliations", socket,
    headers: { "content-type": "application/json" }, rawBody: JSON.stringify(request("CONFIRM_NO_USAGE")),
  });
  assert.equal((await reconcile(generationIdentity)).status, 403);
  assert.equal((await reconcile(reconciliationIdentity)).status, 200);
  const generationResponse = await handler({
    method: "POST", path: "/v1/spec-generations", socket: reconciliationIdentity,
    headers: { "content-type": "application/json", "idempotency-key": generationOperationKey }, rawBody: "{}",
  });
  assert.equal(generationResponse.status, 403);
  assert.throws(() => createSpecModelBrokerHandler({
    service: broker, allowedSpiffeIds: new Set([generationIdentity]),
    reconciliation: new StrictSpecModelReconciliationService(store),
    reconciliationSpiffeIds: new Set([generationIdentity]),
  }), /disjoint/);
});

async function indeterminate(store: MemorySpecModelOperationStore): Promise<void> {
  const result = await store.claim(claim("1"));
  if (result.kind !== "CLAIMED") throw new Error("fixture claim failed");
  await store.abandon({ tenantId, operationKey: generationOperationKey, claimToken: result.claimToken });
}

function claim(suffix: string) {
  return {
    tenantId, projectId, conversationId, operationKey: generationOperationKey,
    requestDigest: "f".repeat(64), provider,
    claimToken: `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`,
    leaseSeconds: 180,
  };
}

function request(action: "CONFIRM_NO_USAGE" | "RECORD_USAGE", inputTokens?: number, outputTokens?: number) {
  return {
    operationKey: reconciliationOperationKey, tenantId, generationOperationKey,
    action, evidenceDigest, reconciledBy: "security-admin@example.com",
    ...(action === "RECORD_USAGE" ? { inputTokens, outputTokens } : {}),
  };
}
