import { createPublicKey, type KeyObject } from "node:crypto";
import type { TargetPlatform } from "../../../lib/domain/types";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { sha256Canonical, signCanonical, verifyCanonical } from "./canonical";
import type {
  RegisteredRunner,
  RunnerAdmissionPolicy,
  RunnerCapabilities,
  RunnerJobPayload,
  RunnerJobSignerOptions,
  SignedRunnerJob,
  TlsRunnerIdentity,
} from "./contracts";
import {
  REQUIRED_RUNNER_EVIDENCE,
  validateRunnerCapabilities,
  validateRunnerIdentity,
} from "./coordinator";
import { parseRunnerExecutionLock, runnerExecutionLockDigest, type RunnerExecutionLock } from "./execution-lock";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export interface RunnerTenantAssignmentPolicy {
  authorize(input: {
    readonly identity: TlsRunnerIdentity;
    readonly runner: RegisteredRunner;
    readonly tenantId: string;
  }): Promise<boolean>;
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

  constructor(options: {
    readonly pool: PostgresWorkflowPool;
    readonly admission: RunnerAdmissionPolicy;
    readonly assignments: RunnerTenantAssignmentPolicy;
    readonly signer: RunnerJobSignerOptions;
    readonly leaseDurationSeconds?: number;
  }) {
    this.#pool = options.pool;
    this.#admission = options.admission;
    this.#assignments = options.assignments;
    this.#signer = options.signer;
    this.#publicKey = createPublicKey(options.signer.privateKey);
    if (this.#publicKey.asymmetricKeyType !== "ed25519" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(options.signer.keyId)) {
      throw new Error("Runner job signer configuration is invalid");
    }
    this.#leaseDurationSeconds = options.leaseDurationSeconds ?? 300;
    if (!Number.isInteger(this.#leaseDurationSeconds)
      || this.#leaseDurationSeconds < 30 || this.#leaseDurationSeconds > 3_600) {
      throw new Error("Runner lease duration must be between 30 and 3600 seconds");
    }
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
                  state = CASE WHEN state IN ('DRAINING', 'QUARANTINED') THEN state ELSE 'ONLINE' END
            WHERE id = $1`,
          [capabilities.runnerId, at],
        );
        return Object.freeze({ ...runner, state: runner.state === "DRAINING" || runner.state === "QUARANTINED" ? runner.state : "ONLINE", lastSeenAt: at });
      }
      await client.query(
        `INSERT INTO deviludo.runner_registrations
          (id, spiffe_id, certificate_fingerprint, certificate_serial,
           certificate_not_after, platform, architecture, capability_digest,
           capabilities, state, registered_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8,
                 $9::jsonb, 'ONLINE', $10::timestamptz, $10::timestamptz)`,
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
          at,
        ],
      );
      return Object.freeze({
        ...capabilities,
        ...identity,
        state: "ONLINE",
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
        [tenantId, runner.platform, at],
      );
      const candidate = candidateResult.rows[0];
      if (!candidate) return null;
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
): Promise<RegisteredRunner> {
  const selected = await client.query<RunnerRow>(
    `SELECT id, spiffe_id, certificate_fingerprint, certificate_serial,
            certificate_not_after::text, platform, architecture,
            capability_digest, capabilities, state,
            registered_at::text, last_seen_at::text
       FROM deviludo.runner_registrations
      WHERE id = $1
      FOR SHARE`,
    [runnerId],
  );
  if (selected.rows.length !== 1) throw new Error("Runner is not registered");
  const runner = parseRegisteredRunner(selected.rows[0] as RunnerRow);
  if (runner.spiffeId !== identity.spiffeId
    || runner.certificateFingerprint !== identity.certificateFingerprint
    || runner.certificateSerial !== identity.certificateSerial
    || runner.certificateNotAfter !== identity.certificateNotAfter) {
    throw new Error("Runner workload identity does not match its registration");
  }
  return runner;
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
