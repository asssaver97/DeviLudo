import { isAdapterVersionAttested } from "@/lib/agent/adapter-registry";
import type { AgentKind } from "@/lib/agent/types";
import type { DemoStoreState } from "@/lib/control-plane/demo-store";
import { PROVIDER_PROBE_CHECKS } from "@/services/inference-gateway/src/provider-probe";

const AGENTS = Object.freeze(["claude-code", "codex-cli"] as const);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_SCOPE = /^(?:platform|tenant:[a-z0-9-]+|project:[a-z0-9-]+)$/;

export type LocalAgentRuntimeProbe = Readonly<{
  status: "ok" | "degraded" | "NOT_CONNECTED";
  service?: string;
  executionEnabled?: boolean;
  inferenceGateway?: "CONFIGURED" | "NOT_CONFIGURED";
  providerBindingProbe?: "CONFIGURED" | "NOT_CONFIGURED";
  workerImageIdentity?: string | null;
  expectedWorkerImageIdentity?: string | null;
  workerImageVerified?: boolean;
  workerIdentityMode?: "PINNED_ENV" | "LOCAL_DETERMINISTIC" | "NOT_CONFIGURED";
  agents?: readonly Readonly<{
    agent: AgentKind;
    executable: "claude" | "codex";
    expectedVersion: string;
    observedVersion: string | null;
    state: "READY" | "VERSION_MISMATCH" | "UNAVAILABLE";
  }>[];
}>;

export type EffectiveLocalAgentReadiness = Readonly<{
  agent: AgentKind;
  executable: "claude" | "codex";
  expectedVersion: string;
  expectedVersions: readonly string[];
  observedVersion: string | null;
  state: "READY" | "VERSION_MISMATCH" | "UNAVAILABLE";
}>;

export type LocalAgentHealthReconciliation = Readonly<{
  agents: readonly EffectiveLocalAgentReadiness[];
  bindingCandidates: readonly LocalAgentBindingCandidate[];
  catalogVerified: boolean;
  probeVerified: boolean;
}>;

export type LocalAgentBindingCandidate = Readonly<{
  agent: AgentKind;
  version: string;
  providerRevisionId: string;
  profileRevisionId: string;
  credentialVersionId: string;
  selectionRole: "PRIMARY" | "FALLBACK" | "PRIMARY_AND_FALLBACK";
  runtimeState: "READY" | "VERSION_MISMATCH" | "UNAVAILABLE";
  modelRoles: Readonly<{
    primaryModel: string;
    planningModel: string;
    smallFastModel: string;
    subagentModel: string;
  }>;
}>;

export type LocalProviderBindingHealth = Readonly<{
  agent: AgentKind;
  version: string;
  providerRevisionId: string;
  profileRevisionId: string;
  selectionRole: LocalAgentBindingCandidate["selectionRole"];
  runtimeState: LocalAgentBindingCandidate["runtimeState"];
  state: "VERIFIED" | "BLOCKED";
}>;

export type LocalProviderBindingSummary = "VERIFIED" | "PARTIAL" | "BLOCKED";
export type LocalAgentProfileExecutionSummary = "READY" | "PARTIAL" | "BLOCKED";

/**
 * Verifies every selected immutable primary/fallback Profile binding
 * independently. Provider verification remains visible even when that exact
 * CLI version is not installed, so one executable path cannot hide another.
 */
export async function inspectLocalProviderBindings(
  candidates: readonly LocalAgentBindingCandidate[],
  verify: (candidate: LocalAgentBindingCandidate) => Promise<boolean>,
): Promise<readonly LocalProviderBindingHealth[]> {
  const ordered = [...candidates].toSorted((left, right) =>
    left.agent.localeCompare(right.agent) || left.profileRevisionId.localeCompare(right.profileRevisionId));
  const results = await Promise.all(ordered.map(async (candidate) => {
    let active = false;
    try { active = await verify(candidate); }
    catch { /* A connector failure is an exact blocked binding, never a global pass. */ }
    return Object.freeze({
      agent: candidate.agent,
      version: candidate.version,
      providerRevisionId: candidate.providerRevisionId,
      profileRevisionId: candidate.profileRevisionId,
      selectionRole: candidate.selectionRole,
      runtimeState: candidate.runtimeState,
      state: active ? "VERIFIED" as const : "BLOCKED" as const,
    });
  }));
  return Object.freeze(results);
}

export function summarizeLocalProviderBindings(
  bindings: readonly LocalProviderBindingHealth[],
): LocalProviderBindingSummary {
  const verified = bindings.filter((binding) => binding.state === "VERIFIED").length;
  if (bindings.length > 0 && verified === bindings.length) return "VERIFIED";
  if (verified > 0) return "PARTIAL";
  return "BLOCKED";
}

