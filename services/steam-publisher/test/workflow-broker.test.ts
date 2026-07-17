import assert from "node:assert/strict";
import test from "node:test";
import { MtlsSteamWorkflowBroker, type SteamWorkflowBrokerHttpRequest } from "../src/workflow-broker";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const evidenceId = "44444444-4444-4444-8444-444444444444";
const mfaId = "55555555-5555-4555-8555-555555555555";
const jobId = "66666666-6666-4666-8666-666666666666";
const operationKey = `workflow-job:${jobId}`;
const requestDigest = "a".repeat(64);
const tls = Object.freeze({
  key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3),
});

function common(heartbeats: string[] = []) {
  return {
    operationKey, requestDigest, tenantId, projectId, workflowId: "delivery-001", runId,
    async heartbeat() { heartbeats.push("heartbeat"); return "renewed"; },
  };
}

function uploadInput(heartbeats: string[] = []) {
  return {
    ...common(heartbeats), mainCommitSha: "b".repeat(40), mainEvidenceBundleId: evidenceId,
    mfaApprovalId: mfaId, targetMatrix: Object.freeze(["linux", "windows"] as const),
  };
}

function publishInput(heartbeats: string[] = []) {
  return {
    ...common(heartbeats), betaBuildId: "91234567",
    externalApprovalIds: Object.freeze(["valve-approval-1", "first-release-1", "default-confirm-1"]),
  };
}

function running(kind: "PRIVATE_BETA_UPLOAD" | "DEFAULT_BRANCH_PUBLISH", operationId = "steam-operation-001") {
  return {
    statusCode: 202,
    payload: { status: "RUNNING", kind, operationId, operationKey, requestDigest, receipt: null },
  };
}

function uploaded(overrides: Record<string, unknown> = {}) {
  return {
    statusCode: 200,
    payload: {
      status: "COMPLETED", kind: "PRIVATE_BETA_UPLOAD", operationId: "steam-operation-001",
      operationKey, requestDigest,
      receipt: {
        receiptId: "steam-upload-receipt-001", runId, mainCommitSha: "b".repeat(40),
        mainEvidenceBundleId: evidenceId, mfaApprovalId: mfaId,
        targetMatrix: ["linux", "windows"], buildId: "91234567", ...overrides,
      },
    },
  };
}

function published(overrides: Record<string, unknown> = {}) {
  return {
    statusCode: 200,
    payload: {
      status: "COMPLETED", kind: "DEFAULT_BRANCH_PUBLISH", operationId: "steam-operation-002",
      operationKey, requestDigest,
      receipt: {
        receiptId: "steam-publish-receipt-001", releaseId: "steam-release-001", runId,
        betaBuildId: "91234567", defaultBranchBuildId: "91234567",
        externalApprovalIds: ["valve-approval-1", "first-release-1", "default-confirm-1"],
        ...overrides,
      },
    },
  };
}

test("mTLS Steam Broker uploads a bound private Beta and heartbeats without credential material", async () => {
  const calls: { url: string; request: SteamWorkflowBrokerHttpRequest }[] = [];
  const heartbeats: string[] = [];
  let now = 1_000;
  const broker = new MtlsSteamWorkflowBroker({
    endpoint: "https://steam-workflow.internal/v1/steam-operations", tls,
    pollIntervalMs: 250, maxWaitMs: 30_000, now: () => now,
    pause: async (delay) => { now += delay; },
    http: async (url, request) => {
      calls.push({ url: url.href, request });
      return request.method === "POST" ? running("PRIVATE_BETA_UPLOAD") : uploaded();
    },
  });
  const receipt = await broker.upload(uploadInput(heartbeats));
  assert.equal(receipt.buildId, "91234567");
  assert.deepEqual(heartbeats, ["heartbeat"]);
  assert.equal(calls[0]?.url, "https://steam-workflow.internal/v1/steam-operations");
  assert.equal(calls[1]?.url, "https://steam-workflow.internal/v1/steam-operations/steam-operation-001");
  const submitted = JSON.parse(calls[0]?.request.body ?? "null") as Record<string, unknown>;
  assert.equal(submitted.kind, "PRIVATE_BETA_UPLOAD");
  assert.equal(submitted.mainEvidenceBundleId, evidenceId);
  assert.equal("password" in submitted, false);
  assert.equal("guardCode" in submitted, false);
  assert.equal("configVdf" in submitted, false);
  assert.equal("secretRef" in submitted, false);
});

test("mTLS Steam Broker promotes only the same approved, clean-install-tested BuildID", async () => {
  const broker = new MtlsSteamWorkflowBroker({
    endpoint: "https://steam-workflow.internal/v1/steam-operations", tls,
    http: async () => published(),
  });
  const receipt = await broker.publish(publishInput());
  assert.equal(receipt.defaultBranchBuildId, "91234567");
  assert.deepEqual(receipt.externalApprovalIds, publishInput().externalApprovalIds);

  const drifted = new MtlsSteamWorkflowBroker({
    endpoint: "https://steam-workflow.internal/v1/steam-operations", tls,
    http: async () => published({ defaultBranchBuildId: "99999999" }),
  });
  await assert.rejects(drifted.publish(publishInput()), /invalid bound response/);
});

test("mTLS Steam Broker rejects operation drift and carries bounded Broker failure codes", async () => {
  let now = 1_000;
  const drifted = new MtlsSteamWorkflowBroker({
    endpoint: "https://steam-workflow.internal/v1/steam-operations", tls,
    pollIntervalMs: 250, maxWaitMs: 30_000, now: () => now,
    pause: async (delay) => { now += delay; },
    http: async (_url, request) => request.method === "POST" ? running("PRIVATE_BETA_UPLOAD") : {
      ...uploaded(), payload: { ...(uploaded().payload as Record<string, unknown>), operationId: "steam-operation-999" },
    },
  });
  await assert.rejects(drifted.upload(uploadInput()), /changed the immutable operation identity/);

  const failed = new MtlsSteamWorkflowBroker({
    endpoint: "https://steam-workflow.internal/v1/steam-operations", tls,
    http: async () => ({ statusCode: 200, payload: {
      status: "FAILED", kind: "DEFAULT_BRANCH_PUBLISH", operationId: "steam-operation-002",
      operationKey, requestDigest, errorCode: "STEAM_EXTERNAL_APPROVAL_REVOKED", terminal: true, receipt: null,
    } }),
  });
  await assert.rejects(failed.publish(publishInput()), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "STEAM_EXTERNAL_APPROVAL_REVOKED");
    assert.equal((error as { terminal?: boolean }).terminal, true);
    return true;
  });
});

test("mTLS Steam Broker pins its endpoint and exact health identity", async () => {
  const calls: string[] = [];
  const broker = new MtlsSteamWorkflowBroker({
    endpoint: "https://steam-workflow.internal/v1/steam-operations", tls,
    http: async (url) => {
      calls.push(url.href);
      return { statusCode: 200, payload: { status: "ok", service: "deviludo-steam-workflow-broker" } };
    },
  });
  await broker.probe();
  assert.deepEqual(calls, ["https://steam-workflow.internal/healthz"]);
  for (const endpoint of [
    "http://steam-workflow.internal/v1/steam-operations",
    "https://user:secret@steam-workflow.internal/v1/steam-operations",
    "https://steam-workflow.internal/v1/steam-operations?token=secret",
    "https://steam-workflow.internal/other",
  ]) assert.throws(() => new MtlsSteamWorkflowBroker({ endpoint, tls }), /endpoint is invalid/);
});
