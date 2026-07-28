import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createRunnerCapabilityDigest } from "../services/runner-control/src/coordinator.ts";
import { canonicalJson, sha256Canonical, signCanonical } from "../services/runner-control/src/canonical.ts";
import {
  createRunnerNativeInstallPlan,
  parseRunnerNativeInstallPlanArguments,
  validateRunnerNativeInstallPlan,
} from "../scripts/production/plan-runner-native-install.mjs";
import {
  stageRunnerNativeInstallation,
  verifyStagedRunnerNativeInstallation,
} from "../scripts/production/stage-runner-native-install.mjs";
import {
  createRunnerNativeActivationAuthorizationRequest,
  requestRunnerNativeActivation,
} from "../scripts/production/request-runner-native-activation.mjs";
import {
  createRunnerNativeServiceDefinition,
  createRunnerNativeServiceTransaction,
  parseRunnerNativeServiceTransactionArguments,
} from "../scripts/production/compile-runner-native-service-transaction.mjs";
import {
  applyRunnerNativeServiceTransaction,
  parseRunnerNativeServiceActuationArguments,
} from "../scripts/production/apply-runner-native-service-transaction.mjs";
import {
  applyInitialRunnerNativeServiceTransaction,
  parseInitialRunnerNativeActuationArguments,
} from "../scripts/production/apply-initial-runner-native-service-transaction.mjs";
import {
  parseE2EHostDeploymentArguments,
  validateE2EHostDeploymentConfig,
} from "../scripts/production/deploy-e2e-runner-host.mjs";

const hex = (character) => character.repeat(64);
const prefixed = (character) => `sha256:${hex(character)}`;
const runnerId = "runner-linux-1";
const machineConfigPath = "/etc/deviludo/physical-runner.json";
const runnerEnvFile = "/etc/deviludo/physical-runner.env";
const connectorEnvFile = "/etc/deviludo/steam-client-connector.env";

test("install plan derives immutable paths and a source-only systemd activation from the verified release", () => {
  const authorization = installAuthorization();
  const machineConfig = config(false);
  const plan = createRunnerNativeInstallPlan({
    authorization,
    artifactDirectory: "/private/staging/final-artifacts",
    installRoot: "/opt/deviludo/native",
    machineConfig,
    machineConfigPath,
    machineConfigDigest: hex("9"),
    runnerEnv: runnerEnvironment(machineConfig, authorization),
    runnerEnvFile,
    runnerEnvFileDigest: hex("8"),
    connectorEnv: null,
    connectorEnvFile: null,
    connectorEnvFileDigest: null,
    bridgeObservedDigest: null,
    previousPlan: null,
    now: new Date("2026-07-22T01:00:00.000Z"),
  });
  assert.equal(plan.schemaVersion, "deviludo.runner-native-install-plan.v1");
  assert.equal(plan.releaseDirectory, `/opt/deviludo/native/releases/${authorization.releaseId}`);
  assert.equal(plan.services.physicalRunner.manager, "SYSTEMD");
  assert.equal(plan.services.physicalRunner.account, "deviludo-runner");
  assert.equal(plan.services.steamClientConnector, null);
  assert.equal(plan.activation.mode, "INITIAL_ENROLLMENT");
  assert.equal(plan.activation.requiredRunnerState, null);
  assert.equal(plan.activation.requiredActiveLeaseCount, null);
  assert.equal(plan.activation.rollbackOnProbeFailure, false);
  assert.equal(plan.artifacts[0].readOnly, true);
  assert.deepEqual(validateRunnerNativeInstallPlan(plan), plan);
  assert.throws(() => validateRunnerNativeInstallPlan({ ...plan, releaseDigest: prefixed("0") }), /plan is invalid/);
  assert.throws(() => createRunnerNativeInstallPlan({
    ...baseInput(authorization, machineConfig),
    runnerEnv: runnerEnvironment(machineConfig, authorization),
    bridgeObservedDigest: null,
    previousPlan: null,
    now: new Date("2026-07-22T01:00:00.000Z"),
    machineConfig: { ...machineConfig, capabilities: { ...machineConfig.capabilities, runnerImageDigest: hex("0") } },
  }), /capability digest mismatch|plan is invalid/);
});

test("Steam-capable upgrade locks the separate Connector service, bridge digest and rollback target", () => {
  const firstAuthorization = installAuthorization();
  const machineConfig = config(true);
  const first = createRunnerNativeInstallPlan({
    ...baseInput(firstAuthorization, machineConfig),
    runnerEnv: runnerEnvironment(machineConfig, firstAuthorization),
    connectorEnv: connectorEnvironment(machineConfig, firstAuthorization),
    connectorEnvFile,
    connectorEnvFileDigest: hex("7"),
    bridgeObservedDigest: machineConfig.capabilities.steamClientConnector.binaryDigest,
    previousPlan: null,
    now: new Date("2026-07-22T01:00:00.000Z"),
  });
  assert.equal(first.services.steamClientConnector.account, "deviludo-steam-connector");
  assert.equal(first.environmentLocks.steamClientConnector.bridgeDigest, hex("4"));
  assert.deepEqual(first.activation.healthProbes, ["STEAM_CONNECTOR_READY", "PHYSICAL_RUNNER_READY"]);

  const nextAuthorization = { ...firstAuthorization, releaseId: "22222222-2222-4222-8222-222222222222", releaseDigest: prefixed("e") };
  const next = createRunnerNativeInstallPlan({
    ...baseInput(nextAuthorization, machineConfig),
    runnerEnv: runnerEnvironment(machineConfig, nextAuthorization, true),
    connectorEnv: connectorEnvironment(machineConfig, nextAuthorization),
    connectorEnvFile,
    connectorEnvFileDigest: hex("7"),
    bridgeObservedDigest: machineConfig.capabilities.steamClientConnector.binaryDigest,
    previousPlan: first,
    now: new Date("2026-07-22T02:00:00.000Z"),
  });
  assert.equal(next.rollback.previousPlanDigest, first.planDigest);
  assert.equal(next.rollback.previousReleaseId, first.releaseId);
  assert.equal(next.activation.rollbackOnProbeFailure, true);
  assert.equal(next.activation.mode, "DRAINED_UPGRADE");
  assert.equal(next.activation.requiredRunnerState, "DRAINING");
  assert.equal(next.activation.requiredActiveLeaseCount, 0);
  assert.throws(() => createRunnerNativeInstallPlan({
    ...baseInput(firstAuthorization, machineConfig),
    runnerEnv: runnerEnvironment(machineConfig, firstAuthorization),
    connectorEnv: connectorEnvironment(machineConfig, firstAuthorization),
    connectorEnvFile,
    connectorEnvFileDigest: hex("7"),
    bridgeObservedDigest: hex("0"),
    previousPlan: null,
    now: new Date("2026-07-22T01:00:00.000Z"),
  }), /plan is invalid/);
});

