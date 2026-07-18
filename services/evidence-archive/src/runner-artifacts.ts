import { createHash, type KeyObject } from "node:crypto";
import type { EvidenceBundle, PlatformEvidence } from "../../../lib/domain/e2e";
import type { TargetPlatform } from "../../../lib/domain/types";
import { canonicalJson, sha256Canonical } from "../../runner-control/src/canonical";
import type { SignedRunnerJob } from "../../runner-control/src/contracts";
import type { SignedRunnerFleetPolicy } from "../../runner-control/src/fleet-manifest";
import { verifyRunnerJob } from "../../runner-control/src/coordinator";
import type { EvidenceArchiveWorkloadIdentity } from "./contracts";
import type { ImmutableObjectStore } from "./contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_GRANT_SECONDS = 300;

export type RunnerArtifactKind =
  | "logs"
  | "junit"
  | "input-timeline"
  | "screenshot-manifest"
  | "video-manifest"
  | "production-export";

export type RunnerArtifactGrantOperation =
  | Readonly<{ kind: "DOWNLOAD_INPUT" }>
  | Readonly<{ kind: "DOWNLOAD_TEST_PLAN" }>
  | Readonly<{
      kind: "UPLOAD_EVIDENCE";
      artifactKind: RunnerArtifactKind;
      artifactDigest: string;
      sizeBytes: number;
    }>;

export interface RunnerArtifactGrantRequest {
  readonly schemaVersion: "deviludo.runner-artifact-grant-request.v1";
  readonly job: SignedRunnerJob;
  readonly operation: RunnerArtifactGrantOperation;
}

export interface RunnerArtifactCommitRequest {
  readonly schemaVersion: "deviludo.runner-artifact-commit-request.v1";
  readonly job: SignedRunnerJob;
  readonly artifactKind: RunnerArtifactKind;
  readonly artifactDigest: string;
  readonly sizeBytes: number;
}

export interface RunnerArtifactTransferGrant {
  readonly url: string;
  readonly method: "GET" | "PUT";
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

export interface RunnerArtifactTransfer {
  createDownloadGrant(input: {
    readonly objectKey: string;
    readonly artifactDigest: string;
    readonly expiresAt: string;
  }): Promise<RunnerArtifactTransferGrant>;
  createUploadGrant(input: {
    readonly objectKey: string;
    readonly artifactDigest: string;
    readonly sizeBytes: number;
    readonly contentType: string;
    readonly expiresAt: string;
  }): Promise<RunnerArtifactTransferGrant>;
  verifyObject(input: {
    readonly objectKey: string;
    readonly artifactDigest: string;
    readonly sizeBytes?: number;
  }): Promise<Readonly<{ sizeBytes: number }>>;
  probe(): Promise<void>;
}

export class RunnerArtifactGrantService {
  readonly #jobKeyId: string;
  readonly #jobPublicKey: KeyObject;
  readonly #fleet: Pick<SignedRunnerFleetPolicy, "authorizeJob" | "probe">;
  readonly #transfer: RunnerArtifactTransfer;
  readonly #reservations: ImmutableObjectStore;
  readonly #now: () => Date;

  constructor(options: {
    readonly jobKeyId: string;
    readonly jobPublicKey: KeyObject;
    readonly fleet: Pick<SignedRunnerFleetPolicy, "authorizeJob" | "probe">;
    readonly transfer: RunnerArtifactTransfer;
    readonly reservations: ImmutableObjectStore;
    readonly now?: () => Date;
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(options.jobKeyId)
      || options.jobPublicKey.asymmetricKeyType !== "ed25519") invalid("job verification key");
    this.#jobKeyId = options.jobKeyId;
    this.#jobPublicKey = options.jobPublicKey;
    this.#fleet = options.fleet;
    this.#transfer = options.transfer;
    this.#reservations = options.reservations;
    this.#now = options.now ?? (() => new Date());
  }

