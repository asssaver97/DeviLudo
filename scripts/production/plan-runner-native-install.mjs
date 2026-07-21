#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import { validateRunnerCapabilities } from "../../services/runner-control/src/coordinator.ts";
import { loadMachineConfig } from "../../services/runner-control/src/run-physical-runner.ts";
import { verifyRunnerNativeRelease } from "./runner-native-release.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
const AUTHORIZATION_KEYS = Object.freeze([
  "architecture", "artifacts", "buildReceiptDigest", "platform", "platformVersion", "releaseDigest", "releaseId",
  "schemaVersion", "signingKeyId", "sourceRevision", "status", "trustPolicyDigest", "verifiedAt",
]);
const AUTHORIZATION_ARTIFACT_KEYS = Object.freeze(["component", "fileName", "identityDigest", "releasedDigest"]);
const PLAN_KEYS = Object.freeze([
  "activation", "architecture", "artifacts", "environmentLocks", "installRoot", "machine", "planDigest", "platform",
  "platformVersion", "preparedAt", "releaseDigest", "releaseDirectory", "releaseId", "rollback", "schemaVersion", "services",
  "sourceRevision",
]);
const RUNNER_STEAM_BINDINGS = Object.freeze([
  "DEVILUDO_PHYSICAL_RUNNER_STEAM_CONNECTOR_VERSION",
  "DEVILUDO_PHYSICAL_RUNNER_STEAM_BRIDGE_VERSION",
  "DEVILUDO_PHYSICAL_RUNNER_STEAM_CONTROLLER_CONTRACT_VERSION",
  "DEVILUDO_PHYSICAL_RUNNER_STEAM_CONNECTOR_BINARY_DIGEST",
  "DEVILUDO_PHYSICAL_RUNNER_STEAM_AUTOMATION_POLICY_DIGEST",
  "DEVILUDO_PHYSICAL_RUNNER_STEAM_SUPPLY_CHAIN_EVIDENCE_DIGEST",
]);

export function parseRunnerNativeInstallPlanArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 18 || argv.length > 22 || argv.length % 2 !== 0) invalidInput();
  const allowed = new Set([
    "--artifacts", "--build-receipt", "--connector-env-file", "--install-root", "--machine-config", "--output",
    "--previous-plan", "--release", "--runner-env-file", "--trust-policy", "--trust-policy-digest",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalidInput();
    values.set(name, value);
  }
  const required = [
    "--artifacts", "--build-receipt", "--install-root", "--machine-config", "--output", "--release",
    "--runner-env-file", "--trust-policy", "--trust-policy-digest",
  ];
  if (required.some((name) => !values.has(name)) || !PREFIXED_SHA256.test(values.get("--trust-policy-digest"))) invalidInput();
  return Object.freeze({
    artifactDirectory: absolute(values.get("--artifacts")),
    buildReceiptPath: absolute(values.get("--build-receipt")),
    connectorEnvFile: optionalAbsolute(values.get("--connector-env-file")),
    installRoot: absolute(values.get("--install-root")),
    machineConfigPath: absolute(values.get("--machine-config")),
    outputPath: absolute(values.get("--output")),
    previousPlanPath: optionalAbsolute(values.get("--previous-plan")),
    releasePath: absolute(values.get("--release")),
    runnerEnvFile: absolute(values.get("--runner-env-file")),
    trustPolicyDigest: values.get("--trust-policy-digest"),
    trustPolicyPath: absolute(values.get("--trust-policy")),
  });
}

