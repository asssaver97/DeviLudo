import { assertPinnedModelId } from "@/lib/agent/providers";
import {
  getDemoStore,
  type DemoProfile,
  type DemoStoreState,
} from "@/lib/control-plane/demo-store";
import { HttpProblem } from "@/lib/control-plane/http";
import type { LocalLockedAgentProfile } from "@/lib/local-delivery/model";

const LOCAL_TENANT_SCOPE_ID = "north-dock";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

type ConfigurationSource = LocalLockedAgentProfile["configurationSource"];

/**
 * Resolve the exact local Agent configuration at enqueue time. The result is
 * copied into the delivery snapshot, so later admin changes affect only later
 * runs. A configured but unhealthy higher-precedence override fails closed
 * instead of silently falling through to another Agent.
 */
export function resolveLocalAgentProfile(
  projectId: string,
  testPlanRevisionId = "godot-testkit-1.0.0",
  store: DemoStoreState = getDemoStore(),
): LocalLockedAgentProfile {
  const candidates: readonly ConfigurationSource[] = [
    `project:${projectId}`,
    `tenant:${LOCAL_TENANT_SCOPE_ID}`,
    "platform",
  ];
  const source = candidates.find((candidate) => Boolean(store.defaults[candidate]));
  if (!source) notReady("没有可用的平台 Claude Code 默认 Profile。");

  const profileId = store.defaults[source];
  const profile = store.profiles.find((item) => item.id === profileId);
  if (!profile || !selectableFrom(profile, source) || profile.state !== "ACTIVE") {
    notReady("最高优先级的 Agent Profile 已失效或超出配置作用域。");
  }
  const installation = store.installations.find((item) => item.id === profile.installationId);
  const provider = store.providers.find((item) => item.id === profile.providerId);
  const credential = provider
    ? store.credentials.find((item) => item.id === provider.credentialId)
    : undefined;
  const expectedProtocol = profile.agent === "claude-code" ? "anthropic-messages" : "openai-responses";
  if (!installation || installation.agent !== profile.agent
    || installation.state !== "ACTIVE" || installation.health !== "HEALTHY"
    || installation.rolloutPercent !== 100 || !installation.activatedAt
    || !EXACT_VERSION.test(installation.version) || !EXACT_VERSION.test(installation.adapterVersion)
    || !IMAGE_DIGEST.test(installation.imageDigest)
    || !["APPROVED", "DEPRECATED"].includes(store.agentVersions[`${installation.agent}@${installation.version}`])
    || !provider || provider.agent !== profile.agent || provider.state !== "ACTIVE"
    || provider.protocol !== expectedProtocol || !SAFE_ID.test(provider.credentialId)
    // The bundled demo catalog uses non-secret fixture bindings. Once a
    // credential enters the local lifecycle catalog, its current state is
    // authoritative and a revoked/previous version must fail closed.
    || (credential !== undefined && credential.state !== "ACTIVE")
    || !SAFE_ID.test(profile.id) || !SAFE_ID.test(installation.id)
    || !SAFE_ID.test(provider.id) || !SAFE_ID.test(testPlanRevisionId)
    || !Number.isFinite(profile.budgetUsd) || profile.budgetUsd <= 0) {
    notReady("最高优先级的 Agent Profile 未通过版本、安装、Provider 或凭据绑定门禁。");
  }
  const model = assertPinnedModelId(provider.primaryModel);
  return Object.freeze({
    agent: profile.agent,
    profileRevisionId: profile.id,
    configurationSource: source,
    installationId: installation.id,
    imageDigest: installation.imageDigest,
    exactAgentVersion: installation.version,
    adapterVersion: installation.adapterVersion,
    providerRevisionId: provider.id,
    providerProtocol: provider.protocol,
    credentialVersionId: provider.credentialId,
    model,
    testPlanRevisionId,
    budget: Object.freeze({
      maxTurns: 64,
      maxCostUsd: profile.budgetUsd,
      maxInputTokens: 200_000,
      maxOutputTokens: 50_000,
    }),
    timeoutSeconds: 7_200,
  });
}

function selectableFrom(profile: DemoProfile, source: ConfigurationSource): boolean {
  if (source === "platform") return profile.scope === "platform" && profile.scopeId === "global";
  const separator = source.indexOf(":");
  const scope = source.slice(0, separator);
  const scopeId = source.slice(separator + 1);
  return profile.scope === "platform" && profile.scopeId === "global"
    || profile.scope === scope && profile.scopeId === scopeId
    || scope === "project" && profile.scope === "tenant" && profile.scopeId === LOCAL_TENANT_SCOPE_ID;
}

function notReady(message: string): never {
  throw new HttpProblem(409, "AGENT_PROFILE_NOT_READY", message);
}