test("install-plan CLI requires the complete reviewed release set and absolute optional inputs", () => {
  const args = [
    "--artifacts", "/private/staging/artifacts",
    "--build-receipt", "/private/staging/build.json",
    "--release", "/private/staging/release.json",
    "--trust-policy", "/private/policy/runner.json",
    "--trust-policy-digest", prefixed("1"),
    "--machine-config", machineConfigPath,
    "--install-root", "/opt/deviludo/native",
    "--runner-env-file", runnerEnvFile,
    "--output", "/private/staging/install-plan.json",
    "--connector-env-file", connectorEnvFile,
    "--previous-plan", "/private/staging/previous-plan.json",
  ];
  const parsed = parseRunnerNativeInstallPlanArguments(args);
  assert.equal(parsed.connectorEnvFile, connectorEnvFile);
  assert.equal(parsed.previousPlanPath, "/private/staging/previous-plan.json");
  assert.throws(() => parseRunnerNativeInstallPlanArguments(args.map((value) =>
    value === "/opt/deviludo/native" ? "relative" : value)), /input is invalid/);
  assert.throws(() => parseRunnerNativeInstallPlanArguments([...args.slice(0, 16), ...args.slice(18)]), /input is invalid/);
});

test("native activation request binds the staged receipt and waits for a signed zero-lease grant", async () => {
  const firstAuthorization = installAuthorization();
  const machineConfig = config(false);
  const first = createRunnerNativeInstallPlan({
    ...baseInput(firstAuthorization, machineConfig),
    runnerEnv: runnerEnvironment(machineConfig, firstAuthorization),
    connectorEnv: null,
    connectorEnvFile: null,
    connectorEnvFileDigest: null,
    bridgeObservedDigest: null,
    previousPlan: null,
    now: new Date("2026-07-22T01:00:00.000Z"),
  });
  const nextAuthorization = {
    ...firstAuthorization,
    releaseId: "22222222-2222-4222-8222-222222222222",
    releaseDigest: prefixed("e"),
  };
  const next = createRunnerNativeInstallPlan({
    ...baseInput(nextAuthorization, machineConfig),
    runnerEnv: runnerEnvironment(machineConfig, nextAuthorization, true),
    connectorEnv: null,
    connectorEnvFile: null,
    connectorEnvFileDigest: null,
    bridgeObservedDigest: null,
    previousPlan: first,
    now: new Date("2026-07-22T02:00:00.000Z"),
  });
  const planBytes = Buffer.from(`${canonicalJson(next)}\n`, "utf8");
  const receiptCore = {
    schemaVersion: "deviludo.runner-native-staging-receipt.v1",
    status: "STAGED",
    planDigest: next.planDigest,
    planFileDigest: createHash("sha256").update(planBytes).digest("hex"),
    releaseId: next.releaseId,
    releaseDigest: next.releaseDigest,
    platform: next.platform,
    architecture: next.architecture,
    releaseDirectory: next.releaseDirectory,
    stagedAt: "2026-07-22T02:01:00.000Z",
    artifacts: next.artifacts.map((artifact) => ({
      component: artifact.component,
      path: artifact.destinationPath,
      digest: artifact.digest,
      sizeBytes: 32,
      readOnly: true,
    })),
  };
  const stagingReceipt = { ...receiptCore, receiptDigest: sha256Canonical(receiptCore) };
  const input = {
    plan: next,
    planDigest: next.planDigest,
    currentPlan: first,
    currentPlanPath: next.rollback.previousPlanPath,
    stagingReceipt,
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    outputPath: next.activation.activationGrantFile,
  };
  const request = createRunnerNativeActivationAuthorizationRequest(input);
  assert.equal(request.stagingReceiptDigest, stagingReceipt.receiptDigest);
  assert.equal(request.currentRunnerId, first.machine.runnerId);
  assert.equal(request.targetCapabilityDigest, next.machine.capabilityDigest);

  const draining = await requestRunnerNativeActivation(input, {
    ingress: { async authorizeNativeInstall() {
      return {
        schemaVersion: "deviludo.runner-native-install-drain-receipt.v1",
        operationId: request.operationId,
        currentRunnerId: request.currentRunnerId,
        planDigest: request.planDigest,
        state: "DRAINING",
        activeLeaseCount: 1,
        observedAt: "2026-07-22T02:02:00.000Z",
        retryAfterSeconds: 5,
      };
    } },
    publicKey: generateKeyPairSync("ed25519").publicKey,
    keyId: "runner-jobs-01",
    now: new Date("2026-07-22T02:02:00.000Z"),
  });
  assert.equal(draining.authorized, false);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const issuedAt = "2026-07-22T02:03:00.000Z";
  const payload = {
    schemaVersion: "deviludo.runner-native-install-activation-grant.v1",
    operationId: request.operationId,
    grantSequence: 1,
    currentRunnerId: request.currentRunnerId,
    currentSpiffeId: first.machine.runnerSpiffeId,
    currentCapabilityDigest: request.currentCapabilityDigest,
    targetRunnerId: request.targetRunnerId,
    targetSpiffeId: request.targetSpiffeId,
    targetCapabilityDigest: request.targetCapabilityDigest,
    platform: request.platform,
    architecture: request.architecture,
    planDigest: request.planDigest,
    stagingReceiptDigest: request.stagingReceiptDigest,
    releaseId: request.releaseId,
    releaseDigest: request.releaseDigest,
    requiredRunnerState: "DRAINING",
    activeLeaseCount: 0,
    issuedAt,
    expiresAt: "2026-07-22T02:13:00.000Z",
  };
  const signed = { payload, signature: {
    algorithm: "Ed25519", keyId: "runner-jobs-01", value: signCanonical(privateKey, payload),
  } };
  const authorized = await requestRunnerNativeActivation(input, {
    ingress: { async authorizeNativeInstall() { return signed; } },
    publicKey,
    keyId: "runner-jobs-01",
    now: new Date(issuedAt),
  });
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.result.payload.activeLeaseCount, 0);
  assert.throws(() => createRunnerNativeActivationAuthorizationRequest({
    ...input,
    stagingReceipt: { ...stagingReceipt, receiptDigest: hex("0") },
  }), /activation request|staging input/);
});