export function createRunnerNativeInstallPlan(input) {
  if (!plainRecord(input) || !absoluteValue(input.artifactDirectory) || !absoluteValue(input.installRoot)
    || !absoluteValue(input.machineConfigPath) || !absoluteValue(input.runnerEnvFile)
    || typeof input.machineConfigDigest !== "string" || !SHA256.test(input.machineConfigDigest)
    || typeof input.runnerEnvFileDigest !== "string" || !SHA256.test(input.runnerEnvFileDigest)) invalidPlan();
  const authorization = validateInstallAuthorization(input.authorization);
  const machineConfig = validateMachineConfig(input.machineConfig, authorization);
  const artifacts = new Map(authorization.artifacts.map((artifact) => [artifact.component, artifact]));
  const runnerArtifact = artifacts.get("physical-runner");
  const testKitArtifact = artifacts.get("godot-testkit");
  if (!runnerArtifact || !testKitArtifact || machineConfig.capabilities.runnerImageDigest !== digestValue(runnerArtifact.releasedDigest)) {
    invalidPlan();
  }
  const connectorCapability = machineConfig.capabilities.steamClientConnector;
  const connectorArtifact = artifacts.get("steam-client-connector") ?? null;
  if (connectorCapability !== null && (!connectorArtifact || connectorCapability.version !== authorization.platformVersion
    || !absoluteValue(input.connectorEnvFile) || typeof input.connectorEnvFileDigest !== "string"
    || !SHA256.test(input.connectorEnvFileDigest) || !plainRecord(input.connectorEnv)
    || input.bridgeObservedDigest !== connectorCapability.binaryDigest)) invalidPlan();
  if (connectorCapability === null && (input.connectorEnvFile !== null || input.connectorEnvFileDigest !== null
    || input.connectorEnv !== null || input.bridgeObservedDigest !== null)) invalidPlan();

  const releaseDirectory = join(input.installRoot, "releases", authorization.releaseId);
  if (!boundaryPath(releaseDirectory, input.installRoot)) invalidPlan();
  const selectedArtifacts = connectorCapability === null
    ? authorization.artifacts.filter((artifact) => artifact.component !== "steam-client-connector")
    : authorization.artifacts;
  const artifactPlans = selectedArtifacts.map((artifact) => Object.freeze({
    component: artifact.component,
    sourcePath: childPath(input.artifactDirectory, artifact.fileName),
    destinationPath: childPath(releaseDirectory, artifact.fileName),
    digest: artifact.releasedDigest,
    sizeLimitBytes: 512 * 1024 * 1024,
    readOnly: true,
  }));
  const destination = new Map(artifactPlans.map((artifact) => [artifact.component, artifact.destinationPath]));
  const previous = input.previousPlan === null ? null : validatePreviousPlan(input.previousPlan, {
    platform: authorization.platform,
    architecture: authorization.architecture,
    installRoot: input.installRoot,
    releaseId: authorization.releaseId,
    releaseDirectory,
  });
  const activationGrantFile = validateRunnerEnvironment(input.runnerEnv, {
    machineConfigPath: input.machineConfigPath,
    testKitPath: destination.get("godot-testkit"),
    testKitDigest: digestValue(testKitArtifact.releasedDigest),
    connectorCapability,
    requiresActivationGrant: previous !== null,
  });
  let bridge = null;
  if (connectorCapability !== null) {
    bridge = validateConnectorEnvironment(input.connectorEnv, {
      runnerId: machineConfig.capabilities.runnerId,
      platform: authorization.platform,
      connectorVersion: authorization.platformVersion,
      connectorCapability,
    });
  }
  const manager = serviceManager(authorization.platform);
  const services = Object.freeze({
    physicalRunner: serviceDefinition("physical-runner", authorization.platform, manager,
      destination.get("physical-runner"), input.runnerEnvFile),
    steamClientConnector: connectorCapability === null ? null : serviceDefinition(
      "steam-client-connector", authorization.platform, manager,
      destination.get("steam-client-connector"), input.connectorEnvFile,
    ),
  });
  const core = Object.freeze({
    schemaVersion: "deviludo.runner-native-install-plan.v1",
    releaseId: authorization.releaseId,
    releaseDigest: authorization.releaseDigest,
    sourceRevision: authorization.sourceRevision,
    platformVersion: authorization.platformVersion,
    platform: authorization.platform,
    architecture: authorization.architecture,
    installRoot: input.installRoot,
    releaseDirectory,
    machine: Object.freeze({
      runnerId: machineConfig.capabilities.runnerId,
      capabilityDigest: machineConfig.capabilities.capabilityDigest,
      machineConfigPath: input.machineConfigPath,
      machineConfigDigest: input.machineConfigDigest,
      runnerSpiffeId: machineConfig.identity.spiffeId,
      steamCapable: connectorCapability !== null,
    }),
    artifacts: Object.freeze(artifactPlans),
    environmentLocks: Object.freeze({
      physicalRunner: Object.freeze({ path: input.runnerEnvFile, digest: input.runnerEnvFileDigest }),
      steamClientConnector: connectorCapability === null ? null : Object.freeze({
        path: input.connectorEnvFile,
        digest: input.connectorEnvFileDigest,
        bridgeExecutable: bridge.executable,
        bridgeDigest: connectorCapability.binaryDigest,
        manifestPath: bridge.manifestPath,
        trustPolicyPath: bridge.trustPolicyPath,
        trustPolicyDigest: bridge.trustPolicyDigest,
      }),
    }),
    services,
    activation: Object.freeze({
      mode: previous === null ? "INITIAL_ENROLLMENT" : "DRAINED_UPGRADE",
      requiredRunnerState: previous === null ? null : "DRAINING",
      requiredActiveLeaseCount: previous === null ? null : 0,
      activationGrantFile,
      switchMode: "ATOMIC_SERVICE_DEFINITION",
      reRegisterCapabilityDigest: machineConfig.capabilities.capabilityDigest,
      healthProbes: Object.freeze(connectorCapability === null
        ? ["PHYSICAL_RUNNER_READY"] : ["STEAM_CONNECTOR_READY", "PHYSICAL_RUNNER_READY"]),
      rollbackOnProbeFailure: previous !== null,
    }),
    rollback: previous,
    preparedAt: authorization.verifiedAt,
  });
  return deepFreeze({ ...core, planDigest: sha256Canonical(core) });
}

