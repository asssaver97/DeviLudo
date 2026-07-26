import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  executeSteamDepotFinalizerHostTransaction,
} from "../scripts/production/apply-steam-depot-finalizer-host-transaction.mjs";
import {
  createSteamDepotFinalizerHostTransaction,
} from "../scripts/production/compile-steam-depot-finalizer-host-transaction.mjs";
import {
  createSteamDepotFinalizerHostInstallPlan,
} from "../scripts/production/plan-steam-depot-finalizer-host-install.mjs";
import {
  verifySteamDepotFinalizerHostActivationGrant,
} from "../services/steam-depot-finalizer/src/host-activation.ts";
import { canonicalJson, sha256Canonical, signCanonical } from "../services/runner-control/src/canonical.ts";

const components = [
  "serviceArtifact", "serviceBuildReceipt", "serviceRelease", "serviceTrustPolicy", "nativeArtifact",
  "nativeBuildReceipt", "nativeRelease", "nativeTrustPolicy", "nativePolicy", "environment",
];
const keyPair = generateKeyPairSync("ed25519");
const keyId = "steam-finalizer-host-activation-key-2026-01";
const now = new Date("2026-07-26T00:02:00.000Z");

test("signed host activation executes an exact initial transaction and replays its immutable receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-finalizer-actuation-"));
  const fixture = transactionFixture(root, "00000000-0000-4000-8000-000000000001");
  const outputPath = join(root, "receipt.json");
  const grant = verifiedGrant(fixture, outputPath, null);
  const host = fakeHost(fixture.plan);
  const reports = [];
  const input = { ...fixture, grant, outputPath };
  const receipt = await executeSteamDepotFinalizerHostTransaction(input, {
    host, now, reportResult: async (value) => reports.push(value),
  });
  assert.equal(receipt.state, "ACTIVATED");
  assert.equal(reports.length, 1);
  assert.deepEqual(host.health, ["SIGNED_RELEASES", "NATIVE_IDENTITY", "NATIVE_PROBE", "MTLS_READY"]);
  assert.equal(digest(host.definition), fixture.transaction.definition.renderedDigest);
  const mutations = host.mutations;
  const replay = await executeSteamDepotFinalizerHostTransaction(input, {
    host, now: new Date("2026-07-26T01:00:00.000Z"), reportResult: async () => assert.fail("replay must not report again"),
  });
  assert.equal(replay.receiptDigest, receipt.receiptDigest);
  assert.equal(host.mutations, mutations);
});

test("failed upgrade health restores the exact previous definition and reports rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-finalizer-rollback-"));
  const previous = transactionFixture(root, "00000000-0000-4000-8000-000000000001").plan;
  const fixture = transactionFixture(root, "00000000-0000-4000-8000-000000000002", previous);
  const outputPath = join(root, "rollback-receipt.json");
  const previousDefinition = Buffer.from("previous-signed-service-definition");
  const grant = verifiedGrant(fixture, outputPath, digest(previousDefinition));
  const host = fakeHost(fixture.plan, { definition: previousDefinition, failHealth: "NATIVE_PROBE" });
  const reports = [];
  const receipt = await executeSteamDepotFinalizerHostTransaction({ ...fixture, grant, outputPath }, {
    host, now, reportResult: async (value) => reports.push(value),
  });
  assert.equal(receipt.state, "ROLLED_BACK");
  assert.match(receipt.failureDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(host.definition, previousDefinition);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].receiptDigest, receipt.receiptDigest);
});

test("activation grant rejects transaction drift, stale grants and a mismatched previous definition", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-finalizer-grant-"));
  const fixture = transactionFixture(root, "00000000-0000-4000-8000-000000000001");
  const outputPath = join(root, "receipt.json");
  const envelope = grantEnvelope(fixture, outputPath, null);
  assert.throws(() => verifySteamDepotFinalizerHostActivationGrant({
    ...envelope, payload: { ...envelope.payload, transactionDigest: "f".repeat(64) },
  }, { publicKey: keyPair.publicKey, keyId, now }), /activation grant .*invalid/);
  assert.throws(() => verifySteamDepotFinalizerHostActivationGrant(envelope, {
    publicKey: keyPair.publicKey, keyId, now: new Date("2026-07-26T00:20:00.000Z"),
  }), /activation grant .*invalid/);

  const previous = transactionFixture(root, "00000000-0000-4000-8000-000000000003").plan;
  const upgrade = transactionFixture(root, "00000000-0000-4000-8000-000000000004", previous);
  const upgradeOutput = join(root, "upgrade-receipt.json");
  const grant = verifiedGrant(upgrade, upgradeOutput, "e".repeat(64));
  await assert.rejects(executeSteamDepotFinalizerHostTransaction({ ...upgrade, grant, outputPath: upgradeOutput }, {
    host: fakeHost(upgrade.plan, { definition: Buffer.from("different-current-definition") }),
    now,
    reportResult: async () => undefined,
  }), /actuation input is invalid/);
});