test("service transaction compiles a digest-bound hardened systemd switch with no shell command", () => {
  const authorization = installAuthorization();
  const machineConfig = config(true);
  const runnerEnvironmentBytes = environmentBytes(runnerEnvironment(machineConfig, authorization));
  const connectorEnvironmentBytes = environmentBytes(connectorEnvironment(machineConfig, authorization));
  const plan = createRunnerNativeInstallPlan({
    ...baseInput(authorization, machineConfig),
    runnerEnv: runnerEnvironment(machineConfig, authorization),
    runnerEnvFileDigest: digest(runnerEnvironmentBytes),
    connectorEnv: connectorEnvironment(machineConfig, authorization),
    connectorEnvFile,
    connectorEnvFileDigest: digest(connectorEnvironmentBytes),
    bridgeObservedDigest: machineConfig.capabilities.steamClientConnector.binaryDigest,
    previousPlan: null,
    now: new Date("2026-07-22T04:00:00.000Z"),
  });
  const receipt = stagingReceipt(plan);
  const transaction = createRunnerNativeServiceTransaction({
    plan,
    planDigest: plan.planDigest,
    stagingReceipt: receipt,
    physicalRunnerEnvironment: runnerEnvironmentBytes,
    steamClientConnectorEnvironment: connectorEnvironmentBytes,
  });
  assert.equal(transaction.status, "READY");
  assert.equal(transaction.managerTool, "/usr/bin/systemctl");
  assert.deepEqual(transaction.activation.startOrder, ["steam-client-connector", "physical-runner"]);
  assert.match(transaction.definitions[1].rendered, /NoNewPrivileges=true/);
  assert.match(transaction.definitions[1].rendered, /ProtectSystem=strict/);
  assert.equal(transaction.definitions[1].environmentSourceDigest, digest(runnerEnvironmentBytes));
  assert.ok(transaction.activation.actions.every((action) => !Object.hasOwn(action, "command") && !Object.hasOwn(action, "argv")));
  assert.equal(transaction.windowsBridge, null);
  assert.equal(transaction.transactionDigest, sha256Canonical(Object.fromEntries(
    Object.entries(transaction).filter(([key]) => key !== "transactionDigest"),
  )));
  assert.throws(() => createRunnerNativeServiceTransaction({
    plan,
    planDigest: plan.planDigest,
    stagingReceipt: receipt,
    physicalRunnerEnvironment: Buffer.from("NODE_ENV=production\nDEVILUDO_API_KEY=plaintext\n"),
    steamClientConnectorEnvironment: connectorEnvironmentBytes,
  }), /service transaction is invalid/);
  const unsafeEnvironment = {
    ...runnerEnvironment(machineConfig, authorization),
    DEVILUDO_API_KEY: "plaintext",
  };
  const unsafeBytes = environmentBytes(unsafeEnvironment);
  const unsafePlan = createRunnerNativeInstallPlan({
    ...baseInput(authorization, machineConfig),
    runnerEnv: unsafeEnvironment,
    runnerEnvFileDigest: digest(unsafeBytes),
    connectorEnv: connectorEnvironment(machineConfig, authorization),
    connectorEnvFile,
    connectorEnvFileDigest: digest(connectorEnvironmentBytes),
    bridgeObservedDigest: machineConfig.capabilities.steamClientConnector.binaryDigest,
    previousPlan: null,
    now: new Date("2026-07-22T04:05:00.000Z"),
  });
  assert.throws(() => createRunnerNativeServiceTransaction({
    plan: unsafePlan,
    planDigest: unsafePlan.planDigest,
    stagingReceipt: stagingReceipt(unsafePlan),
    physicalRunnerEnvironment: unsafeBytes,
    steamClientConnectorEnvironment: connectorEnvironmentBytes,
  }), /service transaction is invalid/);
});

