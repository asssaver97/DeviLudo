import { assertPinnedModelId, normalizeModelRoles } from "@/lib/agent/providers";
import { isAdapterVersionAttested, isBuiltInAdapterVersion } from "@/lib/agent/adapter-registry";
import {
  getDemoStore,
  type DemoProfile,
  type DemoStoreState,
} from "@/lib/control-plane/demo-store";
import { HttpProblem } from "@/lib/control-plane/http";
import type { LocalLockedAgentProfile } from "@/lib/local-delivery/model";

const LOCAL_TENANT_SCOPE_ID = "tenant-local";
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
  const provider = store.providers.find((item) => item.id === profile.providerRevisionId);
  const credential = provider
    ? store.credentials.find((item) => item.id === provider.credentialVersionId)
    : undefined;
  const expectedProtocol = profile.agent === "claude-code" ? "anthropic-messages" : "openai-responses";
  const versionMetadata = installation
    ? store.agentVersionMetadata[`${installation.agent}@${installation.version}`]
    : undefined;
  if (!installation || installation.agent !== profile.agent
    || installation.state !== "ACTIVE" || installation.health !== "HEALTHY"
    || installation.rolloutPercent !== 100 || !installation.activatedAt
    || !EXACT_VERSION.test(installation.version) || !EXACT_VERSION.test(installation.adapterVersion)
    || !IMAGE_DIGEST.test(installation.imageDigest)
    || !isBuiltInAdapterVersion(profile.agent, installation.adapterVersion)
    || !["APPROVED", "DEPRECATED"].includes(store.agentVersions[`${installation.agent}@${installation.version}`])
    || !versionMetadata?.signatureVerified || versionMetadata.scan !== "PASS"
    || !versionMetadata.validationReceiptId || !SAFE_ID.test(versionMetadata.validationReceiptId)
    || !versionMetadata.validationReceiptDigest || !IMAGE_DIGEST.test(versionMetadata.validationReceiptDigest)
    || !versionMetadata.supplyChainEvidenceDigest || !IMAGE_DIGEST.test(versionMetadata.supplyChainEvidenceDigest)
    || !versionMetadata.validatedAdapterVersion
    || !versionMetadata.adapterCompatibility
    || !isAdapterVersionAttested(
      installation.adapterVersion,
      versionMetadata.validatedAdapterVersion,
      versionMetadata.adapterCompatibility,
    )
    || !provider || provider.agent !== profile.agent || provider.state !== "ACTIVE"
    || provider.protocol !== expectedProtocol || !SAFE_ID.test(provider.credentialVersionId)
    || profile.credentialVersionId !== provider.credentialVersionId
    || !provider.governance.confirmedBy || !provider.governance.confirmedAt
    || !Number.isFinite(Date.parse(provider.governance.confirmedAt))
    // The bundled demo catalog uses non-secret fixture bindings. Once a
    // credential enters the local lifecycle catalog, its current state is
    // authoritative and a revoked/previous version must fail closed.
    || (credential !== undefined && credential.state !== "ACTIVE")
    || !SAFE_ID.test(profile.id) || !SAFE_ID.test(installation.id)
    || !SAFE_ID.test(provider.id) || !SAFE_ID.test(testPlanRevisionId)
    || !Number.isFinite(profile.budget.maxUsd) || profile.budget.maxUsd <= 0
    || !Number.isSafeInteger(profile.budget.maxTurns) || profile.budget.maxTurns < 1 || profile.budget.maxTurns > 200
    || !Number.isSafeInteger(profile.budget.timeoutSeconds) || profile.budget.timeoutSeconds < 60
    || profile.budget.timeoutSeconds > 14_400) {
    notReady("最高优先级的 Agent Profile 未通过版本、安装、Provider 或凭据绑定门禁。");
  }
  const modelRoles = normalizeModelRoles(provider.models);
  const model = assertPinnedModelId(modelRoles.primaryModel);
  return Object.freeze({
    agent: profile.agent,
    profileRevisionId: profile.id,
    configurationSource: source,
    installationId: installation.id,
    imageDigest: installation.imageDigest,
    exactAgentVersion: installation.version,
    adapterVersion: installation.adapterVersion,
    agentVersionAttestation: Object.freeze({
      validationReceiptId: versionMetadata.validationReceiptId,
      validationReceiptDigest: versionMetadata.validationReceiptDigest,
      supplyChainEvidenceDigest: versionMetadata.supplyChainEvidenceDigest,
      validatedAdapterVersion: versionMetadata.validatedAdapterVersion,
      adapterCompatibility: Object.freeze({ ...versionMetadata.adapterCompatibility }),
    }),
    providerRevisionId: provider.id,
    providerProtocol: provider.protocol,
    credentialVersionId: provider.credentialVersionId,
    model,
    modelRoles,
    testPlanRevisionId,
    budget: Object.freeze({
      maxTurns: profile.budget.maxTurns,
      maxCostUsd: profile.budget.maxUsd,
      maxInputTokens: 200_000,
      maxOutputTokens: 50_000,
    }),
    timeoutSeconds: profile.budget.timeoutSeconds,
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
