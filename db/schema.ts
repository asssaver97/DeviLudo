import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  AgentKind,
  AgentRunState,
  AgentVersionState,
  E2EAttemptState,
  GameSpecState,
  InstallationState,
  IterationState,
  ProfileState,
  SteamReleaseState,
  TargetPlatform,
} from "@/lib/domain";

type JsonRecord = Record<string, unknown>;

/**
 * D1 schema for the hosted demonstration control plane. Production uses the
 * PostgreSQL/RLS schema in infra/postgres; service contracts are identical.
 */
export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  status: text("status", { enum: ["ACTIVE", "SUSPENDED"] }).notNull().default("ACTIVE"),
  createdAt: text("created_at").notNull(),
  version: integer("version").notNull().default(1),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  githubSubject: text("github_subject").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull(),
});

export const tenantMemberships = sqliteTable(
  "tenant_memberships",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role", { enum: ["TenantAdmin", "ProjectOwner", "Auditor"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("tenant_membership_unique").on(table.tenantId, table.userId)],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    githubInstallationId: text("github_installation_id"),
    githubRepositoryNodeId: text("github_repository_node_id"),
    defaultBranch: text("default_branch").notNull().default("main"),
    steamAppId: text("steam_app_id"),
    createdAt: text("created_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("project_tenant_slug_unique").on(table.tenantId, table.slug),
    index("project_tenant_idx").on(table.tenantId),
  ],
);

export const githubInstallations = sqliteTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    installationId: text("installation_id").notNull(),
    accountNodeId: text("account_node_id").notNull(),
    accountLogin: text("account_login").notNull(),
    repositorySelection: text("repository_selection", { enum: ["all", "selected"] }).notNull(),
    permissions: text("permissions", { mode: "json" }).$type<JsonRecord>().notNull(),
    status: text("status", { enum: ["PENDING_VERIFICATION", "ACTIVE", "SUSPENDED", "REVOKED"] }).notNull(),
    verifiedAt: text("verified_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("github_installation_tenant_unique").on(table.tenantId, table.installationId),
    index("github_installation_status_idx").on(table.tenantId, table.status),
  ],
);

export const githubRepositoryBindings = sqliteTable(
  "github_repository_bindings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    githubInstallationId: text("github_installation_id").notNull().references(() => githubInstallations.id),
    repositoryId: integer("repository_id").notNull(),
    repositoryNodeId: text("repository_node_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    status: text("status", { enum: ["ACTIVE", "REVOKED", "MISSING_PERMISSION"] }).notNull(),
    boundAt: text("bound_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("github_repository_project_unique").on(table.projectId),
    uniqueIndex("github_repository_tenant_node_unique").on(table.tenantId, table.repositoryNodeId),
    index("github_repository_installation_idx").on(table.githubInstallationId, table.status),
  ],
);

export const gameSpecRevisions = sqliteTable(
  "game_spec_revisions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    revision: integer("revision").notNull(),
    previousRevisionId: text("previous_revision_id"),
    state: text("state").$type<GameSpecState>().notNull(),
    content: text("content", { mode: "json" }).$type<JsonRecord>().notNull(),
    contentDigest: text("content_digest").notNull(),
    testPlanDigest: text("test_plan_digest").notNull(),
    targetMatrix: text("target_matrix", { mode: "json" }).$type<TargetPlatform[]>().notNull(),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: text("created_at").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: text("approved_at"),
  },
  (table) => [
    uniqueIndex("spec_project_revision_unique").on(table.projectId, table.revision),
    uniqueIndex("spec_project_digest_unique").on(table.projectId, table.contentDigest),
    index("spec_tenant_project_idx").on(table.tenantId, table.projectId),
  ],
);

export const gameIterations = sqliteTable(
  "game_iterations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    iterationNumber: integer("iteration_number").notNull(),
    previousIterationId: text("previous_iteration_id"),
    specRevisionId: text("spec_revision_id").notNull().references(() => gameSpecRevisions.id),
    specDigest: text("spec_digest").notNull(),
    candidateBranch: text("candidate_branch").notNull(),
    candidateCommitSha: text("candidate_commit_sha").notNull(),
    draftPullRequestUrl: text("draft_pull_request_url").notNull(),
    feedback: text("feedback"),
    state: text("state").$type<IterationState>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("iteration_project_number_unique").on(table.projectId, table.iterationNumber),
    index("iteration_tenant_project_idx").on(table.tenantId, table.projectId),
  ],
);

