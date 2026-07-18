import assert from "node:assert/strict";
import test from "node:test";
import { createSourceSnapshotHandler, createSourceSnapshotHttpsServer } from "../src/source-snapshot-http";
import { sourceBaselineOperationKey } from "../src/source-baseline-contracts";

const spiffeId = "spiffe://deviludo.internal/artifact-preparer/source";
const identity = Object.freeze({
  spiffeId,
  certificateFingerprint: "b".repeat(64),
  certificateSerial: "01",
  certificateNotAfter: "2030-01-01T01:00:00.000Z",
});
const baselineSpiffeId = "spiffe://deviludo.internal/agent-configuration";
const baselineIdentity = Object.freeze({ ...identity, spiffeId: baselineSpiffeId });

test("source snapshot handler delegates an mTLS-authenticated grant without weakening tenant authorization", async () => {
  let observedIdentity: unknown;
  let observedBody: unknown;
  const handler = createSourceSnapshotHandler({
    allowedSpiffeIds: new Set([spiffeId]),
    extractIdentity: () => identity,
    sourceSnapshots: {
      async probe() {},
      async grant(selectedIdentity, body) {
        observedIdentity = selectedIdentity;
        observedBody = body;
        return { schemaVersion: "deviludo.source-snapshot-grant.v1" };
      },
    },
  });
  const request = { schemaVersion: "deviludo.source-snapshot-grant-request.v1" };
  const response = await handler({
    method: "POST",
    path: "/v1/source-snapshot-grants",
    headers: { "content-type": "application/json; charset=utf-8" },
    socket: {},
    rawBody: JSON.stringify(request),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(observedIdentity, identity);
  assert.deepEqual(observedBody, request);
  assert.deepEqual(await handler({ method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" }), {
    status: 200,
    body: { status: "ok", service: "deviludo-source-snapshot" },
  });
});

test("source snapshot handler rejects missing identity, forbidden workloads, malformed JSON and service failures", async () => {
  const service = {
    async probe() { throw new Error("not ready"); },
    async grant() { throw new Error("receipt drift"); },
  };
  const base = {
    method: "POST",
    path: "/v1/source-snapshot-grants",
    headers: { "content-type": "application/json" },
    socket: {},
    rawBody: "{}",
  } as const;
  const missing = createSourceSnapshotHandler({
    sourceSnapshots: service,
    allowedSpiffeIds: new Set([spiffeId]),
    extractIdentity: () => { throw new Error("missing"); },
  });
  assert.equal((await missing(base)).status, 401);
  const forbidden = createSourceSnapshotHandler({
    sourceSnapshots: service,
    allowedSpiffeIds: new Set(["spiffe://deviludo.internal/other"]),
    extractIdentity: () => identity,
  });
  assert.equal((await forbidden(base)).status, 403);
  const allowed = createSourceSnapshotHandler({ sourceSnapshots: service, allowedSpiffeIds: new Set([spiffeId]), extractIdentity: () => identity });
  assert.deepEqual(await allowed(base), { status: 409, body: { error: { code: "SOURCE_SNAPSHOT_GRANT_REJECTED" } } });
  assert.equal((await allowed({ ...base, rawBody: "[1]" })).status, 400);
  assert.equal((await allowed({ ...base, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await allowed({ ...base, path: "/other" })).status, 404);
  assert.equal((await allowed({ ...base, method: "GET", path: "/healthz", rawBody: "" })).status, 503);
});

test("source snapshot HTTPS server requires TLS 1.3 client authentication and bounded bodies", () => {
  assert.throws(() => createSourceSnapshotHttpsServer({ tls: {}, handler: async () => ({ status: 200, body: {} }) }), /incomplete/);
  assert.throws(() => createSourceSnapshotHttpsServer({
    tls: { key: "key", cert: "cert", ca: "ca" },
    handler: async () => ({ status: 200, body: {} }),
    maxBodyBytes: 16,
  }), /body limit/);
});

test("source baseline route has a distinct mTLS role and exact idempotency binding", async () => {
  const projectId = "22222222-2222-4222-8222-222222222222";
  const operationKey = sourceBaselineOperationKey("55555555-5555-4555-8555-555555555555");
  const request = {
    schemaVersion: "deviludo.source-baseline.v1",
    operationKey,
    tenantId: "11111111-1111-4111-8111-111111111111",
    projectId,
    workflowId: `delivery-${projectId}`,
    specRevisionId: "33333333-3333-4333-8333-333333333333",
    testPlanRevisionId: "44444444-4444-4444-8444-444444444444",
    specApprovalReceiptId: "c".repeat(64),
  } as const;
  let baselineCalls = 0;
  const handler = createSourceSnapshotHandler({
    allowedSpiffeIds: new Set([spiffeId]),
    baselineSpiffeIds: new Set([baselineSpiffeId]),
    extractIdentity: (socket) => socket === "baseline" ? baselineIdentity : identity,
    sourceSnapshots: { async probe() {}, async grant() { return {}; } },
    sourceBaselines: {
      async probe() {},
      async resolve(body) {
        assert.deepEqual(body, request);
        baselineCalls += 1;
        return {
          schemaVersion: "deviludo.source-baseline-receipt.v1",
          operationKey: request.operationKey,
          tenantId: request.tenantId,
          projectId: request.projectId,
          workflowId: request.workflowId,
          specRevisionId: request.specRevisionId,
          testPlanRevisionId: request.testPlanRevisionId,
          specApprovalReceiptId: request.specApprovalReceiptId,
          sourceBaselineReceiptId: "66666666-6666-4666-8666-666666666666",
          repositoryBindingId: "77777777-7777-4777-8777-777777777777",
          defaultBranch: "main",
          commitSha: "a".repeat(40),
          sourceDigest: "b".repeat(64),
          observedAt: "2030-01-01T00:00:00.000Z",
          replayed: false,
        };
      },
    },
  });
  const baselineRequest = {
    method: "POST",
    path: "/v1/source-baselines",
    headers: { "content-type": "application/json", "idempotency-key": operationKey },
    socket: "baseline",
    rawBody: JSON.stringify(request),
  } as const;
  assert.equal((await handler(baselineRequest)).status, 201);
  assert.equal(baselineCalls, 1);
  assert.deepEqual(await handler({ ...baselineRequest, socket: "snapshot" }), {
    status: 403,
    body: { error: { code: "SOURCE_BASELINE_WORKLOAD_FORBIDDEN" } },
  });
  assert.equal((await handler({
    ...baselineRequest,
    headers: { ...baselineRequest.headers, "idempotency-key": "f".repeat(64) },
  })).status, 400);
  assert.deepEqual(await handler({ ...baselineRequest, path: "/v1/source-snapshot-grants" }), {
    status: 403,
    body: { error: { code: "SOURCE_SNAPSHOT_WORKLOAD_FORBIDDEN" } },
  });
});
