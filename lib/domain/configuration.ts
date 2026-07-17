import { DomainError, invariant } from "./errors";
import type {
  AgentInstallation,
  AgentProfileRevision,
  AgentRunConfigurationLock,
  ModelRoleMap,
  ProviderRevision,
  WorkerImage,
} from "./aggregates";
import { assertGitSha, assertSha256, deepFreeze, uniqueSorted, type AgentKind, type DeepReadonly, type EntityId, type ISODateTime, type Sha256, type TargetPlatform } from "./types";

export interface SecurityPolicy {
  readonly allowedAgentKinds: readonly AgentKind[];
  readonly allowedProviderIds: readonly EntityId[];
  readonly allowedTargetPlatforms: readonly TargetPlatform[];
  readonly maxBudgetUsd: number;
  readonly maxTurns: number;
  readonly maxTimeoutSeconds: number;
  readonly maxWorkspaceBytes: number;
  readonly requireSignedImages: boolean;
  readonly requireExactModels: boolean;
  readonly requireHttpsProviders: boolean;
  readonly gatewayOnlyEgress: boolean;
  readonly forbidDangerousBypass: boolean;
}

export interface ConfigurationScope {
  readonly scope: "PLATFORM" | "TENANT" | "PROJECT";
  readonly scopeId: EntityId;
  readonly selectedProfileRevisionId: EntityId | null;
  readonly explicitlyAllowedFallbackProfileRevisionIds: readonly EntityId[];
  readonly policy: Partial<SecurityPolicy>;
}

export interface EffectiveAgentConfiguration {
  readonly selectedProfile: AgentProfileRevision;
  readonly effectivePolicy: SecurityPolicy;
  readonly selectedAtScope: "PROJECT" | "TENANT" | "PLATFORM" | "BUILT_IN_DEFAULT";
  readonly sourceTrace: readonly string[];
  readonly permittedFallbackProfileRevisionIds: readonly EntityId[];
}

const DEFAULT_PLATFORM_POLICY: SecurityPolicy = Object.freeze({
  allowedAgentKinds: ["claude-code", "codex-cli"] as const,
  // "*" means any Provider revision already approved by SecurityAdmin. Tenant
  // and project scopes can replace it with a narrower explicit list.
  allowedProviderIds: ["*"] as const,
  allowedTargetPlatforms: ["windows", "linux", "macos"] as const,
  maxBudgetUsd: 100,
  maxTurns: 200,
  maxTimeoutSeconds: 14_400,
  maxWorkspaceBytes: 4 * 1024 * 1024 * 1024,
  requireSignedImages: true,
  requireExactModels: true,
  requireHttpsProviders: true,
  gatewayOnlyEgress: true,
  forbidDangerousBypass: true,
});

function intersection<T extends string>(upper: readonly T[], lower?: readonly T[]): readonly T[] {
  if (!lower) return uniqueSorted(upper);
  if (upper.includes("*" as T)) return uniqueSorted(lower);
  if (lower.includes("*" as T)) return uniqueSorted(upper);
  const allowed = new Set(upper);
  return uniqueSorted(lower.filter((value) => allowed.has(value)));
}

/**
 * Lower scopes may only constrain an inherited policy. Numeric limits use min,
 * allow-lists use intersection, and mandatory protections use logical OR.
 */
