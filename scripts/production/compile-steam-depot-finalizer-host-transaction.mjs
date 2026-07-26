#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import { verifySignedWindowsScmNativeActuatorManifest } from "../../services/runner-control/src/windows-scm-native-actuator.ts";
import { verifySignedWindowsScmServiceBridgeManifest } from "../../services/runner-control/src/windows-scm-service-bridge.ts";
import { validateSteamDepotFinalizerHostInstallPlan } from "./plan-steam-depot-finalizer-host-install.mjs";
import {
  validateSteamDepotFinalizerHostStagingReceipt,
  verifyStagedSteamDepotFinalizerHost,
} from "./stage-steam-depot-finalizer-host-install.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ENV_BYTES = 256 * 1024;
const MAX_NATIVE_HELPER_BYTES = 128 * 1024 * 1024;
const SAFE_POSIX = /^\/[A-Za-z0-9._/+@:-]+$/;
const INLINE_CREDENTIAL_NAME = /(?:API_KEY|PASSWORD|TOKEN|SECRET|SESSION|PRIVATE_KEY)$/;
const SAFE_REFERENCE_NAME = /(?:_FILE|_KEY_ID|_PUBLIC_KEY|_DIGEST)$/;
const SERVICE_SIGNER_PREFIX = ["DEVILUDO", "STEAM", "DEPOT", "FINALIZER", "SERVICE", "SIGNER", ""].join("_");
const NATIVE_SIGNER_PREFIX = ["DEVILUDO", "STEAM", "DEPOT", "FINALIZER", "NATIVE", "SIGNER", ""].join("_");

