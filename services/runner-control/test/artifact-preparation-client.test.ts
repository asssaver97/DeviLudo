import assert from "node:assert/strict";
import test from "node:test";
import { MtlsRunnerArtifactPreparationClient } from "../src/artifact-preparation-client";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const sha = (value: string) => value.repeat(64);
const tls = { key: Buffer.alloc(32, 1), certificate: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) };
const input = Object.freeze({
  tenantId,
  projectId,
  runId,
  lockKey: sha("a"),
  mode: "CANDIDATE" as const,
  commitSha: "b".repeat(40),
  targetMatrix: Object.freeze(["linux"] as const),
});
const sourceArtifactDigest = sha("c");
const testPlanDigest = sha("d");

function receipt() {
  return {
    schemaVersion: "deviludo.source-execution-preparation-receipt.v1",
    executionLockId: "44444444-4444-4444-8444-444444444444",
    executionLockDigest: sha("e"),
    sourceDigest: sha("f"),
    sourceArtifactDigest,
    sourceObjectKey: `tenants/${tenantId}/projects/${projectId}/sources/${sourceArtifactDigest}.tar.zst`,
    testPlanDigest,
    testPlanObjectKey: `tenants/${tenantId}/projects/${projectId}/test-plans/${testPlanDigest}.json`,
    created: true,
  };
}

test("Runner Artifact Preparer client sends only a minimal mTLS trigger and verifies its exact receipt", async () => {
  const client = new MtlsRunnerArtifactPreparationClient({
    endpoint: "https://artifact-preparer.internal:4643",
    tls,
    timeoutMs: 30_000,
    async http(request) {
      assert.equal(request.url.href, "https://artifact-preparer.internal:4643/v1/source-execution-preparations");
      assert.equal(request.timeoutMs, 30_000);
      assert.deepEqual(request.tls, tls);
      assert.deepEqual(JSON.parse(request.body), {
        schemaVersion: "deviludo.source-execution-preparation-trigger.v1",
        ...input,
        targetMatrix: ["linux"],
      });
      return { statusCode: 200, payload: receipt() };
    },
  });
  const { schemaVersion: _schemaVersion, ...expected } = receipt();
  assert.equal(_schemaVersion, "deviludo.source-execution-preparation-receipt.v1");
  assert.deepEqual(await client.prepare(input), expected);
});

test("Runner Artifact Preparer client rejects route, receipt and authority failures", async () => {
  assert.throws(() => new MtlsRunnerArtifactPreparationClient({ endpoint: "http://artifact.internal", tls }), /URL is invalid/);
  assert.throws(() => new MtlsRunnerArtifactPreparationClient({ endpoint: "https://artifact.internal/path", tls }), /URL is invalid/);
  const rejected = new MtlsRunnerArtifactPreparationClient({
    endpoint: "https://artifact.internal",
    tls,
    async http() { return { statusCode: 409, payload: {} }; },
  });
  await assert.rejects(rejected.prepare(input), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "RUNNER_ARTIFACT_PREPARATION_REJECTED");
    assert.equal((error as { terminal?: boolean }).terminal, true);
    return true;
  });
  const tampered = new MtlsRunnerArtifactPreparationClient({
    endpoint: "https://artifact.internal",
    tls,
    async http() { return { statusCode: 200, payload: { ...receipt(), sourceObjectKey: "tenants/other/source" } }; },
  });
  await assert.rejects(tampered.prepare(input), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "RUNNER_ARTIFACT_PREPARATION_RECEIPT_INVALID");
    assert.equal((error as { terminal?: boolean }).terminal, true);
    return true;
  });
});

test("Runner Artifact Preparer readiness pins the exact authenticated service identity", async () => {
  const calls: string[] = [];
  const client = new MtlsRunnerArtifactPreparationClient({
    endpoint: "https://artifact.internal",
    tls,
    async http(request) {
      calls.push(`${request.method} ${request.url.href} ${request.body}`);
      return { statusCode: 200, payload: { service: "deviludo-artifact-preparer", status: "ok" } };
    },
  });
  await client.probe();
  assert.deepEqual(calls, ["GET https://artifact.internal/healthz {}"]);

  for (const payload of [
    { status: "ok", service: "another-service" },
    { status: "ok", service: "deviludo-artifact-preparer", detail: "unexpected" },
  ]) {
    const drifted = new MtlsRunnerArtifactPreparationClient({
      endpoint: "https://artifact.internal", tls, async http() { return { statusCode: 200, payload }; },
    });
    await assert.rejects(drifted.probe(), /readiness probe failed/);
  }
});
