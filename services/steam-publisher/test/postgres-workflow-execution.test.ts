import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresQueryResult, PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import type { SteamPrivateBetaReceipt } from "../src/contracts";
import {
  PostgresSteamBuildReceiptArchive,
  PostgresSteamDefaultBranchReceiptArchive,
  PostgresSteamWorkflowExecutionAuthority,
} from "../src/postgres-workflow-execution";
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
const sessionId = "77777777-7777-4777-8777-777777777777";
const credentialVersionId = "88888888-8888-4888-8888-888888888888";
const buildReceiptId = "99999999-9999-4999-8999-999999999999";
const defaultReceiptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operationKey = "workflow-job:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const requestDigest = "a".repeat(64);
const mainCommitSha = "b".repeat(40);
const sourceDigest = "c".repeat(64);
const evidenceDigest = "d".repeat(64);
const installEvidenceDigest = "e".repeat(64);
const steamAppId = "2841930";
const buildId = "91234567";
const approvals = ["valve-approval-1", "first-release-1", "default-confirm-1"] as const;
const uploadRequest: SteamPrivateBetaOperationRequest = Object.freeze({
  schemaVersion: "deviludo.steam-workflow.v1", kind: "PRIVATE_BETA_UPLOAD",
  operationKey, requestDigest, tenantId, projectId, workflowId: "delivery-001", runId,
  mainCommitSha, mainEvidenceBundleId: evidenceId, mfaApprovalId: mfaId,
  targetMatrix: Object.freeze(["linux"] as const),
});
const publishRequest: SteamDefaultBranchOperationRequest = Object.freeze({
  schemaVersion: "deviludo.steam-workflow.v1", kind: "DEFAULT_BRANCH_PUBLISH",
  operationKey, requestDigest, tenantId, projectId, workflowId: "delivery-001", runId,
  betaBuildId: buildId, externalApprovalIds: Object.freeze(approvals),
});
const rc = Object.freeze({
  keyId: "steam-rc-key-1",
  claims: Object.freeze({
    kind: "deviludo-steam-rc" as const, version: 2 as const, tenantId, projectId, releaseId,
    mainCommitSha, sourceDigest, specRevisionId: defaultReceiptId,
    specDigest: "1".repeat(64), testPlanDigest: "2".repeat(64), evidenceBundleDigest: evidenceDigest,
    steamAppId, targetMatrix: uploadRequest.targetMatrix,
    depots: Object.freeze([{ depotId: "2841931", platform: "linux" as const, objectRef: "s3://rc/linux.signed",
      sourceArtifactDigest: "3".repeat(64), artifactDigest: "4".repeat(64), sizeBytes: 1024,
      signingScheme: "LINUX_SIGSTORE" as const, signingIdentityDigest: "5".repeat(64),
      signingEvidenceRef: "s3://rc/linux.signing.json", signingEvidenceDigest: "6".repeat(64),
      notarizationEvidenceRef: null, notarizationEvidenceDigest: null }]),
    issuedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-01T01:00:00.000Z",
  }),
  signature: "s".repeat(86),
});
const authorization = Object.freeze({
  keyId: "steam-auth-key-1",
  claims: Object.freeze({
    kind: "deviludo-steam-publish-authorization" as const, version: 1 as const,
    operation: "PRIVATE_BETA_UPLOAD" as const, tenantId, projectId, releaseId,
    mainCommitSha, evidenceBundleDigest: evidenceDigest, acceptedBy: "user-001",
    mfaAssertionId: "aal2-assertion-001", nonce: mfaId,
    issuedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:10:00.000Z",
  }),
  signature: "signed-authorization",
});
const sessionColumns = Object.freeze({
  session_id: sessionId, session_tenant_id: tenantId, account_id: "build-account-001",
  account_name: "deviludo_build", config_vdf_secret_ref: "vault://steam/config-vdf/versions/3",
  credential_version_id: credentialVersionId, allowed_app_ids: [steamAppId],
  permissions: ["EditAppMetadata", "PublishAppChanges"], session_state: "ACTIVE",
  verified_at: "2030-01-01T00:00:00.000Z", expires_at: "2030-02-01T00:00:00.000Z",
});
const uploadRow = {
  release_id: releaseId, release_state: "STEAM_PRIVATE_BETA", release_main_commit_sha: mainCommitSha,
  release_steam_app_id: steamAppId, beta_branch: "deviludo_private_9",
  branch_password_secret_ref: "vault://steam/beta-branch/versions/1",
  rc_run_id: runId, rc_evidence_bundle_id: evidenceId, rc_artifact_digest: sha256Canonical(rc), signed_rc: rc,
  evidence_status: "PASSED", evidence_invalidated_at: null, evidence_bundle_digest: evidenceDigest,
  approval_id: mfaId, authorization_state: "DISPATCHED", authorization_workflow_id: uploadRequest.workflowId,
  authorization_main_commit_sha: mainCommitSha, authorization_evidence_bundle_digest: evidenceDigest,
  signed_authorization: authorization, ...sessionColumns,
};
const publishRow = {
  release_id: releaseId, release_state: "READY_TO_PUBLISH", steam_app_id: steamAppId,
  build_receipt_id: buildReceiptId, build_id: buildId, build_state: "EXTERNAL_APPROVAL_REQUIRED",
  steam_install_evidence_bundle_digest: installEvidenceDigest, main_run_id: runId,
  external_approvals: [
    { gate: "VALVE_REVIEW", approvalId: approvals[0] },
    { gate: "FIRST_RELEASE", approvalId: approvals[1] },
    { gate: "DEFAULT_BRANCH_CONFIRMATION", approvalId: approvals[2] },
  ],
  ...sessionColumns,
};
const privateBetaReceipt: SteamPrivateBetaReceipt = Object.freeze({
  tenantId, projectId, releaseId, steamAppId, buildId, mainCommitSha, sourceDigest,
  evidenceBundleDigest: evidenceDigest, betaBranch: "deviludo_private_9",
  depotManifestIds: Object.freeze({ "2841931": "81234567" }),
  installAttempts: Object.freeze({ linux: "install-linux-001" }) as never,
  state: "INSTALL_TESTING", uploadedAt: "2030-01-01T00:02:00.000Z",
});

