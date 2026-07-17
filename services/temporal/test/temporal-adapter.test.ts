import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { bundleWorkflowCode } from "@temporalio/worker";
import { createDeliveryActivities, type DeliveryDispatchRequest } from "../src/activities";
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
  mainCommitSha: null,
  evidenceBundleId: null,
  targetMatrix: ["linux", "macos", "windows"],
  iteration: 1,
  repairAttempts: 0,
  waitingProviderRevisionId: null,
  externalGate: null,
  history: [],
};

test("activity adapter preserves immutable bindings and deterministic idempotency", async () => {
  const seen: DeliveryDispatchRequest[] = [];
  const activities = createDeliveryActivities({
    async dispatch(request) {
      seen.push(request);
      return { receiptId: "receipt-001", acceptedAt: "2026-07-17T00:00:00.000Z" };
    },
  });
  const idempotencyKey = dispatchKey(snapshot, "START_LOCKED_AGENT_RUN");
  const receipt = await activities.dispatchDeliveryCommand({
    idempotencyKey,
    workflowId: snapshot.workflowId,
    tenantId: snapshot.tenantId,
    projectId: snapshot.projectId,
    command: "START_LOCKED_AGENT_RUN",
    snapshot,
  });
  assert.equal(receipt.receiptId, "receipt-001");
  assert.equal(seen.length, 1);
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
      command: "START_LOCKED_AGENT_RUN",
      snapshot,
    }),
    /binding mismatch/,
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