export const agentRegistries = sqliteTable("agent_registries", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<AgentKind>().notNull().unique(),
  vendor: text("vendor").notNull(),
  displayName: text("display_name").notNull(),
  officialSource: text("official_source").notNull(),
  adapterId: text("adapter_id").notNull(),
  configurationSchemaVersion: text("configuration_schema_version").notNull(),
  capabilities: text("capabilities", { mode: "json" }).$type<string[]>().notNull(),
  supportedWorkerPlatforms: text("supported_worker_platforms", { mode: "json" }).$type<string[]>().notNull(),
});

export const agentVersions = sqliteTable(
  "agent_versions",
  {
    id: text("id").primaryKey(),
    registryId: text("registry_id").notNull().references(() => agentRegistries.id),
    exactVersion: text("exact_version").notNull(),
    sourceUrl: text("source_url").notNull(),
    packageIntegrity: text("package_integrity").notNull(),
    sha256: text("sha256").notNull(),
    signatureVerified: integer("signature_verified", { mode: "boolean" }).notNull().default(false),
    sbomDigest: text("sbom_digest"),
    vulnerabilityReportDigest: text("vulnerability_report_digest"),
    adapterMinVersion: text("adapter_min_version").notNull(),
    adapterMaxExclusiveVersion: text("adapter_max_exclusive_version").notNull(),
    releaseNotesUrl: text("release_notes_url").notNull(),
    state: text("state").$type<AgentVersionState>().notNull(),
    discoveredAt: text("discovered_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [uniqueIndex("agent_exact_version_unique").on(table.registryId, table.exactVersion)],
);

export const workerImages = sqliteTable("worker_images", {
  id: text("id").primaryKey(),
  agentVersionId: text("agent_version_id").notNull().references(() => agentVersions.id),
  exactAgentVersion: text("exact_agent_version").notNull(),
  adapterVersion: text("adapter_version").notNull(),
  baseImageDigest: text("base_image_digest").notNull(),
  imageDigest: text("image_digest").notNull().unique(),
  sbomDigest: text("sbom_digest").notNull(),
  scanDigest: text("scan_digest").notNull(),
  builtAt: text("built_at").notNull(),
});

export const agentInstallations = sqliteTable(
  "agent_installations",
  {
    id: text("id").primaryKey(),
    registryId: text("registry_id").notNull().references(() => agentRegistries.id),
    agentVersionId: text("agent_version_id").notNull().references(() => agentVersions.id),
    workerImageId: text("worker_image_id").notNull().references(() => workerImages.id),
    imageDigest: text("image_digest").notNull(),
    workerPool: text("worker_pool").notNull(),
    rolloutPercent: integer("rollout_percent").notNull().default(0),
    rollbackInstallationId: text("rollback_installation_id"),
    health: text("health", { enum: ["UNKNOWN", "HEALTHY", "UNHEALTHY"] }).notNull().default("UNKNOWN"),
    state: text("state").$type<InstallationState>().notNull(),
    createdAt: text("created_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("installation_pool_state_idx").on(table.workerPool, table.state)],
);

export const providerRevisions = sqliteTable(
  "provider_revisions",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    revision: integer("revision").notNull(),
    tenantId: text("tenant_id").references(() => tenants.id),
    projectId: text("project_id").references(() => projects.id),
    agentKind: text("agent_kind").$type<AgentKind>().notNull(),
    protocol: text("protocol", { enum: ["anthropic-messages", "openai-responses"] }).notNull(),
    baseUrl: text("base_url").notNull(),
    modelRoles: text("model_roles", { mode: "json" }).$type<Record<string, string>>().notNull(),
    credentialBindingId: text("credential_binding_id").notNull(),
    credentialVersionId: text("credential_version_id").notNull(),
    compliance: text("compliance", { mode: "json" }).$type<JsonRecord>().notNull(),
    securityApprovalId: text("security_approval_id"),
    probeEvidenceDigest: text("probe_evidence_digest").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("provider_revision_unique").on(table.providerId, table.revision)],
);

export const credentialVersions = sqliteTable(
  "credential_versions",
  {
    id: text("id").primaryKey(),
    bindingId: text("binding_id").notNull(),
    tenantId: text("tenant_id").references(() => tenants.id),
    projectId: text("project_id").references(() => projects.id),
    secretRef: text("secret_ref").notNull(),
    fingerprint: text("fingerprint").notNull(),
    maskedValue: text("masked_value").notNull(),
    status: text("status", { enum: ["ACTIVE", "ROTATING", "REVOKED"] }).notNull(),
    createdAt: text("created_at").notNull(),
    rotatedAt: text("rotated_at"),
    revokedAt: text("revoked_at"),
    lastUsedAt: text("last_used_at"),
  },
  (table) => [uniqueIndex("credential_binding_fingerprint_unique").on(table.bindingId, table.fingerprint)],
);

export const agentProfileRevisions = sqliteTable(
  "agent_profile_revisions",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull(),
    revision: integer("revision").notNull(),
    scope: text("scope", { enum: ["PLATFORM", "TENANT", "PROJECT"] }).notNull(),
    scopeId: text("scope_id").notNull(),
    agentKind: text("agent_kind").$type<AgentKind>().notNull(),
    installationId: text("installation_id").notNull().references(() => agentInstallations.id),
    providerRevisionId: text("provider_revision_id").notNull().references(() => providerRevisions.id),
    modelRoles: text("model_roles", { mode: "json" }).$type<Record<string, string>>().notNull(),
    credentialBindingId: text("credential_binding_id").notNull(),
    credentialVersionId: text("credential_version_id").notNull().references(() => credentialVersions.id),
    permissions: text("permissions", { mode: "json" }).$type<JsonRecord>().notNull(),
    budget: text("budget", { mode: "json" }).$type<JsonRecord>().notNull(),
    fallbackProfileRevisionId: text("fallback_profile_revision_id"),
    state: text("state").$type<ProfileState>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("profile_revision_unique").on(table.profileId, table.revision),
    index("profile_scope_state_idx").on(table.scope, table.scopeId, table.state),
  ],
);

export const agentDefaults = sqliteTable(
  "agent_defaults",
  {
    id: text("id").primaryKey(),
    scope: text("scope", { enum: ["PLATFORM", "TENANT", "PROJECT"] }).notNull(),
    scopeId: text("scope_id").notNull(),
    profileRevisionId: text("profile_revision_id").notNull().references(() => agentProfileRevisions.id),
    policy: text("policy", { mode: "json" }).$type<JsonRecord>().notNull(),
    explicitlyAllowedFallbacks: text("explicitly_allowed_fallbacks", { mode: "json" }).$type<string[]>().notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("agent_default_scope_unique").on(table.scope, table.scopeId)],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    iterationId: text("iteration_id").notNull().references(() => gameIterations.id),
    idempotencyKey: text("idempotency_key").notNull(),
    profileRevisionId: text("profile_revision_id").notNull().references(() => agentProfileRevisions.id),
    installationId: text("installation_id").notNull().references(() => agentInstallations.id),
    imageDigest: text("image_digest").notNull(),
    exactAgentVersion: text("exact_agent_version").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    providerRevisionId: text("provider_revision_id").notNull().references(() => providerRevisions.id),
    model: text("model").notNull(),
    credentialVersionId: text("credential_version_id").notNull().references(() => credentialVersions.id),
    configurationLock: text("configuration_lock", { mode: "json" }).$type<JsonRecord>().notNull(),
    resolutionDigest: text("resolution_digest").notNull(),
    state: text("state").$type<AgentRunState>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_run_idempotency_unique").on(table.tenantId, table.idempotencyKey),
    index("agent_run_project_state_idx").on(table.tenantId, table.projectId, table.state),
  ],
);

export const e2eAttempts = sqliteTable(
  "e2e_attempts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    runId: text("run_id").notNull().references(() => agentRuns.id),
    iterationId: text("iteration_id").notNull().references(() => gameIterations.id),
    attemptNumber: integer("attempt_number").notNull(),
    runnerId: text("runner_id"),
    fencingToken: integer("fencing_token").notNull(),
    lastSeqNo: integer("last_seq_no").notNull().default(0),
    commitSha: text("commit_sha").notNull(),
    sourceDigest: text("source_digest").notNull(),
    specRevisionId: text("spec_revision_id").notNull().references(() => gameSpecRevisions.id),
    specDigest: text("spec_digest").notNull(),
    testPlanDigest: text("test_plan_digest").notNull(),
    targetMatrix: text("target_matrix", { mode: "json" }).$type<TargetPlatform[]>().notNull(),
    leaseExpiresAt: text("lease_expires_at"),
    state: text("state").$type<E2EAttemptState>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("e2e_run_attempt_unique").on(table.runId, table.attemptNumber),
    uniqueIndex("e2e_fencing_unique").on(table.id, table.fencingToken),
    index("e2e_lease_idx").on(table.state, table.leaseExpiresAt),
  ],
);

