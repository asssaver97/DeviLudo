import type { AgentKind } from "./types";

export type ProbeCheckName =
  | "endpoint-policy"
  | "authentication"
  | "model-exists"
  | "streaming"
  | "tool-call"
  | "cancellation"
  | "usage"
  | "timeout"
  | "minimal-no-tools";

export interface ProbeCheck {
  readonly name: ProbeCheckName;
  readonly status: "PASS" | "FAIL";
  readonly latencyMs: number;
  readonly safeDiagnostic?: string;
}

export interface ProviderProbeResult {
  readonly providerRevisionId: string;
  readonly agent: AgentKind;
  readonly checkedAt: string;
  readonly checks: readonly ProbeCheck[];
  readonly observedCanonicalModelId: string;
}

export const REQUIRED_PROBE_CHECKS: readonly ProbeCheckName[] = Object.freeze([
  "endpoint-policy",
  "authentication",
  "model-exists",
  "streaming",
  "tool-call",
  "cancellation",
  "usage",
  "timeout",
  "minimal-no-tools",
]);

export function assertProviderProbePassed(result: ProviderProbeResult): void {
  const checks = new Map(result.checks.map((check) => [check.name, check]));
  for (const required of REQUIRED_PROBE_CHECKS) {
    const check = checks.get(required);
    if (!check || check.status !== "PASS") {
      throw new Error(`Provider activation blocked by probe: ${required}`);
    }
  }
}

export interface ProviderActivation<TProvider> {
  readonly previousActiveRevisionId?: string;
  readonly activated: TProvider;
  readonly probe: ProviderProbeResult;
}

/** Draft validation cannot mutate/replace the currently active revision. */
export function activateAfterProbe<TProvider extends { readonly providerRevisionId: string }>(
  draft: TProvider,
  probe: ProviderProbeResult,
  previousActiveRevisionId?: string,
): ProviderActivation<TProvider> {
  if (draft.providerRevisionId !== probe.providerRevisionId) {
    throw new Error("Probe result belongs to a different provider revision");
  }
  assertProviderProbePassed(probe);
  return Object.freeze({ previousActiveRevisionId, activated: draft, probe });
}