export function summarizeLocalAgentProfileExecutions(
  bindings: readonly LocalProviderBindingHealth[],
): LocalAgentProfileExecutionSummary {
  const ready = bindings.filter((binding) => binding.state === "VERIFIED" && binding.runtimeState === "READY").length;
  if (bindings.length > 0 && ready === bindings.length) return "READY";
  if (ready > 0) return "PARTIAL";
  return "BLOCKED";
}

/**
 * Joins an untrusted, read-only CLI observation with the persisted local Agent
 * control-plane authority. Neither side can manufacture READY on its own.
 */
export function reconcileLocalAgentHealth(
  probe: LocalAgentRuntimeProbe,
  store: DemoStoreState,
): LocalAgentHealthReconciliation {
  const catalog = effectiveVersions(store);
  const normalized = normalizeProbeAgents(probe.agents);
  const agents = normalized.agents.map((entry) => {
    const expectedVersions = catalog.versions[entry.agent];
    const observedVersion = entry.observedVersion;
    const state = observedVersion === null
      ? "UNAVAILABLE" as const
      : expectedVersions.includes(observedVersion) ? "READY" as const : "VERSION_MISMATCH" as const;
    return Object.freeze({
      agent: entry.agent,
      executable: entry.executable,
      expectedVersion: expectedVersions.join(" / ") || "未选择生效 Profile",
      expectedVersions,
      observedVersion,
      state,
    });
  });
  return Object.freeze({
    agents: Object.freeze(agents),
    bindingCandidates: Object.freeze(catalog.bindings.map((binding) => {
      const observed = agents.find((agent) => agent.agent === binding.agent)?.observedVersion ?? null;
      const runtimeState = observed === null
        ? "UNAVAILABLE" as const
        : observed === binding.version ? "READY" as const : "VERSION_MISMATCH" as const;
      return Object.freeze({ ...binding, runtimeState });
    })),
    catalogVerified: catalog.verified,
    probeVerified: normalized.verified,
  });
}

export function isLocalDevelopmentWorkerReady(
  probe: LocalAgentRuntimeProbe,
  reconciliation: LocalAgentHealthReconciliation,
  providerBindings: readonly LocalProviderBindingHealth[],
): boolean {
  return probe.service === "deviludo-local-agent-runtime"
    && probe.executionEnabled === true
    && probe.inferenceGateway === "CONFIGURED"
    && probe.providerBindingProbe === "CONFIGURED"
    && probe.workerImageVerified === true
    && reconciliation.catalogVerified
    && reconciliation.probeVerified
    && providerBindings.some((binding) => binding.state === "VERIFIED" && binding.runtimeState === "READY");
}

type ConfiguredLocalAgentBinding = Readonly<Omit<LocalAgentBindingCandidate, "runtimeState">>;

function effectiveVersions(store: DemoStoreState): Readonly<{
  versions: Readonly<Record<AgentKind, readonly string[]>>;
  bindings: readonly ConfiguredLocalAgentBinding[];
  verified: boolean;
}> {
  const versions: Record<AgentKind, Set<string>> = {
    "claude-code": new Set<string>(),
    "codex-cli": new Set<string>(),
  };
  const bindings = new Map<string, {
    binding: Omit<ConfiguredLocalAgentBinding, "selectionRole">;
    primary: boolean;
    fallback: boolean;
  }>();
  const entries = Object.entries(store.defaults);
  let verified = entries.length > 0 && typeof store.defaults.platform === "string";
  for (const [scope, profileId] of entries) {
    if (!DEFAULT_SCOPE.test(scope)) {
      verified = false;
      continue;
    }
    const profile = store.profiles.find((candidate) => candidate.id === profileId);
    const primary = profile ? servingBinding(store, profile) : null;
    if (!profile || !primary) {
      verified = false;
      continue;
    }
    if (scope === "platform" && (profile.scope !== "platform" || profile.scopeId !== "global")) {
      verified = false;
      continue;
    }
    addBinding(bindings, primary, "PRIMARY");
    versions[profile.agent].add(primary.version);

    // Production freezes a fallback only when a project explicitly selected
    // this primary Profile. Platform and tenant defaults do not implicitly
    // authorize a fallback for every downstream project.
    if (scope.startsWith("project:") && profile.fallbackProfileRevisionId) {
      const fallbackProfile = store.profiles.find((candidate) => candidate.id === profile.fallbackProfileRevisionId);
      const fallback = fallbackProfile ? servingBinding(store, fallbackProfile) : null;
      if (!fallbackProfile || fallbackProfile.id === profile.id || !fallback
        || fallbackProfile.agent !== profile.agent
        || fallbackProfile.scope !== profile.scope || fallbackProfile.scopeId !== profile.scopeId) {
        verified = false;
        continue;
      }
      addBinding(bindings, fallback, "FALLBACK");
      versions[fallbackProfile.agent].add(fallback.version);
    }
  }
  return Object.freeze({
    versions: Object.freeze({
      "claude-code": Object.freeze([...versions["claude-code"]].sort()),
      "codex-cli": Object.freeze([...versions["codex-cli"]].sort()),
    }),
    bindings: Object.freeze([...bindings.values()].map(({ binding, primary, fallback }) => Object.freeze({
      ...binding,
      selectionRole: primary && fallback ? "PRIMARY_AND_FALLBACK" as const
        : fallback ? "FALLBACK" as const : "PRIMARY" as const,
    }))),
    verified,
  });
}

