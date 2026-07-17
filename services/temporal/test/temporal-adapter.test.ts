import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { bundleWorkflowCode } from "@temporalio/worker";
import {
  createDeliveryActivities,
  deliveryDispatchEndpointsFromEnv,
  type DeliveryDispatchRequest,
} from "../src/activities";
import { temporalWebpackConfigHook } from "../src/bundler";
import type { DeliverySnapshot } from "../src/contracts";
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

test("Temporal can bundle the deterministic workflow and signal-backed waits", async () => {
  const workflowsPath = fileURLToPath(
    new URL("../src/workflows/game-delivery.workflow.ts", import.meta.url),
  );
  const bundle = await bundleWorkflowCode({ workflowsPath, webpackConfigHook: temporalWebpackConfigHook });
  assert.ok(bundle.code.length > 10_000);
  assert.match(bundle.code, /gameDeliveryWorkflow/);
});
