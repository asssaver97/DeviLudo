import assert from "node:assert/strict";
import test from "node:test";
import type { DeliverySnapshot } from "../../temporal/src/contracts";
import type { WorkflowJobExecutionContext } from "../../temporal/src/job-processor";
import type { ClaimedWorkflowJob } from "../../temporal/src/postgres-queue";
import {
  AgentProviderUnavailableError,
  AgentWorkerWorkflowHandler,
} from "../src/workflow-handler";

const snapshot: DeliverySnapshot = Object.freeze({
  workflowId: "delivery-001", tenantId: "tenant-001", projectId: "project-001",
  state: "DEVELOPMENT_QUEUED", specRevisionId: "spec-r1", lockedRunConfigurationId: "lock-r1",
  runId: null, candidateCommitSha: null, draftPullRequest: null, mainCommitSha: null,
  evidenceBundleId: null, candidateEvidenceBundleId: null, mainEvidenceBundleId: null,
  steamInstallEvidenceBundleId: null, mfaApprovalId: null, steamBuildId: null,
  steamReleaseId: null, defaultBranchBuildId: null, targetMatrix: Object.freeze(["linux"] as const),
  iteration: 1, repairAttempts: 0, waitingProviderRevisionId: null, externalGate: null,
  externalApprovals: Object.freeze([]), history: Object.freeze([]),
});

function job(): ClaimedWorkflowJob {
  const request = { kind: "COMMAND", destination: "agent-worker", payload: {
    idempotencyKey: "delivery-001:0:DEVELOPMENT_QUEUED:START_LOCKED_AGENT_RUN",
    workflowId: snapshot.workflowId, tenantId: snapshot.tenantId, projectId: snapshot.projectId,
    destination: "agent-worker", command: "START_LOCKED_AGENT_RUN", snapshot,
  } } as const;
  return Object.freeze({
    id: "11111111-1111-4111-8111-111111111111", tenantId: snapshot.tenantId,
    projectId: snapshot.projectId, workflowId: snapshot.workflowId, destination: "agent-worker",
    operation: "START_LOCKED_AGENT_RUN", requestDigest: "a".repeat(64), request, attempt: 1,
    claimToken: "22222222-2222-4222-8222-222222222222", claimExpiresAt: "2099-01-01T00:10:00.000Z",
  });
}

function context(signals: { phase: string; value: unknown }[]): WorkflowJobExecutionContext {
  return {
    async heartbeat() { return "2099-01-01T00:10:00.000Z"; },
    async emitSignal(phase, value) { signals.push({ phase, value }); return `job:1:${phase}`; },
  };
}

test("Agent workflow handler starts one locked CLI run and emits its authoritative Draft PR", async () => {
  const signals: { phase: string; value: unknown }[] = [];
  const handler = new AgentWorkerWorkflowHandler({
    async start(input) {
      assert.equal(input.lockedRunConfigurationId, snapshot.lockedRunConfigurationId);
      assert.equal(input.operationKey, "workflow-job:11111111-1111-4111-8111-111111111111");
      return {
        runId: "run-001", providerRevisionId: "provider-r1", recoveredFromOutage: false,
        completion: Promise.resolve({
          status: "COMPLETED", runId: "run-001", lockedRunConfigurationId: "lock-r1",
          agent: "claude-code", profileRevisionId: "profile-r1", installationId: "installation-r1",
          imageDigest: `sha256:${"b".repeat(64)}`, providerRevisionId: "provider-r1",
          model: "claude-sonnet-4-6-20250514", candidateCommitSha: "c".repeat(40),
          draftPullRequest: 91, diagnosticId: null, receiptId: "agent-receipt-001",
        }),
      };
    },
  });
  const outcome = await handler.execute(job(), context(signals));
  assert.deepEqual(signals, [{ phase: "started", value: { type: "AGENT_STARTED", runId: "run-001" } }]);
  assert.deepEqual(outcome.signal, { type: "AGENT_COMPLETED", candidateCommitSha: "c".repeat(40), draftPullRequest: 91 });
  assert.equal(outcome.result.agent, "claude-code");
});

test("Agent workflow handler pauses the same locked run when its Provider is unavailable", async () => {
  const signals: { phase: string; value: unknown }[] = [];
  const handler = new AgentWorkerWorkflowHandler({
    async start() { throw new AgentProviderUnavailableError("provider-r1"); },
  });
  await assert.rejects(handler.execute(job(), context(signals)), /PROVIDER_UNAVAILABLE/);
  assert.deepEqual(signals, [{
    phase: "provider-unavailable",
    value: { type: "PROVIDER_UNAVAILABLE", providerRevisionId: "provider-r1" },
  }]);
});