export const runnerEvents = sqliteTable(
  "runner_events",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id").notNull().references(() => e2eAttempts.id),
    fencingToken: integer("fencing_token").notNull(),
    seqNo: integer("seq_no").notNull(),
    commitSha: text("commit_sha").notNull(),
    sourceDigest: text("source_digest").notNull(),
    platform: text("platform").$type<TargetPlatform>().notNull(),
    eventType: text("event_type").notNull(),
    status: text("status", { enum: ["RUNNING", "PASSED", "FAILED"] }).notNull(),
    artifactDigest: text("artifact_digest"),
    occurredAt: text("occurred_at").notNull(),
    receivedAt: text("received_at").notNull(),
  },
  (table) => [uniqueIndex("runner_event_seq_unique").on(table.attemptId, table.fencingToken, table.seqNo)],
);

/**
 * Production-shaped Runner records. The older `runner_events` table above is
 * retained only for the read-only hosted demo projection; real matrix jobs use
 * one immutable lease generation and event stream per target platform.
 */
export const runnerRegistrations = sqliteTable(
  "runner_registrations",
  {
    id: text("id").primaryKey(),
    spiffeId: text("spiffe_id").notNull(),
    certificateFingerprint: text("certificate_fingerprint").notNull(),
    certificateSerial: text("certificate_serial").notNull(),
    certificateNotAfter: text("certificate_not_after").notNull(),
    platform: text("platform").$type<TargetPlatform>().notNull(),
    architecture: text("architecture", { enum: ["x86_64", "arm64"] }).notNull(),
    capabilityDigest: text("capability_digest").notNull(),
    capabilities: text("capabilities", { mode: "json" }).$type<JsonRecord>().notNull(),
    state: text("state", { enum: ["ONLINE", "DRAINING", "OFFLINE", "QUARANTINED"] }).notNull(),
    registeredAt: text("registered_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    uniqueIndex("runner_spiffe_unique").on(table.spiffeId),
    uniqueIndex("runner_certificate_unique").on(table.certificateFingerprint),
    index("runner_platform_state_idx").on(table.platform, table.state),
  ],
);

export const e2ePlatformLeases = sqliteTable(
  "e2e_platform_leases",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    attemptId: text("attempt_id").notNull().references(() => e2eAttempts.id),
    platform: text("platform").$type<TargetPlatform>().notNull(),
    runnerId: text("runner_id").notNull().references(() => runnerRegistrations.id),
    fencingToken: integer("fencing_token").notNull(),
    leaseExpiresAt: text("lease_expires_at").notNull(),
    lastSeqNo: integer("last_seq_no").notNull().default(0),
    cursor: text("cursor", { mode: "json" }).$type<JsonRecord>().notNull(),
    jobDigest: text("job_digest").notNull(),
    jobSignature: text("job_signature").notNull(),
    evidenceManifestDigest: text("evidence_manifest_digest"),
    state: text("state", { enum: ["LEASED", "RUNNING", "PASSED", "FAILED", "EXPIRED", "INVALIDATED"] }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("e2e_platform_fencing_unique").on(table.attemptId, table.platform, table.fencingToken),
    index("e2e_platform_active_lease_idx").on(table.attemptId, table.platform, table.state),
    index("e2e_platform_runner_lease_idx").on(table.runnerId, table.state, table.leaseExpiresAt),
  ],
);

export const platformRunnerEvents = sqliteTable(
  "platform_runner_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    attemptId: text("attempt_id").notNull().references(() => e2eAttempts.id),
    platformLeaseId: text("platform_lease_id").notNull().references(() => e2ePlatformLeases.id),
    runnerId: text("runner_id").notNull().references(() => runnerRegistrations.id),
    platform: text("platform").$type<TargetPlatform>().notNull(),
    fencingToken: integer("fencing_token").notNull(),
    seqNo: integer("seq_no").notNull(),
    commitSha: text("commit_sha").notNull(),
    sourceDigest: text("source_digest").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status", { enum: ["RUNNING", "PASSED", "FAILED"] }).notNull(),
    artifactDigest: text("artifact_digest"),
    occurredAt: text("occurred_at").notNull(),
    receivedAt: text("received_at").notNull(),
  },
  (table) => [
    uniqueIndex("platform_runner_event_seq_unique").on(table.platformLeaseId, table.seqNo),
    index("platform_runner_event_attempt_idx").on(table.attemptId, table.platform, table.fencingToken),
  ],
);

