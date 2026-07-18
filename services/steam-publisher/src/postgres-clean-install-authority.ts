import { parseRunnerToolchainRevision } from "../../artifact-preparer/src/contracts";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import {
  parseSteamCleanInstallPreparationTrigger,
  type SteamCleanInstallAuthorityResolution,
  type SteamCleanInstallPreparationAuthority,
} from "./clean-install-preparation";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

type AuthorityRow = {
  run_id: string;
  configuration_lock: unknown;
  spec_revision_id: string;
  spec_payload: unknown;
  spec_digest: string;
  test_plan_digest: string;
  target_matrix: string[];
  required_godot_version: string;
  runner_toolchain_revision_id: string;
  runner_toolchain_digest: string;
  toolchain_payload: unknown;
  toolchain_payload_digest: string;
  main_attempt_mode: string | null;
  main_attempt_state: string;
  main_attempt_commit_sha: string;
  main_attempt_source_digest: string;
  main_attempt_target_matrix: string[];
  main_evidence_status: string;
  main_evidence_commit_sha: string;
  main_evidence_source_digest: string;
  main_evidence_bundle_digest: string;
  main_evidence_invalidated_at: string | null;
  release_main_commit_sha: string;
  release_steam_app_id: string;
  build_receipt_id: string;
  build_steam_app_id: string;
  build_id: string;
  build_main_commit_sha: string;
  build_source_digest: string;
  build_evidence_bundle_digest: string;
  beta_branch: string;
  install_attempts: unknown;
  install_reservations: unknown;
  build_state: string;
};

/** Re-resolves the clean-install Build and its passed main gate under tenant RLS. */
export class PostgresSteamCleanInstallPreparationAuthority implements SteamCleanInstallPreparationAuthority {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async resolve(value: unknown): Promise<SteamCleanInstallAuthorityResolution> {
    const trigger = parseSteamCleanInstallPreparationTrigger(value);
    return this.#transaction(trigger.tenantId, async (client) => {
      const result = await client.query<AuthorityRow>(
        `SELECT run.id::text AS run_id,
                run.configuration_lock,
                spec.id::text AS spec_revision_id,
                spec.payload AS spec_payload,
                spec.payload_digest AS spec_digest,
                binding.test_plan_digest::text,
                binding.target_matrix,
                binding.required_godot_version,
                binding.runner_toolchain_revision_id::text,
                binding.runner_toolchain_digest::text,
                toolchain.payload AS toolchain_payload,
                toolchain.payload_digest::text AS toolchain_payload_digest,
                main_attempt.mode AS main_attempt_mode,
                main_attempt.state AS main_attempt_state,
                main_attempt.commit_sha AS main_attempt_commit_sha,
                main_attempt.source_digest AS main_attempt_source_digest,
                main_attempt.target_matrix AS main_attempt_target_matrix,
                main_evidence.status AS main_evidence_status,
                main_evidence.commit_sha AS main_evidence_commit_sha,
                main_evidence.source_digest AS main_evidence_source_digest,
                main_evidence.bundle_digest AS main_evidence_bundle_digest,
                main_evidence.invalidated_at::text AS main_evidence_invalidated_at,
                release.main_commit_sha AS release_main_commit_sha,
                release.steam_app_id AS release_steam_app_id,
                build.id::text AS build_receipt_id,
                build.steam_app_id AS build_steam_app_id,
                build.build_id,
                build.main_commit_sha AS build_main_commit_sha,
                build.source_digest AS build_source_digest,
                build.evidence_bundle_digest AS build_evidence_bundle_digest,
                build.beta_branch,
                build.install_attempts,
                (SELECT jsonb_object_agg(reservation.platform, reservation.id::text ORDER BY reservation.platform)
                   FROM deviludo.steam_clean_install_reservations reservation
                  WHERE reservation.tenant_id = build.tenant_id
                    AND reservation.project_id = build.project_id
                    AND reservation.release_id = build.release_id
                    AND reservation.build_id = build.build_id) AS install_reservations,
                build.state AS build_state
           FROM deviludo.steam_build_receipts build
           JOIN deviludo.steam_releases release
             ON release.id = build.release_id
            AND release.tenant_id = build.tenant_id
            AND release.project_id = build.project_id
            AND release.steam_app_id = build.steam_app_id
            AND release.main_commit_sha = build.main_commit_sha
           JOIN deviludo.evidence_bundles main_evidence
             ON main_evidence.id = release.evidence_bundle_id
            AND main_evidence.tenant_id = release.tenant_id
            AND main_evidence.project_id = release.project_id
            AND main_evidence.bundle_digest = build.evidence_bundle_digest
           JOIN deviludo.e2e_attempts main_attempt
             ON main_attempt.id = main_evidence.attempt_id
            AND main_attempt.tenant_id = main_evidence.tenant_id
            AND main_attempt.project_id = main_evidence.project_id
           JOIN deviludo.agent_runs run
             ON run.id = main_attempt.run_id
            AND run.tenant_id = main_attempt.tenant_id
            AND run.project_id = main_attempt.project_id
           JOIN deviludo.immutable_revisions spec
             ON spec.id = (run.configuration_lock->>'specRevisionId')::uuid
            AND spec.tenant_id = run.tenant_id
            AND spec.project_id = run.project_id
            AND spec.aggregate_type = 'GAME_SPEC'
            AND spec.state = 'APPROVED'
           JOIN deviludo.approved_test_plan_bindings binding
             ON binding.tenant_id = run.tenant_id
            AND binding.project_id = run.project_id
            AND binding.spec_revision_id = spec.id
           JOIN deviludo.runner_toolchain_revisions toolchain
             ON toolchain.tenant_id = binding.tenant_id
            AND toolchain.project_id = binding.project_id
            AND toolchain.id = binding.runner_toolchain_revision_id
            AND toolchain.payload_digest = binding.runner_toolchain_digest
          WHERE build.tenant_id = $1::uuid
            AND build.project_id = $2::uuid
            AND main_attempt.run_id = $3::uuid
            AND build.main_commit_sha = $4
            AND build.build_id = $5
            AND build.state = 'INSTALL_TESTING'
            AND main_attempt.mode = 'MAIN_RELEASE_GATE'
            AND main_attempt.state = 'PASSED'
            AND main_evidence.status = 'PASSED'
            AND main_evidence.invalidated_at IS NULL
          FOR SHARE OF build, release, main_evidence, main_attempt, run, spec, binding, toolchain`,
        [trigger.tenantId, trigger.projectId, trigger.runId, trigger.commitSha, trigger.steamBuildId],
      );
      if (result.rows.length !== 1) invalid();
      const row = result.rows[0]!;
      const locked = parseConfigurationLock(row.configuration_lock);
      if (row.run_id !== trigger.runId || row.spec_revision_id !== locked.specRevisionId
        || row.spec_digest !== locked.specDigest || row.test_plan_digest !== locked.testPlanDigest
        || row.runner_toolchain_revision_id !== locked.runnerToolchainRevisionId
        || row.runner_toolchain_digest !== locked.runnerToolchainDigest
        || row.toolchain_payload_digest !== row.runner_toolchain_digest
        || sha256Canonical(row.spec_payload) !== row.spec_digest
        || sha256Canonical(row.toolchain_payload) !== row.runner_toolchain_digest
        || !sameMatrix(row.target_matrix, trigger.targetMatrix)
        || !sameMatrix(row.main_attempt_target_matrix, trigger.targetMatrix)
        || !sameMatrix(locked.targetMatrix, trigger.targetMatrix)
        || row.main_attempt_mode !== "MAIN_RELEASE_GATE" || row.main_attempt_state !== "PASSED"
        || row.main_evidence_status !== "PASSED" || row.main_evidence_invalidated_at !== null
        || row.main_attempt_commit_sha !== trigger.commitSha
        || row.main_evidence_commit_sha !== trigger.commitSha
        || row.release_main_commit_sha !== trigger.commitSha
        || row.build_main_commit_sha !== trigger.commitSha
        || row.main_attempt_source_digest !== row.build_source_digest
        || row.main_evidence_source_digest !== row.build_source_digest
        || row.main_evidence_bundle_digest !== row.build_evidence_bundle_digest
        || row.release_steam_app_id !== row.build_steam_app_id
        || row.build_id !== trigger.steamBuildId || row.build_state !== "INSTALL_TESTING"
        || !UUID.test(row.build_receipt_id) || !SHA256.test(row.build_source_digest)
        || !validInstallAttempts(row.install_attempts, trigger.targetMatrix)
        || !sameInstallHandles(row.install_attempts, row.install_reservations, trigger.targetMatrix)) invalid();
      const toolchain = parseRunnerToolchainRevision(row.toolchain_payload, trigger.targetMatrix);
      if (row.required_godot_version !== toolchain.requiredGodotVersion) invalid();
      return Object.freeze({
        trigger,
        buildReceiptId: row.build_receipt_id,
        sourceDigest: row.build_source_digest,
        specRevisionId: row.spec_revision_id,
        specDigest: row.spec_digest,
        testPlanDigest: row.test_plan_digest,
        runnerToolchainRevisionId: row.runner_toolchain_revision_id,
        runnerToolchainDigest: row.runner_toolchain_digest,
        toolchain,
        steamAppId: row.build_steam_app_id,
        betaBranch: row.beta_branch,
      });
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ ready: number }>("SELECT 1 AS ready");
      if (result.rows.length !== 1 || result.rows[0]?.ready !== 1) invalid();
    } finally { client.release(); }
  }

  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
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
}

