import {
  type DeliverySignalWithoutId,
  type WorkflowJobExecutionContext,
  type WorkflowJobHandler,
} from "../../temporal/src/job-processor";
import type { ClaimedWorkflowJob } from "../../temporal/src/postgres-queue";
import { assertPinnedModelId } from "../../../lib/agent/providers";
import { validateAgentFailureDiagnostic } from "../../../lib/agent/failure-diagnostics";
import type { AgentFailureDiagnostic } from "../../../lib/agent/types";
import { validateAgentCodeReviewReceipt, type AgentCodeReviewReceipt } from "../../../lib/agent/code-review";
import { WorkflowJobCancelledError } from "../../temporal/src/job-cancellation";
import { AgentExecutionCancelledError } from "./workflow-errors";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256_IMAGE = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface AgentWorkflowRunReceipt {
  readonly status: "COMPLETED" | "FAILED";
  readonly runId: string;
  readonly lockedRunConfigurationId: string;
  readonly agent: "claude-code" | "codex-cli";
  readonly profileRevisionId: string;
  readonly installationId: string;
  readonly imageDigest: string;
  readonly providerRevisionId: string;
  readonly model: string;
  readonly candidateCommitSha: string | null;
  readonly draftPullRequest: number | null;
  readonly codeReviewReceipt: AgentCodeReviewReceipt | null;
  readonly diagnosticId: string | null;
  readonly diagnostic?: AgentFailureDiagnostic | null;
  readonly receiptId: string;
}

export interface AgentWorkflowRun {
  readonly runId: string;
  readonly providerRevisionId: string;
  /** Starts completion polling only after AGENT_STARTED is durably signaled. */
  complete(): Promise<AgentWorkflowRunReceipt>;
}

export interface LockedAgentWorkflowPort {
  start(input: {
    readonly operationKey: string;
    readonly requestDigest: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly workflowId: string;
    readonly lockedRunConfigurationId: string;
    readonly expectedRunId: string | null;
    readonly iteration: number;
    readonly repairAttempts: number;
    readonly heartbeat: () => Promise<string>;
  }): Promise<AgentWorkflowRun>;
}

export class AgentProviderUnavailableError extends Error {
  constructor(readonly providerRevisionId: string) {
    super("Agent Provider is unavailable");
    if (!ID.test(providerRevisionId)) throw new Error("Provider revision ID is invalid");
  }
}

export class AgentWorkerWorkflowHandler implements WorkflowJobHandler {
  constructor(private readonly runs: LockedAgentWorkflowPort) {}

  async execute(job: ClaimedWorkflowJob, context: WorkflowJobExecutionContext): Promise<{
    readonly result: Readonly<Record<string, unknown>>;
    readonly signal?: DeliverySignalWithoutId;
  }> {
    if (job.destination !== "agent-worker" || job.operation !== "START_LOCKED_AGENT_RUN"
      || job.request.kind !== "COMMAND") throw new Error("Agent workflow operation is invalid");
    const snapshot = job.request.payload.snapshot;
    if (snapshot.state !== "DEVELOPMENT_QUEUED" || !snapshot.lockedRunConfigurationId) {
      throw new Error("Agent workflow lock binding is incomplete");
    }

    let run: AgentWorkflowRun;
    try {
      run = await this.runs.start({
        operationKey: `workflow-job:${job.id}`,
        requestDigest: job.requestDigest,
        tenantId: job.tenantId,
        projectId: job.projectId,
        workflowId: job.workflowId,
        lockedRunConfigurationId: snapshot.lockedRunConfigurationId,
        expectedRunId: snapshot.runId,
        iteration: snapshot.iteration,
        repairAttempts: snapshot.repairAttempts,
        heartbeat: context.heartbeat,
      });
    } catch (error) {
      if (error instanceof AgentProviderUnavailableError) {
        await context.emitSignal("provider-unavailable", {
          type: "PROVIDER_UNAVAILABLE",
          providerRevisionId: error.providerRevisionId,
        });
        return providerWaitResult(snapshot.lockedRunConfigurationId, error.providerRevisionId, null);
      }
      if (error instanceof AgentExecutionCancelledError) {
        assertCancellationBinding(error, snapshot.lockedRunConfigurationId, null);
        throw new WorkflowJobCancelledError(job.tenantId, job.id);
      }
      throw error;
    }
    validateOpaqueId(run.runId, "Agent run");
    validateOpaqueId(run.providerRevisionId, "Provider revision");
    if (snapshot.runId !== null && run.runId !== snapshot.runId) {
      throw new Error("Agent workflow recovery run binding is invalid");
    }
    await context.emitSignal("started", { type: "AGENT_STARTED", runId: run.runId });
    await context.heartbeat();

    let receipt: AgentWorkflowRunReceipt;
    try {
      receipt = await run.complete();
    } catch (error) {
      if (error instanceof AgentProviderUnavailableError) {
        await context.emitSignal("provider-unavailable", {
          type: "PROVIDER_UNAVAILABLE",
          providerRevisionId: error.providerRevisionId,
        });
        return providerWaitResult(snapshot.lockedRunConfigurationId, error.providerRevisionId, run.runId);
      }
      if (error instanceof AgentExecutionCancelledError) {
        assertCancellationBinding(error, run.runId, run.providerRevisionId);
        throw new WorkflowJobCancelledError(job.tenantId, job.id);
      }
      throw error;
    }
    validateReceipt(receipt, run, snapshot.lockedRunConfigurationId);
    if (receipt.status === "FAILED") {
      return Object.freeze({
        result: publicReceipt(receipt),
        signal: Object.freeze({ type: "AGENT_FAILED", diagnosticId: receipt.diagnosticId as string }),
      });
    }
    return Object.freeze({
      result: publicReceipt(receipt),
      signal: Object.freeze({
        type: "AGENT_COMPLETED",
        candidateCommitSha: receipt.candidateCommitSha as string,
        draftPullRequest: receipt.draftPullRequest as number,
        codeReviewReceiptId: (receipt.codeReviewReceipt as AgentCodeReviewReceipt).receiptId,
        codeReviewDigest: (receipt.codeReviewReceipt as AgentCodeReviewReceipt).reviewDigest,
      }),
    });
  }
}

