import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { signSteamRcArtifact, steamCanonicalDigest, verifySteamRcArtifact } from "../src/artifacts";
import { signedDepotObjectKey, signingEvidenceObjectKey } from "../src/depot-finalization";
import type { SteamRcArchivedArtifact, SteamRcIssuanceSnapshot } from "../src/rc-issuance";
import { SteamRcIssuer, validateSignedSteamRcArtifact } from "../src/rc-issuance";
import type { SteamPrivateBetaOperationRequest } from "../src/workflow-broker-http";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const releaseId = "44444444-4444-4444-8444-444444444444";
const evidenceId = "55555555-5555-4555-8555-555555555555";
const mfaId = "66666666-6666-4666-8666-666666666666";
const depotConfigurationId = "77777777-7777-4777-8777-777777777777";
const artifactId = "88888888-8888-4888-8888-888888888888";
const mainCommitSha = "a".repeat(40);
const request: SteamPrivateBetaOperationRequest = Object.freeze({
  schemaVersion: "deviludo.steam-workflow.v1",
  kind: "PRIVATE_BETA_UPLOAD",
  operationKey: "workflow-job:99999999-9999-4999-8999-999999999999",
  requestDigest: "b".repeat(64),
  tenantId,
  projectId,
  workflowId: "delivery-001",
  runId,
  mainCommitSha,
  mainEvidenceBundleId: evidenceId,
  mfaApprovalId: mfaId,
  targetMatrix: Object.freeze(["linux", "windows"] as const),
});
const snapshot: SteamRcIssuanceSnapshot = Object.freeze({
  tenantId,
  projectId,
  runId,
  releaseId,
  mainEvidenceBundleId: evidenceId,
  mainCommitSha,
  sourceDigest: "c".repeat(64),
  specRevisionId: "spec-revision-9",
  specDigest: "d".repeat(64),
  testPlanDigest: "e".repeat(64),
  evidenceBundleDigest: "f".repeat(64),
  steamAppId: "2841930",
  targetMatrix: request.targetMatrix,
  depotConfigurationId,
  depotConfigurationDigest: "1".repeat(64),
  depots: Object.freeze([
    Object.freeze({
      platform: "linux" as const,
      depotId: "2841931",
      objectKey: `runner/${tenantId}/${projectId}/linux/export-${"2".repeat(64)}`,
      artifactDigest: "2".repeat(64),
    }),
    Object.freeze({
      platform: "windows" as const,
      depotId: "2841932",
      objectKey: `runner/${tenantId}/${projectId}/windows/export-${"3".repeat(64)}`,
      artifactDigest: "3".repeat(64),
    }),
  ]),
});

function finalized(platform: "linux" | "windows", sourceArtifactDigest: string) {
  const artifactDigest = (platform === "linux" ? "4" : "5").repeat(64);
  const signingEvidenceDigest = (platform === "linux" ? "6" : "7").repeat(64);
  return Object.freeze({
    platform,
    sourceArtifactDigest,
    artifactObjectKey: signedDepotObjectKey(tenantId, projectId, releaseId, platform, artifactDigest),
    artifactDigest,
    signingScheme: platform === "linux" ? "LINUX_SIGSTORE" as const : "WINDOWS_AUTHENTICODE" as const,
    signingIdentityDigest: "8".repeat(64),
    signingEvidenceObjectKey: signingEvidenceObjectKey(
      tenantId, projectId, releaseId, platform, signingEvidenceDigest,
    ),
    signingEvidenceDigest,
    notarizationEvidenceObjectKey: null,
    notarizationEvidenceDigest: null,
  });
}

