import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { canonicalJson, sha256Canonical } from "./canonical";
import { contentSha256, verifyCandidateAcceptance, verifyGitHubCandidateArtifact } from "./github-artifacts";
import type {
  GitHubCandidateArtifactPayload,
  GitHubCandidateReceipt,
  GitHubMergeReceipt,
  GitHubRepositoryBinding,
  GitHubRepositorySnapshot,
  GitHubScmProxyOptions,
  MergeAcceptedGitHubCandidateRequest,
  PublishGitHubCandidateRequest,
  ScmOperationRecord,
  ScmOperationStore,
} from "./github-contracts";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OWNER_OR_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const MAX_CHANGED_FILES = 20_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const OPERATION_CLAIM_MS = 5 * 60_000;

export class GitHubAppScmProxy {
  readonly #connector: GitHubScmProxyOptions["connector"];
  readonly #store: ScmOperationStore;
  readonly #evidenceGate: GitHubScmProxyOptions["evidenceGate"];
  readonly #artifactKeys: ReadonlyMap<string, KeyObject>;
  readonly #acceptanceKeys: ReadonlyMap<string, KeyObject>;

  constructor(options: GitHubScmProxyOptions) {
    validateKeyRing(options.artifactAttestationKeys, "artifact attestation");
    validateKeyRing(options.acceptanceKeys, "acceptance");
    this.#connector = options.connector;
    this.#store = options.store;
    this.#evidenceGate = options.evidenceGate;
    this.#artifactKeys = options.artifactAttestationKeys;
    this.#acceptanceKeys = options.acceptanceKeys;
  }