export function parseSteamDepotFinalizerHostTransactionArguments(argv) {
  if (!Array.isArray(argv) || !new Set([6, 14, 22]).has(argv.length)) invalid();
  const allowed = new Set([
    "--output", "--plan", "--plan-digest", "--windows-bridge", "--windows-bridge-manifest",
    "--windows-bridge-trust-policy", "--windows-bridge-trust-policy-digest", "--windows-actuator",
    "--windows-actuator-manifest", "--windows-actuator-trust-policy", "--windows-actuator-trust-policy-digest",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name)
      || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (!SHA256.test(values.get("--plan-digest"))) invalid();
  const hasBridge = values.has("--windows-bridge");
  if (["--windows-bridge-manifest", "--windows-bridge-trust-policy", "--windows-bridge-trust-policy-digest"]
    .some((name) => values.has(name) !== hasBridge)
    || hasBridge && !SHA256.test(values.get("--windows-bridge-trust-policy-digest"))) invalid();
  const hasActuator = values.has("--windows-actuator");
  if (["--windows-actuator-manifest", "--windows-actuator-trust-policy", "--windows-actuator-trust-policy-digest"]
    .some((name) => values.has(name) !== hasActuator) || hasActuator && !hasBridge
    || hasActuator && !SHA256.test(values.get("--windows-actuator-trust-policy-digest"))) invalid();
  return Object.freeze({
    outputPath: requiredAbsolute(values.get("--output")),
    planPath: requiredAbsolute(values.get("--plan")),
    planDigest: values.get("--plan-digest"),
    windowsBridgePath: hasBridge ? requiredAbsolute(values.get("--windows-bridge")) : null,
    windowsBridgeManifestPath: hasBridge ? requiredAbsolute(values.get("--windows-bridge-manifest")) : null,
    windowsBridgeTrustPolicyPath: hasBridge ? requiredAbsolute(values.get("--windows-bridge-trust-policy")) : null,
    windowsBridgeTrustPolicyDigest: hasBridge ? values.get("--windows-bridge-trust-policy-digest") : null,
    windowsActuatorPath: hasActuator ? requiredAbsolute(values.get("--windows-actuator")) : null,
    windowsActuatorManifestPath: hasActuator ? requiredAbsolute(values.get("--windows-actuator-manifest")) : null,
    windowsActuatorTrustPolicyPath: hasActuator ? requiredAbsolute(values.get("--windows-actuator-trust-policy")) : null,
    windowsActuatorTrustPolicyDigest: hasActuator ? values.get("--windows-actuator-trust-policy-digest") : null,
  });
}

export async function compileSteamDepotFinalizerHostTransaction(options, dependencies = {}) {
  const plan = validateSteamDepotFinalizerHostInstallPlan(
    await readJson(options.planPath), options.planDigest,
  );
  const [stagingReceipt, environment] = await Promise.all([
    verifyStagedSteamDepotFinalizerHost(plan, plan.releaseDirectory),
    readBytes(artifact(plan, "environment").destinationPath, MAX_ENV_BYTES),
  ]);
  const helpers = await verifyWindowsHostHelpers(options, plan, dependencies.now ?? new Date());
  const transaction = createSteamDepotFinalizerHostTransaction({
    plan,
    planDigest: plan.planDigest,
    stagingReceipt,
    environment,
    windowsBridgeAuthorization: helpers.bridge,
    windowsActuatorAuthorization: helpers.actuator,
  });
  await createOnlyJson(options.outputPath, transaction);
  return transaction;
}

export async function verifyWindowsHostHelpers(options, planValue, now = new Date()) {
  const plan = validateSteamDepotFinalizerHostInstallPlan(planValue, planValue.planDigest);
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) invalid();
  const hasBridge = options.windowsBridgePath !== null && options.windowsBridgePath !== undefined;
  const hasActuator = options.windowsActuatorPath !== null && options.windowsActuatorPath !== undefined;
  if (plan.platform !== "windows") {
    if (hasBridge || hasActuator) invalid();
    return Object.freeze({ bridge: null, actuator: null });
  }
  if (!hasBridge) {
    if (hasActuator) invalid();
    return Object.freeze({ bridge: null, actuator: null });
  }
  const [bridgeManifest, bridgeTrustPolicy, bridgeDigest] = await Promise.all([
    readJson(options.windowsBridgeManifestPath), readJson(options.windowsBridgeTrustPolicyPath),
    digestFile(options.windowsBridgePath, MAX_NATIVE_HELPER_BYTES),
  ]);
  const bridgeClaims = verifySignedWindowsScmServiceBridgeManifest(bridgeManifest, {
    trustPolicy: bridgeTrustPolicy,
    trustPolicyDigest: options.windowsBridgeTrustPolicyDigest,
    architecture: plan.architecture,
    now,
  });
  if (bridgeDigest !== bridgeClaims.binaryDigest) invalid();
  const bridge = Object.freeze({
    verified: true,
    component: "deviludo-windows-scm-service-bridge",
    path: options.windowsBridgePath,
    architecture: bridgeClaims.architecture,
    bridgeVersion: bridgeClaims.bridgeVersion,
    contractVersion: bridgeClaims.serviceContractVersion,
    binaryDigest: bridgeClaims.binaryDigest,
    sourceDigest: bridgeClaims.sourceDigest,
    supplyChainEvidenceDigest: bridgeClaims.supplyChainEvidenceDigest,
    manifestDigest: sha256Canonical(bridgeManifest),
    trustPolicyDigest: options.windowsBridgeTrustPolicyDigest,
  });
  if (!hasActuator) return Object.freeze({ bridge, actuator: null });
  const [actuatorManifest, actuatorTrustPolicy, actuatorDigest] = await Promise.all([
    readJson(options.windowsActuatorManifestPath), readJson(options.windowsActuatorTrustPolicyPath),
    digestFile(options.windowsActuatorPath, MAX_NATIVE_HELPER_BYTES),
  ]);
  const actuatorClaims = verifySignedWindowsScmNativeActuatorManifest(actuatorManifest, {
    trustPolicy: actuatorTrustPolicy,
    trustPolicyDigest: options.windowsActuatorTrustPolicyDigest,
    architecture: plan.architecture,
    now,
  });
  if (actuatorDigest !== actuatorClaims.binaryDigest) invalid();
  return Object.freeze({
    bridge,
    actuator: Object.freeze({
      verified: true,
      component: "deviludo-windows-scm-native-actuator",
      path: options.windowsActuatorPath,
      architecture: actuatorClaims.architecture,
      actuatorVersion: actuatorClaims.actuatorVersion,
      requestContractVersion: actuatorClaims.requestContractVersion,
      binaryDigest: actuatorClaims.binaryDigest,
      sourceDigest: actuatorClaims.sourceDigest,
      supplyChainEvidenceDigest: actuatorClaims.supplyChainEvidenceDigest,
      manifestDigest: sha256Canonical(actuatorManifest),
      trustPolicyDigest: options.windowsActuatorTrustPolicyDigest,
    }),
  });
}

