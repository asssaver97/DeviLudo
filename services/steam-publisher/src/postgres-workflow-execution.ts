import { randomUUID } from "node:crypto";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type {
  SignedSteamPublishAuthorization,
  SignedSteamRcArtifact,
  SteamBuildSession,
  SteamPrivateBetaReceipt,
  SteamTargetPlatform,
} from "./contracts";
import type {
  SteamBuildReceiptArchive,
  SteamDefaultBranchExecutionAuthority,
  SteamDefaultBranchReceiptArchive,
  SteamPrivateBetaExecutionAuthority,
  SteamWorkflowExecutionAuthority,
} from "./workflow-broker-executor";
import type {
  SteamDefaultBranchOperationRequest,
  SteamPrivateBetaOperationRequest,
} from "./workflow-broker-http";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const BRANCH = /^[a-z0-9][a-z0-9_-]{2,39}$/;
const SECRET_REF = /^vault:\/\/[A-Za-z0-9._~:/-]{2,500}$/;

type UploadAuthorityRow = {
  release_id: string;
  release_state: string;
  release_main_commit_sha: string;
  release_steam_app_id: string;
  beta_branch: string | null;
  branch_password_secret_ref: string | null;
  rc_run_id: string;
  rc_evidence_bundle_id: string;
  rc_artifact_digest: string;
  signed_rc: unknown;
  evidence_status: string;
  evidence_invalidated_at: string | null;
  evidence_bundle_digest: string;
  approval_id: string;
  authorization_state: string;
  authorization_workflow_id: string;
  authorization_main_commit_sha: string;
  authorization_evidence_bundle_digest: string;
  signed_authorization: unknown;
  session_id: string;
  session_tenant_id: string;
  account_id: string;
  account_name: string;
  config_vdf_secret_ref: string;
  credential_version_id: string;
  allowed_app_ids: string[];
  permissions: string[];
  session_state: string;
  verified_at: string;
  expires_at: string;
};

type PublishAuthorityRow = {
  release_id: string;
  release_state: string;
  steam_app_id: string;
  build_receipt_id: string;
  build_id: string;
  build_state: string;
  steam_install_evidence_bundle_digest: string | null;
  main_run_id: string;
  external_approvals: unknown;
  session_id: string;
  session_tenant_id: string;
  account_id: string;
  account_name: string;
  config_vdf_secret_ref: string;
  credential_version_id: string;
  allowed_app_ids: string[];
  permissions: string[];
  session_state: string;
  verified_at: string;
  expires_at: string;
};