  async publishCandidate(
    request: PublishGitHubCandidateRequest,
    at = new Date().toISOString(),
  ): Promise<GitHubCandidateReceipt> {
    validateBinding(request.binding);
    validateIdempotencyKey(request.idempotencyKey);
    validateCandidateRequest(request, at);
    const requestDigest = sha256Canonical({
      operation: "PUBLISH_CANDIDATE",
      binding: request.binding,
      artifact: request.artifact,
      pullRequestTitle: request.pullRequestTitle,
      pullRequestBody: request.pullRequestBody,
    });
    const storeKey = operationKey("publish", request.binding, request.idempotencyKey);
    const artifact = request.artifact.payload;
    validateCandidateArtifact(artifact, request.binding, at);
    const existing = await this.#operation<GitHubCandidateReceipt>(storeKey, requestDigest);
    if (existing.response) return existing.response;
    if (!existing.authorized) {
      if (!verifyGitHubCandidateArtifact(request.artifact, this.#artifactKeys)) {
        throw new Error("Candidate artifact attestation is invalid");
      }
    }
    const claimToken = await this.#claim<GitHubCandidateReceipt>(storeKey, requestDigest, at);
    const repository = await this.#connector.getRepository(request.binding);
    assertRepositoryBinding(repository, request.binding);
    const baseReference = await this.#connector.getReference(request.binding, request.binding.defaultBranch);
    if (!baseReference || baseReference.commitSha !== artifact.expectedBaseCommitSha) {
      throw new Error("GitHub default branch moved from the locked base commit");
    }
    const baseCommit = await this.#connector.getCommit(request.binding, artifact.expectedBaseCommitSha);
    if (baseCommit.commitSha !== artifact.expectedBaseCommitSha || !SHA1.test(baseCommit.treeSha)) {
      throw new Error("GitHub returned an invalid locked base commit");
    }

    const treeEntries: Array<{ path: string; mode?: "100644" | "100755"; type?: "blob"; sha: string | null }> = [];
    for (const change of [...artifact.changes].sort((left, right) => left.path.localeCompare(right.path))) {
      if (change.operation === "DELETE") {
        treeEntries.push({ path: change.path, sha: null });
        continue;
      }
      const created = await this.#connector.createBlob(request.binding, change.contentBase64);
      if (!SHA1.test(created.blobSha)) throw new Error("GitHub returned an invalid blob SHA");
      treeEntries.push({ path: change.path, mode: change.mode, type: "blob", sha: created.blobSha });
    }
    const tree = await this.#connector.createTree(request.binding, {
      baseTreeSha: baseCommit.treeSha,
      entries: treeEntries,
    });
    if (!SHA1.test(tree.treeSha)) throw new Error("GitHub returned an invalid tree SHA");
    const createdCommit = await this.#connector.createCommit(request.binding, {
      message: artifact.commitMessage,
      treeSha: tree.treeSha,
      parentCommitSha: artifact.expectedBaseCommitSha,
      author: {
        name: "DeviLudo SCM Proxy",
        email: "scm-proxy@deviludo.invalid",
        date: artifact.createdAt,
      },
    });
    if (!SHA1.test(createdCommit.commitSha) || createdCommit.commitSha === artifact.expectedBaseCommitSha) {
      throw new Error("GitHub did not create a valid candidate commit");
    }
    const observedSourceDigest = await this.#connector.getSourceDigest(request.binding, createdCommit.commitSha);
    if (observedSourceDigest !== artifact.sourceDigest) {
      throw new Error("GitHub candidate tree does not match the attested source digest");
    }

    const existingBranch = await this.#connector.getReference(request.binding, artifact.candidateBranch);
    if (existingBranch && existingBranch.commitSha !== createdCommit.commitSha) {
      throw new Error("GitHub candidate branch already points to another commit");
    }
    if (!existingBranch) {
      await this.#connector.createReference(request.binding, artifact.candidateBranch, createdCommit.commitSha);
    }
    let pullRequest = await this.#connector.findOpenPullRequest(
      request.binding,
      artifact.candidateBranch,
      request.binding.defaultBranch,
    );
    if (pullRequest) {
      if (!pullRequest.draft
        || pullRequest.headSha !== createdCommit.commitSha
        || pullRequest.headBranch !== artifact.candidateBranch
        || pullRequest.baseBranch !== request.binding.defaultBranch) {
        throw new Error("Existing GitHub pull request does not match the candidate lock");
      }
    } else {
      pullRequest = await this.#connector.createDraftPullRequest(request.binding, {
        title: request.pullRequestTitle,
        body: request.pullRequestBody,
        headBranch: artifact.candidateBranch,
        baseBranch: request.binding.defaultBranch,
      });
    }
    validateDraftPullRequest(pullRequest, artifact.candidateBranch, createdCommit.commitSha, request.binding);

    const receipt: GitHubCandidateReceipt = deepFreeze({
      scmProxy: "github-app-proxy-v1",
      tenantId: request.binding.tenantId,
      projectId: request.binding.projectId,
      installationId: request.binding.installationId,
      repositoryId: request.binding.repositoryId,
      repositoryNodeId: request.binding.repositoryNodeId,
      artifactId: artifact.artifactId,
      artifactDigest: artifact.artifactDigest,
      baseBranch: request.binding.defaultBranch,
      baseCommitSha: artifact.expectedBaseCommitSha,
      candidateBranch: artifact.candidateBranch,
      candidateCommitSha: createdCommit.commitSha,
      sourceDigest: artifact.sourceDigest,
      changedFiles: artifact.changes.map((change) => change.path).sort(),
      pullRequestNumber: pullRequest.number,
      pullRequestNodeId: pullRequest.nodeId,
      pullRequestUrl: pullRequest.url,
      state: "DRAFT",
      createdAt: at,
    });
    await this.#store.complete({ key: storeKey, requestDigest, claimToken, response: receipt });
    return receipt;
  }

  async mergeAcceptedCandidate(
    request: MergeAcceptedGitHubCandidateRequest,
    at = new Date().toISOString(),
  ): Promise<GitHubMergeReceipt> {
    validateBinding(request.binding);
    validateIdempotencyKey(request.idempotencyKey);
    validateCandidateReceipt(request.candidate, request.binding);
    validateEvidence(request);
    const requestDigest = sha256Canonical({
      operation: "MERGE_ACCEPTED_CANDIDATE",
      binding: request.binding,
      candidate: request.candidate,
      evidence: request.evidence,
      acceptance: request.acceptance,
    });
    const storeKey = operationKey("merge", request.binding, request.idempotencyKey);
    const existing = await this.#operation<GitHubMergeReceipt>(storeKey, requestDigest);
    if (existing.response) return existing.response;
    const nowEpochSeconds = Math.floor(Date.parse(at) / 1_000);
    if (!Number.isInteger(nowEpochSeconds)) throw new Error("Merge timestamp is invalid");
    if (!existing.authorized) {
      if (!verifyCandidateAcceptance(request.acceptance, this.#acceptanceKeys, {
        tenantId: request.binding.tenantId,
        projectId: request.binding.projectId,
        candidateCommitSha: request.candidate.candidateCommitSha,
        sourceDigest: request.candidate.sourceDigest,
        specRevisionId: request.evidence.specRevisionId,
        evidenceBundleDigest: request.evidence.evidenceBundleDigest,
      }, nowEpochSeconds)) {
        throw new Error("Candidate acceptance proof is invalid or expired");
      }
      if (!(await this.#evidenceGate.verify({ binding: request.binding, candidate: request.candidate, evidence: request.evidence }))) {
        throw new Error("Candidate evidence is not authoritative or is no longer valid");
      }
    }
    const claimToken = await this.#claim<GitHubMergeReceipt>(storeKey, requestDigest, at);

    const repository = await this.#connector.getRepository(request.binding);
    assertRepositoryBinding(repository, request.binding);
    let pullRequest = await this.#connector.getPullRequest(request.binding, request.candidate.pullRequestNumber);
    validateCandidatePullRequest(pullRequest, request.candidate, request.binding.defaultBranch);
    let mergeCommitSha = pullRequest.mergeCommitSha;
    if (!pullRequest.merged) {
      if (pullRequest.state !== "OPEN") throw new Error("Accepted pull request is not open");
      if (pullRequest.draft) {
        await this.#connector.markPullRequestReady(request.binding, pullRequest.nodeId);
        pullRequest = await this.#connector.getPullRequest(request.binding, request.candidate.pullRequestNumber);
        validateCandidatePullRequest(pullRequest, request.candidate, request.binding.defaultBranch);
        if (pullRequest.draft) throw new Error("GitHub pull request is still a draft after ready transition");
      }
      const result = await this.#connector.mergePullRequest(request.binding, {
        number: request.candidate.pullRequestNumber,
        expectedHeadSha: request.candidate.candidateCommitSha,
        commitTitle: `Merge DeviLudo candidate #${request.candidate.pullRequestNumber}`,
        commitMessage: `Accepted by ${request.acceptance.claims.acceptedBy}; evidence ${request.evidence.evidenceBundleDigest}`,
      });
      if (!result.merged || !SHA1.test(result.mergeCommitSha)) throw new Error("GitHub did not merge the accepted pull request");
      mergeCommitSha = result.mergeCommitSha;
    }
    if (!mergeCommitSha || !SHA1.test(mergeCommitSha)) throw new Error("Merged pull request is missing its merge commit SHA");
    const defaultReference = await this.#connector.getReference(request.binding, request.binding.defaultBranch);
    if (!defaultReference || !SHA1.test(defaultReference.commitSha)) throw new Error("GitHub default branch is unavailable after merge");
    const mainSourceDigest = await this.#connector.getSourceDigest(request.binding, defaultReference.commitSha);
    if (!SHA256.test(mainSourceDigest)) throw new Error("GitHub main source digest is invalid");

    const receipt: GitHubMergeReceipt = deepFreeze({
      scmProxy: "github-app-proxy-v1",
      tenantId: request.binding.tenantId,
      projectId: request.binding.projectId,
      repositoryNodeId: request.binding.repositoryNodeId,
      pullRequestNumber: request.candidate.pullRequestNumber,
      candidateCommitSha: request.candidate.candidateCommitSha,
      mergeCommitSha,
      defaultBranch: request.binding.defaultBranch,
      defaultBranchHeadSha: defaultReference.commitSha,
      mainSourceDigest,
      requiresFreshMainSnapshot: defaultReference.commitSha !== mergeCommitSha,
      acceptanceNonce: request.acceptance.claims.nonce,
      evidenceBundleDigest: request.evidence.evidenceBundleDigest,
      mergedAt: at,
    });
    await this.#store.complete({ key: storeKey, requestDigest, claimToken, response: receipt });
    return receipt;
  }

  async #operation<T>(key: string, requestDigest: string): Promise<{ readonly authorized: boolean; readonly response: T | null }> {
    const record = await this.#store.inspect<T>(key);
    if (!record) return { authorized: false, response: null };
    if (record.requestDigest !== requestDigest) throw new Error("SCM idempotency key was reused with a different request");
    return { authorized: true, response: record.response };
  }

  async #claim<T>(key: string, requestDigest: string, at: string): Promise<string> {
    const claimedAt = new Date(at).toISOString();
    const claimToken = randomUUID();
    const acquired = await this.#store.acquire<T>({
      key,
      requestDigest,
      claimToken,
      claimedAt,
      claimExpiresAt: new Date(Date.parse(claimedAt) + OPERATION_CLAIM_MS).toISOString(),
    });
    if (acquired.status === "BUSY") throw new Error("SCM operation is already in progress; retry after its claim expires");
    if (acquired.status === "COMPLETED") throw new Error("SCM operation completed concurrently; retry to read its receipt");
    return acquired.claimToken;
  }
}

