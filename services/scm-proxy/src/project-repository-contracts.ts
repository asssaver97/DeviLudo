export interface ProjectRepositoryPrincipal {
  readonly tenantId: string;
  readonly userId: string;
  readonly githubUserId: number;
}

export interface AuthorizedGitHubInstallation {
  readonly installationRecordId: string;
  readonly installationId: string;
  readonly accountLogin: string;
}

export interface GitHubRepositoryCatalogItem {
  readonly installationId: string;
  readonly repositoryId: number;
  readonly repositoryNodeId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly archived: false;
  readonly disabled: false;
}

export interface ProjectRepositoryCatalogView {
  readonly installations: readonly Readonly<{
    installationId: string;
    accountLogin: string;
    repositories: readonly GitHubRepositoryCatalogItem[];
  }>[];
}

export interface CreateBoundProjectCommand {
  readonly idempotencyKey: string;
  readonly principal: ProjectRepositoryPrincipal;
  readonly slug: string;
  readonly name: string;
  readonly installationId: string;
  readonly repositoryId: number;
}

export interface BoundProjectReceipt {
  readonly projectId: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly repositoryBindingId: string;
  readonly installationId: string;
  readonly repositoryId: number;
  readonly repositoryNodeId: string;
  readonly owner: string;
  readonly repositoryName: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
}

export interface GitHubInstallationRepositoryCatalog {
  list(installationId: string): Promise<readonly GitHubRepositoryCatalogItem[]>;
}

export interface ProjectRepositoryOnboardingStore {
  authorizedInstallations(principal: ProjectRepositoryPrincipal): Promise<readonly AuthorizedGitHubInstallation[]>;
  claim(command: CreateBoundProjectCommand, requestDigest: string, claimToken: string): Promise<
    | { readonly kind: "ACQUIRED" }
    | { readonly kind: "BUSY" }
    | { readonly kind: "REPLAY"; readonly receipt: BoundProjectReceipt }
    | { readonly kind: "CONFLICT" }
  >;
  complete(input: {
    readonly command: CreateBoundProjectCommand;
    readonly requestDigest: string;
    readonly claimToken: string;
    readonly projectId: string;
    readonly repositoryBindingId: string;
    readonly repository: GitHubRepositoryCatalogItem;
    readonly createdAt: string;
  }): Promise<BoundProjectReceipt>;
  release(tenantId: string, idempotencyKey: string, claimToken: string): Promise<void>;
}