export function createSteamDepotFinalizerHostTransaction(input) {
  const plan = validateSteamDepotFinalizerHostInstallPlan(input.plan, input.planDigest);
  const receipt = input.stagingReceipt;
  const planFileDigest = createHash("sha256").update(`${canonicalJson(plan)}\n`).digest("hex");
  validateSteamDepotFinalizerHostStagingReceipt(receipt, plan, planFileDigest);
  const environment = parseBoundSteamDepotFinalizerEnvironment(input.environment, plan);
  const bridge = windowsAuthorization(input.windowsBridgeAuthorization ?? null, plan, "bridge");
  const actuator = windowsAuthorization(input.windowsActuatorAuthorization ?? null, plan, "actuator");
  if (plan.platform !== "windows" && (bridge !== null || actuator !== null)
    || plan.platform === "windows" && actuator !== null && bridge === null) invalid();
  const definition = createSteamDepotFinalizerServiceDefinition(plan, environment, bridge);
  const ready = plan.platform !== "windows" || bridge?.verified === true && actuator?.verified === true;
  const managerTool = plan.platform === "linux" ? "/usr/bin/systemctl"
    : plan.platform === "macos" ? "/bin/launchctl" : actuator?.path ?? null;
  const core = Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalizer-host-transaction.v1",
    status: ready ? "READY" : bridge?.verified !== true ? "WAITING_NATIVE_BRIDGE" : "WAITING_NATIVE_ACTUATOR",
    planDigest: plan.planDigest,
    stagingReceiptDigest: receipt.receiptDigest,
    releaseId: plan.releaseId,
    serviceReleaseDigest: plan.serviceReleaseDigest,
    nativeReleaseDigest: plan.nativeReleaseDigest,
    nativeIdentityDigest: plan.nativeIdentityDigest,
    platform: plan.platform,
    architecture: plan.architecture,
    manager: plan.service.manager,
    managerTool,
    windowsBridge: bridge,
    windowsActuator: actuator,
    definition,
    activation: Object.freeze({
      mode: plan.activation.mode,
      requiredOperationState: plan.activation.requiredOperationState,
      requiredActiveOperationCount: plan.activation.requiredActiveOperationCount,
      healthChecks: plan.activation.healthChecks,
      actions: activationActions(plan, definition, managerTool),
    }),
    rollback: plan.rollback === null ? null : Object.freeze({
      previousPlanDigest: plan.rollback.previousPlanDigest,
      previousReleaseId: plan.rollback.previousReleaseId,
      previousReleaseDirectory: plan.rollback.previousReleaseDirectory,
      actions: rollbackActions(plan, definition, managerTool),
    }),
    preparedAt: receipt.stagedAt,
  });
  return deepFreeze({ ...core, transactionDigest: sha256Canonical(core) });
}

export function validateSteamDepotFinalizerHostTransaction(value, expectedDigest) {
  if (!plainRecord(value) || value.schemaVersion !== "deviludo.steam-depot-finalizer-host-transaction.v1"
    || !SHA256.test(value.transactionDigest) || value.transactionDigest !== sha256Canonical(withoutDigest(value))
    || expectedDigest !== undefined && value.transactionDigest !== expectedDigest
    || !new Set(["READY", "WAITING_NATIVE_BRIDGE", "WAITING_NATIVE_ACTUATOR"]).has(value.status)
    || !SHA256.test(value.planDigest) || !SHA256.test(value.stagingReceiptDigest)
    || !SHA256.test(value.serviceReleaseDigest) || !SHA256.test(value.nativeReleaseDigest)
    || !SHA256.test(value.nativeIdentityDigest)
    || !plainRecord(value.definition) || !plainRecord(value.activation)) invalid();
  return deepFreeze(structuredClone(value));
}

