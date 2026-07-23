export interface LocalScmBinding {
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly specRevisionId: string;
  readonly workspaceRoot: string;
}

export interface PreparedLocalRepository {
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly specRevisionId: string;
  readonly baseBranch: "main";
  readonly baseCommitSha: string;
  readonly preparedAt: string;
}

export interface LocalScmCandidateReceipt {
  readonly scmProxy: "local-git-proxy-v1";
  readonly branch: string;
  readonly commitSha: string;
  readonly sourceDigest: string;
  readonly changedFiles: readonly string[];
  readonly draftPullRequest: null;
  readonly baseCommitSha: string;
  readonly createdAt: string;
}

export interface FinalizeLocalCandidateRequest extends LocalScmBinding {
  readonly expectedBaseCommitSha: string;
  readonly candidateBranch: string;
  readonly commitMessage: string;
}

export interface MergeLocalCandidateRequest extends LocalScmBinding {
  readonly expectedCandidateCommitSha: string;
  readonly expectedSourceDigest: string;
}

export interface LocalScmMergeReceipt {
  readonly scmProxy: "local-git-proxy-v1";
  readonly branch: "main";
  readonly candidateBranch: string;
  readonly baseCommitSha: string;
  readonly candidateCommitSha: string;
  readonly mainCommitSha: string;
  readonly sourceDigest: string;
  readonly mergedAt: string;
}
