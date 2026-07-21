import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentExecutionCancelledError,
  MtlsAgentExecutionBroker,
  type AgentExecutionBrokerHttpRequest,
} from "../src/execution-broker";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const lockedId = "33333333-3333-4333-8333-333333333333";
const tls = Object.freeze({
  key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3),
});

function input(heartbeats: string[] = []) {
  return {
    operationKey: "workflow-job:44444444-4444-4444-8444-444444444444",
    requestDigest: "a".repeat(64), tenantId, projectId, workflowId: "delivery-001",
    lockedRunConfigurationId: lockedId, expectedRunId: null, iteration: 2, repairAttempts: 1,
    async heartbeat() { heartbeats.push("heartbeat"); return "2099-01-01T00:05:00.000Z"; },
  };
}

function running(runId = "run-001") {
  return {
    statusCode: 202,
    payload: {
      status: "RUNNING", runId, providerRevisionId: "provider-r1",
      receipt: null,
    },
  };
}

function completed(runId = "run-001") {
  return {
    statusCode: 200,
    payload: {
      status: "COMPLETED", runId, providerRevisionId: "provider-r1",
      receipt: {
        status: "COMPLETED", runId, lockedRunConfigurationId: lockedId,
        agent: "claude-code", profileRevisionId: "profile-r1", installationId: "installation-r1",
        imageDigest: `sha256:${"b".repeat(64)}`, providerRevisionId: "provider-r1",
        model: "gateway/claude-sonnet-4-6-20250514", candidateCommitSha: "c".repeat(40),
        draftPullRequest: 91, diagnosticId: null, receiptId: "agent-receipt-001",
      },
    },
  };
}

function cancelled(runId = "run-001") {
  return {
    statusCode: 200,
    payload: {
      status: "CANCELLED", runId, providerRevisionId: "provider-r1",
      receipt: null,
    },
  };
}

test("mTLS Agent Broker starts once, polls a bound run and heartbeats its workflow lease", async () => {
  const calls: { url: string; request: AgentExecutionBrokerHttpRequest }[] = [];
  const heartbeats: string[] = [];
  let clock = 1_000;
  let poll = 0;
  const broker = new MtlsAgentExecutionBroker({
    endpoint: "https://agent-broker.internal/v1/agent-runs",
    tls, pollIntervalMs: 250, maxWaitMs: 30_000,
    now: () => clock,
    pause: async (delay) => { clock += delay; },
    http: async (url, request) => {
      calls.push({ url: url.href, request });
      if (request.method === "POST") return running();
      poll += 1;
      return poll === 1 ? running() : completed();
    },
  });
  const run = await broker.start(input(heartbeats));
  assert.equal(run.runId, "run-001");
  assert.equal(calls.length, 1);
  assert.deepEqual(heartbeats, []);
  const firstCompletion = run.complete();
  assert.equal(run.complete(), firstCompletion);
  const receipt = await firstCompletion;
  assert.equal(receipt.candidateCommitSha, "c".repeat(40));
  assert.equal(receipt.model, "gateway/claude-sonnet-4-6-20250514");
  assert.deepEqual(heartbeats, ["heartbeat", "heartbeat"]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url, "https://agent-broker.internal/v1/agent-runs");
  assert.equal(calls[1]?.url, "https://agent-broker.internal/v1/agent-runs/run-001");
  assert.equal(calls[0]?.request.method, "POST");
  assert.equal(calls[1]?.request.method, "GET");
  assert.equal(calls[0]?.request.headers["idempotency-key"], input().operationKey);
  assert.equal(calls[0]?.request.headers["x-deviludo-tenant-id"], tenantId);
  assert.equal(calls[1]?.request.headers["x-deviludo-tenant-id"], tenantId);
  const submitted = JSON.parse(calls[0]?.request.body ?? "null") as Record<string, unknown>;
  assert.equal(submitted.lockedRunConfigurationId, lockedId);
  assert.equal(submitted.expectedRunId, null);
  assert.equal(submitted.schemaVersion, "deviludo.agent-execution.v1");
  assert.equal("apiKey" in submitted, false);
  assert.equal("token" in submitted, false);
  assert.equal("credential" in submitted, false);
});

