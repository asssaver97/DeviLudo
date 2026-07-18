export type PlatformRole = "TenantAdmin" | "ProjectOwner" | "Auditor";

export interface IdentityInvitation {
  readonly id: string;
  readonly tenantId: string;
  readonly tokenDigest: string;
  readonly role: PlatformRole;
  readonly state: "ACTIVE" | "CLAIMED" | "CONSUMED" | "REVOKED";
  readonly loginIntentId: string | null;
  readonly claimExpiresAt: string | null;
  readonly expiresAt: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface IdentityLoginIntent {
  readonly id: string;
  readonly tenantId: string;
  readonly invitationId: string;
  readonly stateDigest: string;
  readonly browserBindingDigest: string;
  readonly pkceVerifierSecretRef: string;
  readonly status: "PENDING" | "CLAIMED" | "COMPLETED" | "FAILED";
  readonly claimToken: string | null;
  readonly claimExpiresAt: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly completedAt: string | null;
  readonly failureCode: string | null;
}

export interface VerifiedGitHubIdentity {
  readonly githubUserId: number;
  readonly githubNodeId: string;
  readonly githubLogin: string;
  readonly displayName: string;
  readonly avatarUrl: string;
}

export interface StoredIdentityPrincipal extends VerifiedGitHubIdentity {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly tenantName: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly role: PlatformRole;
}

export interface IdentityStore {
  createInvitation(invitation: IdentityInvitation): Promise<void>;
  beginLogin(input: {
    readonly tenantId: string;
    readonly invitationTokenDigest: string;
    readonly intent: IdentityLoginIntent;
    readonly at: string;
  }): Promise<void>;
  claimLogin(input: {
    readonly tenantId: string;
    readonly stateDigest: string;
    readonly browserBindingDigest: string;
    readonly claimToken: string;
    readonly claimedAt: string;
    readonly claimExpiresAt: string;
  }): Promise<IdentityLoginIntent>;
  completeLogin(input: {
    readonly tenantId: string;
    readonly intentId: string;
    readonly claimToken: string;
    readonly identity: VerifiedGitHubIdentity;
    readonly session: {
      readonly id: string;
      readonly tokenDigest: string;
      readonly browserBindingDigest: string;
      readonly createdAt: string;
      readonly expiresAt: string;
    };
    readonly completedAt: string;
  }): Promise<StoredIdentityPrincipal>;
  failLogin(input: {
    readonly tenantId: string;
    readonly intentId: string;
    readonly claimToken: string;
    readonly failureCode: string;
    readonly failedAt: string;
  }): Promise<void>;
  resolveSession(input: {
    readonly tenantId: string;
    readonly tokenDigest: string;
    readonly browserBindingDigest: string;
    readonly at: string;
  }): Promise<StoredIdentityPrincipal>;
  revokeSession(input: {
    readonly tenantId: string;
    readonly tokenDigest: string;
    readonly browserBindingDigest: string;
    readonly revokedAt: string;
  }): Promise<boolean>;
}

export interface OneTimePkceSecretStore {
  put(value: string, expiresAt: string): Promise<string>;
  take(secretRef: string): Promise<string | null>;
  delete(secretRef: string): Promise<void>;
}

export interface GitHubIdentityVerifier {
  verify(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly at: string;
  }): Promise<VerifiedGitHubIdentity>;
}

export interface PlatformSessionAssertion extends StoredIdentityPrincipal {
  readonly sessionBinding: string;
  readonly issuedAt: string;
  readonly signature: string;
}