export function validateRunnerNativeInstallPlan(plan, expectedDigest) {
  if (!plainRecord(plan) || !exactKeys(plan, PLAN_KEYS) || plan.schemaVersion !== "deviludo.runner-native-install-plan.v1"
    || !SHA256.test(plan.planDigest) || plan.planDigest !== sha256Canonical(withoutPlanDigest(plan))
    || expectedDigest !== undefined && plan.planDigest !== expectedDigest || !UUID.test(plan.releaseId)
    || !PREFIXED_SHA256.test(plan.releaseDigest) || !/^[a-f0-9]{40}$/.test(plan.sourceRevision)
    || typeof plan.platformVersion !== "string" || !new Set(["windows", "linux", "macos"]).has(plan.platform)
    || !new Set(["x86_64", "arm64"]).has(plan.architecture) || !absoluteValue(plan.installRoot)
    || plan.releaseDirectory !== join(plan.installRoot, "releases", plan.releaseId)
    || !canonicalTimestamp(plan.preparedAt) || !plainRecord(plan.machine)
    || !exactKeys(plan.machine, ["capabilityDigest", "machineConfigDigest", "machineConfigPath", "runnerId", "runnerSpiffeId", "steamCapable"])
    || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(plan.machine.runnerId) || !SHA256.test(plan.machine.capabilityDigest)
    || !SHA256.test(plan.machine.machineConfigDigest) || !absoluteValue(plan.machine.machineConfigPath)
    || typeof plan.machine.runnerSpiffeId !== "string" || typeof plan.machine.steamCapable !== "boolean"
    || !Array.isArray(plan.artifacts) || !new Set([2, 3]).has(plan.artifacts.length)) invalidPlan();
  const components = plan.artifacts.map((artifact) => validatePlanArtifact(artifact, plan));
  const artifactPaths = new Map(plan.artifacts.map((artifact) => [artifact.component, artifact.destinationPath]));
  const expectedComponents = plan.artifacts.length === 3
    ? ["godot-testkit", "physical-runner", "steam-client-connector"] : ["godot-testkit", "physical-runner"];
  if (JSON.stringify(components) !== JSON.stringify(expectedComponents) || !plainRecord(plan.environmentLocks)
    || !exactKeys(plan.environmentLocks, ["physicalRunner", "steamClientConnector"])
    || !validEnvironmentLock(plan.environmentLocks.physicalRunner) || !plainRecord(plan.services)
    || !exactKeys(plan.services, ["physicalRunner", "steamClientConnector"])
    || !validService(plan.services.physicalRunner, "physical-runner", plan.platform, plan.environmentLocks.physicalRunner.path)
    || plan.services.physicalRunner.executable !== artifactPaths.get("physical-runner")
    || !validActivation(plan.activation, plan.machine.capabilityDigest, plan.machine.steamCapable, plan.rollback !== null)
    || plan.machine.steamCapable !== (plan.services.steamClientConnector !== null)
    || plan.machine.steamCapable !== (plan.environmentLocks.steamClientConnector !== null)) invalidPlan();
  if (plan.machine.steamCapable && (!validEnvironmentLock(plan.environmentLocks.steamClientConnector, true)
    || !validService(plan.services.steamClientConnector, "steam-client-connector", plan.platform,
      plan.environmentLocks.steamClientConnector.path)
    || plan.services.steamClientConnector.executable !== artifactPaths.get("steam-client-connector"))) invalidPlan();
  if (plan.rollback !== null && (!plainRecord(plan.rollback)
    || !exactKeys(plan.rollback, [
      "previousCapabilityDigest", "previousPlanDigest", "previousPlanPath", "previousReleaseDigest",
      "previousReleaseDirectory", "previousReleaseId", "previousRunnerId",
    ])
    || !SHA256.test(plan.rollback.previousPlanDigest) || !PREFIXED_SHA256.test(plan.rollback.previousReleaseDigest)
    || !SHA256.test(plan.rollback.previousCapabilityDigest) || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(plan.rollback.previousRunnerId)
    || !UUID.test(plan.rollback.previousReleaseId) || plan.rollback.previousReleaseId === plan.releaseId
    || plan.rollback.previousReleaseDirectory !== join(plan.installRoot, "releases", plan.rollback.previousReleaseId)
    || plan.rollback.previousPlanPath !== join(plan.rollback.previousReleaseDirectory, "install-plan.json"))) invalidPlan();
  if (plan.activation.rollbackOnProbeFailure !== (plan.rollback !== null)) invalidPlan();
  return deepFreeze(structuredClone(plan));
}

