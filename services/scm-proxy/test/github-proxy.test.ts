import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  contentSha256,
  signCandidateAcceptance,
  signGitHubCandidateArtifact,
} from "../src/github-artifacts";
import type {
  GitHubCandidateArtifactCore,
  GitHubCandidateReceipt,
  GitHubPullRequestSnapshot,
  GitHubRepositoryBinding,
  GitHubScmConnector,
  MergeAcceptedGitHubCandidateRequest,
  SignedCandidateAcceptance,
} from "../src/github-contracts";
import { GitHubAppScmProxy, InMemoryScmOperationStore } from "../src/github-proxy";

const baseSha = "a".repeat(40);
const baseTreeSha = "b".repeat(40);
const candidateSha = "c".repeat(40);
const mergeSha = "d".repeat(40);
const now = "2030-01-01T00:00:00.000Z";
const nowEpoch = Math.floor(Date.parse(now) / 1_000);
const artifactKeys = generateKeyPairSync("ed25519");
const acceptanceKeys = generateKeyPairSync("ed25519");

const binding: GitHubRepositoryBinding = Object.freeze({
  tenantId: "tenant-1",
  projectId: "project-1",
  installationId: "123456",
  repositoryId: 991,
  repositoryNodeId: "R_repo991",
  owner: "north-dock-studio",
  name: "ember-archipelago",
  defaultBranch: "main",
});

function artifactCore(overrides: Partial<GitHubCandidateArtifactCore> = {}): GitHubCandidateArtifactCore {
  const content = Buffer.from("extends Node\n", "utf8");
  return {
    schemaVersion: "deviludo.github-candidate.v1",
    artifactId: "artifact-1",
    tenantId: binding.tenantId,
    projectId: binding.projectId,
    runId: "run-1",
    attemptId: "attempt-1",
    specRevisionId: "SPEC-008",
    expectedBaseCommitSha: baseSha,
    candidateBranch: "deviludo/project-1/attempt-1",
    commitMessage: "feat: implement approved specification",
    sourceDigest: "e".repeat(64),
    changes: [{
      operation: "UPSERT",
      path: "game/main.gd",
      mode: "100644",
      contentBase64: content.toString("base64"),
      contentDigest: contentSha256(content),
      sizeBytes: content.byteLength,
    }, { operation: "DELETE", path: "game/obsolete.gd" }],
    createdAt: now,
    ...overrides,
  };
}

class FakeGitHubConnector implements GitHubScmConnector {
  readonly calls: string[] = [];
  readonly references = new Map<string, string>([["main", baseSha]]);
  pullRequest: GitHubPullRequestSnapshot | null = null;
  repositoryNodeId = binding.repositoryNodeId;
  advanceAfterMerge = false;
  getPullRequestFailures = 0;

  async getRepository() {
    this.calls.push("getRepository");
    return {
      repositoryId: binding.repositoryId,
      repositoryNodeId: this.repositoryNodeId,
      owner: binding.owner,
      name: binding.name,
      defaultBranch: binding.defaultBranch,
      archived: false,
      disabled: false,
    };
  }

  async getReference(_binding: GitHubRepositoryBinding, branch: string) {
    this.calls.push(`getReference:${branch}`);
    const commitSha = this.references.get(branch);
    return commitSha ? { branch, commitSha } : null;
  }

  async getCommit() {
    this.calls.push("getCommit");
    return { commitSha: baseSha, treeSha: baseTreeSha };
  }

  async getSourceDigest(_binding: GitHubRepositoryBinding, commitSha: string) {
    this.calls.push(`getSourceDigest:${commitSha}`);
    return commitSha === candidateSha ? "e".repeat(64) : "f".repeat(64);
  }

  async createBlob(_binding: GitHubRepositoryBinding, contentBase64: string) {
    this.calls.push("createBlob");
    return { blobSha: createHash("sha1").update(Buffer.from(contentBase64, "base64")).digest("hex") };
  }

  async createTree() {
    this.calls.push("createTree");
    return { treeSha: "1".repeat(40) };
  }

  async createCommit() {
    this.calls.push("createCommit");
    return { commitSha: candidateSha };
  }

  async createReference(_binding: GitHubRepositoryBinding, branch: string, commitSha: string) {
    this.calls.push("createReference");
    this.references.set(branch, commitSha);
  }

  async findOpenPullRequest() {
    this.calls.push("findOpenPullRequest");
    return this.pullRequest?.state === "OPEN" ? this.pullRequest : null;
  }

