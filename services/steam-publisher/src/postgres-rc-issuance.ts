import { sha256Canonical } from "../../runner-control/src/canonical";
import { runnerArtifactObjectKey } from "../../evidence-archive/src/runner-artifacts";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { SteamTargetPlatform } from "./contracts";
import type { SteamPrivateBetaOperationRequest } from "./workflow-broker-http";
import {
  validateSignedSteamRcArtifact,
  type SteamRcArchivedArtifact,
  type SteamRcArtifactArchive,
  type SteamRcIssuanceAuthority,
  type SteamRcIssuanceSnapshot,
} from "./rc-issuance";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const PLATFORMS = new Set<SteamTargetPlatform>(["windows", "linux", "macos"]);

type AuthorityRow = {
  release_id: string;
  release_main_commit_sha: string;
  release_steam_app_id: string;
  release_evidence_bundle_id: string;
  release_mfa_approval_id: string;
  evidence_bundle_digest: string;
  evidence_source_digest: string;
  evidence_manifest: unknown;
  evidence_status: string;
  evidence_invalidated_at: string | null;
  attempt_id: string;
  attempt_run_id: string;
  attempt_mode: string;
  attempt_state: string;
  depot_configuration_id: string;
  depot_configuration_steam_app_id: string;
  depot_configuration_platform_depots: unknown;
  depot_configuration_digest: string;
};

type ArtifactRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  run_id: string;
  release_id: string;
  main_evidence_bundle_id: string;
  depot_configuration_id: string | null;
  depot_configuration_digest: string | null;
  artifact_digest: string;
  signed_artifact: unknown;
  created_at: string;
};

/** Resolves the exact passed merged-main evidence and its frozen depot revision. */
export class PostgresSteamRcIssuanceAuthority implements SteamRcIssuanceAuthority {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async resolve(request: SteamPrivateBetaOperationRequest): Promise<SteamRcIssuanceSnapshot> {
    validateRequest(request);
    return this.#transaction(request.tenantId, async (client) => {
      const selected = await client.query<AuthorityRow>(
        `SELECT release.id::text AS release_id,
                release.main_commit_sha AS release_main_commit_sha,
                release.steam_app_id AS release_steam_app_id,
                release.evidence_bundle_id::text AS release_evidence_bundle_id,
                release.mfa_approval_id::text AS release_mfa_approval_id,
                evidence.bundle_digest::text AS evidence_bundle_digest,
                evidence.source_digest AS evidence_source_digest,
                evidence.manifest AS evidence_manifest,
                evidence.status AS evidence_status,
                evidence.invalidated_at::text AS evidence_invalidated_at,
                attempt.id::text AS attempt_id,
                attempt.run_id::text AS attempt_run_id,
                attempt.mode AS attempt_mode,
                attempt.state AS attempt_state,
                depot.id::text AS depot_configuration_id,
                depot.steam_app_id AS depot_configuration_steam_app_id,
                depot.platform_depots AS depot_configuration_platform_depots,
                depot.configuration_digest::text AS depot_configuration_digest
           FROM deviludo.steam_releases release
           JOIN deviludo.evidence_bundles evidence
             ON evidence.tenant_id = release.tenant_id
            AND evidence.project_id = release.project_id
            AND evidence.id = release.evidence_bundle_id
           JOIN deviludo.e2e_attempts attempt
             ON attempt.tenant_id = evidence.tenant_id
            AND attempt.project_id = evidence.project_id
            AND attempt.id = evidence.attempt_id
           LEFT JOIN deviludo.steam_rc_artifacts rc
             ON rc.tenant_id = release.tenant_id AND rc.release_id = release.id
           JOIN deviludo.steam_project_depot_configurations depot
             ON depot.tenant_id = release.tenant_id
            AND depot.project_id = release.project_id
            AND depot.steam_app_id = release.steam_app_id
            AND ((rc.id IS NULL AND depot.state = 'ACTIVE')
              OR (rc.id IS NOT NULL AND depot.id = rc.depot_configuration_id
                AND depot.configuration_digest = rc.depot_configuration_digest))
          WHERE release.tenant_id = $1::uuid AND release.project_id = $2::uuid
            AND release.main_commit_sha = $3
            AND release.evidence_bundle_id = $4::uuid
            AND release.mfa_approval_id = $5::uuid
            AND release.state = 'STEAM_PRIVATE_BETA'
            AND evidence.status = 'PASSED' AND evidence.invalidated_at IS NULL
            AND attempt.run_id = $6::uuid
            AND attempt.mode = 'MAIN_RELEASE_GATE' AND attempt.state = 'PASSED'
          FOR SHARE OF release, evidence, attempt, depot`,
        [request.tenantId, request.projectId, request.mainCommitSha,
          request.mainEvidenceBundleId, request.mfaApprovalId, request.runId],
      );
      if (selected.rows.length !== 1) invalid();
      return snapshotFromRow(selected.rows[0]!, request);
    });
  }

  async probe(): Promise<void> { await probe(this.pool); }

  async #transaction<T>(tenantId: string, action: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    return transaction(this.pool, tenantId, action);
  }
}

