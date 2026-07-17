import assert from "node:assert/strict";
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
  parseWorkflowSpiffeId,
  registerWorkflowCommandRoute,
} from "../src/receiver-http";
import { dispatchKey } from "../src/workflows/game-delivery.workflow";

const snapshot: DeliverySnapshot = {
  workflowId: "delivery-001",
  tenantId: "tenant-001",
  projectId: "project-001",
  state: "DEVELOPMENT_QUEUED",
  specRevisionId: "spec-r1",
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
  });
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
  });
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
  });
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
  });
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
  await queue.complete({
    tenantId: request.payload.tenantId,
    jobId: claimed.id,
    claimToken: claimed.claimToken,
    result: { runId: "run-001", signalId: "signal-run-started-001" },
  });
  const begins = statements.filter((entry) => entry.text === "BEGIN").length;
  const tenantBindings = statements.filter((entry) => entry.text.includes("set_config")).length;
  assert.equal(begins, 3);
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
