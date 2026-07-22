import { createPublicKey, type KeyObject } from "node:crypto";
import {
  acceptPlatformRunnerEvent,
  createEvidenceBundle,
  type EvidenceBundle,
  type PlatformRunnerLease,
  type RunnerEvent,
  type RunnerEventCursor,
} from "../../../lib/domain/e2e";
import type { TargetPlatform } from "../../../lib/domain/types";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { sha256Canonical, signCanonical, verifyCanonical } from "./canonical";
import type {
  RegisteredRunner,
  RunnerAdmissionPolicy,
  RunnerCapabilities,
  RunnerJobPayload,
  RunnerJobSignerOptions,
  RunnerEventReceipt,
  PlatformEvidenceManifest,
  RunnerNativeInstallAuthorizationRequest,
  RunnerNativeInstallAuthorizationResult,
  RunnerNativeInstallCompletionReceipt,
  RunnerNativeInstallRollbackReceipt,
  SignedRunnerNativeInstallActivationGrant,
  SignedRunnerJob,
  TlsRunnerIdentity,
} from "./contracts";
import {
  REQUIRED_RUNNER_EVIDENCE,
  validatePlatformEvidenceManifest,
  validateRunnerEventShape,
  validateRunnerCapabilities,
  validateRunnerIdentity,
} from "./coordinator";
import { parseRunnerExecutionLock, runnerExecutionLockDigest, type RunnerExecutionLock } from "./execution-lock";
import {
  createRunnerNativeInstallDrainReceipt,
  runnerNativeInstallRequestDigest,
  validateRunnerNativeInstallAuthorizationRequest,
  verifyRunnerNativeInstallActivationGrant,
} from "./native-install";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export interface RunnerTenantAssignmentPolicy {
  authorize(input: {
    readonly identity: TlsRunnerIdentity;
    readonly runner: RegisteredRunner;
    readonly tenantId: string;
  }): Promise<boolean>;
}

export interface RunnerEvidenceArchive {
  /** Must put by digest idempotently; a DB rollback may safely retry it. */
  persistBundle(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly bundle: EvidenceBundle;
  }): Promise<Readonly<{ objectKey: string; repairPromptId: string | null }>>;
}

type RunnerRow = {
  id: string;
  spiffe_id: string;
  certificate_fingerprint: string;
  certificate_serial: string;
  certificate_not_after: string;
  platform: string;
  architecture: string;
  capability_digest: string;
  capabilities: unknown;
  state: string;
  registered_at: string;
  last_seen_at: string;
};

type ActiveLeaseRow = {
  job: unknown;
  job_digest: string;
  job_signature: string;
  runner_id: string;
  platform: string;
  lease_expires_at: string;
};

type CandidateRow = {
  attempt_id: string;
  project_id: string;
  run_id: string;
  iteration_id: string;
  execution_lock_id: string;
  commit_sha: string;
  source_digest: string;
  target_matrix: string[];
  mode: string;
  steam_build_id: string | null;
  lock_payload: unknown;
  lock_payload_digest: string;
};

type AttemptStateRow = {
  state: string;
  project_id: string;
};

type LeaseRow = ActiveLeaseRow & {
  id: string;
  project_id: string;
  attempt_id: string;
  fencing_token: string | number;
  last_seq_no: string | number;
  cursor: unknown;
  evidence_manifest: unknown | null;
  evidence_manifest_digest: string | null;
  state: string;
};

type EventRow = {
  runner_id: string;
  platform: string;
  fencing_token: string | number;
  seq_no: string | number;
  commit_sha: string;
  source_digest: string;
  event_type: string;
  status: string;
  artifact_digest: string | null;
  occurred_at: string;
};

type NativeInstallOperationRow = {
  id: string;
  current_runner_id: string;
  current_spiffe_id: string;
  current_certificate_fingerprint: string;
  current_capability_digest: string;
  target_runner_id: string;
  target_spiffe_id: string;
  target_capability_digest: string;
  platform: string;
  architecture: string;
  plan_digest: string;
  staging_receipt_digest: string;
  release_id: string;
  release_digest: string;
  request: unknown;
  request_digest: string;
  state: string;
  completed_at: string | null;
};

type NativeInstallGrantRow = {
  grant: unknown;
  grant_digest?: string;
};

type NativeInstallRollbackRow = {
  failure_evidence_digest: string;
  receipt: unknown;
  receipt_digest: string;
};

/**
 * PostgreSQL half of the physical Runner ingress. The HTTP/mTLS listener is a
 * separate adapter; this class accepts only an identity already extracted from
 * an authorized TLS socket and an assignment approved by server-side policy.
 */
export class PostgresRunnerIngressStore {
  readonly #pool: PostgresWorkflowPool;
  readonly #admission: RunnerAdmissionPolicy;
  readonly #assignments: RunnerTenantAssignmentPolicy;
  readonly #signer: RunnerJobSignerOptions;
  readonly #publicKey: KeyObject;
  readonly #leaseDurationSeconds: number;
  readonly #nativeInstallGrantDurationSeconds: number;
  readonly #evidenceArchive: RunnerEvidenceArchive;