export async function planRunnerNativeInstallation(options, { now = new Date() } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) invalidInput();
  const [buildReceipt, release, trustPolicy, machineConfig, runnerEnvBytes, previousPlan] = await Promise.all([
    readBoundedJson(options.buildReceiptPath, MAX_JSON_BYTES),
    readBoundedJson(options.releasePath, MAX_JSON_BYTES),
    readBoundedJson(options.trustPolicyPath, MAX_JSON_BYTES),
    loadMachineConfig(options.machineConfigPath),
    readBoundedFile(options.runnerEnvFile, MAX_ENV_BYTES),
    options.previousPlanPath === null ? null : readBoundedJson(options.previousPlanPath, MAX_JSON_BYTES),
  ]);
  const connectorEnvBytes = options.connectorEnvFile === null ? null : await readBoundedFile(options.connectorEnvFile, MAX_ENV_BYTES);
  const connectorEnv = connectorEnvBytes === null ? null : parseEnvironmentLock(connectorEnvBytes);
  const bridgeObservedDigest = connectorEnv === null ? null
    : await digestLargeFile(absolute(connectorEnv.DEVILUDO_STEAM_CONNECTOR_NATIVE_EXECUTABLE));
  const authorization = await verifyRunnerNativeRelease(release, buildReceipt, trustPolicy, options.trustPolicyDigest, {
    artifactDirectory: options.artifactDirectory,
    now,
  });
  const installRoot = await verifiedDirectory(options.installRoot);
  const releaseDirectory = join(installRoot, "releases", authorization.releaseId);
  try { await lstat(releaseDirectory); invalidInput(); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const plan = createRunnerNativeInstallPlan({
    authorization,
    artifactDirectory: await verifiedDirectory(options.artifactDirectory),
    installRoot,
    machineConfig,
    machineConfigPath: options.machineConfigPath,
    machineConfigDigest: await digestFile(options.machineConfigPath),
    runnerEnv: parseEnvironmentLock(runnerEnvBytes),
    runnerEnvFile: options.runnerEnvFile,
    runnerEnvFileDigest: digestBytes(runnerEnvBytes),
    connectorEnv,
    connectorEnvFile: options.connectorEnvFile,
    connectorEnvFileDigest: connectorEnvBytes === null ? null : digestBytes(connectorEnvBytes),
    bridgeObservedDigest,
    previousPlan,
    now,
  });
  await createOnlyJson(options.outputPath, plan);
  return plan;
}

