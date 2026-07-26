#!/usr/bin/env node

import { isAbsolute, join, resolve, sep } from "node:path";
import { sha256Canonical } from "../../services/runner-control/src/canonical.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NODE_VERSION = /^v22\.\d+\.\d+$/;
const COMPONENT_FILES = Object.freeze({
  serviceArtifact: "deviludo-steam-depot-finalizer-service.mjs",
  serviceBuildReceipt: "steam-depot-finalizer-service-build-receipt.json",
  serviceRelease: "steam-depot-finalizer-service-release.json",
  serviceTrustPolicy: "steam-depot-finalizer-service-trust-policy.json",
  nativeArtifact: "deviludo-steam-depot-finalizer-native",
  nativeBuildReceipt: "steam-depot-finalizer-native-build-receipt.json",
  nativeRelease: "steam-depot-finalizer-native-release.json",
  nativeTrustPolicy: "steam-depot-finalizer-native-trust-policy.json",
  nativePolicy: "steam-depot-finalizer-policy.json",
  environment: "steam-depot-finalizer.env",
});

export function createSteamDepotFinalizerHostInstallPlan(input) {
  validateInput(input);
  const service = validateServiceAuthorization(input.serviceAuthorization);
  const native = validateNativeAuthorization(input.nativeAuthorization);
  if (service.releaseId !== native.releaseId || service.sourceRevision !== native.sourceRevision
    || service.platformVersion !== native.platformVersion || native.platform !== input.platform
    || native.architecture !== input.architecture) invalid();
  if (input.digests.serviceArtifact !== service.artifactDigest
    || input.digests.serviceBuildReceipt !== service.buildReceiptDigest
    || input.digests.serviceRelease !== service.releaseDigest
    || input.digests.serviceTrustPolicy !== service.trustPolicyDigest
    || input.digests.nativeArtifact !== native.artifactDigest
    || input.digests.nativeBuildReceipt !== native.buildReceiptDigest
    || input.digests.nativeRelease !== native.releaseDigest
    || input.digests.nativeTrustPolicy !== native.trustPolicyDigest) invalid();
  const releaseDirectory = join(input.installRoot, "releases", service.releaseId);
  if (!boundary(releaseDirectory, input.installRoot) || input.workRoot.startsWith(`${releaseDirectory}${sep}`)) invalid();
  const artifacts = Object.freeze(Object.keys(COMPONENT_FILES).map((component) => {
    const source = input.sources[component];
    const digest = input.digests[component];
    if (!absolute(source) || !SHA256.test(digest)) invalid();
    const fileName = component === "nativeArtifact" && input.platform === "windows"
      ? `${COMPONENT_FILES[component]}.exe` : COMPONENT_FILES[component];
    return Object.freeze({
      component,
      sourcePath: source,
      destinationPath: join(releaseDirectory, fileName),
      digest,
      mode: component === "serviceArtifact" || component === "nativeArtifact" ? "OWNER_READ_EXECUTE" : "OWNER_READ_ONLY",
      owner: "root",
    });
  }));
  if (new Set(artifacts.map(({ sourcePath }) => sourcePath)).size !== artifacts.length
    || new Set(artifacts.map(({ destinationPath }) => destinationPath)).size !== artifacts.length) invalid();
  const destinations = Object.fromEntries(artifacts.map((artifact) => [artifact.component, artifact.destinationPath]));
  const previous = input.previousPlan === null ? null : rollbackBinding(input.previousPlan, {
    installRoot: input.installRoot,
    platform: input.platform,
    architecture: input.architecture,
    releaseId: service.releaseId,
  });
  const descriptor = serviceDescriptor(input.platform, input.nodeRuntime.path,
    destinations.serviceArtifact, destinations.environment, releaseDirectory);
  const core = Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalizer-host-install-plan.v1",
    releaseId: service.releaseId,
    sourceRevision: service.sourceRevision,
    platformVersion: service.platformVersion,
    platform: input.platform,
    architecture: input.architecture,
    installRoot: input.installRoot,
    releaseDirectory,
    workRoot: input.workRoot,
    serviceReleaseDigest: service.releaseDigest,
    nativeReleaseDigest: native.releaseDigest,
    nodeRuntime: Object.freeze({ ...input.nodeRuntime }),
    artifacts,
    service: descriptor,
    security: securityControls(input.platform, input.workRoot, releaseDirectory),
    activation: Object.freeze({
      mode: previous === null ? "INITIAL" : "DRAINED_UPGRADE",
      switchMode: "ATOMIC_SERVICE_DEFINITION",
      requiredOperationState: previous === null ? null : "DRAINING",
      requiredActiveOperationCount: previous === null ? null : 0,
      healthChecks: Object.freeze(["SIGNED_RELEASES", "NATIVE_IDENTITY", "NATIVE_PROBE", "MTLS_READY"]),
      rollbackOnFailure: previous !== null,
    }),
    rollback: previous,
    preparedAt: input.preparedAt,
  });
  return deepFreeze({ ...core, planDigest: sha256Canonical(core) });
}

