import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { RunnerEvent } from "../../../lib/domain/e2e";
import type { PlatformEvidenceManifest, RunnerCapabilities, SignedRunnerJob, TlsRunnerIdentity } from "../src/contracts";
import { sha256Canonical } from "../src/canonical";
import { createPlatformEvidenceManifest, createRunnerCapabilityDigest, verifyRunnerJob } from "../src/coordinator";
import { runnerExecutionLockDigest, type RunnerExecutionLock } from "../src/execution-lock";
import { PostgresRunnerIngressStore } from "../src/postgres-ingress";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const iterationId = "55555555-5555-4555-8555-555555555555";
const executionLockId = "66666666-6666-4666-8666-666666666666";
const specRevisionId = "77777777-7777-4777-8777-777777777777";
const at = "2030-01-01T00:00:00.000Z";
const sha = (value: string) => value.repeat(64);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function identity(): TlsRunnerIdentity {
  return {
    spiffeId: "spiffe://deviludo.test/e2e-runner/runner-linux-1",
    certificateFingerprint: sha("a"),
    certificateSerial: "serial-linux-1",
    certificateNotAfter: "2031-01-01T00:00:00.000Z",
  };
}

function capabilities(overrides: Partial<RunnerCapabilities> = {}): RunnerCapabilities {
  const core = {
    runnerId: "runner-linux-1",
    platform: "linux" as const,
    architecture: "x86_64" as const,
    osVersion: "ubuntu-24.04",
    runnerImageDigest: sha("1"),
    godotVersion: "4.6.2-stable",
    godotBinaryDigest: sha("2"),
    exportTemplatesDigest: sha("3"),
    gpu: "virtual-vulkan",
    display: "virtual" as const,
    audio: "virtual" as const,
    installedAutonomousAgents: [] as readonly string[],
    ...overrides,
  };
  return { ...core, capabilityDigest: createRunnerCapabilityDigest(core) };
}

function executionLock(): RunnerExecutionLock {
  return {
    schemaVersion: "deviludo.runner-execution-lock.v1",
    tenantId,
    projectId,
    runId,
    mode: "CANDIDATE",
    commitSha: "b".repeat(40),
    sourceDigest: sha("4"),
    steamBuildId: null,
    specRevisionId,
    specDigest: sha("5"),
    testPlanDigest: sha("6"),
    runnerToolchainRevisionId: "99999999-9999-4999-8999-999999999999",
    runnerToolchainDigest: sha("f"),
    targetMatrix: ["linux"],
    requiredGodotVersion: "4.6.2-stable",
    godotTestKitDigest: sha("7"),
    exportTemplates: { linux: sha("3") },
    buildManifestDigest: sha("8"),
    sbomDigest: sha("9"),
    vulnerabilityScanDigest: sha("c"),
    assetLicenseLedgerDigest: sha("d"),
    execution: {
      kind: "SOURCE_ARTIFACT",
      objectKey: `tenants/${tenantId}/projects/${projectId}/source/game.tar.zst`,
      artifactDigest: sha("e"),
    },
    preparedAt: at,
  };
}

function steamExecutionLock(): RunnerExecutionLock {
  return {
    ...executionLock(),
    mode: "STEAM_CLEAN_INSTALL",
    steamBuildId: "123456789",
    execution: {
      kind: "STEAM_CLEAN_INSTALL",
      steamAppId: "480",
      buildId: "123456789",
      betaBranch: "deviludo_beta",
      installGrantId: "install-grant:123456789:linux",
    },
  };
}