  async createDraftPullRequest(_binding: GitHubRepositoryBinding, input: { headBranch: string; baseBranch: string }) {
    this.calls.push("createDraftPullRequest");
    this.pullRequest = {
      number: 18,
      nodeId: "PR_node18",
      url: "https://github.com/north-dock-studio/ember-archipelago/pull/18",
      state: "OPEN",
      draft: true,
      merged: false,
      headBranch: input.headBranch,
      headSha: candidateSha,
      baseBranch: input.baseBranch,
      mergeCommitSha: null,
    };
    return this.pullRequest;
  }

  async getPullRequest() {
    this.calls.push("getPullRequest");
    if (this.getPullRequestFailures > 0) {
      this.getPullRequestFailures -= 1;
      throw new Error("simulated connector interruption");
    }
    if (!this.pullRequest) throw new Error("fixture pull request missing");
    return this.pullRequest;
  }

  async markPullRequestReady() {
    this.calls.push("markPullRequestReady");
    if (!this.pullRequest) throw new Error("fixture pull request missing");
    this.pullRequest = { ...this.pullRequest, draft: false };
  }

  async mergePullRequest() {
    this.calls.push("mergePullRequest");
    if (!this.pullRequest) throw new Error("fixture pull request missing");
    this.pullRequest = { ...this.pullRequest, state: "CLOSED", merged: true, mergeCommitSha: mergeSha };
    this.references.set("main", this.advanceAfterMerge ? "f".repeat(40) : mergeSha);
    return { merged: true, mergeCommitSha: mergeSha, message: "Pull Request successfully merged" };
  }
}

function setup(options: { evidenceValid?: boolean } = {}) {
  const connector = new FakeGitHubConnector();
  const metrics = { evidenceChecks: 0 };
  const proxy = new GitHubAppScmProxy({
    connector,
    store: new InMemoryScmOperationStore(),
    artifactAttestationKeys: new Map([["candidate-attestation-v1", artifactKeys.publicKey]]),
    acceptanceKeys: new Map([["acceptance-v1", acceptanceKeys.publicKey]]),
    evidenceGate: { async verify() { metrics.evidenceChecks += 1; return options.evidenceValid ?? true; } },
  });
  return { proxy, connector, metrics };
}

async function publish(proxy: GitHubAppScmProxy, idempotencyKey = "publish-1") {
  return proxy.publishCandidate({
    idempotencyKey,
    binding,
    artifact: signGitHubCandidateArtifact(artifactCore(), artifactKeys.privateKey, "candidate-attestation-v1"),
    pullRequestTitle: "Implement SPEC-008",
    pullRequestBody: "Generated from the approved immutable specification.",
  }, now);
}

function acceptance(receipt: GitHubCandidateReceipt, overrides: Partial<Parameters<typeof signCandidateAcceptance>[0]> = {}): SignedCandidateAcceptance {
  return signCandidateAcceptance({
    iss: "deviludo-control-plane",
    aud: "deviludo-scm-proxy",
    tenantId: binding.tenantId,
    projectId: binding.projectId,
    acceptedBy: "user-42",
    candidateCommitSha: receipt.candidateCommitSha,
    sourceDigest: receipt.sourceDigest,
    specRevisionId: "SPEC-008",
    evidenceBundleDigest: "9".repeat(64),
    iat: nowEpoch - 10,
    exp: nowEpoch + 300,
    nonce: "acceptance-nonce-1",
    ...overrides,
  }, acceptanceKeys.privateKey, "acceptance-v1");
}

function mergeRequest(receipt: GitHubCandidateReceipt): MergeAcceptedGitHubCandidateRequest {
  return {
    idempotencyKey: "merge-1",
    binding,
    candidate: receipt,
    evidence: {
      evidenceBundleId: "evidence-18",
      evidenceBundleDigest: "9".repeat(64),
      candidateCommitSha: receipt.candidateCommitSha,
      sourceDigest: receipt.sourceDigest,
      specRevisionId: "SPEC-008",
      status: "PASSED",
      valid: true,
    },
    acceptance: acceptance(receipt),
  };
}

test("publishes a signed authoritative candidate as an idempotent Draft PR", async () => {
  const { proxy, connector } = setup();
  const first = await publish(proxy);
  assert.equal(first.state, "DRAFT");
  assert.equal(first.pullRequestNumber, 18);
  assert.equal(first.candidateCommitSha, candidateSha);
  assert.deepEqual(first.changedFiles, ["game/main.gd", "game/obsolete.gd"]);
  assert.equal(connector.calls.includes("createBlob"), true);
  assert.equal(connector.calls.includes("createDraftPullRequest"), true);

  const callCount = connector.calls.length;
  const replay = await publish(proxy);
  assert.deepEqual(replay, first);
  assert.equal(connector.calls.length, callCount);
  await assert.rejects(
    proxy.publishCandidate({
      idempotencyKey: "publish-1",
      binding,
      artifact: signGitHubCandidateArtifact(artifactCore(), artifactKeys.privateKey, "candidate-attestation-v1"),
      pullRequestTitle: "Different request",
      pullRequestBody: "Generated from the approved immutable specification.",
    }, now),
    /idempotency key was reused/,
  );
});

