import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { bundleWorkflowCode } from "@temporalio/worker";
import Fastify from "fastify";
import {
  createDeliveryActivities,
  deliveryDispatchEndpointsFromEnv,
  type DeliveryDispatchRequest,
} from "../src/activities";
import { temporalWebpackConfigHook } from "../src/bundler";
import type { DeliverySnapshot } from "../src/contracts";
import {
  InMemoryWorkflowCommandInbox,
  WorkflowCommandReceiver,
  deliveryDispatchRequestDigest,
  type WorkflowDispatchHeaders,
} from "../src/receiver";
import {
  PostgresWorkflowCommandInbox,
  type PostgresQueryResult,
  type PostgresWorkflowClient,
} from "../src/postgres-inbox";
import { PostgresWorkflowCommandQueue } from "../src/postgres-queue";
import {
  WorkflowJobError,
  WorkflowJobProcessor,
  type WorkflowJobQueuePort,
} from "../src/job-processor";
import { WorkflowJobWorkerHost } from "../src/job-worker-host";
import type { ClaimedWorkflowJob } from "../src/postgres-queue";
import {
  parseWorkflowSpiffeId,
  registerWorkflowCommandRoute,
} from "../src/receiver-http";
import { createWorkflowDestinationRuntime } from "../src/destination-runtime";
import {
  SignedWorkflowTenantAssignmentSource,
  signWorkflowTenantAssignments,
  type WorkflowTenantAssignmentClaims,
} from "../src/tenant-assignments";
import { postgresWorkflowPoolFromEnv } from "../src/node-postgres";
import { MtlsCommandDispatcher } from "../src/mtls-dispatcher";
import { temporalTlsConfigFromEnv } from "../src/temporal-tls";
import { dispatchKey } from "../src/workflows/game-delivery.workflow";
import { GameDeliveryWorkflow } from "../../../lib/orchestration/game-delivery";
import {
  DELIVERY_PROJECTION_SCHEMA_VERSION,
  deliveryProjectionKey,
} from "../../../lib/orchestration/delivery-projection";

const unusedProjections = {
  async persist(): Promise<never> { throw new Error("must not project"); },
};

const snapshot: DeliverySnapshot = {
  workflowId: "delivery-001",
  tenantId: "tenant-001",
  projectId: "project-001",
  state: "DEVELOPMENT_QUEUED",
  specRevisionId: "spec-r1",
  testPlanRevisionId: "plan-r1",
  specApprovalReceiptId: "spec-approval-r1",
  lockedRunConfigurationId: "lock-r1",
  runId: null,
  candidateCommitSha: null,
  draftPullRequest: null,
  mainCommitSha: null,
  evidenceBundleId: null,
  candidateEvidenceBundleId: null,
  mainEvidenceBundleId: null,
  steamInstallEvidenceBundleId: null,
  mfaApprovalId: null,
  steamBuildId: null,
  steamReleaseId: null,
  defaultBranchBuildId: null,
  targetMatrix: ["linux", "macos", "windows"],
  iteration: 1,
  repairAttempts: 0,
  waitingProviderRevisionId: null,
  externalGate: null,
  externalApprovals: [],
  history: [],
};

function agentDispatch(
  value: DeliverySnapshot = snapshot,
): Extract<DeliveryDispatchRequest, { kind: "COMMAND" }> {
  return {
    kind: "COMMAND",
    destination: "agent-worker",
    payload: {
      idempotencyKey: dispatchKey(value, "START_LOCKED_AGENT_RUN"),
      workflowId: value.workflowId,
      tenantId: value.tenantId,
      projectId: value.projectId,
      destination: "agent-worker",
      command: "START_LOCKED_AGENT_RUN",
      snapshot: value,
    },
  };
}

function headersFor(request: DeliveryDispatchRequest): WorkflowDispatchHeaders {
  return {
    idempotencyKey: request.payload.idempotencyKey,
    workflowId: request.payload.workflowId,
    destination: request.destination,
    operation: request.kind === "COMMAND" ? request.payload.command : "CANCEL_DELIVERY",
  };
}

function receiptFor(request: DeliveryDispatchRequest) {
  return {
    receiptId: "receipt-001",
    acceptedAt: "2026-07-17T00:00:00.000Z",
    destination: request.destination,
    workflowId: request.payload.workflowId,
    idempotencyKey: request.payload.idempotencyKey,
    operation: request.kind === "COMMAND" ? request.payload.command : "CANCEL_DELIVERY",
  } as const;
}