export class InMemoryScmOperationStore implements ScmOperationStore {
  readonly #records = new Map<string, ScmOperationRecord<unknown>>();

  async inspect<T>(key: string): Promise<ScmOperationRecord<T> | null> {
    return (this.#records.get(key) as ScmOperationRecord<T> | undefined) ?? null;
  }

  async acquire<T>(input: {
    readonly key: string;
    readonly requestDigest: string;
    readonly claimToken: string;
    readonly claimedAt: string;
    readonly claimExpiresAt: string;
  }): Promise<import("./github-contracts").ScmOperationAcquireResult<T>> {
    const current = this.#records.get(input.key);
    if (current) {
      if (current.requestDigest !== input.requestDigest) throw new Error("SCM operation store rejected a conflicting reservation");
      if (current.response !== null) return { status: "COMPLETED", response: current.response as T };
      if (Date.parse(current.claimExpiresAt) > Date.parse(input.claimedAt)) return { status: "BUSY" };
    }
    this.#records.set(input.key, {
      requestDigest: input.requestDigest,
      response: null,
      claimToken: input.claimToken,
      claimExpiresAt: input.claimExpiresAt,
    });
    return { status: "ACQUIRED", claimToken: input.claimToken };
  }

  async complete<T>(input: { readonly key: string; readonly requestDigest: string; readonly claimToken: string; readonly response: T }): Promise<void> {
    const current = this.#records.get(input.key);
    if (!current || current.requestDigest !== input.requestDigest || current.claimToken !== input.claimToken) {
      throw new Error("SCM operation must hold the active claim before completion");
    }
    if (current.response !== null && canonicalJson(current.response) !== canonicalJson(input.response)) {
      throw new Error("SCM operation store rejected a conflicting idempotent result");
    }
    this.#records.set(input.key, { ...current, response: input.response });
  }
}

