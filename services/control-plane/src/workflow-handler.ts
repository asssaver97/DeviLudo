import type { ExternalApprovalGate } from "../../../lib/orchestration/game-delivery";
import { WorkflowJobError, type WorkflowJobExecutionContext, type WorkflowJobHandler } from "../../temporal/src/job-processor";
import type { ClaimedWorkflowJob } from "../../temporal/src/postgres-queue";
import type { SteamReleasePreparationPort, SteamReleasePreparationReceipt } from "../../steam-publisher/src/postgres-release-lifecycle";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export type ControlPlaneWorkflowAction =
  | "CONTINUE_IDEA_DIALOGUE"
  | "REQUEST_SPEC_APPROVAL"
  | "WAIT_FOR_PROVIDER"
  | "REQUEST_USER_ACCEPTANCE"
  | "REQUEST_FRESH_MFA"
  | "WAIT_FOR_EXTERNAL_APPROVAL"
  | "CANCEL_DELIVERY";

export interface ControlPlaneWorkflowBinding {
  readonly state: string;
  readonly specRevisionId: string | null;
  readonly lockedRunConfigurationId: string | null;
  readonly providerRevisionId: string | null;
  readonly candidateCommitSha: string | null;
  readonly draftPullRequest: number | null;
  readonly evidenceBundleId: string | null;
  readonly mainCommitSha: string | null;
  readonly releaseId: string | null;
  readonly steamBuildId: string | null;
  readonly externalGate: ExternalApprovalGate | null;
  readonly cancellationReason: string | null;
}

export interface ControlPlaneWorkflowActionReceipt {
  readonly receiptId: string;
  readonly actionId: string;
  readonly operation: ControlPlaneWorkflowAction;
  readonly requestDigest: string;
  readonly status: "WAITING" | "ACKNOWLEDGED";
}

/**
 * Persists the user-visible wait/action and arranges an authoritative callback
 * to Temporal. It must never derive a completion signal from browser input.
 */
export interface ControlPlaneWorkflowPort {
  ensureAction(input: {
    readonly operationKey: string;
    readonly requestDigest: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly workflowId: string;
    readonly operation: ControlPlaneWorkflowAction;
    readonly binding: ControlPlaneWorkflowBinding;
    readonly heartbeat: () => Promise<string>;
  }): Promise<ControlPlaneWorkflowActionReceipt>;
}

/**
 * Consumes durable control-plane commands. Successful execution only means the
 * wait/action is registered; state changes still require a separate signed or
 * server-authoritative Temporal signal.
 */
export class ControlPlaneWorkflowHandler implements WorkflowJobHandler {
  constructor(
    private readonly controlPlane: ControlPlaneWorkflowPort,
    private readonly releases: Pick<SteamReleasePreparationPort, "ensure">,
  ) {}

  async execute(job: ClaimedWorkflowJob, context: WorkflowJobExecutionContext): Promise<{
    readonly result: Readonly<Record<string, unknown>>;
  }> {
    if (job.destination !== "control-plane") invalid();
    const operation = actionFor(job);
    let binding = bindingFor(job, operation);
    if (operation === "REQUEST_FRESH_MFA") {
      const snapshot = job.request.payload.snapshot;
      const prepared = await this.releases.ensure({
        tenantId: job.tenantId,
        projectId: job.projectId,
        workflowId: job.workflowId,
        runId: requiredId(snapshot.runId),
        mainCommitSha: requiredSha(snapshot.mainCommitSha),
        mainEvidenceBundleId: requiredId(snapshot.mainEvidenceBundleId),
        targetMatrix: validateTargetMatrix(snapshot.targetMatrix),
      });
      validateReleasePreparation(prepared, job, snapshot);
      binding = Object.freeze({ ...binding, releaseId: prepared.releaseId });
    }
    const receipt = await this.controlPlane.ensureAction({
      operationKey: `workflow-job:${job.id}`,
      requestDigest: job.requestDigest,
      tenantId: job.tenantId,
      projectId: job.projectId,
      workflowId: job.workflowId,
      operation,
      binding,
      heartbeat: context.heartbeat,
    });
    validateReceipt(receipt, operation, job.requestDigest);
    return Object.freeze({ result: Object.freeze({ ...receipt, binding: Object.freeze({ ...binding }) }) });
  }
}

function actionFor(job: ClaimedWorkflowJob): ControlPlaneWorkflowAction {
  if (job.request.kind === "CANCEL") {
    if (job.operation !== "CANCEL_DELIVERY") invalid();
    return "CANCEL_DELIVERY";
  }
  if (job.operation === "CONTINUE_IDEA_DIALOGUE"
    || job.operation === "REQUEST_SPEC_APPROVAL"
    || job.operation === "WAIT_FOR_PROVIDER"
    || job.operation === "REQUEST_USER_ACCEPTANCE"
    || job.operation === "REQUEST_FRESH_MFA"
    || job.operation === "WAIT_FOR_EXTERNAL_APPROVAL") return job.operation;
  return invalid();
}

