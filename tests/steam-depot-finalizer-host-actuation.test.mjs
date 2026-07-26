import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  executeSteamDepotFinalizerHostTransaction,
} from "../scripts/production/apply-steam-depot-finalizer-host-transaction.mjs";
import {
  executeWindowsSteamDepotFinalizerHostActuation,
  parseWindowsSteamDepotFinalizerHostActuationArguments,
} from "../scripts/production/apply-windows-steam-depot-finalizer-host-transaction.mjs";
import {
  createSteamDepotFinalizerHostTransaction,
} from "../scripts/production/compile-steam-depot-finalizer-host-transaction.mjs";
import {
  createSteamDepotFinalizerHostActivationRequest,
  parseSteamDepotFinalizerHostActivationRequestArguments,
  previousSteamDepotFinalizerDefinitionDigest,
  requestSteamDepotFinalizerHostActivation,
} from "../scripts/production/request-steam-depot-finalizer-host-activation.mjs";
import {
  parseSteamDepotFinalizerHostActivationReportArguments,
  reportSteamDepotFinalizerHostActivation,
} from "../scripts/production/report-steam-depot-finalizer-host-activation.mjs";
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

test("host activation requester binds the staged transaction, machine identity and receipt path", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-finalizer-request-"));
  const fixture = transactionFixture(root, "00000000-0000-4000-8000-000000000001");
  const receiptOutputPath = join(root, "activation-receipt.json");
  const input = {
    ...fixture,
    planDigest: fixture.plan.planDigest,
    transactionDigest: fixture.transaction.transactionDigest,
    stagingReceipt: stagingReceiptFor(fixture.plan),
    operationId: "00000000-0000-4000-8000-000000000099",
    receiptOutputPath,
    previousDefinitionDigest: null,
    identity: {
      hostId: "steam-finalizer-linux-01",
      hostSpiffeId: "spiffe://deviludo.internal/steam-depot-finalizer/linux-01",
      hostCertificateFingerprint: "9".repeat(64),
    },
  };
  const request = createSteamDepotFinalizerHostActivationRequest(input);
  assert.equal(request.definitionDigest, fixture.transaction.definition.renderedDigest);
  assert.equal(request.operationState, "INITIALIZING");
  assert.equal(request.receiptPath, receiptOutputPath);

  const signed = grantEnvelope(fixture, receiptOutputPath, null);
  const authorized = await requestSteamDepotFinalizerHostActivation(input, {
    client: { async authorize(value) { assert.deepEqual(value, request); return signed; } },
    publicKey: keyPair.publicKey, keyId, now,
  });
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.result.payload.operationId, request.operationId);

  const draining = await requestSteamDepotFinalizerHostActivation(input, {
    client: { async authorize() { return {
      schemaVersion: "deviludo.steam-depot-finalizer-host-drain-receipt.v1",
      operationId: request.operationId, hostId: request.hostId, state: "DRAINING",
      activeOperationCount: 1, observedAt: now.toISOString(), retryAfterSeconds: 5,
    }; } },
    publicKey: keyPair.publicKey, keyId, now,
  });
  assert.equal(draining.authorized, false);
  assert.equal(draining.result.retryAfterSeconds, 5);

  assert.throws(() => createSteamDepotFinalizerHostActivationRequest({
    ...input, previousDefinitionDigest: "a".repeat(64),
  }), /request input is invalid/);
});

test("host activation requester derives the exact POSIX previous definition and report retries safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-finalizer-report-"));
  const definitionPath = join(root, "deviludo-finalizer.service");
  const definition = Buffer.from("immutable previous service definition");
  await writeFile(definitionPath, definition, { mode: 0o400 });
  const previous = await previousSteamDepotFinalizerDefinitionDigest(
    { platform: "linux", activation: { mode: "DRAINED_UPGRADE" } },
    { definition: { destination: definitionPath } },
  );
  assert.equal(previous, digest(definition));
  assert.equal(await previousSteamDepotFinalizerDefinitionDigest(
    { platform: "linux", activation: { mode: "INITIAL" } },
    { definition: { destination: join(root, "missing.service") } },
  ), null);

  const fixture = transactionFixture(root, "00000000-0000-4000-8000-000000000001");
  const receiptPath = join(root, "receipt.json");
  const grantPath = join(root, "grant.json");
  const grant = verifiedGrant(fixture, receiptPath, null);
  const receipt = await executeSteamDepotFinalizerHostTransaction({ ...fixture, grant, outputPath: receiptPath }, {
    host: fakeHost(fixture.plan), now, reportResult: async () => undefined,
  });
  await writeFile(grantPath, JSON.stringify(grant), { mode: 0o400 });
  let calls = 0;
  const reported = await reportSteamDepotFinalizerHostActivation({ activationGrantPath: grantPath, receiptPath }, {
    client: { async complete(observedGrant, observedReceipt) {
      calls += 1; assert.deepEqual(observedGrant, grant); assert.deepEqual(observedReceipt, receipt); return observedReceipt;
    } },
    now,
  });
  assert.equal(reported.receiptDigest, receipt.receiptDigest);
  assert.equal(calls, 1);
});

