import { DEFAULT_AGENT } from "./registry";
import { assertPinnedModelId } from "./providers";
import type { AgentKind, AgentProfileRevision } from "./types";

export type ConfigurationScope = "platform" | "tenant" | "project";

export interface ScopedProfileSelection {
  readonly scope: ConfigurationScope;
  readonly profile: AgentProfileRevision;
}

export interface ProfileResolutionInput {
  readonly platformDefault: AgentProfileRevision;
  readonly tenantOverride?: AgentProfileRevision;
  readonly projectOverride?: AgentProfileRevision;
  readonly platformAllowedAgents: readonly AgentKind[];
  readonly tenantAllowedAgents?: readonly AgentKind[];
  readonly projectAllowedAgents?: readonly AgentKind[];
}

export interface EffectiveProfileSelection {
  readonly profile: AgentProfileRevision;
  readonly source: ConfigurationScope;
  readonly effectiveAllowedAgents: readonly AgentKind[];
}

export function resolveEffectiveProfile(
  input: ProfileResolutionInput,
): EffectiveProfileSelection {
  if (input.platformDefault.agent !== DEFAULT_AGENT) {
    throw new Error("The platform default profile must use Claude Code");
  }

  const effectiveAllowedAgents = intersectAllowedAgents(
    input.platformAllowedAgents,
    input.tenantAllowedAgents,
    input.projectAllowedAgents,
  );
  const selected: ScopedProfileSelection = input.projectOverride
    ? { scope: "project", profile: input.projectOverride }
    : input.tenantOverride
      ? { scope: "tenant", profile: input.tenantOverride }
      : { scope: "platform", profile: input.platformDefault };

  if (!effectiveAllowedAgents.includes(selected.profile.agent)) {
    throw new Error(
      `Profile ${selected.profile.profileRevisionId} selects a disallowed agent: ${selected.profile.agent}`,
    );
  }

  assertProfileConsistency(selected.profile);
  return Object.freeze({
    profile: selected.profile,
    source: selected.scope,
    effectiveAllowedAgents: Object.freeze(effectiveAllowedAgents),
  });
}

function intersectAllowedAgents(
  platform: readonly AgentKind[],
  tenant?: readonly AgentKind[],
  project?: readonly AgentKind[],
): AgentKind[] {
  const lowerScopes = [tenant, project].filter(
    (value): value is readonly AgentKind[] => value !== undefined,
  );
  return [...new Set(platform)].filter((agent) =>
    lowerScopes.every((allowlist) => allowlist.includes(agent)),
  );
}

export function assertProfileConsistency(profile: AgentProfileRevision): void {
  if (profile.agent !== profile.installation.agent) {
    throw new Error("Profile agent does not match its pinned installation");
  }
  if (profile.revision < 1 || !Number.isInteger(profile.revision)) {
    throw new Error("Profile revision must be a positive integer");
  }
  if (profile.budget.maxTurns < 1 || profile.budget.maxCostUsd <= 0) {
    throw new Error("Profile budget must set positive maxTurns and maxCostUsd");
  }
  if (profile.timeoutSeconds < 1) {
    throw new Error("Profile timeout must be positive");
  }
  for (const model of Object.values(profile.models)) assertPinnedModelId(model);
  if (
    profile.permissions.sandbox !== "workspace-write" ||
    profile.permissions.network !== "inference-gateway-only" ||
    profile.permissions.scmWrite !== "proxy-only" ||
    profile.permissions.allowProjectHooks ||
    profile.permissions.allowProjectMcp ||
    profile.permissions.allowProjectPlugins
  ) {
    throw new Error("Profile attempts to loosen an immutable platform runtime policy");
  }
}

export interface AgentRunSnapshot {
  readonly profileRevisionId: string;
  readonly installationId: string;
  readonly imageDigest: `sha256:${string}`;
  readonly cliVersion: string;
  readonly adapterVersion: string;
  readonly providerRevisionId: string;
  readonly model: string;
  readonly models: AgentProfileRevision["models"];
  readonly credentialVersionId: string;
  readonly budget: AgentProfileRevision["budget"];
  readonly timeoutSeconds: number;
  readonly agent: AgentKind;
}

/** Resolve once at enqueue time, then persist this immutable value with the run. */
export function snapshotProfile(profile: AgentProfileRevision): AgentRunSnapshot {
  assertProfileConsistency(profile);
  return deepFreeze({
    profileRevisionId: profile.profileRevisionId,
    installationId: profile.installation.installationId,
    imageDigest: profile.installation.imageDigest,
    cliVersion: profile.installation.cliVersion,
    adapterVersion: profile.installation.adapterVersion,
    providerRevisionId: profile.providerRevisionId,
    model: profile.models.primaryModel,
    models: { ...profile.models },
    credentialVersionId: profile.credential.credentialVersionId,
    budget: { ...profile.budget },
    timeoutSeconds: profile.timeoutSeconds,
    agent: profile.agent,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
