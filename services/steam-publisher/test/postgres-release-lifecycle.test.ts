import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresQueryResult, PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import {
  PostgresReleaseSnapshotResolver,
  PostgresSteamPrivateBetaReleasePreparer,
  PostgresSteamReleasePreparation,
} from "../src/postgres-release-lifecycle";
import type { SteamPrivateBetaOperationRequest } from "../src/workflow-broker-http";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const evidenceId = "44444444-4444-4444-8444-444444444444";
const releaseId = "55555555-5555-4555-8555-555555555555";
const configurationId = "66666666-6666-4666-8666-666666666666";
const sessionId = "77777777-7777-4777-8777-777777777777";
const depotConfigurationId = "88888888-8888-4888-8888-888888888888";
const mfaId = "99999999-9999-4999-8999-999999999999";
const workflowId = "delivery-release-001";
const mainCommitSha = "a".repeat(40);
const evidenceBundleDigest = "b".repeat(64);
const steamAppId = "2841930";
const targetMatrix = Object.freeze(["linux", "windows"] as const);
const betaBranch = "deviludo_private_9";
const branchSecretRef = "vault://steam/beta-branch/versions/4";
const sessionSecretRef = "vault://steam/config-vdf/versions/7";
const configurationDigest = sha256Canonical({
  schemaVersion: "deviludo.steam-release-configuration.v1",
  steamAppId,
  steamBuildSessionId: sessionId,
  depotConfigurationId,
  betaBranch,
  branchPasswordSecretRef: branchSecretRef,
});
const preparationInput = Object.freeze({
  tenantId,
  projectId,
  workflowId,
  runId,
  mainCommitSha,
  mainEvidenceBundleId: evidenceId,
  targetMatrix,
});
const privateBetaRequest: SteamPrivateBetaOperationRequest = Object.freeze({
  schemaVersion: "deviludo.steam-workflow.v1",
  kind: "PRIVATE_BETA_UPLOAD",
  operationKey: "workflow-job:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  requestDigest: "c".repeat(64),
  tenantId,
  projectId,
  workflowId,
  runId,
  mainCommitSha,
  mainEvidenceBundleId: evidenceId,
  mfaApprovalId: mfaId,
  targetMatrix,
});
const preparationAuthorityRow = Object.freeze({
  evidence_id: evidenceId,
  evidence_status: "PASSED",
  evidence_invalidated_at: null,
  evidence_commit_sha: mainCommitSha,
  evidence_bundle_digest: evidenceBundleDigest,
  attempt_run_id: runId,
  attempt_mode: "MAIN_RELEASE_GATE",
  attempt_state: "PASSED",
  attempt_target_matrix: targetMatrix,
  project_steam_app_id: steamAppId,
  configuration_id: configurationId,
  configuration_steam_app_id: steamAppId,
  configuration_session_id: sessionId,
  configuration_depot_id: depotConfigurationId,
  configuration_beta_branch: betaBranch,
  configuration_branch_password_secret_ref: branchSecretRef,
  configuration_digest: configurationDigest,
  configuration_state: "ACTIVE",
  session_config_vdf_secret_ref: sessionSecretRef,
  session_allowed_app_ids: [steamAppId],
  session_permissions: ["EditAppMetadata", "PublishAppChanges"],
  session_state: "ACTIVE",
  session_expires_at: "2030-02-01T00:00:00.000Z",
  depot_steam_app_id: steamAppId,
  depot_platform_depots: { linux: "2841931", windows: "2841932" },
  depot_state: "ACTIVE",
});

