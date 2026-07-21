export type SteamTargetPlatform = "windows" | "linux" | "macos";

export interface SteamRcDepot {
  readonly depotId: string;
  readonly platform: SteamTargetPlatform;
  readonly objectRef: string;
  /** Digest of the immutable Runner export before native release signing. */
  readonly sourceArtifactDigest: string;
  /** Digest of the finalized, signed artifact uploaded to Steam. */
  readonly artifactDigest: string;
  readonly sizeBytes: number;
  readonly signingScheme: "LINUX_SIGSTORE" | "MACOS_DEVELOPER_ID" | "WINDOWS_AUTHENTICODE";
  readonly signingIdentityDigest: string;
  readonly signingEvidenceRef: string;
  readonly signingEvidenceDigest: string;
  readonly notarizationEvidenceRef: string | null;
  readonly notarizationEvidenceDigest: string | null;
}

export interface SteamRcArtifactClaims {
  readonly kind: "deviludo-steam-rc";
  readonly version: 2;
  readonly tenantId: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly mainCommitSha: string;
  readonly sourceDigest: string;
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanDigest: string;
  readonly evidenceBundleDigest: string;
  readonly steamAppId: string;
  readonly targetMatrix: readonly SteamTargetPlatform[];
  readonly depots: readonly SteamRcDepot[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SignedSteamRcArtifact {
  readonly keyId: string;
  readonly claims: SteamRcArtifactClaims;
  readonly signature: string;
}

export interface SteamPublishAuthorizationClaims {
  readonly kind: "deviludo-steam-publish-authorization";
  readonly version: 1;
  readonly operation: "PRIVATE_BETA_UPLOAD";
  readonly tenantId: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly mainCommitSha: string;
  readonly evidenceBundleDigest: string;
  readonly acceptedBy: string;
  readonly mfaAssertionId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SignedSteamPublishAuthorization {
  readonly keyId: string;
  readonly claims: SteamPublishAuthorizationClaims;
  readonly signature: string;
}

export interface SteamBuildSession {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly configVdfSecretRef: string;
  readonly credentialVersionId: string;
  readonly allowedAppIds: readonly string[];
  readonly permissions: readonly ("EditAppMetadata" | "PublishAppChanges")[];
  readonly state: "ACTIVE" | "REVOKED" | "EXPIRED";
  readonly verifiedAt: string;
  readonly expiresAt: string;
}

export interface SteamReleaseEvidenceGate {
  assertPassed(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly mainCommitSha: string;
    readonly sourceDigest: string;
    readonly specDigest: string;
    readonly testPlanDigest: string;
    readonly evidenceBundleDigest: string;
    readonly targetMatrix: readonly SteamTargetPlatform[];
  }): Promise<void>;
}

export interface SteamPipeUploadReceipt {
  readonly steamAppId: string;
  readonly buildId: string;
  readonly betaBranch: string;
  readonly passwordProtected: true;
  readonly depotManifestIds: Readonly<Record<string, string>>;
  readonly uploadedAt: string;
}

export interface SteamPipeConnector {
  uploadPrivateBeta(input: {
    /** Stable across retries; the Connector reconciles an existing Build before re-uploading. */
    readonly operationKey: string;
    readonly requestDigest: string;
    readonly rc: SteamRcArtifactClaims;
    readonly session: SteamBuildSession;
    readonly betaBranch: string;
    readonly branchPasswordSecretRef: string;
  }): Promise<SteamPipeUploadReceipt>;
}

export interface SteamCleanInstallDispatcher {
  schedule(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly releaseId: string;
    readonly steamAppId: string;
    readonly buildId: string;
    readonly betaBranch: string;
    readonly branchPasswordSecretRef: string;
    readonly mainCommitSha: string;
    readonly sourceDigest: string;
    readonly specDigest: string;
    readonly testPlanDigest: string;
    readonly targetMatrix: readonly SteamTargetPlatform[];
  }): Promise<Readonly<Record<SteamTargetPlatform, string>>>;
}

export interface SteamInstallEvidenceGate {
  assertPassed(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly releaseId: string;
    readonly steamAppId: string;
    readonly buildId: string;
    readonly betaBranch: string;
    readonly mainCommitSha: string;
    readonly sourceDigest: string;
    readonly specDigest: string;
    readonly testPlanDigest: string;
    readonly targetMatrix: readonly SteamTargetPlatform[];
    readonly attempts: Readonly<Record<SteamTargetPlatform, string>>;
  }): Promise<{ readonly evidenceBundleDigest: string }>;
}

export interface SteamPublishOperationStore {
  acquire(input: {
    readonly key: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly releaseId: string;
    readonly requestDigest: string;
    readonly claimToken: string;
    readonly claimExpiresAt: string;
    readonly authorizedAt: string;
  }): Promise<
    | { readonly kind: "ACQUIRED" }
    | { readonly kind: "BUSY" }
    | { readonly kind: "COMPLETED"; readonly response: SteamPrivateBetaReceipt }
  >;
  complete(input: {
    readonly key: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly releaseId: string;
    readonly requestDigest: string;
    readonly claimToken: string;
    readonly response: SteamPrivateBetaReceipt;
    readonly completedAt: string;
  }): Promise<void>;
}

export interface SteamPrivateBetaReceipt {
  readonly tenantId: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly steamAppId: string;
  readonly mainCommitSha: string;
  readonly sourceDigest: string;
  readonly evidenceBundleDigest: string;
  readonly buildId: string;
  readonly betaBranch: string;
  readonly depotManifestIds: Readonly<Record<string, string>>;
  readonly installAttempts: Readonly<Record<SteamTargetPlatform, string>>;
  readonly state: "INSTALL_TESTING";
  readonly uploadedAt: string;
}

export interface SteamReleaseReadyReceipt extends Omit<SteamPrivateBetaReceipt, "state"> {
  readonly steamInstallEvidenceBundleDigest: string;
  readonly state: "EXTERNAL_APPROVAL_REQUIRED";
  readonly externalGates: readonly ["VALVE_REVIEW", "FIRST_RELEASE", "DEFAULT_BRANCH_CONFIRMATION"];
}
