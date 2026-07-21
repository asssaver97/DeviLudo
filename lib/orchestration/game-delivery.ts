import { deepFreeze, type DeepReadonly, type TargetPlatform } from "@/lib/domain/types";

export type DeliveryState =
  | "IDEATION"
  | "WAITING_SPEC_APPROVAL"
  | "RESOLVING_AGENT_CONFIGURATION"
  | "DEVELOPMENT_QUEUED"
  | "DEVELOPING"
  | "WAITING_PROVIDER"
  | "CROSS_PLATFORM_E2E"
  | "WAITING_USER_ACCEPTANCE"
  | "MERGING"
  | "MAIN_SHA_E2E"
  | "WAITING_MFA"
  | "STEAM_PRIVATE_BETA"
  | "STEAM_INSTALL_E2E"
  | "EXTERNAL_APPROVAL_REQUIRED"
  | "READY_TO_PUBLISH"
  | "RELEASED"
  | "CANCELLED";

export type ExternalApprovalGate =
  | "VALVE_REVIEW"
  | "FIRST_RELEASE"
  | "DEFAULT_BRANCH_CONFIRMATION";

export const DEFAULT_AUTOMATIC_REPAIR_LIMIT = 3;

export type DeliverySignal = Readonly<{ signalId: string }> & (
  | { type: "SPEC_READY"; specRevisionId: string }
  | {
      type: "SPEC_APPROVED";
      approvedSpecRevisionId: string;
      testPlanRevisionId: string;
      approvalReceiptId: string;
    }
  | { type: "RUN_CONFIGURATION_LOCKED"; lockedRunConfigurationId: string }
  | { type: "AGENT_STARTED"; runId: string }
  | { type: "PROVIDER_UNAVAILABLE"; providerRevisionId: string }
  | { type: "PROVIDER_RESTORED"; providerRevisionId: string }
  | { type: "AGENT_COMPLETED"; candidateCommitSha: string; draftPullRequest: number }
  | { type: "AGENT_FAILED"; diagnosticId: string }
  | { type: "E2E_PASSED"; evidenceBundleId: string }
  | { type: "E2E_FAILED"; evidenceBundleId: string; repairPromptId: string }
  | { type: "MAIN_E2E_FAILED"; evidenceBundleId: string; repairPromptId: string }
  | { type: "STEAM_INSTALL_FAILED"; evidenceBundleId: string; repairPromptId: string }
  | { type: "USER_FEEDBACK"; nextSpecRevisionId: string; evidenceInvalidationId: string }
  | { type: "USER_ACCEPTED" }
  | { type: "MAIN_MERGED"; mainCommitSha: string }
  | { type: "RELEASE_PREPARED"; releaseId: string }
  | { type: "MFA_APPROVED"; approvalId: string }
  | { type: "BETA_ACTIVATED"; buildId: string }
  | { type: "STEAM_INSTALL_PASSED"; evidenceBundleId: string }
  | { type: "EXTERNAL_APPROVED"; gate: ExternalApprovalGate; approvalId: string }
  | { type: "STEAM_RELEASED"; releaseId: string; defaultBranchBuildId: string }
  | {
      type: "CANCEL";
      reason: string;
      expectedState: DeliveryState;
      expectedHistoryLength: number;
    }
);

export type DeliveryCommand =
  | "CONTINUE_IDEA_DIALOGUE"
  | "REQUEST_SPEC_APPROVAL"
  | "RESOLVE_AGENT_RUN_CONFIGURATION"
  | "START_LOCKED_AGENT_RUN"
  | "WAIT_FOR_PROVIDER"
  | "START_TARGET_MATRIX_E2E"
  | "REQUEST_USER_ACCEPTANCE"
  | "MERGE_DRAFT_PULL_REQUEST"
  | "START_MAIN_SHA_RELEASE_GATE"
  | "REQUEST_FRESH_MFA"
  | "UPLOAD_AND_ACTIVATE_PRIVATE_BETA"
  | "INSTALL_FROM_CLEAN_STEAM_CLIENT"
  | "WAIT_FOR_EXTERNAL_APPROVAL"
  | "PUBLISH_STEAM_DEFAULT_BRANCH"
  | "NONE";

