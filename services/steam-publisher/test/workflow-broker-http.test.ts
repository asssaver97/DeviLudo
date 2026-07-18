import assert from "node:assert/strict";
import test from "node:test";
import {
  createSteamWorkflowBrokerHandler,
  createSteamWorkflowBrokerHttpsServer,
  type SteamWorkflowOperationService,
  type SteamWorkflowOperationStatus,
} from "../src/workflow-broker-http";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const evidenceId = "44444444-4444-4444-8444-444444444444";
const mfaId = "55555555-5555-4555-8555-555555555555";
const operationKey = "workflow-job:66666666-6666-4666-8666-666666666666";
const requestDigest = "a".repeat(64);
const healthIdentity = Object.freeze({ version: "1.0.0", binaryDigest: "9".repeat(64) });
const identity = Object.freeze({
  spiffeId: "spiffe://deviludo.internal/temporal-steam-publisher",
  certificateFingerprint: "8".repeat(64),
  certificateSerial: "01",
  certificateNotAfter: "2099-01-02T00:00:00.000Z",
});
const body = Object.freeze({
  schemaVersion: "deviludo.steam-workflow.v1",
  kind: "PRIVATE_BETA_UPLOAD",
  operationKey,
  requestDigest,
  tenantId,
  projectId,
  workflowId: "delivery-001",
  runId,
  mainCommitSha: "b".repeat(40),
  mainEvidenceBundleId: evidenceId,
  mfaApprovalId: mfaId,
  targetMatrix: ["linux", "windows"],
});
const headers = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "idempotency-key": operationKey,
  "x-deviludo-request-digest": requestDigest,
  "x-deviludo-tenant-id": tenantId,
});
const postRequest = Object.freeze({
  method: "POST",
  path: "/v1/steam-operations",
  headers,
  socket: {},
  rawBody: JSON.stringify(body),
});

function running(overrides: Record<string, unknown> = {}): SteamWorkflowOperationStatus {
  return {
    status: "RUNNING", kind: "PRIVATE_BETA_UPLOAD", operationId: "steam-operation-001",
    operationKey, requestDigest, receipt: null, ...overrides,
  } as SteamWorkflowOperationStatus;
}

function completed(overrides: Record<string, unknown> = {}): SteamWorkflowOperationStatus {
  return {
    status: "COMPLETED", kind: "PRIVATE_BETA_UPLOAD", operationId: "steam-operation-001",
    operationKey, requestDigest,
    receipt: {
      receiptId: "steam-upload-receipt-001", runId, mainCommitSha: "b".repeat(40),
      mainEvidenceBundleId: evidenceId, mfaApprovalId: mfaId,
      targetMatrix: ["linux", "windows"], buildId: "91234567",
    },
    ...overrides,
  } as SteamWorkflowOperationStatus;
}

function handler(service: SteamWorkflowOperationService) {
  return createSteamWorkflowBrokerHandler({
    service,
    allowedSpiffeIds: new Set([identity.spiffeId]),
    healthIdentity,
    extractIdentity: () => identity,
  });
}

test("Steam workflow Broker mTLS ingress freezes one bound operation and returns versioned statuses", async () => {
  let submitted = 0;
  let fetched = 0;
  const ingress = handler({
    async probe() {},
    async submit(receivedIdentity, request) {
      submitted += 1;
      assert.deepEqual(receivedIdentity, identity);
      assert.equal(Object.isFrozen(request), true);
      assert.equal(Object.isFrozen(request.kind === "PRIVATE_BETA_UPLOAD" ? request.targetMatrix : []), true);
      return running();
    },
    async get(receivedIdentity, lookup) {
      fetched += 1;
      assert.deepEqual(receivedIdentity, identity);
      assert.deepEqual(lookup, { tenantId, operationId: "steam-operation-001", operationKey, requestDigest });
      return completed();
    },
  });
  const accepted = await ingress(postRequest);
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.body, {
    schemaVersion: "deviludo.steam-workflow-operation-status.v1",
    ...running(),
  });
  const fetchedStatus = await ingress({
    ...postRequest, method: "GET", path: "/v1/steam-operations/steam-operation-001",
    headers, rawBody: "",
  });
  assert.equal(fetchedStatus.status, 200);
  assert.equal(fetchedStatus.body.schemaVersion, "deviludo.steam-workflow-operation-status.v1");
  assert.equal((fetchedStatus.body.receipt as { buildId?: string }).buildId, "91234567");
  assert.deepEqual({ submitted, fetched }, { submitted: 1, fetched: 1 });

  const health = await ingress({ ...postRequest, method: "GET", path: "/healthz", headers: {}, rawBody: "" });
  assert.deepEqual(health, { status: 200, body: {
    schemaVersion: "deviludo.steam-workflow-broker-health.v1",
    status: "ok", service: "deviludo-steam-workflow-broker", ...healthIdentity,
  } });
});