test("service definitions render launchd safely and keep Windows blocked on the signed SCM bridge", () => {
  const authorization = installAuthorization();
  const machineConfig = config(false);
  const environment = {
    ...runnerEnvironment(machineConfig, authorization),
    DEVILUDO_RENDER_TEST: "<&>\"'",
  };
  const environmentBody = environmentBytes(environment);
  const linux = createRunnerNativeInstallPlan({
    ...baseInput(authorization, machineConfig),
    runnerEnv: environment,
    runnerEnvFileDigest: digest(environmentBody),
    connectorEnv: null,
    connectorEnvFile: null,
    connectorEnvFileDigest: null,
    bridgeObservedDigest: null,
    previousPlan: null,
    now: new Date("2026-07-22T04:10:00.000Z"),
  });
  const macPlan = retargetPlan(linux, "macos");
  const macDefinition = createRunnerNativeServiceDefinition({
    plan: macPlan,
    service: macPlan.services.physicalRunner,
    environment,
    startOrder: 1,
  });
  assert.equal(macDefinition.format, "LAUNCHD_PLIST");
  assert.equal(macDefinition.destination, "/Library/LaunchDaemons/com.deviludo.physical-runner.plist");
  assert.match(macDefinition.rendered, /&lt;&amp;&gt;&quot;&apos;/);
  assert.doesNotMatch(macDefinition.rendered, /<string><&>/);

  const windowsPlan = retargetPlan(linux, "windows");
  const windowsReceipt = stagingReceipt(windowsPlan);
  const transaction = createRunnerNativeServiceTransaction({
    plan: windowsPlan,
    planDigest: windowsPlan.planDigest,
    stagingReceipt: windowsReceipt,
    physicalRunnerEnvironment: environmentBody,
    steamClientConnectorEnvironment: null,
  });
  assert.equal(transaction.status, "WAITING_NATIVE_BRIDGE");
  assert.equal(transaction.windowsBridge.reasonCode, "SIGNED_WINDOWS_SCM_BRIDGE_REQUIRED");
  assert.equal(transaction.definitions[0].format, "WINDOWS_SCM_DESCRIPTOR");
  assert.match(transaction.definitions[0].rendered, /requiresServiceBridgeContractVersion/);
  assert.ok(transaction.activation.actions.some(({ kind }) => kind === "APPLY_SCM_DESCRIPTOR"));

  const bridgePath = "C:\\Program Files\\DeviLudo\\deviludo-windows-scm-service-bridge.exe";
  const authorized = createRunnerNativeServiceTransaction({
    plan: windowsPlan,
    planDigest: windowsPlan.planDigest,
    stagingReceipt: windowsReceipt,
    physicalRunnerEnvironment: environmentBody,
    steamClientConnectorEnvironment: null,
    windowsBridgeAuthorization: {
      verified: true,
      component: "deviludo-windows-scm-service-bridge",
      path: bridgePath,
      architecture: windowsPlan.architecture,
      bridgeVersion: "1.0.0",
      contractVersion: 1,
      binaryDigest: hex("1"),
      sourceDigest: hex("2"),
      supplyChainEvidenceDigest: hex("3"),
      manifestDigest: hex("4"),
      trustPolicyDigest: hex("5"),
    },
  });
  assert.equal(authorized.status, "WAITING_NATIVE_ACTUATOR");
  assert.equal(authorized.windowsActuator.reasonCode, "SIGNED_WINDOWS_SCM_ACTUATOR_REQUIRED");
  const actuatorPath = "C:\\Program Files\\DeviLudo\\deviludo-windows-scm-native-actuator.exe";
  const reusableBridgeAuthorization = Object.fromEntries(
    Object.entries(authorized.windowsBridge).filter(([name]) => name !== "required"),
  );
  const ready = createRunnerNativeServiceTransaction({
    plan: windowsPlan,
    planDigest: windowsPlan.planDigest,
    stagingReceipt: windowsReceipt,
    physicalRunnerEnvironment: environmentBody,
    steamClientConnectorEnvironment: null,
    windowsBridgeAuthorization: reusableBridgeAuthorization,
    windowsActuatorAuthorization: {
      verified: true,
      component: "deviludo-windows-scm-native-actuator",
      path: actuatorPath,
      architecture: windowsPlan.architecture,
      actuatorVersion: "1.0.0",
      requestContractVersion: 1,
      binaryDigest: hex("6"),
      sourceDigest: hex("7"),
      supplyChainEvidenceDigest: hex("8"),
      manifestDigest: hex("9"),
      trustPolicyDigest: hex("a"),
    },
  });
  const descriptor = JSON.parse(authorized.definitions[0].rendered);
  assert.equal(ready.status, "READY");
  assert.equal(ready.managerTool, actuatorPath);
  assert.equal(authorized.windowsBridge.verified, true);
  assert.equal(authorized.definitions[0].executable, bridgePath);
  assert.equal(authorized.definitions[0].targetExecutable, windowsPlan.services.physicalRunner.executable);
  assert.equal(authorized.definitions[0].targetExecutableDigest,
    windowsPlan.artifacts.find(({ component }) => component === "physical-runner").digest.slice(7));
  assert.equal(descriptor.binaryPathName, bridgePath);
  assert.equal(descriptor.targetExecutable, windowsPlan.services.physicalRunner.executable);
  assert.equal(descriptor.bridgeManifestDigest, hex("4"));
  assert.throws(() => createRunnerNativeServiceTransaction({
    plan: windowsPlan,
    planDigest: windowsPlan.planDigest,
    stagingReceipt: windowsReceipt,
    physicalRunnerEnvironment: environmentBody,
    steamClientConnectorEnvironment: null,
    windowsBridgeAuthorization: { ...authorized.windowsBridge, binaryDigest: hex("6"), unexpected: true },
  }), /service transaction is invalid/);
  assert.throws(() => createRunnerNativeServiceTransaction({
    plan: windowsPlan,
    planDigest: windowsPlan.planDigest,
    stagingReceipt: windowsReceipt,
    physicalRunnerEnvironment: environmentBody,
    steamClientConnectorEnvironment: null,
    windowsBridgeAuthorization: reusableBridgeAuthorization,
    windowsActuatorAuthorization: { ...ready.windowsActuator, path: "C:\\Windows\\System32\\sc.exe" },
  }), /service transaction is invalid/);
});

test("service transaction CLI requires exact absolute create-only bindings", () => {
  const parsed = parseRunnerNativeServiceTransactionArguments([
    "--plan", "/private/staging/install-plan.json",
    "--plan-digest", hex("a"),
    "--output", "/private/staging/service-transaction.json",
  ]);
  assert.equal(parsed.planDigest, hex("a"));
  const withBridge = parseRunnerNativeServiceTransactionArguments([
    "--plan", "/private/staging/install-plan.json",
    "--plan-digest", hex("a"),
    "--output", "/private/staging/service-transaction.json",
    "--windows-bridge", "/private/staging/deviludo-windows-scm-service-bridge.exe",
    "--windows-bridge-manifest", "/private/staging/windows-bridge-manifest.json",
    "--windows-bridge-trust-policy", "/private/staging/windows-bridge-trust-policy.json",
    "--windows-bridge-trust-policy-digest", hex("b"),
  ]);
  assert.equal(withBridge.windowsBridgeTrustPolicyDigest, hex("b"));
  const withActuator = parseRunnerNativeServiceTransactionArguments([
    "--plan", "/private/staging/install-plan.json",
    "--plan-digest", hex("a"),
    "--output", "/private/staging/service-transaction.json",
    "--windows-bridge", "/private/staging/deviludo-windows-scm-service-bridge.exe",
    "--windows-bridge-manifest", "/private/staging/windows-bridge-manifest.json",
    "--windows-bridge-trust-policy", "/private/staging/windows-bridge-trust-policy.json",
    "--windows-bridge-trust-policy-digest", hex("b"),
    "--windows-actuator", "/private/staging/deviludo-windows-scm-native-actuator.exe",
    "--windows-actuator-manifest", "/private/staging/windows-actuator-manifest.json",
    "--windows-actuator-trust-policy", "/private/staging/windows-actuator-trust-policy.json",
    "--windows-actuator-trust-policy-digest", hex("c"),
  ]);
  assert.equal(withActuator.windowsActuatorTrustPolicyDigest, hex("c"));
  assert.throws(() => parseRunnerNativeServiceTransactionArguments([
    "--plan", "relative.json",
    "--plan-digest", hex("a"),
    "--output", "/private/staging/service-transaction.json",
  ]), /service transaction is invalid/);
});

