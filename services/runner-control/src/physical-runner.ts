import type { KeyObject } from "node:crypto";
import type { RunnerEvent } from "../../../lib/domain/e2e";
import type { TargetPlatform } from "../../../lib/domain/types";
import { sha256Canonical } from "./canonical";
import type {
  PlatformEvidenceManifest,
  RegisteredRunner,
  RunnerCapabilities,
  RunnerEventReceipt,
  RunnerJobPayload,
  SignedRunnerJob,
} from "./contracts";
import {
  createPlatformEvidenceManifest,
  validateRunnerCapabilities,
  verifyRunnerJob,
} from "./coordinator";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const TARGETS = new Set<TargetPlatform>(["windows", "linux", "macos"]);

export interface PhysicalRunnerIngress {
  register(capabilities: RunnerCapabilities): Promise<RegisteredRunner>;
  leaseNext(runnerId: string, tenantId: string): Promise<SignedRunnerJob | null>;
  submitEvidence(tenantId: string, manifest: PlatformEvidenceManifest): Promise<PlatformEvidenceManifest>;
  acceptEvent(tenantId: string, event: RunnerEvent): Promise<RunnerEventReceipt>;
}

export interface PhysicalRunnerExecutionOutput {
  readonly exportDigest: string;
  readonly logsDigest: string;
  readonly junitDigest: string;
  readonly inputTimelineDigest: string;
  readonly screenshotManifestDigest: string;
  readonly videoManifestDigest: string;
  readonly status: "PASSED" | "FAILED";
  readonly createdAt: string;
}

export interface PhysicalRunnerExecutor {
  /** Must be idempotent for the signed attempt/fencing token. */
  execute(job: RunnerJobPayload): Promise<PhysicalRunnerExecutionOutput>;
}

export interface PhysicalRunnerJournalRecord {
  readonly schemaVersion: "deviludo.physical-runner-journal.v1";
  readonly attemptId: string;
  readonly fencingToken: number;
  readonly jobDigest: string;
  readonly startedEvent: RunnerEvent;
  readonly evidenceManifest: PlatformEvidenceManifest | null;
  readonly completionEvent: RunnerEvent | null;
  readonly completed: boolean;
}

export interface PhysicalRunnerJournal {
  load(attemptId: string, fencingToken: number): Promise<PhysicalRunnerJournalRecord | null>;
  save(record: PhysicalRunnerJournalRecord): Promise<void>;
}

export type PhysicalRunnerCycleResult = Readonly<
  | { status: "DRAINING" | "IDLE" }
  | {
      status: "COMPLETED";
      tenantId: string;
      attemptId: string;
      platform: TargetPlatform;
      result: "PASSED" | "FAILED";
      attemptState: RunnerEventReceipt["attemptState"];
    }
>;

/** Portable state machine executed identically by each physical OS Runner. */
export class PhysicalRunnerAgent {
  readonly #capabilities: RunnerCapabilities;
  readonly #tenantIds: readonly string[];
  readonly #jobKeyId: string;
  readonly #jobPublicKey: KeyObject;
  readonly #ingress: PhysicalRunnerIngress;
  readonly #executor: PhysicalRunnerExecutor;
  readonly #journal: PhysicalRunnerJournal;
  readonly #now: () => Date;