  constructor(options: {
    readonly pool: PostgresWorkflowPool;
    readonly admission: RunnerAdmissionPolicy;
    readonly assignments: RunnerTenantAssignmentPolicy;
    readonly signer: RunnerJobSignerOptions;
    readonly evidenceArchive: RunnerEvidenceArchive;
    readonly leaseDurationSeconds?: number;
    readonly nativeInstallGrantDurationSeconds?: number;
  }) {
    this.#pool = options.pool;
    this.#admission = options.admission;
    this.#assignments = options.assignments;
    this.#signer = options.signer;
    this.#evidenceArchive = options.evidenceArchive;
    this.#publicKey = createPublicKey(options.signer.privateKey);
    if (this.#publicKey.asymmetricKeyType !== "ed25519" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(options.signer.keyId)) {
      throw new Error("Runner job signer configuration is invalid");
    }
    this.#leaseDurationSeconds = options.leaseDurationSeconds ?? 300;
    if (!Number.isInteger(this.#leaseDurationSeconds)
      || this.#leaseDurationSeconds < 30 || this.#leaseDurationSeconds > 3_600) {
      throw new Error("Runner lease duration must be between 30 and 3600 seconds");
    }
    this.#nativeInstallGrantDurationSeconds = options.nativeInstallGrantDurationSeconds ?? 600;
    if (!Number.isInteger(this.#nativeInstallGrantDurationSeconds)
      || this.#nativeInstallGrantDurationSeconds < 60 || this.#nativeInstallGrantDurationSeconds > 900) {
      throw new Error("Runner native install grant duration must be between 60 and 900 seconds");
    }
  }

  async probe(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT to_regclass('deviludo.runner_registrations')::text AS runner_registrations,
                to_regclass('deviludo.runner_native_install_operations')::text AS runner_native_install_operations,
                to_regclass('deviludo.runner_native_install_grants')::text AS runner_native_install_grants,
                to_regclass('deviludo.runner_native_install_rollbacks')::text AS runner_native_install_rollbacks,
                to_regclass('deviludo.e2e_platform_leases')::text AS e2e_platform_leases,
                to_regclass('deviludo.e2e_attempts')::text AS e2e_attempts,
                to_regclass('deviludo.agent_runs')::text AS agent_runs,
                to_regclass('deviludo.runner_execution_locks')::text AS runner_execution_locks,
                to_regclass('deviludo.platform_runner_events')::text AS platform_runner_events,
                to_regclass('deviludo.evidence_bundles')::text AS evidence_bundles`,
      );
      const row = result.rows[0];
      for (const table of [
        "runner_registrations", "runner_native_install_operations", "runner_native_install_grants",
        "runner_native_install_rollbacks", "e2e_platform_leases", "e2e_attempts", "agent_runs",
        "runner_execution_locks", "platform_runner_events", "evidence_bundles",
      ]) {
        if (row?.[table] !== `deviludo.${table}`) throw new Error("Runner ingress database is not ready");
      }
    } finally { client.release(); }
  }

  async register(
    identity: TlsRunnerIdentity,
    capabilities: RunnerCapabilities,
    at = new Date().toISOString(),
  ): Promise<RegisteredRunner> {
    validateRunnerIdentity(identity, at);
    validateRunnerCapabilities(capabilities);
    if (!(await this.#admission.authorize({ identity, capabilities }))) {
      throw new Error("Runner admission policy rejected this workload identity");
    }
    return this.#transaction(null, async (client) => {
      const selected = await client.query<RunnerRow>(
        `SELECT id, spiffe_id, certificate_fingerprint, certificate_serial,
                certificate_not_after::text, platform, architecture,
                capability_digest, capabilities, state,
                registered_at::text, last_seen_at::text
           FROM deviludo.runner_registrations
          WHERE id = $1 OR spiffe_id = $2 OR certificate_fingerprint = $3
          FOR UPDATE`,
        [capabilities.runnerId, identity.spiffeId, identity.certificateFingerprint],
      );
      if (selected.rows.length > 1) throw new Error("Runner identity collides with multiple registrations");
      const existing = selected.rows[0];
      if (existing) {
        const runner = parseRegisteredRunner(existing);
        assertRegisteredBinding(runner, identity, capabilities);
        await client.query(
          `UPDATE deviludo.runner_registrations
              SET last_seen_at = $2::timestamptz,
                  state = CASE WHEN state IN ('DRAINING', 'OFFLINE', 'QUARANTINED') THEN state ELSE 'ONLINE' END
            WHERE id = $1`,
          [capabilities.runnerId, at],
        );
        return Object.freeze({
          ...runner,
          state: runner.state === "DRAINING" || runner.state === "OFFLINE" || runner.state === "QUARANTINED"
            ? runner.state : "ONLINE",
          lastSeenAt: at,
        });
      }
      const pendingActivation = await client.query<{ state: string }>(
        `SELECT state
           FROM deviludo.runner_native_install_operations
          WHERE target_runner_id = $1 AND target_spiffe_id = $2
            AND target_capability_digest = $3
            AND state IN ('DRAINING', 'ACTIVATION_AUTHORIZED')
          FOR SHARE`,
        [capabilities.runnerId, identity.spiffeId, capabilities.capabilityDigest],
      );
      if (pendingActivation.rows.length > 1) throw new Error("Runner target has ambiguous native install operations");
      const initialState = pendingActivation.rows.length === 1 ? "DRAINING" : "ONLINE";
      await client.query(
        `INSERT INTO deviludo.runner_registrations
          (id, spiffe_id, certificate_fingerprint, certificate_serial,
           certificate_not_after, platform, architecture, capability_digest,
           capabilities, state, registered_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8,
                 $9::jsonb, $10, $11::timestamptz, $11::timestamptz)`,
        [
          capabilities.runnerId,
          identity.spiffeId,
          identity.certificateFingerprint,
          identity.certificateSerial,
          identity.certificateNotAfter,
          capabilities.platform,
          capabilities.architecture,
          capabilities.capabilityDigest,
          JSON.stringify(capabilities),
          initialState,
          at,
        ],
      );
      return Object.freeze({
        ...capabilities,
        ...identity,
        state: initialState,
        registeredAt: at,
        lastSeenAt: at,
      });
    });
  }

  async leaseNext(
    identity: TlsRunnerIdentity,
    runnerId: string,
    tenantId: string,
    at = new Date().toISOString(),
  ): Promise<SignedRunnerJob | null> {
    validateRunnerIdentity(identity, at);
    if (!UUID.test(tenantId)) throw new Error("Runner tenant assignment is invalid");
    return this.#transaction(tenantId, async (client) => {
      const runner = await registeredRunner(client, identity, runnerId);
      if (runner.state !== "ONLINE") throw new Error("Runner is not eligible for a new lease");
      if (!(await this.#assignments.authorize({ identity, runner, tenantId }))) {
        throw new Error("Runner is not assigned to this tenant");
      }
      await client.query(
        `UPDATE deviludo.runner_registrations SET last_seen_at = $2::timestamptz WHERE id = $1`,
        [runnerId, at],
      );

      const active = await client.query<ActiveLeaseRow>(
        `SELECT lease.job, lease.job_digest, lease.job_signature,
                lease.runner_id, lease.platform, lease.lease_expires_at::text
           FROM deviludo.e2e_platform_leases lease
          WHERE lease.tenant_id = $1::uuid
            AND lease.runner_id = $2
            AND lease.platform = $3
            AND lease.state IN ('LEASED', 'RUNNING')
            AND lease.lease_expires_at >= $4::timestamptz
          ORDER BY lease.created_at, lease.id
          LIMIT 1
          FOR UPDATE OF lease SKIP LOCKED`,
        [tenantId, runnerId, runner.platform, at],
      );
      if (active.rows[0]) {
        const job = parseStoredJob(active.rows[0], this.#publicKey, this.#signer.keyId);
        if (job.payload.tenantId !== tenantId || job.payload.runnerId !== runnerId
          || job.payload.platform !== runner.platform
          || job.payload.leaseExpiresAt !== active.rows[0].lease_expires_at) {
          throw new Error("Stored Runner job does not match its active lease");
        }
        return job;
      }

      const candidateResult = await client.query<CandidateRow>(
        `SELECT attempt.id::text AS attempt_id,
                attempt.project_id::text, attempt.run_id::text,
                run.iteration_id::text, attempt.execution_lock_id::text,
                attempt.commit_sha, attempt.source_digest, attempt.target_matrix,
                attempt.mode, attempt.steam_build_id,
                lock.payload AS lock_payload,
                lock.payload_digest AS lock_payload_digest
           FROM deviludo.e2e_attempts attempt
           JOIN deviludo.agent_runs run ON run.id = attempt.run_id
           JOIN deviludo.runner_execution_locks lock
             ON lock.id = attempt.execution_lock_id
            AND lock.tenant_id = attempt.tenant_id
            AND lock.project_id = attempt.project_id
            AND lock.run_id = attempt.run_id
          WHERE attempt.tenant_id = $1::uuid
            AND attempt.state IN ('QUEUED', 'RUNNING')
            AND attempt.target_matrix @> ARRAY[$2]::text[]
            AND (attempt.mode <> 'STEAM_CLEAN_INSTALL' OR $4::boolean)
            AND NOT EXISTS (
              SELECT 1 FROM deviludo.e2e_platform_leases occupied
               WHERE occupied.attempt_id = attempt.id
                 AND occupied.platform = $2
                 AND ((occupied.state IN ('LEASED', 'RUNNING')
                       AND occupied.lease_expires_at >= $3::timestamptz)
                      OR occupied.state IN ('PASSED', 'FAILED'))
            )
          ORDER BY attempt.created_at, attempt.id
          LIMIT 1
          FOR UPDATE OF attempt SKIP LOCKED`,
        [tenantId, runner.platform, at, runner.steamClientConnector !== null],
      );
      const candidate = candidateResult.rows[0];
      if (!candidate) return null;
      if (candidate.mode === "STEAM_CLEAN_INSTALL" && runner.steamClientConnector === null) return null;
      const lock = validateCandidateLock(candidate, tenantId);
      const templatesDigest = lock.exportTemplates[runner.platform];
      if (runner.godotVersion !== lock.requiredGodotVersion
        || !templatesDigest || runner.exportTemplatesDigest !== templatesDigest) {
        throw new Error("Runner toolchain does not match the execution lock");
      }
      const fencing = await client.query<{ next_token: string | number }>(
        `SELECT COALESCE(MAX(fencing_token), 0) + 1 AS next_token
           FROM deviludo.e2e_platform_leases
          WHERE tenant_id = $1::uuid AND attempt_id = $2::uuid AND platform = $3`,
        [tenantId, candidate.attempt_id, runner.platform],
      );
      const fencingToken = Number(fencing.rows[0]?.next_token);
      if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw new Error("Runner fencing token is invalid");
      const leaseExpiresAt = new Date(Date.parse(at) + this.#leaseDurationSeconds * 1_000).toISOString();
      const payload: RunnerJobPayload = Object.freeze({
        schemaVersion: "deviludo.runner-job.v2",
        attemptId: candidate.attempt_id,
        tenantId,
        projectId: candidate.project_id,
        runId: candidate.run_id,
        iterationId: candidate.iteration_id,
        runnerId,
        platform: runner.platform,
        fencingToken,
        leaseExpiresAt,
        executionLockId: candidate.execution_lock_id,
        executionLockDigest: candidate.lock_payload_digest,
        commitSha: candidate.commit_sha,
        sourceDigest: candidate.source_digest,
        execution: Object.freeze({ ...lock.execution }),
        specRevisionId: lock.specRevisionId,
        specDigest: lock.specDigest,
        testPlanDigest: lock.testPlanDigest,
        runnerToolchainRevisionId: lock.runnerToolchainRevisionId,
        runnerToolchainDigest: lock.runnerToolchainDigest,
        targetMatrix: Object.freeze([...lock.targetMatrix]),
        requiredGodotVersion: lock.requiredGodotVersion,
        godotTestKitDigest: lock.godotTestKitDigest,
        exportTemplatesDigest: templatesDigest,
        runnerCapabilityDigest: runner.capabilityDigest,
        buildManifestDigest: lock.buildManifestDigest,
        sbomDigest: lock.sbomDigest,
        vulnerabilityScanDigest: lock.vulnerabilityScanDigest,
        assetLicenseLedgerDigest: lock.assetLicenseLedgerDigest,
        requiredEvidence: REQUIRED_RUNNER_EVIDENCE,
      });
      const signature = signCanonical(this.#signer.privateKey, payload);
      const job: SignedRunnerJob = Object.freeze({
        payload,
        signature: Object.freeze({ algorithm: "Ed25519", keyId: this.#signer.keyId, value: signature }),
      });
      const jobDigest = sha256Canonical(payload);
      await client.query(
        `INSERT INTO deviludo.e2e_platform_leases
          (tenant_id, project_id, attempt_id, platform, runner_id,
           fencing_token, lease_expires_at, last_seq_no, cursor,
           job_digest, job_signature, job, state, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5,
                 $6::bigint, $7::timestamptz, 0, $8::jsonb,
                 $9, $10, $11::jsonb, 'LEASED', $12::timestamptz, $12::timestamptz)`,
        [
          tenantId,
          candidate.project_id,
          candidate.attempt_id,
          runner.platform,
          runnerId,
          fencingToken,
          leaseExpiresAt,
          JSON.stringify({ lastAcceptedSeqNo: 0, completedPlatforms: {}, terminal: false }),
          jobDigest,
          signature,
          JSON.stringify(job),
          at,
        ],
      );
      const advanced = await client.query(
        `UPDATE deviludo.e2e_attempts
            SET state = 'RUNNING', updated_at = $3::timestamptz
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND state IN ('QUEUED', 'RUNNING')`,
        [tenantId, candidate.attempt_id, at],
      );
      if (advanced.rowCount !== 1) throw new Error("Runner attempt was no longer leasable");
      return job;
    });
  }

  /**
   * Serializes host draining with lease issuance on the immutable Runner row.
   * A signed activation grant is emitted only after the database observes no
   * unexpired LEASED/RUNNING slot for that exact workload identity.
   */
  async authorizeNativeInstall(
    identity: TlsRunnerIdentity,
    requestValue: RunnerNativeInstallAuthorizationRequest,
    at = new Date().toISOString(),
  ): Promise<RunnerNativeInstallAuthorizationResult> {
    validateRunnerIdentity(identity, at);
    const request = validateRunnerNativeInstallAuthorizationRequest(requestValue);
    const requestDigest = runnerNativeInstallRequestDigest(request);
    return this.#transaction(null, async (client) => {
      const runner = await registeredRunner(client, identity, request.currentRunnerId, "UPDATE");
      if (runner.state === "OFFLINE" || runner.state === "QUARANTINED"
        || runner.capabilityDigest !== request.currentCapabilityDigest
        || runner.platform !== request.platform || runner.architecture !== request.architecture) {
        throw new Error("Runner is not eligible for native installation");
      }
      if (request.currentRunnerId === request.targetRunnerId
        ? request.targetSpiffeId !== identity.spiffeId
        : request.targetSpiffeId === identity.spiffeId) {
        throw new Error("Runner native install target identity is invalid");
      }
      if (request.currentRunnerId !== request.targetRunnerId) {
        const targetRegistration = await client.query<{ id: string }>(
          `SELECT id
             FROM deviludo.runner_registrations
            WHERE id = $1 OR spiffe_id = $2
            FOR SHARE`,
          [request.targetRunnerId, request.targetSpiffeId],
        );
        if (targetRegistration.rows.length !== 0) {
          throw new Error("Runner native install target identity is already registered");
        }
      }

      const selected = await client.query<NativeInstallOperationRow>(
        `SELECT id::text, current_runner_id, current_spiffe_id,
                current_certificate_fingerprint, current_capability_digest,
                target_runner_id, target_spiffe_id, target_capability_digest,
                platform, architecture, plan_digest, staging_receipt_digest,
                release_id::text, release_digest, request, request_digest, state,
                completed_at::text
           FROM deviludo.runner_native_install_operations
          WHERE id = $1::uuid
             OR (current_runner_id = $2 AND state IN ('DRAINING', 'ACTIVATION_AUTHORIZED'))
             OR (target_runner_id = $3 AND target_spiffe_id = $4)
          FOR UPDATE`,
        [request.operationId, request.currentRunnerId, request.targetRunnerId, request.targetSpiffeId],
      );
      if (selected.rows.length > 1) throw new Error("Runner native install operation collides with another binding");
      const existing = selected.rows[0];
      if (existing) assertNativeInstallOperation(existing, request, identity, requestDigest);
      else {
        await client.query(
          `INSERT INTO deviludo.runner_native_install_operations
            (id, current_runner_id, current_spiffe_id, current_certificate_fingerprint,
             current_capability_digest, target_runner_id, target_spiffe_id,
             target_capability_digest, platform, architecture, plan_digest,
             staging_receipt_digest, release_id, release_digest, request,
             request_digest, state, requested_at)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   $12, $13::uuid, $14, $15::jsonb, $16, 'DRAINING', $17::timestamptz)`,
          [
            request.operationId, request.currentRunnerId, identity.spiffeId, identity.certificateFingerprint,
            request.currentCapabilityDigest, request.targetRunnerId, request.targetSpiffeId,
            request.targetCapabilityDigest, request.platform, request.architecture, request.planDigest,
            request.stagingReceiptDigest, request.releaseId, request.releaseDigest, JSON.stringify(request),
            requestDigest, at,
          ],
        );
      }
      if (existing && !new Set(["DRAINING", "ACTIVATION_AUTHORIZED"]).has(existing.state)) {
        throw new Error("Runner native install operation is terminal");
      }
      await client.query(
        `UPDATE deviludo.runner_registrations
            SET state = 'DRAINING', last_seen_at = $2::timestamptz
          WHERE id = $1 AND state IN ('ONLINE', 'DRAINING')`,
        [request.currentRunnerId, at],
      );
      const active = await client.query<{ active_lease_count: string | number }>(
        `SELECT COUNT(*) AS active_lease_count
           FROM deviludo.e2e_platform_leases
          WHERE runner_id = $1
            AND state IN ('LEASED', 'RUNNING')
            AND lease_expires_at >= $2::timestamptz`,
        [request.currentRunnerId, at],
      );
      const activeLeaseCount = Number(active.rows[0]?.active_lease_count);
      if (!Number.isSafeInteger(activeLeaseCount) || activeLeaseCount < 0) {
        throw new Error("Runner native install lease count is invalid");
      }
      if (activeLeaseCount > 0) {
        return createRunnerNativeInstallDrainReceipt({
          request, activeLeaseCount, observedAt: at, retryAfterSeconds: 5,
        });
      }

      const replay = await client.query<NativeInstallGrantRow>(
        `SELECT grant
           FROM deviludo.runner_native_install_grants
          WHERE operation_id = $1::uuid AND expires_at > $2::timestamptz
          ORDER BY grant_sequence DESC
          LIMIT 1
          FOR SHARE`,
        [request.operationId, at],
      );
      if (replay.rows[0]) {
        return verifyRunnerNativeInstallActivationGrant(parseJsonValue(replay.rows[0].grant), {
          publicKey: this.#publicKey, keyId: this.#signer.keyId, request, now: at,
        });
      }
      const sequenceResult = await client.query<{ next_sequence: string | number }>(
        `SELECT COALESCE(MAX(grant_sequence), 0) + 1 AS next_sequence
           FROM deviludo.runner_native_install_grants
          WHERE operation_id = $1::uuid`,
        [request.operationId],
      );
      const grantSequence = Number(sequenceResult.rows[0]?.next_sequence);
      if (!Number.isSafeInteger(grantSequence) || grantSequence < 1) {
        throw new Error("Runner native install grant sequence is invalid");
      }
      const payload = Object.freeze({
        schemaVersion: "deviludo.runner-native-install-activation-grant.v1" as const,
        operationId: request.operationId,
        grantSequence,
        currentRunnerId: request.currentRunnerId,
        currentSpiffeId: identity.spiffeId,
        currentCapabilityDigest: request.currentCapabilityDigest,
        targetRunnerId: request.targetRunnerId,
        targetSpiffeId: request.targetSpiffeId,
        targetCapabilityDigest: request.targetCapabilityDigest,
        platform: request.platform,
        architecture: request.architecture,
        planDigest: request.planDigest,
        stagingReceiptDigest: request.stagingReceiptDigest,
        releaseId: request.releaseId,
        releaseDigest: request.releaseDigest,
        requiredRunnerState: "DRAINING" as const,
        activeLeaseCount: 0 as const,
        issuedAt: at,
        expiresAt: new Date(Date.parse(at) + this.#nativeInstallGrantDurationSeconds * 1_000).toISOString(),
      });
      const signature = signCanonical(this.#signer.privateKey, payload);
      const grant = Object.freeze({
        payload,
        signature: Object.freeze({ algorithm: "Ed25519" as const, keyId: this.#signer.keyId, value: signature }),
      });
      await client.query(
        `INSERT INTO deviludo.runner_native_install_grants
          (operation_id, grant_sequence, grant, grant_digest, signing_key_id,
           signature, issued_at, expires_at)
         VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6, $7::timestamptz, $8::timestamptz)`,
        [
          request.operationId, grantSequence, JSON.stringify(grant), sha256Canonical(grant),
          this.#signer.keyId, signature, payload.issuedAt, payload.expiresAt,
        ],
      );
      await client.query(
        `UPDATE deviludo.runner_native_install_operations
            SET state = 'ACTIVATION_AUTHORIZED', authorized_at = COALESCE(authorized_at, $2::timestamptz)
          WHERE id = $1::uuid AND state IN ('DRAINING', 'ACTIVATION_AUTHORIZED')`,
        [request.operationId, at],
      );
      return grant;
    });
  }

  async completeNativeInstall(
    identity: TlsRunnerIdentity,
    grantValue: SignedRunnerNativeInstallActivationGrant,
    at = new Date().toISOString(),
  ): Promise<RunnerNativeInstallCompletionReceipt> {
    validateRunnerIdentity(identity, at);
    const grant = verifyRunnerNativeInstallActivationGrant(grantValue, {
      publicKey: this.#publicKey,
      keyId: this.#signer.keyId,
      now: at,
      allowExpired: true,
    });
    return this.#transaction(null, async (client) => {
      const current = await registeredRunnerWithoutIdentity(client, grant.payload.currentRunnerId, "UPDATE");
      const operationResult = await client.query<NativeInstallOperationRow>(
        `SELECT id::text, current_runner_id, current_spiffe_id,
                current_certificate_fingerprint, current_capability_digest,
                target_runner_id, target_spiffe_id, target_capability_digest,
                platform, architecture, plan_digest, staging_receipt_digest,
                release_id::text, release_digest, request, request_digest, state,
                completed_at::text
           FROM deviludo.runner_native_install_operations
          WHERE id = $1::uuid
          FOR UPDATE`,
        [grant.payload.operationId],
      );
      if (operationResult.rows.length !== 1) throw new Error("Runner native install operation is unavailable");
      const operation = operationResult.rows[0] as NativeInstallOperationRow;
      const request = validateRunnerNativeInstallAuthorizationRequest(parseJsonValue(operation.request));
      assertNativeInstallOperation(operation, request, {
        spiffeId: current.spiffeId,
        certificateFingerprint: current.certificateFingerprint,
        certificateSerial: current.certificateSerial,
        certificateNotAfter: current.certificateNotAfter,
      }, runnerNativeInstallRequestDigest(request));
      assertNativeInstallGrantBinding(grant, request, current.spiffeId);
      if (operation.state === "ACTIVATED") {
        if (operation.completed_at === null) throw new Error("Runner native install completion is inconsistent");
        return nativeInstallCompletionReceipt(grant, operation.completed_at);
      }
      if (operation.state !== "ACTIVATION_AUTHORIZED" || Date.parse(at) >= Date.parse(grant.payload.expiresAt)
        || current.state !== "DRAINING") {
        throw new Error("Runner native install activation grant is no longer usable");
      }
      const storedGrant = await client.query<NativeInstallGrantRow>(
        `SELECT grant, grant_digest
           FROM deviludo.runner_native_install_grants
          WHERE operation_id = $1::uuid AND grant_sequence = $2
          FOR SHARE`,
        [grant.payload.operationId, grant.payload.grantSequence],
      );
      if (storedGrant.rows.length !== 1
        || storedGrant.rows[0]?.grant_digest !== sha256Canonical(grant)
        || sha256Canonical(parseJsonValue(storedGrant.rows[0]?.grant)) !== sha256Canonical(grant)) {
        throw new Error("Runner native install activation grant is not authoritative");
      }
      const target = await registeredRunner(client, identity, grant.payload.targetRunnerId, "UPDATE");
      if (target.capabilityDigest !== grant.payload.targetCapabilityDigest
        || target.spiffeId !== grant.payload.targetSpiffeId || target.platform !== grant.payload.platform
        || target.architecture !== grant.payload.architecture
        || target.state !== "DRAINING") {
        throw new Error("Activated Runner does not match the authorized target");
      }
      const sameIdentity = target.runnerId === current.runnerId;
      await client.query(
        `UPDATE deviludo.runner_registrations
            SET state = $2, last_seen_at = $3::timestamptz
          WHERE id = $1 AND state = $4`,
        [current.runnerId, sameIdentity ? "ONLINE" : "OFFLINE", at, "DRAINING"],
      );
      if (!sameIdentity) {
        await client.query(
          `UPDATE deviludo.runner_registrations
              SET state = 'ONLINE', last_seen_at = $2::timestamptz
            WHERE id = $1 AND state = 'DRAINING'`,
          [target.runnerId, at],
        );
      }
      await client.query(
        `UPDATE deviludo.runner_native_install_operations
            SET state = 'ACTIVATED', completed_at = $2::timestamptz
          WHERE id = $1::uuid AND state = 'ACTIVATION_AUTHORIZED'`,
        [grant.payload.operationId, at],
      );
      return nativeInstallCompletionReceipt(grant, at);
    });
  }

  async rollbackNativeInstall(
    identity: TlsRunnerIdentity,
    grantValue: SignedRunnerNativeInstallActivationGrant,
    failureEvidenceDigest: string,
    at = new Date().toISOString(),
  ): Promise<RunnerNativeInstallRollbackReceipt> {
    validateRunnerIdentity(identity, at);
    if (!SHA256.test(failureEvidenceDigest)) throw new Error("Runner native install failure evidence is invalid");
    const grant = verifyRunnerNativeInstallActivationGrant(grantValue, {
      publicKey: this.#publicKey,
      keyId: this.#signer.keyId,
      now: at,
      allowExpired: true,
    });
    return this.#transaction(null, async (client) => {
      const current = await registeredRunner(client, identity, grant.payload.currentRunnerId, "UPDATE");
      const operationResult = await client.query<NativeInstallOperationRow>(
        `SELECT id::text, current_runner_id, current_spiffe_id,
                current_certificate_fingerprint, current_capability_digest,
                target_runner_id, target_spiffe_id, target_capability_digest,
                platform, architecture, plan_digest, staging_receipt_digest,
                release_id::text, release_digest, request, request_digest, state,
                completed_at::text
           FROM deviludo.runner_native_install_operations
          WHERE id = $1::uuid
          FOR UPDATE`,
        [grant.payload.operationId],
      );
      if (operationResult.rows.length !== 1) throw new Error("Runner native install operation is unavailable");
      const operation = operationResult.rows[0] as NativeInstallOperationRow;
      const request = validateRunnerNativeInstallAuthorizationRequest(parseJsonValue(operation.request));
      assertNativeInstallOperation(operation, request, identity, runnerNativeInstallRequestDigest(request));
      assertNativeInstallGrantBinding(grant, request, current.spiffeId);
      const replay = await client.query<NativeInstallRollbackRow>(
        `SELECT failure_evidence_digest, receipt, receipt_digest
           FROM deviludo.runner_native_install_rollbacks
          WHERE operation_id = $1::uuid
          FOR SHARE`,
        [grant.payload.operationId],
      );
      if (replay.rows[0]) {
        const receipt = validateNativeInstallRollbackReceipt(parseJsonValue(replay.rows[0].receipt), grant);
        if (operation.state !== "ROLLED_BACK" || replay.rows[0].failure_evidence_digest !== failureEvidenceDigest
          || receipt.failureEvidenceDigest !== failureEvidenceDigest
          || replay.rows[0].receipt_digest !== sha256Canonical(receipt)) {
          throw new Error("Runner native install rollback conflicts with its immutable receipt");
        }
        return receipt;
      }
      if (operation.state !== "ACTIVATION_AUTHORIZED" || current.state !== "DRAINING") {
        throw new Error("Runner native install operation cannot be rolled back");
      }
      const storedGrant = await client.query<NativeInstallGrantRow>(
        `SELECT grant, grant_digest
           FROM deviludo.runner_native_install_grants
          WHERE operation_id = $1::uuid AND grant_sequence = $2
          FOR SHARE`,
        [grant.payload.operationId, grant.payload.grantSequence],
      );
      if (storedGrant.rows.length !== 1 || storedGrant.rows[0]?.grant_digest !== sha256Canonical(grant)
        || sha256Canonical(parseJsonValue(storedGrant.rows[0]?.grant)) !== sha256Canonical(grant)) {
        throw new Error("Runner native install activation grant is not authoritative");
      }
      if (grant.payload.targetRunnerId !== current.runnerId) {
        const target = await optionalRegisteredRunnerWithoutIdentity(client, grant.payload.targetRunnerId, "UPDATE");
        if (target) {
          if (target.spiffeId !== grant.payload.targetSpiffeId
            || target.capabilityDigest !== grant.payload.targetCapabilityDigest) {
            throw new Error("Runner native install rollback target conflicts with its registration");
          }
          await client.query(
            `UPDATE deviludo.runner_registrations
                SET state = 'QUARANTINED', last_seen_at = $2::timestamptz
              WHERE id = $1 AND state IN ('ONLINE', 'DRAINING')`,
            [target.runnerId, at],
          );
        }
      }
      await client.query(
        `UPDATE deviludo.runner_registrations
            SET state = 'ONLINE', last_seen_at = $2::timestamptz
          WHERE id = $1 AND state = 'DRAINING'`,
        [current.runnerId, at],
      );
      await client.query(
        `UPDATE deviludo.runner_native_install_operations
            SET state = 'ROLLED_BACK', completed_at = $2::timestamptz
          WHERE id = $1::uuid AND state = 'ACTIVATION_AUTHORIZED'`,
        [grant.payload.operationId, at],
      );
      const receipt = nativeInstallRollbackReceipt(grant, failureEvidenceDigest, at);
      await client.query(
        `INSERT INTO deviludo.runner_native_install_rollbacks
          (operation_id, grant_sequence, failure_evidence_digest, receipt, receipt_digest, rolled_back_at)
         VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6::timestamptz)`,
        [
          grant.payload.operationId, grant.payload.grantSequence, failureEvidenceDigest,
          JSON.stringify(receipt), sha256Canonical(receipt), at,
        ],
      );
      return receipt;
    });
  }

  async submitEvidence(
    identity: TlsRunnerIdentity,
    tenantId: string,
    manifest: PlatformEvidenceManifest,
    at = new Date().toISOString(),
  ): Promise<PlatformEvidenceManifest> {
    validateRunnerIdentity(identity, at);
    if (!UUID.test(tenantId)) throw new Error("Runner tenant assignment is invalid");
    return this.#transaction(tenantId, async (client) => {
      const runner = await registeredRunner(client, identity, manifest.runnerId);
      await this.#authorizeAssignment(identity, runner, tenantId);
      const lease = await loadLease(client, tenantId, manifest.attemptId, manifest.platform, manifest.fencingToken);
      const job = validateLeaseJob(lease, this.#publicKey, this.#signer.keyId, tenantId, runner);
      if (lease.state !== "RUNNING" || Date.parse(at) > Date.parse(lease.lease_expires_at)) {
        throw new Error("Runner evidence is outside an active started lease");
      }
      const binding = evidenceBinding(job.payload);
      validatePlatformEvidenceManifest(manifest, binding, runner, platformLease(job.payload));
      if (lease.evidence_manifest !== null) {
        const existing = parseEvidenceManifest(lease.evidence_manifest);
        validatePlatformEvidenceManifest(existing, binding, runner, platformLease(job.payload));
        if (existing.manifestDigest !== manifest.manifestDigest
          || sha256Canonical(existing) !== sha256Canonical(manifest)) {
          throw new Error("Platform evidence conflicts with its immutable lease slot");
        }
        return existing;
      }
      const stored = await client.query(
        `UPDATE deviludo.e2e_platform_leases
            SET evidence_manifest = $6::jsonb,
                evidence_manifest_digest = $7,
                updated_at = $8::timestamptz
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND runner_id = $3 AND platform = $4
            AND fencing_token = $5::bigint
            AND state = 'RUNNING' AND evidence_manifest IS NULL
        RETURNING id::text`,
        [
          tenantId, lease.id, runner.runnerId, runner.platform, manifest.fencingToken,
          JSON.stringify(manifest), manifest.manifestDigest, at,
        ],
      );
      if (stored.rowCount !== 1) throw new Error("Platform evidence lease was lost before persistence");
      return Object.freeze({ ...manifest });
    });
  }

  async acceptEvent(
    identity: TlsRunnerIdentity,
    tenantId: string,
    event: RunnerEvent,
    receivedAt = new Date().toISOString(),
  ): Promise<RunnerEventReceipt> {
    validateRunnerIdentity(identity, receivedAt);
    if (!UUID.test(tenantId)) throw new Error("Runner tenant assignment is invalid");
    return this.#transaction(tenantId, async (client) => {
      const runner = await registeredRunner(client, identity, event.runnerId);
      await this.#authorizeAssignment(identity, runner, tenantId);
      const attemptResult = await client.query<AttemptStateRow>(
        `SELECT state, project_id::text
           FROM deviludo.e2e_attempts
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [tenantId, event.attemptId],
      );
      if (attemptResult.rows.length !== 1) throw new Error("Runner attempt is not visible in its assigned tenant");
      const attempt = attemptResult.rows[0] as AttemptStateRow;
      const lease = await loadLease(client, tenantId, event.attemptId, event.platform, event.fencingToken);
      const job = validateLeaseJob(lease, this.#publicKey, this.#signer.keyId, tenantId, runner);
      const cursor = parseCursor(lease.cursor);

      const replay = await client.query<EventRow>(
        `SELECT runner_id, platform, fencing_token, seq_no, commit_sha,
                source_digest, event_type, status, artifact_digest,
                occurred_at::text
           FROM deviludo.platform_runner_events
          WHERE tenant_id = $1::uuid
            AND platform_lease_id = $2::uuid
            AND seq_no = $3::bigint`,
        [tenantId, lease.id, event.seqNo],
      );
      if (replay.rows[0]) {
        assertEventReplay(replay.rows[0], event);
        return Object.freeze({ accepted: true, attemptState: parseAttemptState(attempt.state), cursor, event, evidenceBundle: null });
      }
      if (attempt.state === "PASSED" || attempt.state === "FAILED" || attempt.state === "INVALIDATED") {
        throw new Error("Runner attempt is terminal");
      }
      validateRunnerEventShape(event, cursor, receivedAt);
      if (event.type === "PLATFORM_COMPLETED") {
        if (lease.evidence_manifest === null) throw new Error("Platform completion requires persisted evidence");
        const evidence = parseEvidenceManifest(lease.evidence_manifest);
        validatePlatformEvidenceManifest(evidence, evidenceBinding(job.payload), runner, platformLease(job.payload));
        if (event.artifactDigest !== evidence.manifestDigest || event.status !== evidence.status) {
          throw new Error("Platform completion does not match its persisted evidence");
        }
      }
      const decision = acceptPlatformRunnerEvent(platformLease(job.payload), cursor, event, receivedAt);
      if (!decision.accepted) throw new Error(`Runner event rejected: ${decision.reason}`);
      await client.query(
        `INSERT INTO deviludo.platform_runner_events
          (tenant_id, attempt_id, platform_lease_id, runner_id, platform,
           fencing_token, seq_no, commit_sha, source_digest, event_type,
           status, artifact_digest, occurred_at, received_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5,
                 $6::bigint, $7::bigint, $8, $9, $10,
                 $11, $12, $13::timestamptz, $14::timestamptz)`,
        [
          tenantId, event.attemptId, lease.id, event.runnerId, event.platform,
          event.fencingToken, event.seqNo, event.commitSha, event.sourceDigest,
          event.type, event.status, event.artifactDigest, event.occurredAt, receivedAt,
        ],
      );
      const leaseState = event.type === "PLATFORM_COMPLETED" ? event.status : "RUNNING";
      const advanced = await client.query(
        `UPDATE deviludo.e2e_platform_leases
            SET last_seq_no = $6::bigint, cursor = $7::jsonb,
                state = $8, updated_at = $9::timestamptz
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND runner_id = $3 AND platform = $4
            AND fencing_token = $5::bigint
            AND last_seq_no = $6::bigint - 1
        RETURNING id::text`,
        [
          tenantId, lease.id, event.runnerId, event.platform, event.fencingToken,
          event.seqNo, JSON.stringify(decision.cursor), leaseState, receivedAt,
        ],
      );
      if (advanced.rowCount !== 1) throw new Error("Runner event cursor was concurrently advanced");

      let evidenceBundle: EvidenceBundle | null = null;
      let attemptState: RunnerEventReceipt["attemptState"] = "RUNNING";
      if (event.type === "PLATFORM_COMPLETED") {
        evidenceBundle = await this.#completeMatrixIfReady(
          client, tenantId, attempt.project_id, job, event.occurredAt, receivedAt,
        );
        if (evidenceBundle) attemptState = evidenceBundle.status;
      }
      return Object.freeze({ accepted: true, attemptState, cursor: decision.cursor, event, evidenceBundle });
    });
  }

  async #completeMatrixIfReady(
    client: PostgresWorkflowClient,
    tenantId: string,
    projectId: string,
    completedJob: SignedRunnerJob,
    finalEventOccurredAt: string,
    completedAt: string,
  ): Promise<EvidenceBundle | null> {
    const result = await client.query<LeaseRow>(
      `SELECT lease.id::text, lease.project_id::text, lease.attempt_id::text,
              lease.runner_id, lease.platform, lease.fencing_token,
              lease.lease_expires_at::text, lease.last_seq_no, lease.cursor,
              lease.job, lease.job_digest, lease.job_signature,
              lease.evidence_manifest, lease.evidence_manifest_digest,
              lease.state
         FROM deviludo.e2e_platform_leases lease
         JOIN (
           SELECT platform, MAX(fencing_token) AS fencing_token
             FROM deviludo.e2e_platform_leases
            WHERE tenant_id = $1::uuid AND attempt_id = $2::uuid
            GROUP BY platform
         ) latest ON latest.platform = lease.platform
                 AND latest.fencing_token = lease.fencing_token
        WHERE lease.tenant_id = $1::uuid AND lease.attempt_id = $2::uuid
        ORDER BY lease.platform
        FOR UPDATE OF lease`,
      [tenantId, completedJob.payload.attemptId],
    );
    if (result.rows.length !== completedJob.payload.targetMatrix.length) return null;
    const evidence = new Map<TargetPlatform, PlatformEvidenceManifest>();
    for (const row of result.rows) {
      const platform = runnerPlatform(row.platform);
      if (!completedJob.payload.targetMatrix.includes(platform)
        || (row.state !== "PASSED" && row.state !== "FAILED")
        || row.evidence_manifest === null) return null;
      const platformJob = parseStoredJob(row, this.#publicKey, this.#signer.keyId);
      const token = Number(row.fencing_token);
      if (!Number.isSafeInteger(token) || token < 1
        || platformJob.payload.runnerId !== row.runner_id
        || platformJob.payload.platform !== platform
        || platformJob.payload.fencingToken !== token
        || platformJob.payload.leaseExpiresAt !== row.lease_expires_at
        || sha256Canonical(commonJobBinding(platformJob.payload))
          !== sha256Canonical(commonJobBinding(completedJob.payload))) {
        throw new Error("Terminal platform signed job does not match the matrix lock");
      }
      const manifest = parseEvidenceManifest(row.evidence_manifest);
      if (manifest.platform !== platform || manifest.manifestDigest !== row.evidence_manifest_digest) {
        throw new Error("Terminal platform evidence is inconsistent");
      }
      validatePlatformEvidenceManifest(
        manifest,
        evidenceBinding(platformJob.payload),
        {
          runnerId: platformJob.payload.runnerId,
          platform,
          exportTemplatesDigest: platformJob.payload.exportTemplatesDigest,
          capabilityDigest: platformJob.payload.runnerCapabilityDigest,
        },
        platformLease(platformJob.payload),
      );
      if (manifest.status !== row.state) throw new Error("Terminal platform state does not match its evidence");
      evidence.set(platform, manifest);
    }
    if (evidence.size !== completedJob.payload.targetMatrix.length) throw new Error("Terminal matrix platform coverage is invalid");
    const platformEvidence = completedJob.payload.targetMatrix.map((platform) => {
      const value = evidence.get(platform);
      if (!value) throw new Error("Terminal matrix is missing platform evidence");
      return {
        platform,
        runnerId: value.runnerId,
        runnerCapabilityDigest: value.runnerCapabilityDigest,
        exportDigest: value.exportDigest,
        logsDigest: value.logsDigest,
        junitDigest: value.junitDigest,
        inputTimelineDigest: value.inputTimelineDigest,
        screenshotManifestDigest: value.screenshotManifestDigest,
        videoManifestDigest: value.videoManifestDigest,
        status: value.status,
      };
    });
    const status: "PASSED" | "FAILED" = platformEvidence.every((item) => item.status === "PASSED") ? "PASSED" : "FAILED";
    const createdAt = new Date(Math.max(
      Date.parse(finalEventOccurredAt),
      ...[...evidence.values()].map((manifest) => Date.parse(manifest.createdAt)),
    )).toISOString();
    const core = {
      id: completedJob.payload.attemptId,
      attemptId: completedJob.payload.attemptId,
      specRevisionId: completedJob.payload.specRevisionId,
      specDigest: completedJob.payload.specDigest,
      testPlanDigest: completedJob.payload.testPlanDigest,
      commitSha: completedJob.payload.commitSha,
      sourceDigest: completedJob.payload.sourceDigest,
      targetMatrix: completedJob.payload.targetMatrix,
      godotTestKitDigest: completedJob.payload.godotTestKitDigest,
      buildManifestDigest: completedJob.payload.buildManifestDigest,
      sbomDigest: completedJob.payload.sbomDigest,
      vulnerabilityScanDigest: completedJob.payload.vulnerabilityScanDigest,
      assetLicenseLedgerDigest: completedJob.payload.assetLicenseLedgerDigest,
      platformEvidence,
      status,
      valid: true as const,
      createdAt,
    };
    const bundle = createEvidenceBundle({ ...core, bundleDigest: sha256Canonical(core) }) as EvidenceBundle;
    const archived = await this.#evidenceArchive.persistBundle({ tenantId, projectId, bundle });
    validateArchiveReceipt(archived, tenantId, projectId, bundle);
    const binding = {
      schemaVersion: "deviludo.evidence-binding.v1",
      attemptId: bundle.attemptId,
      executionLockId: completedJob.payload.executionLockId,
      executionLockDigest: completedJob.payload.executionLockDigest,
      specRevisionId: bundle.specRevisionId,
      specDigest: bundle.specDigest,
      testPlanDigest: bundle.testPlanDigest,
      runnerToolchainRevisionId: completedJob.payload.runnerToolchainRevisionId,
      runnerToolchainDigest: completedJob.payload.runnerToolchainDigest,
      commitSha: bundle.commitSha,
      sourceDigest: bundle.sourceDigest,
      targetMatrix: bundle.targetMatrix,
    };
    await client.query(
      `INSERT INTO deviludo.evidence_bundles
        (id, tenant_id, project_id, attempt_id, commit_sha, source_digest,
         binding, manifest, bundle_digest, object_key, status, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
               $7::jsonb, $8::jsonb, $9, $10, $11, $12::timestamptz)`,
      [
        bundle.id, tenantId, projectId, bundle.attemptId, bundle.commitSha, bundle.sourceDigest,
        JSON.stringify(binding), JSON.stringify(bundle), bundle.bundleDigest,
        archived.objectKey, bundle.status, bundle.createdAt,
      ],
    );
    const terminal = await client.query(
      `UPDATE deviludo.e2e_attempts
          SET state = $3, repair_prompt_id = $4,
              completed_at = $5::timestamptz, updated_at = $5::timestamptz
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'RUNNING'
      RETURNING id::text`,
      [tenantId, bundle.attemptId, bundle.status, archived.repairPromptId, completedAt],
    );
    if (terminal.rowCount !== 1) throw new Error("Runner matrix attempt was no longer completable");
    return bundle;
  }

  async #authorizeAssignment(identity: TlsRunnerIdentity, runner: RegisteredRunner, tenantId: string): Promise<void> {
    if (!(await this.#assignments.authorize({ identity, runner, tenantId }))) {
      throw new Error("Runner is not assigned to this tenant");
    }
  }

  async #transaction<T>(tenantId: string | null, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      if (tenantId !== null) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the operation error */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

async function registeredRunner(
  client: PostgresWorkflowClient,
  identity: TlsRunnerIdentity,
  runnerId: string,
  lock: "SHARE" | "UPDATE" = "SHARE",
): Promise<RegisteredRunner> {
  const runner = await registeredRunnerWithoutIdentity(client, runnerId, lock);
  if (runner.spiffeId !== identity.spiffeId
    || runner.certificateFingerprint !== identity.certificateFingerprint
    || runner.certificateSerial !== identity.certificateSerial
    || runner.certificateNotAfter !== identity.certificateNotAfter) {
    throw new Error("Runner workload identity does not match its registration");
  }
  return runner;
}

async function registeredRunnerWithoutIdentity(
  client: PostgresWorkflowClient,
  runnerId: string,
  lock: "SHARE" | "UPDATE" = "SHARE",
): Promise<RegisteredRunner> {
  const selected = await client.query<RunnerRow>(
    `SELECT id, spiffe_id, certificate_fingerprint, certificate_serial,
            certificate_not_after::text, platform, architecture,
            capability_digest, capabilities, state,
            registered_at::text, last_seen_at::text
      FROM deviludo.runner_registrations
      WHERE id = $1
      ${lock === "UPDATE" ? "FOR UPDATE" : "FOR SHARE"}`,
    [runnerId],
  );
  if (selected.rows.length !== 1) throw new Error("Runner is not registered");
  return parseRegisteredRunner(selected.rows[0] as RunnerRow);
}

async function optionalRegisteredRunnerWithoutIdentity(
  client: PostgresWorkflowClient,
  runnerId: string,
  lock: "SHARE" | "UPDATE" = "SHARE",
): Promise<RegisteredRunner | null> {
  const selected = await client.query<RunnerRow>(
    `SELECT id, spiffe_id, certificate_fingerprint, certificate_serial,
            certificate_not_after::text, platform, architecture,
            capability_digest, capabilities, state,
            registered_at::text, last_seen_at::text
       FROM deviludo.runner_registrations
      WHERE id = $1
      ${lock === "UPDATE" ? "FOR UPDATE" : "FOR SHARE"}`,
    [runnerId],
  );
  if (selected.rows.length > 1) throw new Error("Runner registration is ambiguous");
  return selected.rows[0] ? parseRegisteredRunner(selected.rows[0]) : null;
}

function assertNativeInstallOperation(
  row: NativeInstallOperationRow,
  request: RunnerNativeInstallAuthorizationRequest,
  identity: TlsRunnerIdentity,
  requestDigest: string,
): void {
  const stored = validateRunnerNativeInstallAuthorizationRequest(parseJsonValue(row.request));
  if (row.id !== request.operationId || row.current_runner_id !== request.currentRunnerId
    || row.current_spiffe_id !== identity.spiffeId
    || row.current_certificate_fingerprint !== identity.certificateFingerprint
    || row.current_capability_digest !== request.currentCapabilityDigest
    || row.target_runner_id !== request.targetRunnerId || row.target_spiffe_id !== request.targetSpiffeId
    || row.target_capability_digest !== request.targetCapabilityDigest || row.platform !== request.platform
    || row.architecture !== request.architecture || row.plan_digest !== request.planDigest
    || row.staging_receipt_digest !== request.stagingReceiptDigest || row.release_id !== request.releaseId
    || row.release_digest !== request.releaseDigest || row.request_digest !== requestDigest
    || runnerNativeInstallRequestDigest(stored) !== requestDigest) {
    throw new Error("Runner native install operation conflicts with its immutable binding");
  }
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch { throw new Error("Stored Runner native install JSON is invalid"); }
}

function assertNativeInstallGrantBinding(
  grant: SignedRunnerNativeInstallActivationGrant,
  request: RunnerNativeInstallAuthorizationRequest,
  currentSpiffeId: string,
): void {
  const payload = grant.payload;
  if (payload.operationId !== request.operationId || payload.currentRunnerId !== request.currentRunnerId
    || payload.currentSpiffeId !== currentSpiffeId || payload.currentCapabilityDigest !== request.currentCapabilityDigest
    || payload.targetRunnerId !== request.targetRunnerId || payload.targetSpiffeId !== request.targetSpiffeId
    || payload.targetCapabilityDigest !== request.targetCapabilityDigest || payload.platform !== request.platform
    || payload.architecture !== request.architecture || payload.planDigest !== request.planDigest
    || payload.stagingReceiptDigest !== request.stagingReceiptDigest || payload.releaseId !== request.releaseId
    || payload.releaseDigest !== request.releaseDigest || payload.activeLeaseCount !== 0
    || payload.requiredRunnerState !== "DRAINING") {
    throw new Error("Runner native install activation grant binding is invalid");
  }
}

function nativeInstallCompletionReceipt(
  grant: SignedRunnerNativeInstallActivationGrant,
  completedAt: string,
): RunnerNativeInstallCompletionReceipt {
  return Object.freeze({
    schemaVersion: "deviludo.runner-native-install-completion-receipt.v1",
    operationId: grant.payload.operationId,
    state: "ACTIVATED",
    currentRunnerId: grant.payload.currentRunnerId,
    targetRunnerId: grant.payload.targetRunnerId,
    targetCapabilityDigest: grant.payload.targetCapabilityDigest,
    planDigest: grant.payload.planDigest,
    releaseId: grant.payload.releaseId,
    releaseDigest: grant.payload.releaseDigest,
    completedAt: requiredDate(completedAt),
  });
}

function nativeInstallRollbackReceipt(
  grant: SignedRunnerNativeInstallActivationGrant,
  failureEvidenceDigest: string,
  rolledBackAt: string,
): RunnerNativeInstallRollbackReceipt {
  return Object.freeze({
    schemaVersion: "deviludo.runner-native-install-rollback-receipt.v1",
    operationId: grant.payload.operationId,
    state: "ROLLED_BACK",
    currentRunnerId: grant.payload.currentRunnerId,
    rejectedTargetRunnerId: grant.payload.targetRunnerId,
    planDigest: grant.payload.planDigest,
    releaseId: grant.payload.releaseId,
    failureEvidenceDigest,
    rolledBackAt: requiredDate(rolledBackAt),
  });
}

function validateNativeInstallRollbackReceipt(
  value: unknown,
  grant: SignedRunnerNativeInstallActivationGrant,
): RunnerNativeInstallRollbackReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored Runner native install rollback receipt is invalid");
  }
  const receipt = value as Record<string, unknown>;
  const keys = [
    "currentRunnerId", "failureEvidenceDigest", "operationId", "planDigest", "rejectedTargetRunnerId",
    "releaseId", "rolledBackAt", "schemaVersion", "state",
  ];
  if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(keys.sort())
    || receipt.schemaVersion !== "deviludo.runner-native-install-rollback-receipt.v1"
    || receipt.operationId !== grant.payload.operationId || receipt.state !== "ROLLED_BACK"
    || receipt.currentRunnerId !== grant.payload.currentRunnerId
    || receipt.rejectedTargetRunnerId !== grant.payload.targetRunnerId
    || receipt.planDigest !== grant.payload.planDigest || receipt.releaseId !== grant.payload.releaseId
    || typeof receipt.failureEvidenceDigest !== "string" || !SHA256.test(receipt.failureEvidenceDigest)
    || typeof receipt.rolledBackAt !== "string") {
    throw new Error("Stored Runner native install rollback receipt is invalid");
  }
  return nativeInstallRollbackReceipt(grant, receipt.failureEvidenceDigest, receipt.rolledBackAt);
}