/** Append-only RC archive with exact idempotent replay semantics. */
export class PostgresSteamRcArtifactArchive implements SteamRcArtifactArchive {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async find(input: Readonly<{ tenantId: string; releaseId: string }>): Promise<SteamRcArchivedArtifact | null> {
    validateUuid(input.tenantId);
    validateUuid(input.releaseId);
    return transaction(this.pool, input.tenantId, async (client) => {
      const selected = await selectArtifact(client, input.tenantId, input.releaseId);
      return selected ? parseArtifactRow(selected).archived : null;
    });
  }

  async persist(input: Parameters<SteamRcArtifactArchive["persist"]>[0]): Promise<SteamRcArchivedArtifact> {
    validateUuid(input.artifactId);
    const snapshot = input.snapshot;
    validateUuid(snapshot.tenantId);
    validateUuid(snapshot.projectId);
    validateUuid(snapshot.runId);
    validateUuid(snapshot.releaseId);
    validateUuid(snapshot.mainEvidenceBundleId);
    validateUuid(snapshot.depotConfigurationId);
    if (!SHA256.test(input.artifactDigest) || !SHA256.test(snapshot.depotConfigurationDigest)
      || !Number.isFinite(Date.parse(input.createdAt)) || new Date(input.createdAt).toISOString() !== input.createdAt) invalid();
    const artifact = validateSignedSteamRcArtifact(input.artifact);
    if (sha256Canonical(artifact) !== input.artifactDigest) invalid();
    return transaction(this.pool, snapshot.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deviludo.steam_rc_artifacts
          (id, tenant_id, project_id, run_id, release_id, main_evidence_bundle_id,
           depot_configuration_id, depot_configuration_digest,
           artifact_digest, signed_artifact, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
                 $7::uuid, $8, $9, $10::jsonb, $11::timestamptz)
         ON CONFLICT (tenant_id, release_id) DO NOTHING`,
        [input.artifactId, snapshot.tenantId, snapshot.projectId, snapshot.runId,
          snapshot.releaseId, snapshot.mainEvidenceBundleId, snapshot.depotConfigurationId,
          snapshot.depotConfigurationDigest, input.artifactDigest, JSON.stringify(artifact), input.createdAt],
      );
      const row = await selectArtifact(client, snapshot.tenantId, snapshot.releaseId);
      if (!row) invalid();
      const parsed = parseArtifactRow(row);
      if (parsed.projectId !== snapshot.projectId || parsed.runId !== snapshot.runId
        || parsed.mainEvidenceBundleId !== snapshot.mainEvidenceBundleId
        || parsed.archived.depotConfigurationId !== snapshot.depotConfigurationId
        || parsed.archived.depotConfigurationDigest !== snapshot.depotConfigurationDigest
        || parsed.archived.artifactDigest !== input.artifactDigest
        || sha256Canonical(parsed.archived.artifact) !== sha256Canonical(artifact)) invalid();
      return parsed.archived;
    });
  }

  async probe(): Promise<void> { await probe(this.pool); }
}

function snapshotFromRow(row: AuthorityRow, request: SteamPrivateBetaOperationRequest): SteamRcIssuanceSnapshot {
  if (!UUID.test(row.release_id) || row.release_main_commit_sha !== request.mainCommitSha
    || !NUMERIC_ID.test(row.release_steam_app_id) || row.release_evidence_bundle_id !== request.mainEvidenceBundleId
    || row.release_mfa_approval_id !== request.mfaApprovalId || !SHA256.test(row.evidence_bundle_digest)
    || !SHA256.test(row.evidence_source_digest) || row.evidence_status !== "PASSED" || row.evidence_invalidated_at !== null
    || !UUID.test(row.attempt_id) || row.attempt_run_id !== request.runId
    || row.attempt_mode !== "MAIN_RELEASE_GATE" || row.attempt_state !== "PASSED"
    || !UUID.test(row.depot_configuration_id) || row.depot_configuration_steam_app_id !== row.release_steam_app_id
    || !SHA256.test(row.depot_configuration_digest)) invalid();
  const evidence = evidenceManifest(row.evidence_manifest, row.evidence_bundle_digest);
  if (evidence.id !== request.mainEvidenceBundleId || evidence.attemptId !== row.attempt_id
    || evidence.commitSha !== request.mainCommitSha || evidence.sourceDigest !== row.evidence_source_digest
    || JSON.stringify(evidence.targetMatrix) !== JSON.stringify(request.targetMatrix)) invalid();
  const platformDepots = depotConfiguration(
    row.depot_configuration_platform_depots,
    row.depot_configuration_steam_app_id,
    row.depot_configuration_digest,
  );
  if (JSON.stringify(Object.keys(platformDepots).sort()) !== JSON.stringify(request.targetMatrix)) invalid();
  const evidenceByPlatform = new Map(evidence.platformEvidence.map((item) => [item.platform, item]));
  const depots = request.targetMatrix.map((platform) => {
    const platformEvidence = evidenceByPlatform.get(platform);
    const depotId = platformDepots[platform];
    if (!platformEvidence || !depotId) invalid();
    return Object.freeze({
      platform,
      depotId,
      objectKey: runnerArtifactObjectKey(
        request.tenantId, request.projectId, evidence.attemptId, platform, "production-export", platformEvidence.exportDigest,
      ),
      artifactDigest: platformEvidence.exportDigest,
    });
  });
  return deepFreeze({
    tenantId: request.tenantId,
    projectId: request.projectId,
    runId: request.runId,
    releaseId: row.release_id,
    mainEvidenceBundleId: request.mainEvidenceBundleId,
    mainCommitSha: evidence.commitSha,
    sourceDigest: evidence.sourceDigest,
    specRevisionId: evidence.specRevisionId,
    specDigest: evidence.specDigest,
    testPlanDigest: evidence.testPlanDigest,
    evidenceBundleDigest: row.evidence_bundle_digest,
    steamAppId: row.release_steam_app_id,
    targetMatrix: evidence.targetMatrix,
    depotConfigurationId: row.depot_configuration_id,
    depotConfigurationDigest: row.depot_configuration_digest,
    depots,
  });
}

function evidenceManifest(value: unknown, expectedDigest: string) {
  const body = record(jsonValue(value));
  exactKeys(body, ["id", "attemptId", "specRevisionId", "specDigest", "testPlanDigest", "commitSha", "sourceDigest",
    "targetMatrix", "godotTestKitDigest", "buildManifestDigest", "sbomDigest", "vulnerabilityScanDigest",
    "assetLicenseLedgerDigest", "platformEvidence", "bundleDigest", "status", "valid", "createdAt"]);
  const targetMatrix = matrix(body.targetMatrix);
  if (typeof body.id !== "string" || !UUID.test(body.id) || typeof body.attemptId !== "string" || !UUID.test(body.attemptId)
    || typeof body.specRevisionId !== "string" || !SAFE_ID.test(body.specRevisionId)
    || typeof body.specDigest !== "string" || !SHA256.test(body.specDigest)
    || typeof body.testPlanDigest !== "string" || !SHA256.test(body.testPlanDigest)
    || typeof body.commitSha !== "string" || !SHA1.test(body.commitSha)
    || typeof body.sourceDigest !== "string" || !SHA256.test(body.sourceDigest)
    || typeof body.bundleDigest !== "string" || body.bundleDigest !== expectedDigest
    || body.status !== "PASSED" || body.valid !== true || typeof body.createdAt !== "string"
    || !Number.isFinite(Date.parse(body.createdAt))
    || ![body.godotTestKitDigest, body.buildManifestDigest, body.sbomDigest,
      body.vulnerabilityScanDigest, body.assetLicenseLedgerDigest].every((item) => typeof item === "string" && SHA256.test(item))) invalid();
  if (!Array.isArray(body.platformEvidence) || body.platformEvidence.length !== targetMatrix.length) invalid();
  const platformEvidence = body.platformEvidence.map((value) => {
    const item = record(value);
    exactKeys(item, ["platform", "runnerId", "runnerCapabilityDigest", "exportDigest", "logsDigest", "junitDigest",
      "inputTimelineDigest", "screenshotManifestDigest", "videoManifestDigest", "status"]);
    if (!isPlatform(item.platform) || typeof item.runnerId !== "string" || !SAFE_ID.test(item.runnerId)
      || item.status !== "PASSED" || ![item.runnerCapabilityDigest, item.exportDigest, item.logsDigest, item.junitDigest,
        item.inputTimelineDigest, item.screenshotManifestDigest, item.videoManifestDigest]
        .every((digest) => typeof digest === "string" && SHA256.test(digest))) invalid();
    return Object.freeze({ platform: item.platform, exportDigest: item.exportDigest as string });
  });
  if (JSON.stringify(platformEvidence.map((item) => item.platform)) !== JSON.stringify(targetMatrix)) invalid();
  const core = { ...body };
  delete core.bundleDigest;
  if (sha256Canonical(core) !== expectedDigest) invalid();
  return Object.freeze({
    id: body.id,
    attemptId: body.attemptId,
    specRevisionId: body.specRevisionId,
    specDigest: body.specDigest,
    testPlanDigest: body.testPlanDigest,
    commitSha: body.commitSha,
    sourceDigest: body.sourceDigest,
    targetMatrix,
    platformEvidence: Object.freeze(platformEvidence),
  });
}

function depotConfiguration(value: unknown, steamAppId: string, expectedDigest: string): Readonly<Partial<Record<SteamTargetPlatform, string>>> {
  const body = record(jsonValue(value));
  const keys = Object.keys(body).sort();
  if (keys.length < 1 || keys.length > 3 || keys.some((key) => !PLATFORMS.has(key as SteamTargetPlatform))) invalid();
  const output: Partial<Record<SteamTargetPlatform, string>> = {};
  for (const key of keys) {
    const depotId = body[key];
    if (typeof depotId !== "string" || !NUMERIC_ID.test(depotId)) invalid();
    output[key as SteamTargetPlatform] = depotId;
  }
  if (new Set(Object.values(output)).size !== keys.length
    || sha256Canonical({
      schemaVersion: "deviludo.steam-depot-configuration.v1",
      steamAppId,
      platformDepots: output,
    }) !== expectedDigest) invalid();
  return Object.freeze(output);
}

async function selectArtifact(
  client: PostgresWorkflowClient,
  tenantId: string,
  releaseId: string,
): Promise<ArtifactRow | null> {
  const selected = await client.query<ArtifactRow>(
    `SELECT id::text, tenant_id::text, project_id::text, run_id::text,
            release_id::text, main_evidence_bundle_id::text,
            depot_configuration_id::text, depot_configuration_digest::text,
            artifact_digest::text, signed_artifact, created_at::text
       FROM deviludo.steam_rc_artifacts
      WHERE tenant_id = $1::uuid AND release_id = $2::uuid`,
    [tenantId, releaseId],
  );
  if (selected.rows.length > 1) invalid();
  return selected.rows[0] ?? null;
}

function parseArtifactRow(row: ArtifactRow): Readonly<{
  projectId: string;
  runId: string;
  mainEvidenceBundleId: string;
  archived: SteamRcArchivedArtifact;
}> {
  if (!UUID.test(row.id) || !UUID.test(row.tenant_id) || !UUID.test(row.project_id) || !UUID.test(row.run_id)
    || !UUID.test(row.release_id) || !UUID.test(row.main_evidence_bundle_id)
    || !row.depot_configuration_id || !UUID.test(row.depot_configuration_id)
    || !row.depot_configuration_digest || !SHA256.test(row.depot_configuration_digest)
    || !SHA256.test(row.artifact_digest) || !Number.isFinite(Date.parse(row.created_at))) invalid();
  const artifact = validateSignedSteamRcArtifact(jsonValue(row.signed_artifact));
  if (artifact.claims.tenantId !== row.tenant_id || artifact.claims.projectId !== row.project_id
    || artifact.claims.releaseId !== row.release_id || sha256Canonical(artifact) !== row.artifact_digest) invalid();
  return deepFreeze({
    projectId: row.project_id,
    runId: row.run_id,
    mainEvidenceBundleId: row.main_evidence_bundle_id,
    archived: {
      artifact,
      artifactDigest: row.artifact_digest,
      depotConfigurationId: row.depot_configuration_id,
      depotConfigurationDigest: row.depot_configuration_digest,
    },
  });
}

function validateRequest(value: SteamPrivateBetaOperationRequest): void {
  if (!UUID.test(value.tenantId) || !UUID.test(value.projectId) || !UUID.test(value.runId)
    || !UUID.test(value.mainEvidenceBundleId) || !UUID.test(value.mfaApprovalId)
    || !SHA1.test(value.mainCommitSha)) invalid();
  matrix(value.targetMatrix);
}

async function transaction<T>(
  pool: PostgresWorkflowPool,
  tenantId: string,
  action: (client: PostgresWorkflowClient) => Promise<T>,
): Promise<T> {
  validateUuid(tenantId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve issuance failure */ }
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

function matrix(value: unknown): readonly SteamTargetPlatform[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3
    || value.some((item) => !isPlatform(item)) || new Set(value).size !== value.length
    || JSON.stringify([...value].sort()) !== JSON.stringify(value)) invalid();
  return Object.freeze([...value]) as readonly SteamTargetPlatform[];
}

function isPlatform(value: unknown): value is SteamTargetPlatform { return PLATFORMS.has(value as SteamTargetPlatform); }
function validateUuid(value: string): void { if (!UUID.test(value)) invalid(); }
function jsonValue(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown; } catch { invalid(); } }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exactKeys(body: Record<string, unknown>, expected: readonly string[]): void { const actual = Object.keys(body).sort(); const sorted = [...expected].sort(); if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid(); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
function invalid(): never { throw new Error("PostgreSQL Steam RC issuance authority is invalid"); }