function validateInstallAuthorization(value) {
  if (!plainRecord(value) || !exactKeys(value, AUTHORIZATION_KEYS)
    || !new Set(["deviludo.runner-native-install-authorization.v1", "deviludo.runner-native-install-authorization.v2"])
      .has(value.schemaVersion)
    || value.status !== "VERIFIED" || !UUID.test(value.releaseId) || !PREFIXED_SHA256.test(value.releaseDigest)
    || !PREFIXED_SHA256.test(value.buildReceiptDigest) || !PREFIXED_SHA256.test(value.trustPolicyDigest)
    || !/^[a-f0-9]{40}$/.test(value.sourceRevision)
    || !new Set(["windows", "linux", "macos"]).has(value.platform)
    || !new Set(["x86_64", "arm64"]).has(value.architecture)
    || typeof value.platformVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/.test(value.platformVersion)
    || !canonicalTimestamp(value.verifiedAt) || typeof value.signingKeyId !== "string"
    || !Array.isArray(value.artifacts) || value.artifacts.length < 2 || value.artifacts.length > 3) invalidPlan();
  const components = value.artifacts.map((artifact) => {
    if (!plainRecord(artifact) || !exactKeys(artifact, AUTHORIZATION_ARTIFACT_KEYS)
      || !new Set(["godot-testkit", "physical-runner", "steam-client-connector"]).has(artifact.component)
      || typeof artifact.fileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(artifact.fileName)
      || !PREFIXED_SHA256.test(artifact.releasedDigest) || !PREFIXED_SHA256.test(artifact.identityDigest)) invalidPlan();
    return artifact.component;
  });
  const expected = value.schemaVersion.endsWith(".v2")
    ? ["godot-testkit", "physical-runner", "steam-client-connector"] : ["godot-testkit", "physical-runner"];
  if (JSON.stringify(components) !== JSON.stringify(expected)) invalidPlan();
  return value;
}

function validateMachineConfig(value, authorization) {
  if (!plainRecord(value) || !exactKeys(value, ["schemaVersion", "capabilities", "identity"])
    || value.schemaVersion !== "deviludo.physical-runner-config.v2" || !plainRecord(value.identity)
    || !exactKeys(value.identity, ["certificateFingerprint", "spiffeId"]) || !SHA256.test(value.identity.certificateFingerprint)
    || !validSpiffeId(value.identity.spiffeId)) invalidPlan();
  validateRunnerCapabilities(value.capabilities);
  if (value.capabilities.platform !== authorization.platform || value.capabilities.architecture !== authorization.architecture) invalidPlan();
  return value;
}

function validateRunnerEnvironment(env, expected) {
  if (!plainRecord(env) || env.NODE_ENV !== "production"
    || env.DEVILUDO_PHYSICAL_RUNNER_CONFIG_FILE !== expected.machineConfigPath
    || env.DEVILUDO_PHYSICAL_RUNNER_TESTKIT_EXECUTABLE !== expected.testKitPath
    || env.DEVILUDO_PHYSICAL_RUNNER_TESTKIT_DIGEST !== expected.testKitDigest) invalidPlan();
  const activationGrantFile = env.DEVILUDO_PHYSICAL_RUNNER_ACTIVATION_GRANT_FILE;
  if (expected.requiresActivationGrant ? !absoluteValue(activationGrantFile) : activationGrantFile !== undefined) invalidPlan();
  if (expected.connectorCapability === null) {
    if (RUNNER_STEAM_BINDINGS.some((name) => env[name] !== undefined)) invalidPlan();
    return activationGrantFile ?? null;
  }
  const connector = expected.connectorCapability;
  const values = [connector.version, connector.bridgeVersion, "1", connector.binaryDigest,
    connector.automationPolicyDigest, connector.supplyChainEvidenceDigest];
  if (RUNNER_STEAM_BINDINGS.some((name, index) => env[name] !== values[index])) invalidPlan();
  return activationGrantFile ?? null;
}

function validateConnectorEnvironment(env, expected) {
  if (env.NODE_ENV !== "production" || env.DEVILUDO_STEAM_CONNECTOR_RUNNER_ID !== expected.runnerId
    || env.DEVILUDO_STEAM_CONNECTOR_PLATFORM !== expected.platform
    || env.DEVILUDO_STEAM_CONNECTOR_VERSION !== expected.connectorVersion) invalidPlan();
  const executable = absolute(env.DEVILUDO_STEAM_CONNECTOR_NATIVE_EXECUTABLE);
  const manifestPath = absolute(env.DEVILUDO_STEAM_CONNECTOR_NATIVE_MANIFEST_FILE);
  const trustPolicyPath = absolute(env.DEVILUDO_STEAM_CONNECTOR_NATIVE_TRUST_POLICY_FILE);
  const trustPolicyDigest = env.DEVILUDO_STEAM_CONNECTOR_NATIVE_TRUST_POLICY_DIGEST;
  if (!SHA256.test(trustPolicyDigest)) invalidPlan();
  return Object.freeze({ executable, manifestPath, trustPolicyPath, trustPolicyDigest });
}