  async grant(identity: EvidenceArchiveWorkloadIdentity, value: unknown): Promise<Readonly<Record<string, unknown>>> {
    const request = parseGrantRequest(value);
    const { job, now, expiresAt } = await this.#authorize(identity, request.job);
    const jobDigest = sha256Canonical(job.payload);
    if (request.operation.kind === "DOWNLOAD_INPUT") {
      if (job.payload.execution.kind !== "SOURCE_ARTIFACT") invalid("download execution mode");
      const transfer = await this.#transfer.createDownloadGrant({
        objectKey: job.payload.execution.objectKey,
        artifactDigest: job.payload.execution.artifactDigest,
        expiresAt,
      });
      validateTransferGrant(transfer, "GET", expiresAt, now);
      return deepFreeze({
        schemaVersion: "deviludo.runner-artifact-grant.v1",
        jobDigest,
        operation: "DOWNLOAD_INPUT",
        artifactKind: "source-artifact",
        artifactDigest: job.payload.execution.artifactDigest,
        objectKey: job.payload.execution.objectKey,
        sizeBytes: null,
        method: transfer.method,
        url: transfer.url,
        requiredHeaders: transfer.requiredHeaders,
        expiresAt: transfer.expiresAt,
        commitRequired: false,
      });
    }
    if (request.operation.kind === "DOWNLOAD_TEST_PLAN") {
      const objectKey = runnerTestPlanObjectKey(job.payload.tenantId, job.payload.projectId, job.payload.testPlanDigest);
      const transfer = await this.#transfer.createDownloadGrant({
        objectKey,
        artifactDigest: job.payload.testPlanDigest,
        expiresAt,
      });
      validateTransferGrant(transfer, "GET", expiresAt, now);
      return deepFreeze({
        schemaVersion: "deviludo.runner-artifact-grant.v1",
        jobDigest,
        operation: "DOWNLOAD_TEST_PLAN",
        artifactKind: "test-plan",
        artifactDigest: job.payload.testPlanDigest,
        objectKey,
        sizeBytes: null,
        method: transfer.method,
        url: transfer.url,
        requiredHeaders: transfer.requiredHeaders,
        expiresAt: transfer.expiresAt,
        commitRequired: false,
      });
    }
    const artifact = artifactBinding(job, request.operation);
    await this.#reserve(job, request.operation);
    const transfer = await this.#transfer.createUploadGrant({ ...artifact, expiresAt });
    validateTransferGrant(transfer, "PUT", expiresAt, now);
    return deepFreeze({
      schemaVersion: "deviludo.runner-artifact-grant.v1",
      jobDigest,
      operation: "UPLOAD_EVIDENCE",
      artifactKind: request.operation.artifactKind,
      artifactDigest: request.operation.artifactDigest,
      objectKey: artifact.objectKey,
      sizeBytes: request.operation.sizeBytes,
      method: transfer.method,
      url: transfer.url,
      requiredHeaders: transfer.requiredHeaders,
      expiresAt: transfer.expiresAt,
      commitRequired: true,
    });
  }

  async commit(identity: EvidenceArchiveWorkloadIdentity, value: unknown): Promise<Readonly<Record<string, unknown>>> {
    const request = parseCommitRequest(value);
    const { job } = await this.#authorize(identity, request.job);
    const artifact = artifactBinding(job, {
      kind: "UPLOAD_EVIDENCE",
      artifactKind: request.artifactKind,
      artifactDigest: request.artifactDigest,
      sizeBytes: request.sizeBytes,
    });
    await this.#reserve(job, {
      kind: "UPLOAD_EVIDENCE",
      artifactKind: request.artifactKind,
      artifactDigest: request.artifactDigest,
      sizeBytes: request.sizeBytes,
    });
    const verified = await this.#transfer.verifyObject({
      objectKey: artifact.objectKey,
      artifactDigest: request.artifactDigest,
      sizeBytes: request.sizeBytes,
    });
    if (verified.sizeBytes !== request.sizeBytes) invalid("committed artifact size");
    return deepFreeze({
      schemaVersion: "deviludo.runner-artifact-commit-receipt.v1",
      jobDigest: sha256Canonical(job.payload),
      attemptId: job.payload.attemptId,
      platform: job.payload.platform,
      artifactKind: request.artifactKind,
      artifactDigest: request.artifactDigest,
      objectKey: artifact.objectKey,
      sizeBytes: request.sizeBytes,
      verified: true,
    });
  }

  async verifyEvidenceArtifacts(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly bundle: EvidenceBundle;
  }): Promise<void> {
    await Promise.all(input.bundle.platformEvidence.flatMap((evidence) => evidenceArtifactBindings(
      input.tenantId,
      input.projectId,
      input.bundle.attemptId,
      evidence,
    ).map(async (artifact) => {
      await this.#transfer.verifyObject({
        objectKey: artifact.objectKey,
        artifactDigest: artifact.artifactDigest,
      });
    })));
  }

  async probe(): Promise<void> {
    await Promise.all([this.#transfer.probe(), this.#fleet.probe()]);
  }

  async #authorize(identity: EvidenceArchiveWorkloadIdentity, job: SignedRunnerJob): Promise<{
    readonly job: SignedRunnerJob;
    readonly now: string;
    readonly expiresAt: string;
  }> {
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    if (!Number.isFinite(nowDate.getTime())) invalid("clock");
    let verified = false;
    try {
      verified = verifyRunnerJob(job, this.#jobPublicKey, {
        keyId: this.#jobKeyId,
        runnerId: job.payload.runnerId,
        platform: job.payload.platform,
        now,
      });
    } catch { /* malformed jobs fail below */ }
    if (!verified) invalid("signed job");
    const admitted = await this.#fleet.authorizeJob({
      identity,
      runnerId: job.payload.runnerId,
      platform: job.payload.platform,
      capabilityDigest: job.payload.runnerCapabilityDigest,
      tenantId: job.payload.tenantId,
    });
    if (!admitted) invalid("fleet assignment");
    const leaseExpiry = Date.parse(job.payload.leaseExpiresAt);
    const grantExpiry = Math.min(leaseExpiry, nowDate.getTime() + MAX_GRANT_SECONDS * 1_000);
    if (!Number.isFinite(grantExpiry) || grantExpiry <= nowDate.getTime()) invalid("grant expiry");
    return Object.freeze({ job, now, expiresAt: new Date(grantExpiry).toISOString() });
  }

  async #reserve(job: SignedRunnerJob, operation: Extract<RunnerArtifactGrantOperation, { kind: "UPLOAD_EVIDENCE" }>): Promise<void> {
    const reservation = Object.freeze({
      schemaVersion: "deviludo.runner-artifact-reservation.v1",
      jobDigest: sha256Canonical(job.payload),
      attemptId: job.payload.attemptId,
      runnerId: job.payload.runnerId,
      platform: job.payload.platform,
      artifactKind: operation.artifactKind,
      artifactDigest: operation.artifactDigest,
      sizeBytes: operation.sizeBytes,
    });
    const body = Buffer.from(`${canonicalJson(reservation)}\n`, "utf8");
    await this.#reservations.putImmutable({
      objectKey: runnerArtifactReservationKey(
        job.payload.tenantId,
        job.payload.projectId,
        job.payload.attemptId,
        job.payload.platform,
        operation.artifactKind,
      ),
      contentType: "application/json",
      contentDigest: createHash("sha256").update(body).digest("hex"),
      body,
    });
  }
}

