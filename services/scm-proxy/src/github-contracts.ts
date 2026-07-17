import type { KeyObject } from "node:crypto";

export interface GitHubRepositoryBinding {
  readonly tenantId: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly repositoryId: number;
  readonly repositoryNodeId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
}

export type GitHubCandidateChange =
  | {
      readonly operation: "UPSERT";
      readonly path: string;
      readonly mode: "100644" | "100755";
      readonly contentBase64: string;
      readonly contentDigest: string;
      readonly sizeBytes: number;
    }
  | {
      readonly operation: "DELETE";
      readonly path: string;
    };

export interface GitHubCandidateArtifactCore {
  readonly schemaVersion: "deviludo.github-candidate.v1";
  readonly artifactId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly specRevisionId: string;
  readonly expectedBaseCommitSha: string;
  readonly candidateBranch: string;
  readonly commitMessage: string;
  readonly sourceDigest: string;
  readonly changes: readonly GitHubCandidateChange[];
  readonly createdAt: string;
}

export interface GitHubCandidateArtifactPayload extends GitHubCandidateArtifactCore {
  readonly artifactDigest: string;
}

export interface SignedGitHubCandidateArtifact {
  readonly payload: GitHubCandidateArtifactPayload;
  readonly attestation: {
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly signature: string;
  };
}

export interface GitHubRepositorySnapshot {
  readonly repositoryId: number;
  readonly repositoryNodeId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly archived: boolean;
  readonly disabled: boolean;
}

export interface GitHubReference {
  readonly branch: string;
  readonly commitSha: string;
}

export interface GitHubCommitSnapshot {
  readonly commitSha: string;
  readonly treeSha: string;
}

export interface GitHubPullRequestSnapshot {
  readonly number: number;
  readonly nodeId: string;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED";
  readonly draft: boolean;
  readonly merged: boolean;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly mergeCommitSha: string | null;
}

export interface GitHubScmConnector {
  getRepository(binding: GitHubRepositoryBinding): Promise<GitHubRepositorySnapshot>;
  getReference(binding: GitHubRepositoryBinding, branch: string): Promise<GitHubReference | null>;
  getCommit(binding: GitHubRepositoryBinding, commitSha: string): Promise<GitHubCommitSnapshot>;
  createBlob(binding: GitHubRepositoryBinding, contentBase64: string): Promise<{ readonly blobSha: string }>;
  createTree(binding: GitHubRepositoryBinding, input: {
    readonly baseTreeSha: string;
    readonly entries: readonly Readonly<{ path: string; mode?: "100644" | "100755"; type?: "blob"; sha: string | null }>[];
  }): Promise<{ readonly treeSha: string }>;
  createCommit(binding: GitHubRepositoryBinding, input: {
    readonly message: string;
    readonly treeSha: string;
    readonly parentCommitSha: string;
    readonly author: Readonly<{ name: string; email: string; date: string }>;
  }): Promise<{ readonly commitSha: string }>;
  createReference(binding: GitHubRepositoryBinding, branch: string, commitSha: string): Promise<void>;
  findOpenPullRequest(binding: GitHubRepositoryBinding, headBranch: string, baseBranch: string): Promise<GitHubPullRequestSnapshot | null>;
  createDraftPullRequest(binding: GitHubRepositoryBinding, input: {
    readonly title: string;
    readonly body: string;
    readonly headBranch: string;
    readonly baseBranch: string;
  }): Promise<GitHubPullRequestSnapshot>;
  getPullRequest(binding: GitHubRepositoryBinding, number: number): Promise<GitHubPullRequestSnapshot>;
  markPullRequestReady(binding: GitHubRepositoryBinding, nodeId: string): Promise<void>;
  mergePullRequest(binding: GitHubRepositoryBinding, input: {
    readonly number: number;
    readonly expectedHeadSha: string;
    readonly commitTitle: string;
    readonly commitMessage: string;
  }): Promise<{ readonly merged: boolean; readonly mergeCommitSha: string; readonly message: string }>;
}

/** Raw token is visible only inside the trusted Connector process. */
export interface GitHubInstallationAccessToken {
  readonly value: string;
  readonly expiresAt: string;
  readonly installationId: string;
  readonly repositoryId: number;
}

export interface GitHubInstallationTokenBroker {
  issue(binding: GitHubRepositoryBinding): Promise<GitHubInstallationAccessToken>;
}

