import { randomUUID } from "node:crypto";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { ReleaseSnapshotResolver } from "./release-authorization-contracts";
import type { SteamPrivateBetaReleasePreparer } from "./workflow-broker-executor";
import type { SteamPrivateBetaOperationRequest } from "./workflow-broker-http";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const APP_ID = /^[1-9][0-9]{0,19}$/;
const BRANCH = /^[a-z0-9][a-z0-9_-]{2,39}$/;
const SECRET_REF = /^vault:\/\/[A-Za-z0-9._~:/-]{2,500}$/;
const PLATFORMS = new Set(["windows", "linux", "macos"] as const);

export interface SteamReleasePreparationInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly mainCommitSha: string;
  readonly mainEvidenceBundleId: string;
  readonly targetMatrix: readonly ("windows" | "linux" | "macos")[];
}

export interface SteamReleasePreparationReceipt {
  readonly releaseId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly mainCommitSha: string;
  readonly mainEvidenceBundleId: string;
  readonly releaseConfigurationId: string;
  readonly targetMatrix: readonly ("windows" | "linux" | "macos")[];
  readonly state: "WAITING_MFA";
}

export interface SteamReleasePreparationPort {
  ensure(input: SteamReleasePreparationInput): Promise<SteamReleasePreparationReceipt>;
  probe(): Promise<void>;
}

type PreparationAuthorityRow = {
  evidence_id: string;
  evidence_status: string;
  evidence_invalidated_at: string | null;
  evidence_commit_sha: string;
  evidence_bundle_digest: string;
  attempt_run_id: string;
  attempt_mode: string;
  attempt_state: string;
  attempt_target_matrix: unknown;
  project_steam_app_id: string | null;
  configuration_id: string;
  configuration_steam_app_id: string;
  configuration_session_id: string;
  configuration_depot_id: string;
  configuration_beta_branch: string;
  configuration_branch_password_secret_ref: string;
  configuration_digest: string;
  configuration_state: string;
  session_config_vdf_secret_ref: string;
  session_allowed_app_ids: unknown;
  session_permissions: unknown;
  session_state: string;
  session_expires_at: string;
  depot_steam_app_id: string;
  depot_platform_depots: unknown;
  depot_state: string;
};

type ReleaseRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string | null;
  run_id: string | null;
  release_configuration_id: string | null;
  main_commit_sha: string;
  evidence_bundle_id: string;
  steam_app_id: string;
  steam_session_secret_ref: string;
  mfa_approval_id: string | null;
  beta_branch: string | null;
  branch_password_secret_ref: string | null;
  target_matrix: unknown;
  state: string;
  external_gate: string;
  version: number;
  created_at: string;
};

/** Creates one idempotent WAITING_MFA release from passed main evidence and an active exact project revision. */
export class PostgresSteamReleasePreparation implements SteamReleasePreparationPort {
  readonly #releaseId: () => string;
  readonly #now: () => Date;