export function constrainPolicy(upper: SecurityPolicy, requested: Partial<SecurityPolicy>): SecurityPolicy {
  const constrained: SecurityPolicy = {
    allowedAgentKinds: intersection(upper.allowedAgentKinds, requested.allowedAgentKinds),
    allowedProviderIds: intersection(upper.allowedProviderIds, requested.allowedProviderIds),
    allowedTargetPlatforms: intersection(upper.allowedTargetPlatforms, requested.allowedTargetPlatforms),
    maxBudgetUsd: Math.min(upper.maxBudgetUsd, requested.maxBudgetUsd ?? upper.maxBudgetUsd),
    maxTurns: Math.min(upper.maxTurns, requested.maxTurns ?? upper.maxTurns),
    maxTimeoutSeconds: Math.min(upper.maxTimeoutSeconds, requested.maxTimeoutSeconds ?? upper.maxTimeoutSeconds),
    maxWorkspaceBytes: Math.min(upper.maxWorkspaceBytes, requested.maxWorkspaceBytes ?? upper.maxWorkspaceBytes),
    requireSignedImages: upper.requireSignedImages || Boolean(requested.requireSignedImages),
    requireExactModels: upper.requireExactModels || Boolean(requested.requireExactModels),
    requireHttpsProviders: upper.requireHttpsProviders || Boolean(requested.requireHttpsProviders),
    gatewayOnlyEgress: upper.gatewayOnlyEgress || Boolean(requested.gatewayOnlyEgress),
    forbidDangerousBypass: upper.forbidDangerousBypass || Boolean(requested.forbidDangerousBypass),
  };

  invariant(constrained.allowedAgentKinds.length > 0, "Policy leaves no permitted Agent");
  invariant(constrained.allowedProviderIds.length > 0, "Policy leaves no permitted Provider");
  invariant(constrained.allowedTargetPlatforms.length > 0, "Policy leaves no target platform");
  invariant(constrained.maxBudgetUsd >= 0, "Budget cannot be negative");
  invariant(constrained.maxTurns > 0, "maxTurns must be positive");
  invariant(constrained.maxTimeoutSeconds > 0, "Timeout must be positive");
  return Object.freeze(constrained);
}

export function isFloatingModelAlias(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    /(^|[-_/.])(latest|default|stable)(?:$|[-_/.])/.test(normalized) ||
    /^(sonnet|opus|haiku)$/.test(normalized)
  );
}

export function assertExactModelMap(models: ModelRoleMap): void {
  for (const [role, model] of Object.entries(models)) {
    if (isFloatingModelAlias(model)) {
      throw new DomainError("FLOATING_VERSION", `${role} must resolve to an exact model ID`, { role, model });
    }
  }
}

function selectProfileId(
  platform: ConfigurationScope,
  tenant: ConfigurationScope | null,
  project: ConfigurationScope | null,
): { id: EntityId | null; source: EffectiveAgentConfiguration["selectedAtScope"] } {
  if (project?.selectedProfileRevisionId) return { id: project.selectedProfileRevisionId, source: "PROJECT" };
  if (tenant?.selectedProfileRevisionId) return { id: tenant.selectedProfileRevisionId, source: "TENANT" };
  if (platform.selectedProfileRevisionId) return { id: platform.selectedProfileRevisionId, source: "PLATFORM" };
  return { id: null, source: "BUILT_IN_DEFAULT" };
}

export interface ResolveConfigurationInput {
  readonly platform: ConfigurationScope;
  readonly tenant?: ConfigurationScope | null;
  readonly project?: ConfigurationScope | null;
  readonly profiles: Readonly<Record<EntityId, AgentProfileRevision>>;
}

