import assert from "node:assert/strict";
import test from "node:test";
import type { DeliverySnapshot, DeliverySignal } from "../../temporal/src/contracts";
import type { ClaimedWorkflowJob } from "../../temporal/src/postgres-queue";
import { ScmProxyWorkflowHandler, type ScmMergeWorkflowPort, type ScmMergeWorkflowReceipt } from "../src/workflow-handler";

const candidateCommitSha = "c".repeat(40);
const mergeCommitSha = "d".repeat(40);
const acceptance: DeliverySignal = Object.freeze({ signalId: "acceptance-signal-0001", type: "USER_ACCEPTED" });
const snapshot: DeliverySnapshot = Object.freeze({
  workflowId: "delivery-001", tenantId: "tenant-001", projectId: "project-001", state: "MERGING",
  specRevisionId: "spec-r1", lockedRunConfigurationId: "lock-r1", runId: "run-001",
  testPlanRevisionId: "plan-r1", specApprovalReceiptId: "spec-approval-r1",
  candidateCommitSha, draftPullRequest: 91, mainCommitSha: null,
  evidenceBundleId: "candidate-evidence-1", candidateEvidenceBundleId: "candidate-evidence-1",
  mainEvidenceBundleId: null, steamInstallEvidenceBundleId: null, mfaApprovalId: null, steamBuildId: null,
  steamReleaseId: null, defaultBranchBuildId: null,
  targetMatrix: Object.freeze(["linux", "macos", "windows"] as const), iteration: 1, repairAttempts: 0,
  waitingProviderRevisionId: null, externalGate: null, externalApprovals: Object.freeze([]),
  history: Object.freeze([{ sequence: 1, signal: acceptance, resultingState: "MERGING" as const }]),
});

function job(value: DeliverySnapshot = snapshot): ClaimedWorkflowJob {
  const operation = "MERGE_DRAFT_PULL_REQUEST" as const;
  const request = { kind: "COMMAND", destination: "scm-proxy", payload: {
    idempotencyKey: `delivery-001:1:MERGING:${operation}`, workflowId: value.workflowId,
    tenantId: value.tenantId, projectId: value.projectId, destination: "scm-proxy", command: operation, snapshot: value,
  } } as const;
  return Object.freeze({
    id: "11111111-1111-4111-8111-111111111111", tenantId: value.tenantId, projectId: value.projectId,
    workflowId: value.workflowId, destination: "scm-proxy", operation, requestDigest: "b".repeat(64), request,
    attempt: 1, claimToken: "22222222-2222-4222-8222-222222222222", claimExpiresAt: "2099-01-01T00:10:00.000Z",
  });
}

function receipt(overrides: Partial<ScmMergeWorkflowReceipt> = {}): ScmMergeWorkflowReceipt {
  return {
    receiptId: "scm-merge-receipt-1", runId: "run-001", candidateCommitSha, pullRequestNumber: 91,
    evidenceBundleId: "candidate-evidence-1", acceptanceSignalId: acceptance.signalId,
    mergeCommitSha, defaultBranchHeadSha: mergeCommitSha, mainSourceDigest: "a".repeat(64),
    requiresFreshMainSnapshot: false, ...overrides,
  };
}

test("SCM workflow handler merges only the frozen candidate, evidence and acceptance", async () => {
  const observed: Parameters<ScmMergeWorkflowPort["mergeAcceptedCandidate"]>[0][] = [];
  const handler = new ScmProxyWorkflowHandler({ async mergeAcceptedCandidate(input) {
    observed.push(input);
    return receipt();
  } });
  const result = await handler.execute(job(), { async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; } });
  assert.deepEqual(result.signal, { type: "MAIN_MERGED", mainCommitSha: mergeCommitSha });
  assert.equal(observed[0]?.candidateCommitSha, candidateCommitSha);
  assert.equal(observed[0]?.evidenceBundleId, "candidate-evidence-1");
  assert.equal(observed[0]?.acceptanceSignalId, acceptance.signalId);
  assert.equal(observed[0]?.runId, "run-001");
  assert.equal(observed[0]?.operationKey, "workflow-job:11111111-1111-4111-8111-111111111111");
});

test("SCM workflow handler releases the actual default branch head for a fresh full gate", async () => {
  const advancedHead = "f".repeat(40);
  const handler = new ScmProxyWorkflowHandler({ async mergeAcceptedCandidate() {
    return receipt({ defaultBranchHeadSha: advancedHead, requiresFreshMainSnapshot: true });
  } });
  const result = await handler.execute(job(), { async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; } });
  assert.deepEqual(result.signal, { type: "MAIN_MERGED", mainCommitSha: advancedHead });
});

test("SCM workflow handler rejects missing acceptance and cross-boundary receipt drift", async () => {
  const noAcceptance = Object.freeze({ ...snapshot, history: Object.freeze([]) });
  const handler = new ScmProxyWorkflowHandler({ async mergeAcceptedCandidate() { return receipt(); } });
  await assert.rejects(handler.execute(job(noAcceptance), { async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; } }), /acceptance binding/);

  const drifted = new ScmProxyWorkflowHandler({ async mergeAcceptedCandidate() {
    return receipt({ candidateCommitSha: "e".repeat(40) });
  } });
  await assert.rejects(drifted.execute(job(), { async heartbeat() { return "renewed"; }, async emitSignal() { return "unused"; } }), /receipt binding/);
});