function bindingFor(job: ClaimedWorkflowJob, operation: ControlPlaneWorkflowAction): ControlPlaneWorkflowBinding {
  const snapshot = job.request.payload.snapshot;
  const expectedState = {
    CONTINUE_IDEA_DIALOGUE: "IDEATION",
    REQUEST_SPEC_APPROVAL: "WAITING_SPEC_APPROVAL",
    WAIT_FOR_PROVIDER: "WAITING_PROVIDER",
    REQUEST_USER_ACCEPTANCE: "WAITING_USER_ACCEPTANCE",
    REQUEST_FRESH_MFA: "WAITING_MFA",
    WAIT_FOR_EXTERNAL_APPROVAL: "EXTERNAL_APPROVAL_REQUIRED",
    CANCEL_DELIVERY: "CANCELLED",
  } as const satisfies Record<ControlPlaneWorkflowAction, string>;
  if (snapshot.state !== expectedState[operation]) invalid();

  let specRevisionId: string | null = null;
  let lockedRunConfigurationId: string | null = null;
  let providerRevisionId: string | null = null;
  let candidateCommitSha: string | null = null;
  let draftPullRequest: number | null = null;
  let evidenceBundleId: string | null = null;
  let mainCommitSha: string | null = null;
  const releaseId: string | null = null;
  let steamBuildId: string | null = null;
  let externalGate: ExternalApprovalGate | null = null;
  let cancellationReason: string | null = null;

  if (operation === "REQUEST_SPEC_APPROVAL") {
    specRevisionId = requiredId(snapshot.specRevisionId);
  } else if (operation === "WAIT_FOR_PROVIDER") {
    lockedRunConfigurationId = requiredId(snapshot.lockedRunConfigurationId);
    providerRevisionId = requiredId(snapshot.waitingProviderRevisionId);
  } else if (operation === "REQUEST_USER_ACCEPTANCE") {
    specRevisionId = requiredId(snapshot.specRevisionId);
    candidateCommitSha = requiredSha(snapshot.candidateCommitSha);
    draftPullRequest = requiredPullRequest(snapshot.draftPullRequest);
    evidenceBundleId = requiredId(snapshot.candidateEvidenceBundleId);
  } else if (operation === "REQUEST_FRESH_MFA") {
    mainCommitSha = requiredSha(snapshot.mainCommitSha);
    evidenceBundleId = requiredId(snapshot.mainEvidenceBundleId);
  } else if (operation === "WAIT_FOR_EXTERNAL_APPROVAL") {
    steamBuildId = requiredBuildId(snapshot.steamBuildId);
    evidenceBundleId = requiredId(snapshot.steamInstallEvidenceBundleId);
    externalGate = requiredExternalGate(snapshot.externalGate);
  } else if (operation === "CANCEL_DELIVERY") {
    if (job.request.kind !== "CANCEL") invalid();
    const last = snapshot.history.at(-1)?.signal;
    if (!last || last.type !== "CANCEL" || last.reason !== job.request.payload.reason) invalid();
    cancellationReason = validReason(job.request.payload.reason);
  }

  return Object.freeze({
    state: snapshot.state,
    specRevisionId,
    lockedRunConfigurationId,
    providerRevisionId,
    candidateCommitSha,
    draftPullRequest,
    evidenceBundleId,
    mainCommitSha,
    releaseId,
    steamBuildId,
    externalGate,
    cancellationReason,
  });
}

function validateReleasePreparation(
  receipt: SteamReleasePreparationReceipt,
  job: ClaimedWorkflowJob,
  snapshot: ClaimedWorkflowJob["request"]["payload"]["snapshot"],
): void {
  if (!UUID.test(receipt.releaseId) || receipt.workflowId !== job.workflowId
    || receipt.runId !== snapshot.runId || receipt.mainCommitSha !== snapshot.mainCommitSha
    || receipt.mainEvidenceBundleId !== snapshot.mainEvidenceBundleId
    || !UUID.test(receipt.releaseConfigurationId) || receipt.state !== "WAITING_MFA"
    || JSON.stringify(receipt.targetMatrix) !== JSON.stringify(snapshot.targetMatrix)) invalid();
}

function validateTargetMatrix(value: readonly string[]): readonly ("windows" | "linux" | "macos")[] {
  if (!value.length || value.length > 3 || new Set(value).size !== value.length
    || value.some((entry) => entry !== "windows" && entry !== "linux" && entry !== "macos")
    || JSON.stringify([...value].sort()) !== JSON.stringify(value)) invalid();
  return Object.freeze([...value]) as readonly ("windows" | "linux" | "macos")[];
}

function validateReceipt(
  receipt: ControlPlaneWorkflowActionReceipt,
  operation: ControlPlaneWorkflowAction,
  requestDigest: string,
): void {
  const expectedStatus = operation === "CANCEL_DELIVERY" ? "ACKNOWLEDGED" : "WAITING";
  if (!SAFE_ID.test(receipt.receiptId) || !SAFE_ID.test(receipt.actionId)
    || receipt.operation !== operation || receipt.requestDigest !== requestDigest
    || !SHA256.test(receipt.requestDigest) || receipt.status !== expectedStatus) {
    throw new WorkflowJobError("CONTROL_PLANE_RECEIPT_DRIFT", true);
  }
}

function requiredId(value: string | null): string {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

function requiredSha(value: string | null): string {
  if (!value || !SHA1.test(value)) invalid();
  return value;
}

function requiredPullRequest(value: number | null): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}

function requiredBuildId(value: string | null): string {
  if (!value || !/^\d{1,20}$/.test(value) || value === "0") invalid();
  return value;
}

function requiredExternalGate(value: ExternalApprovalGate | null): ExternalApprovalGate {
  if (value !== "VALVE_REVIEW" && value !== "FIRST_RELEASE" && value !== "DEFAULT_BRANCH_CONFIRMATION") invalid();
  return value;
}

function validReason(value: string): string {
  if (!value.trim() || value.length > 2_000 || /\0/.test(value)) invalid();
  return value;
}

function invalid(): never {
  throw new WorkflowJobError("CONTROL_PLANE_BINDING_INVALID", true);
}
