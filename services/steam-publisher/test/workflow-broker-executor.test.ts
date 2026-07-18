import assert from "node:assert/strict";
import test from "node:test";
import type { SteamPrivateBetaReceipt } from "../src/contracts";
import {
  AuthoritativeSteamWorkflowExecutor,
  type SteamDefaultBranchExecutionAuthority,
  type SteamPrivateBetaExecutionAuthority,
} from "../src/workflow-broker-executor";
import type {
  SteamDefaultBranchOperationRequest,
  SteamPrivateBetaOperationRequest,
} from "../src/workflow-broker-http";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const releaseId = "44444444-4444-4444-8444-444444444444";
const evidenceId = "55555555-5555-4555-8555-555555555555";
const mfaId = "66666666-6666-4666-8666-666666666666";
const buildReceiptId = "77777777-7777-4777-8777-777777777777";
const workflowReceiptId = "88888888-8888-4888-8888-888888888888";
const publicationReceiptId = "99999999-9999-4999-8999-999999999999";
const operationKey = "workflow-job:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requestDigest = "a".repeat(64);
const mainCommitSha = "b".repeat(40);
const sourceDigest = "c".repeat(64);
const evidenceDigest = "d".repeat(64);
const installEvidenceDigest = "e".repeat(64);
const buildId = "91234567";
const steamAppId = "2841930";
const approvals = Object.freeze(["valve-approval-1", "first-release-1", "default-confirm-1"] as const);
const session = Object.freeze({
  id: "steam-session-001", tenantId, accountId: "build-account-001", accountName: "deviludo_build",
  configVdfSecretRef: "vault://steam/config-vdf/versions/3", credentialVersionId: buildReceiptId,
  allowedAppIds: Object.freeze([steamAppId]),
  permissions: Object.freeze(["EditAppMetadata", "PublishAppChanges"] as const),
  state: "ACTIVE" as const, verifiedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-02-01T00:00:00.000Z",
});
const uploadRequest: SteamPrivateBetaOperationRequest = Object.freeze({
  schemaVersion: "deviludo.steam-workflow.v1", kind: "PRIVATE_BETA_UPLOAD",
  operationKey, requestDigest, tenantId, projectId, workflowId: "delivery-001", runId,
  mainCommitSha, mainEvidenceBundleId: evidenceId, mfaApprovalId: mfaId,
  targetMatrix: Object.freeze(["linux", "windows"] as const),
});
const rcClaims = Object.freeze({
  kind: "deviludo-steam-rc" as const, version: 1 as const, tenantId, projectId, releaseId,
  mainCommitSha, sourceDigest, specRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  specDigest: "1".repeat(64), testPlanDigest: "2".repeat(64), evidenceBundleDigest: evidenceDigest,
  steamAppId, targetMatrix: uploadRequest.targetMatrix,
  depots: Object.freeze([
    { depotId: "2841931", platform: "linux" as const, objectRef: "s3://rc/linux.tar", artifactDigest: "3".repeat(64), sizeBytes: 1_024 },
    { depotId: "2841932", platform: "windows" as const, objectRef: "s3://rc/windows.zip", artifactDigest: "4".repeat(64), sizeBytes: 2_048 },
  ]),
  issuedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-01T01:00:00.000Z",
});
const uploadAuthority: SteamPrivateBetaExecutionAuthority = Object.freeze({
  state: "AUTHORIZED", runId, mainEvidenceBundleId: evidenceId, mfaApprovalId: mfaId,
  targetMatrix: uploadRequest.targetMatrix,
  rc: Object.freeze({ keyId: "steam-rc-key-1", claims: rcClaims, signature: "signed-rc" }),
  authorization: Object.freeze({ keyId: "steam-auth-key-1", claims: Object.freeze({
    kind: "deviludo-steam-publish-authorization" as const, version: 1 as const,
    operation: "PRIVATE_BETA_UPLOAD" as const, tenantId, projectId, releaseId,
    mainCommitSha, evidenceBundleDigest: evidenceDigest, acceptedBy: "user-001",
    mfaAssertionId: "aal2-assertion-001", nonce: mfaId,
    issuedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:10:00.000Z",
  }), signature: "signed-authorization" }),
  session,
  betaBranch: "deviludo_private_9",
  branchPasswordSecretRef: "vault://steam/beta-branch/versions/1",
});
const domainReceipt: SteamPrivateBetaReceipt = Object.freeze({
  tenantId, projectId, releaseId, steamAppId, mainCommitSha, sourceDigest,
  evidenceBundleDigest: evidenceDigest, buildId, betaBranch: uploadAuthority.betaBranch,
  depotManifestIds: Object.freeze({ "2841931": "81234567", "2841932": "81234568" }),
  installAttempts: Object.freeze({ linux: "install-linux-1", windows: "install-windows-1" }) as never,
  state: "INSTALL_TESTING", uploadedAt: "2030-01-01T00:02:00.000Z",
});
const publishRequest: SteamDefaultBranchOperationRequest = Object.freeze({
  schemaVersion: "deviludo.steam-workflow.v1", kind: "DEFAULT_BRANCH_PUBLISH",
  operationKey, requestDigest, tenantId, projectId, workflowId: "delivery-001", runId,
  betaBuildId: buildId, externalApprovalIds: approvals,
});
const publishAuthority: SteamDefaultBranchExecutionAuthority = Object.freeze({
  state: "READY_TO_PUBLISH", tenantId, projectId, releaseId, runId, steamAppId,
  betaBuildId: buildId, buildReceiptId, steamInstallEvidenceBundleDigest: installEvidenceDigest, session,
  externalApprovals: Object.freeze([
    Object.freeze({ gate: "VALVE_REVIEW", approvalId: approvals[0] }),
    Object.freeze({ gate: "FIRST_RELEASE", approvalId: approvals[1] }),
    Object.freeze({ gate: "DEFAULT_BRANCH_CONFIRMATION", approvalId: approvals[2] }),
  ] as const),
});