function providerWaitResult(
  lockedRunConfigurationId: string,
  providerRevisionId: string,
  runId: string | null,
): { readonly result: Readonly<Record<string, unknown>> } {
  return Object.freeze({
    result: Object.freeze({
      status: "WAITING_PROVIDER",
      lockedRunConfigurationId,
      providerRevisionId,
      runId,
    }),
  });
}

function assertCancellationBinding(
  error: AgentExecutionCancelledError,
  runId: string,
  providerRevisionId: string | null,
): void {
  if (error.runId !== runId || providerRevisionId !== null && error.providerRevisionId !== providerRevisionId) {
    throw new Error("Agent cancellation binding is invalid");
  }
}

function validateReceipt(receipt: AgentWorkflowRunReceipt, run: AgentWorkflowRun, lockedId: string): void {
  if (receipt.runId !== run.runId || receipt.lockedRunConfigurationId !== lockedId
    || receipt.providerRevisionId !== run.providerRevisionId
    || ![receipt.profileRevisionId, receipt.installationId, receipt.receiptId].every(ID.test.bind(ID))
    || !["COMPLETED", "FAILED"].includes(receipt.status)
    || !["claude-code", "codex-cli"].includes(receipt.agent)
    || !SHA256_IMAGE.test(receipt.imageDigest) || !validModel(receipt.model)) {
    throw new Error("Agent workflow receipt lock binding is invalid");
  }
  if (receipt.status === "COMPLETED") {
    const review = validateAgentCodeReviewReceipt(receipt.codeReviewReceipt);
    if (!receipt.candidateCommitSha || !SHA1.test(receipt.candidateCommitSha)
      || !Number.isSafeInteger(receipt.draftPullRequest) || (receipt.draftPullRequest as number) < 1
      || review.runId !== receipt.runId || review.profileRevisionId !== receipt.profileRevisionId
      || review.installationId !== receipt.installationId || review.imageDigest !== receipt.imageDigest
      || review.model !== receipt.model
      || receipt.diagnosticId !== null || receipt.diagnostic !== null && receipt.diagnostic !== undefined) {
      throw new Error("Completed Agent workflow receipt is invalid");
    }
  } else if (!receipt.diagnosticId || !ID.test(receipt.diagnosticId)
    || receipt.candidateCommitSha !== null || receipt.draftPullRequest !== null
    || receipt.codeReviewReceipt !== null) {
    throw new Error("Failed Agent workflow receipt is invalid");
  } else if (receipt.diagnostic !== null && receipt.diagnostic !== undefined) {
    const diagnostic = validateAgentFailureDiagnostic(receipt.diagnostic);
    if (diagnostic.diagnosticId !== receipt.diagnosticId || diagnostic.runId !== receipt.runId) {
      throw new Error("Failed Agent workflow diagnostic binding is invalid");
    }
  }
}

function validModel(value: string): boolean {
  if (value.length > 512) return false;
  try {
    assertPinnedModelId(value);
    return true;
  } catch {
    return false;
  }
}

function publicReceipt(receipt: AgentWorkflowRunReceipt): Readonly<Record<string, unknown>> {
  return Object.freeze({
    receiptId: receipt.receiptId,
    runId: receipt.runId,
    status: receipt.status,
    agent: receipt.agent,
    profileRevisionId: receipt.profileRevisionId,
    installationId: receipt.installationId,
    imageDigest: receipt.imageDigest,
    providerRevisionId: receipt.providerRevisionId,
    model: receipt.model,
    candidateCommitSha: receipt.candidateCommitSha,
    draftPullRequest: receipt.draftPullRequest,
    codeReviewReceipt: receipt.codeReviewReceipt,
    diagnosticId: receipt.diagnosticId,
    diagnostic: receipt.diagnostic ?? null,
  });
}

function validateOpaqueId(value: string, label: string): void {
  if (!ID.test(value)) throw new Error(`${label} ID is invalid`);
}
