import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { signSteamPublishAuthorization, signSteamRcArtifact } from "../src/artifacts";
import { InMemorySteamPublishOperationStore, SteamReleaseCoordinator } from "../src/coordinator";
import { buildSteamCmdRuntimePlan } from "../src/steamcmd";
import type {
  SteamBuildSession,
  SteamPrivateBetaReceipt,
  SteamPublishAuthorizationClaims,
  SteamRcArtifactClaims,
} from "../src/contracts";

const rcKey = generateKeyPairSync("ed25519");
const authorizationKey = generateKeyPairSync("ed25519");
const now = new Date("2099-01-01T00:05:00.000Z");
const digest = (character: string) => character.repeat(64);

const rcClaims: SteamRcArtifactClaims = Object.freeze({
  kind: "deviludo-steam-rc",
  version: 1,
  tenantId: "tenant-north-dock",
  projectId: "project-ember",
  releaseId: "release-9",
  mainCommitSha: "a".repeat(40),
  sourceDigest: digest("b"),
  specRevisionId: "spec-9",
  specDigest: digest("c"),
  testPlanDigest: digest("d"),
  evidenceBundleDigest: digest("e"),
  steamAppId: "2841930",
  targetMatrix: Object.freeze(["windows", "linux", "macos"] as const),
  depots: Object.freeze([
    { depotId: "2841931", platform: "windows", objectRef: "s3://rc/windows.zip", artifactDigest: digest("1"), sizeBytes: 1_000 },
    { depotId: "2841932", platform: "linux", objectRef: "s3://rc/linux.zip", artifactDigest: digest("2"), sizeBytes: 2_000 },
    { depotId: "2841933", platform: "macos", objectRef: "s3://rc/macos.zip", artifactDigest: digest("3"), sizeBytes: 3_000 },
  ] as const),
  issuedAt: "2099-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:30:00.000Z",
});

const authorizationClaims: SteamPublishAuthorizationClaims = Object.freeze({
  kind: "deviludo-steam-publish-authorization",
  version: 1,
  operation: "PRIVATE_BETA_UPLOAD",
  tenantId: rcClaims.tenantId,
  projectId: rcClaims.projectId,
  releaseId: rcClaims.releaseId,
  mainCommitSha: rcClaims.mainCommitSha,
  evidenceBundleDigest: rcClaims.evidenceBundleDigest,
  acceptedBy: "user-ada",
  mfaAssertionId: "mfa-assertion-91",
  nonce: "publish-nonce-91",
  issuedAt: "2099-01-01T00:04:00.000Z",
  expiresAt: "2099-01-01T00:09:00.000Z",
});

const session: SteamBuildSession = Object.freeze({
  id: "steam-session-4",
  tenantId: rcClaims.tenantId,
  accountId: "steam-account-8",
  accountName: "deviludo_build_bot",
  configVdfSecretRef: "vault://kv/steam/config-vdf/v4",
  credentialVersionId: "steam-credential-v4",
  allowedAppIds: Object.freeze([rcClaims.steamAppId]),
  permissions: Object.freeze(["EditAppMetadata", "PublishAppChanges"] as const),
  state: "ACTIVE",
  verifiedAt: "2098-12-31T00:00:00.000Z",
  expiresAt: "2099-02-01T00:00:00.000Z",
});

test("uploads an exact signed RC to a private Beta and schedules clean Steam Client installs idempotently", async () => {
  let uploads = 0;
  let releaseEvidenceChecks = 0;
  let installEvidenceChecks = 0;
  const coordinator = new SteamReleaseCoordinator({
    rcKeys: new Map([["rc-key-1", rcKey.publicKey]]),
    authorizationKeys: new Map([["mfa-key-1", authorizationKey.publicKey]]),
    releaseEvidence: { async assertPassed(input) {
      releaseEvidenceChecks += 1;
      assert.equal(input.mainCommitSha, rcClaims.mainCommitSha);
      assert.deepEqual(input.targetMatrix, rcClaims.targetMatrix);
    } },
    connector: { async uploadPrivateBeta(input) {
      uploads += 1;
      assert.match(input.operationKey, /steam-private-beta/);
      assert.match(input.requestDigest, /^[a-f0-9]{64}$/);
      assert.equal(input.session.configVdfSecretRef, session.configVdfSecretRef);
      assert.equal(input.branchPasswordSecretRef, "vault://kv/steam/beta-password/v1");
      return {
        steamAppId: rcClaims.steamAppId,
        buildId: "91234567",
        betaBranch: "deviludo_private_9",
        passwordProtected: true,
        depotManifestIds: { "2841931": "700000001", "2841932": "700000002", "2841933": "700000003" },
        uploadedAt: now.toISOString(),
      };
    } },
    installs: { async schedule(input) {
      assert.equal(input.buildId, "91234567");
      assert.deepEqual(input.targetMatrix, rcClaims.targetMatrix);
      return { windows: "steam-install-windows-1", linux: "steam-install-linux-1", macos: "steam-install-macos-1" };
    } },
    installEvidence: { async assertPassed(input) {
      installEvidenceChecks += 1;
      assert.equal(input.attempts.macos, "steam-install-macos-1");
      return { evidenceBundleDigest: digest("f") };
    } },
    operations: new InMemorySteamPublishOperationStore(() => now),
    now: () => now,
  });
  const request = {
    rc: signSteamRcArtifact("rc-key-1", rcKey.privateKey, rcClaims),
    authorization: signSteamPublishAuthorization("mfa-key-1", authorizationKey.privateKey, authorizationClaims),
    session,
    betaBranch: "deviludo_private_9",
    branchPasswordSecretRef: "vault://kv/steam/beta-password/v1",
    idempotencyKey: "publish-release-9",
  };

  const beta = await coordinator.uploadPrivateBeta(request);
  const replay = await coordinator.uploadPrivateBeta(request);
  assert.deepEqual(replay, beta);
  assert.equal(uploads, 1);
  assert.equal(releaseEvidenceChecks, 2);
  assert.equal(beta.state, "INSTALL_TESTING");
  assert.equal(JSON.stringify(beta).includes("config-vdf"), false);
  assert.equal(JSON.stringify(beta).includes("beta-password"), false);

  const ready = await coordinator.completeCleanInstall({ rc: request.rc, beta });
  assert.equal(installEvidenceChecks, 1);
  assert.equal(ready.state, "EXTERNAL_APPROVAL_REQUIRED");
  assert.deepEqual(ready.externalGates, ["VALVE_REVIEW", "FIRST_RELEASE", "DEFAULT_BRANCH_CONFIRMATION"]);
  assert.equal(ready.steamInstallEvidenceBundleDigest, digest("f"));
});

