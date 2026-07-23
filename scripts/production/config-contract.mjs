import { access, readFile, readdir } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SERVICE_ENTRYPOINTS } from "../observability/run-service.mjs";

const EXACT_PLATFORM_ENVIRONMENT_NAMES = new Set([
  "DATABASE_URL",
  "NODE_ENV",
  "REDIS_URL",
  "S3_BUCKET",
  "S3_ENDPOINT",
  "TEMPORAL_ADDRESS",
  "TEMPORAL_NAMESPACE",
  "TEMPORAL_TASK_QUEUE",
  "VAULT_ADDR",
]);

// These values are created inside a trusted parent process or passed as fixed
// image build arguments. Operators must not inject them into a service
// deployment or copy them into an environment file.
const PROCESS_OWNED_ENVIRONMENT_NAMES = new Set([
  "DEVILUDO_PLATFORM_VERSION",
  "DEVILUDO_SOURCE_REVISION",
  "DEVILUDO_WORKFLOW_DESTINATION",
  "DEVILUDO_TESTKIT_STEAM_AUTOMATION_POLICY_DIGEST",
  "DEVILUDO_TESTKIT_STEAM_BRIDGE_VERSION",
  "DEVILUDO_TESTKIT_STEAM_CONNECTOR_BINARY_DIGEST",
  "DEVILUDO_TESTKIT_STEAM_CONNECTOR_PLATFORM",
  "DEVILUDO_TESTKIT_STEAM_CONNECTOR_RUNNER_ID",
  "DEVILUDO_TESTKIT_STEAM_CONNECTOR_VERSION",
  "DEVILUDO_TESTKIT_STEAM_CONTROLLER_CONTRACT_VERSION",
  "DEVILUDO_TESTKIT_STEAM_SUPPLY_CHAIN_EVIDENCE_DIGEST",
]);

const ENVIRONMENT_REFERENCE = /\b(?:DEVILUDO_[A-Z0-9_]+|DATABASE_URL|NODE_ENV|REDIS_URL|S3_BUCKET|S3_ENDPOINT|TEMPORAL_ADDRESS|TEMPORAL_NAMESPACE|TEMPORAL_TASK_QUEUE|VAULT_ADDR)\b/g;

export function environmentNamesFromSource(source) {
  return new Set([...source.matchAll(ENVIRONMENT_REFERENCE)]
    .map(([name]) => name)
    .filter((name) => name.startsWith("DEVILUDO_") || EXACT_PLATFORM_ENVIRONMENT_NAMES.has(name))
    .filter((name) => !PROCESS_OWNED_ENVIRONMENT_NAMES.has(name)));
}

export function documentedEnvironmentNames(examples) {
  const names = new Set();
  for (const source of examples) {
    for (const name of environmentNamesFromSource(source)) names.add(name);
  }
  return names;
}

export function analyzeProductionConfiguration({
  entrypointSources,
  environmentExamples,
  entrypoints,
  packageScripts,
  rootEnvironment,
  missingEntrypointFiles = [],
}) {
  const usedEnvironment = new Set();
  for (const source of entrypointSources) {
    for (const name of environmentNamesFromSource(source)) usedEnvironment.add(name);
  }
  const documentedEnvironment = documentedEnvironmentNames(environmentExamples);
  const missingEnvironment = [...usedEnvironment]
    .filter((name) => !documentedEnvironment.has(name))
    .sort();

  const startScripts = Object.entries(packageScripts)
    .filter(([name]) => name === "start" || name.startsWith("start:"));
  const mappedServices = [];
  const unobservedStartScripts = [];
  for (const [name, command] of startScripts) {
    const service = command.match(/scripts\/observability\/run-service\.mjs\s+([a-z0-9-]+)(?:\s|$)/)?.[1];
    if (!service) unobservedStartScripts.push(name);
    else mappedServices.push(service);
  }
  const configuredServices = Object.keys(entrypoints);
  const duplicateMappedServices = [...new Set(mappedServices.filter((service, index) => mappedServices.indexOf(service) !== index))].sort();
  const missingStartServices = configuredServices.filter((service) => !mappedServices.includes(service)).sort();
  const unknownStartServices = [...new Set(mappedServices.filter((service) => !entrypoints[service]))].sort();

  return Object.freeze({
    documentedEnvironmentCount: documentedEnvironment.size,
    duplicateMappedServices,
    entrypointCount: configuredServices.length,
    missingEntrypointFiles: [...missingEntrypointFiles].sort(),
    missingEnvironment,
    missingStartServices,
    startScriptCount: startScripts.length,
    unknownStartServices,
    unobservedStartScripts: unobservedStartScripts.sort(),
    usedEnvironmentCount: usedEnvironment.size,
    usesLegacyControlPlanePort: /^\s*CONTROL_PLANE_PORT\s*=/m.test(rootEnvironment),
  });
}

