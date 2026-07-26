export const agentMicrovmCredentialIssuerConfigurationRevision = "fedcba987654";

export function makeAgentMicrovmCredentialIssuerRuntimeLock({
  clusterContext = "prod-cluster/admin",
  namespace = "deviludo-agent-credentials",
} = {}) {
  let resourceIndex = 1;
  const resource = (kind, name) => Object.freeze({
    kind,
    name,
    uid: `20000000-0000-4000-8000-${String(resourceIndex++).padStart(12, "0")}`,
    resourceVersion: String(30_000 + resourceIndex),
  });
  return Object.freeze({
    schemaVersion: "deviludo.agent-microvm-credential-issuer-runtime-lock.v1",
    lockId: "55555555-5555-4555-8555-555555555556",
    clusterContext,
    namespace,
    configurationRevision: agentMicrovmCredentialIssuerConfigurationRevision,
    createdAt: "2026-07-26T00:00:00.000Z",
    registrySecret: resource("Secret", `deviludo-agent-credential-registry-${agentMicrovmCredentialIssuerConfigurationRevision}`),
    configMap: resource("ConfigMap", `deviludo-agent-credential-config-${agentMicrovmCredentialIssuerConfigurationRevision}`),
    environmentSecret: resource("Secret", `deviludo-agent-credential-environment-${agentMicrovmCredentialIssuerConfigurationRevision}`),
    filesSecret: resource("Secret", `deviludo-agent-credential-files-${agentMicrovmCredentialIssuerConfigurationRevision}`),
  });
}

export function observedAgentMicrovmCredentialIssuerRuntimeResources(lock) {
  return [lock.registrySecret, lock.configMap, lock.environmentSecret, lock.filesSecret]
    .map((resource) => Object.freeze({ ...resource, immutable: true }));
}