test("activity adapter preserves immutable bindings and deterministic idempotency", async () => {
  const seen: DeliveryDispatchRequest[] = [];
  const activities = createDeliveryActivities({
    async dispatch(request) {
      seen.push(request);
      return receiptFor(request);
    },
  }, unusedProjections);
  const idempotencyKey = dispatchKey(snapshot, "START_LOCKED_AGENT_RUN");
  const receipt = await activities.dispatchDeliveryCommand({
    idempotencyKey,
    workflowId: snapshot.workflowId,
    tenantId: snapshot.tenantId,
    projectId: snapshot.projectId,
    destination: "agent-worker",
    command: "START_LOCKED_AGENT_RUN",
    snapshot,
  });
  assert.equal(receipt.receiptId, "receipt-001");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.destination, "agent-worker");
  assert.equal(seen[0]?.payload.idempotencyKey, "delivery-001:0:DEVELOPMENT_QUEUED:START_LOCKED_AGENT_RUN");
});

test("activity adapter rejects a snapshot from another tenant or workflow", async () => {
  const activities = createDeliveryActivities({
    async dispatch() {
      throw new Error("must not be called");
    },
  }, unusedProjections);
  await assert.rejects(
    activities.dispatchDeliveryCommand({
      idempotencyKey: "delivery-001:0:DEVELOPMENT_QUEUED:START_LOCKED_AGENT_RUN",
      workflowId: snapshot.workflowId,
      tenantId: "tenant-other",
      projectId: snapshot.projectId,
      destination: "agent-worker",
      command: "START_LOCKED_AGENT_RUN",
      snapshot,
    }),
    /binding mismatch/,
  );
});

test("activity adapter rejects destination spoofing and unbound receipts", async () => {
  const spoofed = createDeliveryActivities({
    async dispatch(request) {
      return receiptFor(request);
    },
  }, unusedProjections);
  await assert.rejects(
    spoofed.dispatchDeliveryCommand({
      idempotencyKey: "delivery-001:0:DEVELOPMENT_QUEUED:START_LOCKED_AGENT_RUN",
      workflowId: snapshot.workflowId,
      tenantId: snapshot.tenantId,
      projectId: snapshot.projectId,
      destination: "steam-publisher",
      command: "START_LOCKED_AGENT_RUN",
      snapshot,
    }),
    /destination mismatch/,
  );

  const mismatchedReceipt = createDeliveryActivities({
    async dispatch(request) {
      return { ...receiptFor(request), workflowId: "delivery-other" };
    },
  }, unusedProjections);
  await assert.rejects(
    mismatchedReceipt.dispatchDeliveryCommand({
      idempotencyKey: "delivery-001:0:DEVELOPMENT_QUEUED:START_LOCKED_AGENT_RUN",
      workflowId: snapshot.workflowId,
      tenantId: snapshot.tenantId,
      projectId: snapshot.projectId,
      destination: "agent-worker",
      command: "START_LOCKED_AGENT_RUN",
      snapshot,
    }),
    /receipt binding mismatch/,
  );
});

test("activity adapter persists a replay-valid and fully bound workflow projection", async () => {
  const machine = new GameDeliveryWorkflow({
    workflowId: "delivery-11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    targetMatrix: ["linux", "macos"],
  });
  const projected = machine.current() as DeliverySnapshot;
  const key = deliveryProjectionKey(projected);
  let calls = 0;
  const activities = createDeliveryActivities({
    async dispatch() { throw new Error("must not dispatch"); },
  }, {
    async persist(request) {
      calls += 1;
      assert.equal(request.projectionKey, key);
      return {
        receiptId: "projection-receipt-1",
        acceptedAt: "2026-07-18T00:00:00.000Z",
        projectionKey: key,
        workflowId: projected.workflowId,
        sequence: 0,
        state: "IDEATION",
        snapshotDigest: "a".repeat(64),
        replayed: false,
      };
    },
  });
  const receipt = await activities.persistDeliverySnapshot({
    schemaVersion: DELIVERY_PROJECTION_SCHEMA_VERSION,
    projectionKey: key,
    snapshot: projected,
  });
  assert.equal(calls, 1);
  assert.equal(receipt.state, "IDEATION");
});