  constructor(options: {
    readonly capabilities: RunnerCapabilities;
    readonly tenantIds: readonly string[];
    readonly jobKeyId: string;
    readonly jobPublicKey: KeyObject;
    readonly ingress: PhysicalRunnerIngress;
    readonly executor: PhysicalRunnerExecutor;
    readonly journal: PhysicalRunnerJournal;
    readonly now?: () => Date;
  }) {
    validateRunnerCapabilities(options.capabilities);
    this.#capabilities = Object.freeze({ ...options.capabilities });
    this.#tenantIds = validateTenantIds(options.tenantIds);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(options.jobKeyId)
      || options.jobPublicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Physical Runner job verification key is invalid");
    }
    this.#jobKeyId = options.jobKeyId;
    this.#jobPublicKey = options.jobPublicKey;
    this.#ingress = options.ingress;
    this.#executor = options.executor;
    this.#journal = options.journal;
    this.#now = options.now ?? (() => new Date());
  }

  async runOnce(): Promise<PhysicalRunnerCycleResult> {
    const registered = await this.#ingress.register(this.#capabilities);
    assertRegistration(registered, this.#capabilities);
    if (registered.state !== "ONLINE") return Object.freeze({ status: "DRAINING" });
    for (const tenantId of this.#tenantIds) {
      const job = await this.#ingress.leaseNext(this.#capabilities.runnerId, tenantId);
      if (!job) continue;
      return this.#process(tenantId, job);
    }
    return Object.freeze({ status: "IDLE" });
  }

  async #process(tenantId: string, job: SignedRunnerJob): Promise<PhysicalRunnerCycleResult> {
    const now = nowIso(this.#now);
    assertJob(job, this.#capabilities, tenantId, this.#jobKeyId, this.#jobPublicKey, now);
    const jobDigest = sha256Canonical(job.payload);
    let record = await this.#journal.load(job.payload.attemptId, job.payload.fencingToken);
    if (record) assertJournal(record, job, jobDigest);
    else {
      record = Object.freeze({
        schemaVersion: "deviludo.physical-runner-journal.v1",
        attemptId: job.payload.attemptId,
        fencingToken: job.payload.fencingToken,
        jobDigest,
        startedEvent: createEvent(job.payload, 1, "STARTED", "RUNNING", null, now),
        evidenceManifest: null,
        completionEvent: null,
        completed: false,
      });
      await this.#journal.save(record);
    }

    const started = await this.#ingress.acceptEvent(tenantId, record.startedEvent);
    assertEventReceipt(started, record.startedEvent, 1);

    if (!record.evidenceManifest) {
      const output = await this.#executor.execute(job.payload);
      validateExecutionOutput(output);
      const evidenceManifest = createPlatformEvidenceManifest({
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
        ...output,
      });
      record = Object.freeze({ ...record, evidenceManifest });
      await this.#journal.save(record);
    }
    const evidenceManifest = requireEvidence(record.evidenceManifest);
    const stored = await this.#ingress.submitEvidence(tenantId, evidenceManifest);
    if (sha256Canonical(stored) !== sha256Canonical(evidenceManifest)) {
      throw new Error("Physical Runner ingress changed the evidence manifest");
    }

    if (!record.completionEvent) {
      const completionEvent = createEvent(
        job.payload,
        2,
        "PLATFORM_COMPLETED",
        evidenceManifest.status,
        evidenceManifest.manifestDigest,
        nowIso(this.#now),
      );
      record = Object.freeze({ ...record, completionEvent });
      await this.#journal.save(record);
    }
    const completionEvent = requireCompletion(record.completionEvent);
    const completed = await this.#ingress.acceptEvent(tenantId, completionEvent);
    assertEventReceipt(completed, completionEvent, 2);
    if (!completed.cursor.terminal) throw new Error("Physical Runner completion was not terminal for its platform lease");
    if (!record.completed) {
      record = Object.freeze({ ...record, completed: true });
      await this.#journal.save(record);
    }
    return Object.freeze({
      status: "COMPLETED",
      tenantId,
      attemptId: job.payload.attemptId,
      platform: job.payload.platform,
      result: evidenceManifest.status,
      attemptState: completed.attemptState,
    });
  }
}

/** Deterministic journal used by the portable contract suite. */
export class MemoryPhysicalRunnerJournal implements PhysicalRunnerJournal {
  readonly #records = new Map<string, PhysicalRunnerJournalRecord>();

  async load(attemptId: string, fencingToken: number): Promise<PhysicalRunnerJournalRecord | null> {
    return this.#records.get(journalKey(attemptId, fencingToken)) ?? null;
  }

  async save(record: PhysicalRunnerJournalRecord): Promise<void> {
    validateJournalShape(record);
    const key = journalKey(record.attemptId, record.fencingToken);
    const current = this.#records.get(key);
    if (current) assertJournalAdvance(current, record);
    this.#records.set(key, record);
  }
}

function assertJob(
  job: SignedRunnerJob,
  capabilities: RunnerCapabilities,
  tenantId: string,
  keyId: string,
  publicKey: KeyObject,
  now: string,
): void {
  let verified = false;
  try {
    verified = verifyRunnerJob(job, publicKey, {
      keyId,
      runnerId: capabilities.runnerId,
      platform: capabilities.platform,
      now,
    });
  } catch { /* malformed signed envelopes fail closed below */ }
  if (!verified) throw new Error("Physical Runner job signature or lease binding is invalid");
  if (job.payload.tenantId !== tenantId || job.payload.runnerCapabilityDigest !== capabilities.capabilityDigest
    || job.payload.requiredGodotVersion !== capabilities.godotVersion
    || job.payload.exportTemplatesDigest !== capabilities.exportTemplatesDigest) {
    throw new Error("Physical Runner job does not match this machine's locked capabilities");
  }
  const matrix = job.payload.targetMatrix;
  if (matrix.length < 1 || matrix.length > 3 || !matrix.includes(capabilities.platform)
    || matrix.some((platform, index) => !TARGETS.has(platform) || (index > 0 && platform <= matrix[index - 1]!))) {
    throw new Error("Physical Runner target matrix is invalid");
  }
}

function assertRegistration(registered: RegisteredRunner, expected: RunnerCapabilities): void {
  const selected = {
    runnerId: registered.runnerId,
    platform: registered.platform,
    architecture: registered.architecture,
    osVersion: registered.osVersion,
    runnerImageDigest: registered.runnerImageDigest,
    godotVersion: registered.godotVersion,
    godotBinaryDigest: registered.godotBinaryDigest,
    exportTemplatesDigest: registered.exportTemplatesDigest,
    gpu: registered.gpu,
    display: registered.display,
    audio: registered.audio,
    installedAutonomousAgents: registered.installedAutonomousAgents,
    capabilityDigest: registered.capabilityDigest,
  };
  if (sha256Canonical(selected) !== sha256Canonical(expected)) {
    throw new Error("Physical Runner registration changed immutable capabilities");
  }
}

function createEvent(
  job: RunnerJobPayload,
  seqNo: number,
  type: "STARTED" | "PLATFORM_COMPLETED",
  status: "RUNNING" | "PASSED" | "FAILED",
  artifactDigest: string | null,
  occurredAt: string,
): RunnerEvent {
  return Object.freeze({
    attemptId: job.attemptId,
    runnerId: job.runnerId,
    fencingToken: job.fencingToken,
    seqNo,
    commitSha: job.commitSha,
    sourceDigest: job.sourceDigest,
    platform: job.platform,
    type,
    status,
    artifactDigest,
    occurredAt,
  });
}

function assertEventReceipt(receipt: RunnerEventReceipt, event: RunnerEvent, seqNo: number): void {
  if (!receipt.accepted || receipt.cursor.lastAcceptedSeqNo !== seqNo
    || sha256Canonical(receipt.event) !== sha256Canonical(event)) {
    throw new Error("Physical Runner ingress returned a drifted event receipt");
  }
}

function assertJournal(record: PhysicalRunnerJournalRecord, job: SignedRunnerJob, jobDigest: string): void {
  validateJournalShape(record);
  if (record.attemptId !== job.payload.attemptId || record.fencingToken !== job.payload.fencingToken
    || record.jobDigest !== jobDigest || !eventMatchesJob(record.startedEvent, job.payload)) {
    throw new Error("Physical Runner journal conflicts with the signed job");
  }
  if (record.evidenceManifest) {
    const evidence = record.evidenceManifest;
    const { manifestDigest, ...core } = evidence;
    if (evidence.schemaVersion !== "deviludo.platform-evidence.v1"
      || evidence.attemptId !== job.payload.attemptId || evidence.fencingToken !== job.payload.fencingToken
      || evidence.commitSha !== job.payload.commitSha || evidence.sourceDigest !== job.payload.sourceDigest
      || evidence.specRevisionId !== job.payload.specRevisionId || evidence.specDigest !== job.payload.specDigest
      || evidence.testPlanDigest !== job.payload.testPlanDigest
      || JSON.stringify(evidence.targetMatrix) !== JSON.stringify(job.payload.targetMatrix)
      || evidence.godotTestKitDigest !== job.payload.godotTestKitDigest
      || evidence.exportTemplatesDigest !== job.payload.exportTemplatesDigest
      || evidence.platform !== job.payload.platform || evidence.runnerId !== job.payload.runnerId
      || evidence.runnerCapabilityDigest !== job.payload.runnerCapabilityDigest
      || manifestDigest !== sha256Canonical(core)) {
      throw new Error("Physical Runner journal evidence conflicts with the signed job");
    }
  }
  if (record.completionEvent && (!record.evidenceManifest
    || !eventMatchesJob(record.completionEvent, job.payload)
    || record.completionEvent.status !== record.evidenceManifest.status
    || record.completionEvent.artifactDigest !== record.evidenceManifest.manifestDigest)) {
    throw new Error("Physical Runner journal completion conflicts with its evidence");
  }
}

function assertJournalAdvance(current: PhysicalRunnerJournalRecord, next: PhysicalRunnerJournalRecord): void {
  if (current.jobDigest !== next.jobDigest || sha256Canonical(current.startedEvent) !== sha256Canonical(next.startedEvent)
    || (current.evidenceManifest && sha256Canonical(current.evidenceManifest) !== sha256Canonical(next.evidenceManifest))
    || (current.completionEvent && sha256Canonical(current.completionEvent) !== sha256Canonical(next.completionEvent))
    || (current.completed && !next.completed)
    || (next.completionEvent && !next.evidenceManifest) || (next.completed && !next.completionEvent)) {
    throw new Error("Physical Runner journal update is not monotonic");
  }
}

function validateJournalShape(record: PhysicalRunnerJournalRecord): void {
  const keys = Object.keys(record).sort();
  const expected = [
    "schemaVersion", "attemptId", "fencingToken", "jobDigest", "startedEvent",
    "evidenceManifest", "completionEvent", "completed",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
    || record.schemaVersion !== "deviludo.physical-runner-journal.v1" || !UUID.test(record.attemptId)
    || !Number.isSafeInteger(record.fencingToken) || record.fencingToken < 1 || !SHA256.test(record.jobDigest)
    || record.startedEvent.type !== "STARTED" || record.startedEvent.seqNo !== 1
    || record.startedEvent.attemptId !== record.attemptId || record.startedEvent.fencingToken !== record.fencingToken
    || (record.evidenceManifest && (record.evidenceManifest.attemptId !== record.attemptId
      || record.evidenceManifest.fencingToken !== record.fencingToken))
    || (record.completionEvent && (record.completionEvent.type !== "PLATFORM_COMPLETED"
      || record.completionEvent.seqNo !== 2 || record.completionEvent.attemptId !== record.attemptId
      || record.completionEvent.fencingToken !== record.fencingToken))
    || (record.completionEvent && !record.evidenceManifest) || (record.completed && !record.completionEvent)) {
    throw new Error("Physical Runner journal record is invalid");
  }
}

function eventMatchesJob(event: RunnerEvent, job: RunnerJobPayload): boolean {
  return event.attemptId === job.attemptId && event.runnerId === job.runnerId
    && event.fencingToken === job.fencingToken && event.commitSha === job.commitSha
    && event.sourceDigest === job.sourceDigest && event.platform === job.platform;
}

function validateExecutionOutput(output: PhysicalRunnerExecutionOutput): void {
  const keys = Object.keys(output).sort();
  const expected = [
    "exportDigest", "logsDigest", "junitDigest", "inputTimelineDigest",
    "screenshotManifestDigest", "videoManifestDigest", "status", "createdAt",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
    || ![output.exportDigest, output.logsDigest, output.junitDigest, output.inputTimelineDigest,
      output.screenshotManifestDigest, output.videoManifestDigest].every((value) => SHA256.test(value))
    || (output.status !== "PASSED" && output.status !== "FAILED")
    || !Number.isFinite(Date.parse(output.createdAt))) {
    throw new Error("Physical Runner executor returned invalid evidence");
  }
}

function validateTenantIds(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 10_000) {
    throw new Error("Physical Runner tenant assignment is invalid");
  }
  let previous = "";
  const result = values.map((value) => value.toLowerCase());
  for (let index = 0; index < result.length; index += 1) {
    const tenantId = result[index]!;
    if (!UUID.test(tenantId) || values[index] !== tenantId || tenantId <= previous) {
      throw new Error("Physical Runner tenant assignment is invalid");
    }
    previous = tenantId;
  }
  return Object.freeze(result);
}

function nowIso(now: () => Date): string {
  const value = now().toISOString();
  if (!Number.isFinite(Date.parse(value))) throw new Error("Physical Runner clock is invalid");
  return value;
}

function requireEvidence(value: PlatformEvidenceManifest | null): PlatformEvidenceManifest {
  if (!value) throw new Error("Physical Runner journal is missing evidence");
  return value;
}

function requireCompletion(value: RunnerEvent | null): RunnerEvent {
  if (!value) throw new Error("Physical Runner journal is missing completion");
  return value;
}

function journalKey(attemptId: string, fencingToken: number): string {
  return `${attemptId}:${fencingToken}`;
}
