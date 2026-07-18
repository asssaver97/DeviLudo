import assert from "node:assert/strict";
import test from "node:test";
import { verifyRunToken } from "../../../lib/security/credentials";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type {
  AgentExecutionRequest,
  AgentExecutionStatus,
  IsolatedAgentExecutionResult,
  LockedAgentExecution,
} from "../src/contracts";
import { parseAgentExecutionRequest } from "../src/contracts";
import { createAgentExecutionBrokerHandler } from "../src/ingress-http";
import {
  AgentExecutionOperationWorker,
  AgentProviderUnavailable,
  DurableAgentExecutionService,
  type AgentExecutionOperationPersistence,
} from "../src/operations";
import { HmacEphemeralRunTokenBroker, type EphemeralRunTokenSecretStore } from "../src/token-broker";
import { PostgresAgentExecutionOperations } from "../src/postgres-operations";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const claimToken = "55555555-5555-4555-8555-555555555555";
const attemptId = "66666666-6666-4666-8666-666666666666";
const now = new Date("2030-01-01T00:00:00.000Z");

function request(): AgentExecutionRequest {
  return Object.freeze({
    schemaVersion: "deviludo.agent-execution.v1", operationKey: "workflow-job:44444444-4444-4444-8444-444444444444",
    requestDigest: "a".repeat(64), tenantId, projectId, workflowId: `delivery-${projectId}`,
    lockedRunConfigurationId: runId, expectedRunId: null, iteration: 1, repairAttempts: 0,
  });
}

function lock(): LockedAgentExecution {
  return Object.freeze({
    tenantId, projectId, runId, resolutionDigest: "b".repeat(64), profileRevisionId: "profile-r1",
    installationId: "installation-r1", imageDigest: `sha256:${"c".repeat(64)}`, exactAgentVersion: "2.1.14",
    adapterVersion: "adapter-1.0.0", agent: "claude-code", providerRevisionId: "provider-r1",
    providerProtocol: "anthropic-messages", providerBaseUrl: "https://gateway.example.invalid/v1",
    credentialVersionId: "credential-v1", model: "gateway/claude-sonnet-4-6-20250514",
    authorizedModels: Object.freeze(["gateway/claude-sonnet-4-6-20250514"]),
    authorizationNonce: "nonce-r1", authorizationExpiresAt: "2030-01-01T01:00:00.000Z",
    budget: Object.freeze({ maxUsd: 10, maxTurns: 50, timeoutSeconds: 3_600 }),
    specRevisionId: "77777777-7777-4777-8777-777777777777",
    testPlanRevisionId: "88888888-8888-4888-8888-888888888888",
    sourceBaselineReceiptId: "99999999-9999-4999-8999-999999999999",
    baseCommitSha: "d".repeat(40), sourceDigest: "e".repeat(64),
  });
}

function completedResult(): IsolatedAgentExecutionResult {
  const locked = lock();
  return Object.freeze({
    status: "COMPLETED", runId, attemptId, resolutionDigest: locked.resolutionDigest,
    profileRevisionId: locked.profileRevisionId, installationId: locked.installationId,
    imageDigest: locked.imageDigest, adapterVersion: locked.adapterVersion,
    providerRevisionId: locked.providerRevisionId, credentialVersionId: locked.credentialVersionId,
    model: locked.model, candidateCommitSha: "f".repeat(40), draftPullRequest: 42,
    diagnosticId: null, receiptId: "receipt-r1",
  });
}

test("contract rejects unbound recovery IDs and extra credential fields", () => {
  assert.deepEqual(parseAgentExecutionRequest(request()), request());
  assert.throws(() => parseAgentExecutionRequest({ ...request(), expectedRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }), /contract is invalid/);
  assert.throws(() => parseAgentExecutionRequest({ ...request(), apiKey: "must-not-cross" }), /contract is invalid/);
});