test("dispatcher endpoint configuration is complete and service-specific", () => {
  const endpoints = deliveryDispatchEndpointsFromEnv({
    DEVILUDO_CONTROL_PLANE_DISPATCH_URL: "https://control.internal/v1/commands",
    DEVILUDO_AGENT_WORKER_DISPATCH_URL: "https://agent.internal/v1/commands",
    DEVILUDO_RUNNER_CONTROL_DISPATCH_URL: "https://runner.internal/v1/commands",
    DEVILUDO_SCM_PROXY_DISPATCH_URL: "https://scm.internal/v1/commands",
    DEVILUDO_STEAM_PUBLISHER_DISPATCH_URL: "https://steam.internal/v1/commands",
  });
  assert.equal(endpoints["agent-worker"], "https://agent.internal/v1/commands");
  assert.throws(
    () => deliveryDispatchEndpointsFromEnv({}),
    /DEVILUDO_CONTROL_PLANE_DISPATCH_URL is required/,
  );
});

test("mTLS dispatcher presents workload material and preserves immutable headers", async () => {
  const request = agentDispatch();
  const endpoints = deliveryDispatchEndpointsFromEnv({
    DEVILUDO_CONTROL_PLANE_DISPATCH_URL: "https://control.internal/v1/workflow-commands",
    DEVILUDO_AGENT_WORKER_DISPATCH_URL: "https://agent.internal/v1/workflow-commands",
    DEVILUDO_RUNNER_CONTROL_DISPATCH_URL: "https://runner.internal/v1/workflow-commands",
    DEVILUDO_SCM_PROXY_DISPATCH_URL: "https://scm.internal/v1/workflow-commands",
    DEVILUDO_STEAM_PUBLISHER_DISPATCH_URL: "https://steam.internal/v1/workflow-commands",
  });
  const pem = Buffer.from("-----BEGIN TEST-----\n" + "a".repeat(64) + "\n-----END TEST-----");
  const dispatcher = new MtlsCommandDispatcher(
    endpoints,
    { key: pem, certificate: pem, ca: pem },
    12_000,
    async (url, input) => {
      assert.equal(url.toString(), endpoints["agent-worker"]);
      assert.equal(input.timeoutMs, 12_000);
      assert.equal(input.tls.certificate, pem);
      assert.equal(input.headers["idempotency-key"], request.payload.idempotencyKey);
      assert.equal(input.headers["x-deviludo-destination"], "agent-worker");
      assert.deepEqual(JSON.parse(input.body), request);
      return { statusCode: 202, payload: receiptFor(request) };
    },
  );
  assert.deepEqual(await dispatcher.dispatch(request), receiptFor(request));
  assert.throws(() => new MtlsCommandDispatcher(
    { ...endpoints, "agent-worker": "http://agent.internal/v1/workflow-commands" },
    { key: pem, certificate: pem, ca: pem },
  ), /credential-free HTTPS/);
});

test("production Temporal connections require complete mTLS material", async () => {
  await assert.rejects(
    temporalTlsConfigFromEnv({ NODE_ENV: "production" }),
    /mTLS material is required/,
  );
  await assert.rejects(
    temporalTlsConfigFromEnv({
      NODE_ENV: "production",
      DEVILUDO_ALLOW_INSECURE_LOCAL_TEMPORAL: "1",
    }),
    /cannot disable TLS/,
  );
  await assert.rejects(
    temporalTlsConfigFromEnv({ DEVILUDO_TEMPORAL_TLS_CA_FILE: "/tmp/ca.crt" }),
    /material is incomplete/,
  );
  assert.equal(await temporalTlsConfigFromEnv({ DEVILUDO_ALLOW_INSECURE_LOCAL_TEMPORAL: "1" }), undefined);
});

test("command receiver queues once and replays a fully bound receipt", async () => {
  const queued: DeliveryDispatchRequest[] = [];
  const receiver = new WorkflowCommandReceiver(
    "agent-worker",
    new InMemoryWorkflowCommandInbox(() => new Date("2026-07-17T00:00:00.000Z")),
    { async enqueue(request) { queued.push(request); } },
    () => new Date("2026-07-17T00:00:00.000Z"),
  );
  const request = agentDispatch();
  const first = await receiver.receive(request, headersFor(request));
  const replay = await receiver.receive(structuredClone(request), headersFor(request));
  assert.equal(queued.length, 1);
  assert.deepEqual(replay, first);
  assert.equal(first.destination, "agent-worker");
  assert.equal(first.operation, "START_LOCKED_AGENT_RUN");
});