test("Steam RC issuer inspects exact exports, signs once and replays the append-only artifact", async () => {
  const key = generateKeyPairSync("ed25519");
  const inspected: string[] = [];
  let signs = 0;
  let archived: SteamRcArchivedArtifact | null = null;
  const issuer = new SteamRcIssuer({
    async resolve(value) { assert.equal(value, request); return snapshot; },
    async probe() {},
  }, {
    async finalize(input) { return finalized(input.platform as "linux" | "windows", input.sourceArtifactDigest); },
    async probe() {},
  }, {
    async inspect(input) {
      inspected.push(input.objectKey);
      const artifact = input.objectKey.includes("/artifact/");
      return { objectRef: `s3://deviludo-evidence/${input.objectKey}`,
        sizeBytes: artifact ? input.platform === "linux" ? 1_024 : 2_048 : 512 };
    },
    async probe() {},
  }, {
    async sign(claims) { signs += 1; return signSteamRcArtifact("steam-rc-kms-7", key.privateKey, claims); },
    async probe() {},
  }, {
    async find() { return archived; },
    async persist(input) {
      assert.equal(input.artifactId, artifactId);
      assert.equal(input.artifactDigest, steamCanonicalDigest(input.artifact));
      archived = Object.freeze({
        artifact: input.artifact,
        artifactDigest: input.artifactDigest,
        depotConfigurationId: input.snapshot.depotConfigurationId,
        depotConfigurationDigest: input.snapshot.depotConfigurationDigest,
      });
      return archived;
    },
    async probe() {},
  }, {
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    artifactId: () => artifactId,
  });

  const first = await issuer.ensure(request);
  assert.equal(verifySteamRcArtifact(key.publicKey, first), true);
  assert.deepEqual(first.claims.targetMatrix, ["linux", "windows"]);
  assert.deepEqual(first.claims.depots.map((depot) => [depot.platform, depot.depotId, depot.sizeBytes]), [
    ["linux", "2841931", 1_024], ["windows", "2841932", 2_048],
  ]);
  assert.equal(first.claims.expiresAt, "2030-01-01T01:00:00.000Z");
  assert.equal(signs, 1);
  assert.deepEqual([...inspected].sort(), snapshot.depots.flatMap((depot) => {
    const result = finalized(depot.platform as "linux" | "windows", depot.artifactDigest);
    return [result.artifactObjectKey, result.signingEvidenceObjectKey];
  }).sort());

  const replay = await issuer.ensure(request);
  assert.equal(replay, first);
  assert.equal(signs, 1);
  assert.equal(inspected.length, 4);
  assert.doesNotMatch(JSON.stringify(first), /private.?key|accountPassword|configVdf/i);
});

test("Steam RC issuer rejects archived evidence or depot drift before signing or upload", async () => {
  const key = generateKeyPairSync("ed25519");
  const claims = {
    kind: "deviludo-steam-rc" as const,
    version: 2 as const,
    tenantId,
    projectId,
    releaseId,
    mainCommitSha,
    sourceDigest: snapshot.sourceDigest,
    specRevisionId: snapshot.specRevisionId,
    specDigest: snapshot.specDigest,
    testPlanDigest: snapshot.testPlanDigest,
    evidenceBundleDigest: snapshot.evidenceBundleDigest,
    steamAppId: snapshot.steamAppId,
    targetMatrix: snapshot.targetMatrix,
    depots: Object.freeze(snapshot.depots.map((depot) => {
      const result = finalized(depot.platform as "linux" | "windows", depot.artifactDigest);
      return Object.freeze({
        depotId: depot.depotId,
        platform: depot.platform,
        objectRef: `s3://deviludo-evidence/${result.artifactObjectKey}`,
        sourceArtifactDigest: result.sourceArtifactDigest,
        artifactDigest: result.artifactDigest,
        sizeBytes: 1_024,
        signingScheme: result.signingScheme,
        signingIdentityDigest: result.signingIdentityDigest,
        signingEvidenceRef: `s3://deviludo-evidence/${result.signingEvidenceObjectKey}`,
        signingEvidenceDigest: result.signingEvidenceDigest,
        notarizationEvidenceRef: null,
        notarizationEvidenceDigest: null,
      });
    })),
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T01:00:00.000Z",
  };
  const artifact = signSteamRcArtifact("steam-rc-kms-7", key.privateKey, claims);
  let objects = 0;
  const issuer = new SteamRcIssuer({
    async resolve() { return { ...snapshot, depotConfigurationDigest: "9".repeat(64) }; },
    async probe() {},
  }, {
    async finalize() { throw new Error("must not finalize"); },
    async probe() {},
  }, {
    async inspect() { objects += 1; throw new Error("must not inspect"); },
    async probe() {},
  }, {
    async sign() { throw new Error("must not sign"); },
    async probe() {},
  }, {
    async find() {
      return {
        artifact,
        artifactDigest: steamCanonicalDigest(artifact),
        depotConfigurationId,
        depotConfigurationDigest: snapshot.depotConfigurationDigest,
      };
    },
    async persist() { throw new Error("must not persist"); },
    async probe() {},
  });
  await assert.rejects(issuer.ensure(request), /RC issuance is invalid/);
  assert.equal(objects, 0);

  assert.throws(() => validateSignedSteamRcArtifact({ ...artifact, extra: true }), /RC issuance is invalid/);
});
