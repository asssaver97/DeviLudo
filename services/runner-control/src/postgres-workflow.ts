import { createEvidenceBundle, type EvidenceBundle, type PlatformEvidence } from "../../../lib/domain/e2e";
import type { TargetPlatform } from "../../../lib/domain/types";
import { WorkflowJobError } from "../../temporal/src/job-processor";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { probePostgresRelations } from "../../temporal/src/postgres-readiness";
import { sha256Canonical } from "./canonical";
import { parseRunnerExecutionLock, runnerExecutionLockDigest, type RunnerExecutionLock } from "./execution-lock";
import type { RunnerWorkflowPort, RunnerWorkflowReceipt } from "./workflow-handler";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TARGETS = new Set<TargetPlatform>(["windows", "linux", "macos"]);

type WorkflowInput = Parameters<RunnerWorkflowPort["execute"]>[0];
type AttemptRow = {
  id: string;
  run_id: string;
  workflow_id: string;
  workflow_operation_key: string;
  workflow_request_digest: string;
  execution_lock_id: string;
  mode: string;
  commit_sha: string;
  source_digest: string;
  binding: unknown;
  target_matrix: string[];
  draft_pull_request: string | number | null;
  steam_build_id: string | null;
  state: string;
  repair_prompt_id: string | null;
  completed_at: string | null;
};

type EvidenceRow = {
  id: string | null;
  commit_sha: string | null;
  source_digest: string | null;
  binding: unknown | null;
  manifest: unknown | null;
  bundle_digest: string | null;
  object_key: string | null;
  status: string | null;
  invalidated_at: string | null;
};

type LockedRun = {
  iteration_id: string;
  configuration_lock: unknown;
};

type SourceBinding = {
  source_digest: string | null;
  spec_revision_id: string | null;
};

type ExecutionLockRow = {
  id: string;
  payload: unknown;
  payload_digest: string;
};

type SteamInstallProjectionRow = {
  build_receipt_id: string;
  build_state: string;
  steam_install_evidence_bundle_digest: string | null;
  release_id: string;
  release_state: string;
  external_gate: string;
  workflow_id: string;
  release_run_id: string;
  main_commit_sha: string;
  build_id: string;
  target_matrix: string[];
  evidence_id: string;
  evidence_bundle_digest: string;
};

type LockedConfiguration = {
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanDigest: string;
  readonly runnerToolchainRevisionId: string;
  readonly runnerToolchainDigest: string;
  readonly targetMatrix: readonly TargetPlatform[];
};

type AttemptBinding = LockedConfiguration & {
  readonly schemaVersion: "deviludo.e2e-attempt.v1";
  readonly workflowId: string;
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly iterationId: string;
  readonly mode: WorkflowInput["mode"];
  readonly executionLockId: string;
  readonly executionLockDigest: string;
};

/**
 * Production workflow adapter. It schedules only immutable PostgreSQL attempts;
 * the separately authenticated Runner ingress owns leases/events and is the
 * only component allowed to move an attempt to a terminal state.
 */