function claimedJob(attempt = 1): ClaimedWorkflowJob {
  const request = agentDispatch();
  return Object.freeze({
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: request.payload.tenantId,
    projectId: request.payload.projectId,
    workflowId: request.payload.workflowId,
    destination: request.destination,
    operation: request.payload.command,
    requestDigest: "a".repeat(64),
    request,
    attempt,
    claimToken: "22222222-2222-4222-8222-222222222222",
    claimExpiresAt: "2026-07-17T00:05:00.000Z",
  });
}

test("job processor heartbeats, signals with a stable job ID and completes the exact claim", async () => {
  const events: string[] = [];
  const job = claimedJob();
  const queue: WorkflowJobQueuePort = {
    async claimNext(input) {
      assert.equal(input.destination, "agent-worker");
      events.push("claim");
      return job;
    },
    async renew(input) {
      assert.equal(input.claimToken, job.claimToken);
      events.push("heartbeat");
      return "2026-07-17T00:10:00.000Z";
    },
    async complete(input) {
      assert.equal(input.jobId, job.id);
      assert.equal(input.result.signalId, `job:${job.id}:final`);
      events.push("complete");
    },
    async fail() { throw new Error("must not fail"); },
  };
  const processor = new WorkflowJobProcessor({
    queue,
    destination: "agent-worker",
    workerId: "agent-worker-01",
    handler: {
      async execute(_job, context) {
        await context.heartbeat();
        await context.emitSignal("started", { type: "AGENT_STARTED", runId: "run-1" });
        events.push("execute");
        return { result: { runId: "run-1" }, signal: { type: "AGENT_COMPLETED", candidateCommitSha: "c".repeat(40), draftPullRequest: 91 } };
      },
    },
    signals: {
      async signal(workflowId, signal) {
        assert.equal(workflowId, job.workflowId);
        if (signal.signalId.endsWith(":started")) {
          assert.deepEqual(signal, { signalId: `job:${job.id}:started`, type: "AGENT_STARTED", runId: "run-1" });
          events.push("signal-started");
        } else {
          assert.deepEqual(signal, { signalId: `job:${job.id}:final`, type: "AGENT_COMPLETED", candidateCommitSha: "c".repeat(40), draftPullRequest: 91 });
          events.push("signal-final");
        }
      },
    },
  });
  assert.deepEqual(await processor.processOne(job.tenantId), { kind: "COMPLETED", jobId: job.id, signalId: `job:${job.id}:final` });
  assert.deepEqual(events, ["claim", "heartbeat", "signal-started", "execute", "signal-final", "complete"]);
});

test("job processor records bounded retries and makes the final attempt terminal without leaking errors", async () => {
  const failures: Parameters<WorkflowJobQueuePort["fail"]>[0][] = [];
  const job = claimedJob(2);
  const queue: WorkflowJobQueuePort = {
    async claimNext() { return job; },
    async renew() { throw new Error("must not renew"); },
    async complete() { throw new Error("must not complete"); },
    async fail(input) { failures.push(input); },
  };
  const processor = new WorkflowJobProcessor({
    queue,
    destination: "agent-worker",
    workerId: "agent-worker-01",
    maxAttempts: 2,
    now: () => new Date("2026-07-17T00:00:00.000Z"),
    handler: { async execute() { throw new WorkflowJobError("PROVIDER_UNAVAILABLE"); } },
    signals: { async signal() { throw new Error("must not signal"); } },
  });
  assert.deepEqual(await processor.processOne(job.tenantId), {
    kind: "FAILED",
    jobId: job.id,
    terminal: true,
    errorCode: "PROVIDER_UNAVAILABLE",
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.terminal, true);
  assert.equal(failures[0]?.retryAt, undefined);
});

test("worker host drains assigned tenants, deduplicates IDs and stops from its idle wait", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const processed: string[] = [];
  const delays: number[] = [];
  const controller = new AbortController();
  let calls = 0;
  const host = new WorkflowJobWorkerHost({
    destination: "agent-worker",
    tenants: {
      async listTenantIds(destination) {
        assert.equal(destination, "agent-worker");
        return [tenantId.toUpperCase(), tenantId];
      },
    },
    processor: {
      async processOne(assignedTenantId) {
        processed.push(assignedTenantId);
        calls += 1;
        return calls === 1
          ? { kind: "COMPLETED", jobId: "33333333-3333-4333-8333-333333333333", signalId: null }
          : { kind: "IDLE" };
      },
    },
    pause: async (delayMs) => {
      delays.push(delayMs);
      controller.abort();
    },
  });
  await host.run(controller.signal);
  assert.deepEqual(processed, [tenantId, tenantId]);
  assert.deepEqual(delays, [1_000]);
});