/** Resolve once at enqueue. Runtime configuration changes never re-resolve a queued run. */
export function resolveAgentConfiguration(input: ResolveConfigurationInput): DeepReadonly<EffectiveAgentConfiguration> {
  const platformBase: SecurityPolicy = {
    ...DEFAULT_PLATFORM_POLICY,
    ...input.platform.policy,
    allowedAgentKinds: input.platform.policy.allowedAgentKinds ?? DEFAULT_PLATFORM_POLICY.allowedAgentKinds,
    allowedProviderIds: input.platform.policy.allowedProviderIds ?? DEFAULT_PLATFORM_POLICY.allowedProviderIds,
    allowedTargetPlatforms: input.platform.policy.allowedTargetPlatforms ?? DEFAULT_PLATFORM_POLICY.allowedTargetPlatforms,
    requireSignedImages: true,
    requireExactModels: true,
    requireHttpsProviders: true,
    gatewayOnlyEgress: true,
    forbidDangerousBypass: true,
  };
  let policy = Object.freeze(platformBase);
  const trace = [`PLATFORM:${input.platform.scopeId}`];
  if (input.tenant) {
    policy = constrainPolicy(policy, input.tenant.policy);
    trace.push(`TENANT:${input.tenant.scopeId}`);
  }
  if (input.project) {
    policy = constrainPolicy(policy, input.project.policy);
    trace.push(`PROJECT:${input.project.scopeId}`);
  }

  const selection = selectProfileId(input.platform, input.tenant ?? null, input.project ?? null);
  let selected: AgentProfileRevision | undefined;
  if (selection.id) {
    selected = input.profiles[selection.id];
    if (!selected) {
      throw new DomainError("PROFILE_NOT_FOUND", "The explicitly selected Profile revision does not exist", {
        profileRevisionId: selection.id,
      });
    }
  } else {
    selected = Object.values(input.profiles).find(
      (profile) => profile.agentKind === "claude-code" && profile.scope === "PLATFORM" && profile.state === "ACTIVE",
    );
  }
  if (!selected) {
    throw new DomainError("PROFILE_NOT_FOUND", "No selected Profile and no active platform Claude Code default");
  }
  if (selected.state !== "ACTIVE") {
    throw new DomainError("PROFILE_NOT_ACTIVE", "Only an active Profile can be resolved", {
      profileRevisionId: selected.id,
      state: selected.state,
    });
  }
  if (!policy.allowedAgentKinds.includes(selected.agentKind)) {
    throw new DomainError("POLICY_ESCALATION", "Selected Agent is outside the effective allow-list", {
      agentKind: selected.agentKind,
    });
  }
  if (selected.budget.maxUsd > policy.maxBudgetUsd || selected.budget.maxTurns > policy.maxTurns || selected.budget.timeoutSeconds > policy.maxTimeoutSeconds) {
    throw new DomainError("POLICY_ESCALATION", "Selected Profile exceeds the effective budget or timeout cap");
  }
  if (policy.requireExactModels) assertExactModelMap(selected.modelRoles);
  invariant(selected.permissions.workspaceWrite, "Development Profiles require workspace-write");
  invariant(selected.permissions.networkThroughGatewayOnly, "Profiles must route inference through the gateway");
  invariant(!selected.permissions.allowDangerousBypass, "Dangerous permission bypass is forbidden");

  const fallbackLists = [
    input.platform.explicitlyAllowedFallbackProfileRevisionIds,
    input.tenant?.explicitlyAllowedFallbackProfileRevisionIds,
    input.project?.explicitlyAllowedFallbackProfileRevisionIds,
  ].filter((list): list is readonly string[] => Boolean(list));
  const permittedFallbacks = fallbackLists.length
    ? fallbackLists.reduce((current, list) => intersection(current, list))
    : [];

  return deepFreeze({
    selectedProfile: selected,
    effectivePolicy: policy,
    selectedAtScope: selection.id ? selection.source : "BUILT_IN_DEFAULT",
    sourceTrace: trace,
    permittedFallbackProfileRevisionIds: permittedFallbacks,
  });
}

export interface LockAgentRunInput {
  readonly effective: EffectiveAgentConfiguration;
  readonly provider: ProviderRevision;
  readonly installation: AgentInstallation;
  readonly image: WorkerImage;
  readonly specRevisionId: EntityId;
  readonly specDigest: Sha256;
  readonly testPlanDigest: Sha256;
  readonly commitSha: string;
  readonly sourceDigest: Sha256;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly resolvedAt: ISODateTime;
  readonly resolutionDigest: Sha256;
}