function serviceDefinition(component, platform, manager, executable, environmentFile) {
  const connector = component === "steam-client-connector";
  const identifiers = platform === "linux"
    ? connector ? ["deviludo-steam-connector.service", "deviludo-steam-connector"]
      : ["deviludo-physical-runner.service", "deviludo-runner"]
    : platform === "macos"
      ? connector ? ["com.deviludo.steam-connector", "_deviludo_steam"]
        : ["com.deviludo.physical-runner", "_deviludo_runner"]
      : connector ? ["DeviLudoSteamConnector", "NT SERVICE\\DeviLudoSteamConnector"]
        : ["DeviLudoPhysicalRunner", "NT SERVICE\\DeviLudoPhysicalRunner"];
  return Object.freeze({
    component,
    manager,
    serviceId: identifiers[0],
    account: identifiers[1],
    executable,
    arguments: Object.freeze([]),
    environmentSource: Object.freeze({
      kind: platform === "linux" ? "SYSTEMD_ENVIRONMENT_FILE"
        : platform === "macos" ? "LAUNCHD_ENVIRONMENT_DICTIONARY" : "SCM_ENVIRONMENT_BLOCK",
      path: environmentFile,
    }),
    restartPolicy: "ON_FAILURE",
  });
}

function validatePreviousPlan(value, expected) {
  const previous = validateRunnerNativeInstallPlan(value);
  if (previous.platform !== expected.platform || previous.architecture !== expected.architecture || previous.installRoot !== expected.installRoot
    || previous.releaseId === expected.releaseId || previous.releaseDirectory === expected.releaseDirectory) invalidPlan();
  return Object.freeze({
    previousPlanDigest: previous.planDigest,
    previousPlanPath: join(previous.releaseDirectory, "install-plan.json"),
    previousReleaseId: previous.releaseId,
    previousReleaseDigest: previous.releaseDigest,
    previousReleaseDirectory: previous.releaseDirectory,
    previousRunnerId: previous.machine.runnerId,
    previousCapabilityDigest: previous.machine.capabilityDigest,
  });
}

function validatePlanArtifact(artifact, plan) {
  if (!plainRecord(artifact) || !exactKeys(artifact, [
    "component", "destinationPath", "digest", "readOnly", "sizeLimitBytes", "sourcePath",
  ]) || !new Set(["godot-testkit", "physical-runner", "steam-client-connector"]).has(artifact.component)
    || !absoluteValue(artifact.sourcePath) || !absoluteValue(artifact.destinationPath)
    || !boundaryPath(artifact.destinationPath, plan.releaseDirectory) || !PREFIXED_SHA256.test(artifact.digest)
    || artifact.sizeLimitBytes !== 512 * 1024 * 1024 || artifact.readOnly !== true) invalidPlan();
  return artifact.component;
}

function validEnvironmentLock(value, connector = false) {
  if (!plainRecord(value)) return false;
  const keys = connector
    ? ["bridgeDigest", "bridgeExecutable", "digest", "manifestPath", "path", "trustPolicyDigest", "trustPolicyPath"]
    : ["digest", "path"];
  if (!exactKeys(value, keys) || !absoluteValue(value.path) || !SHA256.test(value.digest)) return false;
  return !connector || absoluteValue(value.bridgeExecutable) && SHA256.test(value.bridgeDigest)
    && absoluteValue(value.manifestPath) && absoluteValue(value.trustPolicyPath) && SHA256.test(value.trustPolicyDigest);
}

function validService(value, component, platform, environmentPath) {
  if (!plainRecord(value) || !exactKeys(value, [
    "account", "arguments", "component", "environmentSource", "executable", "manager", "restartPolicy", "serviceId",
  ]) || value.component !== component || !absoluteValue(value.executable) || !Array.isArray(value.arguments)
    || value.arguments.length !== 0 || value.restartPolicy !== "ON_FAILURE" || typeof value.account !== "string"
    || typeof value.serviceId !== "string" || value.manager !== serviceManager(platform)
    || !plainRecord(value.environmentSource) || !exactKeys(value.environmentSource, ["kind", "path"])
    || value.environmentSource.path !== environmentPath) return false;
  const kind = platform === "linux" ? "SYSTEMD_ENVIRONMENT_FILE"
    : platform === "macos" ? "LAUNCHD_ENVIRONMENT_DICTIONARY" : "SCM_ENVIRONMENT_BLOCK";
  return value.environmentSource.kind === kind;
}

