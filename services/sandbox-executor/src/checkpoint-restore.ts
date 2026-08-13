export type AgentCheckpointRestoreInput = Readonly<{
  checkpoint: Readonly<{
    state: "PARTIAL" | "AGENT_COMPLETE";
    originJobId: string | null;
    specificationDigest: string | null;
    sourceDigest: string | null;
    localDirectoryBaseDigest: string | null;
    digest: string;
  }>;
  jobId: string;
  specificationDigest: string | null;
  inputSourceDigest: string | null;
  localDirectoryBaseDigest: string | null;
}>;

export type AgentCheckpointRestoreDecision = Readonly<{
  action: "RESTORE" | "DISCARD_STALE" | "REJECT_CURRENT_JOB";
  reason?: string;
}>;

/**
 * A workflow has one checkpoint slot, while every manual stage rerun creates a
 * new job. A checkpoint from an older job is useful only while its frozen
 * inputs still match. Once those inputs change it must not permanently poison
 * the workflow; only a checkpoint written by the current job may report a
 * concurrent-change conflict.
 */
export function decideAgentCheckpointRestore(input: AgentCheckpointRestoreInput): AgentCheckpointRestoreDecision {
  const { checkpoint } = input;
  let reason: string | undefined;

  if (checkpoint.specificationDigest && checkpoint.specificationDigest !== input.specificationDigest) {
    reason = "Agent checkpoint specification changed; refusing to restore stale source";
  } else if (!input.localDirectoryBaseDigest
    && checkpoint.sourceDigest
    && input.inputSourceDigest
    && checkpoint.sourceDigest !== input.inputSourceDigest) {
    reason = "Agent checkpoint source revision changed; refusing to restore stale source";
  } else if (input.localDirectoryBaseDigest && checkpoint.localDirectoryBaseDigest) {
    const completedForThisJob = checkpoint.state === "AGENT_COMPLETE"
      && checkpoint.originJobId === input.jobId;
    const acceptedDigests = completedForThisJob
      ? [checkpoint.localDirectoryBaseDigest, checkpoint.digest]
      : [checkpoint.localDirectoryBaseDigest];
    if (!acceptedDigests.includes(input.localDirectoryBaseDigest)) {
      reason = "LOCAL_PROJECT_CHANGED: Local project changed after the Agent checkpoint was created";
    }
  }

  if (!reason) return { action: "RESTORE" };
  return checkpoint.originJobId === input.jobId
    ? { action: "REJECT_CURRENT_JOB", reason }
    : { action: "DISCARD_STALE", reason };
}