class Client implements PostgresWorkflowClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  authorityUpload: Omit<typeof uploadRow, "evidence_invalidated_at"> & { evidence_invalidated_at: string | null } = uploadRow;
  authorityPublish = publishRow;
  buildRow: Record<string, unknown> | null = null;
  publicationRow: Record<string, unknown> | null = null;
  lifecycleState = "STEAM_PRIVATE_BETA";
  lifecycleGate = "NONE";
  releases = 0;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ text, values });
    if (text.includes("FROM deviludo.steam_rc_artifacts")) return result([this.authorityUpload] as unknown as Row[]);
    if (text.includes("FROM deviludo.steam_build_receipts build")) return result([this.authorityPublish] as unknown as Row[]);
    if (text.includes("INSERT INTO deviludo.steam_build_receipts")) {
      if (!this.buildRow) this.buildRow = {
        id: String(values[0]), tenant_id: String(values[1]), project_id: String(values[2]), release_id: String(values[3]),
        steam_app_id: String(values[4]), build_id: String(values[5]), main_commit_sha: String(values[6]),
        source_digest: String(values[7]), evidence_bundle_digest: String(values[8]), beta_branch: String(values[9]),
        depot_manifest_ids: JSON.parse(String(values[10])), install_attempts: JSON.parse(String(values[11])),
        state: "INSTALL_TESTING", uploaded_at: String(values[12]),
      };
      return result([], 1);
    }
    if (text.includes("FROM deviludo.steam_build_receipts") && !text.includes("steam_build_receipts build")) {
      return this.buildRow ? result([this.buildRow] as Row[]) : result([]);
    }
    if (text.includes("INSERT INTO deviludo.steam_default_branch_receipts")) {
      if (!this.publicationRow) this.publicationRow = {
        id: String(values[0]), tenant_id: String(values[1]), project_id: String(values[2]), run_id: String(values[3]),
        release_id: String(values[4]), build_receipt_id: String(values[5]), operation_key: String(values[6]),
        request_digest: String(values[7]), steam_app_id: String(values[8]), beta_build_id: String(values[9]),
        default_branch_build_id: String(values[10]), steam_install_evidence_bundle_digest: String(values[11]),
        external_approval_ids: values[12] as string[], receipt: JSON.parse(String(values[13])), published_at: String(values[14]),
      };
      return result([], 1);
    }
    if (text.includes("FROM deviludo.steam_default_branch_receipts")) {
      return this.publicationRow ? result([this.publicationRow] as Row[]) : result([]);
    }
    if (text.includes("UPDATE deviludo.steam_releases") && text.includes("'INSTALL_TESTING'")) {
      if (this.lifecycleState === "STEAM_PRIVATE_BETA") this.lifecycleState = "INSTALL_TESTING";
      return result([]);
    }
    if (text.includes("UPDATE deviludo.steam_releases") && text.includes("'RELEASED'")) {
      if (this.lifecycleState === "READY_TO_PUBLISH") this.lifecycleState = "RELEASED";
      return result([]);
    }
    if (text.includes("FROM deviludo.steam_releases")) {
      return result([{ id: releaseId, state: this.lifecycleState, external_gate: this.lifecycleGate }] as unknown as Row[]);
    }
    return result([]);
  }

  release(): void { this.releases += 1; }
}