function servingBinding(
  store: DemoStoreState,
  profile: DemoStoreState["profiles"][number],
): Omit<ConfiguredLocalAgentBinding, "selectionRole"> | null {
  const installation = store.installations.find((candidate) => candidate.id === profile.installationId);
  const provider = store.providers.find((candidate) => candidate.id === profile.providerRevisionId);
  if (profile.state !== "ACTIVE" || !installation || !provider
    || installation.agent !== profile.agent || provider.agent !== profile.agent
    || provider.state !== "ACTIVE"
    || provider.credentialVersionId !== profile.credentialVersionId
    || !providerProbePassed(provider.probe)
    || !installationServing(store, installation)) return null;
  return Object.freeze({
    agent: profile.agent,
    version: installation.version,
    providerRevisionId: provider.id,
    profileRevisionId: profile.id,
    credentialVersionId: profile.credentialVersionId,
    modelRoles: Object.freeze({ ...provider.models }),
  });
}

function addBinding(
  bindings: Map<string, {
    binding: Omit<ConfiguredLocalAgentBinding, "selectionRole">;
    primary: boolean;
    fallback: boolean;
  }>,
  binding: Omit<ConfiguredLocalAgentBinding, "selectionRole">,
  role: "PRIMARY" | "FALLBACK",
): void {
  const existing = bindings.get(binding.profileRevisionId);
  if (existing) {
    if (role === "PRIMARY") existing.primary = true;
    else existing.fallback = true;
    return;
  }
  bindings.set(binding.profileRevisionId, {
    binding,
    primary: role === "PRIMARY",
    fallback: role === "FALLBACK",
  });
}

function installationServing(
  store: DemoStoreState,
  installation: DemoStoreState["installations"][number],
): boolean {
  const key = `${installation.agent}@${installation.version}`;
  const state = store.agentVersions[key];
  const metadata = store.agentVersionMetadata[key];
  return (state === "APPROVED" || state === "DEPRECATED")
    && installation.state === "ACTIVE"
    && installation.health === "HEALTHY"
    && installation.rolloutPercent === 100
    && typeof installation.activatedAt === "string"
    && Number.isFinite(Date.parse(installation.activatedAt))
    && DIGEST.test(installation.imageDigest)
    && Boolean(installation.buildReceiptId)
    && DIGEST.test(installation.buildReceiptDigest)
    && metadata?.signatureVerified === true
    && metadata.scan === "PASS"
    && Boolean(metadata.validationReceiptId)
    && Boolean(metadata.validationReceiptDigest && DIGEST.test(metadata.validationReceiptDigest))
    && Boolean(metadata.supplyChainEvidenceDigest && DIGEST.test(metadata.supplyChainEvidenceDigest))
    && typeof metadata.validatedAdapterVersion === "string"
    && Boolean(metadata.adapterCompatibility)
    && isAdapterVersionAttested(
      installation.adapterVersion,
      metadata.validatedAdapterVersion,
      metadata.adapterCompatibility!,
    );
}

function providerProbePassed(probe: Readonly<Record<string, "PASS" | "FAIL">>): boolean {
  const keys = Object.keys(probe);
  return keys.length === PROVIDER_PROBE_CHECKS.length
    && PROVIDER_PROBE_CHECKS.every((check) => probe[check] === "PASS");
}

function normalizeProbeAgents(value: LocalAgentRuntimeProbe["agents"]): Readonly<{
  agents: readonly NonNullable<LocalAgentRuntimeProbe["agents"]>[number][];
  verified: boolean;
}> {
  if (!Array.isArray(value)) return Object.freeze({ agents: Object.freeze([]), verified: false });
  const seen = new Set<string>();
  const agents = value.flatMap((entry) => {
    const executable = entry?.agent === "claude-code" ? "claude" : entry?.agent === "codex-cli" ? "codex" : null;
    if (!executable || entry.executable !== executable || seen.has(entry.agent)
      || !EXACT_VERSION.test(entry.expectedVersion)
      || (entry.observedVersion !== null && !EXACT_VERSION.test(entry.observedVersion))
      || !["READY", "VERSION_MISMATCH", "UNAVAILABLE"].includes(entry.state)) return [];
    seen.add(entry.agent);
    return [entry];
  });
  const verified = agents.length === AGENTS.length && AGENTS.every((agent) => seen.has(agent));
  return Object.freeze({ agents: Object.freeze(agents), verified });
}