export function validateSteamDepotFinalizerHostInstallPlan(value, expectedDigest) {
  if (!plainRecord(value) || value.schemaVersion !== "deviludo.steam-depot-finalizer-host-install-plan.v1"
    || !SHA256.test(value.planDigest) || value.planDigest !== sha256Canonical(withoutDigest(value))
    || expectedDigest !== undefined && value.planDigest !== expectedDigest || !UUID.test(value.releaseId)
    || !SOURCE_REVISION.test(value.sourceRevision) || !fixedVersion(value.platformVersion)
    || !platform(value.platform) || !architecture(value.architecture) || !absolute(value.installRoot)
    || value.releaseDirectory !== join(value.installRoot, "releases", value.releaseId) || !absolute(value.workRoot)
    || !SHA256.test(value.serviceReleaseDigest) || !SHA256.test(value.nativeReleaseDigest)
    || !canonicalTimestamp(value.preparedAt) || !plainRecord(value.nodeRuntime)
    || !exactKeys(value.nodeRuntime, ["digest", "path", "version"]) || !absolute(value.nodeRuntime.path)
    || !SHA256.test(value.nodeRuntime.digest) || !NODE_VERSION.test(value.nodeRuntime.version)
    || !Array.isArray(value.artifacts) || value.artifacts.length !== Object.keys(COMPONENT_FILES).length) invalid();
  const expectedComponents = Object.keys(COMPONENT_FILES);
  if (JSON.stringify(value.artifacts.map((artifact) => validateArtifact(artifact, value)))
    !== JSON.stringify(expectedComponents) || !validService(value.service, value)
    || !validSecurity(value.security, value) || !validActivation(value.activation, value.rollback !== null)
    || value.rollback !== null && !validRollback(value.rollback, value)) invalid();
  return deepFreeze(structuredClone(value));
}