test("worker host backs off and recovers from assignment and processor infrastructure errors", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const diagnostics: string[] = [];
  const delays: number[] = [];
  const controller = new AbortController();
  let assignmentCalls = 0;
  let processorCalls = 0;
  const host = new WorkflowJobWorkerHost({
    destination: "runner-control",
    tenants: {
      async listTenantIds() {
        assignmentCalls += 1;
        if (assignmentCalls === 1) throw new Error("secret database detail");
        return [tenantId];
      },
    },
    processor: {
      async processOne() {
        processorCalls += 1;
        if (processorCalls === 1) throw new Error("secret connector detail");
        return { kind: "IDLE" };
      },
    },
    onDiagnostic: (diagnostic) => diagnostics.push(`${diagnostic.destination}:${diagnostic.code}`),
    pause: async (delayMs) => {
      delays.push(delayMs);
      if (delays.length === 3) controller.abort();
    },
  });
  await host.run(controller.signal);
  assert.deepEqual(delays, [5_000, 5_000, 1_000]);
  assert.deepEqual(diagnostics, [
    "runner-control:TENANT_ASSIGNMENT_FAILED",
    "runner-control:JOB_PROCESSOR_FAILED",
  ]);
  assert.equal(processorCalls, 2);
  assert.equal(diagnostics.join(" ").includes("secret"), false);
});

test("worker host rejects invalid tenant assignments and concurrent runs", async () => {
  const pauses: (() => void)[] = [];
  const controller = new AbortController();
  const host = new WorkflowJobWorkerHost({
    destination: "scm-proxy",
    tenants: { async listTenantIds() { return ["not-a-tenant"]; } },
    processor: { async processOne() { return { kind: "IDLE" }; } },
    pause: (_delayMs, signal) => new Promise((resolve) => {
      pauses.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  });
  const running = host.run(controller.signal);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await assert.rejects(host.run(controller.signal), /already running/);
  controller.abort();
  for (const resolve of pauses) resolve();
  await running;
});

test("signed tenant assignments bind workload, destination, expiry and exact tenant set", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const claims: WorkflowTenantAssignmentClaims = {
    kind: "deviludo-workflow-tenant-assignments",
    version: 1,
    workloadId: "agent-worker-pool-01",
    destination: "agent-worker",
    revision: 7,
    tenantIds: [tenantId],
    issuedAt: "2026-07-18T00:00:00.000Z",
    expiresAt: "2026-07-18T00:10:00.000Z",
  };
  let envelope: unknown = signWorkflowTenantAssignments("assignments-key-01", privateKey, claims);
  const source = new SignedWorkflowTenantAssignmentSource(
    { async load() { return envelope; } },
    new Map([["assignments-key-01", publicKey]]),
    claims.workloadId,
    () => new Date("2026-07-18T00:05:00.000Z"),
  );
  assert.deepEqual(await source.listTenantIds("agent-worker"), [tenantId]);
  await assert.rejects(source.listTenantIds("runner-control"), /manifest is invalid/);

  envelope = { ...envelope as object, claims: { ...claims, tenantIds: [] } };
  await assert.rejects(source.listTenantIds("agent-worker"), /signature is invalid/);

  const expired = new SignedWorkflowTenantAssignmentSource(
    { async load() { return signWorkflowTenantAssignments("assignments-key-01", privateKey, claims); } },
    new Map([["assignments-key-01", publicKey]]),
    claims.workloadId,
    () => new Date("2026-07-18T00:10:00.000Z"),
  );
  await assert.rejects(expired.listTenantIds("agent-worker"), /manifest is invalid/);
});

test("destination runtime becomes ready only after probes and durably accepts commands", async () => {
  const request = agentDispatch();
  const queued: DeliveryDispatchRequest[] = [];
  let auxiliaryCalls = 0;
  const queue = {
    async enqueue(value: DeliveryDispatchRequest) { queued.push(value); },
    async claimNext() { return null; },
    async renew() { throw new Error("must not renew"); },
    async complete() { throw new Error("must not complete"); },
    async fail() { throw new Error("must not fail"); },
  };
  const server = Fastify({ logger: false });
  const runtime = createWorkflowDestinationRuntime({
    server,
    destination: "agent-worker",
    workerId: "agent-worker-pool-01",
    inbox: new InMemoryWorkflowCommandInbox(() => new Date("2026-07-18T00:00:00.000Z")),
    queue,
    handler: { async execute() { throw new Error("must not execute"); } },
    signals: { async signal() { throw new Error("must not signal"); } },
    tenants: { async listTenantIds() { return ["11111111-1111-4111-8111-111111111111"]; } },
    auxiliaryProcessors: [{
      async processOne() {
        auxiliaryCalls += 1;
        return { kind: "IDLE" };
      },
    }],
    authorize() {},
    probes: [async () => undefined],
  });
  await runtime.start(async () => { await server.ready(); });
  assert.equal(runtime.state, "READY");
  const health = await server.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), {
    service: "deviludo-workflow-destination",
    destination: "agent-worker",
    state: "READY",
    ready: true,
  });
  const accepted = await server.inject({
    method: "POST",
    url: "/v1/workflow-commands",
    headers: {
      "idempotency-key": request.payload.idempotencyKey,
      "x-deviludo-workflow-id": request.payload.workflowId,
      "x-deviludo-destination": request.destination,
      "x-deviludo-operation": request.payload.command,
    },
    payload: request,
  });
  assert.equal(accepted.statusCode, 202);
  assert.equal(queued.length, 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(auxiliaryCalls > 0);
  await runtime.stop();
  assert.equal(runtime.state, "STOPPED");
});