export function parseBoundSteamDepotFinalizerEnvironment(bytes, plan) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 2 || bytes.byteLength > MAX_ENV_BYTES) invalid();
  const expectedEnvironment = artifact(plan, "environment");
  if (createHash("sha256").update(bytes).digest("hex") !== expectedEnvironment.digest) invalid();
  const source = bytes.toString("utf8");
  if (source.includes("\0") || source.includes("\r")) invalid();
  const environment = {};
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(environment, match[1]) || match[2].length > 8_192) invalid();
    if (INLINE_CREDENTIAL_NAME.test(match[1]) && !SAFE_REFERENCE_NAME.test(match[1])) invalid();
    if (match[1].startsWith(SERVICE_SIGNER_PREFIX)
      || match[1].startsWith(NATIVE_SIGNER_PREFIX)
      || match[1].includes("AGENT") || /[\n\r\0]/.test(match[2])) invalid();
    if (match[1].endsWith("_FILE") && !absolute(match[2])) invalid();
    environment[match[1]] = match[2];
  }
  const destinations = Object.fromEntries(plan.artifacts.map((entry) => [entry.component, entry.destinationPath]));
  const expected = {
    NODE_ENV: "production",
    DEVILUDO_STEAM_DEPOT_FINALIZER_PLATFORM: plan.platform,
    DEVILUDO_STEAM_DEPOT_FINALIZER_VERSION: plan.platformVersion,
    DEVILUDO_STEAM_DEPOT_FINALIZER_BINARY_DIGEST: artifact(plan, "serviceArtifact").digest,
    DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_ARTIFACT_FILE: destinations.serviceArtifact,
    DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_BUILD_RECEIPT_FILE: destinations.serviceBuildReceipt,
    DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_BUILD_RECEIPT_DIGEST: artifact(plan, "serviceBuildReceipt").digest,
    DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_RELEASE_FILE: destinations.serviceRelease,
    DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_TRUST_POLICY_FILE: destinations.serviceTrustPolicy,
    DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_TRUST_POLICY_DIGEST: plan.serviceTrustPolicyDigest,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE: destinations.nativeArtifact,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE_DIGEST: artifact(plan, "nativeArtifact").digest,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_BUILD_RECEIPT_FILE: destinations.nativeBuildReceipt,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_BUILD_RECEIPT_DIGEST: artifact(plan, "nativeBuildReceipt").digest,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_RELEASE_FILE: destinations.nativeRelease,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_TRUST_POLICY_FILE: destinations.nativeTrustPolicy,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_TRUST_POLICY_DIGEST: plan.nativeTrustPolicyDigest,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_POLICY_FILE: destinations.nativePolicy,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_POLICY_DIGEST: artifact(plan, "nativePolicy").digest,
    DEVILUDO_STEAM_DEPOT_FINALIZER_WORK_ROOT: plan.workRoot,
  };
  if (Object.entries(expected).some(([name, value]) => environment[name] !== value)) invalid();
  const database = environment.DATABASE_URL;
  let url; try { url = new URL(database); } catch { invalid(); }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || url.password || !url.hostname) invalid();
  const requiredFiles = [
    "DEVILUDO_STEAM_DEPOT_FINALIZER_TLS_KEY_FILE",
    "DEVILUDO_STEAM_DEPOT_FINALIZER_TLS_CERT_FILE",
    "DEVILUDO_STEAM_DEPOT_FINALIZER_CLIENT_CA_FILE",
    "DEVILUDO_STEAM_DEPOT_FINALIZER_HEALTH_TLS_KEY_FILE",
    "DEVILUDO_STEAM_DEPOT_FINALIZER_HEALTH_TLS_CERT_FILE",
    "DEVILUDO_STEAM_DEPOT_FINALIZER_HEALTH_TLS_CA_FILE",
  ];
  if (requiredFiles.some((name) => !absolute(environment[name]))
    || new Set(requiredFiles.map((name) => environment[name])).size !== requiredFiles.length
    || !validSpiffeAllowList(environment.DEVILUDO_STEAM_DEPOT_FINALIZER_ALLOWED_SPIFFE_IDS)
    || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(
      environment.DEVILUDO_STEAM_DEPOT_FINALIZER_HEALTH_SERVER_NAME ?? "")) invalid();
  return Object.freeze(Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))));
}

function validSpiffeAllowList(source) {
  let value; try { value = JSON.parse(source); } catch { return false; }
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || new Set(value).size !== value.length
    || JSON.stringify(value) !== JSON.stringify([...value].sort())) return false;
  return value.every((candidate) => {
    if (typeof candidate !== "string") return false;
    let url; try { url = new URL(candidate); } catch { return false; }
    return url.protocol === "spiffe:" && Boolean(url.hostname) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname !== "/" && url.toString() === candidate;
  });
}

export function createSteamDepotFinalizerServiceDefinition(plan, environment, windowsBridge = null) {
  const service = plan.service;
  if (!plainRecord(environment)) invalid();
  let rendered; let format; let destination; let executable = service.executable; let executableDigest = plan.nodeRuntime.digest;
  if (plan.platform === "linux") {
    rendered = renderSystemd(plan, service); format = "SYSTEMD_UNIT";
    destination = `/etc/systemd/system/${service.serviceId}`;
  } else if (plan.platform === "macos") {
    rendered = renderLaunchd(plan, service, environment); format = "LAUNCHD_PLIST";
    destination = `/Library/LaunchDaemons/${service.serviceId}.plist`;
  } else {
    rendered = renderWindows(plan, service, environment, windowsBridge); format = "WINDOWS_SCM_DESCRIPTOR";
    destination = `SCM:${service.serviceId}`;
    executable = windowsBridge?.verified === true ? windowsBridge.path : null;
    executableDigest = windowsBridge?.verified === true ? windowsBridge.binaryDigest : null;
  }
  return Object.freeze({
    serviceId: service.serviceId,
    account: service.account,
    manager: service.manager,
    format,
    destination,
    executable,
    executableDigest,
    targetExecutable: service.executable,
    targetExecutableDigest: plan.nodeRuntime.digest,
    environmentDigest: artifact(plan, "environment").digest,
    rendered,
    renderedDigest: createHash("sha256").update(rendered).digest("hex"),
  });
}

