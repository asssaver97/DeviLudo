import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  createSteamDepotFinalizerHostInstallPlan,
  validateSteamDepotFinalizerHostInstallPlan,
} from "../scripts/production/plan-steam-depot-finalizer-host-install.mjs";

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
