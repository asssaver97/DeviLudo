import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createSteamDepotFinalizerHostInstallPlan,
  planSteamDepotFinalizerHostInstallation,
  validateSteamDepotFinalizerHostInstallPlan,
} from "../scripts/production/plan-steam-depot-finalizer-host-install.mjs";
import {
  steamDepotFinalizerNativeTrustPolicyDigest,
} from "../services/steam-depot-finalizer/src/native-controller-release.ts";
import {
  steamDepotFinalizerServiceTrustPolicyDigest,
} from "../services/steam-depot-finalizer/src/native-service-release.ts";
import { canonicalJson, sha256Canonical } from "../services/runner-control/src/canonical.ts";

const releaseId = "00000000-0000-4000-8000-000000000001";
const components = [
  "serviceArtifact", "serviceBuildReceipt", "serviceRelease", "serviceTrustPolicy", "nativeArtifact",
  "nativeBuildReceipt", "nativeRelease", "nativeTrustPolicy", "nativePolicy", "environment",
];

test("host install plan binds both releases into one read-only least-privilege service", () => {
  for (const target of ["windows", "linux", "macos"]) {
    const input = fixture(target);
    const plan = createSteamDepotFinalizerHostInstallPlan(input);
    assert.equal(validateSteamDepotFinalizerHostInstallPlan(plan, plan.planDigest).releaseId, releaseId);
    assert.equal(plan.artifacts.length, 10);
    assert.equal(plan.security.agentRuntimeInstalled, false);
    assert.equal(plan.security.credentialExportAllowed, false);
    assert.deepEqual(plan.security.writablePaths, [input.workRoot]);
    assert.deepEqual(plan.service.arguments, [plan.artifacts[0].destinationPath]);
    assert.equal(plan.service.interactive, false);
    assert.equal(plan.activation.mode, "INITIAL");
    assert.equal(plan.activation.rollbackOnFailure, false);
    assert.equal(plan.service.manager, target === "linux" ? "SYSTEMD" : target === "macos" ? "LAUNCHD" : "WINDOWS_SCM");
  }
});

test("host upgrades require a drained operation ledger and retain exact rollback authority", () => {
  const first = createSteamDepotFinalizerHostInstallPlan(fixture("linux"));
  const secondInput = fixture("linux", "00000000-0000-4000-8000-000000000002");
  secondInput.previousPlan = first;
  const second = createSteamDepotFinalizerHostInstallPlan(secondInput);
  assert.equal(second.activation.mode, "DRAINED_UPGRADE");
  assert.equal(second.activation.requiredOperationState, "DRAINING");
  assert.equal(second.activation.requiredActiveOperationCount, 0);
  assert.equal(second.activation.rollbackOnFailure, true);
  assert.equal(second.rollback.previousPlanDigest, first.planDigest);
  assert.equal(second.rollback.previousReleaseDirectory, first.releaseDirectory);
});

test("host install rejects cross-platform releases, digest drift and writable release overlap", () => {
  const crossPlatform = fixture("linux");
  crossPlatform.nativeAuthorization = { ...crossPlatform.nativeAuthorization, platform: "windows" };
  assert.throws(() => createSteamDepotFinalizerHostInstallPlan(crossPlatform), /install plan is invalid/);

  const digestDrift = fixture("macos");
  digestDrift.digests = { ...digestDrift.digests, nativeArtifact: "f".repeat(64) };
  assert.throws(() => createSteamDepotFinalizerHostInstallPlan(digestDrift), /install plan is invalid/);

  const writableRelease = fixture("windows");
  writableRelease.workRoot = resolve(writableRelease.installRoot, "releases", releaseId, "work");
  assert.throws(() => createSteamDepotFinalizerHostInstallPlan(writableRelease), /install plan is invalid/);
});