function executor(options: {
  preparedRc?: SteamPrivateBetaExecutionAuthority["rc"];
  uploadAuthority?: SteamPrivateBetaExecutionAuthority;
  publishAuthority?: SteamDefaultBranchExecutionAuthority;
  promotedBuildId?: string;
  events?: string[];
}) {
  const events = options.events ?? [];
  return new AuthoritativeSteamWorkflowExecutor({
    async ensure() { events.push("prepare-rc"); return options.preparedRc ?? uploadAuthority.rc; },
    async probe() { events.push("rc-preparer-probe"); },
  }, {
    async resolvePrivateBeta() { events.push("resolve-upload"); return options.uploadAuthority ?? uploadAuthority; },
    async resolveDefaultBranch() { events.push("resolve-publish"); return options.publishAuthority ?? publishAuthority; },
    async probe() { events.push("authority-probe"); },
  }, {
    async uploadPrivateBeta(input) {
      events.push("upload");
      assert.equal(input.rc, uploadAuthority.rc);
      assert.equal(input.authorization, uploadAuthority.authorization);
      assert.equal(input.idempotencyKey, operationKey);
      return domainReceipt;
    },
  }, {
    async persist(input) {
      events.push("archive-build");
      assert.deepEqual(input.receipt, domainReceipt);
      return { receiptId: workflowReceiptId };
    },
    async probe() { events.push("build-probe"); },
  }, {
    async promote(input) {
      events.push("promote");
      assert.equal(input.betaBuildId, buildId);
      assert.deepEqual(input.externalApprovalIds, approvals);
      return {
        releaseId, steamAppId, betaBuildId: buildId,
        defaultBranchBuildId: options.promotedBuildId ?? buildId,
        publishedAt: "2030-01-02T00:00:00.000Z",
      };
    },
    async probe() { events.push("connector-probe"); },
  }, {
    async persist(input) {
      events.push("archive-publication");
      assert.equal(input.defaultBranchBuildId, buildId);
      return { receiptId: publicationReceiptId };
    },
    async probe() { events.push("publication-probe"); },
  });
}

test("authoritative Steam executor resolves, uploads and archives the exact approved private Beta", async () => {
  const events: string[] = [];
  let heartbeats = 0;
  const result = await executor({ events }).execute(uploadRequest, { async heartbeat() { heartbeats += 1; } });
  assert.deepEqual(result, {
    receiptId: workflowReceiptId, runId, mainCommitSha, mainEvidenceBundleId: evidenceId,
    mfaApprovalId: mfaId, targetMatrix: ["linux", "windows"], buildId,
  });
  assert.deepEqual(events, ["prepare-rc", "resolve-upload", "upload", "archive-build"]);
  assert.equal(heartbeats, 4);
});

test("authoritative Steam executor promotes and archives only the clean-install-tested BuildID", async () => {
  const events: string[] = [];
  const result = await executor({ events }).execute(publishRequest, { async heartbeat() {} });
  assert.deepEqual(result, {
    receiptId: publicationReceiptId, releaseId, runId, betaBuildId: buildId,
    defaultBranchBuildId: buildId, externalApprovalIds: approvals,
  });
  assert.deepEqual(events, ["resolve-publish", "promote", "archive-publication"]);

  const driftedEvents: string[] = [];
  await assert.rejects(
    executor({ events: driftedEvents, promotedBuildId: "99999999" }).execute(publishRequest, { async heartbeat() {} }),
    /execution is invalid/,
  );
  assert.deepEqual(driftedEvents, ["resolve-publish", "promote"]);
});

test("authoritative Steam executor rejects authority drift before any irreversible connector call", async () => {
  const events: string[] = [];
  await assert.rejects(executor({
    events,
    uploadAuthority: { ...uploadAuthority, rc: { ...uploadAuthority.rc, claims: { ...rcClaims, mainCommitSha: "f".repeat(40) } } },
  }).execute(uploadRequest, { async heartbeat() {} }), /execution is invalid/);
  assert.deepEqual(events, ["prepare-rc", "resolve-upload"]);

  const preparedDriftEvents: string[] = [];
  await assert.rejects(executor({
    events: preparedDriftEvents,
    preparedRc: { ...uploadAuthority.rc, signature: "different-signed-rc" },
  }).execute(uploadRequest, { async heartbeat() {} }), /execution is invalid/);
  assert.deepEqual(preparedDriftEvents, ["prepare-rc", "resolve-upload"]);

  const publishEvents: string[] = [];
  await assert.rejects(executor({
    events: publishEvents,
    publishAuthority: { ...publishAuthority, externalApprovals: [
      publishAuthority.externalApprovals[1],
      publishAuthority.externalApprovals[0],
      publishAuthority.externalApprovals[2],
    ] as never },
  }).execute(publishRequest, { async heartbeat() {} }), /execution is invalid/);
  assert.deepEqual(publishEvents, ["resolve-publish"]);
});

test("authoritative Steam executor readiness includes every authority and archive dependency", async () => {
  const events: string[] = [];
  await executor({ events }).probe();
  assert.deepEqual(events.sort(), ["rc-preparer-probe", "authority-probe", "build-probe", "connector-probe", "publication-probe"].sort());
});