function parseGrantRequest(value: unknown): RunnerArtifactGrantRequest {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "job", "operation"]);
  if (body.schemaVersion !== "deviludo.runner-artifact-grant-request.v1") invalid("grant schema");
  const operation = record(body.operation);
  if (operation.kind === "DOWNLOAD_INPUT") {
    exactKeys(operation, ["kind"]);
    return { schemaVersion: "deviludo.runner-artifact-grant-request.v1", job: record(body.job) as unknown as SignedRunnerJob, operation: { kind: "DOWNLOAD_INPUT" } };
  }
  if (operation.kind === "DOWNLOAD_TEST_PLAN") {
    exactKeys(operation, ["kind"]);
    return { schemaVersion: "deviludo.runner-artifact-grant-request.v1", job: record(body.job) as unknown as SignedRunnerJob, operation: { kind: "DOWNLOAD_TEST_PLAN" } };
  }
  exactKeys(operation, ["kind", "artifactKind", "artifactDigest", "sizeBytes"]);
  if (operation.kind !== "UPLOAD_EVIDENCE") invalid("grant operation");
  const artifactKind = artifactKindValue(operation.artifactKind);
  const artifactDigest = digestValue(operation.artifactDigest);
  const sizeBytes = sizeValue(operation.sizeBytes, artifactKind);
  return {
    schemaVersion: "deviludo.runner-artifact-grant-request.v1",
    job: record(body.job) as unknown as SignedRunnerJob,
    operation: { kind: "UPLOAD_EVIDENCE", artifactKind, artifactDigest, sizeBytes },
  };
}

function parseCommitRequest(value: unknown): RunnerArtifactCommitRequest {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "job", "artifactKind", "artifactDigest", "sizeBytes"]);
  if (body.schemaVersion !== "deviludo.runner-artifact-commit-request.v1") invalid("commit schema");
  const artifactKind = artifactKindValue(body.artifactKind);
  return {
    schemaVersion: "deviludo.runner-artifact-commit-request.v1",
    job: record(body.job) as unknown as SignedRunnerJob,
    artifactKind,
    artifactDigest: digestValue(body.artifactDigest),
    sizeBytes: sizeValue(body.sizeBytes, artifactKind),
  };
}

