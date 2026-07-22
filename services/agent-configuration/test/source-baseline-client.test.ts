import assert from "node:assert/strict";
import test from "node:test";
import { sourceBaselineOperationKey } from "../../scm-proxy/src/source-baseline-contracts";
import { MtlsSourceBaselineClient, type SourceBaselineBrokerHttp } from "../src/source-baseline-client";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const request = Object.freeze({
  schemaVersion: "deviludo.source-baseline.v1" as const,
  operationKey: sourceBaselineOperationKey("33333333-3333-4333-8333-333333333333"),
  tenantId,
  projectId,
  workflowId: `delivery-${projectId}`,
  specRevisionId: "44444444-4444-4444-8444-444444444444",
  testPlanRevisionId: "55555555-5555-4555-8555-555555555555",
  specApprovalReceiptId: "a".repeat(64),
});

test("source baseline client pins mTLS origin, route and idempotency key", async () => {
  const calls: Parameters<SourceBaselineBrokerHttp>[0][] = [];
  const client = clientWith(async (input) => {
    calls.push(input);
    if (input.method === "GET") return { statusCode: 200, payload: { status: "ok", service: "deviludo-source-snapshot" } };
    return { statusCode: 201, payload: { data: receipt(false) } };
  });
  assert.deepEqual(await client.resolve(request), receipt(false));
  await client.probe();
  assert.equal(calls[0]!.url.href, "https://source-snapshot.internal:4543/v1/source-baselines");
  assert.equal(calls[0]!.idempotencyKey, request.operationKey);
  assert.equal(calls[1]!.url.href, "https://source-snapshot.internal:4543/healthz");
});

test("source baseline client rejects receipt drift and status/replay mismatch", async () => {
  await assert.rejects(clientWith(async () => ({ statusCode: 201, payload: { data: { ...receipt(false), projectId: tenantId } } })).resolve(request), /response|binding/);
  await assert.rejects(clientWith(async () => ({ statusCode: 200, payload: { data: receipt(false) } })).resolve(request), /response/);
  await assert.rejects(clientWith(async () => ({ statusCode: 409, payload: { error: { code: "CONFLICT" } } })).resolve(request), /status 409/);
  assert.throws(() => clientWith(async () => ({ statusCode: 200, payload: {} }), "http://localhost:4543"), /configuration/);
});

test("source baseline readiness rejects health identity drift", async () => {
  for (const payload of [
    { status: "ok", service: "another-service" },
    { status: "ok", service: "deviludo-source-snapshot", detail: "must-not-be-accepted" },
  ]) {
    await assert.rejects(clientWith(async () => ({ statusCode: 200, payload })).probe(), /response/);
  }
});

function clientWith(http: SourceBaselineBrokerHttp, endpoint = "https://source-snapshot.internal:4543") {
  return new MtlsSourceBaselineClient({
    endpoint,
    tls: { key: Buffer.alloc(32), certificate: Buffer.alloc(32), ca: Buffer.alloc(32) },
    http,
  });
}
function receipt(replayed: boolean) {
  return {
    schemaVersion: "deviludo.source-baseline-receipt.v1" as const,
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
    commitSha: "b".repeat(40),
    sourceDigest: "c".repeat(64),
    observedAt: "2030-01-01T00:00:00.000Z",
    replayed,
  };
}
