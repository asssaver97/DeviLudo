export type GitHubAuthorizationStage = "INSTALL" | "OAUTH";
export type GitHubAuthorizationStatus = "PENDING" | "CLAIMED" | "COMPLETED" | "FAILED" | "EXPIRED";

export interface GitHubAuthorizationPrincipal {
  readonly tenantId: string;
  readonly userId: string;
  /** A high-entropy authenticated browser-session identifier. It is hashed before persistence. */
  readonly sessionBinding: string;
  /** Numeric GitHub user id already bound to the DeviLudo account. */
  readonly expectedGithubUserId: number;
}

export interface GitHubAuthorizationIntent {
  readonly id: string;
  readonly stateDigest: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionBindingDigest: string;
  readonly stage: GitHubAuthorizationStage;
  readonly installationId: string | null;
  readonly pkceVerifierSecretRef: string | null;
  readonly returnPath: string;
  readonly status: GitHubAuthorizationStatus;
  readonly claimToken: string | null;
  readonly claimExpiresAt: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly completedAt: string | null;
  readonly failureCode: string | null;
}

export interface GitHubVerifiedInstallation {
  readonly installationId: string;
  readonly githubUserId: number;
  readonly githubUserNodeId: string;
  readonly githubUserLogin: string;
  readonly accountNodeId: string;
  readonly accountLogin: string;
  readonly repositorySelection: "all" | "selected";
  readonly permissions: Readonly<Record<string, string>>;
  readonly appSlug: string;
  readonly verifiedAt: string;
}

export interface GitHubAuthorizationStore {
  create(intent: GitHubAuthorizationIntent): Promise<void>;
  claim(input: {
    readonly stateDigest: string;
    readonly stage: GitHubAuthorizationStage;
    readonly tenantId: string;
    readonly userId: string;
    readonly sessionBindingDigest: string;
    readonly claimToken: string;
    readonly claimedAt: string;
    readonly claimExpiresAt: string;
  }): Promise<GitHubAuthorizationIntent>;
  completeSetup(input: {
    readonly intentId: string;
    readonly claimToken: string;
    readonly oauthIntent: GitHubAuthorizationIntent;
    readonly completedAt: string;
  }): Promise<void>;
  completeOAuth(input: {
    readonly tenantId: string;
    readonly intentId: string;
    readonly claimToken: string;
    readonly installation: GitHubVerifiedInstallation;
    readonly completedAt: string;
  }): Promise<void>;
  fail(input: {
    readonly tenantId: string;
    readonly intentId: string;
    readonly claimToken: string;
    readonly failureCode: string;
    readonly failedAt: string;
  }): Promise<void>;
}

export interface GitHubAuthorizationSecretStore {
  put(value: string, expiresAt: string): Promise<string>;
  take(secretRef: string): Promise<string | null>;
  delete(secretRef: string): Promise<void>;
}

/** The implementation keeps the GitHub user token entirely inside this call. */
export interface GitHubUserAuthorizationVerifier {
  verify(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly installationId: string;
    readonly expectedGithubUserId: number;
    readonly at: string;
  }): Promise<GitHubVerifiedInstallation>;
}

export interface GitHubClientSecretLease {
  readonly value: string;
  destroy(): void;
}

export interface GitHubClientSecretResolver {
  resolve(secretRef: string): Promise<GitHubClientSecretLease>;
}