test("worker deposits a 15-minute bound DLRT, passes only its SecretRef, and revokes it", async () => {
  const stored: Uint8Array[] = [];
  const revoked: string[] = [];
  const secrets: EphemeralRunTokenSecretStore = {
    async put(input) { stored.push(input.value.slice()); return { secretRef: `secret://agent-runs/${input.runId}/${input.attemptId}` }; },
    async revoke(ref) { revoked.push(ref); }, async probe() {},
  };
  const signingKey = new Uint8Array(32).fill(7);
  const tokens = new HmacEphemeralRunTokenBroker(signingKey, secrets, () => now);
  const persistence: AgentExecutionOperationPersistence = {
    async reserve() { throw new Error("not used"); }, async find() { throw new Error("not used"); },
    async claim() { return { kind: "ACQUIRED", request: request(), lock: lock(), attemptId, attempt: 1 }; },
    async heartbeat() {},
    async complete(input) { return { status: "COMPLETED", runId,
      providerRevisionId: lock().providerRevisionId, receipt: input.receipt }; },
    async waitForProvider() { throw new Error("not expected"); }, async release() { throw new Error("not expected"); }, async probe() {},
  };
  let dispatchedSecretRef = "";
  const worker = new AgentExecutionOperationWorker(persistence, tokens, {
    async execute(input, context) {
      dispatchedSecretRef = input.inferenceTokenSecretRef;
      assert.equal("apiKey" in input, false); assert.equal("token" in input, false);
      await context.heartbeat(); return completedResult();
    }, async probe() {},
  }, { now: () => now, claimToken: () => claimToken });
  const status = await worker.execute({ tenantId, runId });
  assert.equal(status?.status, "COMPLETED");
  assert.equal(status?.receipt?.candidateCommitSha, "f".repeat(40));
  assert.equal(dispatchedSecretRef, `secret://agent-runs/${runId}/${attemptId}`);
  assert.deepEqual(revoked, [dispatchedSecretRef]);
  const token = new TextDecoder().decode(stored[0]);
  const claims = await verifyRunToken(signingKey, token, { tenantId, projectId, runId, profileRevisionId: "profile-r1" },
    Math.floor(now.getTime() / 1_000));
  assert.equal(claims.exp - claims.iat, 15 * 60);
  assert.equal(claims.providerRevisionId, "provider-r1");
  assert.deepEqual(claims.models, ["gateway/claude-sonnet-4-6-20250514"]);
});

test("expired authorization enters WAITING_PROVIDER before isolated execution", async () => {
  let waited = false; let executed = false;
  const persistence: AgentExecutionOperationPersistence = {
    async reserve() { throw new Error("not used"); }, async find() { throw new Error("not used"); },
    async claim() { return { kind: "ACQUIRED", request: request(), lock: { ...lock(), authorizationExpiresAt: now.toISOString() }, attemptId, attempt: 1 }; },
    async heartbeat() {}, async complete() { throw new Error("not expected"); },
    async waitForProvider(input) { waited = input.providerRevisionId === "provider-r1"; },
    async release() { throw new Error("not expected"); }, async probe() {},
  };
  const tokens = new HmacEphemeralRunTokenBroker(new Uint8Array(32).fill(9), {
    async put() { throw new Error("not expected"); }, async revoke() {}, async probe() {},
  }, () => now);
  const worker = new AgentExecutionOperationWorker(persistence, tokens, {
    async execute() { executed = true; return completedResult(); }, async probe() {},
  }, { now: () => now, claimToken: () => claimToken });
  assert.equal(await worker.execute({ tenantId, runId }), null);
  assert.equal(waited, true); assert.equal(executed, false);
});

test("mTLS ingress binds tenant headers and returns the Provider wait contract", async () => {
  const persistence: AgentExecutionOperationPersistence = {
    async reserve() { throw new AgentProviderUnavailable("provider-r1"); }, async find() { throw new Error("not used"); },
    async claim() { throw new Error("not used"); }, async heartbeat() {}, async complete() { throw new Error("not used"); },
    async waitForProvider() {}, async release() {}, async probe() {},
  };
  const service = new DurableAgentExecutionService(persistence, { async enqueue() {}, async probe() {} }, () => now);
  const handler = createAgentExecutionBrokerHandler({ service,
    allowedSpiffeIds: new Set(["spiffe://deviludo.internal/service/agent-worker"]),
    healthIdentity: { version: "1.0.0", binaryDigest: "1".repeat(64) },
    extractIdentity: () => ({ spiffeId: "spiffe://deviludo.internal/service/agent-worker" }),
  });
  const headers = { "content-type": "application/json", "x-deviludo-tenant-id": tenantId,
    "idempotency-key": request().operationKey, "x-deviludo-request-digest": request().requestDigest };
  const response = await handler({ method: "POST", path: "/v1/agent-runs", headers, socket: {}, rawBody: JSON.stringify(request()) });
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { error: { code: "PROVIDER_UNAVAILABLE", providerRevisionId: "provider-r1" } });
  const drift = await handler({ method: "POST", path: "/v1/agent-runs", headers: { ...headers, "x-deviludo-tenant-id": projectId },
    socket: {}, rawBody: JSON.stringify(request()) });
  assert.equal(drift.status, 400);
});

