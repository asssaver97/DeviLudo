import assert from "node:assert/strict";
import test from "node:test";
import { MtlsScmMergeBroker, type ScmMergeBrokerHttpRequest } from "../src/merge-broker";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const specRevisionId = "44444444-4444-4444-8444-444444444444";
const evidenceBundleId = "55555555-5555-4555-8555-555555555555";
const jobId = "66666666-6666-4666-8666-666666666666";
const candidateCommitSha = "a".repeat(40);
const operationKey = `workflow-job:${jobId}`;
const requestDigest = "b".repeat(64);
const tls = Object.freeze({
  key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3),
});

function input(heartbeats: string[] = []) {
  return {
    operationKey, requestDigest, tenantId, projectId, workflowId: "delivery-001", runId,
    specRevisionId, candidateCommitSha, pullRequestNumber: 91, evidenceBundleId,
    acceptanceSignalId: "acceptance-signal-0001",
    async heartbeat() { heartbeats.push("heartbeat"); return "renewed"; },
  };
}

function running(mergeId = "merge-001") {
  return {
    statusCode: 202,
    payload: { status: "RUNNING", mergeId, operationKey, requestDigest, receipt: null },
  };
}

function completed(overrides: Record<string, unknown> = {}) {
  return {
    statusCode: 200,
    payload: {
      status: "COMPLETED", mergeId: "merge-001", operationKey, requestDigest,
      receipt: {
        receiptId: "scm-receipt-001", runId, candidateCommitSha, pullRequestNumber: 91,
        evidenceBundleId, acceptanceSignalId: "acceptance-signal-0001",
        mergeCommitSha: "c".repeat(40), defaultBranchHeadSha: "c".repeat(40),
        mainSourceDigest: "d".repeat(64), requiresFreshMainSnapshot: false,
        ...overrides,
      },
    },
  };
}

test("mTLS SCM Broker submits immutable merge IDs, polls and heartbeats without GitHub credentials", async () => {
  const calls: { url: string; request: ScmMergeBrokerHttpRequest }[] = [];
  const heartbeats: string[] = [];
  let now = 1_000;
  const broker = new MtlsScmMergeBroker({
    endpoint: "https://scm-merge.internal/v1/merges", tls,
    pollIntervalMs: 250, maxWaitMs: 30_000, now: () => now,
    pause: async (delay) => { now += delay; },
    http: async (url, request) => {
      calls.push({ url: url.href, request });
      return request.method === "POST" ? running() : completed();
    },
  });
  const receipt = await broker.mergeAcceptedCandidate(input(heartbeats));
  assert.equal(receipt.mainSourceDigest, "d".repeat(64));
  assert.deepEqual(heartbeats, ["heartbeat"]);
  assert.equal(calls[0]?.url, "https://scm-merge.internal/v1/merges");
  assert.equal(calls[1]?.url, "https://scm-merge.internal/v1/merges/merge-001");
  assert.equal(calls[0]?.request.headers["idempotency-key"], operationKey);
  const submitted = JSON.parse(calls[0]?.request.body ?? "null") as Record<string, unknown>;
  assert.equal(submitted.schemaVersion, "deviludo.scm-merge.v1");
  assert.equal(submitted.runId, runId);
  assert.equal(submitted.acceptanceSignalId, "acceptance-signal-0001");
  assert.equal("githubToken" in submitted, false);
  assert.equal("appPrivateKey" in submitted, false);
  assert.equal("acceptanceProof" in submitted, false);
});

test("mTLS SCM Broker rejects receipt drift and a changed merge identity", async () => {
  const driftedReceipt = new MtlsScmMergeBroker({
    endpoint: "https://scm-merge.internal/v1/merges", tls,
    http: async () => completed({ evidenceBundleId: "77777777-7777-4777-8777-777777777777" }),
  });
  await assert.rejects(driftedReceipt.mergeAcceptedCandidate(input()), /invalid bound response/);

  let now = 1_000;
  const driftedMerge = new MtlsScmMergeBroker({
    endpoint: "https://scm-merge.internal/v1/merges", tls,
    pollIntervalMs: 250, maxWaitMs: 30_000, now: () => now,
    pause: async (delay) => { now += delay; },
    http: async (_url, request) => request.method === "POST" ? running() : {
      ...completed(), payload: { ...(completed().payload as Record<string, unknown>), mergeId: "merge-002" },
    },
  });
  await assert.rejects(driftedMerge.mergeAcceptedCandidate(input()), /changed the immutable merge identity/);
});

test("mTLS SCM Broker carries only bounded workflow error codes from its authenticated Broker", async () => {
  const broker = new MtlsScmMergeBroker({
    endpoint: "https://scm-merge.internal/v1/merges", tls,
    http: async () => ({
      statusCode: 200,
      payload: { status: "FAILED", mergeId: "merge-001", operationKey, requestDigest,
        errorCode: "GITHUB_BRANCH_PROTECTION_BLOCKED", terminal: true, receipt: null },
    }),
  });
  await assert.rejects(broker.mergeAcceptedCandidate(input()), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "GITHUB_BRANCH_PROTECTION_BLOCKED");
    assert.equal((error as { terminal?: boolean }).terminal, true);
    return true;
  });
});

test("mTLS SCM Broker pins its endpoint and exact health identity", async () => {
  const calls: string[] = [];
  const broker = new MtlsScmMergeBroker({
    endpoint: "https://scm-merge.internal/v1/merges", tls,
    http: async (url) => {
      calls.push(url.href);
      return { statusCode: 200, payload: { schemaVersion: "deviludo.scm-merge-health.v1",
        status: "ok", service: "deviludo-scm-merge-broker" } };
    },
  });
  await broker.probe();
  assert.deepEqual(calls, ["https://scm-merge.internal/healthz"]);

  const drifted = new MtlsScmMergeBroker({
    endpoint: "https://scm-merge.internal/v1/merges", tls,
    http: async () => ({ statusCode: 200, payload: { schemaVersion: "deviludo.scm-merge-health.v1",
      status: "ok", service: "deviludo-scm-merge-broker", detail: "not part of the contract" } }),
  });
  await assert.rejects(drifted.probe(), /readiness probe failed/);

  for (const endpoint of [
    "http://scm-merge.internal/v1/merges",
    "https://user:secret@scm-merge.internal/v1/merges",
    "https://scm-merge.internal/v1/merges?token=secret",
    "https://scm-merge.internal/another-path",
  ]) assert.throws(() => new MtlsScmMergeBroker({ endpoint, tls }), /endpoint is invalid/);
});