export const scmOperationClaims = sqliteTable(
  "scm_operation_claims",
  {
    key: text("key").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    operation: text("operation", { enum: ["PUBLISH_CANDIDATE", "MERGE_ACCEPTED_CANDIDATE"] }).notNull(),
    requestDigest: text("request_digest").notNull(),
    claimToken: text("claim_token").notNull(),
    claimExpiresAt: text("claim_expires_at").notNull(),
    response: text("response", { mode: "json" }).$type<JsonRecord>(),
    authorizedAt: text("authorized_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [index("scm_operation_active_claim_idx").on(table.tenantId, table.projectId, table.claimExpiresAt)],
);

export const githubCandidateReceipts = sqliteTable(
  "github_candidate_receipts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    specRevisionId: text("spec_revision_id").notNull().references(() => gameSpecRevisions.id),
    repositoryBindingId: text("repository_binding_id").notNull().references(() => githubRepositoryBindings.id),
    artifactDigest: text("artifact_digest").notNull(),
    baseCommitSha: text("base_commit_sha").notNull(),
    candidateBranch: text("candidate_branch").notNull(),
    candidateCommitSha: text("candidate_commit_sha").notNull(),
    sourceDigest: text("source_digest").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    pullRequestNodeId: text("pull_request_node_id").notNull(),
    pullRequestUrl: text("pull_request_url").notNull(),
    receipt: text("receipt", { mode: "json" }).$type<JsonRecord>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("github_candidate_attempt_unique").on(table.attemptId),
    uniqueIndex("github_candidate_pr_unique").on(table.repositoryBindingId, table.pullRequestNumber),
    index("github_candidate_project_commit_idx").on(table.projectId, table.candidateCommitSha),
  ],
);

export const githubMergeReceipts = sqliteTable(
  "github_merge_receipts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    candidateReceiptId: text("candidate_receipt_id").notNull().references(() => githubCandidateReceipts.id),
    acceptanceNonce: text("acceptance_nonce").notNull(),
    evidenceBundleDigest: text("evidence_bundle_digest").notNull(),
    candidateCommitSha: text("candidate_commit_sha").notNull(),
    mergeCommitSha: text("merge_commit_sha").notNull(),
    defaultBranchHeadSha: text("default_branch_head_sha").notNull(),
    requiresFreshMainSnapshot: integer("requires_fresh_main_snapshot", { mode: "boolean" }).notNull(),
    receipt: text("receipt", { mode: "json" }).$type<JsonRecord>().notNull(),
    mergedAt: text("merged_at").notNull(),
  },
  (table) => [
    uniqueIndex("github_merge_candidate_unique").on(table.candidateReceiptId),
    uniqueIndex("github_merge_acceptance_nonce_unique").on(table.tenantId, table.acceptanceNonce),
    index("github_merge_project_commit_idx").on(table.projectId, table.mergeCommitSha),
  ],
);