export type DeliveryRepairContext = Readonly<{
  attempt: number;
  reason: "AGENT_FAILURE" | "E2E_FAILURE" | "MAIN_GATE_FAILURE" | "STEAM_INSTALL_FAILURE";
  fromRunConfigurationId: string;
  diagnosticId: string | null;
  evidenceBundleId: string | null;
  repairPromptId: string | null;
  candidateCommitSha: string | null;
  draftPullRequest: number | null;
}>;

export interface DeliverySnapshot {
  readonly workflowId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly state: DeliveryState;
  readonly specRevisionId: string | null;
  readonly testPlanRevisionId: string | null;
  readonly specApprovalReceiptId: string | null;
  readonly lockedRunConfigurationId: string | null;
  readonly runId: string | null;
  readonly candidateCommitSha: string | null;
  readonly draftPullRequest: number | null;
  readonly mainCommitSha: string | null;
  readonly evidenceBundleId: string | null;
  readonly candidateEvidenceBundleId: string | null;
  readonly mainEvidenceBundleId: string | null;
  readonly steamInstallEvidenceBundleId: string | null;
  readonly mfaApprovalId: string | null;
  readonly steamBuildId: string | null;
  readonly steamReleaseId: string | null;
  readonly defaultBranchBuildId: string | null;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly iteration: number;
  readonly repairAttempts: number;
  readonly repairContext: DeliveryRepairContext | null;
  readonly waitingProviderRevisionId: string | null;
  readonly externalGate: ExternalApprovalGate | null;
  readonly externalApprovals: readonly Readonly<{
    gate: ExternalApprovalGate;
    approvalId: string;
  }>[];
  readonly history: readonly Readonly<{ sequence: number; signal: DeliverySignal; resultingState: DeliveryState }>[];
}

/**
 * Deterministic workflow interpreter. The Temporal wrapper stores this snapshot
 * in workflow history and maps nextCommand() to retryable activities. Keeping
 * all transitions deterministic makes replay and long external waits safe.
 */
export class GameDeliveryWorkflow {
  private snapshot: DeliverySnapshot;
  private readonly automaticRepairSuccessorRuns: boolean;
  private readonly automaticRepairLimit: number | null;

  constructor(input: {
    workflowId: string;
    tenantId: string;
    projectId: string;
    targetMatrix: readonly TargetPlatform[];
    automaticRepairSuccessorRuns?: boolean;
    /** null preserves Temporal histories created before repair budgets existed. */
    automaticRepairLimit?: number | null;
  }) {
    if (!input.targetMatrix.length) throw new Error("A delivery needs at least one target platform");
    this.automaticRepairSuccessorRuns = input.automaticRepairSuccessorRuns ?? true;
    this.automaticRepairLimit = input.automaticRepairLimit === undefined
      ? DEFAULT_AUTOMATIC_REPAIR_LIMIT
      : input.automaticRepairLimit;
    if (this.automaticRepairLimit !== null
      && (!Number.isSafeInteger(this.automaticRepairLimit) || this.automaticRepairLimit < 1 || this.automaticRepairLimit > 100)) {
      throw new Error("Automatic repair limit is invalid");
    }
    const identity = {
      workflowId: input.workflowId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      targetMatrix: input.targetMatrix,
    };
    this.snapshot = deepFreeze({
      ...identity,
      targetMatrix: [...new Set(input.targetMatrix)].sort(),
      state: "IDEATION" as const,
      specRevisionId: null,
      testPlanRevisionId: null,
      specApprovalReceiptId: null,
      lockedRunConfigurationId: null,
      runId: null,
      candidateCommitSha: null,
      draftPullRequest: null,
      mainCommitSha: null,
      evidenceBundleId: null,
      candidateEvidenceBundleId: null,
      mainEvidenceBundleId: null,
      steamInstallEvidenceBundleId: null,
      mfaApprovalId: null,
      steamBuildId: null,
      steamReleaseId: null,
      defaultBranchBuildId: null,
      iteration: 1,
      repairAttempts: 0,
      repairContext: null,
      waitingProviderRevisionId: null,
      externalGate: null,
      externalApprovals: [],
      history: [],
    });
  }

  current(): DeepReadonly<DeliverySnapshot> {
    return this.snapshot as DeepReadonly<DeliverySnapshot>;
  }

