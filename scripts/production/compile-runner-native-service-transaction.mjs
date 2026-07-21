#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import { verifySignedWindowsScmServiceBridgeManifest } from "../../services/runner-control/src/windows-scm-service-bridge.ts";
import { validateRunnerNativeInstallPlan } from "./plan-runner-native-install.mjs";
import { validateStagingReceipt, verifyStagedRunnerNativeInstallation } from "./stage-runner-native-install.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
const SAFE_SYSTEMD_VALUE = /^[A-Za-z0-9_./:@+,[\]{}=-]+$/;
const INLINE_CREDENTIAL_NAME = /(?:API_KEY|PASSWORD|TOKEN|SECRET|SESSION|PRIVATE_KEY)$/;
const SAFE_CREDENTIAL_REFERENCE = /(?:_FILE|_KEY_ID|_PUBLIC_KEY|_DIGEST)$/;

export function parseRunnerNativeServiceTransactionArguments(argv) {
  if (!Array.isArray(argv) || !new Set([6, 14]).has(argv.length)) invalid();
  const allowed = new Set([
    "--output", "--plan", "--plan-digest", "--windows-bridge", "--windows-bridge-manifest",
    "--windows-bridge-trust-policy", "--windows-bridge-trust-policy-digest",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (!SHA256.test(values.get("--plan-digest"))) invalid();
  const hasWindowsBridge = values.has("--windows-bridge");
  if (["--windows-bridge-manifest", "--windows-bridge-trust-policy", "--windows-bridge-trust-policy-digest"]
    .some((name) => values.has(name) !== hasWindowsBridge)) invalid();
  if (hasWindowsBridge && !SHA256.test(values.get("--windows-bridge-trust-policy-digest"))) invalid();
  return Object.freeze({
    outputPath: absolute(values.get("--output")),
    planPath: absolute(values.get("--plan")),
    planDigest: values.get("--plan-digest"),
    windowsBridgePath: hasWindowsBridge ? absolute(values.get("--windows-bridge")) : null,
    windowsBridgeManifestPath: hasWindowsBridge ? absolute(values.get("--windows-bridge-manifest")) : null,
    windowsBridgeTrustPolicyPath: hasWindowsBridge ? absolute(values.get("--windows-bridge-trust-policy")) : null,
    windowsBridgeTrustPolicyDigest: hasWindowsBridge ? values.get("--windows-bridge-trust-policy-digest") : null,
  });
}

export function createRunnerNativeServiceTransaction(input) {
  const plan = validateRunnerNativeInstallPlan(input.plan, input.planDigest);
  const receipt = input.stagingReceipt;
  if (!plainRecord(receipt) || receipt.planDigest !== plan.planDigest || receipt.releaseId !== plan.releaseId
    || receipt.releaseDigest !== plan.releaseDigest || !SHA256.test(receipt.receiptDigest)) invalid();
  const planFileDigest = createHash("sha256").update(`${canonicalJson(plan)}\n`).digest("hex");
  validateStagingReceipt(receipt, plan, planFileDigest);
  const environments = Object.freeze({
    physicalRunner: parseBoundEnvironment(input.physicalRunnerEnvironment, plan.environmentLocks.physicalRunner.digest),
    steamClientConnector: plan.machine.steamCapable
      ? parseBoundEnvironment(input.steamClientConnectorEnvironment, plan.environmentLocks.steamClientConnector.digest)
      : null,
  });
  if (!plan.machine.steamCapable && input.steamClientConnectorEnvironment !== null) invalid();
  const windowsBridge = validateWindowsBridgeAuthorization(plan, input.windowsBridgeAuthorization ?? null);
  const orderedServices = plan.machine.steamCapable
    ? [plan.services.steamClientConnector, plan.services.physicalRunner]
    : [plan.services.physicalRunner];
  const definitions = orderedServices.map((service, index) => createRunnerNativeServiceDefinition({
    plan,
    service,
    environment: service.component === "physical-runner" ? environments.physicalRunner : environments.steamClientConnector,
    startOrder: index + 1,
    windowsBridge,
  }));
  const managerTool = plan.platform === "linux" ? "/usr/bin/systemctl"
    : plan.platform === "macos" ? "/bin/launchctl" : "C:\\Windows\\System32\\sc.exe";
  const activationActions = compileActivationActions(plan.platform, managerTool, definitions);
  const rollbackActions = plan.rollback === null ? Object.freeze([])
    : compileRollbackActions(plan.platform, managerTool, definitions);
  const core = Object.freeze({
    schemaVersion: "deviludo.runner-native-service-transaction.v1",
    status: plan.platform !== "windows" || windowsBridge?.verified === true ? "READY" : "WAITING_NATIVE_BRIDGE",
    planDigest: plan.planDigest,
    stagingReceiptDigest: receipt.receiptDigest,
    releaseId: plan.releaseId,
    releaseDigest: plan.releaseDigest,
    platform: plan.platform,
    architecture: plan.architecture,
    manager: plan.services.physicalRunner.manager,
    managerTool,
    windowsBridge,
    definitions: Object.freeze(definitions),
    activation: Object.freeze({
      mode: plan.activation.mode,
      grantFile: plan.activation.activationGrantFile,
      startOrder: Object.freeze(definitions.map(({ component }) => component)),
      healthProbes: plan.activation.healthProbes,
      actions: activationActions,
    }),
    rollback: plan.rollback === null ? null : Object.freeze({
      previousPlanDigest: plan.rollback.previousPlanDigest,
      previousPlanPath: plan.rollback.previousPlanPath,
      previousReleaseId: plan.rollback.previousReleaseId,
      stopOrder: Object.freeze([...definitions].reverse().map(({ component }) => component)),
      actions: rollbackActions,
    }),
    preparedAt: receipt.stagedAt,
  });
  return deepFreeze({ ...core, transactionDigest: sha256Canonical(core) });
}

export function createRunnerNativeServiceDefinition({ plan, service, environment, startOrder, windowsBridge = null }) {
  if (!plainRecord(plan) || !plainRecord(service) || !plainRecord(environment)
    || !Number.isSafeInteger(startOrder) || startOrder < 1 || startOrder > 2) invalid();
  assertSecretFreeEnvironment(environment);
  if (plan.platform !== "windows" && windowsBridge !== null) invalid();
  const artifactDigest = plan.artifacts.find(({ component }) => component === service.component)?.digest ?? null;
  const targetExecutableDigest = plan.platform === "windows" ? rawSha256(artifactDigest) : artifactDigest;
  const rendered = plan.platform === "linux" ? renderSystemdUnit(service)
    : plan.platform === "macos" ? renderLaunchdPlist(service, environment)
      : renderWindowsScmDescriptor(service, environment, targetExecutableDigest, windowsBridge);
  const format = plan.platform === "linux" ? "SYSTEMD_UNIT"
    : plan.platform === "macos" ? "LAUNCHD_PLIST" : "WINDOWS_SCM_DESCRIPTOR";
  const destination = plan.platform === "linux" ? `/etc/systemd/system/${service.serviceId}`
    : plan.platform === "macos" ? `/Library/LaunchDaemons/${service.serviceId}.plist`
      : `SCM:${service.serviceId}`;
  return Object.freeze({
    component: service.component,
    serviceId: service.serviceId,
    account: service.account,
    manager: service.manager,
    format,
    destination,
    executable: plan.platform === "windows" && windowsBridge?.verified === true ? windowsBridge.path : service.executable,
    executableDigest: plan.platform === "windows" && windowsBridge?.verified === true
      ? windowsBridge.binaryDigest : targetExecutableDigest,
    targetExecutable: plan.platform === "windows" ? service.executable : null,
    targetExecutableDigest: plan.platform === "windows" ? targetExecutableDigest : null,
    environmentSourcePath: service.environmentSource.path,
    environmentSourceDigest: service.component === "physical-runner"
      ? plan.environmentLocks.physicalRunner.digest : plan.environmentLocks.steamClientConnector.digest,
    rendered,
    renderedDigest: createHash("sha256").update(rendered).digest("hex"),
    startOrder,
  });
}

export async function prepareRunnerNativeServiceTransaction(options) {
  const plan = validateRunnerNativeInstallPlan(await readBoundedJson(options.planPath), options.planDigest);
  const hasWindowsBridge = options.windowsBridgePath != null;
  if ((plan.platform === "windows") !== hasWindowsBridge) invalid();
  const stagingReceipt = await verifyStagedRunnerNativeInstallation(plan, plan.releaseDirectory);
  const [physicalRunnerEnvironment, steamClientConnectorEnvironment] = await Promise.all([
    readBoundedFile(plan.environmentLocks.physicalRunner.path, MAX_ENV_BYTES),
    plan.machine.steamCapable ? readBoundedFile(plan.environmentLocks.steamClientConnector.path, MAX_ENV_BYTES) : null,
  ]);
  if (plan.machine.steamCapable
    && await digestLargeFile(plan.environmentLocks.steamClientConnector.bridgeExecutable)
      !== plan.environmentLocks.steamClientConnector.bridgeDigest) invalid();
  let windowsBridgeAuthorization = null;
  if (plan.platform === "windows") {
    const [manifest, trustPolicy, observedDigest] = await Promise.all([
      readBoundedJson(options.windowsBridgeManifestPath),
      readBoundedJson(options.windowsBridgeTrustPolicyPath),
      digestLargeFile(options.windowsBridgePath),
    ]);
    const claims = verifySignedWindowsScmServiceBridgeManifest(manifest, {
      trustPolicy,
      trustPolicyDigest: options.windowsBridgeTrustPolicyDigest,
      architecture: plan.architecture,
    });
    if (observedDigest !== claims.binaryDigest) invalid();
    windowsBridgeAuthorization = Object.freeze({
      verified: true,
      component: "deviludo-windows-scm-service-bridge",
      path: options.windowsBridgePath,
      architecture: claims.architecture,
      bridgeVersion: claims.bridgeVersion,
      contractVersion: claims.serviceContractVersion,
      binaryDigest: claims.binaryDigest,
      sourceDigest: claims.sourceDigest,
      supplyChainEvidenceDigest: claims.supplyChainEvidenceDigest,
      manifestDigest: sha256Canonical(manifest),
      trustPolicyDigest: options.windowsBridgeTrustPolicyDigest,
    });
  }
  const transaction = createRunnerNativeServiceTransaction({
    plan,
    planDigest: options.planDigest,
    stagingReceipt,
    physicalRunnerEnvironment,
    steamClientConnectorEnvironment,
    windowsBridgeAuthorization,
  });
  return transaction;
}

export async function compileRunnerNativeServiceTransaction(options) {
  const transaction = await prepareRunnerNativeServiceTransaction(options);
  await createOnlyJson(options.outputPath, transaction);
  return transaction;
}

function compileActivationActions(platform, managerTool, definitions) {
  const actions = definitions.map((definition) => Object.freeze({
    kind: "INSTALL_DEFINITION",
    component: definition.component,
    destination: definition.destination,
    renderedDigest: definition.renderedDigest,
  }));
  if (platform === "linux") actions.push(Object.freeze({ kind: "RELOAD_MANAGER", tool: managerTool }));
  for (const definition of definitions) {
    if (platform === "linux") {
      actions.push(Object.freeze({ kind: "ENABLE_AND_RESTART", tool: managerTool, serviceId: definition.serviceId }));
    } else if (platform === "macos") {
      actions.push(Object.freeze({ kind: "BOOTOUT_IF_LOADED", tool: managerTool, serviceId: definition.serviceId }));
      actions.push(Object.freeze({ kind: "BOOTSTRAP", tool: managerTool, destination: definition.destination }));
      actions.push(Object.freeze({ kind: "KICKSTART", tool: managerTool, serviceId: definition.serviceId }));
    } else {
      actions.push(Object.freeze({
        kind: "APPLY_SCM_DESCRIPTOR", tool: managerTool, serviceId: definition.serviceId,
        renderedDigest: definition.renderedDigest,
      }));
      actions.push(Object.freeze({ kind: "START_SCM_SERVICE", tool: managerTool, serviceId: definition.serviceId }));
    }
    actions.push(Object.freeze({ kind: "ASSERT_RUNNING", tool: managerTool, serviceId: definition.serviceId, timeoutSeconds: 30 }));
  }
  return Object.freeze(actions);
}

function compileRollbackActions(platform, managerTool, definitions) {
  const actions = [];
  for (const definition of [...definitions].reverse()) {
    actions.push(Object.freeze({
      kind: platform === "windows" ? "STOP_SCM_SERVICE" : "STOP_SERVICE",
      tool: managerTool,
      serviceId: definition.serviceId,
    }));
  }
  actions.push(Object.freeze({ kind: "RESTORE_PREVIOUS_DEFINITIONS" }));
  if (platform === "linux") actions.push(Object.freeze({ kind: "RELOAD_MANAGER", tool: managerTool }));
  actions.push(Object.freeze({ kind: "START_PREVIOUS_SERVICES" }));
  actions.push(Object.freeze({ kind: "ASSERT_PREVIOUS_RUNNING", timeoutSeconds: 30 }));
  return Object.freeze(actions);
}

function renderSystemdUnit(service) {
  for (const value of [service.account, service.executable, service.environmentSource.path]) {
    if (typeof value !== "string" || !SAFE_SYSTEMD_VALUE.test(value) || value.includes("%")) invalid();
  }
  const writable = service.component === "physical-runner" ? "/var/lib/deviludo-runner" : "/var/lib/deviludo";
  return [
    "[Unit]",
    `Description=DeviLudo ${service.component}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${service.account}`,
    `ExecStart=${service.executable}`,
    `EnvironmentFile=${service.environmentSource.path}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectHome=true",
    "ProtectSystem=strict",
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectControlGroups=true",
    "RestrictSUIDSGID=true",
    `ReadWritePaths=${writable}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function renderLaunchdPlist(service, environment) {
  const variables = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  const environmentXml = variables.flatMap(([name, value]) => [
    `      <key>${xml(name)}</key>`,
    `      <string>${xml(value)}</string>`,
  ]).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>", `    <string>${xml(service.serviceId)}</string>`,
    "    <key>ProgramArguments</key>", "    <array>", `      <string>${xml(service.executable)}</string>`, "    </array>",
    "    <key>UserName</key>", `    <string>${xml(service.account)}</string>`,
    "    <key>EnvironmentVariables</key>", "    <dict>", environmentXml, "    </dict>",
    "    <key>RunAtLoad</key>", "    <true/>",
    "    <key>KeepAlive</key>", "    <dict>", "      <key>SuccessfulExit</key>", "      <false/>", "    </dict>",
    "    <key>ProcessType</key>", "    <string>Background</string>",
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

function renderWindowsScmDescriptor(service, environment, targetDigest, windowsBridge) {
  return `${canonicalJson({
    schemaVersion: "deviludo.windows-scm-service-descriptor.v1",
    serviceName: service.serviceId,
    account: service.account,
    binaryPathName: windowsBridge?.verified === true ? windowsBridge.path : null,
    binaryPathDigest: windowsBridge?.verified === true ? windowsBridge.binaryDigest : null,
    targetExecutable: service.executable,
    targetDigest,
    arguments: [],
    startType: "AUTO_START",
    failureActions: [{ action: "RESTART", delaySeconds: 5 }],
    environment: Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))),
    bridgeContractVersion: 1,
    bridgeManifestDigest: windowsBridge?.verified === true ? windowsBridge.manifestDigest : null,
    bridgeTrustPolicyDigest: windowsBridge?.verified === true ? windowsBridge.trustPolicyDigest : null,
    requiresServiceBridgeContractVersion: 1,
  })}\n`;
}

function validateWindowsBridgeAuthorization(plan, value) {
  if (plan.platform !== "windows") {
    if (value !== null) invalid();
    return null;
  }
  if (value === null) return Object.freeze({
    required: true,
    verified: false,
    component: "deviludo-windows-scm-service-bridge",
    contractVersion: 1,
    reasonCode: "SIGNED_WINDOWS_SCM_BRIDGE_REQUIRED",
  });
  const expectedKeys = [
    "architecture", "binaryDigest", "bridgeVersion", "component", "contractVersion", "manifestDigest", "path",
    "sourceDigest", "supplyChainEvidenceDigest", "trustPolicyDigest", "verified",
  ];
  if (!plainRecord(value) || !exactKeys(value, expectedKeys) || value.verified !== true
    || value.component !== "deviludo-windows-scm-service-bridge" || value.architecture !== plan.architecture
    || value.contractVersion !== 1 || !fixedVersion(value.bridgeVersion)
    || !canonicalWindowsBridgePath(value.path) || !SHA256.test(value.binaryDigest)
    || !SHA256.test(value.sourceDigest) || !SHA256.test(value.supplyChainEvidenceDigest)
    || !SHA256.test(value.manifestDigest) || !SHA256.test(value.trustPolicyDigest)) invalid();
  return deepFreeze({
    required: true,
    verified: true,
    component: value.component,
    path: value.path,
    architecture: value.architecture,
    bridgeVersion: value.bridgeVersion,
    contractVersion: value.contractVersion,
    binaryDigest: value.binaryDigest,
    sourceDigest: value.sourceDigest,
    supplyChainEvidenceDigest: value.supplyChainEvidenceDigest,
    manifestDigest: value.manifestDigest,
    trustPolicyDigest: value.trustPolicyDigest,
  });
}

function parseBoundEnvironment(bytes, expectedDigest) {
  if (!Buffer.isBuffer(bytes) || !SHA256.test(expectedDigest)
    || createHash("sha256").update(bytes).digest("hex") !== expectedDigest) invalid();
  const source = bytes.toString("utf8");
  if (source.includes("\0") || source.includes("\r")) invalid();
  const values = {};
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1]) || match[2].length > 8_192) invalid();
    values[match[1]] = match[2];
  }
  if (Object.keys(values).length < 2) invalid();
  assertSecretFreeEnvironment(values);
  return Object.freeze(values);
}

function assertSecretFreeEnvironment(environment) {
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== "string" || /[\0\r\n]/.test(value) || value.length > 8_192
      || INLINE_CREDENTIAL_NAME.test(name) && !SAFE_CREDENTIAL_REFERENCE.test(name)) invalid();
  }
}