test("Steam workflow Broker rejects unauthenticated, mismatched and non-canonical requests before execution", async () => {
  let executions = 0;
  const service: SteamWorkflowOperationService = {
    async probe() {},
    async submit() { executions += 1; return running(); },
    async get() { executions += 1; return running(); },
  };
  const noIdentity = createSteamWorkflowBrokerHandler({
    service, allowedSpiffeIds: new Set([identity.spiffeId]), healthIdentity,
    extractIdentity: () => { throw new Error("certificate missing"); },
  });
  assert.equal((await noIdentity(postRequest)).status, 401);
  const forbidden = createSteamWorkflowBrokerHandler({
    service, allowedSpiffeIds: new Set(["spiffe://deviludo.internal/other"]), healthIdentity,
    extractIdentity: () => identity,
  });
  assert.equal((await forbidden(postRequest)).status, 403);
  const ingress = handler(service);
  assert.equal((await ingress({ ...postRequest, path: "/missing" })).status, 404);
  assert.equal((await ingress({ ...postRequest, headers: { ...headers, "content-type": "text/plain" } })).status, 415);
  assert.equal((await ingress({ ...postRequest, headers: { ...headers, "x-deviludo-tenant-id": projectId } })).status, 400);
  assert.equal((await ingress({ ...postRequest, rawBody: JSON.stringify({ ...body, configVdf: "secret" }) })).status, 400);
  assert.equal((await ingress({ ...postRequest, method: "GET", path: "/v1/steam-operations/steam-operation-001", rawBody: "{}" })).status, 400);
  assert.equal(executions, 0);
});

test("Steam workflow Broker strips executor trust and rejects identity, receipt or secret-field drift", async () => {
  const checks: SteamWorkflowOperationStatus[] = [
    running({ configVdf: "secret" }),
    running({ requestDigest: "c".repeat(64) }),
    completed({ receipt: { ...(completed().receipt as unknown as Record<string, unknown>), password: "secret" } }),
    completed({ receipt: { ...(completed().receipt as unknown as Record<string, unknown>), mainCommitSha: "d".repeat(40) } }),
  ];
  for (const returned of checks) {
    const ingress = handler({ async probe() {}, async submit() { return returned; }, async get() { return returned; } });
    const response = await ingress(postRequest);
    assert.equal(response.status, 409);
    assert.doesNotMatch(JSON.stringify(response), /secret|config\.vdf|password/i);
  }
});

test("Steam workflow Broker HTTPS server requires TLS 1.3 client auth and bounded settings", () => {
  const ingress = async () => ({ status: 200, body: {} });
  assert.throws(() => createSteamWorkflowBrokerHttpsServer({ tls: {}, handler: ingress }), /incomplete/);
  assert.throws(() => createSteamWorkflowBrokerHttpsServer({
    tls: { key: "key", cert: "cert", ca: "ca" }, handler: ingress, maxBodyBytes: 31 * 1024,
  }), /body limit/);
  assert.throws(() => createSteamWorkflowBrokerHttpsServer({
    tls: { key: "key", cert: "cert", ca: "ca" }, handler: ingress, requestTimeoutMs: 999,
  }), /timeout/);
  assert.throws(() => createSteamWorkflowBrokerHandler({
    service: { async probe() {}, async submit() { return running(); }, async get() { return running(); } },
    allowedSpiffeIds: new Set(), healthIdentity, extractIdentity: () => identity,
  }), /allow-list/);
  assert.throws(() => createSteamWorkflowBrokerHandler({
    service: { async probe() {}, async submit() { return running(); }, async get() { return running(); } },
    allowedSpiffeIds: new Set([identity.spiffeId]),
    healthIdentity: { ...healthIdentity, version: "latest" }, extractIdentity: () => identity,
  }), /contract/);
});