class Client implements PostgresWorkflowClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  preparationAuthority: Record<string, unknown> = preparationAuthorityRow;
  releaseRow: Record<string, unknown> | null = null;
  releaseAuthorizationAllowed = true;
  releases = 0;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ text, values });
    if (text.includes("FROM deviludo.evidence_bundles evidence")
      && text.includes("steam_project_release_configurations configuration")) {
      return result([this.preparationAuthority] as Row[]);
    }
    if (text.includes("INSERT INTO deviludo.steam_releases")) {
      if (!this.releaseRow) this.releaseRow = releaseFromInsert(values);
      return result([], 1);
    }
    if (text.includes("JOIN deviludo.workflow_control_actions action")) {
      return this.releaseRow && this.releaseAuthorizationAllowed ? result([{
        ...this.releaseRow,
        evidence_bundle_digest: evidenceBundleDigest,
        evidence_status: "PASSED",
        evidence_invalidated_at: null,
        attempt_mode: "MAIN_RELEASE_GATE",
        attempt_state: "PASSED",
        action_status: "WAITING",
        action_binding: {
          state: "WAITING_MFA",
          releaseId,
          mainCommitSha,
          evidenceBundleId: evidenceId,
        },
      }] as unknown as Row[]) : result([]);
    }
    if (text.includes("JOIN deviludo.steam_release_authorizations authorization")) {
      return this.releaseRow ? result([{
        ...this.releaseRow,
        evidence_bundle_digest: evidenceBundleDigest,
        authorization_state: "DISPATCHED",
        authorization_workflow_id: workflowId,
        authorization_main_commit_sha: mainCommitSha,
        authorization_evidence_bundle_digest: evidenceBundleDigest,
      }] as unknown as Row[]) : result([]);
    }
    if (text.includes("UPDATE deviludo.steam_releases")) {
      if (this.releaseRow?.state === "WAITING_MFA" && this.releaseRow.mfa_approval_id === null) {
        this.releaseRow = { ...this.releaseRow, state: "STEAM_PRIVATE_BETA", mfa_approval_id: String(values[2]), version: 2 };
        return result([{ id: releaseId }] as unknown as Row[], 1);
      }
      return result([]);
    }
    if (text.includes("FROM deviludo.steam_releases") && text.includes("workflow_id = $2")) {
      return this.releaseRow?.workflow_id === values[1] ? result([this.releaseRow] as Row[]) : result([]);
    }
    if (text === "SELECT 1 AS ready") return result([{ ready: 1 }] as unknown as Row[]);
    return result([]);
  }

  release(): void { this.releases += 1; }
}

function pool(client: Client) { return { async connect() { return client; } }; }

test("PostgreSQL release preparation freezes passed main evidence and one active project configuration idempotently", async () => {
  const client = new Client();
  const preparation = new PostgresSteamReleasePreparation(pool(client), {
    releaseId: () => releaseId,
    now: () => new Date("2030-01-01T00:00:00.000Z"),
  });
  const first = await preparation.ensure(preparationInput);
  const replay = await preparation.ensure(preparationInput);
  assert.deepEqual(first, {
    releaseId,
    workflowId,
    runId,
    mainCommitSha,
    mainEvidenceBundleId: evidenceId,
    releaseConfigurationId: configurationId,
    targetMatrix: ["linux", "windows"],
    state: "WAITING_MFA",
  });
  assert.deepEqual(replay, first);
  assert.equal(client.calls.filter((call) => call.text.includes("steam_project_release_configurations configuration")).length, 1);
  const authorityQuery = client.calls.find((call) => call.text.includes("steam_project_release_configurations configuration"))!;
  assert.match(authorityQuery.text, /attempt\.mode = 'MAIN_RELEASE_GATE'/);
  assert.match(authorityQuery.text, /session\.state = 'ACTIVE'/);
  assert.match(authorityQuery.text, /depot\.state = 'ACTIVE'/);
  assert.ok(client.calls.some((call) => call.text.includes("set_config('app.tenant_id'")));
  assert.doesNotMatch(JSON.stringify(client.calls), /accountPassword|guardCode|configVdfBytes/i);

  client.preparationAuthority = { ...preparationAuthorityRow, configuration_digest: "f".repeat(64) };
  await assert.rejects(preparation.ensure({ ...preparationInput, workflowId: "delivery-release-002" }), /release lifecycle is invalid/);
  assert.equal(client.calls.at(-1)?.text, "ROLLBACK");
});