test("destination runtime fails closed when a readiness dependency is unavailable", async () => {
  const server = Fastify({ logger: false });
  const runtime = createWorkflowDestinationRuntime({
    server,
    destination: "runner-control",
    workerId: "runner-control-pool-01",
    inbox: new InMemoryWorkflowCommandInbox(),
    queue: {
      async enqueue() {}, async claimNext() { return null; }, async renew() { return ""; },
      async complete() {}, async fail() {},
    },
    handler: { async execute() { return { result: {} }; } },
    signals: { async signal() {} },
    tenants: { async listTenantIds() { return []; } },
    authorize() {},
    probes: [async () => { throw new Error("database unavailable"); }],
  });
  await assert.rejects(runtime.start(async () => { await server.ready(); }), /database unavailable/);
  assert.equal(runtime.state, "FAILED");
  await runtime.stop();
});

test("production workflow PostgreSQL configuration cannot opt out of TLS", () => {
  assert.throws(() => postgresWorkflowPoolFromEnv({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://deviludo:secret@postgres.internal/deviludo",
    DEVILUDO_ALLOW_INSECURE_LOCAL_POSTGRES: "1",
  }), /cannot disable TLS/);
});

test("command receiver rejects confused-deputy, transport and state drift", async () => {
  let queued = 0;
  const inbox = new InMemoryWorkflowCommandInbox(() => new Date("2026-07-17T00:00:00.000Z"));
  const handler = { async enqueue() { queued += 1; } };
  const agentReceiver = new WorkflowCommandReceiver("agent-worker", inbox, handler);
  const request = agentDispatch();
  await assert.rejects(
    agentReceiver.receive(request, { ...headersFor(request), destination: "steam-publisher" }),
    /transport binding mismatch/,
  );
  const steamReceiver = new WorkflowCommandReceiver("steam-publisher", inbox, handler);
  await assert.rejects(
    steamReceiver.receive(request, headersFor(request)),
    /destination is invalid/,
  );
  const missingLock = agentDispatch({ ...snapshot, lockedRunConfigurationId: null });
  await assert.rejects(
    agentReceiver.receive(missingLock, headersFor(missingLock)),
    /missing its required snapshot binding/,
  );
  assert.equal(queued, 0);
});

