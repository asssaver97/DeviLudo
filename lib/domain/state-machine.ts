import { DomainError } from "./errors";

export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export function transitionState<S extends string, T extends { readonly state: S }>(
  aggregate: T,
  next: S,
  allowed: TransitionMap<S>,
): T {
  if (!allowed[aggregate.state].includes(next)) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      `Cannot transition ${aggregate.state} to ${next}`,
      { from: aggregate.state, to: next },
    );
  }
  return Object.freeze({ ...aggregate, state: next });
}

export type AgentVersionState =
  | "DISCOVERED"
  | "VALIDATING"
  | "APPROVED"
  | "DEPRECATED"
  | "BLOCKED"
  | "REJECTED";

export const AGENT_VERSION_TRANSITIONS: TransitionMap<AgentVersionState> = {
  DISCOVERED: ["VALIDATING", "BLOCKED", "REJECTED"],
  VALIDATING: ["APPROVED", "BLOCKED", "REJECTED"],
  APPROVED: ["DEPRECATED", "BLOCKED"],
  DEPRECATED: ["BLOCKED"],
  BLOCKED: [],
  REJECTED: [],
};

export type InstallationState =
  | "BUILDING"
  | "SCANNING"
  | "SMOKE_TESTING"
  | "READY"
  | "CANARY"
  | "ACTIVE"
  | "DRAINING"
  | "RETIRED"
  | "FAILED"
  | "QUARANTINED";

export const INSTALLATION_TRANSITIONS: TransitionMap<InstallationState> = {
  BUILDING: ["SCANNING", "FAILED", "QUARANTINED"],
  SCANNING: ["SMOKE_TESTING", "FAILED", "QUARANTINED"],
  SMOKE_TESTING: ["READY", "FAILED", "QUARANTINED"],
  READY: ["CANARY", "DRAINING", "QUARANTINED"],
  CANARY: ["ACTIVE", "READY", "DRAINING", "FAILED", "QUARANTINED"],
  ACTIVE: ["DRAINING", "QUARANTINED"],
  DRAINING: ["RETIRED", "QUARANTINED"],
  RETIRED: [],
  FAILED: ["BUILDING", "QUARANTINED"],
  QUARANTINED: ["RETIRED"],
};

export type ProfileState =
  | "DRAFT"
  | "VALIDATING"
  | "READY"
  | "ACTIVE"
  | "SUPERSEDED"
  | "DEGRADED"
  | "DISABLED";

export const PROFILE_TRANSITIONS: TransitionMap<ProfileState> = {
  DRAFT: ["VALIDATING", "DISABLED"],
  VALIDATING: ["READY", "DRAFT", "DEGRADED", "DISABLED"],
  READY: ["ACTIVE", "VALIDATING", "DISABLED"],
  ACTIVE: ["SUPERSEDED", "DEGRADED", "DISABLED"],
  SUPERSEDED: ["DISABLED"],
  DEGRADED: ["VALIDATING", "DISABLED"],
  DISABLED: [],
};

export type AgentRunState =
  | "QUEUED"
  | "PREPARING"
  | "RUNNING"
  | "WAITING_PROVIDER"
  | "CANCELLING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export const AGENT_RUN_TRANSITIONS: TransitionMap<AgentRunState> = {
  QUEUED: ["PREPARING", "WAITING_PROVIDER", "CANCELLING", "FAILED"],
  PREPARING: ["RUNNING", "WAITING_PROVIDER", "CANCELLING", "FAILED"],
  RUNNING: ["WAITING_PROVIDER", "CANCELLING", "SUCCEEDED", "FAILED"],
  WAITING_PROVIDER: ["PREPARING", "CANCELLING", "FAILED"],
  CANCELLING: ["CANCELLED", "FAILED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export type GameSpecState = "DRAFT" | "APPROVED" | "SUPERSEDED";
export const GAME_SPEC_TRANSITIONS: TransitionMap<GameSpecState> = {
  DRAFT: ["APPROVED", "SUPERSEDED"],
  APPROVED: ["SUPERSEDED"],
  SUPERSEDED: [],
};

export type IterationState =
  | "CREATED"
  | "DEVELOPING"
  | "TESTING"
  | "AWAITING_ACCEPTANCE"
  | "CHANGES_REQUESTED"
  | "ACCEPTED"
  | "MERGED"
  | "FAILED"
  | "CANCELLED";

export const ITERATION_TRANSITIONS: TransitionMap<IterationState> = {
  CREATED: ["DEVELOPING", "CANCELLED"],
  DEVELOPING: ["TESTING", "FAILED", "CANCELLED"],
  TESTING: ["AWAITING_ACCEPTANCE", "DEVELOPING", "FAILED", "CANCELLED"],
  AWAITING_ACCEPTANCE: ["CHANGES_REQUESTED", "ACCEPTED", "CANCELLED"],
  CHANGES_REQUESTED: [],
  ACCEPTED: ["MERGED", "FAILED"],
  MERGED: [],
  FAILED: [],
  CANCELLED: [],
};

export type E2EAttemptState =
  | "QUEUED"
  | "LEASED"
  | "RUNNING"
  | "PASSED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "INVALIDATED";

export const E2E_ATTEMPT_TRANSITIONS: TransitionMap<E2EAttemptState> = {
  QUEUED: ["LEASED", "CANCELLED", "INVALIDATED"],
  LEASED: ["RUNNING", "TIMED_OUT", "CANCELLED", "INVALIDATED"],
  RUNNING: ["PASSED", "FAILED", "TIMED_OUT", "CANCELLED", "INVALIDATED"],
  PASSED: ["INVALIDATED"],
  FAILED: ["INVALIDATED"],
  TIMED_OUT: ["INVALIDATED"],
  CANCELLED: ["INVALIDATED"],
  INVALIDATED: [],
};

export type SteamReleaseState =
  | "DRAFT"
  | "RC_BUILDING"
  | "RC_TESTING"
  | "BETA_UPLOADING"
  | "BETA_ACTIVE"
  | "INSTALL_TESTING"
  | "EXTERNAL_APPROVAL_REQUIRED"
  | "READY_TO_RELEASE"
  | "RELEASED"
  | "FAILED"
  | "CANCELLED";

export const STEAM_RELEASE_TRANSITIONS: TransitionMap<SteamReleaseState> = {
  DRAFT: ["RC_BUILDING", "CANCELLED"],
  RC_BUILDING: ["RC_TESTING", "FAILED", "CANCELLED"],
  RC_TESTING: ["BETA_UPLOADING", "FAILED", "CANCELLED"],
  BETA_UPLOADING: ["BETA_ACTIVE", "EXTERNAL_APPROVAL_REQUIRED", "FAILED"],
  BETA_ACTIVE: ["INSTALL_TESTING", "FAILED", "CANCELLED"],
  INSTALL_TESTING: ["READY_TO_RELEASE", "EXTERNAL_APPROVAL_REQUIRED", "FAILED"],
  EXTERNAL_APPROVAL_REQUIRED: ["BETA_UPLOADING", "INSTALL_TESTING", "READY_TO_RELEASE", "FAILED", "CANCELLED"],
  READY_TO_RELEASE: ["RELEASED", "EXTERNAL_APPROVAL_REQUIRED", "FAILED", "CANCELLED"],
  RELEASED: [],
  FAILED: ["RC_BUILDING", "CANCELLED"],
  CANCELLED: [],
};