async function loadLease(
  client: PostgresWorkflowClient,
  tenantId: string,
  attemptId: string,
  platform: TargetPlatform,
  fencingToken: number,
): Promise<LeaseRow> {
  const result = await client.query<LeaseRow>(
    `SELECT id::text, project_id::text, attempt_id::text, runner_id,
            platform, fencing_token, lease_expires_at::text, last_seq_no,
            cursor, job, job_digest, job_signature, evidence_manifest,
            evidence_manifest_digest, state
       FROM deviludo.e2e_platform_leases
      WHERE tenant_id = $1::uuid AND attempt_id = $2::uuid
        AND platform = $3 AND fencing_token = $4::bigint
      FOR UPDATE`,
    [tenantId, attemptId, platform, fencingToken],
  );
  if (result.rows.length !== 1) throw new Error("Platform lease is not visible for this fencing token");
  return result.rows[0] as LeaseRow;
}

function validateLeaseJob(
  lease: LeaseRow,
  publicKey: KeyObject,
  keyId: string,
  tenantId: string,
  runner: RegisteredRunner,
): SignedRunnerJob {
  const job = parseStoredJob(lease, publicKey, keyId);
  const token = Number(lease.fencing_token);
  if (!UUID.test(lease.id) || !UUID.test(lease.project_id) || !UUID.test(lease.attempt_id)
    || !Number.isSafeInteger(token) || token < 1
    || lease.runner_id !== runner.runnerId || runnerPlatform(lease.platform) !== runner.platform
    || job.payload.tenantId !== tenantId || job.payload.projectId !== lease.project_id
    || job.payload.attemptId !== lease.attempt_id || job.payload.runnerId !== lease.runner_id
    || job.payload.platform !== runner.platform || job.payload.fencingToken !== token
    || job.payload.leaseExpiresAt !== lease.lease_expires_at
    || job.payload.runnerCapabilityDigest !== runner.capabilityDigest
    || !["LEASED", "RUNNING", "PASSED", "FAILED", "EXPIRED", "INVALIDATED"].includes(lease.state)) {
    throw new Error("Stored Runner job does not match its platform lease");
  }
  return job;
}