function renderSystemd(plan, service) {
  for (const value of [service.executable, service.arguments[0], service.environmentFile,
    service.workingDirectory, plan.workRoot, plan.releaseDirectory]) if (!SAFE_POSIX.test(value)) invalid();
  if (!/^[a-z_][a-z0-9_-]{2,63}$/.test(service.account)) invalid();
  return [
    "[Unit]", "Description=DeviLudo Steam Depot Finalizer", "After=network-online.target",
    "Wants=network-online.target", "", "[Service]", "Type=simple", `User=${service.account}`,
    `Group=${service.account}`, `WorkingDirectory=${service.workingDirectory}`,
    `EnvironmentFile=${service.environmentFile}`, `ExecStart=${service.executable} ${service.arguments[0]}`,
    "Restart=on-failure", "RestartSec=5s", "UMask=0077", "NoNewPrivileges=yes", "PrivateTmp=yes",
    "ProtectSystem=strict", "ProtectHome=yes", "ProtectKernelTunables=yes", "ProtectKernelModules=yes",
    "ProtectControlGroups=yes", "RestrictSUIDSGID=yes", "LockPersonality=yes", "CapabilityBoundingSet=",
    "AmbientCapabilities=", "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    `ReadOnlyPaths=${plan.releaseDirectory}`, `ReadWritePaths=${plan.workRoot}`, "", "[Install]",
    "WantedBy=multi-user.target", "",
  ].join("\n");
}
function renderLaunchd(plan, service, environment) {
  const environmentXml = Object.entries(environment).flatMap(([name, value]) => [
    `      <key>${xml(name)}</key>`, `      <string>${xml(value)}</string>`,
  ]);
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">", "  <dict>", "    <key>Label</key>", `    <string>${xml(service.serviceId)}</string>`,
    "    <key>UserName</key>", `    <string>${xml(service.account)}</string>`, "    <key>ProgramArguments</key>",
    "    <array>", `      <string>${xml(service.executable)}</string>`, `      <string>${xml(service.arguments[0])}</string>`,
    "    </array>", "    <key>WorkingDirectory</key>", `    <string>${xml(service.workingDirectory)}</string>`,
    "    <key>EnvironmentVariables</key>", "    <dict>", ...environmentXml, "    </dict>",
    "    <key>RunAtLoad</key>", "    <true/>", "    <key>KeepAlive</key>", "    <dict>",
    "      <key>SuccessfulExit</key>", "      <false/>", "    </dict>", "    <key>ProcessType</key>",
    "    <string>Background</string>", "    <key>HardResourceLimits</key>", "    <dict>",
    "      <key>Core</key>", "      <integer>0</integer>", "    </dict>", "  </dict>", "</plist>", "",
  ].join("\n");
}
function renderWindows(plan, service, environment, bridge) {
  return canonicalJson({
    schemaVersion: "deviludo.windows-scm-service-definition.v1",
    serviceId: service.serviceId,
    account: service.account,
    serviceSidType: "RESTRICTED",
    interactive: false,
    bridgeExecutable: bridge?.verified === true ? bridge.path : null,
    bridgeDigest: bridge?.verified === true ? bridge.binaryDigest : null,
    targetExecutable: service.executable,
    targetExecutableDigest: plan.nodeRuntime.digest,
    arguments: service.arguments,
    workingDirectory: service.workingDirectory,
    environment,
    requiredPrivileges: [],
    failureActions: [{ action: "RESTART", delayMs: 5_000 }],
  });
}