  nextCommand(): DeliveryCommand {
    const commands: Record<DeliveryState, DeliveryCommand> = {
      IDEATION: "CONTINUE_IDEA_DIALOGUE",
      WAITING_SPEC_APPROVAL: "REQUEST_SPEC_APPROVAL",
      RESOLVING_AGENT_CONFIGURATION: "RESOLVE_AGENT_RUN_CONFIGURATION",
      DEVELOPMENT_QUEUED: "START_LOCKED_AGENT_RUN",
      DEVELOPING: "NONE",
      WAITING_PROVIDER: "WAIT_FOR_PROVIDER",
      CROSS_PLATFORM_E2E: "START_TARGET_MATRIX_E2E",
      WAITING_USER_ACCEPTANCE: "REQUEST_USER_ACCEPTANCE",
      MERGING: "MERGE_DRAFT_PULL_REQUEST",
      MAIN_SHA_E2E: "START_MAIN_SHA_RELEASE_GATE",
      WAITING_MFA: this.snapshot.steamReleaseId ? "NONE" : "REQUEST_FRESH_MFA",
      STEAM_PRIVATE_BETA: "UPLOAD_AND_ACTIVATE_PRIVATE_BETA",
      STEAM_INSTALL_E2E: "INSTALL_FROM_CLEAN_STEAM_CLIENT",
      EXTERNAL_APPROVAL_REQUIRED: "WAIT_FOR_EXTERNAL_APPROVAL",
      READY_TO_PUBLISH: "PUBLISH_STEAM_DEFAULT_BRANCH",
      RELEASED: "NONE",
      CANCELLED: "NONE",
    };
    return commands[this.snapshot.state];
  }

