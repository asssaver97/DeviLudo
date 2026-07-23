export const agentSupplyChainConfigurationRevision = "abcdef012345";

export function makeAgentSupplyChainRuntimeLock({
  clusterContext = "prod-cluster/admin",
  namespace = "deviludo-agent-supply-chain",
} = {}) {
  let resourceIndex = 1;
  const resource = (kind, name) => Object.freeze({
    kind,
    name,
    uid: `10000000-0000-4000-8000-${String(resourceIndex++).padStart(12, "0")}`,
    resourceVersion: String(20_000 + resourceIndex),
  });
  return Object.freeze({
    schemaVersion: "deviludo.agent-supply-chain-runtime-lock.v1",
    lockId: "55555555-5555-4555-8555-555555555555",
    clusterContext,
    namespace,
    configurationRevision: agentSupplyChainConfigurationRevision,
    createdAt: "2026-07-24T00:00:00.000Z",
    registrySecret: resource("Secret", `deviludo-agent-supply-chain-registry-${agentSupplyChainConfigurationRevision}`),
    configMap: resource("ConfigMap", `deviludo-agent-supply-chain-config-${agentSupplyChainConfigurationRevision}`),
    environmentSecret: resource("Secret", `deviludo-agent-supply-chain-environment-${agentSupplyChainConfigurationRevision}`),
    filesSecret: resource("Secret", `deviludo-agent-supply-chain-files-${agentSupplyChainConfigurationRevision}`),
    releaseVolumeClaim: resource(
      "PersistentVolumeClaim",
      `deviludo-agent-supply-chain-release-${agentSupplyChainConfigurationRevision}`,
    ),
  });
}

export function observedAgentSupplyChainRuntimeResources(lock) {
  return [lock.registrySecret, lock.configMap, lock.environmentSecret, lock.filesSecret, lock.releaseVolumeClaim]
    .map((resource) => Object.freeze({
      ...resource,
      immutable: resource.kind === "PersistentVolumeClaim" ? null : true,
    }));
}