function validateCandidateRequest(request: PublishGitHubCandidateRequest, at: string): void {
  if (!request.pullRequestTitle.trim() || request.pullRequestTitle.length > 240 || /[\u0000-\u001f]/.test(request.pullRequestTitle)) {
    throw new Error("Pull request title is invalid");
  }
  if (request.pullRequestBody.length > 32_000 || request.pullRequestBody.includes("\0")) throw new Error("Pull request body is invalid");
  if (!Number.isFinite(Date.parse(at))) throw new Error("Publish timestamp is invalid");
}

function validateCandidateArtifact(artifact: GitHubCandidateArtifactPayload, binding: GitHubRepositoryBinding, at: string): void {
  for (const value of [artifact.artifactId, artifact.runId, artifact.attemptId, artifact.specRevisionId]) {
    if (!IDENTIFIER.test(value)) throw new Error("Candidate artifact identifier is invalid");
  }
  if (artifact.schemaVersion !== "deviludo.github-candidate.v1"
    || artifact.tenantId !== binding.tenantId
    || artifact.projectId !== binding.projectId) throw new Error("Candidate artifact binding mismatch");
  if (!SHA1.test(artifact.expectedBaseCommitSha)) throw new Error("Candidate base commit SHA is invalid");
  if (!SHA256.test(artifact.sourceDigest) || !SHA256.test(artifact.artifactDigest)) throw new Error("Candidate artifact digest is invalid");
  validateCandidateBranch(artifact.candidateBranch);
  if (!artifact.commitMessage.trim() || artifact.commitMessage.length > 500 || artifact.commitMessage.includes("\0")) throw new Error("Candidate commit message is invalid");
  if (!Number.isFinite(Date.parse(artifact.createdAt)) || Date.parse(artifact.createdAt) > Date.parse(at) + 5 * 60_000) throw new Error("Candidate creation timestamp is invalid");
  if (!artifact.changes.length || artifact.changes.length > MAX_CHANGED_FILES) throw new Error("Candidate changed-file count is invalid");
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const change of artifact.changes) {
    validatePath(change.path);
    if (seen.has(change.path)) throw new Error("Candidate contains duplicate file paths");
    seen.add(change.path);
    if (change.operation === "UPSERT") {
      if (!Number.isInteger(change.sizeBytes) || change.sizeBytes < 0 || change.sizeBytes > MAX_FILE_BYTES) throw new Error("Candidate file size is invalid");
      const content = decodeCanonicalBase64(change.contentBase64);
      if (content.byteLength !== change.sizeBytes || contentSha256(content) !== change.contentDigest) throw new Error("Candidate file content digest mismatch");
      totalBytes += content.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Candidate file content exceeds the total size limit");
    }
  }
}