test("command receiver releases a failed claim but forbids idempotency digest reuse", async () => {
  let attempts = 0;
  const receiver = new WorkflowCommandReceiver(
    "agent-worker",
    new InMemoryWorkflowCommandInbox(() => new Date("2026-07-17T00:00:00.000Z")),
    {
      async enqueue() {
        attempts += 1;
        if (attempts === 1) throw new Error("queue unavailable");
      },
    },
    () => new Date("2026-07-17T00:00:00.000Z"),
  );
  const request = agentDispatch();
  await assert.rejects(receiver.receive(request, headersFor(request)), /queue unavailable/);
  await receiver.receive(request, headersFor(request));
  assert.equal(attempts, 2);

  const drifted = agentDispatch({ ...snapshot, repairAttempts: 1 });
  await assert.rejects(
    receiver.receive(drifted, headersFor(drifted)),
    /idempotency key was reused with another request/,
  );
});

test("Postgres inbox sets tenant RLS before claiming and commits a receipt", async () => {
  const statements: { text: string; values?: readonly unknown[] }[] = [];
  let released = false;
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PostgresQueryResult<Row>> {
      statements.push({ text, values });
      if (text.includes("SELECT request_digest")) {
        return {
          rowCount: 1,
          rows: [{
            request_digest: "a".repeat(64),
            claim_token: "11111111-1111-4111-8111-111111111111",
            claim_active: true,
            receipt: null,
          }],
        } as unknown as PostgresQueryResult<Row>;
      }
      if (text.includes("RETURNING idempotency_key")) {
        return { rowCount: 1, rows: [{ idempotency_key: "delivery-001:0:DEVELOPMENT_QUEUED:START_LOCKED_AGENT_RUN" }] } as unknown as PostgresQueryResult<Row>;
      }
      return { rowCount: 0, rows: [] } as PostgresQueryResult<Row>;
    },
    release() { released = true; },
  };
  const store = new PostgresWorkflowCommandInbox({ async connect() { return client; } });
  const claim = {
    idempotencyKey: "delivery-001:0:DEVELOPMENT_QUEUED:START_LOCKED_AGENT_RUN",
    requestDigest: "a".repeat(64),
    tenantId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    workflowId: "delivery-001",
    destination: "agent-worker",
    operation: "START_LOCKED_AGENT_RUN",
    claimToken: "11111111-1111-4111-8111-111111111111",
    claimExpiresAt: "2026-07-17T00:05:00.000Z",
  } as const;
  assert.deepEqual(await store.acquire(claim), { kind: "ACQUIRED" });
  assert.equal(statements[0]?.text, "BEGIN");
  assert.match(statements[1]?.text ?? "", /set_config/);
  assert.deepEqual(statements[1]?.values, [claim.tenantId]);
  assert.match(statements[2]?.text ?? "", /ON CONFLICT \(tenant_id, idempotency_key\)/);
  assert.match(statements[3]?.text ?? "", /WHERE tenant_id = \$2::uuid/);
  assert.deepEqual(statements[3]?.values, [claim.idempotencyKey, claim.tenantId]);
  assert.equal(statements.at(-1)?.text, "COMMIT");
  assert.equal(released, true);

  await store.complete({
    idempotencyKey: claim.idempotencyKey,
    requestDigest: claim.requestDigest,
    tenantId: claim.tenantId,
    claimToken: claim.claimToken,
    receipt: {
      receiptId: "33333333-3333-4333-8333-333333333333",
      acceptedAt: "2026-07-17T00:00:00.000Z",
      destination: "agent-worker",
      workflowId: claim.workflowId,
      idempotencyKey: claim.idempotencyKey,
      operation: "START_LOCKED_AGENT_RUN",
    },
  });
  assert.match(statements.at(-2)?.text ?? "", /receipt_id/);
  assert.match(statements.at(-2)?.text ?? "", /WHERE tenant_id = \$2::uuid/);
  assert.equal(statements.at(-1)?.text, "COMMIT");
});

test("HTTP receiver requires workload authorization and preserves transport bindings", async () => {
  const request = agentDispatch();
  let authorized = false;
  const server = Fastify({ logger: false });
  registerWorkflowCommandRoute(server, {
    destination: "agent-worker",
    receiver: new WorkflowCommandReceiver(
      "agent-worker",
      new InMemoryWorkflowCommandInbox(),
      { async enqueue() {} },
      () => new Date("2026-07-17T00:00:00.000Z"),
    ),
    authorize() {
      if (!authorized) throw new Error("unauthorized");
    },
  });
  const httpHeaders = {
    "idempotency-key": request.payload.idempotencyKey,
    "x-deviludo-workflow-id": request.payload.workflowId,
    "x-deviludo-destination": request.destination,
    "x-deviludo-operation": request.payload.command,
  };
  const unauthorized = await server.inject({
    method: "POST",
    url: "/v1/workflow-commands",
    headers: httpHeaders,
    payload: request,
  });
  assert.equal(unauthorized.statusCode, 401);
  authorized = true;
  const accepted = await server.inject({
    method: "POST",
    url: "/v1/workflow-commands",
    headers: httpHeaders,
    payload: request,
  });
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json().workflowId, request.payload.workflowId);
  assert.equal(accepted.headers["cache-control"], "no-store");
  await server.close();
});

