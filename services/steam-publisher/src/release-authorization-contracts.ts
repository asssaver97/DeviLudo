import type {
  SignedSteamPublishAuthorization,
  SteamPublishAuthorizationClaims,
} from "./contracts";

export interface ReleaseAuthorizationPrincipal {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionBinding: string;
}

export interface AuthoritativeReleaseSnapshot {
  readonly tenantId: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly workflowId: string;
  readonly state: "WAITING_MFA";
  readonly mainCommitSha: string;
  readonly evidenceBundleDigest: string;
}

export interface ReleaseSnapshotResolver {
  resolveForMfa(input: {
    readonly tenantId: string;
    readonly releaseId: string;
    readonly requestedBy: string;
  }): Promise<AuthoritativeReleaseSnapshot>;
}

export type ReleaseAuthorizationState =
  | "CREATING"
  | "MFA_REQUIRED"
  | "VERIFIED"
  | "DISPATCHED"
  | "FAILED"
  | "EXPIRED";

export interface ReleaseAuthorizationRecord {
  readonly approvalId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionBindingDigest: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly snapshot: AuthoritativeReleaseSnapshot;
  readonly state: ReleaseAuthorizationState;
  readonly authorizationUrl: string | null;
  readonly mfaAssertionId: string | null;
  readonly signedAuthorization: SignedSteamPublishAuthorization | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly verifiedAt: string | null;
  readonly dispatchedAt: string | null;
}

export interface ReleaseAuthorizationStore {
  reserve(input: Omit<ReleaseAuthorizationRecord,
    "state" | "authorizationUrl" | "mfaAssertionId" | "signedAuthorization" | "verifiedAt" | "dispatchedAt"
  >): Promise<{ readonly kind: "CREATED" | "EXISTING"; readonly record: ReleaseAuthorizationRecord }>;
  activate(input: {
    readonly tenantId: string;
    readonly approvalId: string;
    readonly authorizationUrl: string;
  }): Promise<ReleaseAuthorizationRecord>;
  find(input: {
    readonly tenantId: string;
    readonly approvalId: string;
  }): Promise<ReleaseAuthorizationRecord>;
  markVerified(input: {
    readonly tenantId: string;
    readonly approvalId: string;
    readonly mfaAssertionId: string;
    readonly authorization: SignedSteamPublishAuthorization;
    readonly verifiedAt: string;
  }): Promise<ReleaseAuthorizationRecord>;
  markDispatched(input: {
    readonly tenantId: string;
    readonly approvalId: string;
    readonly dispatchedAt: string;
  }): Promise<ReleaseAuthorizationRecord>;
  fail(input: {
    readonly tenantId: string;
    readonly approvalId: string;
  }): Promise<void>;
}

export interface ReleaseMfaChallengeIssuer {
  begin(input: {
    readonly approvalId: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly sessionBindingDigest: string;
    readonly releaseId: string;
    readonly expiresAt: string;
  }): Promise<{ readonly authorizationUrl: string }>;
}

export interface FreshMfaVerification {
  readonly approvalId: string;
  readonly userId: string;
  readonly assertionId: string;
  readonly assuranceLevel: "AAL2";
  readonly verifiedAt: string;
}

export interface ReleaseMfaVerifier {
  verify(input: {
    readonly approvalId: string;
    readonly assertion: unknown;
  }): Promise<FreshMfaVerification>;
}

/** Production implementation signs through Vault/KMS; private keys stay out of this service logic. */
export interface SteamPublishAuthorizationSigner {
  sign(claims: SteamPublishAuthorizationClaims): Promise<SignedSteamPublishAuthorization>;
}

export interface SteamPublishAuthorizationArchive {
  persist(input: {
    readonly approvalId: string;
    readonly tenantId: string;
    readonly releaseId: string;
    readonly authorization: SignedSteamPublishAuthorization;
  }): Promise<void>;
}

export interface ReleaseMfaWorkflowSignal {
  signal(input: {
    readonly workflowId: string;
    readonly signalId: string;
    readonly approvalId: string;
  }): Promise<void>;
}

export interface ReleaseAuthorizationView {
  readonly releaseId: string;
  readonly state: "MFA_REQUIRED" | "DISPATCHED";
  readonly approvalId: string;
  readonly authorizationUrl: string | null;
  readonly workflowId: string | null;
  readonly expiresAt: string;
}