test("rejects unsigned, corrupt or cross-repository candidate material before GitHub writes", async () => {
  const { proxy, connector } = setup();
  const signed = signGitHubCandidateArtifact(artifactCore(), artifactKeys.privateKey, "candidate-attestation-v1");
  await assert.rejects(proxy.publishCandidate({
    idempotencyKey: "bad-signature",
    binding,
    artifact: { ...signed, attestation: { ...signed.attestation, signature: "invalid" } },
    pullRequestTitle: "Implement SPEC-008",
    pullRequestBody: "",
  }, now), /attestation is invalid/);
  assert.equal(connector.calls.length, 0);

  const corrupt = artifactCore({
    changes: [{ operation: "UPSERT", path: "../escape", mode: "100644", contentBase64: "YQ==", contentDigest: "0".repeat(64), sizeBytes: 1 }],
  });
  await assert.rejects(proxy.publishCandidate({
    idempotencyKey: "bad-path",
    binding,
    artifact: signGitHubCandidateArtifact(corrupt, artifactKeys.privateKey, "candidate-attestation-v1"),
    pullRequestTitle: "Implement SPEC-008",
    pullRequestBody: "",
  }, now), /unsafe repository path/);
  assert.equal(connector.calls.length, 0);

  connector.repositoryNodeId = "R_other";
  await assert.rejects(publish(proxy, "wrong-repository"), /immutable project binding/);
  assert.equal(connector.calls.includes("createBlob"), false);
});

test("merges only a fresh signed acceptance backed by authoritative passing evidence", async () => {
  const { proxy, connector } = setup();
  const receipt = await publish(proxy);
  const request = mergeRequest(receipt);
  const merged = await proxy.mergeAcceptedCandidate(request, now);
  assert.equal(merged.mergeCommitSha, mergeSha);
  assert.equal(merged.defaultBranchHeadSha, mergeSha);
  assert.equal(merged.requiresFreshMainSnapshot, false);
  assert.equal(merged.mainSourceDigest, "f".repeat(64));
  assert.equal(connector.calls.includes("markPullRequestReady"), true);
  assert.equal(connector.calls.includes("mergePullRequest"), true);

  const callCount = connector.calls.length;
  assert.deepEqual(await proxy.mergeAcceptedCandidate(request, now), merged);
  assert.equal(connector.calls.length, callCount);
});

test("records main advancement and refuses expired approval or untrusted evidence", async () => {
  const advanced = setup();
  advanced.connector.advanceAfterMerge = true;
  const receipt = await publish(advanced.proxy);
  const merged = await advanced.proxy.mergeAcceptedCandidate(mergeRequest(receipt), now);
  assert.equal(merged.requiresFreshMainSnapshot, true);
  assert.equal(merged.defaultBranchHeadSha, "f".repeat(40));

  const expired = setup();
  const expiredReceipt = await publish(expired.proxy);
  const expiredRequest = {
    ...mergeRequest(expiredReceipt),
    acceptance: acceptance(expiredReceipt, { iat: nowEpoch - 700, exp: nowEpoch - 100 }),
  };
  await assert.rejects(expired.proxy.mergeAcceptedCandidate(expiredRequest, now), /invalid or expired/);
  assert.equal(expired.connector.calls.includes("mergePullRequest"), false);

  const untrusted = setup({ evidenceValid: false });
  const untrustedReceipt = await publish(untrusted.proxy);
  await assert.rejects(untrusted.proxy.mergeAcceptedCandidate(mergeRequest(untrustedReceipt), now), /not authoritative/);
  assert.equal(untrusted.connector.calls.includes("mergePullRequest"), false);
});

test("a claimed merge resumes after connector interruption without re-authorizing an expired acceptance", async () => {
  const recovery = setup();
  const receipt = await publish(recovery.proxy);
  const request = mergeRequest(receipt);
  recovery.connector.getPullRequestFailures = 1;
  await assert.rejects(recovery.proxy.mergeAcceptedCandidate(request, now), /simulated connector interruption/);
  assert.equal(recovery.metrics.evidenceChecks, 1);
  await assert.rejects(
    recovery.proxy.mergeAcceptedCandidate(request, "2030-01-01T00:01:00.000Z"),
    /already in progress/,
  );
  const resumed = await recovery.proxy.mergeAcceptedCandidate(request, "2030-01-01T00:10:01.000Z");
  assert.equal(resumed.mergeCommitSha, mergeSha);
  assert.equal(recovery.metrics.evidenceChecks, 1);
});