function platformLease(payload: RunnerJobPayload): PlatformRunnerLease {
  return Object.freeze({
    attemptId: payload.attemptId,
    runnerId: payload.runnerId,
    platform: payload.platform,
    fencingToken: payload.fencingToken,
    leaseExpiresAt: payload.leaseExpiresAt,
    commitSha: payload.commitSha,
    sourceDigest: payload.sourceDigest,
    specRevisionId: payload.specRevisionId,
    specDigest: payload.specDigest,
    testPlanDigest: payload.testPlanDigest,
    targetMatrix: payload.targetMatrix,
  });
}

function evidenceBinding(payload: RunnerJobPayload) {
  return Object.freeze({
    attemptId: payload.attemptId,
    commitSha: payload.commitSha,
    sourceDigest: payload.sourceDigest,
    specRevisionId: payload.specRevisionId,
    specDigest: payload.specDigest,
    testPlanDigest: payload.testPlanDigest,
    runnerToolchainRevisionId: payload.runnerToolchainRevisionId,
    runnerToolchainDigest: payload.runnerToolchainDigest,
    targetMatrix: payload.targetMatrix,
    godotTestKitDigest: payload.godotTestKitDigest,
  });
}

function commonJobBinding(payload: RunnerJobPayload) {
  return {
    schemaVersion: payload.schemaVersion,
    attemptId: payload.attemptId,
    tenantId: payload.tenantId,
    projectId: payload.projectId,
    runId: payload.runId,
    iterationId: payload.iterationId,
    executionLockId: payload.executionLockId,
    executionLockDigest: payload.executionLockDigest,
    commitSha: payload.commitSha,
    sourceDigest: payload.sourceDigest,
    execution: payload.execution,
    specRevisionId: payload.specRevisionId,
    specDigest: payload.specDigest,
    testPlanDigest: payload.testPlanDigest,
    targetMatrix: payload.targetMatrix,
    requiredGodotVersion: payload.requiredGodotVersion,
    godotTestKitDigest: payload.godotTestKitDigest,
    buildManifestDigest: payload.buildManifestDigest,
    sbomDigest: payload.sbomDigest,
    vulnerabilityScanDigest: payload.vulnerabilityScanDigest,
    assetLicenseLedgerDigest: payload.assetLicenseLedgerDigest,
    requiredEvidence: payload.requiredEvidence,
  };
}