function validActivation(value, capabilityDigest, steamCapable, hasRollback) {
  if (!plainRecord(value) || !exactKeys(value, [
    "activationGrantFile", "healthProbes", "mode", "reRegisterCapabilityDigest", "requiredActiveLeaseCount", "requiredRunnerState",
    "rollbackOnProbeFailure", "switchMode",
  ]) || value.mode !== (hasRollback ? "DRAINED_UPGRADE" : "INITIAL_ENROLLMENT")
    || value.requiredRunnerState !== (hasRollback ? "DRAINING" : null)
    || value.requiredActiveLeaseCount !== (hasRollback ? 0 : null)
    || value.switchMode !== "ATOMIC_SERVICE_DEFINITION" || value.reRegisterCapabilityDigest !== capabilityDigest
    || typeof value.rollbackOnProbeFailure !== "boolean" || !Array.isArray(value.healthProbes)) return false;
  if (hasRollback ? !absoluteValue(value.activationGrantFile) : value.activationGrantFile !== null) return false;
  const expected = steamCapable ? ["STEAM_CONNECTOR_READY", "PHYSICAL_RUNNER_READY"] : ["PHYSICAL_RUNNER_READY"];
  return JSON.stringify(value.healthProbes) === JSON.stringify(expected);
}

function parseEnvironmentLock(bytes) {
  const source = bytes.toString("utf8");
  if (source.includes("\0") || source.includes("\r")) invalidInput();
  const values = {};
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1]) || match[2].length > 8_192) invalidInput();
    values[match[1]] = match[2];
  }
  return Object.freeze(values);
}

async function verifiedDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalidInput();
  return realpath(path);
}

async function readBoundedJson(path, maximum) {
  const body = await readBoundedFile(path, maximum);
  try { return JSON.parse(body.toString("utf8")); } catch { invalidInput(); }
}

async function readBoundedFile(path, maximum) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximum) invalidInput();
  return readFile(path);
}

async function createOnlyJson(path, value) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) invalidInput();
  const body = `${canonicalJson(value)}\n`;
  try {
    const file = await open(path, "wx", 0o400);
    try { await file.writeFile(body, "utf8"); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readBoundedJson(path, MAX_JSON_BYTES);
    if (canonicalJson(existing) !== canonicalJson(value)) invalidInput();
  }
}

async function digestFile(path) { return digestBytes(await readBoundedFile(path, MAX_JSON_BYTES)); }
async function digestLargeFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 1024 * 1024 * 1024) invalidInput();
  const file = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, metadata.size - position), position);
      if (bytesRead < 1) invalidInput();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) invalidInput();
    return hash.digest("hex");
  } finally { await file.close(); }
}
function digestBytes(value) { return createHash("sha256").update(value).digest("hex"); }
function digestValue(value) { if (!PREFIXED_SHA256.test(value)) invalidPlan(); return value.slice(7); }
function serviceManager(platform) { return platform === "linux" ? "SYSTEMD" : platform === "macos" ? "LAUNCHD" : "WINDOWS_SCM"; }
function childPath(root, name) { const path = resolve(root, name); if (!boundaryPath(path, root)) invalidPlan(); return path; }
function boundaryPath(path, root) { return absoluteValue(path) && path !== root && path.startsWith(`${root}${sep}`); }
function optionalAbsolute(value) { return value === undefined ? null : absolute(value); }
function absolute(value) { if (!absoluteValue(value)) invalidInput(); return value; }
function absoluteValue(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096; }
function exactKeys(value, keys) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function plainRecord(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const p = Object.getPrototypeOf(value); return p === Object.prototype || p === null; }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function validSpiffeId(value) { try { const url = new URL(value); return url.protocol === "spiffe:" && !!url.hostname && url.pathname !== "/" && !url.username && !url.password && !url.search && !url.hash && url.toString() === value; } catch { return false; } }
function withoutPlanDigest(plan) { return Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "planDigest")); }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
function invalidInput() { throw new Error("Runner native install planning input is invalid"); }
function invalidPlan() { throw new Error("Runner native install plan is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production") invalidInput();
  const plan = await planRunnerNativeInstallation(parseRunnerNativeInstallPlanArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.runner-native-install-planning-result.v1",
    releaseId: plan.releaseId,
    runnerId: plan.machine.runnerId,
    planDigest: plan.planDigest,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[plan:runner-native-install] planning failed\n");
    process.exitCode = 1;
  });
}
