import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSteamDepotFinalizerHostInstallPlan } from
  "../scripts/production/plan-steam-depot-finalizer-host-install.mjs";
import {
  stageSteamDepotFinalizerHostInstallation,
  verifyStagedSteamDepotFinalizerHost,
} from "../scripts/production/stage-steam-depot-finalizer-host-install.mjs";

const components = [
  "serviceArtifact", "serviceBuildReceipt", "serviceRelease", "serviceTrustPolicy", "nativeArtifact",
  "nativeBuildReceipt", "nativeRelease", "nativeTrustPolicy", "nativePolicy", "environment",
];

test("host staging copies through no-follow handles and replays only exact immutable bytes", async () => {
  const fixture = await createFixture("linux");
  const first = await stageSteamDepotFinalizerHostInstallation(fixture.plan, fixture.plan.planDigest, {
    now: new Date("2026-07-26T00:00:00.000Z"),
    uuid: () => "00000000-0000-4000-8000-000000000010",
  });
  assert.equal(first.replayed, false);
  assert.equal(first.receipt.artifacts.length, components.length);
  assert.equal(first.receipt.serviceReleaseDigest, fixture.plan.serviceReleaseDigest);
  assert.equal(first.receipt.nativeReleaseDigest, fixture.plan.nativeReleaseDigest);
  assert.equal((await verifyStagedSteamDepotFinalizerHost(fixture.plan, fixture.plan.releaseDirectory)).receiptDigest,
    first.receipt.receiptDigest);
  const replay = await stageSteamDepotFinalizerHostInstallation(fixture.plan, fixture.plan.planDigest);
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.receiptDigest, first.receipt.receiptDigest);
});

test("host staging rejects source substitution and detects staged byte drift", async () => {
  const substituted = await createFixture("macos");
  const source = substituted.plan.artifacts[0].sourcePath;
  const alternate = resolve(substituted.root, "alternate");
  await writeFile(alternate, "alternate", { mode: 0o400 });
  await chmod(source, 0o600);
  await writeFile(source, "changed");
  await chmod(source, 0o400);
  await assert.rejects(stageSteamDepotFinalizerHostInstallation(
    substituted.plan, substituted.plan.planDigest,
  ), /staging input is invalid/);

  const drifted = await createFixture("windows");
  const staged = await stageSteamDepotFinalizerHostInstallation(drifted.plan, drifted.plan.planDigest, {
    uuid: () => "00000000-0000-4000-8000-000000000011",
  });
  const destination = staged.receipt.artifacts[4].path;
  await chmod(destination, 0o600);
  await writeFile(destination, "drifted");
  await chmod(destination, 0o500);
  await assert.rejects(verifyStagedSteamDepotFinalizerHost(
    drifted.plan, drifted.plan.releaseDirectory,
  ), /staging input is invalid/);
});

test("host staging refuses a symlinked source before creating a release", async () => {
  const fixture = await createFixture("linux");
  const original = fixture.plan.artifacts[2].sourcePath;
  const symlinkPath = resolve(fixture.root, "staged", "serviceRelease-link");
  await symlink(original, symlinkPath);
  const input = structuredClone(fixture.input);
  input.sources.serviceRelease = symlinkPath;
  const plan = createSteamDepotFinalizerHostInstallPlan(input);
  await assert.rejects(stageSteamDepotFinalizerHostInstallation(plan, plan.planDigest), /ELOOP|staging input is invalid/);
});

async function createFixture(platform) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), `deviludo-finalizer-stage-${platform}-`)));
  const installRoot = resolve(root, "install");
  const workRoot = resolve(root, "work");
  const stagedRoot = resolve(root, "staged");
  await Promise.all([mkdir(installRoot), mkdir(workRoot), mkdir(stagedRoot)]);
  const sources = {}; const digests = {};
  for (const [index, component] of components.entries()) {
    const path = resolve(stagedRoot, component);
    const body = Buffer.from(`${component}-release-bytes-${index}`);
    await writeFile(path, body, { mode: component === "serviceArtifact" || component === "nativeArtifact" ? 0o500 : 0o400 });
    sources[component] = path;
    digests[component] = digest(body);
  }
  const releaseId = "00000000-0000-4000-8000-000000000001";
  const sourceRevision = "a".repeat(40);
  const input = {
    platform,
    architecture: platform === "macos" ? "arm64" : "x86_64",
    installRoot,
    workRoot,
    preparedAt: "2026-07-26T00:00:00.000Z",
    sources,
    digests,
    nodeRuntime: {
      path: resolve(root, "runtime", platform === "windows" ? "node.exe" : "node"),
      digest: "b".repeat(64),
      version: "v22.13.1",
    },
    serviceAuthorization: {
      releaseId, sourceRevision, platformVersion: "0.1.0-beta.1",
      artifactDigest: digests.serviceArtifact,
      buildReceiptDigest: digests.serviceBuildReceipt,
      releaseDigest: digests.serviceRelease,
      trustPolicyDigest: digests.serviceTrustPolicy,
      signingKeyId: "steam-depot-finalizer-service-release-key-2026-01",
    },
    nativeAuthorization: {
      releaseId, sourceRevision, platformVersion: "0.1.0-beta.1", platform,
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
  return { root, input, plan: createSteamDepotFinalizerHostInstallPlan(input) };
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