test("privileged POSIX actuator consumes one signed zero-lease grant and atomically rolls back a failed switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-runner-native-actuator-"));
  try {
    const activationGrantPath = resolve(root, "activation-grant.json");
    const runnerEnvironmentPath = resolve(root, "physical-runner.env");
    const planPath = resolve(root, "install-plan.json");
    const transactionPath = resolve(root, "service-transaction.json");
    const successOutputPath = resolve(root, "success-receipt.json");
    const rollbackOutputPath = resolve(root, "rollback-receipt.json");
    const firstAuthorization = installAuthorization();
    const machineConfig = config(false);
    const firstEnvironment = runnerEnvironment(machineConfig, firstAuthorization);
    const firstEnvironmentBytes = environmentBytes(firstEnvironment);
    const first = createRunnerNativeInstallPlan({
      ...baseInput(firstAuthorization, machineConfig),
      runnerEnv: firstEnvironment,
      runnerEnvFile: runnerEnvironmentPath,
      runnerEnvFileDigest: digest(firstEnvironmentBytes),
      connectorEnv: null,
      connectorEnvFile: null,
      connectorEnvFileDigest: null,
      bridgeObservedDigest: null,
      previousPlan: null,
      now: new Date("2026-07-22T06:00:00.000Z"),
    });
    const nextAuthorization = {
      ...firstAuthorization,
      releaseId: "22222222-2222-4222-8222-222222222222",
      releaseDigest: prefixed("e"),
    };
    const nextEnvironment = {
      ...runnerEnvironment(machineConfig, nextAuthorization),
      DEVILUDO_PHYSICAL_RUNNER_ACTIVATION_GRANT_FILE: activationGrantPath,
    };
    const nextEnvironmentBytes = environmentBytes(nextEnvironment);
    const next = createRunnerNativeInstallPlan({
      ...baseInput(nextAuthorization, machineConfig),
      runnerEnv: nextEnvironment,
      runnerEnvFile: runnerEnvironmentPath,
      runnerEnvFileDigest: digest(nextEnvironmentBytes),
      connectorEnv: null,
      connectorEnvFile: null,
      connectorEnvFileDigest: null,
      bridgeObservedDigest: null,
      previousPlan: first,
      now: new Date("2026-07-22T06:01:00.000Z"),
    });
    const receipt = stagingReceipt(next);
    const transaction = createRunnerNativeServiceTransaction({
      plan: next,
      planDigest: next.planDigest,
      stagingReceipt: receipt,
      physicalRunnerEnvironment: nextEnvironmentBytes,
      steamClientConnectorEnvironment: null,
    });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = {
      schemaVersion: "deviludo.runner-native-install-activation-grant.v1",
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      grantSequence: 1,
      currentRunnerId: first.machine.runnerId,
      currentSpiffeId: first.machine.runnerSpiffeId,
      currentCapabilityDigest: first.machine.capabilityDigest,
      targetRunnerId: next.machine.runnerId,
      targetSpiffeId: next.machine.runnerSpiffeId,
      targetCapabilityDigest: next.machine.capabilityDigest,
      platform: next.platform,
      architecture: next.architecture,
      planDigest: next.planDigest,
      stagingReceiptDigest: receipt.receiptDigest,
      releaseId: next.releaseId,
      releaseDigest: next.releaseDigest,
      requiredRunnerState: "DRAINING",
      activeLeaseCount: 0,
      issuedAt: "2026-07-22T06:02:00.000Z",
      expiresAt: "2026-07-22T06:12:00.000Z",
    };
    const grant = { payload, signature: {
      algorithm: "Ed25519", keyId: "runner-jobs-01", value: signCanonical(privateKey, payload),
    } };
    await Promise.all([
      writeFile(activationGrantPath, JSON.stringify(grant)),
      writeFile(runnerEnvironmentPath, nextEnvironmentBytes),
      writeFile(planPath, JSON.stringify(next)),
      writeFile(transactionPath, JSON.stringify(transaction)),
    ]);
    const options = {
      activationGrantPath,
      outputPath: successOutputPath,
      planPath,
      planDigest: next.planDigest,
      transactionPath,
      transactionDigest: transaction.transactionDigest,
      windowsBridgePath: null,
      windowsBridgeManifestPath: null,
      windowsBridgeTrustPolicyPath: null,
      windowsBridgeTrustPolicyDigest: null,
      publicKey,
      keyId: "runner-jobs-01",
    };
    const oldDefinition = Buffer.from("old hardened systemd unit\n");
    const successHost = fakeActuatorHost(transaction, oldDefinition);
    const activated = await applyRunnerNativeServiceTransaction(options, {
      host: successHost,
      reportRollback: async () => { throw new Error("successful activation must not report rollback"); },
      prepareTransaction: async () => transaction,
      now: new Date("2026-07-22T06:03:00.000Z"),
    });
    assert.equal(activated.state, "SERVICES_STARTED");
    assert.equal(successHost.definitions.get(transaction.definitions[0].destination).toString(),
      transaction.definitions[0].rendered);
    assert.deepEqual(successHost.commands.slice(0, 3), [
      ["/usr/bin/systemctl", "daemon-reload"],
      ["/usr/bin/systemctl", "enable", "deviludo-physical-runner.service"],
      ["/usr/bin/systemctl", "restart", "deviludo-physical-runner.service"],
    ]);
    const replay = await applyRunnerNativeServiceTransaction(options, {
      host: { ...successHost, async run() { throw new Error("receipt replay must not mutate the host"); } },
      reportRollback: async () => { throw new Error("receipt replay must not report rollback"); },
      prepareTransaction: async () => transaction,
      now: new Date("2026-07-22T07:00:00.000Z"),
    });
    assert.equal(replay.receiptDigest, activated.receiptDigest);

    const rollbackHost = fakeActuatorHost(transaction, oldDefinition, { failFirstRestart: true });
    const reportedRollbacks = [];
    await assert.rejects(applyRunnerNativeServiceTransaction({ ...options, outputPath: rollbackOutputPath }, {
      host: rollbackHost,
      reportRollback: async () => {
        throw new Error("simulated mTLS interruption after local rollback");
      },
      prepareTransaction: async () => transaction,
      now: new Date("2026-07-22T06:04:00.000Z"),
    }), /simulated mTLS interruption/);
    const persistedFailure = JSON.parse(await readFile(`${rollbackOutputPath}.failure`, "utf8"));
    assert.deepEqual(rollbackHost.definitions.get(transaction.definitions[0].destination), oldDefinition);
    const rolledBack = await applyRunnerNativeServiceTransaction({ ...options, outputPath: rollbackOutputPath }, {
      host: rollbackHost,
      reportRollback: async (observedGrant, failureDigest) => {
        reportedRollbacks.push({ observedGrant, failureDigest });
        return { state: "ROLLED_BACK", failureEvidenceDigest: failureDigest };
      },
      prepareTransaction: async () => transaction,
      now: new Date("2026-07-22T06:05:00.000Z"),
    });
    assert.equal(rolledBack.state, "ROLLED_BACK");
    assert.match(rolledBack.failureDigest, /^[a-f0-9]{64}$/);
    assert.equal(rolledBack.failureDigest, persistedFailure.failureDigest);
    assert.equal(reportedRollbacks.length, 1);
    assert.equal(reportedRollbacks[0].observedGrant.payload.operationId, payload.operationId);
    assert.equal(reportedRollbacks[0].failureDigest, rolledBack.failureDigest);
    assert.deepEqual(rollbackHost.definitions.get(transaction.definitions[0].destination), oldDefinition);
    assert.equal(await readFile(`${rollbackOutputPath}.journal`, "utf8").catch((error) => error.code), "ENOENT");

    const parsed = parseRunnerNativeServiceActuationArguments([
      "--activation-grant", activationGrantPath,
      "--output", successOutputPath,
      "--plan", planPath,
      "--plan-digest", next.planDigest,
      "--transaction", transactionPath,
      "--transaction-digest", transaction.transactionDigest,
    ]);
    assert.equal(parsed.transactionDigest, transaction.transactionDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initial Runner actuator installs only into an empty service slot and replays its receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-runner-initial-actuator-"));
  try {
    const authorization = installAuthorization();
    const machineConfig = config(false);
    const environment = runnerEnvironment(machineConfig, authorization);
    const environmentBody = environmentBytes(environment);
    const plan = createRunnerNativeInstallPlan({
      ...baseInput(authorization, machineConfig),
      runnerEnv: environment,
      runnerEnvFile: resolve(root, "physical-runner.env"),
      runnerEnvFileDigest: digest(environmentBody),
      connectorEnv: null,
      connectorEnvFile: null,
      connectorEnvFileDigest: null,
      bridgeObservedDigest: null,
      previousPlan: null,
      now: new Date("2026-07-22T08:00:00.000Z"),
    });
    const transaction = createRunnerNativeServiceTransaction({
      plan, planDigest: plan.planDigest, stagingReceipt: stagingReceipt(plan),
      physicalRunnerEnvironment: environmentBody, steamClientConnectorEnvironment: null,
    });
    const planPath = resolve(root, "install-plan.json");
    const transactionPath = resolve(root, "transaction.json");
    const outputPath = resolve(root, "receipt.json");
    await Promise.all([
      writeFile(planPath, JSON.stringify(plan)), writeFile(transactionPath, JSON.stringify(transaction)),
      writeFile(resolve(root, "physical-runner.env"), environmentBody),
    ]);
    const definitions = new Map(); const commands = [];
    const host = {
      platform: "linux", architecture: "x86_64", definitions, commands,
      async readDefinition(path) { return definitions.has(path) ? Buffer.from(definitions.get(path)) : null; },
      async writeDefinition(path, body) { definitions.set(path, Buffer.from(body)); },
      async removeDefinition(path) { definitions.delete(path); },
      async digestFile(path) { const definition = transaction.definitions.find((item) =>
        item.executable === path || item.environmentSourcePath === path); return definition.executable === path
          ? definition.executableDigest.slice(7) : definition.environmentSourceDigest; },
      async run(command, args) { commands.push([command, ...args]); return { exitCode: 0, output: "" }; },
      async sleep() {},
    };
    const options = { outputPath, planPath, planDigest: plan.planDigest, transactionPath,
      transactionDigest: transaction.transactionDigest, windowsBridgePath: null,
      windowsBridgeManifestPath: null, windowsBridgeTrustPolicyPath: null, windowsBridgeTrustPolicyDigest: null };
    const receipt = await applyInitialRunnerNativeServiceTransaction(options, {
      host, prepareTransaction: async () => transaction, now: new Date("2026-07-22T08:01:00.000Z"),
    });
    assert.equal(receipt.state, "SERVICES_STARTED");
    assert.equal(definitions.size, 1);
    assert.ok(commands.some((call) => call.includes("enable")));
    const replay = await applyInitialRunnerNativeServiceTransaction(options, {
      host: { ...host, async run() { throw new Error("replay may not mutate host"); } },
      prepareTransaction: async () => transaction, now: new Date("2026-07-22T09:00:00.000Z"),
    });
    assert.equal(replay.receiptDigest, receipt.receiptDigest);
    const parsed = parseInitialRunnerNativeActuationArguments(["--output", outputPath, "--plan", planPath,
      "--plan-digest", plan.planDigest, "--transaction", transactionPath,
      "--transaction-digest", transaction.transactionDigest]);
    assert.equal(parsed.planDigest, plan.planDigest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("E2E one-click deployment uses one digest-bound configuration for initial or upgrade mode", () => {
  const digestValue = hex("a");
  assert.equal(parseE2EHostDeploymentArguments([
    "--config", "/etc/deviludo/e2e-deployment.json", "--config-digest", digestValue, "--apply",
  ]).apply, true);
  const configValue = validateE2EHostDeploymentConfig({
    schemaVersion: "deviludo.e2e-host-deployment.v1",
    artifactDirectory: "/opt/deviludo/staging/artifacts", buildReceiptPath: "/opt/deviludo/staging/build.json",
    connectorEnvFile: null, installRoot: "/opt/deviludo/native", machineConfigPath,
    operationId: null, planPath: "/opt/deviludo/staging/plan.json", previousPlanPath: null,
    receiptPath: "/var/lib/deviludo/runner-receipt.json", releasePath: "/opt/deviludo/staging/release.json",
    runnerEnvFile, transactionPath: "/opt/deviludo/staging/transaction.json",
    trustPolicyDigest: `sha256:${digestValue}`, trustPolicyPath: "/etc/deviludo/runner-trust.json", windows: null,
  });
  assert.equal(configValue.operationId, null);
  assert.throws(() => validateE2EHostDeploymentConfig({ ...configValue,
    previousPlanPath: "/opt/deviludo/native/old-plan.json", operationId: null }), /input is invalid/);
});

test("stager rehashes signed bytes into a new read-only revision and replays only the exact receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-runner-native-stage-"));
  try {
    const requestedInstallRoot = resolve(root, "native");
    const requestedArtifactDirectory = resolve(root, "artifacts");
    await Promise.all([mkdir(requestedInstallRoot), mkdir(requestedArtifactDirectory)]);
    const [installRoot, artifactDirectory] = await Promise.all([
      realpath(requestedInstallRoot), realpath(requestedArtifactDirectory),
    ]);
    const bodies = new Map([
      ["godot-testkit", Buffer.from("signed-testkit\n")],
      ["physical-runner", Buffer.from("signed-runner\n")],
      ["steam-client-connector", Buffer.from("signed-connector\n")],
    ]);
    const fileNames = new Map([
      ["godot-testkit", "deviludo-testkit"],
      ["physical-runner", "deviludo-physical-runner"],
      ["steam-client-connector", "deviludo-steam-client-connector"],
    ]);
    await Promise.all([...bodies].map(([component, body]) =>
      writeFile(resolve(artifactDirectory, fileNames.get(component)), body)));
    const releaseId = "33333333-3333-4333-8333-333333333333";
    const authorization = {
      ...installAuthorization(),
      releaseId,
      artifacts: Object.freeze([...bodies].map(([component, body]) => Object.freeze({
        component,
        fileName: fileNames.get(component),
        releasedDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
        identityDigest: prefixed("f"),
      }))),
    };
    const core = {
      ...config(false).capabilities,
      runnerImageDigest: authorization.artifacts.find(({ component }) => component === "physical-runner").releasedDigest.slice(7),
    };
    const capabilityCore = { ...core };
    delete capabilityCore.capabilityDigest;
    const machineConfig = {
      ...config(false),
      capabilities: { ...capabilityCore, capabilityDigest: createRunnerCapabilityDigest(capabilityCore) },
    };
    const plan = createRunnerNativeInstallPlan({
      authorization,
      artifactDirectory,
      installRoot,
      machineConfig,
      machineConfigPath,
      machineConfigDigest: hex("9"),
      runnerEnv: {
        NODE_ENV: "production",
        DEVILUDO_PHYSICAL_RUNNER_CONFIG_FILE: machineConfigPath,
        DEVILUDO_PHYSICAL_RUNNER_TESTKIT_EXECUTABLE:
          resolve(installRoot, "releases", releaseId, "deviludo-testkit"),
        DEVILUDO_PHYSICAL_RUNNER_TESTKIT_DIGEST:
          authorization.artifacts.find(({ component }) => component === "godot-testkit").releasedDigest.slice(7),
      },
      runnerEnvFile,
      runnerEnvFileDigest: hex("8"),
      connectorEnv: null,
      connectorEnvFile: null,
      connectorEnvFileDigest: null,
      bridgeObservedDigest: null,
      previousPlan: null,
      now: new Date("2026-07-22T03:00:00.000Z"),
    });
    const staged = await stageRunnerNativeInstallation(plan, plan.planDigest, {
      now: new Date("2026-07-22T03:01:00.000Z"),
      uuid: () => "44444444-4444-4444-8444-444444444444",
    });
    assert.equal(staged.replayed, false);
    assert.equal(staged.receipt.status, "STAGED");
    assert.equal(staged.receipt.artifacts.length, 2);
    assert.deepEqual(await verifyStagedRunnerNativeInstallation(plan, plan.releaseDirectory), staged.receipt);
    const replay = await stageRunnerNativeInstallation(plan, plan.planDigest, {
      now: new Date("2026-07-22T03:02:00.000Z"),
    });
    assert.equal(replay.replayed, true);

    const installedTestKit = resolve(plan.releaseDirectory, "deviludo-testkit");
    await chmod(installedTestKit, 0o700);
    await writeFile(installedTestKit, "tampered\n");
    await assert.rejects(verifyStagedRunnerNativeInstallation(plan, plan.releaseDirectory), /staging input is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function baseInput(authorization, machineConfig) {
  return {
    authorization,
    artifactDirectory: "/private/staging/final-artifacts",
    installRoot: "/opt/deviludo/native",
    machineConfig,
    machineConfigPath,
    machineConfigDigest: hex("9"),
    runnerEnvFile,
    runnerEnvFileDigest: hex("8"),
  };
}

function installAuthorization() {
  return Object.freeze({
    schemaVersion: "deviludo.runner-native-install-authorization.v2",
    status: "VERIFIED",
    releaseId: "11111111-1111-4111-8111-111111111111",
    releaseDigest: prefixed("a"),
    buildReceiptDigest: prefixed("b"),
    trustPolicyDigest: prefixed("c"),
    signingKeyId: "runner-native-release-2026-01",
    platform: "linux",
    architecture: "x86_64",
    platformVersion: "0.1.0-beta.1",
    sourceRevision: "d".repeat(40),
    verifiedAt: "2026-07-22T00:30:00.000Z",
    artifacts: Object.freeze([
      artifact("godot-testkit", "deviludo-testkit", "1"),
      artifact("physical-runner", "deviludo-physical-runner", "2"),
      artifact("steam-client-connector", "deviludo-steam-client-connector", "3"),
    ]),
  });
}

function artifact(component, fileName, character) {
  return Object.freeze({ component, fileName, releasedDigest: prefixed(character), identityDigest: prefixed(character) });
}

function config(steam) {
  const core = {
    runnerId,
    platform: "linux",
    architecture: "x86_64",
    osVersion: "ubuntu-24.04.2",
    runnerImageDigest: hex("2"),
    godotVersion: "4.6.2-stable",
    godotBinaryDigest: hex("5"),
    exportTemplatesDigest: hex("6"),
    gpu: "NVIDIA-L4-driver-570.124.04",
    display: "virtual",
    audio: "virtual",
    installedAutonomousAgents: [],
    steamClientConnector: steam ? {
      version: "0.1.0-beta.1",
      bridgeVersion: "1.0.3",
      controllerContractVersion: 1,
      binaryDigest: hex("4"),
      automationPolicyDigest: hex("5"),
      supplyChainEvidenceDigest: hex("6"),
    } : null,
  };
  return Object.freeze({
    schemaVersion: "deviludo.physical-runner-config.v2",
    capabilities: Object.freeze({ ...core, capabilityDigest: createRunnerCapabilityDigest(core) }),
    identity: Object.freeze({
      spiffeId: `spiffe://deviludo.internal/e2e/${runnerId}`,
      certificateFingerprint: hex("7"),
    }),
  });
}

function runnerEnvironment(machineConfig, authorization, activation = false) {
  const env = {
    NODE_ENV: "production",
    DEVILUDO_PHYSICAL_RUNNER_CONFIG_FILE: machineConfigPath,
    DEVILUDO_PHYSICAL_RUNNER_TESTKIT_EXECUTABLE:
      `/opt/deviludo/native/releases/${authorization.releaseId}/deviludo-testkit`,
    DEVILUDO_PHYSICAL_RUNNER_TESTKIT_DIGEST: hex("1"),
  };
  if (activation) env.DEVILUDO_PHYSICAL_RUNNER_ACTIVATION_GRANT_FILE = "/etc/deviludo/runner-native-activation-grant.json";
  const connector = machineConfig.capabilities.steamClientConnector;
  if (connector) Object.assign(env, {
    DEVILUDO_PHYSICAL_RUNNER_STEAM_CONNECTOR_VERSION: connector.version,
    DEVILUDO_PHYSICAL_RUNNER_STEAM_BRIDGE_VERSION: connector.bridgeVersion,
    DEVILUDO_PHYSICAL_RUNNER_STEAM_CONTROLLER_CONTRACT_VERSION: "1",
    DEVILUDO_PHYSICAL_RUNNER_STEAM_CONNECTOR_BINARY_DIGEST: connector.binaryDigest,
    DEVILUDO_PHYSICAL_RUNNER_STEAM_AUTOMATION_POLICY_DIGEST: connector.automationPolicyDigest,
    DEVILUDO_PHYSICAL_RUNNER_STEAM_SUPPLY_CHAIN_EVIDENCE_DIGEST: connector.supplyChainEvidenceDigest,
  });
  return Object.freeze(env);
}

function connectorEnvironment(machineConfig, authorization) {
  return Object.freeze({
    NODE_ENV: "production",
    DEVILUDO_STEAM_CONNECTOR_RUNNER_ID: machineConfig.capabilities.runnerId,
    DEVILUDO_STEAM_CONNECTOR_PLATFORM: machineConfig.capabilities.platform,
    DEVILUDO_STEAM_CONNECTOR_VERSION: authorization.platformVersion,
    DEVILUDO_STEAM_CONNECTOR_NATIVE_EXECUTABLE: "/opt/deviludo/bin/steam-client-bridge",
    DEVILUDO_STEAM_CONNECTOR_NATIVE_MANIFEST_FILE: "/opt/deviludo/manifests/steam-client-bridge.json",
    DEVILUDO_STEAM_CONNECTOR_NATIVE_TRUST_POLICY_FILE: "/opt/deviludo/policies/steam-native-bridge-trust-policy.json",
    DEVILUDO_STEAM_CONNECTOR_NATIVE_TRUST_POLICY_DIGEST: hex("9"),
  });
}

function environmentBytes(environment) {
  return Buffer.from(`${Object.entries(environment).map(([name, value]) => `${name}=${value}`).join("\n")}\n`, "utf8");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stagingReceipt(plan) {
  const planBytes = Buffer.from(`${canonicalJson(plan)}\n`, "utf8");
  const core = {
    schemaVersion: "deviludo.runner-native-staging-receipt.v1",
    status: "STAGED",
    planDigest: plan.planDigest,
    planFileDigest: digest(planBytes),
    releaseId: plan.releaseId,
    releaseDigest: plan.releaseDigest,
    platform: plan.platform,
    architecture: plan.architecture,
    releaseDirectory: plan.releaseDirectory,
    stagedAt: "2026-07-22T04:01:00.000Z",
    artifacts: plan.artifacts.map((artifact) => ({
      component: artifact.component,
      path: artifact.destinationPath,
      digest: artifact.digest,
      sizeBytes: 32,
      readOnly: true,
    })),
  };
  return Object.freeze({ ...core, receiptDigest: sha256Canonical(core) });
}

function retargetPlan(plan, platform) {
  const manager = platform === "macos" ? "LAUNCHD" : "WINDOWS_SCM";
  const service = plan.services.physicalRunner;
  const physicalRunner = {
    ...service,
    manager,
    serviceId: platform === "macos" ? "com.deviludo.physical-runner" : "DeviLudoPhysicalRunner",
    account: platform === "macos" ? "_deviludo_runner" : "NT SERVICE\\DeviLudoPhysicalRunner",
    environmentSource: {
      ...service.environmentSource,
      kind: platform === "macos" ? "LAUNCHD_ENVIRONMENT_DICTIONARY" : "SCM_ENVIRONMENT_BLOCK",
    },
  };
  const core = {
    ...plan,
    platform,
    services: { physicalRunner, steamClientConnector: null },
  };
  delete core.planDigest;
  return Object.freeze({ ...core, planDigest: sha256Canonical(core) });
}

function fakeActuatorHost(transaction, previousDefinition, { failFirstRestart = false } = {}) {
  let restartFailed = false;
  const definitions = new Map(transaction.definitions.map(({ destination }) =>
    [destination, Buffer.from(previousDefinition)]));
  const commands = [];
  return {
    platform: transaction.platform,
    architecture: transaction.architecture,
    definitions,
    commands,
    async readDefinition(path) { return definitions.has(path) ? Buffer.from(definitions.get(path)) : null; },
    async writeDefinition(path, body) { definitions.set(path, Buffer.from(body)); },
    async removeDefinition(path) { definitions.delete(path); },
    async digestFile(path) {
      const definition = transaction.definitions.find((candidate) =>
        candidate.executable === path || candidate.environmentSourcePath === path);
      if (!definition) throw new Error("unexpected digest path");
      return definition.executable === path ? definition.executableDigest.slice(7) : definition.environmentSourceDigest;
    },
    async run(command, args) {
      commands.push([command, ...args]);
      if (failFirstRestart && !restartFailed && args[0] === "restart") {
        restartFailed = true;
        throw new Error("simulated activation failure");
      }
      return { exitCode: 0, output: "" };
    },
    async sleep() {},
  };
}