function pool(client: Client) { return { async connect() { return client; } }; }

test("PostgreSQL Steam execution authority joins one signed RC, MFA authorization and active session under RLS", async () => {
  const client = new Client();
  const authority = new PostgresSteamWorkflowExecutionAuthority(pool(client));
  const resolved = await authority.resolvePrivateBeta(uploadRequest);
  assert.equal(resolved.state, "AUTHORIZED");
  assert.equal(resolved.rc.claims.releaseId, releaseId);
  assert.equal(resolved.authorization.claims.nonce, mfaId);
  assert.equal(resolved.session.configVdfSecretRef, sessionColumns.config_vdf_secret_ref);
  assert.ok(client.calls.some((call) => call.text.includes("set_config('app.tenant_id'")));
  assert.match(client.calls.find((call) => call.text.includes("steam_rc_artifacts"))!.text, /authorization\.state = 'DISPATCHED'/);
  assert.doesNotMatch(JSON.stringify(resolved), /accountPassword|guardCode|configVdfBytes/i);

  client.authorityUpload = { ...uploadRow, evidence_invalidated_at: "2030-01-01T00:03:00.000Z" };
  await assert.rejects(authority.resolvePrivateBeta(uploadRequest), /authority is invalid/);
  assert.equal(client.calls.at(-1)?.text, "ROLLBACK");
});

test("PostgreSQL Steam execution authority requires the ordered three approvals for the same tested BuildID", async () => {
  const client = new Client();
  const authority = new PostgresSteamWorkflowExecutionAuthority(pool(client));
  const resolved = await authority.resolveDefaultBranch(publishRequest);
  assert.equal(resolved.state, "READY_TO_PUBLISH");
  assert.equal(resolved.betaBuildId, buildId);
  assert.deepEqual(resolved.externalApprovals.map((entry) => entry.approvalId), approvals);
  const query = client.calls.find((call) => call.text.includes("workflow_external_approval_receipts"))!.text;
  assert.match(query, /build\.state = 'EXTERNAL_APPROVAL_REQUIRED'/);
  assert.match(query, /release\.state = 'READY_TO_PUBLISH'/);

  client.authorityPublish = { ...publishRow, external_approvals: [
    publishRow.external_approvals[1], publishRow.external_approvals[0], publishRow.external_approvals[2],
  ] };
  await assert.rejects(authority.resolveDefaultBranch(publishRequest), /authority is invalid/);
});

test("PostgreSQL Steam archives replay only an identical private-Beta and default-branch receipt", async () => {
  const client = new Client();
  const builds = new PostgresSteamBuildReceiptArchive(pool(client), () => buildReceiptId);
  assert.deepEqual(await builds.persist({ operationKey, requestDigest, receipt: privateBetaReceipt }), { receiptId: buildReceiptId });
  assert.deepEqual(await builds.persist({ operationKey, requestDigest, receipt: privateBetaReceipt }), { receiptId: buildReceiptId });
  assert.equal(client.lifecycleState, "INSTALL_TESTING");
  assert.match(client.calls.find((call) => call.text.includes("INSERT INTO deviludo.steam_build_receipts"))!.text, /ON CONFLICT \(release_id\) DO NOTHING/);

  const publications = new PostgresSteamDefaultBranchReceiptArchive(pool(client), () => defaultReceiptId);
  const publication = {
    operationKey, requestDigest, tenantId, projectId, releaseId, runId, steamAppId,
    buildReceiptId, betaBuildId: buildId, defaultBranchBuildId: buildId,
    steamInstallEvidenceBundleDigest: installEvidenceDigest,
    externalApprovalIds: approvals, publishedAt: "2030-01-02T00:00:00.000Z",
  };
  client.lifecycleState = "READY_TO_PUBLISH";
  assert.deepEqual(await publications.persist(publication), { receiptId: defaultReceiptId });
  assert.deepEqual(await publications.persist(publication), { receiptId: defaultReceiptId });
  assert.equal(client.lifecycleState, "RELEASED");
  assert.match(client.calls.find((call) => call.text.includes("INSERT INTO deviludo.steam_default_branch_receipts"))!.text, /ON CONFLICT \(tenant_id, release_id\) DO NOTHING/);
  assert.doesNotMatch(JSON.stringify(client.calls), /config\.vdf|password|steam.?guard/i);

  await assert.rejects(publications.persist({ ...publication, defaultBranchBuildId: "99999999" }), /authority is invalid/);
});

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): PostgresQueryResult<Row> {
  return { rows, rowCount };
}