class IngressClient implements PostgresWorkflowClient {
  readonly sql: string[] = [];
  releases = 0;
  runner = capabilities();
  registered = false;
  tamperedLock = false;
  steam = false;
  storedJob: unknown = null;
  storedJobDigest = "";
  storedJobSignature = "";
  leaseInserts = 0;
  leaseId = "88888888-8888-4888-8888-888888888888";
  leaseState = "LEASED";
  leaseCursor = { lastAcceptedSeqNo: 0, completedPlatforms: {}, terminal: false };
  evidenceManifest: PlatformEvidenceManifest | null = null;
  events = new Map<number, Record<string, unknown>>();
  attemptState = "RUNNING";
  evidenceBundle: unknown = null;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.sql.push(text);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config('app.tenant_id'")) return result([]);
    if (text.includes("WHERE id = $1 OR spiffe_id")) {
      return result((this.registered ? [runnerRow(this.runner)] : []) as unknown as Row[]);
    }
    if (text.includes("INSERT INTO deviludo.runner_registrations")) {
      this.registered = true;
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("UPDATE deviludo.runner_registrations")) return { rowCount: 1, rows: [] };
    if (text.includes("FROM deviludo.runner_registrations") && text.includes("WHERE id = $1")) {
      return result((this.registered ? [runnerRow(this.runner)] : []) as unknown as Row[]);
    }
    if (text.includes("SELECT state, project_id::text") && text.includes("FROM deviludo.e2e_attempts")) {
      return result([{ state: this.attemptState, project_id: projectId }] as unknown as Row[]);
    }
    if (text.includes("FROM deviludo.e2e_platform_leases lease") && text.includes("AND lease.runner_id = $2")) {
      if (!this.storedJob) return result([]);
      const parsed = this.storedJob as { payload: { leaseExpiresAt: string } };
      return result([{
        job: this.storedJob,
        job_digest: this.storedJobDigest,
        job_signature: this.storedJobSignature,
        runner_id: this.runner.runnerId,
        platform: this.runner.platform,
        lease_expires_at: parsed.payload.leaseExpiresAt,
      }] as unknown as Row[]);
    }
    if (text.includes("FROM deviludo.e2e_attempts attempt")) {
      const lock = this.steam ? steamExecutionLock() : executionLock();
      const payload = this.tamperedLock ? { ...lock, commitSha: "f".repeat(40) } : lock;
      return result([{
        attempt_id: attemptId,
        project_id: projectId,
        run_id: runId,
        iteration_id: iterationId,
        execution_lock_id: executionLockId,
        commit_sha: lock.commitSha,
        source_digest: lock.sourceDigest,
        target_matrix: ["linux"],
        mode: lock.mode,
        steam_build_id: lock.steamBuildId,
        lock_payload: payload,
        lock_payload_digest: runnerExecutionLockDigest(lock),
      }] as unknown as Row[]);
    }
    if (text.includes("COALESCE(MAX(fencing_token)")) return result([{ next_token: "1" }] as unknown as Row[]);
    if (text.includes("INSERT INTO deviludo.e2e_platform_leases")) {
      this.leaseInserts += 1;
      this.storedJobDigest = String(values[8]);
      this.storedJobSignature = String(values[9]);
      this.storedJob = JSON.parse(String(values[10]));
      assert.equal(this.storedJobDigest, sha256Canonical((this.storedJob as { payload: unknown }).payload));
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("FROM deviludo.e2e_platform_leases") && text.includes("AND fencing_token = $4::bigint")) {
      if (!this.storedJob || Number(values[3]) !== 1) return result([]);
      return result([leaseRow(this)] as unknown as Row[]);
    }
    if (text.includes("SET evidence_manifest = $6::jsonb")) {
      this.evidenceManifest = JSON.parse(String(values[5])) as PlatformEvidenceManifest;
      return { rowCount: 1, rows: [{ id: this.leaseId }] as unknown as Row[] };
    }
    if (text.includes("FROM deviludo.platform_runner_events")) {
      const event = this.events.get(Number(values[2]));
      return result((event ? [event] : []) as unknown as Row[]);
    }
    if (text.includes("INSERT INTO deviludo.platform_runner_events")) {
      this.events.set(Number(values[6]), {
        runner_id: values[3], platform: values[4], fencing_token: values[5], seq_no: values[6],
        commit_sha: values[7], source_digest: values[8], event_type: values[9], status: values[10],
        artifact_digest: values[11], occurred_at: values[12],
      });
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("SET last_seq_no = $6::bigint")) {
      this.leaseCursor = JSON.parse(String(values[6])) as typeof this.leaseCursor;
      this.leaseState = String(values[7]);
      return { rowCount: 1, rows: [{ id: this.leaseId }] as unknown as Row[] };
    }
    if (text.includes("JOIN (") && text.includes("MAX(fencing_token)")) {
      return result([leaseRow(this)] as unknown as Row[]);
    }
    if (text.includes("INSERT INTO deviludo.evidence_bundles")) {
      this.evidenceBundle = JSON.parse(String(values[7]));
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("UPDATE deviludo.e2e_attempts") && text.includes("repair_prompt_id")) {
      this.attemptState = String(values[2]);
      return { rowCount: 1, rows: [{ id: attemptId }] as unknown as Row[] };
    }
    if (text.includes("UPDATE deviludo.e2e_attempts")) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected SQL: ${text}`);
  }

  release(): void { this.releases += 1; }
}

function leaseRow(client: IngressClient) {
  const job = client.storedJob as SignedRunnerJob;
  return {
    id: client.leaseId,
    project_id: projectId,
    attempt_id: attemptId,
    runner_id: capabilities().runnerId,
    platform: "linux",
    fencing_token: "1",
    lease_expires_at: job.payload.leaseExpiresAt,
    last_seq_no: client.leaseCursor.lastAcceptedSeqNo,
    cursor: client.leaseCursor,
    job: client.storedJob,
    job_digest: client.storedJobDigest,
    job_signature: client.storedJobSignature,
    evidence_manifest: client.evidenceManifest,
    evidence_manifest_digest: client.evidenceManifest?.manifestDigest ?? null,
    state: client.leaseState,
  };
}

function runnerRow(runner: RunnerCapabilities) {
  return {
    id: runner.runnerId,
    spiffe_id: identity().spiffeId,
    certificate_fingerprint: identity().certificateFingerprint,
    certificate_serial: identity().certificateSerial,
    certificate_not_after: identity().certificateNotAfter,
    platform: runner.platform,
    architecture: runner.architecture,
    capability_digest: runner.capabilityDigest,
    capabilities: runner,
    state: "ONLINE",
    registered_at: at,
    last_seen_at: at,
  };
}

function result<Row extends Record<string, unknown>>(rows: readonly Row[]): PostgresQueryResult<Row> {
  return { rowCount: rows.length, rows };
}

function pool(client: IngressClient): PostgresWorkflowPool {
  return { async connect() { return client; } };
}

function store(client: IngressClient, assigned = true) {
  return new PostgresRunnerIngressStore({
    pool: pool(client),
    signer: { keyId: "runner-jobs-2030-q1", privateKey },
    admission: { async authorize() { return true; } },
    assignments: { async authorize() { return assigned; } },
    evidenceArchive: {
      async persistBundle({ tenantId: assignedTenant, projectId: assignedProject, bundle }) {
        return {
          objectKey: `tenants/${assignedTenant}/projects/${assignedProject}/evidence/${bundle.bundleDigest}.json`,
          repairPromptId: bundle.status === "FAILED" ? `repair-prompt:${bundle.bundleDigest.slice(0, 32)}` : null,
        };
      },
    },
    leaseDurationSeconds: 300,
  });
}

test("PostgreSQL Runner ingress registers once and leases a complete signed immutable job", async () => {
  const client = new IngressClient();
  const ingress = store(client);
  const registered = await ingress.register(identity(), capabilities(), at);
  assert.equal(registered.state, "ONLINE");
  const job = await ingress.leaseNext(identity(), capabilities().runnerId, tenantId, at);
  assert.ok(job);
  assert.equal(job.payload.schemaVersion, "deviludo.runner-job.v2");
  assert.equal(job.payload.executionLockId, executionLockId);
  assert.equal(job.payload.execution.kind, "SOURCE_ARTIFACT");
  assert.equal(job.payload.buildManifestDigest, executionLock().buildManifestDigest);
  assert.equal(verifyRunnerJob(job, publicKey, {
    keyId: "runner-jobs-2030-q1", runnerId: capabilities().runnerId, platform: "linux", now: at,
  }), true);
  assert.ok(client.sql.some((sql) => sql.includes("set_config('app.tenant_id'")));
  assert.ok(client.sql.some((sql) => sql.includes("FOR UPDATE OF attempt SKIP LOCKED")));
  assert.equal(client.leaseInserts, 1);
});

test("PostgreSQL Runner ingress replays the exact active signed job without a second lease", async () => {
  const client = new IngressClient();
  client.registered = true;
  const ingress = store(client);
  const first = await ingress.leaseNext(identity(), capabilities().runnerId, tenantId, at);
  const second = await ingress.leaseNext(identity(), capabilities().runnerId, tenantId, at);
  assert.deepEqual(second, first);
  assert.equal(client.leaseInserts, 1);
});

test("PostgreSQL Runner ingress signs a BuildID-bound Steam clean-install job without session material", async () => {
  const client = new IngressClient();
  client.registered = true;
  client.steam = true;
  const job = await store(client).leaseNext(identity(), capabilities().runnerId, tenantId, at);
  assert.ok(job);
  assert.deepEqual(job.payload.execution, steamExecutionLock().execution);
  assert.equal(JSON.stringify(job).includes("config.vdf"), false);
  assert.equal(JSON.stringify(job).toLowerCase().includes("password"), false);
  assert.equal(verifyRunnerJob(job, publicKey, {
    keyId: "runner-jobs-2030-q1", runnerId: capabilities().runnerId, platform: "linux", now: at,
  }), true);
});

function started(job: SignedRunnerJob): RunnerEvent {
  return {
    attemptId: job.payload.attemptId,
    runnerId: job.payload.runnerId,
    fencingToken: job.payload.fencingToken,
    seqNo: 1,
    commitSha: job.payload.commitSha,
    sourceDigest: job.payload.sourceDigest,
    platform: job.payload.platform,
    type: "STARTED",
    status: "RUNNING",
    artifactDigest: null,
    occurredAt: "2030-01-01T00:00:01.000Z",
  };
}

function evidence(job: SignedRunnerJob): PlatformEvidenceManifest {
  return createPlatformEvidenceManifest({
    schemaVersion: "deviludo.platform-evidence.v1",
    attemptId: job.payload.attemptId,
    fencingToken: job.payload.fencingToken,
    commitSha: job.payload.commitSha,
    sourceDigest: job.payload.sourceDigest,
    specRevisionId: job.payload.specRevisionId,
    specDigest: job.payload.specDigest,
    testPlanDigest: job.payload.testPlanDigest,
    targetMatrix: job.payload.targetMatrix,
    godotTestKitDigest: job.payload.godotTestKitDigest,
    exportTemplatesDigest: job.payload.exportTemplatesDigest,
    platform: job.payload.platform,
    runnerId: job.payload.runnerId,
    runnerCapabilityDigest: job.payload.runnerCapabilityDigest,
    exportDigest: sha("1"),
    logsDigest: sha("2"),
    junitDigest: sha("3"),
    inputTimelineDigest: sha("4"),
    screenshotManifestDigest: sha("5"),
    videoManifestDigest: sha("6"),
    status: "PASSED",
    createdAt: "2030-01-01T00:00:02.000Z",
  });
}

test("PostgreSQL Runner ingress persists ordered events and completes only from stored platform evidence", async () => {
  const client = new IngressClient();
  client.registered = true;
  const ingress = store(client);
  const job = await ingress.leaseNext(identity(), capabilities().runnerId, tenantId, at) as SignedRunnerJob;
  const startReceipt = await ingress.acceptEvent(identity(), tenantId, started(job), "2030-01-01T00:00:01.500Z");
  assert.equal(startReceipt.attemptState, "RUNNING");
  const manifest = evidence(job);
  const stored = await ingress.submitEvidence(identity(), tenantId, manifest, "2030-01-01T00:00:02.500Z");
  assert.equal(stored.manifestDigest, manifest.manifestDigest);
  const completion: RunnerEvent = {
    ...started(job),
    seqNo: 2,
    type: "PLATFORM_COMPLETED",
    status: "PASSED",
    artifactDigest: manifest.manifestDigest,
    occurredAt: "2030-01-01T00:00:03.000Z",
  };
  const completed = await ingress.acceptEvent(identity(), tenantId, completion, "2030-01-01T00:00:03.500Z");
  assert.equal(completed.attemptState, "PASSED");
  assert.equal(completed.evidenceBundle?.bundleDigest, (client.evidenceBundle as { bundleDigest: string }).bundleDigest);
  assert.equal(client.attemptState, "PASSED");
  assert.equal(client.events.size, 2);
  const replay = await ingress.acceptEvent(identity(), tenantId, completion, "2030-01-01T00:00:04.000Z");
  assert.equal(replay.accepted, true);
  assert.equal(replay.attemptState, "PASSED");
  assert.equal(client.events.size, 2);
});

test("PostgreSQL Runner ingress rejects sequence gaps, stale fencing and completion without evidence", async () => {
  const gapClient = new IngressClient();
  gapClient.registered = true;
  const gapIngress = store(gapClient);
  const gapJob = await gapIngress.leaseNext(identity(), capabilities().runnerId, tenantId, at) as SignedRunnerJob;
  await assert.rejects(gapIngress.acceptEvent(identity(), tenantId, { ...started(gapJob), seqNo: 2 }, "2030-01-01T00:00:01.500Z"), /first platform event|sequence/i);
  await assert.rejects(gapIngress.acceptEvent(identity(), tenantId, { ...started(gapJob), fencingToken: 2 }, "2030-01-01T00:00:01.500Z"), /not visible/);

  const emptyClient = new IngressClient();
  emptyClient.registered = true;
  const emptyIngress = store(emptyClient);
  const emptyJob = await emptyIngress.leaseNext(identity(), capabilities().runnerId, tenantId, at) as SignedRunnerJob;
  await emptyIngress.acceptEvent(identity(), tenantId, started(emptyJob), "2030-01-01T00:00:01.500Z");
  await assert.rejects(emptyIngress.acceptEvent(identity(), tenantId, {
    ...started(emptyJob), seqNo: 2, type: "PLATFORM_COMPLETED", status: "PASSED",
    artifactDigest: sha("f"), occurredAt: "2030-01-01T00:00:02.000Z",
  }, "2030-01-01T00:00:02.500Z"), /persisted evidence/);
});

test("PostgreSQL Runner ingress rejects tenant assignment, capability drift and lock tampering", async () => {
  const unassignedClient = new IngressClient();
  unassignedClient.registered = true;
  await assert.rejects(store(unassignedClient, false).leaseNext(identity(), capabilities().runnerId, tenantId, at), /not assigned/);
  assert.equal(unassignedClient.sql.some((sql) => sql.includes("FROM deviludo.e2e_attempts attempt")), false);

  const driftClient = new IngressClient();
  driftClient.registered = true;
  await assert.rejects(store(driftClient).register(identity(), capabilities({ gpu: "different-gpu" }), at), /conflict/);

  const tamperedClient = new IngressClient();
  tamperedClient.registered = true;
  tamperedClient.tamperedLock = true;
  await assert.rejects(store(tamperedClient).leaseNext(identity(), capabilities().runnerId, tenantId, at), /does not match/);
  assert.equal(tamperedClient.leaseInserts, 0);
  assert.ok(tamperedClient.sql.includes("ROLLBACK"));
});