test("PostgreSQL release snapshot resolver admits only the exact still-waiting MFA action", async () => {
  const client = new Client();
  client.releaseRow = releaseFromInsert([
    releaseId, tenantId, projectId, workflowId, runId, configurationId,
    mainCommitSha, evidenceId, steamAppId, sessionSecretRef, betaBranch,
    branchSecretRef, targetMatrix, "2030-01-01T00:00:00.000Z",
  ]);
  const resolver = new PostgresReleaseSnapshotResolver(pool(client));
  const snapshot = await resolver.resolveForMfa({ tenantId, releaseId, requestedBy: "user-ada" });
  assert.deepEqual(snapshot, {
    tenantId,
    projectId,
    releaseId,
    workflowId,
    acceptedBy: "user-ada",
    state: "WAITING_MFA",
    mainCommitSha,
    evidenceBundleDigest,
  });
  const query = client.calls.find((call) => call.text.includes("workflow_control_actions action"))!;
  assert.match(query.text, /action\.operation = 'REQUEST_FRESH_MFA'/);
  assert.match(query.text, /action\.status = 'WAITING'/);
  assert.match(query.text, /membership\.role IN \('TenantAdmin', 'ProjectOwner'\)/);
  assert.match(query.text, /membership\.status = 'ACTIVE'/);
  assert.match(query.text, /acceptance\.actor_id = requester\.id::text/);
  assert.match(query.text, /acceptance\.state = 'COMPLETED'/);
  assert.deepEqual(query.values, [tenantId, releaseId, "user-ada"]);

  client.releaseAuthorizationAllowed = false;
  await assert.rejects(resolver.resolveForMfa({ tenantId, releaseId, requestedBy: "user-auditor" }), /release lifecycle is invalid/);
  client.releaseAuthorizationAllowed = true;

  client.releaseRow = { ...client.releaseRow, state: "STEAM_PRIVATE_BETA", mfa_approval_id: mfaId };
  await assert.rejects(resolver.resolveForMfa({ tenantId, releaseId, requestedBy: "user-ada" }), /release lifecycle is invalid/);
});

test("PostgreSQL private-Beta preparation binds one dispatched MFA approval before RC issuance", async () => {
  const client = new Client();
  client.releaseRow = releaseFromInsert([
    releaseId, tenantId, projectId, workflowId, runId, configurationId,
    mainCommitSha, evidenceId, steamAppId, sessionSecretRef, betaBranch,
    branchSecretRef, targetMatrix, "2030-01-01T00:00:00.000Z",
  ]);
  const preparer = new PostgresSteamPrivateBetaReleasePreparer(pool(client));
  await preparer.prepare(privateBetaRequest);
  await preparer.prepare(privateBetaRequest);
  assert.equal(client.releaseRow.state, "STEAM_PRIVATE_BETA");
  assert.equal(client.releaseRow.mfa_approval_id, mfaId);
  assert.equal(client.releaseRow.version, 2);
  assert.equal(client.calls.filter((call) => call.text.includes("UPDATE deviludo.steam_releases")).length, 1);
  const authorityQuery = client.calls.find((call) => call.text.includes("steam_release_authorizations authorization"))!;
  assert.match(authorityQuery.text, /authorization\.state = 'DISPATCHED'/);
  assert.match(authorityQuery.text, /FOR UPDATE OF release/);

  client.releaseRow = { ...client.releaseRow, mfa_approval_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  await assert.rejects(preparer.prepare(privateBetaRequest), /release lifecycle is invalid/);
});

function releaseFromInsert(values: readonly unknown[]): Record<string, unknown> {
  return {
    id: String(values[0]),
    tenant_id: String(values[1]),
    project_id: String(values[2]),
    workflow_id: String(values[3]),
    run_id: String(values[4]),
    release_configuration_id: String(values[5]),
    main_commit_sha: String(values[6]),
    evidence_bundle_id: String(values[7]),
    steam_app_id: String(values[8]),
    steam_session_secret_ref: String(values[9]),
    mfa_approval_id: null,
    beta_branch: String(values[10]),
    branch_password_secret_ref: String(values[11]),
    target_matrix: values[12],
    state: "WAITING_MFA",
    external_gate: "NONE",
    version: 1,
    created_at: String(values[13]),
  };
}

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): PostgresQueryResult<Row> {
  return { rows, rowCount };
}