function parseCursor(value: unknown): RunnerEventCursor {
  const body = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Stored Runner event cursor is invalid");
  const row = body as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["completedPlatforms", "lastAcceptedSeqNo", "terminal"])) {
    throw new Error("Stored Runner event cursor is invalid");
  }
  if (!Number.isSafeInteger(row.lastAcceptedSeqNo) || (row.lastAcceptedSeqNo as number) < 0
    || typeof row.terminal !== "boolean" || !row.completedPlatforms
    || typeof row.completedPlatforms !== "object" || Array.isArray(row.completedPlatforms)) {
    throw new Error("Stored Runner event cursor is invalid");
  }
  const completed: Partial<Record<TargetPlatform, "PASSED" | "FAILED">> = {};
  for (const [platformValue, status] of Object.entries(row.completedPlatforms as Record<string, unknown>)) {
    const platform = runnerPlatform(platformValue);
    if (status !== "PASSED" && status !== "FAILED") throw new Error("Stored Runner event cursor is invalid");
    completed[platform] = status;
  }
  return Object.freeze({
    lastAcceptedSeqNo: row.lastAcceptedSeqNo as number,
    completedPlatforms: Object.freeze(completed),
    terminal: row.terminal,
  });
}

function parseEvidenceManifest(value: unknown): PlatformEvidenceManifest {
  const body = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Stored platform evidence is invalid");
  return Object.freeze({ ...(body as PlatformEvidenceManifest) });
}

