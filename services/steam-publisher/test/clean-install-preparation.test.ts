import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerExecutionLock } from "../../runner-control/src/execution-lock";
import {
  parseSteamCleanInstallPreparationTrigger,
  SteamCleanInstallPreparationService,
} from "../src/clean-install-preparation";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const buildReceiptId = "44444444-4444-4444-8444-444444444444";
const executionLockId = "55555555-5555-4555-8555-555555555555";
const specRevisionId = "66666666-6666-4666-8666-666666666666";
const toolchainRevisionId = "77777777-7777-4777-8777-777777777777";
const sha = (character: string) => character.repeat(64);
const trigger = Object.freeze({
  schemaVersion: "deviludo.steam-clean-install-preparation-trigger.v1" as const,
  tenantId,
  projectId,
  runId,
  lockKey: sha("1"),
  commitSha: "a".repeat(40),
  steamBuildId: "91234567",
  targetMatrix: Object.freeze(["linux", "macos", "windows"] as const),
});
const toolchain = Object.freeze({
  schemaVersion: "deviludo.runner-toolchain.v1" as const,
  requiredGodotVersion: "4.6.2-stable",
  godotTestKitDigest: sha("2"),
  exportTemplates: Object.freeze({ linux: sha("3"), macos: sha("4"), windows: sha("5") }),
  buildManifestDigest: sha("6"),
  sbomDigest: sha("7"),
  vulnerabilityScanDigest: sha("8"),
  assetLicenseLedgerDigest: sha("9"),
});

test("Steam clean-install preparation authorizes, issues one opaque grant and freezes the execution lock", async () => {
  const calls: string[] = [];
  const persistedLocks: RunnerExecutionLock[] = [];
  const service = new SteamCleanInstallPreparationService({
    tenants: {
      async authorize(identity, authorizedTenantId) {
        calls.push("authorize");
        assert.equal(identity.spiffeId, "spiffe://deviludo.internal/runner-workflow");
        assert.equal(authorizedTenantId, tenantId);
      },
      async probe() { calls.push("tenant-probe"); },
    },
    authority: {
      async resolve(value) {
        calls.push("authority");
        assert.equal(calls[0], "authorize");
        assert.deepEqual(value, trigger);
        return {
          trigger,
          buildReceiptId,
          sourceDigest: sha("a"),
          specRevisionId,
          specDigest: sha("b"),
          testPlanDigest: sha("c"),
          runnerToolchainRevisionId: toolchainRevisionId,
          runnerToolchainDigest: sha("d"),
          toolchain,
          steamAppId: "2841930",
          betaBranch: "deviludo_private_9",
        };
      },
      async probe() { calls.push("authority-probe"); },
    },
    grants: {
      async issue(input) {
        calls.push("grant");
        assert.equal(input.buildReceiptId, buildReceiptId);
        assert.equal(input.buildId, trigger.steamBuildId);
        assert.equal(JSON.stringify(input).includes("password"), false);
        return {
          installGrantId: "install-grant-9",
          steamAppId: input.steamAppId,
          buildId: input.buildId,
          betaBranch: input.betaBranch,
          targetMatrix: input.targetMatrix,
        };
      },
      async probe() { calls.push("grant-probe"); },
    },
    locks: {
      async persist(input) {
        calls.push("lock");
        persistedLocks.push(input.payload);
        assert.equal(input.lockKey, trigger.lockKey);
        assert.equal(input.payloadDigest, sha256Shape(input.payloadDigest));
        return { executionLockId, payloadDigest: input.payloadDigest, created: true };
      },
    },
    now: () => new Date("2099-01-01T00:00:00.000Z"),
  });

  const receipt = await service.prepare({
    spiffeId: "spiffe://deviludo.internal/runner-workflow",
    certificateFingerprint: sha("e"),
    certificateSerial: "01",
    certificateNotAfter: "2099-01-02T00:00:00.000Z",
  }, trigger);
  assert.deepEqual(calls, ["authorize", "authority", "grant", "lock"]);
  assert.equal(receipt.executionLockId, executionLockId);
  assert.equal(receipt.installGrantId, "install-grant-9");
  assert.equal(receipt.buildId, trigger.steamBuildId);
  assert.equal(persistedLocks[0]?.mode, "STEAM_CLEAN_INSTALL");
  assert.equal(persistedLocks[0]?.steamBuildId, trigger.steamBuildId);
  assert.deepEqual(persistedLocks[0]?.execution, {
    kind: "STEAM_CLEAN_INSTALL",
    steamAppId: "2841930",
    buildId: trigger.steamBuildId,
    betaBranch: "deviludo_private_9",
    installGrantId: "install-grant-9",
  });
  assert.doesNotMatch(JSON.stringify({ receipt, locked: persistedLocks[0] }), /config\.vdf|password|steam.?guard|secret.?ref/i);
});

test("Steam clean-install trigger rejects caller-supplied credentials and non-canonical matrices", () => {
  assert.throws(() => parseSteamCleanInstallPreparationTrigger({ ...trigger, password: "do-not-accept" }), /fields/);
  assert.throws(() => parseSteamCleanInstallPreparationTrigger({ ...trigger, targetMatrix: ["windows", "linux"] }), /matrix order/);
  assert.throws(() => parseSteamCleanInstallPreparationTrigger({ ...trigger, steamBuildId: "0" }), /BuildID/);
});

function sha256Shape(value: string): string {
  assert.match(value, /^[a-f0-9]{64}$/);
  return value;
}