/** Implemented by a Vault/KMS-backed RSA signer; private key bytes never enter SCM business logic. */
export interface GitHubAppJwtSigner {
  readonly keyId: string;
  signRs256(signingInput: Uint8Array): Promise<Uint8Array>;
}

export interface PublishGitHubCandidateRequest {
  readonly idempotencyKey: string;
  readonly binding: GitHubRepositoryBinding;
  readonly artifact: SignedGitHubCandidateArtifact;
  readonly pullRequestTitle: string;
  readonly pullRequestBody: string;
}

export interface GitHubCandidateReceipt {
  readonly scmProxy: "github-app-proxy-v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly repositoryId: number;
  readonly repositoryNodeId: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly baseBranch: string;
  readonly baseCommitSha: string;
  readonly candidateBranch: string;
  readonly candidateCommitSha: string;
  readonly sourceDigest: string;
  readonly changedFiles: readonly string[];
  readonly pullRequestNumber: number;
  readonly pullRequestNodeId: string;
  readonly pullRequestUrl: string;
  readonly state: "DRAFT";
  readonly createdAt: string;
}

export interface AcceptedCandidateEvidence {
  readonly evidenceBundleId: string;
  readonly evidenceBundleDigest: string;
  readonly candidateCommitSha: string;
  readonly sourceDigest: string;
  readonly specRevisionId: string;
  readonly status: "PASSED";
  readonly valid: true;
}

export interface CandidateAcceptanceClaims {
  readonly iss: "deviludo-control-plane";
  readonly aud: "deviludo-scm-proxy";
  readonly tenantId: string;
  readonly projectId: string;
  readonly acceptedBy: string;
  readonly candidateCommitSha: string;
  readonly sourceDigest: string;
  readonly specRevisionId: string;
  readonly evidenceBundleDigest: string;
  readonly iat: number;
  readonly exp: number;
  readonly nonce: string;
}

export interface SignedCandidateAcceptance {
  readonly claims: CandidateAcceptanceClaims;
  readonly signature: {
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly value: string;
  };
}

export interface MergeAcceptedGitHubCandidateRequest {
  readonly idempotencyKey: string;
  readonly binding: GitHubRepositoryBinding;
  readonly candidate: GitHubCandidateReceipt;
  readonly evidence: AcceptedCandidateEvidence;
  readonly acceptance: SignedCandidateAcceptance;
}

export interface GitHubMergeReceipt {
  readonly scmProxy: "github-app-proxy-v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly repositoryNodeId: string;
  readonly pullRequestNumber: number;
  readonly candidateCommitSha: string;
  readonly mergeCommitSha: string;
  readonly defaultBranch: string;
  readonly defaultBranchHeadSha: string;
  readonly requiresFreshMainSnapshot: boolean;
  readonly acceptanceNonce: string;
  readonly evidenceBundleDigest: string;
  readonly mergedAt: string;
}

export interface ScmOperationRecord<T> {
  readonly requestDigest: string;
  readonly response: T | null;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
}

export type ScmOperationAcquireResult<T> =
  | { readonly status: "ACQUIRED"; readonly claimToken: string }
  | { readonly status: "BUSY" }
  | { readonly status: "COMPLETED"; readonly response: T };

export interface ScmOperationStore {
  inspect<T>(key: string): Promise<ScmOperationRecord<T> | null>;
  acquire<T>(input: {
    readonly key: string;
    readonly requestDigest: string;
    readonly claimToken: string;
    readonly claimedAt: string;
    readonly claimExpiresAt: string;
  }): Promise<ScmOperationAcquireResult<T>>;
  complete<T>(input: {
    readonly key: string;
    readonly requestDigest: string;
    readonly claimToken: string;
    readonly response: T;
  }): Promise<void>;
}

export interface CandidateEvidenceGate {
  verify(input: {
    readonly binding: GitHubRepositoryBinding;
    readonly candidate: GitHubCandidateReceipt;
    readonly evidence: AcceptedCandidateEvidence;
  }): Promise<boolean>;
}

export interface GitHubScmProxyOptions {
  readonly connector: GitHubScmConnector;
  readonly store: ScmOperationStore;
  readonly evidenceGate: CandidateEvidenceGate;
  readonly artifactAttestationKeys: ReadonlyMap<string, KeyObject>;
  readonly acceptanceKeys: ReadonlyMap<string, KeyObject>;
}