function assertEventReplay(row: EventRow, event: RunnerEvent): void {
  if (row.runner_id !== event.runnerId || runnerPlatform(row.platform) !== event.platform
    || Number(row.fencing_token) !== event.fencingToken || Number(row.seq_no) !== event.seqNo
    || row.commit_sha !== event.commitSha || row.source_digest !== event.sourceDigest
    || row.event_type !== event.type || row.status !== event.status
    || row.artifact_digest !== event.artifactDigest
    || Date.parse(row.occurred_at) !== Date.parse(event.occurredAt)) {
    throw new Error("Runner event sequence was replayed with different content");
  }
}

function parseAttemptState(value: string): RunnerEventReceipt["attemptState"] {
  if (value !== "QUEUED" && value !== "RUNNING" && value !== "PASSED"
    && value !== "FAILED" && value !== "INVALIDATED") {
    throw new Error("Stored Runner attempt state is invalid");
  }
  return value;
}

function validateArchiveReceipt(
  receipt: Readonly<{ objectKey: string; repairPromptId: string | null }>,
  tenantId: string,
  projectId: string,
  bundle: EvidenceBundle,
): void {
  const prefix = `tenants/${tenantId}/projects/${projectId}/evidence/`;
  if (!receipt.objectKey.startsWith(prefix) || receipt.objectKey.includes("..")
    || !receipt.objectKey.endsWith(`${bundle.bundleDigest}.json`)) {
    throw new Error("Evidence archive returned an invalid object key");
  }
  if (bundle.status === "PASSED" ? receipt.repairPromptId !== null
    : typeof receipt.repairPromptId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(receipt.repairPromptId)) {
    throw new Error("Evidence archive returned an invalid repair prompt binding");
  }
}

