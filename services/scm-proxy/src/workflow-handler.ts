import type { DeliverySignalWithoutId, WorkflowJobExecutionContext, WorkflowJobHandler } from "../../temporal/src/job-processor";
import type { ClaimedWorkflowJob } from "../../temporal/src/postgres-queue";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface ScmMergeWorkflowReceipt {
  readonly receiptId: string;
  readonly runId: string;
  readonly candidateCommitSha: string;
  readonly pullRequestNumber: number;
  readonly evidenceBundleId: string;
  readonly acceptanceSignalId: string;
  readonly mergeCommitSha: string;
  readonly defaultBranchHeadSha: string;
  readonly mainSourceDigest: string;
  readonly requiresFreshMainSnapshot: boolean;
}

/**
 * Trusted adapter that resolves the immutable repository binding, candidate
 * receipt, evidence manifest and signed user acceptance from server-side
 * stores. None of those authoritative objects are accepted from a browser.
 */
export interface ScmMergeWorkflowPort {
  mergeAcceptedCandidate(input: {
    readonly operationKey: string;
    readonly requestDigest: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly specRevisionId: string;
    readonly candidateCommitSha: string;
    readonly pullRequestNumber: number;
    readonly evidenceBundleId: string;
    readonly acceptanceSignalId: string;
    readonly heartbeat: () => Promise<string>;
  }): Promise<ScmMergeWorkflowReceipt>;
}

/** Maps the durable MERGING command to the SCM proxy and emits the actual main head. */
export class ScmProxyWorkflowHandler implements WorkflowJobHandler {
  constructor(private readonly scm: ScmMergeWorkflowPort) {}

  async execute(job: ClaimedWorkflowJob, context: WorkflowJobExecutionContext): Promise<{
    readonly result: Readonly<Record<string, unknown>>;
    readonly signal: DeliverySignalWithoutId;
  }> {
    if (job.destination !== "scm-proxy" || job.operation !== "MERGE_DRAFT_PULL_REQUEST"
      || job.request.kind !== "COMMAND") throw new Error("SCM workflow destination is invalid");
    const snapshot = job.request.payload.snapshot;
    if (snapshot.state !== "MERGING" || !snapshot.specRevisionId || !validId(snapshot.specRevisionId)
      || !snapshot.runId || !validId(snapshot.runId)
      || !snapshot.candidateCommitSha || !SHA1.test(snapshot.candidateCommitSha)
      || !Number.isSafeInteger(snapshot.draftPullRequest) || (snapshot.draftPullRequest as number) < 1
      || !snapshot.candidateEvidenceBundleId || !validId(snapshot.candidateEvidenceBundleId)) {
      throw new Error("SCM workflow merge binding is invalid");
    }
    const acceptance = snapshot.history.at(-1)?.signal;
    if (!acceptance || acceptance.type !== "USER_ACCEPTED" || !validId(acceptance.signalId)) {
      throw new Error("SCM workflow lacks the authoritative user acceptance binding");
    }
    const receipt = await this.scm.mergeAcceptedCandidate({
      operationKey: `workflow-job:${job.id}`,
      requestDigest: job.requestDigest,
      tenantId: job.tenantId,
      projectId: job.projectId,
      workflowId: job.workflowId,
      runId: snapshot.runId,
      specRevisionId: snapshot.specRevisionId,
      candidateCommitSha: snapshot.candidateCommitSha,
      pullRequestNumber: snapshot.draftPullRequest as number,
      evidenceBundleId: snapshot.candidateEvidenceBundleId,
      acceptanceSignalId: acceptance.signalId,
      heartbeat: context.heartbeat,
    });
    validateReceipt(receipt, {
      runId: snapshot.runId,
      candidateCommitSha: snapshot.candidateCommitSha,
      pullRequestNumber: snapshot.draftPullRequest as number,
      evidenceBundleId: snapshot.candidateEvidenceBundleId,
      acceptanceSignalId: acceptance.signalId,
    });
    return Object.freeze({
      result: Object.freeze({ ...receipt }),
      signal: Object.freeze({ type: "MAIN_MERGED", mainCommitSha: receipt.defaultBranchHeadSha }),
    });
  }
}

function validateReceipt(
  receipt: ScmMergeWorkflowReceipt,
  expected: Pick<ScmMergeWorkflowReceipt, "runId" | "candidateCommitSha" | "pullRequestNumber" | "evidenceBundleId" | "acceptanceSignalId">,
): void {
  if (!RECEIPT_ID.test(receipt.receiptId)
    || receipt.runId !== expected.runId
    || receipt.candidateCommitSha !== expected.candidateCommitSha
    || receipt.pullRequestNumber !== expected.pullRequestNumber
    || receipt.evidenceBundleId !== expected.evidenceBundleId
    || receipt.acceptanceSignalId !== expected.acceptanceSignalId
    || !SHA1.test(receipt.mergeCommitSha)
    || !SHA1.test(receipt.defaultBranchHeadSha)
    || !SHA256.test(receipt.mainSourceDigest)
    || receipt.requiresFreshMainSnapshot !== (receipt.defaultBranchHeadSha !== receipt.mergeCommitSha)) {
    throw new Error("SCM workflow merge receipt binding is invalid");
  }
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