/** Re-resolves every signed artifact and release gate under tenant RLS. */
export class PostgresSteamWorkflowExecutionAuthority implements SteamWorkflowExecutionAuthority {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async resolvePrivateBeta(request: SteamPrivateBetaOperationRequest): Promise<SteamPrivateBetaExecutionAuthority> {
    return withTenant(this.pool, request.tenantId, async (client) => {
      const result = await client.query<UploadAuthorityRow>(
        `SELECT release.id::text AS release_id,
                release.state AS release_state,
                release.main_commit_sha AS release_main_commit_sha,
                release.steam_app_id AS release_steam_app_id,
                release.beta_branch,
                release.branch_password_secret_ref,
                rc.run_id::text AS rc_run_id,
                rc.main_evidence_bundle_id::text AS rc_evidence_bundle_id,
                rc.artifact_digest::text AS rc_artifact_digest,
                rc.signed_artifact AS signed_rc,
                evidence.status AS evidence_status,
                evidence.invalidated_at::text AS evidence_invalidated_at,
                evidence.bundle_digest AS evidence_bundle_digest,
                authorization.approval_id::text,
                authorization.state AS authorization_state,
                authorization.workflow_id AS authorization_workflow_id,
                authorization.main_commit_sha AS authorization_main_commit_sha,
                authorization.evidence_bundle_digest AS authorization_evidence_bundle_digest,
                authorization.signed_authorization,
                session.id::text AS session_id,
                session.tenant_id::text AS session_tenant_id,
                session.account_id,
                session.account_name,
                session.config_vdf_secret_ref,
                session.credential_version_id::text,
                session.allowed_app_ids,
                session.permissions,
                session.state AS session_state,
                session.verified_at::text,
                session.expires_at::text
           FROM deviludo.steam_rc_artifacts rc
           JOIN deviludo.steam_releases release
             ON release.tenant_id = rc.tenant_id
            AND release.project_id = rc.project_id
            AND release.id = rc.release_id
           JOIN deviludo.evidence_bundles evidence
             ON evidence.tenant_id = rc.tenant_id
            AND evidence.project_id = rc.project_id
            AND evidence.id = rc.main_evidence_bundle_id
           JOIN deviludo.steam_release_authorizations authorization
             ON authorization.tenant_id = release.tenant_id
            AND authorization.project_id = release.project_id
            AND authorization.release_id = release.id
           JOIN deviludo.steam_build_sessions session
             ON session.tenant_id = release.tenant_id
            AND session.config_vdf_secret_ref = release.steam_session_secret_ref
          WHERE rc.tenant_id = $1::uuid AND rc.project_id = $2::uuid
            AND rc.run_id = $3::uuid AND rc.main_evidence_bundle_id = $4::uuid
            AND authorization.approval_id = $5::uuid
            AND authorization.workflow_id = $6
            AND release.main_commit_sha = $7
            AND release.state = 'STEAM_PRIVATE_BETA'
            AND authorization.state = 'DISPATCHED'
            AND evidence.status = 'PASSED' AND evidence.invalidated_at IS NULL
            AND session.state = 'ACTIVE' AND session.expires_at > now()
            AND release.steam_app_id = ANY(session.allowed_app_ids)
          FOR SHARE OF rc, release, evidence, authorization, session`,
        [request.tenantId, request.projectId, request.runId, request.mainEvidenceBundleId,
          request.mfaApprovalId, request.workflowId, request.mainCommitSha],
      );
      if (result.rows.length !== 1) invalid();
      const row = result.rows[0]!;
      const rc = parseSignedRc(row.signed_rc);
      const authorization = parseSignedAuthorization(row.signed_authorization);
      const session = parseSession(row);
      if (row.release_state !== "STEAM_PRIVATE_BETA" || row.rc_run_id !== request.runId
        || row.rc_evidence_bundle_id !== request.mainEvidenceBundleId || row.approval_id !== request.mfaApprovalId
        || row.authorization_state !== "DISPATCHED" || row.authorization_workflow_id !== request.workflowId
        || row.release_main_commit_sha !== request.mainCommitSha || row.authorization_main_commit_sha !== request.mainCommitSha
        || row.evidence_status !== "PASSED" || row.evidence_invalidated_at !== null
        || !SHA256.test(row.evidence_bundle_digest)
        || row.authorization_evidence_bundle_digest !== row.evidence_bundle_digest
        || rc.claims.evidenceBundleDigest !== row.evidence_bundle_digest
        || rc.claims.releaseId !== row.release_id || authorization.claims.releaseId !== row.release_id
        || rc.claims.steamAppId !== row.release_steam_app_id
        || sha256Canonical(rc) !== row.rc_artifact_digest
        || !row.beta_branch || !BRANCH.test(row.beta_branch) || ["default", "public"].includes(row.beta_branch)
        || !row.branch_password_secret_ref || !SECRET_REF.test(row.branch_password_secret_ref)) invalid();
      return Object.freeze({
        state: "AUTHORIZED",
        runId: row.rc_run_id,
        mainEvidenceBundleId: row.rc_evidence_bundle_id,
        mfaApprovalId: row.approval_id,
        targetMatrix: parseMatrix(rc.claims.targetMatrix),
        rc,
        authorization,
        session,
        betaBranch: row.beta_branch,
        branchPasswordSecretRef: row.branch_password_secret_ref,
      });
    });
  }