function parseRegisteredRunner(row: RunnerRow): RegisteredRunner {
  const capabilities = parseCapabilities(row.capabilities);
  validateRunnerCapabilities(capabilities);
  if (row.id !== capabilities.runnerId || row.platform !== capabilities.platform
    || row.architecture !== capabilities.architecture || row.capability_digest !== capabilities.capabilityDigest) {
    throw new Error("Stored Runner registration is inconsistent");
  }
  if (row.state !== "ONLINE" && row.state !== "DRAINING" && row.state !== "OFFLINE" && row.state !== "QUARANTINED") {
    throw new Error("Stored Runner state is invalid");
  }
  return Object.freeze({
    ...capabilities,
    spiffeId: row.spiffe_id,
    certificateFingerprint: row.certificate_fingerprint,
    certificateSerial: row.certificate_serial,
    certificateNotAfter: requiredDate(row.certificate_not_after),
    state: row.state,
    registeredAt: requiredDate(row.registered_at),
    lastSeenAt: requiredDate(row.last_seen_at),
  });
}

function parseCapabilities(value: unknown): RunnerCapabilities {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Stored Runner capabilities are invalid");
  return parsed as RunnerCapabilities;
}

function assertRegisteredBinding(
  runner: RegisteredRunner,
  identity: TlsRunnerIdentity,
  capabilities: RunnerCapabilities,
): void {
  if (runner.spiffeId !== identity.spiffeId
    || runner.certificateFingerprint !== identity.certificateFingerprint
    || runner.certificateSerial !== identity.certificateSerial
    || runner.certificateNotAfter !== identity.certificateNotAfter
    || sha256Canonical(capabilityView(runner)) !== sha256Canonical(capabilityView(capabilities))) {
    throw new Error("Runner identity or immutable capabilities conflict with its registration");
  }
}