function validateEvidence(request: MergeAcceptedGitHubCandidateRequest): void {
  const evidence = request.evidence;
  if (evidence.status !== "PASSED" || evidence.valid !== true
    || evidence.candidateCommitSha !== request.candidate.candidateCommitSha
    || evidence.sourceDigest !== request.candidate.sourceDigest
    || !IDENTIFIER.test(evidence.evidenceBundleId)
    || !IDENTIFIER.test(evidence.specRevisionId)
    || !SHA256.test(evidence.evidenceBundleDigest)) {
    throw new Error("Candidate evidence does not match the merge request");
  }
}

function validateBinding(binding: GitHubRepositoryBinding): void {
  for (const value of [binding.tenantId, binding.projectId, binding.installationId, binding.repositoryNodeId]) {
    if (!IDENTIFIER.test(value)) throw new Error("GitHub repository binding identifier is invalid");
  }
  if (!Number.isSafeInteger(binding.repositoryId) || binding.repositoryId <= 0) throw new Error("GitHub repository ID is invalid");
  if (!/^\d{1,20}$/.test(binding.installationId)) throw new Error("GitHub installation ID is invalid");
  if (!OWNER_OR_REPOSITORY.test(binding.owner) || !OWNER_OR_REPOSITORY.test(binding.name)) throw new Error("GitHub repository owner or name is invalid");
  validateBaseBranch(binding.defaultBranch);
}

function assertRepositoryBinding(repository: GitHubRepositorySnapshot, binding: GitHubRepositoryBinding): void {
  if (repository.repositoryId !== binding.repositoryId
    || repository.repositoryNodeId !== binding.repositoryNodeId
    || repository.owner.toLowerCase() !== binding.owner.toLowerCase()
    || repository.name.toLowerCase() !== binding.name.toLowerCase()
    || repository.defaultBranch !== binding.defaultBranch
    || repository.archived
    || repository.disabled) {
    throw new Error("GitHub repository does not match the immutable project binding");
  }
}