  constructor(
    private readonly pool: PostgresWorkflowPool,
    options: Readonly<{ releaseId?: () => string; now?: () => Date }> = {},
  ) {
    this.#releaseId = options.releaseId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async ensure(input: SteamReleasePreparationInput): Promise<SteamReleasePreparationReceipt> {
    validatePreparationInput(input);
    const createdAt = exactNow(this.#now()).toISOString();
    return transaction(this.pool, input.tenantId, async (client) => {
      const existing = await findReleaseByWorkflow(client, input.tenantId, input.workflowId);
      if (existing) return replayReleaseReceipt(existing, input);
      const selected = await client.query<PreparationAuthorityRow>(
        `SELECT evidence.id::text AS evidence_id,
                evidence.status AS evidence_status,
                evidence.invalidated_at::text AS evidence_invalidated_at,
                evidence.commit_sha AS evidence_commit_sha,
                evidence.bundle_digest::text AS evidence_bundle_digest,
                attempt.run_id::text AS attempt_run_id,
                attempt.mode AS attempt_mode,
                attempt.state AS attempt_state,
                attempt.target_matrix AS attempt_target_matrix,
                project.steam_app_id AS project_steam_app_id,
                configuration.id::text AS configuration_id,
                configuration.steam_app_id AS configuration_steam_app_id,
                configuration.steam_build_session_id::text AS configuration_session_id,
                configuration.depot_configuration_id::text AS configuration_depot_id,
                configuration.beta_branch AS configuration_beta_branch,
                configuration.branch_password_secret_ref AS configuration_branch_password_secret_ref,
                configuration.configuration_digest::text AS configuration_digest,
                configuration.state AS configuration_state,
                session.config_vdf_secret_ref AS session_config_vdf_secret_ref,
                session.allowed_app_ids AS session_allowed_app_ids,
                session.permissions AS session_permissions,
                session.state AS session_state,
                session.expires_at::text AS session_expires_at,
                depot.steam_app_id AS depot_steam_app_id,
                depot.platform_depots AS depot_platform_depots,
                depot.state AS depot_state
           FROM deviludo.evidence_bundles evidence
           JOIN deviludo.e2e_attempts attempt
             ON attempt.tenant_id = evidence.tenant_id
            AND attempt.project_id = evidence.project_id
            AND attempt.id = evidence.attempt_id
           JOIN deviludo.projects project
             ON project.tenant_id = evidence.tenant_id AND project.id = evidence.project_id
           JOIN deviludo.steam_project_release_configurations configuration
             ON configuration.tenant_id = project.tenant_id
            AND configuration.project_id = project.id AND configuration.state = 'ACTIVE'
           JOIN deviludo.steam_build_sessions session
             ON session.tenant_id = configuration.tenant_id
            AND session.id = configuration.steam_build_session_id
           JOIN deviludo.steam_project_depot_configurations depot
             ON depot.tenant_id = configuration.tenant_id
            AND depot.project_id = configuration.project_id
            AND depot.id = configuration.depot_configuration_id
          WHERE evidence.tenant_id = $1::uuid AND evidence.project_id = $2::uuid
            AND evidence.id = $3::uuid AND evidence.commit_sha = $4
            AND evidence.status = 'PASSED' AND evidence.invalidated_at IS NULL
            AND attempt.run_id = $5::uuid AND attempt.mode = 'MAIN_RELEASE_GATE'
            AND attempt.state = 'PASSED'
            AND session.state = 'ACTIVE' AND session.expires_at > $6::timestamptz
            AND depot.state = 'ACTIVE'
          FOR SHARE OF evidence, attempt, project, configuration, session, depot`,
        [input.tenantId, input.projectId, input.mainEvidenceBundleId,
          input.mainCommitSha, input.runId, createdAt],
      );
      if (selected.rows.length !== 1) invalid();
      const authority = preparationAuthority(selected.rows[0]!, input, createdAt);
      const releaseId = this.#releaseId();
      if (!UUID.test(releaseId)) invalid();
      await client.query(
        `INSERT INTO deviludo.steam_releases
          (id, tenant_id, project_id, workflow_id, run_id, release_configuration_id,
           main_commit_sha, evidence_bundle_id, steam_app_id, steam_session_secret_ref,
           mfa_approval_id, beta_branch, branch_password_secret_ref, target_matrix,
           state, external_gate, version, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid,
                 $7, $8::uuid, $9, $10, NULL, $11, $12, $13::text[],
                 'WAITING_MFA', 'NONE', 1, $14::timestamptz)
         ON CONFLICT (tenant_id, workflow_id) WHERE workflow_id IS NOT NULL DO NOTHING`,
        [releaseId, input.tenantId, input.projectId, input.workflowId, input.runId,
          authority.configurationId, input.mainCommitSha, input.mainEvidenceBundleId,
          authority.steamAppId, authority.sessionSecretRef, authority.betaBranch,
          authority.branchPasswordSecretRef, input.targetMatrix, createdAt],
      );
      const release = await selectReleaseByWorkflow(client, input.tenantId, input.workflowId);
      return releaseReceipt(release, input, authority);
    });
  }

  async probe(): Promise<void> { await probe(this.pool); }
}

/** Resolves only the release created for the still-waiting control-plane MFA action. */
export class PostgresReleaseSnapshotResolver implements ReleaseSnapshotResolver {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async resolveForMfa(input: { tenantId: string; releaseId: string; requestedBy: string }) {
    if (!UUID.test(input.tenantId) || !UUID.test(input.releaseId) || !SAFE_ID.test(input.requestedBy)) invalid();
    return transaction(this.pool, input.tenantId, async (client) => {
      const result = await client.query<ReleaseRow & {
        evidence_bundle_digest: string;
        evidence_status: string;
        evidence_invalidated_at: string | null;
        attempt_mode: string;
        attempt_state: string;
        action_status: string;
        action_binding: unknown;
      }>(
        `SELECT release.id::text, release.tenant_id::text, release.project_id::text,
                release.workflow_id, release.run_id::text, release.release_configuration_id::text,
                release.main_commit_sha, release.evidence_bundle_id::text,
                release.steam_app_id, release.steam_session_secret_ref,
                release.mfa_approval_id::text, release.beta_branch,
                release.branch_password_secret_ref, release.target_matrix,
                release.state, release.external_gate, release.version, release.created_at::text,
                evidence.bundle_digest::text AS evidence_bundle_digest,
                evidence.status AS evidence_status,
                evidence.invalidated_at::text AS evidence_invalidated_at,
                attempt.mode AS attempt_mode, attempt.state AS attempt_state,
                action.status AS action_status, action.binding AS action_binding
           FROM deviludo.steam_releases release
           JOIN deviludo.evidence_bundles evidence
             ON evidence.tenant_id = release.tenant_id
            AND evidence.project_id = release.project_id
            AND evidence.id = release.evidence_bundle_id
           JOIN deviludo.e2e_attempts attempt
             ON attempt.tenant_id = evidence.tenant_id
            AND attempt.project_id = evidence.project_id
            AND attempt.id = evidence.attempt_id AND attempt.run_id = release.run_id
           JOIN deviludo.workflow_control_actions action
             ON action.tenant_id = release.tenant_id
            AND action.project_id = release.project_id
            AND action.workflow_id = release.workflow_id
            AND action.operation = 'REQUEST_FRESH_MFA'
          WHERE release.tenant_id = $1::uuid AND release.id = $2::uuid
            AND release.state = 'WAITING_MFA' AND release.mfa_approval_id IS NULL
            AND evidence.status = 'PASSED' AND evidence.invalidated_at IS NULL
            AND attempt.mode = 'MAIN_RELEASE_GATE' AND attempt.state = 'PASSED'
            AND action.status = 'WAITING'
          FOR SHARE OF release, evidence, attempt, action`,
        [input.tenantId, input.releaseId],
      );
      if (result.rows.length !== 1) invalid();
      const row = result.rows[0]!;
      const binding = record(jsonValue(row.action_binding));
      if (!UUID.test(row.id) || row.tenant_id !== input.tenantId
        || row.state !== "WAITING_MFA" || row.mfa_approval_id !== null
        || !UUID.test(row.project_id) || !row.workflow_id || !SAFE_ID.test(row.workflow_id)
        || !row.run_id || !UUID.test(row.run_id) || !row.release_configuration_id || !UUID.test(row.release_configuration_id)
        || !SHA1.test(row.main_commit_sha) || !UUID.test(row.evidence_bundle_id)
        || !SHA256.test(row.evidence_bundle_digest) || row.evidence_status !== "PASSED"
        || row.evidence_invalidated_at !== null || row.attempt_mode !== "MAIN_RELEASE_GATE"
        || row.attempt_state !== "PASSED" || row.action_status !== "WAITING"
        || binding.state !== "WAITING_MFA" || binding.releaseId !== row.id
        || binding.mainCommitSha !== row.main_commit_sha || binding.evidenceBundleId !== row.evidence_bundle_id) invalid();
      return Object.freeze({
        tenantId: input.tenantId,
        projectId: row.project_id,
        releaseId: row.id,
        workflowId: row.workflow_id,
        state: "WAITING_MFA" as const,
        mainCommitSha: row.main_commit_sha,
        evidenceBundleDigest: row.evidence_bundle_digest,
      });
    });
  }
}

/** One-way WAITING_MFA -> STEAM_PRIVATE_BETA projection after a dispatched authorization. */
export class PostgresSteamPrivateBetaReleasePreparer implements SteamPrivateBetaReleasePreparer {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async prepare(request: SteamPrivateBetaOperationRequest): Promise<void> {
    validatePrivateBetaRequest(request);
    await transaction(this.pool, request.tenantId, async (client) => {
      const selected = await client.query<ReleaseRow & {
        evidence_bundle_digest: string;
        authorization_state: string;
        authorization_workflow_id: string;
        authorization_main_commit_sha: string;
        authorization_evidence_bundle_digest: string;
      }>(
        `SELECT release.id::text, release.tenant_id::text, release.project_id::text,
                release.workflow_id, release.run_id::text, release.release_configuration_id::text,
                release.main_commit_sha, release.evidence_bundle_id::text,
                release.steam_app_id, release.steam_session_secret_ref,
                release.mfa_approval_id::text, release.beta_branch,
                release.branch_password_secret_ref, release.target_matrix,
                release.state, release.external_gate, release.version, release.created_at::text,
                evidence.bundle_digest::text AS evidence_bundle_digest,
                authorization.state AS authorization_state,
                authorization.workflow_id AS authorization_workflow_id,
                authorization.main_commit_sha AS authorization_main_commit_sha,
                authorization.evidence_bundle_digest AS authorization_evidence_bundle_digest
           FROM deviludo.steam_releases release
           JOIN deviludo.evidence_bundles evidence
             ON evidence.tenant_id = release.tenant_id
            AND evidence.project_id = release.project_id
            AND evidence.id = release.evidence_bundle_id
           JOIN deviludo.steam_release_authorizations authorization
             ON authorization.tenant_id = release.tenant_id
            AND authorization.project_id = release.project_id
            AND authorization.release_id = release.id
            AND authorization.approval_id = $6::uuid
          WHERE release.tenant_id = $1::uuid AND release.project_id = $2::uuid
            AND release.run_id = $3::uuid AND release.workflow_id = $4
            AND release.main_commit_sha = $5 AND release.evidence_bundle_id = $7::uuid
            AND evidence.status = 'PASSED' AND evidence.invalidated_at IS NULL
            AND authorization.state = 'DISPATCHED'
          FOR UPDATE OF release`,
        [request.tenantId, request.projectId, request.runId, request.workflowId,
          request.mainCommitSha, request.mfaApprovalId, request.mainEvidenceBundleId],
      );
      if (selected.rows.length !== 1) invalid();
      const row = selected.rows[0]!;
      if (!UUID.test(row.id) || row.tenant_id !== request.tenantId || row.project_id !== request.projectId
        || row.workflow_id !== request.workflowId || row.run_id !== request.runId
        || row.main_commit_sha !== request.mainCommitSha || row.evidence_bundle_id !== request.mainEvidenceBundleId
        || row.authorization_workflow_id !== request.workflowId
        || row.authorization_main_commit_sha !== request.mainCommitSha
        || row.authorization_evidence_bundle_digest !== row.evidence_bundle_digest
        || row.authorization_state !== "DISPATCHED"
        || !row.release_configuration_id || !UUID.test(row.release_configuration_id)
        || JSON.stringify(matrix(row.target_matrix)) !== JSON.stringify(request.targetMatrix)) invalid();
      if (row.state === "STEAM_PRIVATE_BETA" && row.mfa_approval_id === request.mfaApprovalId) return;
      if (row.state !== "WAITING_MFA" || row.mfa_approval_id !== null) invalid();
      const updated = await client.query(
        `UPDATE deviludo.steam_releases
            SET state = 'STEAM_PRIVATE_BETA', mfa_approval_id = $3::uuid,
                version = version + 1
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND state = 'WAITING_MFA' AND mfa_approval_id IS NULL
        RETURNING id`,
        [request.tenantId, row.id, request.mfaApprovalId],
      );
      if (updated.rows.length !== 1) invalid();
    });
  }