function artifactBinding(job: SignedRunnerJob, operation: Extract<RunnerArtifactGrantOperation, { kind: "UPLOAD_EVIDENCE" }>) {
  return Object.freeze({
    objectKey: runnerArtifactObjectKey(
      job.payload.tenantId,
      job.payload.projectId,
      job.payload.attemptId,
      job.payload.platform,
      operation.artifactKind,
      operation.artifactDigest,
    ),
    artifactDigest: operation.artifactDigest,
    sizeBytes: operation.sizeBytes,
    contentType: contentTypeFor(operation.artifactKind),
  });
}

function evidenceArtifactBindings(
  tenantId: string,
  projectId: string,
  attemptId: string,
  evidence: PlatformEvidence,
): readonly { objectKey: string; artifactDigest: string }[] {
  const values: readonly [RunnerArtifactKind, string][] = [
    ["production-export", evidence.exportDigest],
    ["logs", evidence.logsDigest],
    ["junit", evidence.junitDigest],
    ["input-timeline", evidence.inputTimelineDigest],
    ["screenshot-manifest", evidence.screenshotManifestDigest],
    ["video-manifest", evidence.videoManifestDigest],
  ];
  return values.map(([kind, artifactDigest]) => Object.freeze({
    objectKey: runnerArtifactObjectKey(tenantId, projectId, attemptId, evidence.platform, kind, artifactDigest),
    artifactDigest,
  }));
}

export function runnerArtifactObjectKey(
  tenantId: string,
  projectId: string,
  attemptId: string,
  platform: TargetPlatform,
  kind: RunnerArtifactKind,
  digest: string,
): string {
  return `tenants/${tenantId}/projects/${projectId}/runner-artifacts/${attemptId}/${platform}/${kind}/${digest}`;
}

export function runnerTestPlanObjectKey(tenantId: string, projectId: string, digest: string): string {
  return `tenants/${tenantId}/projects/${projectId}/test-plans/${digest}.json`;
}

function artifactKindValue(value: unknown): RunnerArtifactKind {
  if (value !== "logs" && value !== "junit" && value !== "input-timeline"
    && value !== "screenshot-manifest" && value !== "video-manifest" && value !== "production-export") {
    invalid("artifact kind");
  }
  return value;
}

function digestValue(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) invalid("artifact digest");
  return value;
}

function sizeValue(value: unknown, kind: RunnerArtifactKind): number {
  const maximum: Record<RunnerArtifactKind, number> = {
    logs: 64 * 1024 * 1024,
    junit: 16 * 1024 * 1024,
    "input-timeline": 64 * 1024 * 1024,
    "screenshot-manifest": 1024 * 1024 * 1024,
    "video-manifest": 4 * 1024 * 1024 * 1024,
    "production-export": 8 * 1024 * 1024 * 1024,
  };
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum[kind]) invalid("artifact size");
  return value as number;
}

function contentTypeFor(kind: RunnerArtifactKind): string {
  if (kind === "logs") return "text/plain";
  if (kind === "junit") return "application/xml";
  if (kind === "input-timeline") return "application/json";
  if (kind.endsWith("-manifest")) return "application/vnd.deviludo.evidence-package";
  return "application/octet-stream";
}

function validateTransferGrant(grant: RunnerArtifactTransferGrant, method: "GET" | "PUT", expiresAt: string, now: string): void {
  let url: URL;
  try { url = new URL(grant.url); }
  catch { invalid("transfer URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || grant.method !== method || grant.expiresAt !== expiresAt
    || Date.parse(grant.expiresAt) <= Date.parse(now)) invalid("transfer grant");
  const headers = record(grant.requiredHeaders);
  if (Object.keys(headers).length > 16) invalid("transfer headers");
  for (const [name, value] of Object.entries(headers)) {
    if (!SAFE_HEADER.test(name) || name !== name.toLowerCase()
      || typeof value !== "string" || !value || value.length > 4_096 || /\r|\n|\0/.test(value)
      || name === "authorization" || name === "cookie") invalid("transfer headers");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("object");
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid("fields");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(field: string): never {
  throw new Error(`Runner artifact ${field} is invalid`);
}

function runnerArtifactReservationKey(
  tenantId: string,
  projectId: string,
  attemptId: string,
  platform: TargetPlatform,
  kind: RunnerArtifactKind,
): string {
  return `tenants/${tenantId}/projects/${projectId}/runner-artifacts/${attemptId}/${platform}/${kind}/reservation.json`;
}