test("operational host planning verifies real signed inputs while preserving raw file digests", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deviludo-finalizer-host-plan-")));
  const sourceRoot = join(root, "sources"); const installRoot = join(root, "install");
  const workRoot = join(root, "work"); const runtimeRoot = join(root, "runtime");
  await Promise.all([mkdir(sourceRoot), mkdir(installRoot), mkdir(workRoot), mkdir(runtimeRoot)]);
  const sourceRevision = "a".repeat(40); const releaseId = "00000000-0000-4000-8000-000000000009";
  const publishedAt = "2026-07-26T00:00:00.000Z"; const now = new Date("2026-07-26T00:01:00.000Z");
  const serviceKeys = generateKeyPairSync("ed25519"); const nativeKeys = generateKeyPairSync("ed25519");
  const serviceKeyId = "service-release-key-2026-01"; const nativeKeyId = "native-release-key-2026-01";
  const serviceArtifact = Buffer.from("verified-service-artifact");
  const nativeArtifact = Buffer.from("verified-native-artifact");
  const nodeRuntime = Buffer.from("verified-node-runtime");
  const identity = {
    schemaVersion: "deviludo.native-component-identity.v1",
    component: "steam-depot-finalizer-controller",
    platformVersion: "0.1.0-beta.1",
    sourceRevision,
    nodeVersion: "v22.13.1",
    platform: "linux",
    architecture: "x64",
  };
  const serviceBuild = {
    schemaVersion: "deviludo.steam-depot-finalizer-service-build-receipt.v1",
    status: "CANDIDATE",
    platformVersion: "0.1.0-beta.1",
    sourceRevision,
    nodeTarget: "22.13",
    packageLockDigest: "1".repeat(64),
    esbuildVersion: "0.28.0",
    esbuildLibraryDigest: "2".repeat(64),
    entryPoint: "services/steam-depot-finalizer/src/run-native-bundle.ts",
    artifactFileName: "deviludo-steam-depot-finalizer-service.mjs",
    artifactDigest: digest(serviceArtifact),
    sizeBytes: serviceArtifact.byteLength,
    bundleInputCount: 12,
    bundleInputDigest: "3".repeat(64),
    completedAt: "2026-07-25T23:55:00.000Z",
  };
  const nativeBuild = {
    schemaVersion: "deviludo.steam-depot-finalizer-native-build-receipt.v1",
    status: "CANDIDATE",
    platformVersion: "0.1.0-beta.1",
    sourceRevision,
    platform: "linux",
    architecture: "x86_64",
    nodeVersion: "v22.13.1",
    nodeBinaryDigest: digest(nodeRuntime),
    packageLockDigest: "1".repeat(64),
    esbuildVersion: "0.28.0",
    esbuildLibraryDigest: "2".repeat(64),
    esbuildBinaryDigest: "4".repeat(64),
    postjectVersion: "1.0.0-alpha.6",
    postjectCliDigest: "5".repeat(64),
    signatureState: "UNSIGNED",
    artifactFileName: "deviludo-steam-depot-finalizer-native",
    artifactDigest: "6".repeat(64),
    sizeBytes: 123,
    bundleDigest: "7".repeat(64),
    bundleInputCount: 12,
    identityDigest: sha256Canonical(identity),
    completedAt: "2026-07-25T23:56:00.000Z",
  };
  const serviceTrustPolicy = trustPolicy("deviludo.steam-depot-finalizer-service-trust-policy.v1",
    "service-production", serviceKeyId, serviceKeys.publicKey);
  const nativeTrustPolicy = trustPolicy("deviludo.steam-depot-finalizer-native-trust-policy.v1",
    "native-production", nativeKeyId, nativeKeys.publicKey);
  const serviceTrustPolicyDigest = steamDepotFinalizerServiceTrustPolicyDigest(serviceTrustPolicy);
  const nativeTrustPolicyDigest = steamDepotFinalizerNativeTrustPolicyDigest(nativeTrustPolicy);
  const serviceBuildBytes = Buffer.from(`${JSON.stringify(serviceBuild, null, 2)}\n`);
  const nativeBuildBytes = Buffer.from(`${JSON.stringify(nativeBuild, null, 2)}\n`);
  const serviceClaims = {
    kind: "deviludo-steam-depot-finalizer-service",
    version: 1,
    releaseId,
    platformVersion: "0.1.0-beta.1",
    sourceRevision,
    nodeTarget: "22.13",
    artifactDigest: digest(serviceArtifact),
    artifactSizeBytes: serviceArtifact.byteLength,
    buildReceiptDigest: digest(serviceBuildBytes),
    packageLockDigest: serviceBuild.packageLockDigest,
    bundleInputDigest: serviceBuild.bundleInputDigest,
    sbomDigest: "8".repeat(64),
    malwareScanDigest: "9".repeat(64),
    vulnerabilityScanDigest: "a".repeat(64),
    provenanceDigest: "b".repeat(64),
    publishedAt,
  };
  const serviceRelease = {
    keyId: serviceKeyId,
    claims: serviceClaims,
    signature: sign(null, Buffer.from(canonicalJson(serviceClaims)), serviceKeys.privateKey).toString("base64url"),
  };
  const nativeClaims = {
    schemaVersion: "deviludo.steam-depot-finalizer-native-release-claims.v1",
    releaseId,
    platformVersion: "0.1.0-beta.1",
    sourceRevision,
    platform: "linux",
    architecture: "x86_64",
    nodeVersion: "v22.13.1",
    artifactDigest: digest(nativeArtifact),
    artifactSizeBytes: nativeArtifact.byteLength,
    buildReceiptDigest: digest(nativeBuildBytes),
    identityDigest: sha256Canonical(identity),
    nativeSignature: {
      scheme: "sigstore-cosign",
      signerIdentity: "kms-linux-release-key",
      evidenceDigest: "c".repeat(64),
      transparencyLogDigest: "d".repeat(64),
      notarizationDigest: null,
    },
    publishedAt,
  };
  const nativeRelease = {
    schemaVersion: "deviludo.steam-depot-finalizer-native-release.v1",
    claims: nativeClaims,
    signature: {
      algorithm: "Ed25519",
      keyId: nativeKeyId,
      value: sign(null, Buffer.from(canonicalJson(nativeClaims)), nativeKeys.privateKey).toString("base64url"),
    },
  };
  const nativePolicy = {
    schemaVersion: "deviludo.steam-depot-native-policy.v1",
    policyVersion: "1.0.0",
    platform: "linux",
    workRoot,
    artifactStore: {
      endpoint: "https://s3.release.internal:9000/",
      bucket: "deviludo-release-evidence",
      region: "us-east-1",
      accessKeyId: "DEVILUDORELEASE01",
      secretAccessKeyFile: join(root, "secrets", "s3-key"),
      caFile: join(root, "secrets", "s3-ca.pem"),
    },
    signer: {
      scheme: "LINUX_SIGSTORE",
      signingKeyRef: "kms://deviludo/steam-linux-signing",
      publicKeyFile: join(root, "secrets", "cosign.pub"),
      publicKeyDigest: "e".repeat(64),
      cosign: { path: join(root, "tools", "cosign"), digest: "f".repeat(64), version: "2.6.0" },
    },
  };
  const sources = Object.fromEntries(components.map((component) => [component, join(sourceRoot, component)]));
  const prettyServiceRelease = Buffer.from(`${JSON.stringify(serviceRelease, null, 2)}\n`);
  const prettyServiceTrust = Buffer.from(`${JSON.stringify(serviceTrustPolicy, null, 2)}\n`);
  const prettyNativeRelease = Buffer.from(`${JSON.stringify(nativeRelease, null, 2)}\n`);
  const prettyNativeTrust = Buffer.from(`${JSON.stringify(nativeTrustPolicy, null, 2)}\n`);
  await Promise.all([
    writeFile(sources.serviceArtifact, serviceArtifact, { mode: 0o500 }),
    writeFile(sources.serviceBuildReceipt, serviceBuildBytes, { mode: 0o400 }),
    writeFile(sources.serviceRelease, prettyServiceRelease, { mode: 0o400 }),
    writeFile(sources.serviceTrustPolicy, prettyServiceTrust, { mode: 0o400 }),
    writeFile(sources.nativeArtifact, nativeArtifact, { mode: 0o500 }),
    writeFile(sources.nativeBuildReceipt, nativeBuildBytes, { mode: 0o400 }),
    writeFile(sources.nativeRelease, prettyNativeRelease, { mode: 0o400 }),
    writeFile(sources.nativeTrustPolicy, prettyNativeTrust, { mode: 0o400 }),
    writeFile(sources.nativePolicy, canonicalJson(nativePolicy), { mode: 0o400 }),
    writeFile(sources.environment, "NODE_ENV=production\n", { mode: 0o400 }),
    writeFile(join(runtimeRoot, "node"), nodeRuntime, { mode: 0o500 }),
  ]);
  const outputPath = join(root, "install-plan.json");
  const plan = await planSteamDepotFinalizerHostInstallation({
    schemaVersion: "deviludo.steam-depot-finalizer-host-planning-input.v1",
    platform: "linux",
    architecture: "x86_64",
    installRoot,
    workRoot,
    outputPath,
    previousPlanPath: null,
    sources,
    serviceTrustPolicyDigest,
    nativeTrustPolicyDigest,
    nodeRuntime: { path: join(runtimeRoot, "node"), digest: digest(nodeRuntime), version: "v22.13.1" },
  }, {
    now,
    inspectIdentity: async () => identity,
    inspectNode: async () => ({ version: "v22.13.1", platform: "linux", arch: "x64", execPath: join(runtimeRoot, "node") }),
  });
  assert.equal(plan.serviceTrustPolicyDigest, serviceTrustPolicyDigest);
  assert.equal(plan.nativeTrustPolicyDigest, nativeTrustPolicyDigest);
  assert.equal(plan.serviceReleaseDigest, sha256Canonical(serviceRelease));
  assert.equal(plan.nativeReleaseDigest, sha256Canonical(nativeRelease));
  assert.equal(plan.artifacts.find(({ component }) => component === "serviceRelease").digest, digest(prettyServiceRelease));
  assert.notEqual(digest(prettyServiceRelease), plan.serviceReleaseDigest);
  assert.notEqual(digest(prettyServiceTrust), plan.serviceTrustPolicyDigest);
  assert.equal((await readFile(outputPath, "utf8")), `${canonicalJson(plan)}\n`);
});