  signal(signal: DeliverySignal): DeepReadonly<DeliverySnapshot> {
    assertDeliverySignal(signal);
    const replay = this.snapshot.history.find((entry) => entry.signal.signalId === signal.signalId);
    if (replay) {
      if (canonicalSignal(replay.signal) !== canonicalSignal(signal)) {
        throw new Error(`Signal ID ${signal.signalId} was reused with different content`);
      }
      return this.current();
    }
    if (this.snapshot.state === "CANCELLED") throw new Error("Cancelled workflows are terminal");
    if (signal.type === "CANCEL") {
      // A cancellation is authorized against the last replay-validated
      // projection observed by the server-side command broker. If another
      // transition wins the race, ignore this stale signal instead of
      // poisoning a Temporal workflow task or cancelling a newer authority.
      if (signal.expectedState !== this.snapshot.state
        || signal.expectedHistoryLength !== this.snapshot.history.length) {
        return this.current();
      }
      // The default-branch publish dispatch is intentionally treated as an
      // irreversible boundary. Cancellation after that point could make the
      // workflow projection claim success was revoked after Steam already
      // accepted the public release.
      if (this.snapshot.state === "READY_TO_PUBLISH" || this.snapshot.state === "RELEASED") {
        return this.invalid(signal);
      }
      return this.commit(signal, { state: "CANCELLED" });
    }

    switch (this.snapshot.state) {
      case "IDEATION":
        return signal.type === "SPEC_READY"
          ? this.commit(signal, { state: "WAITING_SPEC_APPROVAL", specRevisionId: signal.specRevisionId })
          : this.invalid(signal);
      case "WAITING_SPEC_APPROVAL":
        if (this.snapshot.repairContext) {
          if (signal.type !== "USER_FEEDBACK"
            || signal.nextSpecRevisionId === this.snapshot.specRevisionId
            || !this.requiresHumanRevision(this.snapshot.repairContext)) return this.invalid(signal);
          return this.commit(signal, {
            specRevisionId: signal.nextSpecRevisionId,
            testPlanRevisionId: null,
            specApprovalReceiptId: null,
            candidateCommitSha: null,
            draftPullRequest: null,
            evidenceBundleId: null,
            candidateEvidenceBundleId: null,
            mainCommitSha: null,
            mainEvidenceBundleId: null,
            steamInstallEvidenceBundleId: null,
            mfaApprovalId: null,
            steamBuildId: null,
            steamReleaseId: null,
            defaultBranchBuildId: null,
            externalGate: null,
            externalApprovals: [],
            lockedRunConfigurationId: null,
            runId: null,
            repairAttempts: 0,
            repairContext: null,
            iteration: this.snapshot.iteration + 1,
          });
        }
        return signal.type === "SPEC_APPROVED"
          ? this.commit(signal, {
              state: "RESOLVING_AGENT_CONFIGURATION",
              specRevisionId: signal.approvedSpecRevisionId,
              testPlanRevisionId: signal.testPlanRevisionId,
              specApprovalReceiptId: signal.approvalReceiptId,
            })
          : this.invalid(signal);
      case "RESOLVING_AGENT_CONFIGURATION":
        return signal.type === "RUN_CONFIGURATION_LOCKED"
          ? this.commit(signal, {
              state: "DEVELOPMENT_QUEUED",
              lockedRunConfigurationId: signal.lockedRunConfigurationId,
              runId: null,
            })
          : this.invalid(signal);
      case "DEVELOPMENT_QUEUED":
        return signal.type === "AGENT_STARTED"
          ? this.commit(signal, { state: "DEVELOPING", runId: signal.runId, waitingProviderRevisionId: null })
          : signal.type === "PROVIDER_UNAVAILABLE"
            ? this.commit(signal, { state: "WAITING_PROVIDER", waitingProviderRevisionId: signal.providerRevisionId })
            : this.invalid(signal);
      case "DEVELOPING":
        if (signal.type === "PROVIDER_UNAVAILABLE") return this.commit(signal, { state: "WAITING_PROVIDER", waitingProviderRevisionId: signal.providerRevisionId });
        if (signal.type === "AGENT_COMPLETED") {
          return this.commit(signal, {
            state: "CROSS_PLATFORM_E2E",
            candidateCommitSha: signal.candidateCommitSha,
            draftPullRequest: signal.draftPullRequest,
          });
        }
        if (signal.type === "AGENT_FAILED") {
          if (!this.automaticRepairSuccessorRuns) {
            return this.commit(signal, {
              state: "DEVELOPMENT_QUEUED",
              repairAttempts: this.snapshot.repairAttempts + 1,
            });
          }
          if (!this.snapshot.lockedRunConfigurationId) return this.invalid(signal);
          const attempt = this.snapshot.repairAttempts + 1;
          const repairContext = Object.freeze({
            attempt,
            reason: "AGENT_FAILURE" as const,
            fromRunConfigurationId: this.snapshot.lockedRunConfigurationId,
            diagnosticId: signal.diagnosticId,
            evidenceBundleId: null,
            repairPromptId: null,
            candidateCommitSha: null,
            draftPullRequest: null,
          });
          return this.commit(signal, {
            state: this.repairBudgetExhausted(attempt)
              ? "WAITING_SPEC_APPROVAL"
              : "RESOLVING_AGENT_CONFIGURATION",
            lockedRunConfigurationId: null,
            runId: null,
            ...(this.automaticRepairLimit !== null ? {
              candidateCommitSha: null,
              draftPullRequest: null,
              evidenceBundleId: null,
              candidateEvidenceBundleId: null,
            } : {}),
            repairAttempts: attempt,
            repairContext,
          });
        }
        return this.invalid(signal);
      case "WAITING_PROVIDER":
        if (signal.type !== "PROVIDER_RESTORED" || signal.providerRevisionId !== this.snapshot.waitingProviderRevisionId) return this.invalid(signal);
        // Queue a fresh durable command that must resume the same lock/run.
        // The old destination job has already closed and cannot race this one.
        return this.commit(signal, { state: "DEVELOPMENT_QUEUED", waitingProviderRevisionId: null });
      case "CROSS_PLATFORM_E2E":
        if (signal.type === "E2E_PASSED") {
          return this.commit(signal, {
            state: "WAITING_USER_ACCEPTANCE",
            evidenceBundleId: signal.evidenceBundleId,
            candidateEvidenceBundleId: signal.evidenceBundleId,
          });
        }
        if (signal.type === "E2E_FAILED") {
          if (!this.automaticRepairSuccessorRuns) {
            return this.commit(signal, {
              state: "DEVELOPMENT_QUEUED",
              evidenceBundleId: signal.evidenceBundleId,
              repairAttempts: this.snapshot.repairAttempts + 1,
            });
          }
          if (!this.snapshot.lockedRunConfigurationId || !this.snapshot.candidateCommitSha || !this.snapshot.draftPullRequest) {
            return this.invalid(signal);
          }
          const attempt = this.snapshot.repairAttempts + 1;
          const repairContext = Object.freeze({
            attempt,
            reason: "E2E_FAILURE" as const,
            fromRunConfigurationId: this.snapshot.lockedRunConfigurationId,
            diagnosticId: null,
            evidenceBundleId: signal.evidenceBundleId,
            repairPromptId: signal.repairPromptId,
            candidateCommitSha: this.snapshot.candidateCommitSha,
            draftPullRequest: this.snapshot.draftPullRequest,
          });
          const exhausted = this.repairBudgetExhausted(attempt);
          return this.commit(signal, {
            state: exhausted ? "WAITING_SPEC_APPROVAL" : "RESOLVING_AGENT_CONFIGURATION",
            evidenceBundleId: signal.evidenceBundleId,
            lockedRunConfigurationId: null,
            runId: null,
            ...(exhausted ? {
              candidateCommitSha: null,
              draftPullRequest: null,
              candidateEvidenceBundleId: null,
            } : {}),
            repairAttempts: attempt,
            repairContext,
          });
        }
        return this.invalid(signal);
      case "WAITING_USER_ACCEPTANCE":
        if (signal.type === "USER_FEEDBACK") {
          return this.commit(signal, {
            state: "WAITING_SPEC_APPROVAL",
            specRevisionId: signal.nextSpecRevisionId,
            testPlanRevisionId: null,
            specApprovalReceiptId: null,
            lockedRunConfigurationId: null,
            runId: null,
            candidateCommitSha: null,
            draftPullRequest: null,
            evidenceBundleId: null,
            candidateEvidenceBundleId: null,
            repairContext: null,
            iteration: this.snapshot.iteration + 1,
            ...(this.automaticRepairSuccessorRuns ? { repairAttempts: 0 } : {}),
          });
        }
        return signal.type === "USER_ACCEPTED" ? this.commit(signal, { state: "MERGING" }) : this.invalid(signal);
      case "MERGING":
        return signal.type === "MAIN_MERGED" ? this.commit(signal, { state: "MAIN_SHA_E2E", mainCommitSha: signal.mainCommitSha, evidenceBundleId: null }) : this.invalid(signal);
      case "MAIN_SHA_E2E":
        if (signal.type === "E2E_PASSED") {
          return this.commit(signal, {
            state: "WAITING_MFA",
            evidenceBundleId: signal.evidenceBundleId,
            mainEvidenceBundleId: signal.evidenceBundleId,
          });
        }
        if (signal.type === "MAIN_E2E_FAILED") {
          return this.handoffPostMergeFailure(signal, "MAIN_GATE_FAILURE", this.snapshot.mainCommitSha);
        }
        return this.invalid(signal);
      case "WAITING_MFA":
        if (signal.type === "RELEASE_PREPARED" && !this.snapshot.steamReleaseId) {
          return this.commit(signal, { steamReleaseId: signal.releaseId });
        }
        // MFA_APPROVED remains replay-compatible with workflows created before
        // RELEASE_PREPARED became a projected signal. New workflows always
        // project the release first so the Web UI can bind its authorization.
        return signal.type === "MFA_APPROVED"
          ? this.commit(signal, { state: "STEAM_PRIVATE_BETA", mfaApprovalId: signal.approvalId })
          : this.invalid(signal);
      case "STEAM_PRIVATE_BETA":
        return signal.type === "BETA_ACTIVATED"
          ? this.commit(signal, { state: "STEAM_INSTALL_E2E", steamBuildId: signal.buildId })
          : this.invalid(signal);
      case "STEAM_INSTALL_E2E":
        if (signal.type === "STEAM_INSTALL_PASSED") {
          return this.commit(signal, {
            state: "EXTERNAL_APPROVAL_REQUIRED",
            evidenceBundleId: signal.evidenceBundleId,
            steamInstallEvidenceBundleId: signal.evidenceBundleId,
            externalGate: "VALVE_REVIEW",
          });
        }
        if (signal.type === "STEAM_INSTALL_FAILED") {
          return this.handoffPostMergeFailure(signal, "STEAM_INSTALL_FAILURE", this.snapshot.mainCommitSha);
        }
        return this.invalid(signal);
      case "EXTERNAL_APPROVAL_REQUIRED": {
        if (
          signal.type !== "EXTERNAL_APPROVED" ||
          !this.snapshot.externalGate ||
          signal.gate !== this.snapshot.externalGate ||
          this.snapshot.externalApprovals.some((approval) => approval.approvalId === signal.approvalId)
        ) return this.invalid(signal);
        const gate = this.snapshot.externalGate;
        const externalApprovals = [
          ...this.snapshot.externalApprovals,
          Object.freeze({ gate, approvalId: signal.approvalId }),
        ];
        if (gate === "VALVE_REVIEW") {
          return this.commit(signal, {
            state: "EXTERNAL_APPROVAL_REQUIRED",
            externalGate: "FIRST_RELEASE",
            externalApprovals,
          });
        }
        if (gate === "FIRST_RELEASE") {
          return this.commit(signal, {
            state: "EXTERNAL_APPROVAL_REQUIRED",
            externalGate: "DEFAULT_BRANCH_CONFIRMATION",
            externalApprovals,
          });
        }
        return this.commit(signal, {
          state: "READY_TO_PUBLISH",
          externalGate: null,
          externalApprovals,
        });
      }
      case "READY_TO_PUBLISH":
        return signal.type === "STEAM_RELEASED"
          && (!this.snapshot.steamReleaseId || signal.releaseId === this.snapshot.steamReleaseId)
          && signal.defaultBranchBuildId === this.snapshot.steamBuildId
          ? this.commit(signal, {
              state: "RELEASED",
              steamReleaseId: signal.releaseId,
              defaultBranchBuildId: signal.defaultBranchBuildId,
            })
          : this.invalid(signal);
      case "RELEASED":
        return this.invalid(signal);
    }
  }