async function readBoundedJson(path) {
  const body = await readBoundedFile(path, MAX_JSON_BYTES);
  try { return JSON.parse(body.toString("utf8")); } catch { invalid(); }
}
async function readBoundedFile(path, maximum) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximum) invalid();
  return readFile(path);
}
async function digestLargeFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 1024 * 1024 * 1024) invalid();
  const file = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, metadata.size - position), position);
      if (bytesRead < 1) invalid();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) invalid();
    return hash.digest("hex");
  } finally { await file.close(); }
}
async function createOnlyJson(path, value) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  const body = `${canonicalJson(value)}\n`;
  try {
    const file = await open(path, "wx", 0o400);
    try { await file.writeFile(body, "utf8"); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readBoundedJson(path);
    if (canonicalJson(existing) !== canonicalJson(value)) invalid();
  }
}
function xml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function fixedVersion(value) { return typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/.test(value) && !/(?:latest|stable|default)/i.test(value); }
function rawSha256(value) { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) invalid(); return value.slice(7); }
function canonicalWindowsBridgePath(value) {
  if (typeof value !== "string" || value.length < 4 || value.length > 4_096 || /[\0\r\n/]/.test(value)
    || !/^[A-Za-z]:\\[^:*?"<>|]+$/.test(value) || /(?:^|\\)\.\.?(?:\\|$)/.test(value)) return false;
  return value.slice(value.lastIndexOf("\\") + 1).toLowerCase() === "deviludo-windows-scm-service-bridge.exe";
}
function exactKeys(value, expected) { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]); }
function absolute(value) { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.length > 4_096) invalid(); return value; }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
function invalid() { throw new Error("Runner native service transaction is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production") invalid();
  const transaction = await compileRunnerNativeServiceTransaction(
    parseRunnerNativeServiceTransactionArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "deviludo.runner-native-service-transaction-result.v1",
    releaseId: transaction.releaseId,
    planDigest: transaction.planDigest,
    transactionDigest: transaction.transactionDigest,
    status: transaction.status,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[compile:runner-native-service-transaction] compilation failed\n");
    process.exitCode = 1;
  });
}