test("mTLS Agent Broker converts only a bound Provider outage into WAITING_PROVIDER", async () => {
  const broker = new MtlsAgentExecutionBroker({
    endpoint: "https://agent-broker.internal/v1/agent-runs", tls,
    http: async () => ({
      statusCode: 409,
      payload: { error: { code: "PROVIDER_UNAVAILABLE", providerRevisionId: "provider-r7" } },
    }),
  });
  await assert.rejects(broker.start(input()), (error: unknown) => {
    assert.equal(error instanceof Error && error.message, "Agent Provider is unavailable");
    assert.equal((error as { providerRevisionId?: string }).providerRevisionId, "provider-r7");
    return true;
  });

  const invalid = new MtlsAgentExecutionBroker({
    endpoint: "https://agent-broker.internal/v1/agent-runs", tls,
    http: async () => ({
      statusCode: 409,
      payload: { error: { code: "PROVIDER_UNAVAILABLE", providerRevisionId: "bad provider" } },
    }),
  });
  await assert.rejects(invalid.start(input()), /invalid bound response/);
});

test("mTLS Agent Broker rejects replay drift and unsafe endpoints", async () => {
  let clock = 1_000;
  const broker = new MtlsAgentExecutionBroker({
    endpoint: "https://agent-broker.internal/v1/agent-runs", tls,
    pollIntervalMs: 250, maxWaitMs: 30_000, now: () => clock,
    pause: async (delay) => { clock += delay; },
    http: async (_url, request) => request.method === "POST" ? running() : completed("run-drifted"),
  });
  const run = await broker.start(input());
  await assert.rejects(run.complete(), /changed an immutable run binding/);

  for (const endpoint of [
    "http://agent-broker.internal/v1/agent-runs",
    "https://user:secret@agent-broker.internal/v1/agent-runs",
    "https://agent-broker.internal/v1/agent-runs?token=secret",
    "https://agent-broker.internal/another-path",
  ]) {
    assert.throws(() => new MtlsAgentExecutionBroker({ endpoint, tls }), /credential-free HTTPS/);
  }
});

test("mTLS Agent Broker accepts an idempotently replayed terminal receipt without polling", async () => {
  let calls = 0;
  const broker = new MtlsAgentExecutionBroker({
    endpoint: "https://agent-broker.internal/v1/agent-runs", tls,
    http: async () => { calls += 1; return completed(); },
  });
  const run = await broker.start(input());
  assert.equal((await run.complete()).receiptId, "agent-receipt-001");
  assert.equal(calls, 1);
});

test("mTLS Agent Broker stops immediately when the authoritative run is already cancelled", async () => {
  let calls = 0;
  const broker = new MtlsAgentExecutionBroker({
    endpoint: "https://agent-broker.internal/v1/agent-runs", tls,
    http: async () => { calls += 1; return cancelled(); },
  });
  await assert.rejects(broker.start(input()), (error: unknown) => {
    assert.ok(error instanceof AgentExecutionCancelledError);
    assert.equal(error.runId, "run-001");
    assert.equal(error.providerRevisionId, "provider-r1");
    return true;
  });
  assert.equal(calls, 1);
});

test("mTLS Agent Broker stops polling without manufacturing a failed receipt after cancellation", async () => {
  const heartbeats: string[] = [];
  let clock = 1_000;
  let calls = 0;
  const broker = new MtlsAgentExecutionBroker({
    endpoint: "https://agent-broker.internal/v1/agent-runs", tls,
    pollIntervalMs: 250, maxWaitMs: 30_000, now: () => clock,
    pause: async (delay) => { clock += delay; },
    http: async (_url, request) => {
      calls += 1;
      return request.method === "POST" ? running() : cancelled();
    },
  });
  const run = await broker.start(input(heartbeats));
  await assert.rejects(run.complete(), AgentExecutionCancelledError);
  assert.deepEqual(heartbeats, ["heartbeat"]);
  assert.equal(calls, 2);

  const invalid = new MtlsAgentExecutionBroker({
    endpoint: "https://agent-broker.internal/v1/agent-runs", tls,
    http: async () => ({ ...cancelled(), payload: { ...cancelled().payload, receipt: completed().payload.receipt } }),
  });
  await assert.rejects(invalid.start(input()), /invalid bound response/);
});

test("mTLS Agent Broker readiness requires its exact workload service identity", async () => {
  const calls: string[] = [];
  const broker = new MtlsAgentExecutionBroker({
    endpoint: "https://agent-broker.internal/v1/agent-runs", tls,
    http: async (url) => {
      calls.push(url.href);
      return { statusCode: 200, payload: { status: "ok", service: "deviludo-agent-execution-broker" } };
    },
  });
  await broker.probe();
  assert.deepEqual(calls, ["https://agent-broker.internal/healthz"]);

  const drifted = new MtlsAgentExecutionBroker({
    endpoint: "https://agent-broker.internal/v1/agent-runs", tls,
    http: async () => ({ statusCode: 200, payload: { status: "ok", service: "another-service" } }),
  });
  await assert.rejects(drifted.probe(), /readiness probe failed/);
});