export function assertProductionConfiguration(report) {
  const problems = [];
  if (report.missingEnvironment.length) problems.push(`undocumented environment: ${report.missingEnvironment.join(", ")}`);
  if (report.missingEntrypointFiles.length) problems.push(`missing entrypoints: ${report.missingEntrypointFiles.join(", ")}`);
  if (report.missingStartServices.length) problems.push(`services without start scripts: ${report.missingStartServices.join(", ")}`);
  if (report.unknownStartServices.length) problems.push(`start scripts with unknown services: ${report.unknownStartServices.join(", ")}`);
  if (report.duplicateMappedServices.length) problems.push(`services with duplicate start scripts: ${report.duplicateMappedServices.join(", ")}`);
  if (report.unobservedStartScripts.length) problems.push(`start scripts outside observed launcher: ${report.unobservedStartScripts.join(", ")}`);
  if (report.usesLegacyControlPlanePort) problems.push("legacy CONTROL_PLANE_PORT is forbidden; use DEVILUDO_CONTROL_PLANE_PORT");
  if (problems.length) throw new Error(`Production configuration contract failed:\n- ${problems.join("\n- ")}`);
  return report;
}

export async function loadProductionConfiguration(root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")) {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const environmentPaths = [resolve(root, ".env.example"), ...await findEnvironmentExamples(resolve(root, "services"))];
  const environmentExamples = await Promise.all(environmentPaths.map((path) => readFile(path, "utf8")));
  const entrypointSources = [];
  const missingEntrypointFiles = [];
  for (const descriptor of Object.values(SERVICE_ENTRYPOINTS)) {
    if (!descriptor.entry.startsWith("services/") || !descriptor.entry.endsWith(".ts")) continue;
    const path = resolve(root, descriptor.entry);
    try {
      await access(path);
      entrypointSources.push(await readFile(path, "utf8"));
    } catch {
      missingEntrypointFiles.push(relative(root, path));
    }
  }
  for (const utility of [
    "scripts/production/authorize-control-plane-release.mjs",
    "scripts/production/build-control-plane-image.mjs",
    "scripts/production/build-runner-native.mjs",
    "scripts/production/apply-runner-native-service-transaction.mjs",
    "scripts/production/compile-runner-native-service-transaction.mjs",
    "scripts/production/compile-windows-scm-actuation-request.mjs",
    "scripts/production/finalize-runner-native-release.mjs",
    "scripts/production/finalize-agent-supply-chain-native.mjs",
    "scripts/production/finalize-steam-native-bridge.mjs",
    "scripts/production/finalize-windows-scm-service-bridge.mjs",
    "scripts/production/finalize-windows-scm-native-actuator.mjs",
    "scripts/production/inspect-runner-native-trust-policy.mjs",
    "scripts/production/inspect-agent-supply-chain-native-trust-policy.mjs",
    "scripts/production/inspect-steam-native-bridge-trust-policy.mjs",
    "scripts/production/inspect-windows-scm-service-bridge-trust-policy.mjs",
    "scripts/production/inspect-windows-scm-native-actuator-trust-policy.mjs",
    "scripts/production/plan-runner-native-install.mjs",
    "scripts/production/request-runner-native-activation.mjs",
    "scripts/production/runner-native-finalizer.mjs",
    "scripts/production/runner-native-release.mjs",
    "scripts/production/stage-runner-native-install.mjs",
    "scripts/production/verify-runner-native-release.mjs",
    "scripts/production/control-release-authorization.mjs",
    "scripts/production/deploy-control-plane.mjs",
    "scripts/production/inspect-control-release-trust-policy.mjs",
    "scripts/production/lock-control-runtime.mjs",
    "scripts/production/migrate-postgres.mjs",
    "scripts/production/run-control-service.mjs",
  ]) {
    const path = resolve(root, utility);
    try {
      await access(path);
      entrypointSources.push(await readFile(path, "utf8"));
    } catch {
      missingEntrypointFiles.push(relative(root, path));
    }
  }
  return analyzeProductionConfiguration({
    entrypointSources,
    environmentExamples,
    entrypoints: SERVICE_ENTRYPOINTS,
    packageScripts: packageJson.scripts ?? {},
    rootEnvironment: environmentExamples[0],
    missingEntrypointFiles,
  });
}

async function findEnvironmentExamples(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await findEnvironmentExamples(path));
    else if (entry.isFile() && basename(path).includes(".env") && basename(path).endsWith(".example")) paths.push(path);
  }
  return paths.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = assertProductionConfiguration(await loadProductionConfiguration());
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    serviceEntrypoints: report.entrypointCount,
    startScripts: report.startScriptCount,
    runtimeEnvironmentNames: report.usedEnvironmentCount,
    documentedEnvironmentNames: report.documentedEnvironmentCount,
  })}\n`);
}
