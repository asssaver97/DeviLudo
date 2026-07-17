import type {
  DeliverySignalWithoutId,
  WorkflowJobHandler,
} from "../../temporal/src/job-processor";
import type { ClaimedWorkflowJob } from "../../temporal/src/postgres-queue";
import type { SteamTargetPlatform } from "./contracts";

export interface SteamPrivateBetaWorkflowPort {
  upload(input: SteamWorkflowBinding & {
    readonly mainCommitSha: string;
    readonly mainEvidenceBundleId: string;
    readonly mfaApprovalId: string;
    readonly targetMatrix: readonly SteamTargetPlatform[];
  }): Promise<{ readonly buildId: string; readonly receiptId: string }>;
}

export interface SteamDefaultBranchWorkflowPort {
  publish(input: SteamWorkflowBinding & {
    readonly betaBuildId: string;
    readonly externalApprovalIds: readonly string[];
  }): Promise<{
    readonly releaseId: string;
    /** SetLive promotes the same tested BuildID; it must not create another build. */
    readonly defaultBranchBuildId: string;
    readonly receiptId: string;
  }>;
}

interface SteamWorkflowBinding {
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly workflowId: string;
}

export class SteamPublisherWorkflowHandler implements WorkflowJobHandler {
  constructor(
    private readonly beta: SteamPrivateBetaWorkflowPort,
    private readonly release: SteamDefaultBranchWorkflowPort,
  ) {}

  async execute(job: ClaimedWorkflowJob, context: { readonly heartbeat: () => Promise<string> }): Promise<{
    readonly result: Readonly<Record<string, unknown>>;
    readonly signal: DeliverySignalWithoutId;
  }> {
    if (job.destination !== "steam-publisher" || job.request.kind !== "COMMAND") {
      throw new Error("Steam workflow job destination is invalid");
    }
    const snapshot = job.request.payload.snapshot;
    const base: SteamWorkflowBinding = Object.freeze({
      operationKey: `workflow-job:${job.id}`,
      requestDigest: job.requestDigest,
      tenantId: job.tenantId,
      projectId: job.projectId,
      workflowId: job.workflowId,
    });
    if (job.operation === "UPLOAD_AND_ACTIVATE_PRIVATE_BETA") {
      if (snapshot.state !== "STEAM_PRIVATE_BETA" || !snapshot.mainCommitSha
        || !snapshot.mainEvidenceBundleId || !snapshot.mfaApprovalId) {
        throw new Error("Steam private Beta workflow binding is incomplete");
      }
      await context.heartbeat();
      const receipt = await this.beta.upload({
        ...base,
        mainCommitSha: snapshot.mainCommitSha,
        mainEvidenceBundleId: snapshot.mainEvidenceBundleId,
        mfaApprovalId: snapshot.mfaApprovalId,
        targetMatrix: validateMatrix(snapshot.targetMatrix),
      });
      validateOpaqueId(receipt.receiptId, "Steam private Beta receipt");
      validateBuildId(receipt.buildId);
      return Object.freeze({
        result: Object.freeze({ receiptId: receipt.receiptId, buildId: receipt.buildId }),
        signal: Object.freeze({ type: "BETA_ACTIVATED", buildId: receipt.buildId }),
      });
    }
    if (job.operation === "PUBLISH_STEAM_DEFAULT_BRANCH") {
      if (snapshot.state !== "READY_TO_PUBLISH" || !snapshot.steamBuildId
        || snapshot.externalGate !== null || snapshot.externalApprovals.length !== 3) {
        throw new Error("Steam default branch workflow binding is incomplete");
      }
      const gates = snapshot.externalApprovals.map((entry) => entry.gate);
      if (gates.join(",") !== "VALVE_REVIEW,FIRST_RELEASE,DEFAULT_BRANCH_CONFIRMATION") {
        throw new Error("Steam external approval order is invalid");
      }
      await context.heartbeat();
      const receipt = await this.release.publish({
        ...base,
        betaBuildId: snapshot.steamBuildId,
        externalApprovalIds: Object.freeze(snapshot.externalApprovals.map((entry) => entry.approvalId)),
      });
      validateOpaqueId(receipt.receiptId, "Steam release receipt");
      validateOpaqueId(receipt.releaseId, "Steam release");
      validateBuildId(receipt.defaultBranchBuildId);
      if (receipt.defaultBranchBuildId !== snapshot.steamBuildId) {
        throw new Error("Steam default branch did not promote the tested BuildID");
      }
      return Object.freeze({
        result: Object.freeze({
          receiptId: receipt.receiptId,
          releaseId: receipt.releaseId,
          defaultBranchBuildId: receipt.defaultBranchBuildId,
        }),
        signal: Object.freeze({
          type: "STEAM_RELEASED",
          releaseId: receipt.releaseId,
          defaultBranchBuildId: receipt.defaultBranchBuildId,
        }),
      });
    }
    throw new Error("Steam workflow operation is unsupported");
  }
}

function validateMatrix(value: readonly string[]): readonly SteamTargetPlatform[] {
  if (!value.length || value.length > 3 || new Set(value).size !== value.length
    || value.some((entry) => !["windows", "linux", "macos"].includes(entry))) {
    throw new Error("Steam workflow target matrix is invalid");
  }
  return Object.freeze([...value]) as readonly SteamTargetPlatform[];
}

function validateBuildId(value: string): void {
  if (!/^\d{1,20}$/.test(value) || value === "0") throw new Error("Steam workflow BuildID is invalid");
}

function validateOpaqueId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`${label} ID is invalid`);
}
