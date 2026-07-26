import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalJson, sha256Canonical, signCanonical } from "../services/runner-control/src/canonical.ts";
import { windowsScmNativeActuatorTrustPolicyDigest } from
  "../services/runner-control/src/windows-scm-native-actuator.ts";
import { windowsScmServiceBridgeTrustPolicyDigest } from
  "../services/runner-control/src/windows-scm-service-bridge.ts";
import { createSteamDepotFinalizerHostInstallPlan } from
  "../scripts/production/plan-steam-depot-finalizer-host-install.mjs";
import {
  createSteamDepotFinalizerHostTransaction,
  validateSteamDepotFinalizerHostTransaction,
  verifyWindowsHostHelpers,
} from "../scripts/production/compile-steam-depot-finalizer-host-transaction.mjs";

const components = [
  "serviceArtifact", "serviceBuildReceipt", "serviceRelease", "serviceTrustPolicy", "nativeArtifact",
  "nativeBuildReceipt", "nativeRelease", "nativeTrustPolicy", "nativePolicy", "environment",
];

test("Linux transaction renders a strict service and ordered health-gated activation", () => {
  const fixture = transactionFixture("linux");
  const transaction = createSteamDepotFinalizerHostTransaction(fixture);
  assert.equal(validateSteamDepotFinalizerHostTransaction(
    transaction, transaction.transactionDigest,
  ).status, "READY");
  assert.equal(transaction.definition.format, "SYSTEMD_UNIT");
  assert.match(transaction.definition.rendered, /NoNewPrivileges=yes/);
  assert.match(transaction.definition.rendered, /ProtectSystem=strict/);
  assert.match(transaction.definition.rendered, /CapabilityBoundingSet=\n/);
  assert.match(transaction.definition.rendered, /ReadWritePaths=\/private\/tmp\/deviludo-finalizer-transaction-linux\/work/);
  assert.deepEqual(transaction.activation.actions.slice(-4).map(({ check }) => check),
    ["SIGNED_RELEASES", "NATIVE_IDENTITY", "NATIVE_PROBE", "MTLS_READY"]);
});

test("macOS transaction embeds only validated reference environment in launchd", () => {
  const fixture = transactionFixture("macos");
  const transaction = createSteamDepotFinalizerHostTransaction(fixture);
  assert.equal(transaction.status, "READY");
  assert.equal(transaction.definition.format, "LAUNCHD_PLIST");
  assert.match(transaction.definition.rendered, /<key>UserName<\/key>/);
  assert.match(transaction.definition.rendered, /_deviludo_finalizer/);
  assert.match(transaction.definition.rendered, /<key>HardResourceLimits<\/key>/);
  assert.equal(transaction.definition.rendered.includes("release-signer"), false);
});

test("Windows transaction stays non-runnable until both signed native helpers are fixed", () => {
  const waitingBridge = createSteamDepotFinalizerHostTransaction(transactionFixture("windows"));
  assert.equal(waitingBridge.status, "WAITING_NATIVE_BRIDGE");
  assert.equal(waitingBridge.managerTool, null);
  assert.equal(waitingBridge.definition.executable, null);

  const bridgeOnly = transactionFixture("windows");
  bridgeOnly.windowsBridgeAuthorization = windowsAuthorization("bridge");
  const waitingActuator = createSteamDepotFinalizerHostTransaction(bridgeOnly);
  assert.equal(waitingActuator.status, "WAITING_NATIVE_ACTUATOR");

  const ready = transactionFixture("windows");
  ready.windowsBridgeAuthorization = windowsAuthorization("bridge");
  ready.windowsActuatorAuthorization = windowsAuthorization("actuator");
  const transaction = createSteamDepotFinalizerHostTransaction(ready);
  assert.equal(transaction.status, "READY");
  assert.equal(transaction.definition.executable, ready.windowsBridgeAuthorization.path);
  const descriptor = JSON.parse(transaction.definition.rendered);
  assert.equal(descriptor.serviceSidType, "RESTRICTED");
  assert.deepEqual(descriptor.requiredPrivileges, []);
  assert.equal(descriptor.interactive, false);
});

