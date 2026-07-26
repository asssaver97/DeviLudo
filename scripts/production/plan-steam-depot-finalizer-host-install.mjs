#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import { validateSteamDepotFinalizerNativeBuildReceipt } from "./build-steam-depot-finalizer-native.mjs";
import { validateSteamDepotFinalizerServiceBuildReceipt } from "../build-steam-depot-finalizer-service.mjs";
import {
  verifySteamDepotFinalizerNativeRuntime,
} from "../../services/steam-depot-finalizer/src/native-controller-release.ts";
import { parseSteamDepotNativePolicy } from "../../services/steam-depot-finalizer/src/native-policy.ts";
import {
  verifySignedSteamDepotFinalizerServiceRelease,
} from "../../services/steam-depot-finalizer/src/native-service-release.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NODE_VERSION = /^v22\.\d+\.\d+$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
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

export function parseSteamDepotFinalizerHostPlanningArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--input") invalid();
  return Object.freeze({ inputPath: requiredAbsolute(argv[1]) });
}

export async function planSteamDepotFinalizerHostInstallation(inputValue, dependencies = {}) {
  const input = validatePlanningInput(inputValue);
  const now = dependencies.now ?? new Date();
  const inspectIdentity = dependencies.inspectIdentity;
  const inspectNode = dependencies.inspectNode ?? executeNodeIdentity;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())
    || inspectIdentity !== undefined && typeof inspectIdentity !== "function" || typeof inspectNode !== "function") invalid();
  await Promise.all([exactDirectory(input.installRoot), exactDirectory(input.workRoot)]);
  const files = {};
  for (const [component, path] of Object.entries(input.sources)) {
    files[component] = await fileMetadata(path, maximumBytes(component));
  }
  files.nodeRuntime = await fileMetadata(input.nodeRuntime.path, MAX_ARTIFACT_BYTES);
  const [serviceBuild, nativeBuild, serviceRelease, serviceTrustPolicy, nativeReleaseValue,
    nativePolicyValue, previousPlan, nodeIdentity] = await Promise.all([
    readValidatedJson(input.sources.serviceBuildReceipt, validateSteamDepotFinalizerServiceBuildReceipt),
    readValidatedJson(input.sources.nativeBuildReceipt, validateSteamDepotFinalizerNativeBuildReceipt),
    readJson(input.sources.serviceRelease),
    readJson(input.sources.serviceTrustPolicy),
    readJson(input.sources.nativeRelease),
    readJson(input.sources.nativePolicy),
    input.previousPlanPath === null ? null : readJson(input.previousPlanPath),
    inspectNode(input.nodeRuntime.path),
  ]);
  const serviceClaims = verifySignedSteamDepotFinalizerServiceRelease(serviceRelease, {
    trustPolicy: serviceTrustPolicy,
    trustPolicyDigest: input.serviceTrustPolicyDigest,
    platformVersion: serviceBuild.platformVersion,
    artifactDigest: files.serviceArtifact.digest,
    artifactSizeBytes: files.serviceArtifact.sizeBytes,
    buildReceiptDigest: files.serviceBuildReceipt.digest,
    now,
  });
  if (serviceClaims.sourceRevision !== serviceBuild.sourceRevision
    || serviceClaims.packageLockDigest !== serviceBuild.packageLockDigest
    || serviceClaims.bundleInputDigest !== serviceBuild.bundleInputDigest
    || serviceBuild.artifactDigest !== files.serviceArtifact.digest
    || serviceBuild.sizeBytes !== files.serviceArtifact.sizeBytes) invalid();
  const nativeRelease = await verifySteamDepotFinalizerNativeRuntime({
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE: input.sources.nativeArtifact,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE_DIGEST: files.nativeArtifact.digest,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_BUILD_RECEIPT_FILE: input.sources.nativeBuildReceipt,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_BUILD_RECEIPT_DIGEST: files.nativeBuildReceipt.digest,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_RELEASE_FILE: input.sources.nativeRelease,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_TRUST_POLICY_FILE: input.sources.nativeTrustPolicy,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_TRUST_POLICY_DIGEST: input.nativeTrustPolicyDigest,
    DEVILUDO_STEAM_DEPOT_FINALIZER_PLATFORM: input.platform,
    DEVILUDO_STEAM_DEPOT_FINALIZER_VERSION: nativeBuild.platformVersion,
  }, { ...(inspectIdentity ? { inspectIdentity } : {}), now });
  if (nativeRelease.claims.sourceRevision !== nativeBuild.sourceRevision
    || nativeRelease.claims.identityDigest !== nativeBuild.identityDigest
    || nativeRelease.claims.nodeVersion !== nativeBuild.nodeVersion
    || nativeRelease.claims.platform !== nativeBuild.platform
    || nativeRelease.claims.architecture !== nativeBuild.architecture) invalid();
  const policy = parseSteamDepotNativePolicy(nativePolicyValue);
  if (policy.platform !== input.platform || policy.workRoot !== input.workRoot
    || files.nativePolicy.digest !== sha256Canonical(policy)) invalid();
  validateNodeIdentity(nodeIdentity, input, nativeBuild, files.nodeRuntime);
  const serviceEnvelope = record(serviceRelease); const nativeEnvelope = record(nativeReleaseValue);
  const nativeSignature = record(nativeEnvelope.signature);
  const serviceKeyId = serviceEnvelope.keyId; const nativeKeyId = nativeSignature.keyId;
  if (typeof serviceKeyId !== "string" || typeof nativeKeyId !== "string") invalid();
  const serviceAuthorization = Object.freeze({
    releaseId: serviceClaims.releaseId,
    sourceRevision: serviceClaims.sourceRevision,
    platformVersion: serviceClaims.platformVersion,
    artifactDigest: files.serviceArtifact.digest,
    buildReceiptDigest: files.serviceBuildReceipt.digest,
    releaseDigest: sha256Canonical(serviceRelease),
    trustPolicyDigest: input.serviceTrustPolicyDigest,
    signingKeyId: serviceKeyId,
  });
  const nativeAuthorization = Object.freeze({
    releaseId: nativeRelease.claims.releaseId,
    sourceRevision: nativeRelease.claims.sourceRevision,
    platformVersion: nativeRelease.claims.platformVersion,
    platform: nativeRelease.claims.platform,
    architecture: nativeRelease.claims.architecture,
    artifactDigest: files.nativeArtifact.digest,
    buildReceiptDigest: files.nativeBuildReceipt.digest,
    releaseDigest: sha256Canonical(nativeReleaseValue),
    trustPolicyDigest: input.nativeTrustPolicyDigest,
    identityDigest: nativeRelease.claims.identityDigest,
    signingKeyId: nativeKeyId,
  });
  const digests = Object.freeze(Object.fromEntries(Object.keys(COMPONENT_FILES).map((component) => [
    component, files[component].digest,
  ])));
  const plan = createSteamDepotFinalizerHostInstallPlan({
    platform: input.platform,
    architecture: input.architecture,
    installRoot: await exactDirectory(input.installRoot),
    workRoot: await exactDirectory(input.workRoot),
    sources: input.sources,
    digests,
    nodeRuntime: input.nodeRuntime,
    serviceAuthorization,
    nativeAuthorization,
    previousPlan,
    preparedAt: now.toISOString(),
  });
  await createOnlyJson(input.outputPath, plan);
  return plan;
}