  async probe(): Promise<void> { await probe(this.pool); }
}

function preparationAuthority(row: PreparationAuthorityRow, input: SteamReleasePreparationInput, now: string) {
  const selectedMatrix = matrix(row.attempt_target_matrix);
  const allowedAppIds = stringArray(row.session_allowed_app_ids);
  const permissions = stringArray(row.session_permissions);
  const platformDepots = record(jsonValue(row.depot_platform_depots));
  if (!UUID.test(row.evidence_id) || row.evidence_id !== input.mainEvidenceBundleId
    || row.evidence_status !== "PASSED" || row.evidence_invalidated_at !== null
    || row.evidence_commit_sha !== input.mainCommitSha || !SHA256.test(row.evidence_bundle_digest)
    || row.attempt_run_id !== input.runId || row.attempt_mode !== "MAIN_RELEASE_GATE" || row.attempt_state !== "PASSED"
    || JSON.stringify(selectedMatrix) !== JSON.stringify(input.targetMatrix)
    || !row.project_steam_app_id || !APP_ID.test(row.project_steam_app_id)
    || !UUID.test(row.configuration_id) || row.configuration_steam_app_id !== row.project_steam_app_id
    || !UUID.test(row.configuration_session_id) || !UUID.test(row.configuration_depot_id)
    || !BRANCH.test(row.configuration_beta_branch) || ["default", "public"].includes(row.configuration_beta_branch)
    || !SECRET_REF.test(row.configuration_branch_password_secret_ref) || !SHA256.test(row.configuration_digest)
    || row.configuration_state !== "ACTIVE" || row.session_state !== "ACTIVE"
    || !SECRET_REF.test(row.session_config_vdf_secret_ref) || Date.parse(row.session_expires_at) <= Date.parse(now)
    || !allowedAppIds.includes(row.project_steam_app_id)
    || !permissions.includes("EditAppMetadata") || !permissions.includes("PublishAppChanges")
    || row.depot_steam_app_id !== row.project_steam_app_id || row.depot_state !== "ACTIVE"
    || JSON.stringify(Object.keys(platformDepots).sort()) !== JSON.stringify(input.targetMatrix)
    || Object.values(platformDepots).some((value) => typeof value !== "string" || !APP_ID.test(value))) invalid();
  const expectedConfigurationDigest = sha256Canonical({
    schemaVersion: "deviludo.steam-release-configuration.v1",
    steamAppId: row.configuration_steam_app_id,
    steamBuildSessionId: row.configuration_session_id,
    depotConfigurationId: row.configuration_depot_id,
    betaBranch: row.configuration_beta_branch,
    branchPasswordSecretRef: row.configuration_branch_password_secret_ref,
  });
  if (expectedConfigurationDigest !== row.configuration_digest) invalid();
  return Object.freeze({
    configurationId: row.configuration_id,
    steamAppId: row.configuration_steam_app_id,
    sessionSecretRef: row.session_config_vdf_secret_ref,
    betaBranch: row.configuration_beta_branch,
    branchPasswordSecretRef: row.configuration_branch_password_secret_ref,
  });
}

async function selectReleaseByWorkflow(client: PostgresWorkflowClient, tenantId: string, workflowId: string) {
  const row = await findReleaseByWorkflow(client, tenantId, workflowId);
  if (!row) invalid();
  return row;
}

async function findReleaseByWorkflow(client: PostgresWorkflowClient, tenantId: string, workflowId: string) {
  const result = await client.query<ReleaseRow>(
    `SELECT id::text, tenant_id::text, project_id::text, workflow_id, run_id::text,
            release_configuration_id::text, main_commit_sha, evidence_bundle_id::text,
            steam_app_id, steam_session_secret_ref, mfa_approval_id::text,
            beta_branch, branch_password_secret_ref, target_matrix,
            state, external_gate, version, created_at::text
       FROM deviludo.steam_releases
      WHERE tenant_id = $1::uuid AND workflow_id = $2`,
    [tenantId, workflowId],
  );
  if (result.rows.length > 1) invalid();
  return result.rows[0] ?? null;
}

function releaseReceipt(
  row: ReleaseRow,
  input: SteamReleasePreparationInput,
  authority: Readonly<{ configurationId: string; steamAppId: string; sessionSecretRef: string; betaBranch: string; branchPasswordSecretRef: string }>,
): SteamReleasePreparationReceipt {
  if (!UUID.test(row.id) || row.tenant_id !== input.tenantId || row.project_id !== input.projectId
    || row.workflow_id !== input.workflowId || row.run_id !== input.runId
    || row.release_configuration_id !== authority.configurationId
    || row.main_commit_sha !== input.mainCommitSha || row.evidence_bundle_id !== input.mainEvidenceBundleId
    || row.steam_app_id !== authority.steamAppId || row.steam_session_secret_ref !== authority.sessionSecretRef
    || row.beta_branch !== authority.betaBranch || row.branch_password_secret_ref !== authority.branchPasswordSecretRef
    || row.mfa_approval_id !== null || row.state !== "WAITING_MFA" || row.external_gate !== "NONE" || row.version !== 1
    || JSON.stringify(matrix(row.target_matrix)) !== JSON.stringify(input.targetMatrix)) invalid();
  return Object.freeze({
    releaseId: row.id,
    workflowId: input.workflowId,
    runId: input.runId,
    mainCommitSha: input.mainCommitSha,
    mainEvidenceBundleId: input.mainEvidenceBundleId,
    releaseConfigurationId: authority.configurationId,
    targetMatrix: Object.freeze([...input.targetMatrix]),
    state: "WAITING_MFA",
  });
}

function replayReleaseReceipt(row: ReleaseRow, input: SteamReleasePreparationInput): SteamReleasePreparationReceipt {
  if (!UUID.test(row.id) || row.tenant_id !== input.tenantId || row.project_id !== input.projectId
    || row.workflow_id !== input.workflowId || row.run_id !== input.runId
    || !row.release_configuration_id || !UUID.test(row.release_configuration_id)
    || row.main_commit_sha !== input.mainCommitSha || row.evidence_bundle_id !== input.mainEvidenceBundleId
    || !APP_ID.test(row.steam_app_id) || !SECRET_REF.test(row.steam_session_secret_ref)
    || !row.beta_branch || !BRANCH.test(row.beta_branch) || ["default", "public"].includes(row.beta_branch)
    || !row.branch_password_secret_ref || !SECRET_REF.test(row.branch_password_secret_ref)
    || row.mfa_approval_id !== null || row.state !== "WAITING_MFA" || row.external_gate !== "NONE" || row.version !== 1
    || JSON.stringify(matrix(row.target_matrix)) !== JSON.stringify(input.targetMatrix)) invalid();
  return Object.freeze({
    releaseId: row.id,
    workflowId: input.workflowId,
    runId: input.runId,
    mainCommitSha: input.mainCommitSha,
    mainEvidenceBundleId: input.mainEvidenceBundleId,
    releaseConfigurationId: row.release_configuration_id,
    targetMatrix: Object.freeze([...input.targetMatrix]),
    state: "WAITING_MFA",
  });
}

function validatePreparationInput(input: SteamReleasePreparationInput): void {
  if (!UUID.test(input.tenantId) || !UUID.test(input.projectId) || !UUID.test(input.runId)
    || !UUID.test(input.mainEvidenceBundleId) || !SAFE_ID.test(input.workflowId) || !SHA1.test(input.mainCommitSha)) invalid();
  matrix(input.targetMatrix);
}

function validatePrivateBetaRequest(request: SteamPrivateBetaOperationRequest): void {
  if (!UUID.test(request.tenantId) || !UUID.test(request.projectId) || !UUID.test(request.runId)
    || !UUID.test(request.mainEvidenceBundleId) || !UUID.test(request.mfaApprovalId)
    || !SAFE_ID.test(request.workflowId) || !SHA1.test(request.mainCommitSha)) invalid();
  matrix(request.targetMatrix);
}

function matrix(value: unknown): readonly ("windows" | "linux" | "macos")[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3
    || value.some((item) => !PLATFORMS.has(item as never)) || new Set(value).size !== value.length
    || JSON.stringify([...value].sort()) !== JSON.stringify(value)) invalid();
  return Object.freeze([...value]) as readonly ("windows" | "linux" | "macos")[];
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalid();
  return value as string[];
}

async function transaction<T>(
  pool: PostgresWorkflowPool,
  tenantId: string,
  action: (client: PostgresWorkflowClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) invalid();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve lifecycle failure */ }
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

function exactNow(value: Date): Date { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid(); return value; }
function jsonValue(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown; } catch { invalid(); } }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function invalid(): never { throw new Error("PostgreSQL Steam release lifecycle is invalid"); }
