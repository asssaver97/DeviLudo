import { invariant } from "./errors";
import { assertGitSha, deepFreeze, uniqueSorted, type DeepReadonly, type EntityId, type ISODateTime, type Sha256, type TargetPlatform } from "./types";

export interface RunnerLease {
  readonly attemptId: EntityId;
  readonly runnerId: EntityId;
  readonly fencingToken: number;
  readonly leaseExpiresAt: ISODateTime;
  readonly commitSha: string;
  readonly sourceDigest: Sha256;
  readonly specRevisionId: EntityId;
  readonly specDigest: Sha256;
  readonly testPlanDigest: Sha256;
  readonly targetMatrix: readonly TargetPlatform[];
}

/**
 * A matrix attempt is leased independently per target OS. The complete target
 * matrix remains in every lease for provenance, while `platform` is the only
 * platform the bound runner may report. This prevents a Windows runner from
 * claiming Linux/macOS completion and lets every platform receive its own
 * monotonically increasing fencing token.
 */
export interface PlatformRunnerLease extends RunnerLease {
  readonly platform: TargetPlatform;
}

export type RunnerEventType =
  | "STARTED"
  | "HEARTBEAT"
  | "LOG"
  | "SCREENSHOT"
  | "VIDEO"
  | "JUNIT"
  | "PLATFORM_COMPLETED"
  | "ATTEMPT_COMPLETED";

export interface RunnerEvent {
  readonly attemptId: EntityId;
  readonly runnerId: EntityId;
  readonly fencingToken: number;
  readonly seqNo: number;
  readonly commitSha: string;
  readonly sourceDigest: Sha256;
  readonly platform: TargetPlatform;
  readonly type: RunnerEventType;
  readonly status: "RUNNING" | "PASSED" | "FAILED";
  readonly artifactDigest: Sha256 | null;
  readonly occurredAt: ISODateTime;
}

export interface RunnerEventCursor {
  readonly lastAcceptedSeqNo: number;
  readonly completedPlatforms: Readonly<Partial<Record<TargetPlatform, "PASSED" | "FAILED">>>;
  readonly terminal: boolean;
}

export type RunnerResultRejection =
  | "WRONG_ATTEMPT"
  | "WRONG_RUNNER"
  | "STALE_FENCING_TOKEN"
  | "LEASE_EXPIRED"
  | "DUPLICATE_OR_OUT_OF_ORDER_SEQUENCE"
  | "COMMIT_MISMATCH"
  | "SOURCE_DIGEST_MISMATCH"
  | "PLATFORM_NOT_SELECTED"
  | "WRONG_PLATFORM_LEASE"
  | "RUNNER_ATTEMPT_COMPLETION_FORBIDDEN"
  | "EVENT_AFTER_TERMINAL"
  | "INVALID_TERMINAL_EVENT";

export type RunnerResultDecision =
  | { readonly accepted: false; readonly reason: RunnerResultRejection }
  | { readonly accepted: true; readonly cursor: DeepReadonly<RunnerEventCursor> };

/**
 * This is the only acceptance gate for runner events. A re-leased attempt receives
 * a higher fencing token, making every result from the old lease unconditionally stale.
 */
export function acceptRunnerEvent(
  lease: RunnerLease,
  cursor: RunnerEventCursor,
  event: RunnerEvent,
  receivedAt: ISODateTime,
): RunnerResultDecision {
  if (event.attemptId !== lease.attemptId) return { accepted: false, reason: "WRONG_ATTEMPT" };
  if (event.runnerId !== lease.runnerId) return { accepted: false, reason: "WRONG_RUNNER" };
  if (event.fencingToken !== lease.fencingToken) return { accepted: false, reason: "STALE_FENCING_TOKEN" };
  const receivedTime = Date.parse(receivedAt);
  const expiryTime = Date.parse(lease.leaseExpiresAt);
  if (!Number.isFinite(receivedTime) || !Number.isFinite(expiryTime) || receivedTime > expiryTime) {
    return { accepted: false, reason: "LEASE_EXPIRED" };
  }
  if (cursor.terminal) return { accepted: false, reason: "EVENT_AFTER_TERMINAL" };
  if (event.seqNo !== cursor.lastAcceptedSeqNo + 1) {
    return { accepted: false, reason: "DUPLICATE_OR_OUT_OF_ORDER_SEQUENCE" };
  }
  if (event.commitSha !== lease.commitSha) return { accepted: false, reason: "COMMIT_MISMATCH" };
  if (event.sourceDigest !== lease.sourceDigest) return { accepted: false, reason: "SOURCE_DIGEST_MISMATCH" };
  if (!lease.targetMatrix.includes(event.platform)) return { accepted: false, reason: "PLATFORM_NOT_SELECTED" };

  const completedPlatforms = { ...cursor.completedPlatforms };
  if (event.type === "PLATFORM_COMPLETED") {
    if (completedPlatforms[event.platform]) return { accepted: false, reason: "INVALID_TERMINAL_EVENT" };
    completedPlatforms[event.platform] = event.status === "PASSED" ? "PASSED" : "FAILED";
  }

  if (event.type === "ATTEMPT_COMPLETED") {
    const complete = lease.targetMatrix.every((platform) => completedPlatforms[platform]);
    const expectedStatus = lease.targetMatrix.every((platform) => completedPlatforms[platform] === "PASSED") ? "PASSED" : "FAILED";
    if (!complete || event.status !== expectedStatus) return { accepted: false, reason: "INVALID_TERMINAL_EVENT" };
  }

  return {
    accepted: true,
    cursor: deepFreeze({
      lastAcceptedSeqNo: event.seqNo,
      completedPlatforms,
      terminal: event.type === "ATTEMPT_COMPLETED",
    }),
  };
}