function activationActions(plan, definition, managerTool) {
  const actions = [{ kind: "INSTALL_DEFINITION", destination: definition.destination, digest: definition.renderedDigest }];
  if (plan.platform === "linux") actions.push({ kind: "RELOAD_MANAGER", tool: managerTool });
  if (plan.platform === "linux") actions.push({ kind: "ENABLE_AND_RESTART", tool: managerTool, serviceId: definition.serviceId });
  else if (plan.platform === "macos") {
    actions.push({ kind: "BOOTOUT_IF_LOADED", tool: managerTool, serviceId: definition.serviceId });
    actions.push({ kind: "BOOTSTRAP", tool: managerTool, destination: definition.destination });
  } else actions.push({ kind: "UPSERT_AND_START", tool: managerTool, serviceId: definition.serviceId });
  for (const check of plan.activation.healthChecks) actions.push({ kind: "VERIFY_HEALTH", check });
  return Object.freeze(actions.map((action) => Object.freeze(action)));
}
function rollbackActions(plan, definition, managerTool) {
  return Object.freeze([
    Object.freeze({ kind: "STOP", tool: managerTool, serviceId: definition.serviceId }),
    Object.freeze({ kind: "RESTORE_PREVIOUS_PLAN", previousPlanDigest: plan.rollback.previousPlanDigest,
      previousReleaseDirectory: plan.rollback.previousReleaseDirectory }),
    Object.freeze({ kind: "START_PREVIOUS", tool: managerTool, serviceId: definition.serviceId }),
    Object.freeze({ kind: "VERIFY_PREVIOUS_HEALTH", checks: plan.activation.healthChecks }),
  ]);
}
function windowsAuthorization(value, plan, kind) {
  if (value === null) return null;
  const versionName = kind === "bridge" ? "bridgeVersion" : "actuatorVersion";
  const contractName = kind === "bridge" ? "contractVersion" : "requestContractVersion";
  const component = kind === "bridge" ? "deviludo-windows-scm-service-bridge" : "deviludo-windows-scm-native-actuator";
  if (plan.platform !== "windows" || !plainRecord(value) || !exactKeys(value, [
    "architecture", "binaryDigest", "component", contractName, "manifestDigest", "path", "sourceDigest",
    "supplyChainEvidenceDigest", "trustPolicyDigest", "verified", versionName,
  ])
    || value.verified !== true || value.architecture !== plan.architecture || !absolute(value.path)
    || value.component !== component || !fixedVersionAtLeast(value[versionName], 1, 1, 0) || !SHA256.test(value.binaryDigest)
    || !SHA256.test(value.sourceDigest) || !SHA256.test(value.supplyChainEvidenceDigest)
    || !SHA256.test(value.manifestDigest) || !SHA256.test(value.trustPolicyDigest)
    || value[contractName] !== 1) invalid();
  return Object.freeze({ ...value, kind });
}
function artifact(plan, component) { const value = plan.artifacts.find((entry) => entry.component === component); if (!value) invalid(); return value; }
async function readBytes(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > maximum) invalid();
    const bytes = await file.readFile(); const after = await file.stat();
    if (bytes.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return bytes;
  } finally { await file.close(); }
}
async function readJson(path) { try { return JSON.parse((await readBytes(path, 1024 * 1024)).toString("utf8")); } catch { invalid(); } }
async function digestFile(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum) invalid();
    const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0;
    while (position < before.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead < 1) invalid(); hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await file.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return hash.digest("hex");
  } finally { await file.close(); }
}
async function createOnlyJson(path, value) {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
  try { await file.writeFile(`${canonicalJson(value)}\n`); await file.sync(); } finally { await file.close(); }
}
function xml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function withoutDigest(value) { return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "transactionDigest")); }
function absolute(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096; }
function fixedVersion(value) { return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) && !/(latest|stable|default)/i.test(value); }
function fixedVersionAtLeast(value, major, minor, patch) {
  if (!fixedVersion(value)) return false;
  const observed = value.split("-", 1)[0].split(".").map(Number);
  return observed[0] > major || observed[0] === major
    && (observed[1] > minor || observed[1] === minor && observed[2] >= patch);
}
function requiredAbsolute(value) { if (!absolute(value)) invalid(); return value; }
function exactKeys(value, expected) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
function invalid() { throw new Error("Steam depot finalizer host transaction is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production") invalid();
  const transaction = await compileSteamDepotFinalizerHostTransaction(
    parseSteamDepotFinalizerHostTransactionArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.steam-depot-finalizer-host-transaction-result.v1",
    releaseId: transaction.releaseId,
    status: transaction.status,
    transactionDigest: transaction.transactionDigest,
  })}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[compile:steam-depot-finalizer-host] transaction failed\n");
    process.exitCode = 1;
  });
}
