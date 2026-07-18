import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubRepositoryBinding } from "../src/github-contracts";
import {
  parseSourceBaselineReceipt,
  parseSourceBaselineRequest,
  sourceBaselineOperationKey,
  type SourceBaselineReceipt,
  type SourceBaselineRequest,
} from "../src/source-baseline-contracts";
import type { SourceBaselineClaim } from "../src/source-baseline-postgres";
import {
  SourceBaselineBusyError,
  SourceBaselineService,
  type SourceBaselineStore,
} from "../src/source-baseline-service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const specRevisionId = "33333333-3333-4333-8333-333333333333";
const testPlanRevisionId = "44444444-4444-4444-8444-444444444444";
const actionId = "55555555-5555-4555-8555-555555555555";
const sourceBaselineReceiptId = "66666666-6666-4666-8666-666666666666";
const repositoryBindingId = "77777777-7777-4777-8777-777777777777";
const commitSha = "a".repeat(40);
const sourceDigest = "b".repeat(64);
const specApprovalReceiptId = "c".repeat(64);

const binding: GitHubRepositoryBinding = Object.freeze({
  tenantId,
  projectId,
  installationId: "123456",
  repositoryId: 991,
  repositoryNodeId: "R_repo991",
  owner: "north-dock-studio",
  name: "ember-archipelago",
  defaultBranch: "main",
});

test("source baseline contracts bind the approval to the deterministic project workflow", () => {
  const parsed = parseSourceBaselineRequest(request());
  assert.equal(parsed.operationKey, sourceBaselineOperationKey(actionId));
  assert.throws(() => parseSourceBaselineRequest({
    ...request(),
    workflowId: "delivery-99999999-9999-4999-8999-999999999999",
  }), /binding/);
  assert.throws(() => parseSourceBaselineReceipt({
    ...receipt(false),
    defaultBranch: "refs//heads/main",
  }), /binding/);
  assert.throws(() => parseSourceBaselineReceipt({
    ...receipt(false),
    workflowId: "delivery-99999999-9999-4999-8999-999999999999",
  }), /binding/);
});

test("source baseline service persists one exact read-only GitHub observation", async () => {
  const fixture = serviceFixture();
  const result = await fixture.service.resolve(request());
  assert.deepEqual(result, receipt(false));
  assert.deepEqual(fixture.githubCalls, ["repository", "reference:main", `digest:${commitSha}`]);
  assert.equal(fixture.completed, 1);
  assert.equal(fixture.released, 0);
  await fixture.service.probe();
  assert.equal(fixture.probed, 1);
});

test("source baseline service returns an immutable replay without touching GitHub", async () => {
  const fixture = serviceFixture({ replay: true });
  assert.deepEqual(await fixture.service.resolve(request()), receipt(true));
  assert.deepEqual(fixture.githubCalls, []);
  assert.equal(fixture.completed, 0);
});

test("source baseline service releases its claim after any GitHub authority failure", async () => {
  const fixture = serviceFixture({ archived: true });
  await assert.rejects(fixture.service.resolve(request()), /receipt is invalid/);
  assert.equal(fixture.released, 1);

  const busy = serviceFixture({ busy: true });
  await assert.rejects(busy.service.resolve(request()), SourceBaselineBusyError);
  assert.deepEqual(busy.githubCalls, []);
});

function request(): SourceBaselineRequest {
  return Object.freeze({
    schemaVersion: "deviludo.source-baseline.v1",
    operationKey: sourceBaselineOperationKey(actionId),
    tenantId,
    projectId,
    workflowId: `delivery-${projectId}`,
    specRevisionId,
    testPlanRevisionId,
    specApprovalReceiptId,
  });
}

function receipt(replayed: boolean): SourceBaselineReceipt {
  const approval = request();
  return Object.freeze({
    schemaVersion: "deviludo.source-baseline-receipt.v1",
    operationKey: approval.operationKey,
    tenantId: approval.tenantId,
    projectId: approval.projectId,
    workflowId: approval.workflowId,
    specRevisionId: approval.specRevisionId,
    testPlanRevisionId: approval.testPlanRevisionId,
    specApprovalReceiptId: approval.specApprovalReceiptId,
    sourceBaselineReceiptId,
    repositoryBindingId,
    defaultBranch: "main",
    commitSha,
    sourceDigest,
    observedAt: "2030-01-01T00:00:00.000Z",
    replayed,
  });
}

function serviceFixture(options: {
  readonly replay?: boolean;
  readonly busy?: boolean;
  readonly archived?: boolean;
} = {}) {
  const claim: SourceBaselineClaim = Object.freeze({
    request: request(),
    claimToken: "88888888-8888-4888-8888-888888888888",
    repositoryBindingId,
    binding,
  });
  let completed = 0;
  let released = 0;
  let probed = 0;
  const store: SourceBaselineStore = {
    async acquire() {
      if (options.replay) return { kind: "REPLAY", receipt: receipt(true) };
      if (options.busy) return { kind: "BUSY" };
      return { kind: "ACQUIRED", claim };
    },
    async complete(selectedClaim, observed) {
      assert.equal(selectedClaim, claim);
      assert.deepEqual(observed, {
        defaultBranch: "main",
        commitSha,
        sourceDigest,
        observedAt: "2030-01-01T00:00:00.000Z",
      });
      completed += 1;
      return receipt(false);
    },
    async release(selectedClaim) { assert.equal(selectedClaim, claim); released += 1; },
    async probe() { probed += 1; },
  };
  const githubCalls: string[] = [];
  return {
    service: new SourceBaselineService(store, {
      async getRepository() {
        githubCalls.push("repository");
        return {
          repositoryId: binding.repositoryId,
          repositoryNodeId: binding.repositoryNodeId,
          owner: binding.owner,
          name: binding.name,
          defaultBranch: binding.defaultBranch,
          archived: options.archived ?? false,
          disabled: false,
        };
      },
      async getReference(_binding, branch) {
        githubCalls.push(`reference:${branch}`);
        return { branch, commitSha };
      },
      async getSourceDigest(_binding, sha) {
        githubCalls.push(`digest:${sha}`);
        return sourceDigest;
      },
    }, () => new Date("2030-01-01T00:00:00.000Z")),
    githubCalls,
    get completed() { return completed; },
    get released() { return released; },
    get probed() { return probed; },
  };
}
