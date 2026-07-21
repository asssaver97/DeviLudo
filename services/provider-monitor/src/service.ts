import type { ProviderProbeConfiguration } from "../../control-plane/src/provider-probe";
import type { WorkflowActionCompletionPort } from "../../control-plane/src/workflow-action-completion-postgres";
import {
  parseProviderRecoveryRequest,
  providerProbeDigest,
  type ProviderRecoveryAuthority,
  type ProviderRecoveryReceipt,
  type ProviderRecoveryRequest,
} from "./contracts";

export interface ProviderRecoveryClaim extends ProviderRecoveryAuthority {
  readonly claimToken: string;
  readonly requestDigest: string;
  readonly request: ProviderRecoveryRequest;
  readonly schedulerSubject: string;
  readonly signalId: string;
}

export interface ProviderRecoveryStore {
  begin(input: { readonly request: ProviderRecoveryRequest; readonly schedulerSubject: string }): Promise<
    | { readonly kind: "CLAIMED"; readonly claim: ProviderRecoveryClaim }
    | { readonly kind: "BUSY" }
    | { readonly kind: "COMPLETED"; readonly receipt: ProviderRecoveryReceipt }
  >;
  complete(input: {
    readonly claim: ProviderRecoveryClaim;
    readonly probeDigest: string;
    readonly probedAt: string;
    readonly delivery: Awaited<ReturnType<WorkflowActionCompletionPort["complete"]>>;
  }): Promise<ProviderRecoveryReceipt>;
  release(claim: ProviderRecoveryClaim): Promise<void>;
  probe(): Promise<void>;
}

export interface ProviderRecoveryProbe {
  run(provider: ProviderProbeConfiguration): Promise<Readonly<Record<string, "PASS" | "FAIL">>>;
}

export class ProviderRecoveryConflict extends Error {
  constructor(readonly code: "PROVIDER_RECOVERY_BUSY" | "PROVIDER_RECOVERY_CONFLICT") {
    super("Provider recovery check could not be completed");
  }
}

/** Probes only the immutable Provider binding derived by the RLS store. */
export class ProviderRecoveryService {
  constructor(
    private readonly store: ProviderRecoveryStore,
    private readonly providerProbe: ProviderRecoveryProbe,
    private readonly completions: WorkflowActionCompletionPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async check(value: unknown, schedulerSubject: string): Promise<ProviderRecoveryReceipt> {
    const request = parseProviderRecoveryRequest(value);
    const outcome = await this.store.begin({ request, schedulerSubject });
    if (outcome.kind === "COMPLETED") return Object.freeze({ ...outcome.receipt, replayed: true });
    if (outcome.kind === "BUSY") throw new ProviderRecoveryConflict("PROVIDER_RECOVERY_BUSY");
    const { claim } = outcome;
    try {
      const checks = await this.providerProbe.run(claim.provider);
      if (Object.values(checks).some((result) => result !== "PASS")) {
        throw new ProviderRecoveryConflict("PROVIDER_RECOVERY_CONFLICT");
      }
      const probedAt = exactDate(this.now()).toISOString();
      const delivery = await this.completions.complete({
        tenantId: claim.request.tenantId,
        projectId: claim.request.projectId,
        workflowId: claim.workflowId,
        actionId: claim.request.actionId,
        source: "PROVIDER_MONITOR",
        sourceReceiptId: claim.request.operationKey,
        signal: Object.freeze({
          signalId: claim.signalId,
          type: "PROVIDER_RESTORED" as const,
          providerRevisionId: claim.provider.id,
        }),
      });
      return await this.store.complete({
        claim, probeDigest: providerProbeDigest(checks), probedAt, delivery,
      });
    } catch (error) {
      await this.store.release(claim).catch(() => undefined);
      throw error;
    }
  }

  async probe(): Promise<void> { await this.store.probe(); }
}

function exactDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new Error("Provider recovery clock is invalid");
  return value;
}