  private commit(signal: DeliverySignal, changes: Partial<DeliverySnapshot>): DeepReadonly<DeliverySnapshot> {
    const state = changes.state ?? this.snapshot.state;
    const history = [
      ...this.snapshot.history,
      Object.freeze({ sequence: this.snapshot.history.length + 1, signal: deepFreeze(signal), resultingState: state }),
    ];
    this.snapshot = deepFreeze({ ...this.snapshot, ...changes, history });
    return this.current();
  }

  private repairBudgetExhausted(attempt: number): boolean {
    return this.automaticRepairLimit !== null && attempt >= this.automaticRepairLimit;
  }

  private requiresHumanRevision(repair: DeliveryRepairContext): boolean {
    return repair.reason === "MAIN_GATE_FAILURE"
      || repair.reason === "STEAM_INSTALL_FAILURE"
      || this.repairBudgetExhausted(repair.attempt);
  }

  private handoffPostMergeFailure(
    signal: Extract<DeliverySignal, { type: "MAIN_E2E_FAILED" | "STEAM_INSTALL_FAILED" }>,
    reason: "MAIN_GATE_FAILURE" | "STEAM_INSTALL_FAILURE",
    baselineCommitSha: string | null,
  ): DeepReadonly<DeliverySnapshot> {
    if (!this.snapshot.lockedRunConfigurationId || !baselineCommitSha) return this.invalid(signal);
    const attempt = this.snapshot.repairAttempts + 1;
    return this.commit(signal, {
      state: "WAITING_SPEC_APPROVAL",
      lockedRunConfigurationId: null,
      runId: null,
      candidateCommitSha: null,
      draftPullRequest: null,
      mainCommitSha: null,
      evidenceBundleId: signal.evidenceBundleId,
      candidateEvidenceBundleId: null,
      mainEvidenceBundleId: null,
      steamInstallEvidenceBundleId: null,
      mfaApprovalId: null,
      steamBuildId: null,
      steamReleaseId: null,
      defaultBranchBuildId: null,
      externalGate: null,
      externalApprovals: [],
      repairAttempts: attempt,
      repairContext: Object.freeze({
        attempt,
        reason,
        fromRunConfigurationId: this.snapshot.lockedRunConfigurationId,
        diagnosticId: null,
        evidenceBundleId: signal.evidenceBundleId,
        repairPromptId: signal.repairPromptId,
        candidateCommitSha: baselineCommitSha,
        draftPullRequest: null,
      }),
    });
  }

