export const runtimeConfigurationRevision = "0123456789ab";

export function makeControlRuntimeLock({
  clusterContext = "prod-cluster/admin",
  namespace = "deviludo-system",
  services = ["control-plane"],
} = {}) {
  const selected = [...services].sort();
  let resourceIndex = 1;
  const resource = (kind, name) => Object.freeze({
    kind,
    name,
    uid: `00000000-0000-4000-8000-${String(resourceIndex++).padStart(12, "0")}`,
    resourceVersion: String(10_000 + resourceIndex),
  });
  return Object.freeze({
    schemaVersion: "deviludo.control-runtime-lock.v1",
    lockId: "44444444-4444-4444-8444-444444444444",
    clusterContext,
    namespace,
    configurationRevision: runtimeConfigurationRevision,
    createdAt: "2026-07-22T00:00:00.000Z",
    registrySecret: resource("Secret", `deviludo-control-registry-${runtimeConfigurationRevision}`),
    migrationSecret: resource("Secret", `deviludo-schema-migrator-files-${runtimeConfigurationRevision}`),
    services: Object.freeze(selected.map((service) => Object.freeze({
      service,
      configMap: resource("ConfigMap", `deviludo-${service}-config-${runtimeConfigurationRevision}`),
      environmentSecret: resource("Secret", `deviludo-${service}-environment-${runtimeConfigurationRevision}`),
      filesSecret: resource("Secret", `deviludo-${service}-files-${runtimeConfigurationRevision}`),
    }))),
  });
}

export function observedControlRuntimeResources(lock) {
  const resources = [lock.registrySecret, lock.migrationSecret];
  for (const entry of lock.services) resources.push(entry.configMap, entry.environmentSecret, entry.filesSecret);
  return resources.map((resource) => Object.freeze({ ...resource, immutable: true }));
}