/**
 * Production runner ingestion uses one lease per target platform. A runner may
 * terminate only its own platform stream; the control plane derives the matrix
 * result after all platform leases terminate. `ATTEMPT_COMPLETED` therefore
 * never crosses the runner trust boundary.
 */
export function acceptPlatformRunnerEvent(
  lease: PlatformRunnerLease,
  cursor: RunnerEventCursor,
  event: RunnerEvent,
  receivedAt: ISODateTime,
): RunnerResultDecision {
  if (event.platform !== lease.platform) {
    return { accepted: false, reason: "WRONG_PLATFORM_LEASE" };
  }
  if (event.type === "ATTEMPT_COMPLETED") {
    return { accepted: false, reason: "RUNNER_ATTEMPT_COMPLETION_FORBIDDEN" };
  }
  const decision = acceptRunnerEvent(
    { ...lease, targetMatrix: [lease.platform] },
    cursor,
    event,
    receivedAt,
  );
  if (!decision.accepted || event.type !== "PLATFORM_COMPLETED") return decision;
  return {
    accepted: true,
    cursor: deepFreeze({ ...decision.cursor, terminal: true }),
  };
}

export interface PlatformEvidence {
  readonly platform: TargetPlatform;
  readonly runnerId: EntityId;
  readonly runnerCapabilityDigest: Sha256;
  readonly exportDigest: Sha256;
  readonly logsDigest: Sha256;
  readonly junitDigest: Sha256;
  readonly inputTimelineDigest: Sha256;
  readonly screenshotManifestDigest: Sha256;
  readonly videoManifestDigest: Sha256;
  readonly status: "PASSED" | "FAILED";
}

export interface EvidenceBundle {
  readonly id: EntityId;
  readonly attemptId: EntityId;
  readonly specRevisionId: EntityId;
  readonly specDigest: Sha256;
  readonly testPlanDigest: Sha256;
  readonly commitSha: string;
  readonly sourceDigest: Sha256;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly godotTestKitDigest: Sha256;
  readonly buildManifestDigest: Sha256;
  readonly sbomDigest: Sha256;
  readonly vulnerabilityScanDigest: Sha256;
  readonly assetLicenseLedgerDigest: Sha256;
  readonly platformEvidence: readonly PlatformEvidence[];
  readonly bundleDigest: Sha256;
  readonly status: "PASSED" | "FAILED";
  readonly valid: true;
  readonly createdAt: ISODateTime;
}

export function createEvidenceBundle(input: EvidenceBundle): DeepReadonly<EvidenceBundle> {
  assertGitSha(input.commitSha);
  const selected = uniqueSorted(input.targetMatrix);
  const submitted = uniqueSorted(input.platformEvidence.map((evidence) => evidence.platform));
  invariant(
    input.platformEvidence.length === selected.length &&
      selected.length === submitted.length &&
      selected.every((platform, index) => platform === submitted[index]),
    "Evidence must cover the exact target matrix exactly once",
  );
  const expected = input.platformEvidence.every((evidence) => evidence.status === "PASSED") ? "PASSED" : "FAILED";
  invariant(input.status === expected, "Bundle status does not match platform evidence");
  return deepFreeze({ ...input, targetMatrix: selected });
}

/** Evidence is never edited; feedback creates this tombstone and a fresh attempt. */
export interface EvidenceInvalidation {
  readonly id: EntityId;
  readonly evidenceBundleId: EntityId;
  readonly iterationId: EntityId;
  readonly reason: "USER_FEEDBACK" | "COMMIT_CHANGED" | "SPEC_CHANGED" | "TEST_PLAN_CHANGED";
  readonly invalidatedBy: EntityId;
  readonly invalidatedAt: ISODateTime;
}

export interface MainShaReleaseGateInput {
  readonly acceptedIterationCommitSha: string;
  readonly mergedMainCommitSha: string;
  readonly releaseEvidence: EvidenceBundle;
}

/** Candidate-branch evidence cannot authorize a release; main gets a full fresh gate. */
export function assertMainShaReleaseGate(input: MainShaReleaseGateInput): void {
  assertGitSha(input.acceptedIterationCommitSha);
  assertGitSha(input.mergedMainCommitSha);
  invariant(input.releaseEvidence.valid, "Release evidence was invalidated");
  invariant(input.releaseEvidence.status === "PASSED", "Release evidence did not pass");
  invariant(input.releaseEvidence.commitSha === input.mergedMainCommitSha, "Release evidence must bind the merged main SHA");
}
