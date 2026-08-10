export type LocalGitCommitOutcome = "COMMITTED" | "NO_CHANGES" | "NOT_GIT";

export function commitVerifiedGitDirectory(input: Readonly<{
  directory: string;
  workflowId: string;
  iterationNumber: number;
  sourcePaths: readonly string[];
  includePath(path: string): boolean;
  verifySource(): Promise<unknown>;
}>): Promise<Readonly<{
  outcome: LocalGitCommitOutcome;
  commitHash: string | null;
  branch: string | null;
}>>;