/** Materialize every indirect reference; a queued task never follows moving defaults. */
export function lockAgentRunConfiguration(input: LockAgentRunInput): DeepReadonly<AgentRunConfigurationLock> {
  const profile = input.effective.selectedProfile;
  assertGitSha(input.commitSha);
  assertSha256(input.specDigest, "specDigest");
  assertSha256(input.testPlanDigest, "testPlanDigest");
  assertSha256(input.sourceDigest, "sourceDigest");
  assertSha256(input.resolutionDigest, "resolutionDigest");
  invariant(input.installation.id === profile.installationId, "Profile installation mismatch");
  invariant(input.installation.state === "ACTIVE" || input.installation.state === "CANARY", "Installation cannot accept new work");
  invariant(input.image.id === input.installation.workerImageId, "Installation image mismatch");
  invariant(input.image.imageDigest === input.installation.imageDigest, "Image digest mismatch");
  invariant(input.provider.id === profile.providerRevisionId, "Provider revision mismatch");
  invariant(
    input.effective.effectivePolicy.allowedProviderIds.includes("*") ||
      input.effective.effectivePolicy.allowedProviderIds.includes(input.provider.providerId),
    "Provider is outside the effective allow-list",
  );
  invariant(new URL(input.provider.baseUrl).protocol === "https:", "Provider must use HTTPS");
  invariant(input.provider.credentialVersionId === profile.credentialVersionId, "Credential version mismatch");
  invariant(input.provider.credentialBindingId === profile.credentialBindingId, "Credential binding mismatch");
  invariant(input.provider.agentKind === profile.agentKind, "Provider protocol belongs to another Agent");
  invariant(
    input.provider.models.primaryModel === profile.modelRoles.primaryModel &&
      input.provider.models.planningModel === profile.modelRoles.planningModel &&
      input.provider.models.smallFastModel === profile.modelRoles.smallFastModel &&
      input.provider.models.subagentModel === profile.modelRoles.subagentModel,
    "Provider and Profile model maps differ",
  );
  invariant(
    (profile.agentKind === "codex-cli" && input.provider.protocol === "openai-responses") ||
      (profile.agentKind === "claude-code" && input.provider.protocol === "anthropic-messages"),
    "Provider protocol is incompatible with the Agent",
  );
  const targetMatrix = uniqueSorted(input.targetMatrix);
  invariant(targetMatrix.length > 0, "Target matrix cannot be empty");
  for (const platform of targetMatrix) {
    invariant(input.effective.effectivePolicy.allowedTargetPlatforms.includes(platform), "Target platform is blocked by policy", { platform });
  }

  return deepFreeze({
    profileRevisionId: profile.id,
    installationId: input.installation.id,
    imageDigest: input.image.imageDigest,
    exactAgentVersion: input.image.exactAgentVersion,
    adapterVersion: input.image.adapterVersion,
    providerRevisionId: input.provider.id,
    providerProtocol: input.provider.protocol,
    modelRoles: profile.modelRoles,
    credentialBindingId: profile.credentialBindingId,
    credentialVersionId: profile.credentialVersionId,
    permissions: profile.permissions,
    budget: profile.budget,
    specRevisionId: input.specRevisionId,
    specDigest: input.specDigest,
    testPlanDigest: input.testPlanDigest,
    commitSha: input.commitSha,
    sourceDigest: input.sourceDigest,
    targetMatrix,
    resolvedAt: input.resolvedAt,
    resolutionDigest: input.resolutionDigest,
  });
}

/** Provider failures pause by default. Fallback is explicit, pre-approved and same-Agent only. */
export function resolveExplicitFallback(
  current: AgentProfileRevision,
  effective: EffectiveAgentConfiguration,
  profiles: Readonly<Record<EntityId, AgentProfileRevision>>,
): AgentProfileRevision | null {
  const configured = current.fallbackProfileRevisionId;
  if (!configured) return null;
  if (!effective.permittedFallbackProfileRevisionIds.includes(configured)) return null;
  const fallback = profiles[configured];
  if (!fallback || fallback.state !== "ACTIVE" || fallback.agentKind !== current.agentKind) return null;
  return fallback;
}