function transactionFixture(root, releaseId, previousPlan = null) {
  const installRoot = resolve(root, "install"); const workRoot = resolve(root, "work");
  const sources = Object.fromEntries(components.map((component) => [component, resolve(root, "source", component)]));
  const digests = Object.fromEntries(components.map((component, index) => [component, (index + 1).toString(16).repeat(64)]));
  const platform = "linux"; const architecture = "x86_64";
  const releaseDirectory = resolve(installRoot, "releases", releaseId);
  const fileNames = {
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
  };
  const destination = (component) => resolve(releaseDirectory, fileNames[component]);
  const environmentBytes = Buffer.from([
    "NODE_ENV=production",
    "DATABASE_URL=postgresql://deviludo@postgres.internal/deviludo",
    "DEVILUDO_STEAM_DEPOT_FINALIZER_PLATFORM=linux",
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
    "",
  ].join("\n"));
  digests.environment = digest(environmentBytes);
  const sourceRevision = "a".repeat(40);
  const plan = createSteamDepotFinalizerHostInstallPlan({
    platform, architecture, installRoot, workRoot, sources, digests,
    preparedAt: "2026-07-26T00:00:00.000Z",
    nodeRuntime: { path: resolve(root, "runtime", "node"), digest: "b".repeat(64), version: "v22.13.1" },
    serviceAuthorization: {
      releaseId, sourceRevision, platformVersion: "0.1.0-beta.1", artifactDigest: digests.serviceArtifact,
      buildReceiptDigest: digests.serviceBuildReceipt, releaseDigest: digests.serviceRelease,
      trustPolicyDigest: digests.serviceTrustPolicy, signingKeyId: "service-release-key-2026-01",
    },
    nativeAuthorization: {
      releaseId, sourceRevision, platformVersion: "0.1.0-beta.1", platform, architecture,
      artifactDigest: digests.nativeArtifact, buildReceiptDigest: digests.nativeBuildReceipt,
      releaseDigest: digests.nativeRelease, trustPolicyDigest: digests.nativeTrustPolicy,
      identityDigest: "c".repeat(64), signingKeyId: "native-release-key-2026-01",
    },
    previousPlan,
  });
  const stagingReceipt = stagingReceiptFor(plan);
  const transaction = createSteamDepotFinalizerHostTransaction({
    plan, planDigest: plan.planDigest, stagingReceipt, environment: environmentBytes,
    windowsBridgeAuthorization: null, windowsActuatorAuthorization: null,
  });
  return { plan, transaction, environment: Object.freeze(Object.fromEntries(environmentBytes.toString("utf8").trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)))) };
}

function stagingReceiptFor(plan) {
  const core = {
    schemaVersion: "deviludo.steam-depot-finalizer-host-staging-receipt.v1",
    status: "STAGED",
    planDigest: plan.planDigest,
    planFileDigest: digest(Buffer.from(`${canonicalJson(plan)}\n`)),
    releaseId: plan.releaseId,
    serviceReleaseDigest: plan.serviceReleaseDigest,
    nativeReleaseDigest: plan.nativeReleaseDigest,
    platform: plan.platform,
    architecture: plan.architecture,
    releaseDirectory: plan.releaseDirectory,
    stagedAt: "2026-07-26T00:01:00.000Z",
    artifacts: plan.artifacts.map((entry) => ({
      component: entry.component, path: entry.destinationPath, digest: entry.digest, sizeBytes: 100, mode: entry.mode,
    })),
  };
  return { ...core, receiptDigest: sha256Canonical(core) };
}

function grantEnvelope(fixture, receiptPath, previousDefinitionDigest) {
  const payload = {
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-grant-payload.v1",
    operationId: "00000000-0000-4000-8000-000000000099",
    grantSequence: 1,
    planDigest: fixture.plan.planDigest,
    transactionDigest: fixture.transaction.transactionDigest,
    stagingReceiptDigest: fixture.transaction.stagingReceiptDigest,
    releaseId: fixture.plan.releaseId,
    serviceReleaseDigest: fixture.plan.serviceReleaseDigest,
    nativeReleaseDigest: fixture.plan.nativeReleaseDigest,
    platform: fixture.plan.platform,
    architecture: fixture.plan.architecture,
    operationState: fixture.plan.rollback === null ? "INITIALIZING" : "DRAINING",
    activeOperationCount: 0,
    previousPlanDigest: fixture.plan.rollback?.previousPlanDigest ?? null,
    previousDefinitionDigest,
    definitionDigest: fixture.transaction.definition.renderedDigest,
    receiptPath,
    issuedAt: "2026-07-26T00:00:00.000Z",
    expiresAt: "2026-07-26T00:10:00.000Z",
  };
  return {
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-grant.v1",
    algorithm: "Ed25519",
    keyId,
    payload,
    signature: signCanonical(keyPair.privateKey, payload),
  };
}
function verifiedGrant(fixture, receiptPath, previousDefinitionDigest) {
  return verifySteamDepotFinalizerHostActivationGrant(grantEnvelope(fixture, receiptPath, previousDefinitionDigest), {
    publicKey: keyPair.publicKey, keyId, now,
  });
}

function fakeHost(plan, options = {}) {
  const expected = new Map(plan.artifacts.map((entry) => [entry.destinationPath, entry.digest]));
  expected.set(plan.nodeRuntime.path, plan.nodeRuntime.digest);
  return {
    platform: plan.platform,
    architecture: plan.architecture,
    definition: options.definition ?? null,
    health: [],
    mutations: 0,
    async readDefinition() { return this.definition === null ? null : Buffer.from(this.definition); },
    async writeDefinition(_path, body) { this.definition = Buffer.from(body); this.mutations += 1; },
    async removeDefinition() { this.definition = null; this.mutations += 1; },
    async digestFile(path) { return expected.get(path) ?? assert.fail(`unexpected digest path ${path}`); },
    async run() { this.mutations += 1; return { exitCode: 0, output: "" }; },
    async checkHealth(check) { this.health.push(check); if (check === options.failHealth) throw new Error("probe failed"); },
    async sleep() {},
  };
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