function capabilityView(value: RunnerCapabilities): RunnerCapabilities {
  return {
    runnerId: value.runnerId,
    platform: value.platform,
    architecture: value.architecture,
    osVersion: value.osVersion,
    runnerImageDigest: value.runnerImageDigest,
    godotVersion: value.godotVersion,
    godotBinaryDigest: value.godotBinaryDigest,
    exportTemplatesDigest: value.exportTemplatesDigest,
    gpu: value.gpu,
    display: value.display,
    audio: value.audio,
    installedAutonomousAgents: value.installedAutonomousAgents,
    steamClientConnector: value.steamClientConnector,
    capabilityDigest: value.capabilityDigest,
  };
}

function validateCandidateLock(candidate: CandidateRow, tenantId: string): Readonly<RunnerExecutionLock> {
  let lock: Readonly<RunnerExecutionLock>;
  try { lock = parseRunnerExecutionLock(candidate.lock_payload); }
  catch { throw new Error("Runner execution lock is malformed"); }
  const digest = runnerExecutionLockDigest(lock);
  if (!UUID.test(candidate.attempt_id) || !UUID.test(candidate.project_id) || !UUID.test(candidate.run_id)
    || !UUID.test(candidate.iteration_id) || !UUID.test(candidate.execution_lock_id)
    || !SHA256.test(candidate.lock_payload_digest) || digest !== candidate.lock_payload_digest
    || lock.tenantId !== tenantId || lock.projectId !== candidate.project_id || lock.runId !== candidate.run_id
    || lock.mode !== candidate.mode || lock.steamBuildId !== candidate.steam_build_id
    || lock.commitSha !== candidate.commit_sha || lock.sourceDigest !== candidate.source_digest
    || JSON.stringify(lock.targetMatrix) !== JSON.stringify(candidate.target_matrix)) {
    throw new Error("Runner execution lock does not match the queued attempt");
  }
  return lock;
}

function parseStoredJob(row: ActiveLeaseRow, publicKey: KeyObject, keyId: string): SignedRunnerJob {
  const raw = typeof row.job === "string" ? JSON.parse(row.job) as unknown : row.job;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Stored Runner job is invalid");
  const job = raw as SignedRunnerJob;
  if (job.payload?.schemaVersion !== "deviludo.runner-job.v2"
    || job.signature?.algorithm !== "Ed25519"
    || job.signature.keyId !== keyId
    || !SHA256.test(row.job_digest)
    || sha256Canonical(job.payload) !== row.job_digest
    || job.signature.value !== row.job_signature
    || sha256Canonical(job.payload.requiredEvidence) !== sha256Canonical(REQUIRED_RUNNER_EVIDENCE)
    || !verifyCanonical(publicKey, job.payload, job.signature.value)) {
    throw new Error("Stored Runner job signature is invalid");
  }
  return Object.freeze(job);
}

function requiredDate(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Stored Runner timestamp is invalid");
  return new Date(value).toISOString();
}

export function runnerPlatform(value: string): TargetPlatform {
  if (value !== "windows" && value !== "linux" && value !== "macos") throw new Error("Runner platform is invalid");
  return value;
}
