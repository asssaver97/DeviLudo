import type { WorkflowActionCompletionPort } from "../../control-plane/src/workflow-action-completion-postgres";
import {
  parseSteamExternalApprovalAttestation,
  type SteamExternalApprovalAttestation,
  type SteamExternalApprovalReceipt,
} from "./contracts";

export interface SteamExternalApprovalClaim {
  readonly claimToken: string;
  readonly requestDigest: string;
  readonly verifierSubject: string;
  readonly attestation: SteamExternalApprovalAttestation;
  readonly workflowId: string;
  readonly signalId: string;
}

export interface SteamExternalApprovalStore {
  begin(input: {
    readonly attestation: SteamExternalApprovalAttestation;
    readonly verifierSubject: string;
  }): Promise<
    | { readonly kind: "CLAIMED"; readonly claim: SteamExternalApprovalClaim }
    | { readonly kind: "BUSY" }
    | { readonly kind: "COMPLETED"; readonly receipt: SteamExternalApprovalReceipt }
  >;
  complete(claim: SteamExternalApprovalClaim, delivery: Awaited<ReturnType<WorkflowActionCompletionPort["complete"]>>): Promise<SteamExternalApprovalReceipt>;
  release(claim: SteamExternalApprovalClaim): Promise<void>;
  probe(): Promise<void>;
}

export class SteamExternalApprovalConflict extends Error {
  constructor(readonly code: "STEAM_EXTERNAL_APPROVAL_BUSY" | "STEAM_EXTERNAL_APPROVAL_CONFLICT") {
    super("Steam external approval could not be accepted");
  }
}

/** Converts one mTLS-authenticated Steam verifier observation into a bound workflow signal. */
export class SteamExternalApprovalService {
  constructor(
    private readonly store: SteamExternalApprovalStore,
    private readonly completions: WorkflowActionCompletionPort,
  ) {}

  async approve(value: unknown, verifierSubject: string): Promise<SteamExternalApprovalReceipt> {
    const attestation = parseSteamExternalApprovalAttestation(value);
    const outcome = await this.store.begin({ attestation, verifierSubject });
    if (outcome.kind === "COMPLETED") return Object.freeze({ ...outcome.receipt, replayed: true });
    if (outcome.kind === "BUSY") throw new SteamExternalApprovalConflict("STEAM_EXTERNAL_APPROVAL_BUSY");
    const { claim } = outcome;
    try {
      const delivery = await this.completions.complete({
        tenantId: claim.attestation.tenantId,
        projectId: claim.attestation.projectId,
        workflowId: claim.workflowId,
        actionId: claim.attestation.actionId,
        source: "STEAM_APPROVAL_MONITOR",
        sourceReceiptId: claim.attestation.operationKey,
        signal: Object.freeze({
          signalId: claim.signalId,
          type: "EXTERNAL_APPROVED" as const,
          gate: claim.attestation.gate,
          approvalId: claim.attestation.approvalId,
        }),
      });
      return await this.store.complete(claim, delivery);
    } catch (error) {
      await this.store.release(claim).catch(() => undefined);
      throw error;
    }
  }

  async probe(): Promise<void> { await this.store.probe(); }
}