function validateInput(value) {
  if (!plainRecord(value) || !platform(value.platform) || !architecture(value.architecture)
    || !absolute(value.installRoot) || !absolute(value.workRoot) || value.installRoot === value.workRoot
    || !plainRecord(value.sources) || !exactKeys(value.sources, Object.keys(COMPONENT_FILES))
    || !plainRecord(value.digests) || !exactKeys(value.digests, Object.keys(COMPONENT_FILES))
    || !plainRecord(value.nodeRuntime) || !exactKeys(value.nodeRuntime, ["digest", "path", "version"])
    || !absolute(value.nodeRuntime.path) || !SHA256.test(value.nodeRuntime.digest)
    || !NODE_VERSION.test(value.nodeRuntime.version) || !canonicalTimestamp(value.preparedAt)
    || value.previousPlan !== null && !plainRecord(value.previousPlan)) invalid();
}
function validateServiceAuthorization(value) {
  if (!plainRecord(value) || !exactKeys(value, [
    "artifactDigest", "buildReceiptDigest", "platformVersion", "releaseDigest", "releaseId", "signingKeyId",
    "sourceRevision", "trustPolicyDigest",
  ]) || !UUID.test(value.releaseId) || !SOURCE_REVISION.test(value.sourceRevision)
    || !fixedVersion(value.platformVersion) || !SAFE_ID(value.signingKeyId)
    || [value.artifactDigest, value.buildReceiptDigest, value.releaseDigest, value.trustPolicyDigest]
      .some((digest) => !SHA256.test(digest))) invalid();
  return value;
}
function validateNativeAuthorization(value) {
  if (!plainRecord(value) || !exactKeys(value, [
    "architecture", "artifactDigest", "buildReceiptDigest", "identityDigest", "platform", "platformVersion",
    "releaseDigest", "releaseId", "signingKeyId", "sourceRevision", "trustPolicyDigest",
  ]) || !UUID.test(value.releaseId) || !SOURCE_REVISION.test(value.sourceRevision)
    || !fixedVersion(value.platformVersion) || !platform(value.platform) || !architecture(value.architecture)
    || !SAFE_ID(value.signingKeyId) || [value.artifactDigest, value.buildReceiptDigest, value.identityDigest,
      value.releaseDigest, value.trustPolicyDigest].some((digest) => !SHA256.test(digest))) invalid();
  return value;
}
function validateArtifact(value, plan) {
  if (!plainRecord(value) || !exactKeys(value, ["component", "destinationPath", "digest", "mode", "owner", "sourcePath"])
    || !Object.hasOwn(COMPONENT_FILES, value.component) || !absolute(value.sourcePath)
    || !absolute(value.destinationPath) || !boundary(value.destinationPath, plan.releaseDirectory)
    || !SHA256.test(value.digest) || value.owner !== "root"
    || value.mode !== (value.component === "serviceArtifact" || value.component === "nativeArtifact"
      ? "OWNER_READ_EXECUTE" : "OWNER_READ_ONLY")) invalid();
  return value.component;
}
function serviceDescriptor(target, node, artifact, environment, workingDirectory) {
  const identity = target === "linux" ? ["SYSTEMD", "deviludo-steam-depot-finalizer.service", "deviludo-steam-finalizer"]
    : target === "macos" ? ["LAUNCHD", "com.deviludo.steam-depot-finalizer", "_deviludo_finalizer"]
      : ["WINDOWS_SCM", "DeviLudoSteamDepotFinalizer", "NT SERVICE\\DeviLudoSteamDepotFinalizer"];
  return Object.freeze({
    manager: identity[0], serviceId: identity[1], account: identity[2], executable: node,
    arguments: Object.freeze([artifact]), environmentFile: environment, workingDirectory,
    restartPolicy: "ON_FAILURE", interactive: false,
  });
}
function validService(value, plan) {
  if (!plainRecord(value) || !exactKeys(value, [
    "account", "arguments", "environmentFile", "executable", "interactive", "manager", "restartPolicy", "serviceId",
    "workingDirectory",
  ]) || value.executable !== plan.nodeRuntime.path || !Array.isArray(value.arguments) || value.arguments.length !== 1
    || value.arguments[0] !== artifactDestination(plan, "serviceArtifact")
    || value.environmentFile !== artifactDestination(plan, "environment")
    || value.workingDirectory !== plan.releaseDirectory || value.restartPolicy !== "ON_FAILURE"
    || value.interactive !== false) return false;
  return value.manager === serviceManager(plan.platform) && typeof value.serviceId === "string" && typeof value.account === "string";
}
function securityControls(target, workRoot, releaseDirectory) {
  return Object.freeze({
    agentRuntimeInstalled: false,
    automaticUpdates: false,
    credentialExportAllowed: false,
    interactiveLoginAllowed: false,
    releaseTreeReadOnly: true,
    writablePaths: Object.freeze([workRoot]),
    protectedPaths: Object.freeze([releaseDirectory]),
    secretFileMode: "OWNER_READ_ONLY",
    networkPolicy: "EXPLICIT_EGRESS_ALLOWLIST_REQUIRED",
    platformIsolation: target === "linux" ? "SYSTEMD_STRICT_SANDBOX"
      : target === "macos" ? "LAUNCHD_SANDBOX_PROFILE" : "RESTRICTED_SERVICE_SID",
  });
}
function validSecurity(value, plan) {
  if (!plainRecord(value) || !exactKeys(value, [
    "agentRuntimeInstalled", "automaticUpdates", "credentialExportAllowed", "interactiveLoginAllowed", "networkPolicy",
    "platformIsolation", "protectedPaths", "releaseTreeReadOnly", "secretFileMode", "writablePaths",
  ]) || value.agentRuntimeInstalled !== false || value.automaticUpdates !== false
    || value.credentialExportAllowed !== false || value.interactiveLoginAllowed !== false
    || value.releaseTreeReadOnly !== true || value.secretFileMode !== "OWNER_READ_ONLY"
    || value.networkPolicy !== "EXPLICIT_EGRESS_ALLOWLIST_REQUIRED"
    || JSON.stringify(value.writablePaths) !== JSON.stringify([plan.workRoot])
    || JSON.stringify(value.protectedPaths) !== JSON.stringify([plan.releaseDirectory])) return false;
  const isolation = plan.platform === "linux" ? "SYSTEMD_STRICT_SANDBOX"
    : plan.platform === "macos" ? "LAUNCHD_SANDBOX_PROFILE" : "RESTRICTED_SERVICE_SID";
  return value.platformIsolation === isolation;
}
function validActivation(value, upgrading) {
  return plainRecord(value) && exactKeys(value, [
    "healthChecks", "mode", "requiredActiveOperationCount", "requiredOperationState", "rollbackOnFailure", "switchMode",
  ]) && value.mode === (upgrading ? "DRAINED_UPGRADE" : "INITIAL")
    && value.switchMode === "ATOMIC_SERVICE_DEFINITION"
    && value.requiredOperationState === (upgrading ? "DRAINING" : null)
    && value.requiredActiveOperationCount === (upgrading ? 0 : null)
    && value.rollbackOnFailure === upgrading
    && JSON.stringify(value.healthChecks) === JSON.stringify(["SIGNED_RELEASES", "NATIVE_IDENTITY", "NATIVE_PROBE", "MTLS_READY"]);
}
function rollbackBinding(previousValue, expected) {
  const previous = validateSteamDepotFinalizerHostInstallPlan(previousValue);
  if (previous.installRoot !== expected.installRoot || previous.platform !== expected.platform
    || previous.architecture !== expected.architecture || previous.releaseId === expected.releaseId) invalid();
  return Object.freeze({
    previousPlanDigest: previous.planDigest,
    previousReleaseId: previous.releaseId,
    previousReleaseDirectory: previous.releaseDirectory,
    previousServiceReleaseDigest: previous.serviceReleaseDigest,
    previousNativeReleaseDigest: previous.nativeReleaseDigest,
  });
}
function validRollback(value, plan) {
  return plainRecord(value) && exactKeys(value, [
    "previousNativeReleaseDigest", "previousPlanDigest", "previousReleaseDirectory", "previousReleaseId",
    "previousServiceReleaseDigest",
  ]) && SHA256.test(value.previousPlanDigest) && UUID.test(value.previousReleaseId)
    && value.previousReleaseId !== plan.releaseId
    && value.previousReleaseDirectory === join(plan.installRoot, "releases", value.previousReleaseId)
    && SHA256.test(value.previousServiceReleaseDigest) && SHA256.test(value.previousNativeReleaseDigest);
}
function artifactDestination(plan, component) { return plan.artifacts.find((artifact) => artifact.component === component)?.destinationPath; }
function withoutDigest(value) { return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "planDigest")); }
function serviceManager(value) { return value === "linux" ? "SYSTEMD" : value === "macos" ? "LAUNCHD" : "WINDOWS_SCM"; }
function platform(value) { return value === "windows" || value === "linux" || value === "macos"; }
function architecture(value) { return value === "x86_64" || value === "arm64"; }
function fixedVersion(value) { return typeof value === "string" && VERSION.test(value) && !/(latest|stable|default)/i.test(value); }
function SAFE_ID(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/.test(value); }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function boundary(path, root) { return absolute(path) && path !== root && path.startsWith(`${root}${sep}`); }
function absolute(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096; }
function exactKeys(value, expected) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
function invalid() { throw new Error("Steam depot finalizer host install plan is invalid"); }