  private invalid(signal: DeliverySignal): never {
    throw new Error(`Signal ${signal.type} is invalid while delivery is ${this.snapshot.state}`);
  }
}

const SIGNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const STEAM_BUILD_ID = /^[0-9]{1,20}$/;

export function assertDeliverySignal(signal: DeliverySignal): void {
  if (!signal || typeof signal !== "object") throw new Error("Delivery signal is invalid");
  if (!SIGNAL_ID.test(signal.signalId)) throw new Error("Delivery signal ID is invalid");
  switch (signal.type) {
    case "SPEC_READY":
      return assertOpaqueId(signal.specRevisionId, "Specification revision");
    case "SPEC_APPROVED":
      assertOpaqueId(signal.approvedSpecRevisionId, "Approved specification revision");
      assertOpaqueId(signal.testPlanRevisionId, "Test plan revision");
      return assertOpaqueId(signal.approvalReceiptId, "Specification approval receipt");
    case "RUN_CONFIGURATION_LOCKED":
      return assertOpaqueId(signal.lockedRunConfigurationId, "Run configuration lock");
    case "AGENT_STARTED":
      return assertOpaqueId(signal.runId, "Agent run");
    case "PROVIDER_UNAVAILABLE":
    case "PROVIDER_RESTORED":
      return assertOpaqueId(signal.providerRevisionId, "Provider revision");
    case "AGENT_COMPLETED":
      if (!SHA1.test(signal.candidateCommitSha) || !Number.isSafeInteger(signal.draftPullRequest) || signal.draftPullRequest < 1) {
        throw new Error("Agent completion binding is invalid");
      }
      return;
    case "AGENT_FAILED":
      return assertOpaqueId(signal.diagnosticId, "Agent diagnostic");
    case "E2E_PASSED":
    case "STEAM_INSTALL_PASSED":
      return assertOpaqueId(signal.evidenceBundleId, "Evidence bundle");
    case "E2E_FAILED":
    case "MAIN_E2E_FAILED":
    case "STEAM_INSTALL_FAILED":
      assertOpaqueId(signal.evidenceBundleId, "Evidence bundle");
      return assertOpaqueId(signal.repairPromptId, "Repair prompt");
    case "USER_FEEDBACK":
      assertOpaqueId(signal.nextSpecRevisionId, "Next specification revision");
      return assertOpaqueId(signal.evidenceInvalidationId, "Evidence invalidation");
    case "USER_ACCEPTED":
      return;
    case "MAIN_MERGED":
      if (!SHA1.test(signal.mainCommitSha)) throw new Error("Main commit SHA is invalid");
      return;
    case "RELEASE_PREPARED":
      return assertOpaqueId(signal.releaseId, "Steam release");
    case "MFA_APPROVED":
    case "EXTERNAL_APPROVED":
      return assertOpaqueId(signal.approvalId, "Approval");
    case "BETA_ACTIVATED":
      if (!STEAM_BUILD_ID.test(signal.buildId)) throw new Error("Steam BuildID is invalid");
      return;
    case "STEAM_RELEASED":
      assertOpaqueId(signal.releaseId, "Steam release");
      if (!STEAM_BUILD_ID.test(signal.defaultBranchBuildId)) throw new Error("Default branch BuildID is invalid");
      return;
    case "CANCEL":
      if (typeof signal.reason !== "string" || !signal.reason.trim() || signal.reason.length > 2_000) {
        throw new Error("Cancellation reason is invalid");
      }
      if (!DELIVERY_STATES.has(signal.expectedState)
        || !Number.isSafeInteger(signal.expectedHistoryLength)
        || signal.expectedHistoryLength < 0 || signal.expectedHistoryLength > 100_000) {
        throw new Error("Cancellation projection binding is invalid");
      }
      return;
    default:
      throw new Error("Delivery signal type is invalid");
  }
}

const DELIVERY_STATES = new Set<DeliveryState>([
  "IDEATION", "WAITING_SPEC_APPROVAL", "RESOLVING_AGENT_CONFIGURATION",
  "DEVELOPMENT_QUEUED", "DEVELOPING", "WAITING_PROVIDER",
  "CROSS_PLATFORM_E2E", "WAITING_USER_ACCEPTANCE", "MERGING",
  "MAIN_SHA_E2E", "WAITING_MFA", "STEAM_PRIVATE_BETA",
  "STEAM_INSTALL_E2E", "EXTERNAL_APPROVAL_REQUIRED", "READY_TO_PUBLISH",
  "RELEASED", "CANCELLED",
]);

function assertOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} identifier is invalid`);
  }
}

function canonicalSignal(signal: DeliverySignal): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(signal).sort(([left], [right]) => left.localeCompare(right))),
  );
}
