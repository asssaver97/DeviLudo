import type { AgentProfileRevision, AgentRunState } from "./types";

export type ProviderHealth = "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "REVOKED";

export interface ProviderSelection {
  readonly state: Extract<AgentRunState, "QUEUED" | "WAITING_PROVIDER">;
  readonly profile?: AgentProfileRevision;
  readonly reason?: string;
  readonly usedFallback: boolean;
}

/**
 * Never switches Claude/Codex or provider revisions silently. A fallback is
 * eligible only when both the active profile and the project explicitly name
 * the exact fallback revision before the run is enqueued.
 */
export function selectRunnableProfile(input: {
  readonly primary: AgentProfileRevision;
  readonly primaryHealth: ProviderHealth;
  readonly fallback?: AgentProfileRevision;
  readonly fallbackHealth?: ProviderHealth;
  readonly projectAllowedFallbackProfileRevisionIds: readonly string[];
}): ProviderSelection {
  if (input.primaryHealth === "HEALTHY") {
    return Object.freeze({ state: "QUEUED", profile: input.primary, usedFallback: false });
  }

  const fallback = input.fallback;
  const explicitlyAllowed =
    fallback !== undefined &&
    input.primary.allowedFallbackProfileRevisionIds.includes(fallback.profileRevisionId) &&
    input.projectAllowedFallbackProfileRevisionIds.includes(fallback.profileRevisionId);

  if (fallback && explicitlyAllowed && input.fallbackHealth === "HEALTHY") {
    return Object.freeze({ state: "QUEUED", profile: fallback, usedFallback: true });
  }

  return Object.freeze({
    state: "WAITING_PROVIDER",
    usedFallback: false,
    reason: explicitlyAllowed
      ? "Explicit fallback is not healthy"
      : "Primary provider is unavailable and no pre-approved exact fallback exists",
  });
}