function validateCandidateReceipt(candidate: GitHubCandidateReceipt, binding: GitHubRepositoryBinding): void {
  if (candidate.scmProxy !== "github-app-proxy-v1"
    || candidate.state !== "DRAFT"
    || candidate.tenantId !== binding.tenantId
    || candidate.projectId !== binding.projectId
    || candidate.installationId !== binding.installationId
    || candidate.repositoryId !== binding.repositoryId
    || candidate.repositoryNodeId !== binding.repositoryNodeId
    || candidate.baseBranch !== binding.defaultBranch
    || !SHA1.test(candidate.baseCommitSha)
    || !SHA1.test(candidate.candidateCommitSha)
    || !SHA256.test(candidate.sourceDigest)
    || !SHA256.test(candidate.artifactDigest)
    || !Number.isInteger(candidate.pullRequestNumber)
    || candidate.pullRequestNumber <= 0
    || !isExpectedPullRequestUrl(candidate.pullRequestUrl, binding, candidate.pullRequestNumber)) throw new Error("GitHub candidate receipt binding is invalid");
  validateCandidateBranch(candidate.candidateBranch);
}

function validateDraftPullRequest(
  pullRequest: Awaited<ReturnType<GitHubScmProxyOptions["connector"]["getPullRequest"]>>,
  branch: string,
  commitSha: string,
  binding: GitHubRepositoryBinding,
): void {
  if (pullRequest.state !== "OPEN" || !pullRequest.draft || pullRequest.merged
    || pullRequest.headBranch !== branch || pullRequest.headSha !== commitSha
    || pullRequest.baseBranch !== binding.defaultBranch || !pullRequest.nodeId
    || !isExpectedPullRequestUrl(pullRequest.url, binding, pullRequest.number)
    || !Number.isInteger(pullRequest.number) || pullRequest.number <= 0) {
    throw new Error("GitHub did not create the expected Draft pull request");
  }
}

function validateCandidatePullRequest(
  pullRequest: Awaited<ReturnType<GitHubScmProxyOptions["connector"]["getPullRequest"]>>,
  candidate: GitHubCandidateReceipt,
  baseBranch: string,
): void {
  if (pullRequest.number !== candidate.pullRequestNumber
    || pullRequest.nodeId !== candidate.pullRequestNodeId
    || pullRequest.headBranch !== candidate.candidateBranch
    || pullRequest.headSha !== candidate.candidateCommitSha
    || pullRequest.baseBranch !== baseBranch) throw new Error("GitHub pull request drifted from the accepted candidate");
}

function validateCandidateBranch(value: string): void {
  if (value.length > 128
    || !/^deviludo\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i.test(value)
    || value.includes("..")
    || value.endsWith(".lock")) throw new Error("GitHub candidate branch is invalid");
}

function validateBaseBranch(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value) || value.includes("..") || value.includes("//") || value.endsWith(".lock")) {
    throw new Error("GitHub default branch is invalid");
  }
}

function validatePath(value: string): void {
  const segments = value.split("/");
  if (!value || value.length > 500 || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)
    || segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".git")) {
    throw new Error("Candidate contains an unsafe repository path");
  }
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (!value || value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Candidate file content is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Candidate file content is not canonical base64");
  return bytes;
}

function validateIdempotencyKey(value: string): void {
  if (!value || value.length > 160 || /[\u0000-\u0020]/.test(value)) throw new Error("SCM idempotency key is invalid");
}

function operationKey(operation: string, binding: GitHubRepositoryBinding, idempotencyKey: string): string {
  return `github:${operation}:${binding.tenantId}:${binding.projectId}:${idempotencyKey}`;
}

function validateKeyRing(keys: ReadonlyMap<string, KeyObject>, label: string): void {
  if (!keys.size) throw new Error(`SCM ${label} key ring cannot be empty`);
  for (const [keyId, key] of keys) {
    const publicKey = key.type === "public" ? key : createPublicKey(key);
    if (!keyId.trim() || publicKey.asymmetricKeyType !== "ed25519") throw new Error(`SCM ${label} key ring is invalid`);
  }
}

function isExpectedPullRequestUrl(value: string, binding: GitHubRepositoryBinding, number: number): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && url.port === ""
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname.toLowerCase() === `/${binding.owner}/${binding.name}/pull/${number}`.toLowerCase();
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
