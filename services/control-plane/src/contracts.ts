export const ADMIN_ROLES = [
  "PlatformAgentAdmin",
  "SecurityAdmin",
  "TenantAdmin",
  "ProjectOwner",
  "Auditor",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];
export type AgentKind = "claude-code" | "codex-cli";
export type ProfileScope = "platform" | "tenant" | "project";

export type AgentVersionState =
  | "DISCOVERED"
  | "VALIDATING"
  | "APPROVED"
  | "DEPRECATED"
  | "BLOCKED"
  | "REJECTED";

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

export type ProfileState =
  | "DRAFT"
  | "VALIDATING"
  | "READY"
  | "ACTIVE"
  | "SUPERSEDED"
  | "DEGRADED"
  | "DISABLED";

export interface AgentVersionRecord {
  readonly id: string;
  readonly agent: AgentKind;
  readonly version: string;
  state: AgentVersionState;
  readonly source: string;
  readonly sourceDigest: string;
  readonly releaseNotesUrl: string;
  integrity: string;
  signatureVerified: boolean;
  sbomRef: string;
  scan: "PASS" | "FAIL" | "PENDING";
  readonly catalogReceiptId: string;
  readonly catalogReceiptDigest: string;
  validationReceiptId: string | null;
  validationReceiptDigest: string | null;
  supplyChainEvidenceDigest: string | null;
  validatedAt: string | null;
  readonly discoveredAt: string;
}

export interface InstallationRecord {
  readonly id: string;
  readonly agent: AgentKind;
  readonly agentVersionId: string;
  readonly workerPool: string;
  imageDigest: string | null;
  workerImageId: string | null;
  readonly adapterVersion: string;
  buildReceiptId: string | null;
  buildReceiptDigest: string | null;
  readonly rollbackInstallationId: string | null;
  health: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  state: InstallationState;
  rolloutPercent: 0 | 5 | 25 | 100;
  previousRolloutPercent: 0 | 5 | 25 | 100;
  readonly selfUpdateDisabled: true;
  readonly createdAt: string;
  activatedAt: string | null;
  drainingAt: string | null;
  retiredAt: string | null;
  failure?: Readonly<{
    failureCode: string;
    evidenceDigest: string;
    failureReceiptId: string;
    failureReceiptDigest: string;
    failedAt: string;
  }>;
}

export interface ProviderRevisionRecord {
  readonly id: string;
  readonly revision: number;
  readonly agent: AgentKind;
  readonly protocol: "anthropic-messages" | "openai-responses";
  readonly baseUrl: string;
  readonly approvedPorts: readonly number[];
  readonly authentication: "bearer" | "x-api-key" | "authorization-bearer";
  readonly models: {
    readonly primaryModel: string;
    readonly planningModel: string;
    readonly smallFastModel: string;
    readonly subagentModel: string;
  };
  readonly pricing: {
    readonly inputUsdPerMillionTokens: number;
    readonly outputUsdPerMillionTokens: number;
  };
  readonly credentialVersionId: string;
  state: ProfileState;
  probe: Readonly<Record<string, "PASS" | "FAIL">>;
  readonly governance: {
    readonly dataRegion: string;
    readonly retentionPolicy: string;
    readonly trainingPolicy: string;
    readonly confirmedBy: string;
    readonly confirmedAt: string;
  };
}

export interface ProfileRevisionRecord {
  readonly id: string;
  readonly revision: number;
  readonly scope: ProfileScope;
  readonly scopeId: string;
  readonly agent: AgentKind;
  readonly installationId: string;
  readonly providerRevisionId: string;
  readonly credentialVersionId: string;
  readonly budget: { readonly maxUsd: number; readonly maxTurns: number; readonly timeoutSeconds: number };
  readonly fallbackProfileRevisionId: string | null;
  state: ProfileState;
  readonly createdAt: string;
}

export interface CredentialVersionRecord {
  readonly id: string;
  readonly familyId: string;
  readonly version: number;
  readonly label: string;
  readonly scope: "platform" | "tenant";
  readonly scopeId: string;
  readonly secretRef: string;
  readonly maskedFingerprint: string;
  state: "ACTIVE" | "PREVIOUS" | "REVOKED";
  readonly createdAt: string;
  /** Atomic completion time of the rotation that introduced or superseded this version. */
  rotatedAt: string | null;
  lastUsedAt: string | null;
  /** Internal crash-recovery binding. Public credential projectors omit it. */
  readonly rotation?: Readonly<{
    operationKey: string;
    sourceVersionId: string;
    bindings: readonly Readonly<{
      sourceProfileId: string;
      successorProfileId: string;
      sourceProviderId: string;
      successorProviderId: string;
      usesReplacement: boolean;
    }>[];
  }>;
}

export interface AuditRecord {
  readonly id: string;
  readonly action: string;
  readonly resource: string;
  /** Runtime security events are projected as System records; request RBAC remains AdminRole-only. */
  readonly actorRole: AdminRole | "System";
  readonly actorId: string;
  readonly tenantId: string | null;
  readonly projectId: string | null;
  readonly requestId: string;
  readonly at: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AgentUsageRecord {
  readonly requestId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly providerRevisionId: string;
  readonly credentialVersionId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly recordedAt: string;
}

export interface AgentUsageSummary {
  readonly available: boolean;
  readonly source: "inference_usage_events";
  readonly windowStartedAt: string;
  /** Actor-scoped all-time projection; raw credential catalog rows remain immutable. */
  readonly credentialLastUsedAt: Readonly<Record<string, string>>;
  readonly totals: Readonly<{
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
  readonly records: readonly AgentUsageRecord[];
}

export interface RequestActor {
  readonly role: AdminRole;
  readonly requestId: string;
  readonly actorId: string;
  readonly tenantId: string | null;
  readonly projectId: string | null;
  /** Present only after the mutation interceptor owns this exact request claim. */
  readonly mutation?: AdminMutationClaimBinding;
}

export interface AdminMutationClaimBinding {
  readonly identityDigest: string;
  readonly requestFingerprint: string;
  readonly claimToken: string;
}

export class ServiceProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export function isAgentKind(value: unknown): value is AgentKind {
  return value === "claude-code" || value === "codex-cli";
}

export function requiredString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 1000,
): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new ServiceProblem(400, "INVALID_FIELD", `${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ServiceProblem(400, "INVALID_FIELD", `${field} must be a string`, { field });
  }
  return value.trim();
}

export function assertAllowedFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowList = new Set(allowed);
  if (Object.keys(body).some((field) => !allowList.has(field))) {
    throw new ServiceProblem(
      400,
      "UNEXPECTED_FIELD",
      "Request body contains a field that is not part of this operation contract",
    );
  }
}
