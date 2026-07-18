import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { sha256Canonical, signCanonical } from "../../runner-control/src/canonical";
import type { RunnerJobPayload, SignedRunnerJob } from "../../runner-control/src/contracts";
import { REQUIRED_RUNNER_EVIDENCE } from "../../runner-control/src/coordinator";
import { SteamInstallGrantRedemptionService } from "../src/install-grant-redemption";

const keys = generateKeyPairSync("ed25519");
const sha = (value: string) => value.repeat(64);
const now = "2030-01-01T00:00:00.000Z";
const identity = { spiffeId: "spiffe://deviludo.test/connector/linux", certificateFingerprint: sha("f"), certificateSerial: "01", certificateNotAfter: "2031-01-01T00:00:00.000Z" };

test("redemption independently verifies signed job, fleet identity and exact grant binding", async () => {
  const job = signedJob();
  let authorized = 0;
  const stored: Record<string, unknown>[] = [];
  const service = new SteamInstallGrantRedemptionService({
    jobKeyId: "runner-job-key-01", jobPublicKey: keys.publicKey, now: () => new Date(now),
    fleet: {
      async authorizeJob(input) { authorized += 1; assert.equal(input.tenantId, job.payload.tenantId); return true; },
      async probe() {},
    },
    store: {
      async redeem(input) {
        stored.push({ ...input });
        return { grantId: "55555555-5555-4555-8555-555555555555", platform: "linux", steamAppId: "2841930", buildId: "91234567", betaBranch: "deviludo_private_9", redeemedAt: now };
      },
      async probe() {},
    },
  });
  const jobDigest = sha256Canonical(job.payload);
  const receipt = await service.redeem(identity, { schemaVersion: "deviludo.steam-install-grant-redemption.v1", jobDigest, signedJob: job });
  assert.equal(receipt.jobDigest, jobDigest);
  assert.equal(receipt.grantId, "55555555-5555-4555-8555-555555555555");
  assert.equal(authorized, 1);
  assert.equal(stored[0]?.jobDigest, jobDigest);
  assert.equal(stored[0]?.executionLockDigest, job.payload.executionLockDigest);
  assert.doesNotMatch(JSON.stringify({ receipt, stored }), /password|config\.vdf|steam.?guard/i);
});

test("redemption rejects signature and fleet drift before touching the grant store", async () => {
  const job = signedJob();
  let writes = 0;
  const build = (fleet: boolean) => new SteamInstallGrantRedemptionService({
    jobKeyId: "runner-job-key-01", jobPublicKey: keys.publicKey, now: () => new Date(now),
    fleet: { async authorizeJob() { return fleet; }, async probe() {} },
    store: { async redeem() { writes += 1; throw new Error("must not write"); }, async probe() {} },
  });
  const request = { schemaVersion: "deviludo.steam-install-grant-redemption.v1", jobDigest: sha256Canonical(job.payload), signedJob: job };
  await assert.rejects(build(false).redeem(identity, request), /redemption is invalid/);
  await assert.rejects(build(true).redeem(identity, { ...request, signedJob: { ...job, signature: { ...job.signature, value: "bad" } } }), /redemption is invalid/);
  assert.equal(writes, 0);
});

function signedJob(): SignedRunnerJob {
  const payload: RunnerJobPayload = {
    schemaVersion: "deviludo.runner-job.v2", attemptId: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222", projectId: "33333333-3333-4333-8333-333333333333",
    runId: "44444444-4444-4444-8444-444444444444", iterationId: "66666666-6666-4666-8666-666666666666",
    runnerId: "runner-linux-1", platform: "linux", fencingToken: 1, leaseExpiresAt: "2030-01-01T00:30:00.000Z",
    executionLockId: "77777777-7777-4777-8777-777777777777", executionLockDigest: sha("1"),
    commitSha: "a".repeat(40), sourceDigest: sha("2"), execution: { kind: "STEAM_CLEAN_INSTALL", steamAppId: "2841930", buildId: "91234567", betaBranch: "deviludo_private_9", installGrantId: "55555555-5555-4555-8555-555555555555" },
    specRevisionId: "88888888-8888-4888-8888-888888888888", specDigest: sha("3"), testPlanDigest: sha("4"),
    runnerToolchainRevisionId: "99999999-9999-4999-8999-999999999999", runnerToolchainDigest: sha("5"),
    targetMatrix: ["linux"], requiredGodotVersion: "4.6.2-stable", godotTestKitDigest: sha("6"),
    exportTemplatesDigest: sha("7"), runnerCapabilityDigest: sha("8"), buildManifestDigest: sha("9"),
    sbomDigest: sha("a"), vulnerabilityScanDigest: sha("b"), assetLicenseLedgerDigest: sha("c"), requiredEvidence: REQUIRED_RUNNER_EVIDENCE,
  };
  return { payload, signature: { algorithm: "Ed25519", keyId: "runner-job-key-01", value: signCanonical(keys.privateKey, payload) } };
}