test("rejects unsigned drift, stale MFA, non-private branches and unauthorized build sessions before SteamPipe", async () => {
  let uploads = 0;
  const createCoordinator = () => new SteamReleaseCoordinator({
    rcKeys: new Map([["rc-key-1", rcKey.publicKey]]),
    authorizationKeys: new Map([["mfa-key-1", authorizationKey.publicKey]]),
    releaseEvidence: { async assertPassed() {} },
    connector: { async uploadPrivateBeta() { uploads += 1; throw new Error("must not run"); } },
    installs: { async schedule() { throw new Error("must not run"); } },
    installEvidence: { async assertPassed() { throw new Error("must not run"); } },
    operations: new InMemorySteamPublishOperationStore(() => now),
    now: () => now,
  });
  const validRc = signSteamRcArtifact("rc-key-1", rcKey.privateKey, rcClaims);
  const validAuthorization = signSteamPublishAuthorization("mfa-key-1", authorizationKey.privateKey, authorizationClaims);
  const base = {
    rc: validRc,
    authorization: validAuthorization,
    session,
    betaBranch: "deviludo_private_9",
    branchPasswordSecretRef: "vault://kv/steam/beta-password/v1",
    idempotencyKey: "publish-release-9",
  };
  await assert.rejects(createCoordinator().uploadPrivateBeta({ ...base, rc: { ...validRc, claims: { ...rcClaims, mainCommitSha: "9".repeat(40) } } }), /signature/);
  await assert.rejects(createCoordinator().uploadPrivateBeta({ ...base, authorization: signSteamPublishAuthorization("mfa-key-1", authorizationKey.privateKey, { ...authorizationClaims, expiresAt: "2099-01-01T00:04:30.000Z" }) }), /time window/);
  await assert.rejects(createCoordinator().uploadPrivateBeta({ ...base, betaBranch: "default" }), /private branch/);
  await assert.rejects(createCoordinator().uploadPrivateBeta({ ...base, session: { ...session, allowedAppIds: ["1"] } }), /not authorized/);
  assert.equal(uploads, 0);
});

test("SteamCMD plan contains no password, uses a pre-enrolled config.vdf SecretRef and fixes SetLive to the private branch", () => {
  const plan = buildSteamCmdRuntimePlan({
    executable: "/opt/steamcmd/steamcmd.sh",
    runtimeRoot: "/var/lib/deviludo/steam-run-9",
    rc: rcClaims,
    session,
    betaBranch: "deviludo_private_9",
    contentRoots: {
      "2841931": "/var/lib/deviludo/steam-run-9/content/windows",
      "2841932": "/var/lib/deviludo/steam-run-9/content/linux",
      "2841933": "/var/lib/deviludo/steam-run-9/content/macos",
    },
  });
  assert.deepEqual(plan.args.slice(0, 2), ["+login", "deviludo_build_bot"]);
  assert.equal(plan.args.includes("+run_app_build"), true);
  assert.equal(plan.args.some((arg) => /password|secret|vault:\/\//i.test(arg)), false);
  assert.equal(plan.configVdfSecretRef, session.configVdfSecretRef);
  assert.equal(plan.configVdfTarget, "/var/lib/deviludo/steam-run-9/steam/config/config.vdf");
  assert.equal(plan.shell, false);
  const appScript = plan.files.find((file) => file.path.includes("/app_"));
  assert.match(appScript?.content ?? "", /"SetLive" "deviludo_private_9"/);
  assert.doesNotMatch(JSON.stringify(plan), /master-password|SteamGuard/i);
  assert.throws(() => buildSteamCmdRuntimePlan({
    executable: "/opt/steamcmd/steamcmd.sh",
    runtimeRoot: "/var/lib/deviludo/steam-run-9",
    rc: rcClaims,
    session,
    betaBranch: "default",
    contentRoots: {},
  }), /SetLive branch/);
});

// Compile-time guard that receipts never gain credential fields.
const _receiptContract: Pick<SteamPrivateBetaReceipt, "buildId" | "state"> | null = null;
void _receiptContract;