test("host activation request and report CLIs accept only exact absolute arguments", () => {
  const root = "/var/lib/deviludo/steam-depot-finalizer";
  assert.equal(parseSteamDepotFinalizerHostActivationRequestArguments([
    "--operation-id", "00000000-0000-4000-8000-000000000099",
    "--plan", `${root}/plan.json`, "--plan-digest", "1".repeat(64),
    "--transaction", `${root}/transaction.json`, "--transaction-digest", "2".repeat(64),
    "--grant-output", `${root}/grant.json`, "--receipt-output", `${root}/receipt.json`,
  ]).operationId, "00000000-0000-4000-8000-000000000099");
  assert.deepEqual(parseSteamDepotFinalizerHostActivationReportArguments([
    "--activation-grant", `${root}/grant.json`, "--receipt", `${root}/receipt.json`,
  ]), { activationGrantPath: `${root}/grant.json`, receiptPath: `${root}/receipt.json` });
  assert.throws(() => parseSteamDepotFinalizerHostActivationReportArguments([
    "--activation-grant", "relative.json", "--receipt", `${root}/receipt.json`,
  ]), /report input is invalid/);
});

test("Windows Finalizer actuation keeps native rollback pending until mTLS health passes", async () => {
  const payload = {
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-grant-payload.v1",
    operationId: "00000000-0000-4000-8000-000000000099", grantSequence: 1,
    hostId: "steam-finalizer-windows-01",
    hostSpiffeId: "spiffe://deviludo.internal/steam-depot-finalizer/windows-01",
    hostCertificateFingerprint: "9".repeat(64),
    planDigest: "1".repeat(64), transactionDigest: "2".repeat(64), stagingReceiptDigest: "3".repeat(64),
    releaseId: "00000000-0000-4000-8000-000000000001",
    serviceReleaseDigest: "4".repeat(64), nativeReleaseDigest: "5".repeat(64),
    platform: "windows", architecture: "x86_64", operationState: "INITIALIZING", activeOperationCount: 0,
    previousPlanDigest: null, previousDefinitionDigest: null, definitionDigest: "6".repeat(64),
    receiptPath: "C:\\ProgramData\\DeviLudo\\NativeActuator\\activation-receipt.json",
    issuedAt: "2026-07-26T00:00:00.000Z", expiresAt: "2026-07-26T00:10:00.000Z",
  };
  const grant = verifySteamDepotFinalizerHostActivationGrant({
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-grant.v1",
    algorithm: "Ed25519", keyId, payload, signature: signCanonical(keyPair.privateKey, payload),
  }, { publicKey: keyPair.publicKey, keyId, now });
  const events = [];
  const host = {
    async prepare() { events.push("prepare"); }, async probePending() { events.push("probe-pending"); },
    async checkHealth() { events.push("health"); }, async commit() { events.push("commit"); },
    async rollback() { events.push("rollback"); }, async probeActive() { events.push("probe-active"); },
  };
  const success = await executeWindowsSteamDepotFinalizerHostActuation({ grant }, { host, now });
  assert.equal(success.state, "ACTIVATED");
  assert.deepEqual(events, ["prepare", "probe-pending", "health", "commit"]);

  events.length = 0;
  host.checkHealth = async () => { events.push("health"); throw new Error("not ready"); };
  const rolledBack = await executeWindowsSteamDepotFinalizerHostActuation({ grant }, { host, now });
  assert.equal(rolledBack.state, "ROLLED_BACK");
  assert.match(rolledBack.failureDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(events, ["prepare", "probe-pending", "health", "rollback"]);

  events.length = 0;
  host.checkHealth = async () => { events.push("health"); };
  const recovered = await executeWindowsSteamDepotFinalizerHostActuation({ grant, recoveryState: "COMMITTED" }, { host, now });
  assert.equal(recovered.state, "ACTIVATED");
  assert.deepEqual(events, ["probe-active", "health"]);
});

test("Windows Finalizer actuator CLI binds all digests and fixed absolute files", () => {
  const root = "C:\\ProgramData\\DeviLudo\\NativeActuator";
  const parsed = parseWindowsSteamDepotFinalizerHostActuationArguments([
    "--activation-grant", `${root}\\activation-grant.json`,
    "--actuation-request", `${root}\\actuation-request.v1.bin`,
    "--actuation-request-digest", "1".repeat(64),
    "--output", `${root}\\activation-receipt.json`,
    "--plan", `${root}\\install-plan.json`, "--plan-digest", "2".repeat(64),
    "--transaction", `${root}\\transaction.json`, "--transaction-digest", "3".repeat(64),
  ]);
  assert.equal(parsed.actuationRequestDigest, "1".repeat(64));
  assert.throws(() => parseWindowsSteamDepotFinalizerHostActuationArguments([
    "--activation-grant", "relative.json",
  ]), /actuation input is invalid/);
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
    hostId: "steam-finalizer-linux-01",
    hostSpiffeId: "spiffe://deviludo.internal/steam-depot-finalizer/linux-01",
    hostCertificateFingerprint: "9".repeat(64),
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