export function createSteamDepotFinalizerHostInstallPlan(input) {
  validateInput(input);
  const service = validateServiceAuthorization(input.serviceAuthorization);
  const native = validateNativeAuthorization(input.nativeAuthorization);
  if (service.releaseId !== native.releaseId || service.sourceRevision !== native.sourceRevision
    || service.platformVersion !== native.platformVersion || native.platform !== input.platform
    || native.architecture !== input.architecture) invalid();
  if (input.digests.serviceArtifact !== service.artifactDigest
    || input.digests.serviceBuildReceipt !== service.buildReceiptDigest
    || input.digests.nativeArtifact !== native.artifactDigest
    || input.digests.nativeBuildReceipt !== native.buildReceiptDigest) invalid();
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
    serviceTrustPolicyDigest: service.trustPolicyDigest,
    nativeReleaseDigest: native.releaseDigest,
    nativeTrustPolicyDigest: native.trustPolicyDigest,
    nativeIdentityDigest: native.identityDigest,
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
    || !SHA256.test(value.serviceReleaseDigest) || !SHA256.test(value.serviceTrustPolicyDigest)
    || !SHA256.test(value.nativeReleaseDigest) || !SHA256.test(value.nativeTrustPolicyDigest)
    || !SHA256.test(value.nativeIdentityDigest)
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
function validatePlanningInput(value) {
  if (!plainRecord(value) || !exactKeys(value, [
    "architecture", "installRoot", "nativeTrustPolicyDigest", "nodeRuntime", "outputPath", "platform",
    "previousPlanPath", "schemaVersion", "serviceTrustPolicyDigest", "sources", "workRoot",
  ]) || value.schemaVersion !== "deviludo.steam-depot-finalizer-host-planning-input.v1"
    || !platform(value.platform) || !architecture(value.architecture) || !absolute(value.installRoot)
    || !absolute(value.workRoot) || value.installRoot === value.workRoot || !absolute(value.outputPath)
    || value.previousPlanPath !== null && !absolute(value.previousPlanPath)
    || !SHA256.test(value.serviceTrustPolicyDigest) || !SHA256.test(value.nativeTrustPolicyDigest)
    || !plainRecord(value.nodeRuntime) || !exactKeys(value.nodeRuntime, ["digest", "path", "version"])
    || !absolute(value.nodeRuntime.path) || !SHA256.test(value.nodeRuntime.digest)
    || !NODE_VERSION.test(value.nodeRuntime.version) || !plainRecord(value.sources)
    || !exactKeys(value.sources, Object.keys(COMPONENT_FILES))) invalid();
  for (const source of Object.values(value.sources)) if (!absolute(source)) invalid();
  const paths = [...Object.values(value.sources), value.nodeRuntime.path, value.outputPath,
    ...(value.previousPlanPath === null ? [] : [value.previousPlanPath])];
  if (new Set(paths).size !== paths.length) invalid();
  return Object.freeze({
    ...value,
    nodeRuntime: Object.freeze({ ...value.nodeRuntime }),
    sources: Object.freeze({ ...value.sources }),
  });
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
      : target === "macos" ? "DEDICATED_ACCOUNT_AND_ACL" : "RESTRICTED_SERVICE_SID",
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
    : plan.platform === "macos" ? "DEDICATED_ACCOUNT_AND_ACL" : "RESTRICTED_SERVICE_SID";
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
function validateNodeIdentity(value, input, nativeBuild, metadata) {
  if (!plainRecord(value) || !exactKeys(value, ["arch", "execPath", "platform", "version"])
    || value.version !== input.nodeRuntime.version || value.version !== nativeBuild.nodeVersion
    || resolve(value.execPath) !== input.nodeRuntime.path || metadata.digest !== input.nodeRuntime.digest
    || metadata.digest !== nativeBuild.nodeBinaryDigest
    || value.platform !== (input.platform === "macos" ? "darwin" : input.platform === "windows" ? "win32" : "linux")
    || value.arch !== (input.architecture === "x86_64" ? "x64" : "arm64")) invalid();
}
function executeNodeIdentity(path) {
  return new Promise((accept, reject) => execFile(path, ["-p",
    "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,execPath:process.execPath})",
  ], {
    encoding: "utf8", env: { NODE_ENV: "production" }, shell: false, windowsHide: true,
    timeout: 10_000, maxBuffer: 16 * 1024,
  }, (error, stdout, stderr) => {
    if (error || stderr) { reject(new Error("Steam depot finalizer Node identity is invalid")); return; }
    try { accept(JSON.parse(stdout)); } catch { reject(new Error("Steam depot finalizer Node identity is invalid")); }
  }));
}
async function fileMetadata(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum || (before.mode & 0o022) !== 0) invalid();
    const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0;
    while (position < before.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead < 1) invalid();
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return Object.freeze({ digest: hash.digest("hex"), sizeBytes: before.size });
  } finally { await file.close(); }
}
async function readBytes(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > maximum || (before.mode & 0o022) !== 0) invalid();
    const body = await file.readFile(); const after = await file.stat();
    if (body.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return body;
  } finally { await file.close(); }
}
async function readJson(path) { try { return JSON.parse((await readBytes(path, MAX_JSON_BYTES)).toString("utf8")); } catch { invalid(); } }
async function readValidatedJson(path, validate) { return validate(await readJson(path)); }
async function exactDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid();
  const canonical = await realpath(path);
  if (canonical !== path) invalid();
  return canonical;
}
async function createOnlyJson(path, value) {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
  try { await file.writeFile(`${canonicalJson(value)}\n`, "utf8"); await file.sync(); }
  finally { await file.close(); }
}
function maximumBytes(component) { return component === "serviceArtifact" || component === "nativeArtifact" ? MAX_ARTIFACT_BYTES : component === "environment" ? MAX_ENV_BYTES : MAX_JSON_BYTES; }
function withoutDigest(value) { return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "planDigest")); }
function serviceManager(value) { return value === "linux" ? "SYSTEMD" : value === "macos" ? "LAUNCHD" : "WINDOWS_SCM"; }
function platform(value) { return value === "windows" || value === "linux" || value === "macos"; }
function architecture(value) { return value === "x86_64" || value === "arm64"; }
function fixedVersion(value) { return typeof value === "string" && VERSION.test(value) && !/(latest|stable|default)/i.test(value); }
function SAFE_ID(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/.test(value); }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function boundary(path, root) { return absolute(path) && path !== root && path.startsWith(`${root}${sep}`); }
function absolute(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096; }
function requiredAbsolute(value) { if (!absolute(value)) invalid(); return value; }
function exactKeys(value, expected) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function record(value) { if (!plainRecord(value)) invalid(); return value; }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
function invalid() { throw new Error("Steam depot finalizer host install plan is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production") invalid();
  const { inputPath } = parseSteamDepotFinalizerHostPlanningArguments(process.argv.slice(2));
  const input = await readJson(inputPath);
  const plan = await planSteamDepotFinalizerHostInstallation(input);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.steam-depot-finalizer-host-planning-result.v1",
    releaseId: plan.releaseId,
    planDigest: plan.planDigest,
    platform: plan.platform,
    architecture: plan.architecture,
  })}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[plan:steam-depot-finalizer-host] planning failed\n");
    process.exitCode = 1;
  });
}