  async resolveDefaultBranch(request: SteamDefaultBranchOperationRequest): Promise<SteamDefaultBranchExecutionAuthority> {
    return withTenant(this.pool, request.tenantId, async (client) => {
      const result = await client.query<PublishAuthorityRow>(
        `SELECT release.id::text AS release_id,
                release.state AS release_state,
                release.steam_app_id,
                build.id::text AS build_receipt_id,
                build.build_id,
                build.state AS build_state,
                build.steam_install_evidence_bundle_digest,
                main_attempt.run_id::text AS main_run_id,
                (SELECT jsonb_agg(
                   jsonb_build_object('gate', approval.gate, 'approvalId', approval.approval_id)
                   ORDER BY CASE approval.gate
                     WHEN 'VALVE_REVIEW' THEN 1
                     WHEN 'FIRST_RELEASE' THEN 2
                     WHEN 'DEFAULT_BRANCH_CONFIRMATION' THEN 3 END)
                   FROM deviludo.workflow_external_approval_receipts approval
                  WHERE approval.tenant_id = release.tenant_id
                    AND approval.project_id = release.project_id
                    AND approval.release_id = release.id
                    AND approval.workflow_id = $4) AS external_approvals,
                session.id::text AS session_id,
                session.tenant_id::text AS session_tenant_id,
                session.account_id,
                session.account_name,
                session.config_vdf_secret_ref,
                session.credential_version_id::text,
                session.allowed_app_ids,
                session.permissions,
                session.state AS session_state,
                session.verified_at::text,
                session.expires_at::text
           FROM deviludo.steam_build_receipts build
           JOIN deviludo.steam_releases release
             ON release.tenant_id = build.tenant_id
            AND release.project_id = build.project_id
            AND release.id = build.release_id
           JOIN deviludo.evidence_bundles main_evidence
             ON main_evidence.tenant_id = release.tenant_id
            AND main_evidence.project_id = release.project_id
            AND main_evidence.id = release.evidence_bundle_id
           JOIN deviludo.e2e_attempts main_attempt
             ON main_attempt.id = main_evidence.attempt_id
            AND main_attempt.tenant_id = main_evidence.tenant_id
            AND main_attempt.project_id = main_evidence.project_id
           JOIN deviludo.steam_build_sessions session
             ON session.tenant_id = release.tenant_id
            AND session.config_vdf_secret_ref = release.steam_session_secret_ref
          WHERE build.tenant_id = $1::uuid AND build.project_id = $2::uuid
            AND main_attempt.run_id = $3::uuid AND release.state = 'READY_TO_PUBLISH'
            AND build.build_id = $5 AND build.state = 'EXTERNAL_APPROVAL_REQUIRED'
            AND build.steam_install_evidence_bundle_digest IS NOT NULL
            AND session.state = 'ACTIVE' AND session.expires_at > now()
            AND release.steam_app_id = ANY(session.allowed_app_ids)
          FOR SHARE OF build, release, main_evidence, main_attempt, session`,
        [request.tenantId, request.projectId, request.runId, request.workflowId, request.betaBuildId],
      );
      if (result.rows.length !== 1) invalid();
      const row = result.rows[0]!;
      const externalApprovals = parseApprovals(row.external_approvals);
      const session = parseSession(row);
      if (row.release_state !== "READY_TO_PUBLISH" || row.main_run_id !== request.runId
        || row.build_id !== request.betaBuildId || row.build_state !== "EXTERNAL_APPROVAL_REQUIRED"
        || !UUID.test(row.release_id) || !UUID.test(row.build_receipt_id) || !NUMERIC_ID.test(row.steam_app_id)
        || !row.steam_install_evidence_bundle_digest || !SHA256.test(row.steam_install_evidence_bundle_digest)
        || JSON.stringify(externalApprovals.map((entry) => entry.approvalId)) !== JSON.stringify(request.externalApprovalIds)) invalid();
      return Object.freeze({
        state: "READY_TO_PUBLISH",
        tenantId: request.tenantId,
        projectId: request.projectId,
        releaseId: row.release_id,
        runId: row.main_run_id,
        steamAppId: row.steam_app_id,
        betaBuildId: row.build_id,
        buildReceiptId: row.build_receipt_id,
        steamInstallEvidenceBundleDigest: row.steam_install_evidence_bundle_digest,
        session,
        externalApprovals,
      });
    });
  }

  async probe(): Promise<void> { await probe(this.pool); }
}

type BuildReceiptRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  release_id: string;
  steam_app_id: string;
  build_id: string;
  main_commit_sha: string;
  source_digest: string;
  evidence_bundle_digest: string;
  beta_branch: string;
  depot_manifest_ids: unknown;
  install_attempts: unknown;
  state: string;
  uploaded_at: string;
};

type ReleaseLifecycleRow = {
  id: string;
  state: string;
  external_gate: string;
};

export class PostgresSteamBuildReceiptArchive implements SteamBuildReceiptArchive {
  constructor(private readonly pool: PostgresWorkflowPool, private readonly receiptId: () => string = randomUUID) {}