export class PostgresRunnerWorkflowPort implements RunnerWorkflowPort {
  readonly #pool: PostgresWorkflowPool;
  readonly #pollIntervalMs: number;
  readonly #maxWaitMs: number;
  readonly #pause: (delayMs: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: {
    readonly pool: PostgresWorkflowPool;
    readonly pollIntervalMs?: number;
    readonly maxWaitMs?: number;
    readonly pause?: (delayMs: number) => Promise<void>;
    readonly now?: () => number;
  }) {
    this.#pool = options.pool;
    this.#pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 5_000, 250, 60_000, "poll interval");
    this.#maxWaitMs = boundedInteger(options.maxWaitMs ?? 2 * 60 * 60_000, 30_000, 24 * 60 * 60_000, "maximum wait");
    this.#pause = options.pause ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.#now = options.now ?? Date.now;
  }

  async probe(): Promise<void> {
    await probePostgresRelations(this.#pool, [
      "agent_runs",
      "e2e_attempts",
      "evidence_bundles",
      "github_candidate_receipts",
      "github_merge_receipts",
      "runner_execution_locks",
      "steam_build_receipts",
      "steam_release_revocations",
      "steam_releases",
    ], () => new Error("Runner workflow PostgreSQL schema is not ready"));
  }

  async execute(input: WorkflowInput): Promise<RunnerWorkflowReceipt> {
    validateInput(input);
    const attempt = await this.#ensureAttempt(input);
    const startedAt = validNow(this.#now());
    const deadline = startedAt + this.#maxWaitMs;
    while (validNow(this.#now()) < deadline) {
      const terminal = await this.#readTerminal(input, attempt.id);
      if (terminal) return terminal;
      await input.heartbeat();
      await this.#pause(this.#pollIntervalMs);
    }
    throw new WorkflowJobError("RUNNER_ATTEMPT_WAIT_TIMEOUT");
  }

  async #ensureAttempt(input: WorkflowInput): Promise<AttemptRow> {
    return this.#transaction(input.tenantId, async (client) => {
      const runResult = await client.query<LockedRun>(
        `SELECT iteration_id::text, configuration_lock
           FROM deviludo.agent_runs
          WHERE tenant_id = $1::uuid
            AND project_id = $2::uuid
            AND id = $3::uuid
          FOR UPDATE`,
        [input.tenantId, input.projectId, input.runId],
      );
      const run = onlyRow(runResult.rows, "Agent run is not visible in the authorized tenant");
      const locked = parseLockedConfiguration(run.configuration_lock);
      if (JSON.stringify(locked.targetMatrix) !== JSON.stringify(input.targetMatrix)) {
        throw new WorkflowJobError("RUNNER_TARGET_MATRIX_LOCK_MISMATCH", true);
      }

      const source = await this.#resolveSource(client, input);
      if (!source.source_digest || !SHA256.test(source.source_digest)
        || source.spec_revision_id !== locked.specRevisionId) {
        throw new WorkflowJobError("RUNNER_SOURCE_BINDING_MISSING");
      }
      const executionLock = await this.#resolveExecutionLock(client, input, locked, source.source_digest);
      const binding: AttemptBinding = Object.freeze({
        schemaVersion: "deviludo.e2e-attempt.v1",
        workflowId: input.workflowId,
        operationKey: input.operationKey,
        requestDigest: input.requestDigest,
        iterationId: run.iteration_id,
        mode: input.mode,
        executionLockId: executionLock.id,
        executionLockDigest: executionLock.digest,
        ...locked,
      });
      await client.query(
        `INSERT INTO deviludo.e2e_attempts
          (tenant_id, project_id, run_id, attempt_number, commit_sha,
           source_digest, binding, target_matrix, state, workflow_id,
           workflow_operation_key, workflow_request_digest, mode,
           draft_pull_request, steam_build_id, execution_lock_id)
         SELECT $1::uuid, $2::uuid, $3::uuid,
                COALESCE(MAX(existing.attempt_number), 0) + 1,
                $4, $5, $6::jsonb, $7::text[], 'QUEUED', $8, $9, $10, $11,
                $12::bigint, $13, $14::uuid
           FROM deviludo.e2e_attempts existing
          WHERE existing.tenant_id = $1::uuid
            AND existing.run_id = $3::uuid
         ON CONFLICT (tenant_id, workflow_operation_key) DO NOTHING`,
        [
          input.tenantId,
          input.projectId,
          input.runId,
          input.commitSha,
          source.source_digest,
          JSON.stringify(binding),
          input.targetMatrix,
          input.workflowId,
          input.operationKey,
          input.requestDigest,
          input.mode,
          input.draftPullRequest,
          input.steamBuildId,
          executionLock.id,
        ],
      );
      const selected = await client.query<AttemptRow>(
        `SELECT id::text, run_id::text, workflow_id, workflow_operation_key,
                workflow_request_digest, execution_lock_id::text, mode, commit_sha, source_digest,
                binding, target_matrix, draft_pull_request, steam_build_id,
                state, repair_prompt_id, completed_at::text
           FROM deviludo.e2e_attempts
          WHERE tenant_id = $1::uuid
            AND project_id = $2::uuid
            AND workflow_operation_key = $3
          FOR UPDATE`,
        [input.tenantId, input.projectId, input.operationKey],
      );
      const attempt = onlyRow(selected.rows, "Runner workflow attempt was not created");
      validateAttempt(attempt, input, binding, source.source_digest);
      return attempt;
    });
  }

  async #resolveExecutionLock(
    client: PostgresWorkflowClient,
    input: WorkflowInput,
    configuration: LockedConfiguration,
    sourceDigest: string,
  ): Promise<Readonly<{ id: string; digest: string; payload: RunnerExecutionLock }>> {
    const result = await client.query<ExecutionLockRow>(
      `SELECT id::text, payload, payload_digest
         FROM deviludo.runner_execution_locks
        WHERE tenant_id = $1::uuid
          AND project_id = $2::uuid
          AND run_id = $3::uuid
          AND lock_key = $4
        FOR SHARE`,
      [input.tenantId, input.projectId, input.runId, input.requestDigest],
    );
    if (result.rows.length !== 1) throw new WorkflowJobError("RUNNER_EXECUTION_LOCK_MISSING");
    const row = result.rows[0] as ExecutionLockRow;
    let payload: Readonly<RunnerExecutionLock>;
    try {
      payload = parseRunnerExecutionLock(row.payload);
    } catch {
      throw new WorkflowJobError("RUNNER_EXECUTION_LOCK_INVALID", true);
    }
    const digest = runnerExecutionLockDigest(payload);
    if (!UUID.test(row.id) || !SHA256.test(row.payload_digest) || digest !== row.payload_digest
      || payload.tenantId !== input.tenantId || payload.projectId !== input.projectId
      || payload.runId !== input.runId || payload.mode !== input.mode
      || payload.commitSha !== input.commitSha || payload.sourceDigest !== sourceDigest
      || payload.steamBuildId !== input.steamBuildId
      || payload.specRevisionId !== configuration.specRevisionId
      || payload.specDigest !== configuration.specDigest
      || payload.testPlanDigest !== configuration.testPlanDigest
      || payload.runnerToolchainRevisionId !== configuration.runnerToolchainRevisionId
      || payload.runnerToolchainDigest !== configuration.runnerToolchainDigest
      || JSON.stringify(payload.targetMatrix) !== JSON.stringify(input.targetMatrix)) {
      throw new WorkflowJobError("RUNNER_EXECUTION_LOCK_BINDING_CONFLICT", true);
    }
    return Object.freeze({ id: row.id, digest, payload });
  }

  async #resolveSource(client: PostgresWorkflowClient, input: WorkflowInput): Promise<SourceBinding> {
    if (input.mode === "CANDIDATE") {
      const result = await client.query<SourceBinding>(
        `SELECT source_digest, spec_revision_id::text
           FROM deviludo.github_candidate_receipts
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
            AND run_id = $3::uuid AND candidate_commit_sha = $4
            AND pull_request_number = $5::bigint`,
        [input.tenantId, input.projectId, input.runId, input.commitSha, input.draftPullRequest],
      );
      return onlyRow(result.rows, "GitHub candidate source receipt is not available");
    }
    if (input.mode === "MAIN_RELEASE_GATE") {
      const result = await client.query<SourceBinding>(
        `SELECT merge.main_source_digest AS source_digest,
                candidate.spec_revision_id::text
           FROM deviludo.github_merge_receipts merge
           JOIN deviludo.github_candidate_receipts candidate
             ON candidate.id = merge.candidate_receipt_id
          WHERE merge.tenant_id = $1::uuid AND merge.project_id = $2::uuid
            AND candidate.run_id = $3::uuid
            AND merge.default_branch_head_sha = $4`,
        [input.tenantId, input.projectId, input.runId, input.commitSha],
      );
      return onlyRow(result.rows, "Merged main source receipt is not available");
    }
    const result = await client.query<SourceBinding>(
      `SELECT build.source_digest,
              run.configuration_lock->>'specRevisionId' AS spec_revision_id
         FROM deviludo.steam_build_receipts build
         JOIN deviludo.steam_releases release ON release.id = build.release_id
         JOIN deviludo.evidence_bundles main_evidence ON main_evidence.id = release.evidence_bundle_id
         JOIN deviludo.e2e_attempts main_attempt ON main_attempt.id = main_evidence.attempt_id
         JOIN deviludo.agent_runs run ON run.id = main_attempt.run_id
        WHERE build.tenant_id = $1::uuid AND build.project_id = $2::uuid
          AND main_attempt.run_id = $3::uuid AND build.main_commit_sha = $4
          AND build.build_id = $5
          AND (
            build.state IN ('INSTALL_TESTING', 'EXTERNAL_APPROVAL_REQUIRED')
            OR (build.state = 'FAILED' AND EXISTS (
              SELECT 1
                FROM deviludo.e2e_attempts replay
               WHERE replay.tenant_id = build.tenant_id
                 AND replay.project_id = build.project_id
                 AND replay.run_id = $3::uuid
                 AND replay.workflow_operation_key = $6
                 AND replay.workflow_id = release.workflow_id
                 AND replay.mode = 'STEAM_CLEAN_INSTALL'
                 AND replay.commit_sha = build.main_commit_sha
                 AND replay.steam_build_id = build.build_id
                 AND replay.state = 'FAILED'
            ))
          )
          AND build.source_digest = main_evidence.source_digest
          AND main_evidence.invalidated_at IS NULL`,
      [input.tenantId, input.projectId, input.runId, input.commitSha, input.steamBuildId,
        input.operationKey],
    );
    return onlyRow(result.rows, "Steam Build source receipt is not available");
  }

  async #readTerminal(input: WorkflowInput, attemptId: string): Promise<RunnerWorkflowReceipt | null> {
    return this.#transaction(input.tenantId, async (client) => {
      const result = await client.query<AttemptRow & EvidenceRow>(
        `SELECT attempt.id::text, attempt.run_id::text, attempt.workflow_id,
                attempt.workflow_operation_key, attempt.workflow_request_digest,
                attempt.execution_lock_id::text, attempt.mode, attempt.commit_sha, attempt.source_digest,
                attempt.binding, attempt.target_matrix, attempt.draft_pull_request,
                attempt.steam_build_id, attempt.state, attempt.repair_prompt_id,
                attempt.completed_at::text,
                evidence.id::text AS evidence_id,
                evidence.commit_sha AS evidence_commit_sha,
                evidence.source_digest AS evidence_source_digest,
                evidence.binding AS evidence_binding,
                evidence.manifest AS evidence_manifest,
                evidence.bundle_digest AS evidence_bundle_digest,
                evidence.object_key AS evidence_object_key,
                evidence.status AS evidence_status,
                evidence.invalidated_at::text AS evidence_invalidated_at
           FROM deviludo.e2e_attempts attempt
           LEFT JOIN deviludo.evidence_bundles evidence ON evidence.attempt_id = attempt.id
          WHERE attempt.tenant_id = $1::uuid
            AND attempt.project_id = $2::uuid
            AND attempt.id = $3::uuid
          FOR UPDATE OF attempt`,
        [input.tenantId, input.projectId, attemptId],
      );
      const raw = onlyRow(result.rows, "Runner workflow attempt disappeared");
      const attempt = attemptFromTerminalRow(raw);
      validateAttempt(attempt, input, parseAttemptBinding(attempt.binding), attempt.source_digest);
      if (attempt.state === "QUEUED" || attempt.state === "RUNNING") return null;
      if (attempt.state === "INVALIDATED") throw new WorkflowJobError("E2E_ATTEMPT_INVALIDATED", true);
      if (attempt.state !== "PASSED" && attempt.state !== "FAILED") {
        throw new WorkflowJobError("E2E_ATTEMPT_STATE_INVALID", true);
      }
      const evidence = evidenceFromTerminalRow(raw);
      const bundle = validateEvidence(evidence, attempt);
      if (bundle.status !== attempt.state) throw new WorkflowJobError("E2E_EVIDENCE_STATUS_MISMATCH", true);
      if (attempt.state === "FAILED" && (!attempt.repair_prompt_id || !SAFE_ID.test(attempt.repair_prompt_id))) {
        throw new WorkflowJobError("E2E_REPAIR_PROMPT_MISSING", true);
      }
      if (input.mode === "STEAM_CLEAN_INSTALL") {
        if (attempt.state === "PASSED") {
          await this.#projectSteamInstallEvidence(client, input, attempt, evidence);
        } else {
          await this.#projectSteamInstallFailure(client, input, attempt, evidence);
        }
      }
      return Object.freeze({
        receiptId: `runner-receipt:${attempt.id}:${evidence.bundle_digest}`,
        attemptId: attempt.id,
        mode: input.mode,
        status: attempt.state,
        commitSha: attempt.commit_sha,
        steamBuildId: attempt.steam_build_id,
        targetMatrix: Object.freeze([...input.targetMatrix]),
        evidenceBundleId: evidence.id as string,
        repairPromptId: attempt.repair_prompt_id,
      });
    });
  }

  async #projectSteamInstallEvidence(
    client: PostgresWorkflowClient,
    input: WorkflowInput,
    attempt: AttemptRow,
    evidence: EvidenceRow,
  ): Promise<void> {
    const result = await client.query<SteamInstallProjectionRow>(
      `SELECT build.id::text AS build_receipt_id,
              build.state AS build_state,
              build.steam_install_evidence_bundle_digest,
              release.id::text AS release_id,
              release.state AS release_state,
              release.external_gate,
              release.workflow_id,
              release.run_id::text AS release_run_id,
              release.main_commit_sha,
              release.target_matrix,
              build.build_id,
              install_evidence.id::text AS evidence_id,
              install_evidence.bundle_digest AS evidence_bundle_digest
         FROM deviludo.steam_build_receipts build
         JOIN deviludo.steam_releases release
           ON release.tenant_id = build.tenant_id
          AND release.project_id = build.project_id
          AND release.id = build.release_id
         JOIN deviludo.evidence_bundles install_evidence
           ON install_evidence.tenant_id = build.tenant_id
          AND install_evidence.project_id = build.project_id
          AND install_evidence.attempt_id = $6::uuid
        WHERE build.tenant_id = $1::uuid AND build.project_id = $2::uuid
          AND release.run_id = $3::uuid AND release.workflow_id = $4
          AND build.build_id = $5 AND build.main_commit_sha = $7
          AND install_evidence.id = $8::uuid
          AND install_evidence.status = 'PASSED'
          AND install_evidence.invalidated_at IS NULL
        FOR UPDATE OF build, release`,
      [input.tenantId, input.projectId, input.runId, input.workflowId, input.steamBuildId,
        attempt.id, attempt.commit_sha, evidence.id],
    );
    const row = onlyRow(result.rows, "Steam clean-install evidence cannot be projected");
    if (!UUID.test(row.build_receipt_id) || !UUID.test(row.release_id)
      || row.workflow_id !== input.workflowId || row.release_run_id !== input.runId
      || row.main_commit_sha !== attempt.commit_sha || row.build_id !== input.steamBuildId
      || row.evidence_id !== evidence.id || row.evidence_bundle_digest !== evidence.bundle_digest
      || JSON.stringify(row.target_matrix) !== JSON.stringify(input.targetMatrix)) {
      throw new WorkflowJobError("STEAM_INSTALL_EVIDENCE_PROJECTION_BINDING_CONFLICT", true);
    }
    if (row.build_state === "INSTALL_TESTING" && row.steam_install_evidence_bundle_digest === null
      && row.release_state === "INSTALL_TESTING" && row.external_gate === "NONE") {
      const build = await client.query(
        `UPDATE deviludo.steam_build_receipts
            SET state = 'EXTERNAL_APPROVAL_REQUIRED',
                steam_install_evidence_bundle_digest = $4
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
            AND state = 'INSTALL_TESTING'
            AND steam_install_evidence_bundle_digest IS NULL
        RETURNING id`,
        [input.tenantId, input.projectId, row.build_receipt_id, evidence.bundle_digest],
      );
      const release = await client.query(
        `UPDATE deviludo.steam_releases
            SET state = 'EXTERNAL_APPROVAL_REQUIRED', external_gate = 'VALVE_REVIEW',
                version = version + 1
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
            AND state = 'INSTALL_TESTING' AND external_gate = 'NONE'
        RETURNING id`,
        [input.tenantId, input.projectId, row.release_id],
      );
      if (build.rows.length !== 1 || release.rows.length !== 1) {
        throw new WorkflowJobError("STEAM_INSTALL_EVIDENCE_PROJECTION_RACE", true);
      }
      return;
    }
    const downstreamState = row.release_state === "EXTERNAL_APPROVAL_REQUIRED"
      || row.release_state === "READY_TO_PUBLISH" || row.release_state === "RELEASED";
    if (row.build_state !== "EXTERNAL_APPROVAL_REQUIRED"
      || row.steam_install_evidence_bundle_digest !== evidence.bundle_digest || !downstreamState) {
      throw new WorkflowJobError("STEAM_INSTALL_EVIDENCE_PROJECTION_CONFLICT", true);
    }
  }

  async #projectSteamInstallFailure(
    client: PostgresWorkflowClient,
    input: WorkflowInput,
    attempt: AttemptRow,
    evidence: EvidenceRow,
  ): Promise<void> {
    const result = await client.query<SteamInstallProjectionRow>(
      `SELECT build.id::text AS build_receipt_id,
              build.state AS build_state,
              build.steam_install_evidence_bundle_digest,
              release.id::text AS release_id,
              release.state AS release_state,
              release.external_gate,
              release.workflow_id,
              release.run_id::text AS release_run_id,
              release.main_commit_sha,
              release.target_matrix,
              build.build_id,
              install_evidence.id::text AS evidence_id,
              install_evidence.bundle_digest AS evidence_bundle_digest
         FROM deviludo.steam_build_receipts build
         JOIN deviludo.steam_releases release
           ON release.tenant_id = build.tenant_id
          AND release.project_id = build.project_id
          AND release.id = build.release_id
         JOIN deviludo.evidence_bundles install_evidence
           ON install_evidence.tenant_id = build.tenant_id
          AND install_evidence.project_id = build.project_id
          AND install_evidence.attempt_id = $6::uuid
        WHERE build.tenant_id = $1::uuid AND build.project_id = $2::uuid
          AND release.run_id = $3::uuid AND release.workflow_id = $4
          AND build.build_id = $5 AND build.main_commit_sha = $7
          AND install_evidence.id = $8::uuid
          AND install_evidence.status = 'FAILED'
          AND install_evidence.invalidated_at IS NULL
        FOR UPDATE OF build, release`,
      [input.tenantId, input.projectId, input.runId, input.workflowId, input.steamBuildId,
        attempt.id, attempt.commit_sha, evidence.id],
    );
    const row = onlyRow(result.rows, "Steam clean-install failure cannot revoke release authority");
    if (!UUID.test(row.build_receipt_id) || !UUID.test(row.release_id)
      || row.workflow_id !== input.workflowId || row.release_run_id !== input.runId
      || row.main_commit_sha !== attempt.commit_sha || row.build_id !== input.steamBuildId
      || row.evidence_id !== evidence.id || row.evidence_bundle_digest !== evidence.bundle_digest
      || JSON.stringify(row.target_matrix) !== JSON.stringify(input.targetMatrix)
      || !attempt.repair_prompt_id || !attempt.completed_at) {
      throw new WorkflowJobError("STEAM_INSTALL_FAILURE_REVOCATION_BINDING_CONFLICT", true);
    }

    const initial = row.build_state === "INSTALL_TESTING"
      && row.steam_install_evidence_bundle_digest === null
      && row.release_state === "INSTALL_TESTING" && row.external_gate === "NONE";
    const replay = row.build_state === "FAILED"
      && row.steam_install_evidence_bundle_digest === evidence.bundle_digest
      && row.release_state === "FAILED" && row.external_gate === "NONE";
    if (!initial && !replay) {
      throw new WorkflowJobError("STEAM_INSTALL_FAILURE_REVOCATION_CONFLICT", true);
    }

    if (initial) {
      await client.query(
        `INSERT INTO deviludo.steam_release_revocations
          (tenant_id, project_id, workflow_id, run_id, release_id, build_receipt_id,
           attempt_id, evidence_bundle_id, evidence_bundle_digest, repair_prompt_id,
           main_commit_sha, build_id, reason, revoked_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid,
                 $7::uuid, $8::uuid, $9, $10, $11, $12,
                 'STEAM_INSTALL_E2E_FAILED', $13::timestamptz)
         ON CONFLICT (tenant_id, release_id) DO NOTHING`,
        [input.tenantId, input.projectId, input.workflowId, input.runId, row.release_id,
          row.build_receipt_id, attempt.id, evidence.id, evidence.bundle_digest,
          attempt.repair_prompt_id, attempt.commit_sha, input.steamBuildId, attempt.completed_at],
      );
    }
    await this.#validateSteamInstallFailureReceipt(client, input, attempt, evidence, row);

    if (!initial) return;
    const build = await client.query(
      `UPDATE deviludo.steam_build_receipts
          SET state = 'FAILED', steam_install_evidence_bundle_digest = $4
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
          AND state = 'INSTALL_TESTING'
          AND steam_install_evidence_bundle_digest IS NULL
      RETURNING id`,
      [input.tenantId, input.projectId, row.build_receipt_id, evidence.bundle_digest],
    );
    const release = await client.query(
      `UPDATE deviludo.steam_releases
          SET state = 'FAILED', external_gate = 'NONE', version = version + 1
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
          AND state = 'INSTALL_TESTING' AND external_gate = 'NONE'
      RETURNING id`,
      [input.tenantId, input.projectId, row.release_id],
    );
    if (build.rows.length !== 1 || release.rows.length !== 1) {
      throw new WorkflowJobError("STEAM_INSTALL_FAILURE_REVOCATION_RACE", true);
    }
  }

  async #validateSteamInstallFailureReceipt(
    client: PostgresWorkflowClient,
    input: WorkflowInput,
    attempt: AttemptRow,
    evidence: EvidenceRow,
    row: SteamInstallProjectionRow,
  ): Promise<void> {
    const receipt = await client.query<{ id: string }>(
      `SELECT id::text
         FROM deviludo.steam_release_revocations
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid
          AND workflow_id = $3 AND run_id = $4::uuid
          AND release_id = $5::uuid AND build_receipt_id = $6::uuid
          AND attempt_id = $7::uuid AND evidence_bundle_id = $8::uuid
          AND evidence_bundle_digest = $9 AND repair_prompt_id = $10
          AND main_commit_sha = $11 AND build_id = $12
          AND reason = 'STEAM_INSTALL_E2E_FAILED'
          AND revoked_at = $13::timestamptz
        FOR SHARE`,
      [input.tenantId, input.projectId, input.workflowId, input.runId, row.release_id,
        row.build_receipt_id, attempt.id, evidence.id, evidence.bundle_digest,
        attempt.repair_prompt_id, attempt.commit_sha, input.steamBuildId, attempt.completed_at],
    );
    if (receipt.rows.length !== 1 || !UUID.test(receipt.rows[0]?.id ?? "")) {
      throw new WorkflowJobError("STEAM_INSTALL_FAILURE_REVOCATION_RECEIPT_CONFLICT", true);
    }
  }

  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function postgresRunnerWorkflowFromEnv(
  pool: PostgresWorkflowPool,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PostgresRunnerWorkflowPort {
  return new PostgresRunnerWorkflowPort({
    pool,
    pollIntervalMs: seconds(env.DEVILUDO_RUNNER_ATTEMPT_POLL_SECONDS, 5, 1, 60) * 1_000,
    maxWaitMs: seconds(env.DEVILUDO_RUNNER_ATTEMPT_MAX_WAIT_SECONDS, 7_200, 30, 86_400) * 1_000,
  });
}

function validateInput(input: WorkflowInput): void {
  for (const value of [input.tenantId, input.projectId, input.runId]) {
    if (!UUID.test(value)) throw new WorkflowJobError("RUNNER_WORKFLOW_IDENTITY_INVALID", true);
  }
  if (!SAFE_ID.test(input.workflowId) || !/^workflow-job:[a-f0-9-]{36}$/.test(input.operationKey)
    || !SHA256.test(input.requestDigest) || !SHA1.test(input.commitSha)) {
    throw new WorkflowJobError("RUNNER_WORKFLOW_BINDING_INVALID", true);
  }
  validateMatrix(input.targetMatrix);
  if (input.mode === "CANDIDATE") {
    if (!Number.isSafeInteger(input.draftPullRequest) || (input.draftPullRequest as number) < 1 || input.steamBuildId !== null) invalidMode();
  } else if (input.mode === "MAIN_RELEASE_GATE") {
    if (input.draftPullRequest !== null || input.steamBuildId !== null) invalidMode();
  } else if (input.draftPullRequest !== null || !input.steamBuildId || !/^[1-9][0-9]{0,19}$/.test(input.steamBuildId)) invalidMode();
}

function validateAttempt(attempt: AttemptRow, input: WorkflowInput, binding: AttemptBinding, sourceDigest: string): void {
  const draftPullRequest = attempt.draft_pull_request === null ? null : Number(attempt.draft_pull_request);
  const terminal = attempt.state === "PASSED" || attempt.state === "FAILED";
  if (!UUID.test(attempt.id) || attempt.run_id !== input.runId || attempt.workflow_id !== input.workflowId
    || attempt.workflow_operation_key !== input.operationKey || attempt.workflow_request_digest !== input.requestDigest
    || attempt.execution_lock_id !== binding.executionLockId
    || attempt.mode !== input.mode || attempt.commit_sha !== input.commitSha || attempt.source_digest !== sourceDigest
    || draftPullRequest !== input.draftPullRequest || attempt.steam_build_id !== input.steamBuildId
    || JSON.stringify(attempt.target_matrix) !== JSON.stringify(input.targetMatrix)
    || sha256Canonical(attempt.binding) !== sha256Canonical(binding)
    || !["QUEUED", "RUNNING", "PASSED", "FAILED", "INVALIDATED"].includes(attempt.state)
    || terminal !== (attempt.completed_at !== null)
    || (attempt.completed_at !== null && !Number.isFinite(Date.parse(attempt.completed_at)))
    || (attempt.state === "FAILED") !== (attempt.repair_prompt_id !== null)) {
    throw new WorkflowJobError("RUNNER_ATTEMPT_BINDING_CONFLICT", true);
  }
}

function parseLockedConfiguration(value: unknown): LockedConfiguration {
  const body = record(value, "Agent run configuration lock is invalid");
  const specRevisionId = requiredString(body.specRevisionId, SAFE_ID, "spec revision");
  const specDigest = requiredString(body.specDigest, SHA256, "spec digest");
  const testPlanDigest = requiredString(body.testPlanDigest, SHA256, "test plan digest");
  const runnerToolchainRevisionId = requiredString(body.runnerToolchainRevisionId, UUID, "Runner toolchain revision");
  const runnerToolchainDigest = requiredString(body.runnerToolchainDigest, SHA256, "Runner toolchain digest");
  const targetMatrix = parseMatrix(body.targetMatrix);
  return Object.freeze({
    specRevisionId,
    specDigest,
    testPlanDigest,
    runnerToolchainRevisionId,
    runnerToolchainDigest,
    targetMatrix,
  });
}

function parseAttemptBinding(value: unknown): AttemptBinding {
  const body = record(value, "E2E attempt binding is invalid");
  if (body.schemaVersion !== "deviludo.e2e-attempt.v1") throw new WorkflowJobError("E2E_ATTEMPT_BINDING_INVALID", true);
  const mode = body.mode;
  if (mode !== "CANDIDATE" && mode !== "MAIN_RELEASE_GATE" && mode !== "STEAM_CLEAN_INSTALL") {
    throw new WorkflowJobError("E2E_ATTEMPT_BINDING_INVALID", true);
  }
  return Object.freeze({
    schemaVersion: body.schemaVersion,
    workflowId: requiredString(body.workflowId, SAFE_ID, "workflow"),
    operationKey: requiredString(body.operationKey, /^workflow-job:[a-f0-9-]{36}$/, "operation"),
    requestDigest: requiredString(body.requestDigest, SHA256, "request digest"),
    iterationId: requiredString(body.iterationId, SAFE_ID, "iteration"),
    mode,
    executionLockId: requiredString(body.executionLockId, UUID, "execution lock"),
    executionLockDigest: requiredString(body.executionLockDigest, SHA256, "execution lock digest"),
    specRevisionId: requiredString(body.specRevisionId, SAFE_ID, "spec revision"),
    specDigest: requiredString(body.specDigest, SHA256, "spec digest"),
    testPlanDigest: requiredString(body.testPlanDigest, SHA256, "test plan digest"),
    runnerToolchainRevisionId: requiredString(body.runnerToolchainRevisionId, UUID, "Runner toolchain revision"),
    runnerToolchainDigest: requiredString(body.runnerToolchainDigest, SHA256, "Runner toolchain digest"),
    targetMatrix: parseMatrix(body.targetMatrix),
  });
}

function validateEvidence(row: EvidenceRow, attempt: AttemptRow): EvidenceBundle {
  if (!row.id || !UUID.test(row.id) || row.commit_sha !== attempt.commit_sha || row.source_digest !== attempt.source_digest
    || !row.bundle_digest || !SHA256.test(row.bundle_digest) || row.status !== attempt.state
    || !row.object_key || row.object_key.startsWith("/") || row.object_key.includes("..")
    || row.invalidated_at !== null || row.manifest === null || row.binding === null) {
    throw new WorkflowJobError("E2E_EVIDENCE_BINDING_INVALID", true);
  }
  const attemptBinding = parseAttemptBinding(attempt.binding);
  validateEvidenceBinding(row.binding, attempt, attemptBinding);
  const body = record(row.manifest, "Evidence manifest is invalid");
  const platformEvidenceValue = body.platformEvidence;
  if (!Array.isArray(platformEvidenceValue)) throw new WorkflowJobError("E2E_EVIDENCE_MANIFEST_INVALID", true);
  const platformEvidence: PlatformEvidence[] = platformEvidenceValue.map((value) => {
    const item = record(value, "Platform evidence is invalid");
    const status = item.status;
    if (status !== "PASSED" && status !== "FAILED") throw new WorkflowJobError("E2E_EVIDENCE_MANIFEST_INVALID", true);
    return {
      platform: requiredTarget(item.platform),
      runnerId: requiredString(item.runnerId, SAFE_ID, "runner"),
      runnerCapabilityDigest: requiredString(item.runnerCapabilityDigest, SHA256, "runner capability digest"),
      exportDigest: requiredString(item.exportDigest, SHA256, "export digest"),
      logsDigest: requiredString(item.logsDigest, SHA256, "logs digest"),
      junitDigest: requiredString(item.junitDigest, SHA256, "JUnit digest"),
      inputTimelineDigest: requiredString(item.inputTimelineDigest, SHA256, "input timeline digest"),
      screenshotManifestDigest: requiredString(item.screenshotManifestDigest, SHA256, "screenshot digest"),
      videoManifestDigest: requiredString(item.videoManifestDigest, SHA256, "video digest"),
      status,
    } as PlatformEvidence;
  });
  const status = body.status;
  if (status !== "PASSED" && status !== "FAILED") throw new WorkflowJobError("E2E_EVIDENCE_MANIFEST_INVALID", true);
  const bundle: EvidenceBundle = {
    id: requiredString(body.id, UUID, "evidence bundle") as EvidenceBundle["id"],
    attemptId: requiredString(body.attemptId, UUID, "attempt") as EvidenceBundle["attemptId"],
    specRevisionId: requiredString(body.specRevisionId, SAFE_ID, "spec revision") as EvidenceBundle["specRevisionId"],
    specDigest: requiredString(body.specDigest, SHA256, "spec digest") as EvidenceBundle["specDigest"],
    testPlanDigest: requiredString(body.testPlanDigest, SHA256, "test plan digest") as EvidenceBundle["testPlanDigest"],
    commitSha: requiredString(body.commitSha, SHA1, "commit SHA"),
    sourceDigest: requiredString(body.sourceDigest, SHA256, "source digest") as EvidenceBundle["sourceDigest"],
    targetMatrix: parseMatrix(body.targetMatrix),
    godotTestKitDigest: requiredString(body.godotTestKitDigest, SHA256, "TestKit digest") as EvidenceBundle["godotTestKitDigest"],
    buildManifestDigest: requiredString(body.buildManifestDigest, SHA256, "build manifest digest") as EvidenceBundle["buildManifestDigest"],
    sbomDigest: requiredString(body.sbomDigest, SHA256, "SBOM digest") as EvidenceBundle["sbomDigest"],
    vulnerabilityScanDigest: requiredString(body.vulnerabilityScanDigest, SHA256, "scan digest") as EvidenceBundle["vulnerabilityScanDigest"],
    assetLicenseLedgerDigest: requiredString(body.assetLicenseLedgerDigest, SHA256, "asset ledger digest") as EvidenceBundle["assetLicenseLedgerDigest"],
    platformEvidence,
    bundleDigest: requiredString(body.bundleDigest, SHA256, "bundle digest") as EvidenceBundle["bundleDigest"],
    status,
    valid: body.valid === true ? true : invalidEvidence(),
    createdAt: requiredDate(body.createdAt) as EvidenceBundle["createdAt"],
  };
  if (bundle.id !== row.id || bundle.attemptId !== attempt.id || bundle.bundleDigest !== row.bundle_digest
    || bundle.commitSha !== attempt.commit_sha || bundle.sourceDigest !== attempt.source_digest
    || bundle.specRevisionId !== attemptBinding.specRevisionId || bundle.specDigest !== attemptBinding.specDigest
    || bundle.testPlanDigest !== attemptBinding.testPlanDigest
    || JSON.stringify(bundle.targetMatrix) !== JSON.stringify(attempt.target_matrix)) {
    throw new WorkflowJobError("E2E_EVIDENCE_BINDING_INVALID", true);
  }
  const core = { ...body };
  delete core.bundleDigest;
  if (sha256Canonical(core) !== row.bundle_digest) throw new WorkflowJobError("E2E_EVIDENCE_DIGEST_INVALID", true);
  return createEvidenceBundle(bundle) as EvidenceBundle;
}

function validateEvidenceBinding(value: unknown, attempt: AttemptRow, binding: AttemptBinding): void {
  const body = record(value, "Evidence row binding is invalid");
  if (body.schemaVersion !== "deviludo.evidence-binding.v1" || body.attemptId !== attempt.id
    || body.executionLockId !== binding.executionLockId
    || body.executionLockDigest !== binding.executionLockDigest
    || body.specRevisionId !== binding.specRevisionId || body.specDigest !== binding.specDigest
    || body.testPlanDigest !== binding.testPlanDigest
    || body.runnerToolchainRevisionId !== binding.runnerToolchainRevisionId
    || body.runnerToolchainDigest !== binding.runnerToolchainDigest
    || body.commitSha !== attempt.commit_sha
    || body.sourceDigest !== attempt.source_digest
    || JSON.stringify(parseMatrix(body.targetMatrix)) !== JSON.stringify(attempt.target_matrix)) {
    throw new WorkflowJobError("E2E_EVIDENCE_BINDING_INVALID", true);
  }
}

function attemptFromTerminalRow(row: Record<string, unknown>): AttemptRow {
  return {
    id: String(row.id), run_id: String(row.run_id), workflow_id: String(row.workflow_id),
    workflow_operation_key: String(row.workflow_operation_key), workflow_request_digest: String(row.workflow_request_digest),
    execution_lock_id: String(row.execution_lock_id),
    mode: String(row.mode), commit_sha: String(row.commit_sha), source_digest: String(row.source_digest),
    binding: row.binding, target_matrix: row.target_matrix as string[],
    draft_pull_request: row.draft_pull_request as string | number | null,
    steam_build_id: row.steam_build_id as string | null, state: String(row.state),
    repair_prompt_id: row.repair_prompt_id as string | null, completed_at: row.completed_at as string | null,
  };
}

function evidenceFromTerminalRow(row: Record<string, unknown>): EvidenceRow {
  return {
    id: row.evidence_id as string | null, commit_sha: row.evidence_commit_sha as string | null,
    source_digest: row.evidence_source_digest as string | null, binding: row.evidence_binding,
    manifest: row.evidence_manifest, bundle_digest: row.evidence_bundle_digest as string | null,
    object_key: row.evidence_object_key as string | null, status: row.evidence_status as string | null,
    invalidated_at: row.evidence_invalidated_at as string | null,
  };
}

function parseMatrix(value: unknown): readonly TargetPlatform[] {
  if (!Array.isArray(value) || !value.length || value.length > 3
    || value.some((entry) => typeof entry !== "string" || !TARGETS.has(entry as TargetPlatform))
    || new Set(value).size !== value.length
    || JSON.stringify([...value].sort()) !== JSON.stringify(value)) throw new WorkflowJobError("RUNNER_TARGET_MATRIX_INVALID", true);
  return Object.freeze([...value]) as readonly TargetPlatform[];
}

function validateMatrix(value: readonly TargetPlatform[]): void {
  parseMatrix(value);
}

function requiredTarget(value: unknown): TargetPlatform {
  if (typeof value !== "string" || !TARGETS.has(value as TargetPlatform)) throw new WorkflowJobError("E2E_EVIDENCE_MANIFEST_INVALID", true);
  return value as TargetPlatform;
}

function record(value: unknown, message: string): Record<string, unknown> {
  void message;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowJobError("E2E_EVIDENCE_MANIFEST_INVALID", true);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, pattern: RegExp, label: string): string {
  void label;
  if (typeof value !== "string" || !pattern.test(value)) throw new WorkflowJobError("E2E_EVIDENCE_MANIFEST_INVALID", true);
  return value;
}

function requiredDate(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new WorkflowJobError("E2E_EVIDENCE_MANIFEST_INVALID", true);
  return value;
}

function onlyRow<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) throw new Error(message);
  return rows[0] as T;
}

function invalidMode(): never {
  throw new WorkflowJobError("RUNNER_WORKFLOW_MODE_BINDING_INVALID", true);
}

function invalidEvidence(): never {
  throw new WorkflowJobError("E2E_EVIDENCE_MANIFEST_INVALID", true);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Runner workflow ${label} is invalid`);
  return value;
}

function validNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Runner workflow clock is invalid");
  return value;
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Runner workflow duration is invalid");
  }
  return parsed;
}