export const evidenceBundles = sqliteTable(
  "evidence_bundles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    attemptId: text("attempt_id").notNull().references(() => e2eAttempts.id),
    specRevisionId: text("spec_revision_id").notNull().references(() => gameSpecRevisions.id),
    specDigest: text("spec_digest").notNull(),
    testPlanDigest: text("test_plan_digest").notNull(),
    commitSha: text("commit_sha").notNull(),
    sourceDigest: text("source_digest").notNull(),
    targetMatrix: text("target_matrix", { mode: "json" }).$type<TargetPlatform[]>().notNull(),
    manifest: text("manifest", { mode: "json" }).$type<JsonRecord>().notNull(),
    bundleDigest: text("bundle_digest").notNull().unique(),
    status: text("status", { enum: ["PASSED", "FAILED"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("evidence_project_commit_idx").on(table.projectId, table.commitSha)],
);

export const evidenceInvalidations = sqliteTable("evidence_invalidations", {
  id: text("id").primaryKey(),
  evidenceBundleId: text("evidence_bundle_id").notNull().references(() => evidenceBundles.id),
  iterationId: text("iteration_id").notNull().references(() => gameIterations.id),
  reason: text("reason").notNull(),
  invalidatedBy: text("invalidated_by").notNull(),
  invalidatedAt: text("invalidated_at").notNull(),
});

export const steamReleases = sqliteTable(
  "steam_releases",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    mainCommitSha: text("main_commit_sha").notNull(),
    sourceDigest: text("source_digest").notNull(),
    evidenceBundleId: text("evidence_bundle_id").notNull().references(() => evidenceBundles.id),
    targetMatrix: text("target_matrix", { mode: "json" }).$type<TargetPlatform[]>().notNull(),
    steamAppId: text("steam_app_id").notNull(),
    steamSessionSecretRef: text("steam_session_secret_ref").notNull(),
    betaBranch: text("beta_branch").notNull(),
    mfaApprovalId: text("mfa_approval_id").notNull(),
    state: text("state").$type<SteamReleaseState>().notNull(),
    externalGate: text("external_gate").notNull().default("NONE"),
    createdAt: text("created_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("steam_release_project_state_idx").on(table.projectId, table.state)],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id),
    projectId: text("project_id").references(() => projects.id),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    requestId: text("request_id").notNull(),
    idempotencyKey: text("idempotency_key"),
    beforeDigest: text("before_digest"),
    afterDigest: text("after_digest"),
    metadata: text("metadata", { mode: "json" }).$type<JsonRecord>().notNull(),
    previousEventHash: text("previous_event_hash"),
    eventHash: text("event_hash").notNull().unique(),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [index("audit_tenant_time_idx").on(table.tenantId, table.occurredAt)],
);

export const idempotencyRecords = sqliteTable(
  "idempotency_records",
  {
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    key: text("key").notNull(),
    requestDigest: text("request_digest").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body", { mode: "json" }).$type<JsonRecord>().notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [uniqueIndex("idempotency_tenant_key_unique").on(table.tenantId, table.key)],
);

export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id),
    topic: text("topic").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: text("payload", { mode: "json" }).$type<JsonRecord>().notNull(),
    createdAt: text("created_at").notNull(),
    publishedAt: text("published_at"),
  },
  (table) => [index("outbox_unpublished_idx").on(table.publishedAt, table.createdAt)],
);

/**
 * Local-first delivery projection used by the localhost test environment.
 * Production continues to use the normalized aggregates above; this compact
 * projection lets the complete workflow be exercised without Docker or
 * external credentials while remaining durable across browser refreshes.
 */
export const localDeliverySnapshots = sqliteTable("local_delivery_snapshots", {
  projectId: text("project_id").primaryKey(),
  revision: integer("revision").notNull(),
  snapshot: text("snapshot", { mode: "json" }).$type<JsonRecord>().notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const localDeliveryEvents = sqliteTable(
  "local_delivery_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    revision: integer("revision").notNull(),
    eventType: text("event_type").notNull(),
    payload: text("payload", { mode: "json" }).$type<JsonRecord>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("local_delivery_event_revision_unique").on(table.projectId, table.revision),
    index("local_delivery_event_project_time_idx").on(table.projectId, table.createdAt),
  ],
);

export const localDeliveryCommands = sqliteTable("local_delivery_commands", {
  key: text("key").primaryKey(),
  projectId: text("project_id").notNull(),
  response: text("response", { mode: "json" }).$type<JsonRecord>().notNull(),
  createdAt: text("created_at").notNull(),
});
