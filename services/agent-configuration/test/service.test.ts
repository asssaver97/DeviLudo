import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowActionCompletionPort } from "../../control-plane/src/workflow-action-completion-postgres";
import { sourceBaselineOperationKey } from "../../scm-proxy/src/source-baseline-contracts";
import type {
  AgentConfigurationClaim,
  AgentConfigurationStore,
  LockedAgentConfiguration,
  SourceBaselinePort,
} from "../src/contracts";
import { AgentConfigurationService } from "../src/service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const actionId = "33333333-3333-4333-8333-333333333333";
const claim: AgentConfigurationClaim = Object.freeze({
  kind: "CLAIMED",
  tenantId,
  projectId,
  workflowId: `delivery-${projectId}`,
  actionId,
  specRevisionId: "44444444-4444-4444-8444-444444444444",
  testPlanRevisionId: "55555555-5555-4555-8555-555555555555",
  specApprovalReceiptId: "a".repeat(64),
  repairContext: null,
  claimToken: "66666666-6666-4666-8666-666666666666",
});
const locked: LockedAgentConfiguration = Object.freeze({
  kind: "LOCKED",
  tenantId,
  projectId,
  workflowId: claim.workflowId,
  actionId,
  specRevisionId: claim.specRevisionId,
  testPlanRevisionId: claim.testPlanRevisionId,
  specApprovalReceiptId: claim.specApprovalReceiptId,
  sourceBaselineReceiptId: "77777777-7777-4777-8777-777777777777",
  repairContext: null,
  runId: "88888888-8888-4888-8888-888888888888",
  resolutionDigest: "b".repeat(64),
});

test("Agent configuration service resolves source, locks a run and completes the Temporal wait", async () => {
  const fixture = serviceFixture(claim);
  assert.equal(await fixture.service.processTenantOnce(tenantId), "COMPLETED");
  assert.equal(fixture.baselineRequests.length, 1);
  assert.deepEqual(fixture.baselineRequests[0], {
    schemaVersion: "deviludo.source-baseline.v1",
    operationKey: sourceBaselineOperationKey(actionId),
    tenantId,
    projectId,
    workflowId: claim.workflowId,
    specRevisionId: claim.specRevisionId,
    testPlanRevisionId: claim.testPlanRevisionId,
    specApprovalReceiptId: claim.specApprovalReceiptId,
  });
  assert.equal(fixture.completions.length, 1);
  assert.equal(fixture.completions[0]!.sourceReceiptId, locked.resolutionDigest);
  assert.equal(fixture.completions[0]!.signal.type, "RUN_CONFIGURATION_LOCKED");
  assert.equal(fixture.completed, 1);
  assert.equal(fixture.released, 0);
});

test("Agent configuration service resumes a locked run without re-reading GitHub", async () => {
  const fixture = serviceFixture(locked);
  assert.equal(await fixture.service.processTenantOnce(tenantId), "COMPLETED");
  assert.equal(fixture.baselineRequests.length, 0);
  assert.equal(fixture.completed, 1);
});

test("Agent configuration service derives a repair baseline from immutable predecessor evidence", async () => {
  const repairClaim: AgentConfigurationClaim = Object.freeze({
    ...claim,
    repairContext: Object.freeze({
      attempt: 1,
      reason: "E2E_FAILURE",
      fromRunConfigurationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      diagnosticId: null,
      evidenceBundleId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      repairPromptId: `repair:${"c".repeat(64)}`,
      candidateCommitSha: "d".repeat(40),
      draftPullRequest: 27,
    }),
  });
  const fixture = serviceFixture(repairClaim);
  assert.equal(await fixture.service.processTenantOnce(tenantId), "COMPLETED");
  assert.equal(fixture.baselineRequests.length, 0);
  assert.deepEqual(fixture.lockReceipts, [null]);
});

test("Agent configuration service releases only pre-lock failures", async () => {
  const beforeLock = serviceFixture(claim, { baselineFailure: true });
  await assert.rejects(beforeLock.service.processTenantOnce(tenantId), /baseline unavailable/);
  assert.equal(beforeLock.released, 1);

  const afterLock = serviceFixture(locked, { completionFailure: true });
  await assert.rejects(afterLock.service.processTenantOnce(tenantId), /completion unavailable/);
  assert.equal(afterLock.released, 0);
});

function serviceFixture(work: AgentConfigurationClaim | LockedAgentConfiguration, options: {
  readonly baselineFailure?: boolean;
  readonly completionFailure?: boolean;
} = {}) {
  let pending = true;
  let completed = 0;
  let released = 0;
  const baselineRequests: unknown[] = [];
  const lockReceipts: Array<Parameters<AgentConfigurationStore["lock"]>[1]> = [];
  const completions: Parameters<WorkflowActionCompletionPort["complete"]>[0][] = [];
  const expectedLocked = work.kind === "CLAIMED"
    ? Object.freeze({ ...locked, repairContext: work.repairContext })
    : work;
  const store: AgentConfigurationStore = {
    async claimNext() { if (!pending) return null; pending = false; return work; },
    async lock(selected, receipt) {
      assert.equal(selected, work);
      lockReceipts.push(receipt);
      if (selected.repairContext === null) {
        assert.ok(receipt);
        assert.equal(receipt.sourceBaselineReceiptId, locked.sourceBaselineReceiptId);
      } else assert.equal(receipt, null);
      return expectedLocked;
    },
    async complete(selected, outboxId) {
      assert.equal(selected, expectedLocked);
      assert.equal(outboxId, "99999999-9999-4999-8999-999999999999");
      completed += 1;
    },
    async release(selected) { assert.equal(selected, claim); released += 1; },
    async probe() {},
  };
  const baselines: SourceBaselinePort = {
    async resolve(request) {
      baselineRequests.push(request);
      if (options.baselineFailure) throw new Error("baseline unavailable");
      return {
        schemaVersion: "deviludo.source-baseline-receipt.v1",
        operationKey: request.operationKey,
        tenantId: request.tenantId,
        projectId: request.projectId,
        workflowId: request.workflowId,
        specRevisionId: request.specRevisionId,
        testPlanRevisionId: request.testPlanRevisionId,
        specApprovalReceiptId: request.specApprovalReceiptId,
        sourceBaselineReceiptId: locked.sourceBaselineReceiptId,
        repositoryBindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        defaultBranch: "main",
        commitSha: "c".repeat(40),
        sourceDigest: "d".repeat(64),
        observedAt: "2030-01-01T00:00:00.000Z",
        replayed: false,
      };
    },
    async probe() {},
  };
  const completionPort: WorkflowActionCompletionPort = {
    async complete(input) {
      completions.push(input);
      if (options.completionFailure) throw new Error("completion unavailable");
      return {
        actionId,
        outboxId: "99999999-9999-4999-8999-999999999999",
        workflowId: claim.workflowId,
        signalId: input.signal.signalId,
        signalDigest: "e".repeat(64),
        state: "PENDING_DELIVERY",
        replayed: false,
      };
    },
  };
  return {
    service: new AgentConfigurationService(store, baselines, completionPort),
    baselineRequests,
    lockReceipts,
    completions,
    get completed() { return completed; },
    get released() { return released; },
  };
}