function fixture(platform, id = releaseId) {
  const root = resolve("/private/tmp/deviludo-finalizer-host", platform);
  const digests = Object.fromEntries(components.map((component, index) => [
    component, (index + 1).toString(16).repeat(64),
  ]));
  const sources = Object.fromEntries(components.map((component) => [component, resolve(root, "staged", component)]));
  const sourceRevision = "a".repeat(40);
  return {
    platform,
    architecture: platform === "macos" ? "arm64" : "x86_64",
    installRoot: resolve(root, "install"),
    workRoot: resolve(root, "work"),
    preparedAt: "2026-07-26T00:00:00.000Z",
    sources,
    digests,
    nodeRuntime: {
      path: resolve(root, "runtime", platform === "windows" ? "node.exe" : "node"),
      digest: "b".repeat(64),
      version: "v22.13.1",
    },
    serviceAuthorization: {
      releaseId: id,
      sourceRevision,
      platformVersion: "0.1.0-beta.1",
      artifactDigest: digests.serviceArtifact,
      buildReceiptDigest: digests.serviceBuildReceipt,
      releaseDigest: digests.serviceRelease,
      trustPolicyDigest: digests.serviceTrustPolicy,
      signingKeyId: "steam-depot-finalizer-service-release-key-2026-01",
    },
    nativeAuthorization: {
      releaseId: id,
      sourceRevision,
      platformVersion: "0.1.0-beta.1",
      platform,
      architecture: platform === "macos" ? "arm64" : "x86_64",
      artifactDigest: digests.nativeArtifact,
      buildReceiptDigest: digests.nativeBuildReceipt,
      releaseDigest: digests.nativeRelease,
      trustPolicyDigest: digests.nativeTrustPolicy,
      identityDigest: "c".repeat(64),
      signingKeyId: "steam-depot-finalizer-native-release-key-2026-01",
    },
    previousPlan: null,
  };
}

function trustPolicy(schemaVersion, policyId, keyId, publicKey) {
  return {
    schemaVersion,
    policyId,
    policyRevision: 1,
    keys: [{
      keyId,
      algorithm: "Ed25519",
      publicKeySpkiBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2027-01-01T00:00:00.000Z",
      status: "ACTIVE",
    }],
  };
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