test("Windows helper readiness is derived only from signed manifests and exact binary bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-finalizer-windows-helpers-"));
  const plan = planFixture("windows").plan; const now = new Date("2026-07-26T00:01:00.000Z");
  const bridgeKeys = generateKeyPairSync("ed25519"); const actuatorKeys = generateKeyPairSync("ed25519");
  const bridgeKeyId = "windows-scm-bridge-key-2026-01"; const actuatorKeyId = "windows-scm-actuator-key-2026-01";
  const bridgePolicy = helperTrustPolicy("deviludo.windows-scm-service-bridge-trust-policy.v1",
    "windows-scm-bridge-production", bridgeKeyId, bridgeKeys.publicKey);
  const actuatorPolicy = helperTrustPolicy("deviludo.windows-scm-native-actuator-trust-policy.v1",
    "windows-scm-actuator-production", actuatorKeyId, actuatorKeys.publicKey);
  const bridgeBody = Buffer.from("signed-windows-service-bridge");
  const actuatorBody = Buffer.from("signed-windows-native-actuator");
  const bridgeClaims = {
    kind: "deviludo-windows-scm-service-bridge", version: 1, revision: 4, platform: "windows",
    architecture: "x86_64", bridgeVersion: "1.2.3", serviceContractVersion: 1,
    binaryDigest: digest(bridgeBody), sourceDigest: "a".repeat(64), supplyChainEvidenceDigest: "b".repeat(64),
    builtAt: "2026-07-26T00:00:00.000Z",
  };
  const actuatorClaims = {
    kind: "deviludo-windows-scm-native-actuator", version: 1, revision: 7, platform: "windows",
    architecture: "x86_64", actuatorVersion: "2.3.4", requestContractVersion: 1,
    binaryDigest: digest(actuatorBody), sourceDigest: "c".repeat(64), supplyChainEvidenceDigest: "d".repeat(64),
    builtAt: "2026-07-26T00:00:00.000Z",
  };
  const paths = {
    windowsBridgePath: join(root, "bridge.exe"), windowsBridgeManifestPath: join(root, "bridge-manifest.json"),
    windowsBridgeTrustPolicyPath: join(root, "bridge-trust.json"),
    windowsBridgeTrustPolicyDigest: windowsScmServiceBridgeTrustPolicyDigest(bridgePolicy),
    windowsActuatorPath: join(root, "actuator.exe"), windowsActuatorManifestPath: join(root, "actuator-manifest.json"),
    windowsActuatorTrustPolicyPath: join(root, "actuator-trust.json"),
    windowsActuatorTrustPolicyDigest: windowsScmNativeActuatorTrustPolicyDigest(actuatorPolicy),
  };
  await Promise.all([
    writeFile(paths.windowsBridgePath, bridgeBody, { mode: 0o500 }),
    writeFile(paths.windowsBridgeManifestPath, canonicalJson({
      keyId: bridgeKeyId, claims: bridgeClaims, signature: signCanonical(bridgeKeys.privateKey, bridgeClaims),
    }), { mode: 0o400 }),
    writeFile(paths.windowsBridgeTrustPolicyPath, canonicalJson(bridgePolicy), { mode: 0o400 }),
    writeFile(paths.windowsActuatorPath, actuatorBody, { mode: 0o500 }),
    writeFile(paths.windowsActuatorManifestPath, canonicalJson({
      keyId: actuatorKeyId, claims: actuatorClaims, signature: signCanonical(actuatorKeys.privateKey, actuatorClaims),
    }), { mode: 0o400 }),
    writeFile(paths.windowsActuatorTrustPolicyPath, canonicalJson(actuatorPolicy), { mode: 0o400 }),
  ]);
  const verified = await verifyWindowsHostHelpers(paths, plan, now);
  assert.equal(verified.bridge.manifestDigest.length, 64);
  assert.equal(verified.actuator.binaryDigest, digest(actuatorBody));
  const transaction = createSteamDepotFinalizerHostTransaction({
    plan, planDigest: plan.planDigest, stagingReceipt: stagingReceipt(plan),
    environment: planFixture("windows").environment,
    windowsBridgeAuthorization: verified.bridge, windowsActuatorAuthorization: verified.actuator,
  });
  assert.equal(transaction.status, "READY");
  await chmod(paths.windowsActuatorPath, 0o700);
  await writeFile(paths.windowsActuatorPath, "substituted-actuator");
  await chmod(paths.windowsActuatorPath, 0o500);
  await assert.rejects(verifyWindowsHostHelpers(paths, plan, now), /transaction is invalid/);
});