test("workflow SPIFFE parser accepts exactly one well-formed identity", () => {
  assert.equal(
    parseWorkflowSpiffeId("DNS:temporal-worker.internal, URI:spiffe://deviludo.internal/control/temporal-worker"),
    "spiffe://deviludo.internal/control/temporal-worker",
  );
  assert.throws(
    () => parseWorkflowSpiffeId("URI:spiffe://one/worker, URI:spiffe://two/worker"),
    /exactly one/,
  );
});

test("Postgres job queue enqueues idempotently and claims an exact destination job", async () => {
  const request = agentDispatch();
  const requestDigest = deliveryDispatchRequestDigest(request);
  const statements: { text: string; values?: readonly unknown[] }[] = [];
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PostgresQueryResult<Row>> {
      statements.push({ text, values });
      if (text.includes("SELECT request_digest") && text.includes("workflow_command_jobs")) {
        return { rowCount: 1, rows: [{ request_digest: requestDigest }] } as unknown as PostgresQueryResult<Row>;
      }
      if (text.includes("WITH candidate AS")) {
        return {
          rowCount: 1,
          rows: [{
            id: "33333333-3333-4333-8333-333333333333",
            tenant_id: request.payload.tenantId,
            project_id: request.payload.projectId,
            workflow_id: request.payload.workflowId,
            destination: request.destination,
            operation: request.payload.command,
            request_digest: requestDigest,
            request_body: request,
            state: "RUNNING",
            attempt: 1,
            claim_token: values?.[3],
            claim_expires_at: "2026-07-17T00:05:00.000Z",
          }],
        } as unknown as PostgresQueryResult<Row>;
      }
      if (text.includes("RETURNING claim_expires_at")) {
        return { rowCount: 1, rows: [{ claim_expires_at: "2026-07-17T00:10:00.000Z" }] } as unknown as PostgresQueryResult<Row>;
      }
      if (text.includes("RETURNING id")) {
        return { rowCount: 1, rows: [{ id: "33333333-3333-4333-8333-333333333333" }] } as unknown as PostgresQueryResult<Row>;
      }
      return { rowCount: 0, rows: [] } as PostgresQueryResult<Row>;
    },
    release() {},
  };
  const queue = new PostgresWorkflowCommandQueue(
    { async connect() { return client; } },
    () => new Date("2026-07-17T00:00:00.000Z"),
  );
  await queue.enqueue(request);
  const claimed = await queue.claimNext({
    tenantId: request.payload.tenantId,
    destination: "agent-worker",
    workerId: "agent-worker-001",
  });
  assert.ok(claimed);
  assert.equal(claimed.requestDigest, requestDigest);
  assert.equal(claimed.request.payload.idempotencyKey, request.payload.idempotencyKey);
  assert.equal(await queue.renew({
    tenantId: request.payload.tenantId,
    jobId: claimed.id,
    claimToken: claimed.claimToken,
  }), "2026-07-17T00:10:00.000Z");
  await queue.complete({
    tenantId: request.payload.tenantId,
    jobId: claimed.id,
    claimToken: claimed.claimToken,
    result: { runId: "run-001", signalId: "signal-run-started-001" },
  });
  const begins = statements.filter((entry) => entry.text === "BEGIN").length;
  const tenantBindings = statements.filter((entry) => entry.text.includes("set_config")).length;
  assert.equal(begins, 4);
  assert.equal(tenantBindings, begins);
});

test("Temporal can bundle the deterministic workflow and signal-backed waits", async () => {
  const workflowsPath = fileURLToPath(
    new URL("../src/workflows/game-delivery.workflow.ts", import.meta.url),
  );
  const bundle = await bundleWorkflowCode({ workflowsPath, webpackConfigHook: temporalWebpackConfigHook });
  assert.ok(bundle.code.length > 10_000);
  assert.match(bundle.code, /gameDeliveryWorkflow/);
});