  async persist(input: Parameters<SteamBuildReceiptArchive["persist"]>[0]): Promise<Readonly<{ receiptId: string }>> {
    validateOperationBinding(input.operationKey, input.requestDigest);
    const receipt = validatePrivateBetaReceipt(input.receipt);
    const id = this.receiptId();
    if (!UUID.test(id)) invalid();
    return withTenant(this.pool, receipt.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.steam_build_receipts
          (id, tenant_id, project_id, release_id, steam_app_id, build_id,
           main_commit_sha, source_digest, evidence_bundle_digest, beta_branch,
           depot_manifest_ids, install_attempts, state, uploaded_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
                 $7, $8, $9, $10, $11::jsonb, $12::jsonb, 'INSTALL_TESTING', $13::timestamptz)
         ON CONFLICT (release_id) DO NOTHING`,
        [id, receipt.tenantId, receipt.projectId, receipt.releaseId, receipt.steamAppId,
          receipt.buildId, receipt.mainCommitSha, receipt.sourceDigest, receipt.evidenceBundleDigest,
          receipt.betaBranch, JSON.stringify(receipt.depotManifestIds), JSON.stringify(receipt.installAttempts), receipt.uploadedAt],
      );
      const selected = await client.query<BuildReceiptRow>(
        `SELECT id::text, tenant_id::text, project_id::text, release_id::text,
                steam_app_id, build_id, main_commit_sha, source_digest,
                evidence_bundle_digest, beta_branch, depot_manifest_ids,
                install_attempts, state, uploaded_at::text
           FROM deviludo.steam_build_receipts
          WHERE tenant_id = $1::uuid AND release_id = $2::uuid
          FOR UPDATE`,
        [receipt.tenantId, receipt.releaseId],
      );
      if (selected.rows.length !== 1) invalid();
      const row = selected.rows[0]!;
      const stored = buildReceiptFromRow(row);
      if (sha256Canonical(stored) !== sha256Canonical(receipt)) invalid();
      await client.query(
        `UPDATE deviludo.steam_releases
            SET state = 'INSTALL_TESTING', external_gate = 'NONE', version = version + 1
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
            AND state = 'STEAM_PRIVATE_BETA' AND external_gate = 'NONE'`,
        [receipt.tenantId, receipt.projectId, receipt.releaseId],
      );
      const release = await client.query<ReleaseLifecycleRow>(
        `SELECT id::text, state, external_gate
           FROM deviludo.steam_releases
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
          FOR UPDATE`,
        [receipt.tenantId, receipt.projectId, receipt.releaseId],
      );
      if (release.rows.length !== 1 || release.rows[0]?.id !== receipt.releaseId
        || release.rows[0]?.state !== "INSTALL_TESTING" || release.rows[0]?.external_gate !== "NONE") invalid();
      return Object.freeze({ receiptId: row.id });
    });
  }

  async probe(): Promise<void> { await probe(this.pool); }
}

type PublicationRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  run_id: string;
  release_id: string;
  build_receipt_id: string;
  operation_key: string;
  request_digest: string;
  steam_app_id: string;
  beta_build_id: string;
  default_branch_build_id: string;
  steam_install_evidence_bundle_digest: string;
  external_approval_ids: string[];
  receipt: unknown;
  published_at: string;
};

export class PostgresSteamDefaultBranchReceiptArchive implements SteamDefaultBranchReceiptArchive {
  constructor(private readonly pool: PostgresWorkflowPool, private readonly receiptId: () => string = randomUUID) {}

  async persist(input: Parameters<SteamDefaultBranchReceiptArchive["persist"]>[0]): Promise<Readonly<{ receiptId: string }>> {
    validatePublication(input);
    const id = this.receiptId();
    if (!UUID.test(id)) invalid();
    return withTenant(this.pool, input.tenantId, async (client) => {
      const receipt = publicationReceipt(id, input);
      await client.query(
        `INSERT INTO deviludo.steam_default_branch_receipts
          (id, tenant_id, project_id, run_id, release_id, build_receipt_id,
           operation_key, request_digest, steam_app_id, beta_build_id,
           default_branch_build_id, steam_install_evidence_bundle_digest,
           external_approval_ids, receipt, published_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
                 $7, $8, $9, $10, $11, $12, $13::text[], $14::jsonb,
                 $15::timestamptz, $15::timestamptz)
         ON CONFLICT (tenant_id, release_id) DO NOTHING`,
        [id, input.tenantId, input.projectId, input.runId, input.releaseId, input.buildReceiptId,
          input.operationKey, input.requestDigest, input.steamAppId, input.betaBuildId,
          input.defaultBranchBuildId, input.steamInstallEvidenceBundleDigest,
          input.externalApprovalIds, JSON.stringify(receipt), input.publishedAt],
      );
      const selected = await client.query<PublicationRow>(
        `SELECT id::text, tenant_id::text, project_id::text, run_id::text, release_id::text,
                build_receipt_id::text, operation_key, request_digest::text,
                steam_app_id, beta_build_id, default_branch_build_id,
                steam_install_evidence_bundle_digest::text,
                external_approval_ids, receipt, published_at::text
           FROM deviludo.steam_default_branch_receipts
          WHERE tenant_id = $1::uuid AND release_id = $2::uuid
          FOR UPDATE`,
        [input.tenantId, input.releaseId],
      );
      if (selected.rows.length !== 1) invalid();
      const stored = publicationFromRow(selected.rows[0]!);
      if (sha256Canonical(stored) !== sha256Canonical(publicationReceipt(stored.receiptId, input))) invalid();
      await client.query(
        `UPDATE deviludo.steam_releases
            SET state = 'RELEASED', external_gate = 'NONE', version = version + 1
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
            AND state = 'READY_TO_PUBLISH' AND external_gate = 'NONE'`,
        [input.tenantId, input.projectId, input.releaseId],
      );
      const release = await client.query<ReleaseLifecycleRow>(
        `SELECT id::text, state, external_gate
           FROM deviludo.steam_releases
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
          FOR UPDATE`,
        [input.tenantId, input.projectId, input.releaseId],
      );
      if (release.rows.length !== 1 || release.rows[0]?.id !== input.releaseId
        || release.rows[0]?.state !== "RELEASED" || release.rows[0]?.external_gate !== "NONE") invalid();
      return Object.freeze({ receiptId: stored.receiptId });
    });
  }

  async probe(): Promise<void> { await probe(this.pool); }
}

function parseSignedRc(value: unknown): SignedSteamRcArtifact {
  const body = envelope(value);
  const claims = record(body.claims);
  if (claims.kind !== "deviludo-steam-rc" || claims.version !== 1) invalid();
  return Object.freeze({ keyId: body.keyId, claims: Object.freeze({ ...claims }) as unknown as SignedSteamRcArtifact["claims"], signature: body.signature });
}

function parseSignedAuthorization(value: unknown): SignedSteamPublishAuthorization {
  const body = envelope(value);
  const claims = record(body.claims);
  if (claims.kind !== "deviludo-steam-publish-authorization" || claims.version !== 1
    || claims.operation !== "PRIVATE_BETA_UPLOAD") invalid();
  return Object.freeze({ keyId: body.keyId, claims: Object.freeze({ ...claims }) as unknown as SignedSteamPublishAuthorization["claims"], signature: body.signature });
}

function envelope(value: unknown): { keyId: string; claims: unknown; signature: string } {
  const body = record(jsonValue(value));
  exactKeys(body, ["keyId", "claims", "signature"]);
  if (typeof body.keyId !== "string" || !SAFE_ID.test(body.keyId)
    || typeof body.signature !== "string" || !body.signature || body.signature.length > 512) invalid();
  return { keyId: body.keyId, claims: body.claims, signature: body.signature };
}

function parseSession(row: Pick<UploadAuthorityRow, "session_id" | "session_tenant_id" | "account_id" | "account_name" |
  "config_vdf_secret_ref" | "credential_version_id" | "allowed_app_ids" | "permissions" | "session_state" |
  "verified_at" | "expires_at">): SteamBuildSession {
  if (!UUID.test(row.session_id) || !UUID.test(row.session_tenant_id) || !SAFE_ID.test(row.account_id)
    || !/^[A-Za-z0-9_-]{3,64}$/.test(row.account_name) || !SECRET_REF.test(row.config_vdf_secret_ref)
    || !UUID.test(row.credential_version_id) || !Array.isArray(row.allowed_app_ids) || !row.allowed_app_ids.length
    || row.allowed_app_ids.some((item) => !NUMERIC_ID.test(item))
    || !Array.isArray(row.permissions) || !row.permissions.includes("EditAppMetadata")
    || !row.permissions.includes("PublishAppChanges") || row.session_state !== "ACTIVE"
    || !Number.isFinite(Date.parse(row.verified_at)) || !Number.isFinite(Date.parse(row.expires_at))) invalid();
  return Object.freeze({
    id: row.session_id,
    tenantId: row.session_tenant_id,
    accountId: row.account_id,
    accountName: row.account_name,
    configVdfSecretRef: row.config_vdf_secret_ref,
    credentialVersionId: row.credential_version_id,
    allowedAppIds: Object.freeze([...row.allowed_app_ids]),
    permissions: Object.freeze([...row.permissions]) as SteamBuildSession["permissions"],
    state: "ACTIVE",
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
  });
}

function parseApprovals(value: unknown): SteamDefaultBranchExecutionAuthority["externalApprovals"] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed) || parsed.length !== 3) invalid();
  const expected = ["VALVE_REVIEW", "FIRST_RELEASE", "DEFAULT_BRANCH_CONFIRMATION"] as const;
  const result = parsed.map((item, index) => {
    const body = record(item);
    exactKeys(body, ["gate", "approvalId"]);
    if (body.gate !== expected[index] || typeof body.approvalId !== "string" || !SAFE_ID.test(body.approvalId)) invalid();
    return Object.freeze({ gate: body.gate, approvalId: body.approvalId });
  });
  if (new Set(result.map((entry) => entry.approvalId)).size !== 3) invalid();
  return Object.freeze(result) as SteamDefaultBranchExecutionAuthority["externalApprovals"];
}

function validatePrivateBetaReceipt(value: SteamPrivateBetaReceipt): SteamPrivateBetaReceipt {
  if (!UUID.test(value.tenantId) || !UUID.test(value.projectId) || !UUID.test(value.releaseId)
    || !NUMERIC_ID.test(value.steamAppId) || !NUMERIC_ID.test(value.buildId) || !SHA1.test(value.mainCommitSha)
    || !SHA256.test(value.sourceDigest) || !SHA256.test(value.evidenceBundleDigest)
    || !BRANCH.test(value.betaBranch) || ["default", "public"].includes(value.betaBranch)
    || value.state !== "INSTALL_TESTING" || !Number.isFinite(Date.parse(value.uploadedAt))) invalid();
  const depots = numericMap(value.depotManifestIds);
  const attempts = attemptMap(value.installAttempts);
  if (Object.keys(depots).length !== Object.keys(attempts).length) invalid();
  return deepFreeze({ ...value, depotManifestIds: depots, installAttempts: attempts });
}

function buildReceiptFromRow(row: BuildReceiptRow): SteamPrivateBetaReceipt {
  if (!UUID.test(row.id)) invalid();
  return validatePrivateBetaReceipt({
    tenantId: row.tenant_id,
    projectId: row.project_id,
    releaseId: row.release_id,
    steamAppId: row.steam_app_id,
    buildId: row.build_id,
    mainCommitSha: row.main_commit_sha,
    sourceDigest: row.source_digest,
    evidenceBundleDigest: row.evidence_bundle_digest,
    betaBranch: row.beta_branch,
    depotManifestIds: numericMap(jsonValue(row.depot_manifest_ids)),
    installAttempts: attemptMap(jsonValue(row.install_attempts)),
    state: row.state as "INSTALL_TESTING",
    uploadedAt: row.uploaded_at,
  });
}

type PublicationInput = Parameters<SteamDefaultBranchReceiptArchive["persist"]>[0];

function validatePublication(value: PublicationInput): void {
  validateOperationBinding(value.operationKey, value.requestDigest);
  if (![value.tenantId, value.projectId, value.releaseId, value.runId, value.buildReceiptId].every((item) => UUID.test(item))
    || !NUMERIC_ID.test(value.steamAppId) || !NUMERIC_ID.test(value.betaBuildId)
    || value.defaultBranchBuildId !== value.betaBuildId || !SHA256.test(value.steamInstallEvidenceBundleDigest)
    || !Array.isArray(value.externalApprovalIds) || value.externalApprovalIds.length !== 3
    || new Set(value.externalApprovalIds).size !== 3
    || value.externalApprovalIds.some((item) => !SAFE_ID.test(item))
    || !Number.isFinite(Date.parse(value.publishedAt))) invalid();
}

function publicationReceipt(receiptId: string, value: PublicationInput) {
  return deepFreeze({
    receiptId,
    tenantId: value.tenantId,
    projectId: value.projectId,
    releaseId: value.releaseId,
    runId: value.runId,
    buildReceiptId: value.buildReceiptId,
    operationKey: value.operationKey,
    requestDigest: value.requestDigest,
    steamAppId: value.steamAppId,
    betaBuildId: value.betaBuildId,
    defaultBranchBuildId: value.defaultBranchBuildId,
    steamInstallEvidenceBundleDigest: value.steamInstallEvidenceBundleDigest,
    externalApprovalIds: Object.freeze([...value.externalApprovalIds]),
    publishedAt: value.publishedAt,
  });
}

function publicationFromRow(row: PublicationRow) {
  const value = {
    tenantId: row.tenant_id,
    projectId: row.project_id,
    releaseId: row.release_id,
    runId: row.run_id,
    buildReceiptId: row.build_receipt_id,
    operationKey: row.operation_key,
    requestDigest: row.request_digest,
    steamAppId: row.steam_app_id,
    betaBuildId: row.beta_build_id,
    defaultBranchBuildId: row.default_branch_build_id,
    steamInstallEvidenceBundleDigest: row.steam_install_evidence_bundle_digest,
    externalApprovalIds: row.external_approval_ids,
    publishedAt: row.published_at,
  };
  validateOperationBinding(value.operationKey, value.requestDigest);
  if (!UUID.test(row.id) || !UUID.test(value.tenantId) || !UUID.test(value.projectId) || !UUID.test(value.runId)
    || !UUID.test(value.releaseId)
    || !UUID.test(value.buildReceiptId) || !NUMERIC_ID.test(value.steamAppId) || !NUMERIC_ID.test(value.betaBuildId)
    || value.defaultBranchBuildId !== value.betaBuildId || !SHA256.test(value.steamInstallEvidenceBundleDigest)
    || !Array.isArray(value.externalApprovalIds) || value.externalApprovalIds.length !== 3
    || new Set(value.externalApprovalIds).size !== 3 || value.externalApprovalIds.some((item) => !SAFE_ID.test(item))
    || !Number.isFinite(Date.parse(value.publishedAt))) invalid();
  const receipt = deepFreeze({ receiptId: row.id, ...value });
  if (sha256Canonical(jsonValue(row.receipt)) !== sha256Canonical(receipt)) invalid();
  return receipt;
}

function validateOperationBinding(operationKey: string, requestDigest: string): void {
  if (!/^workflow-job:[a-f0-9-]{36}$/.test(operationKey) || !SHA256.test(requestDigest)) invalid();
}

function numericMap(value: unknown): Readonly<Record<string, string>> {
  const body = record(value);
  const entries = Object.entries(body);
  if (!entries.length || entries.length > 3) invalid();
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!NUMERIC_ID.test(key) || typeof item !== "string" || !NUMERIC_ID.test(item)) invalid();
    result[key] = item;
  }
  return Object.freeze(result);
}

function attemptMap(value: unknown): Readonly<Record<SteamTargetPlatform, string>> {
  const body = record(value);
  const entries = Object.entries(body);
  if (!entries.length || entries.length > 3) invalid();
  const result: Partial<Record<SteamTargetPlatform, string>> = {};
  for (const [key, item] of entries) {
    if (!isPlatform(key) || typeof item !== "string" || !SAFE_ID.test(item)) invalid();
    result[key] = item;
  }
  return Object.freeze(result) as Readonly<Record<SteamTargetPlatform, string>>;
}

function parseMatrix(value: readonly SteamTargetPlatform[]): readonly SteamTargetPlatform[] {
  if (!Array.isArray(value) || !value.length || value.length > 3 || new Set(value).size !== value.length
    || value.some((item) => !isPlatform(item))) invalid();
  return Object.freeze([...value]);
}

function isPlatform(value: unknown): value is SteamTargetPlatform {
  return value === "windows" || value === "linux" || value === "macos";
}

async function withTenant<T>(
  pool: PostgresWorkflowPool,
  tenantId: string,
  operation: (client: PostgresWorkflowClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) invalid();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve authority failure */ }
    throw error;
  } finally { client.release(); }
}

async function probe(pool: PostgresWorkflowPool): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ ready: number }>("SELECT 1 AS ready");
    if (result.rows.length !== 1 || result.rows[0]?.ready !== 1) invalid();
  } finally { client.release(); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid();
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch { invalid(); }
}

function deepFreeze<T>(value: T): T {
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function invalid(): never { throw new Error("PostgreSQL Steam workflow execution authority is invalid"); }