test("transaction rejects inline credentials and release-path rebinding", () => {
  const credentialFixture = planFixture("linux", undefined, null, ["STEAM_PASSWORD=forbidden"]);
  const credential = {
    plan: credentialFixture.plan,
    planDigest: credentialFixture.plan.planDigest,
    stagingReceipt: stagingReceipt(credentialFixture.plan),
    environment: credentialFixture.environment,
  };
  assert.throws(() => createSteamDepotFinalizerHostTransaction(credential), /transaction is invalid/);

  const rebound = transactionFixture("macos");
  const text = rebound.environment.toString("utf8").replace(
    /DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE=.*\n/,
    "DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE=/tmp/other-native\n",
  );
  rebound.environment = Buffer.from(text);
  assert.throws(() => createSteamDepotFinalizerHostTransaction(rebound), /install plan is invalid|transaction is invalid/);
});

test("upgrade transaction carries only its exact previous-plan rollback authority", () => {
  const previousFixture = planFixture("linux", "00000000-0000-4000-8000-000000000001");
  const previous = previousFixture.plan;
  const currentFixture = planFixture("linux", "00000000-0000-4000-8000-000000000002", previous);
  const transaction = createSteamDepotFinalizerHostTransaction({
    plan: currentFixture.plan,
    planDigest: currentFixture.plan.planDigest,
    stagingReceipt: stagingReceipt(currentFixture.plan),
    environment: currentFixture.environment,
    windowsBridgeAuthorization: null,
    windowsActuatorAuthorization: null,
  });
  assert.equal(transaction.activation.mode, "DRAINED_UPGRADE");
  assert.equal(transaction.activation.requiredActiveOperationCount, 0);
  assert.equal(transaction.rollback.previousPlanDigest, previous.planDigest);
  assert.equal(transaction.rollback.actions[1].kind, "RESTORE_PREVIOUS_PLAN");
});

function transactionFixture(platform) {
  const fixture = planFixture(platform);
  return {
    plan: fixture.plan,
    planDigest: fixture.plan.planDigest,
    stagingReceipt: stagingReceipt(fixture.plan),
    environment: fixture.environment,
    windowsBridgeAuthorization: null,
    windowsActuatorAuthorization: null,
  };
}