test("durable submit persists before idempotent dispatch and validates the locked run", async () => {
  const queued: string[] = [];
  const running: AgentExecutionStatus = { status: "RUNNING", runId, providerRevisionId: "provider-r1", receipt: null };
  const service = new DurableAgentExecutionService({
    async reserve(input) { assert.equal(input.submitterSpiffeId, "spiffe://deviludo.internal/service/agent-worker"); return { created: true, status: running }; },
    async find() { return running; }, async claim() { throw new Error("not used"); }, async heartbeat() {},
    async complete() { throw new Error("not used"); }, async waitForProvider() {}, async release() {}, async probe() {},
  }, { async enqueue(input) { queued.push(input.runId); }, async probe() {} }, () => now);
  const status = await service.submit({ spiffeId: "spiffe://deviludo.internal/service/agent-worker" }, request());
  assert.equal(status.runId, runId); assert.deepEqual(queued, [runId]);
});

test("PostgreSQL Provider wait commits before returning 409 semantics", async () => {
  const sql: string[] = [];
  const lockWithoutDigest = {
    profileRevisionId: "profile-r1", installationId: "installation-r1", imageDigest: `sha256:${"c".repeat(64)}`,
    exactAgentVersion: "2.1.14", adapterVersion: "adapter-1.0.0", agent: "claude-code",
    providerRevisionId: "provider-r1", providerProtocol: "anthropic-messages",
    providerBaseUrl: "https://gateway.example.invalid/v1", credentialVersionId: "credential-v1",
    budget: { maxUsd: 10, maxTurns: 50, timeoutSeconds: 3_600 },
    specRevisionId: "77777777-7777-4777-8777-777777777777",
    testPlanRevisionId: "88888888-8888-4888-8888-888888888888",
    sourceBaselineReceiptId: "99999999-9999-4999-8999-999999999999",
    commitSha: "d".repeat(40), sourceDigest: "e".repeat(64),
  };
  const resolutionDigest = sha256Canonical(lockWithoutDigest);
  const authority = {
    id: runId, tenant_id: tenantId, project_id: projectId, state: "QUEUED",
    profile_revision_id: "profile-r1", installation_id: "installation-r1", image_digest: `sha256:${"c".repeat(64)}`,
    adapter_version: "adapter-1.0.0", exact_agent_version: "2.1.14", provider_revision_id: "provider-r1",
    model: "gateway/claude-sonnet-4-6-20250514", credential_version_id: "credential-v1", resolution_digest: resolutionDigest,
    configuration_lock: { ...lockWithoutDigest, resolutionDigest }, spec_revision_id: lockWithoutDigest.specRevisionId,
    test_plan_revision_id: lockWithoutDigest.testPlanRevisionId, source_baseline_receipt_id: lockWithoutDigest.sourceBaselineReceiptId,
    authorization_profile_revision_id: "profile-r1", authorization_provider_revision_id: "provider-r1",
    authorization_credential_version_id: "credential-v1", authorization_models: ["gateway/claude-sonnet-4-6-20250514"],
    authorization_budget: { maxCostUsd: 10 }, authorization_nonce: "nonce-r1", authorization_state: "ACTIVE",
    authorization_expires_at: "2030-01-01T01:00:00.000Z", provider_state: "DEGRADED",
  };
  const operation = { tenant_id: tenantId, project_id: projectId, run_id: runId, operation_key: request().operationKey,
    request_digest: request().requestDigest, provider_revision_id: "provider-r1", request_payload: request(),
    state: "WAITING_PROVIDER", attempt_count: 0, claim_token: null, claim_expires_at: null, attempt_id: null, receipt_payload: null };
  const client = {
    async query<Row extends Record<string, unknown>>(statement: string) {
      sql.push(statement.trim());
      if (statement.includes("FROM deviludo.agent_runs run")) return { rowCount: 1, rows: [authority as unknown as Row] };
      if (statement.includes("FROM deviludo.agent_execution_operations")) return { rowCount: 1, rows: [operation as unknown as Row] };
      return { rowCount: statement.startsWith("UPDATE") ? 1 : 0, rows: [] as Row[] };
    }, release() {},
  };
  const pool: PostgresWorkflowPool = { async connect() { return client; } };
  const store = new PostgresAgentExecutionOperations(pool);
  await assert.rejects(store.reserve({ submitterSpiffeId: "spiffe://deviludo.internal/service/agent-worker",
    request: request(), createdAt: now.toISOString() }), (error: unknown) => error instanceof AgentProviderUnavailable);
  assert.equal(sql.at(-1), "COMMIT");
  assert.equal(sql.includes("ROLLBACK"), false);
  assert.ok(sql.some((statement) => statement.includes("SET state = 'WAITING_PROVIDER'")));
});