function parseConfigurationLock(value: unknown): Readonly<{
  specRevisionId: string;
  specDigest: string;
  testPlanDigest: string;
  runnerToolchainRevisionId: string;
  runnerToolchainDigest: string;
  targetMatrix: readonly string[];
}> {
  const body = record(value);
  const targetMatrix = body.targetMatrix;
  if (!Array.isArray(targetMatrix) || targetMatrix.some((item) => typeof item !== "string")) invalid();
  return Object.freeze({
    specRevisionId: text(body.specRevisionId, UUID),
    specDigest: text(body.specDigest, SHA256),
    testPlanDigest: text(body.testPlanDigest, SHA256),
    runnerToolchainRevisionId: text(body.runnerToolchainRevisionId, UUID),
    runnerToolchainDigest: text(body.runnerToolchainDigest, SHA256),
    targetMatrix: Object.freeze([...targetMatrix]) as readonly string[],
  });
}

function validInstallAttempts(value: unknown, matrix: readonly string[]): boolean {
  const body = record(value);
  const keys = Object.keys(body).sort();
  return JSON.stringify(keys) === JSON.stringify(matrix)
    && keys.every((platform) => typeof body[platform] === "string" && SAFE_ID.test(body[platform]));
}

function sameInstallHandles(left: unknown, right: unknown, matrix: readonly string[]): boolean {
  const attempts = record(left);
  const reservations = record(right);
  return JSON.stringify(Object.keys(reservations).sort()) === JSON.stringify(matrix)
    && matrix.every((platform) => typeof reservations[platform] === "string"
      && UUID.test(reservations[platform] as string) && attempts[platform] === reservations[platform]);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}

function sameMatrix(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invalid(): never {
  throw new Error("Steam clean-install authority receipt is invalid");
}