function planFixture(platform, releaseId = "00000000-0000-4000-8000-000000000001", previousPlan = null, extraLines = []) {
  const root = resolve(`/private/tmp/deviludo-finalizer-transaction-${platform}`);
  const installRoot = resolve(root, "install"); const workRoot = resolve(root, "work");
  const releaseDirectory = resolve(installRoot, "releases", releaseId);
  const sources = Object.fromEntries(components.map((component) => [component, resolve(root, "staged", component)]));
  const digests = Object.fromEntries(components.map((component, index) => [component, (index + 1).toString(16).repeat(64)]));
  const fileName = (component) => component === "nativeArtifact" && platform === "windows"
    ? "deviludo-steam-depot-finalizer-native.exe" : {
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
    }[component];
  const destination = (component) => resolve(releaseDirectory, fileName(component));
  const environment = Buffer.from([
    "NODE_ENV=production",
    `DATABASE_URL=postgresql://deviludo@postgres.internal/deviludo`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_PLATFORM=${platform}`,
    "DEVILUDO_STEAM_DEPOT_FINALIZER_VERSION=0.1.0-beta.1",
    `DEVILUDO_STEAM_DEPOT_FINALIZER_BINARY_DIGEST=${digests.serviceArtifact}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_ARTIFACT_FILE=${destination("serviceArtifact")}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_BUILD_RECEIPT_FILE=${destination("serviceBuildReceipt")}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_BUILD_RECEIPT_DIGEST=${digests.serviceBuildReceipt}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_RELEASE_FILE=${destination("serviceRelease")}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_TRUST_POLICY_FILE=${destination("serviceTrustPolicy")}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_TRUST_POLICY_DIGEST=${digests.serviceTrustPolicy}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE=${destination("nativeArtifact")}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE_DIGEST=${digests.nativeArtifact}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_BUILD_RECEIPT_FILE=${destination("nativeBuildReceipt")}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_BUILD_RECEIPT_DIGEST=${digests.nativeBuildReceipt}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_RELEASE_FILE=${destination("nativeRelease")}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_TRUST_POLICY_FILE=${destination("nativeTrustPolicy")}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_TRUST_POLICY_DIGEST=${digests.nativeTrustPolicy}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_POLICY_FILE=${destination("nativePolicy")}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_POLICY_DIGEST=${digests.nativePolicy}`,
    `DEVILUDO_STEAM_DEPOT_FINALIZER_WORK_ROOT=${workRoot}`,
    'DEVILUDO_STEAM_DEPOT_FINALIZER_ALLOWED_SPIFFE_IDS=["spiffe://deviludo.internal/steam-workflow-executor"]',
    "DEVILUDO_STEAM_DEPOT_FINALIZER_TLS_KEY_FILE=/run/secrets/finalizer.key",
    "DEVILUDO_STEAM_DEPOT_FINALIZER_TLS_CERT_FILE=/run/secrets/finalizer.crt",
    "DEVILUDO_STEAM_DEPOT_FINALIZER_CLIENT_CA_FILE=/run/secrets/client-ca.crt",
    "DEVILUDO_STEAM_DEPOT_FINALIZER_HEALTH_TLS_KEY_FILE=/run/secrets/health.key",
    "DEVILUDO_STEAM_DEPOT_FINALIZER_HEALTH_TLS_CERT_FILE=/run/secrets/health.crt",
    "DEVILUDO_STEAM_DEPOT_FINALIZER_HEALTH_TLS_CA_FILE=/run/secrets/health-ca.crt",
    "DEVILUDO_STEAM_DEPOT_FINALIZER_HEALTH_SERVER_NAME=steam-depot-finalizer.internal",
    ...extraLines,
    "",
  ].join("\n"));
  digests.environment = digest(environment);
  const sourceRevision = "a".repeat(40);
  const input = {
    platform,
    architecture: platform === "macos" ? "arm64" : "x86_64",
    installRoot,
    workRoot,
    preparedAt: "2026-07-26T00:00:00.000Z",
    sources,
    digests,
    nodeRuntime: { path: resolve(root, "runtime", platform === "windows" ? "node.exe" : "node"), digest: "b".repeat(64), version: "v22.13.1" },
    serviceAuthorization: {
      releaseId, sourceRevision, platformVersion: "0.1.0-beta.1", artifactDigest: digests.serviceArtifact,
      buildReceiptDigest: digests.serviceBuildReceipt, releaseDigest: digests.serviceRelease,
      trustPolicyDigest: digests.serviceTrustPolicy, signingKeyId: "service-release-key-2026-01",
    },
    nativeAuthorization: {
      releaseId, sourceRevision, platformVersion: "0.1.0-beta.1", platform,
      architecture: platform === "macos" ? "arm64" : "x86_64", artifactDigest: digests.nativeArtifact,
      buildReceiptDigest: digests.nativeBuildReceipt, releaseDigest: digests.nativeRelease,
      trustPolicyDigest: digests.nativeTrustPolicy, identityDigest: "c".repeat(64), signingKeyId: "native-release-key-2026-01",
    },
    previousPlan,
  };
  return { plan: createSteamDepotFinalizerHostInstallPlan(input), environment };
}

function stagingReceipt(plan) {
  const planBody = Buffer.from(`${canonicalJson(plan)}\n`);
  const core = {
    schemaVersion: "deviludo.steam-depot-finalizer-host-staging-receipt.v1",
    status: "STAGED",
    planDigest: plan.planDigest,
    planFileDigest: digest(planBody),
    releaseId: plan.releaseId,
    serviceReleaseDigest: plan.serviceReleaseDigest,
    nativeReleaseDigest: plan.nativeReleaseDigest,
    platform: plan.platform,
    architecture: plan.architecture,
    releaseDirectory: plan.releaseDirectory,
    stagedAt: "2026-07-26T00:01:00.000Z",
    artifacts: plan.artifacts.map((entry) => ({
      component: entry.component, path: entry.destinationPath, digest: entry.digest,
      sizeBytes: 100, mode: entry.mode,
    })),
  };
  return { ...core, receiptDigest: sha256Canonical(core) };
}

function windowsAuthorization(kind) {
  return {
    verified: true,
    component: kind === "bridge" ? "deviludo-windows-scm-service-bridge" : "deviludo-windows-scm-native-actuator",
    path: resolve(`/private/tmp/deviludo-windows-${kind}`),
    binaryDigest: kind === "bridge" ? "d".repeat(64) : "e".repeat(64),
    architecture: "x86_64",
    [kind === "bridge" ? "contractVersion" : "requestContractVersion"]: 1,
    [kind === "bridge" ? "bridgeVersion" : "actuatorVersion"]: "1.1.0",
    sourceDigest: "a".repeat(64),
    supplyChainEvidenceDigest: "b".repeat(64),
    manifestDigest: "c".repeat(64),
    trustPolicyDigest: "f".repeat(64),
  };
}
function helperTrustPolicy(schemaVersion, policyId, keyId, publicKey) {
  return {
    schemaVersion, policyId, policyRevision: 1,
    keys: [{
      keyId, algorithm: "Ed25519",
      publicKeySpkiBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      notBefore: "2026-01-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z", status: "ACTIVE",
    }],
  };
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
