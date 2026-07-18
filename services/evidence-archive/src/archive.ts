import { createHash } from "node:crypto";
import type { EvidenceBundle, PlatformEvidence } from "../../../lib/domain/e2e";
import type { TargetPlatform } from "../../../lib/domain/types";
import { canonicalJson, sha256Canonical } from "../../runner-control/src/canonical";
import type {
  EvidenceArchivePersistResult,
  EvidenceArchiveReceipt,
  EvidenceArchiveRequest,
  ImmutableObjectStore,
} from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TARGETS = new Set<TargetPlatform>(["windows", "linux", "macos"]);
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;

export class EvidenceArchiveService {
  readonly #store: ImmutableObjectStore;
  readonly #artifactVerifier: Readonly<{
    verifyEvidenceArtifacts(input: { readonly tenantId: string; readonly projectId: string; readonly bundle: EvidenceBundle }): Promise<void>;
    probe(): Promise<void>;
  }> | null;
  readonly #now: () => Date;

  constructor(options: {
    readonly store: ImmutableObjectStore;
    readonly artifactVerifier?: Readonly<{
      verifyEvidenceArtifacts(input: { readonly tenantId: string; readonly projectId: string; readonly bundle: EvidenceBundle }): Promise<void>;
      probe(): Promise<void>;
    }>;
    readonly now?: () => Date;
  }) {
    this.#store = options.store;
    this.#artifactVerifier = options.artifactVerifier ?? null;
    this.#now = options.now ?? (() => new Date());
  }

  async persist(value: unknown): Promise<EvidenceArchivePersistResult> {
    const request = parseEvidenceArchiveRequest(value, this.#now());
    if (this.#artifactVerifier) {
      await this.#artifactVerifier.verifyEvidenceArtifacts({
        tenantId: request.tenantId,
        projectId: request.projectId,
        bundle: request.bundle,
      });
    }
    const objectKey = evidenceObjectKey(request.tenantId, request.projectId, request.bundleDigest);
    const bundleBytes = jsonBytes(request.bundle);
    const storedBundle = await this.#store.putImmutable({
      objectKey,
      contentType: "application/json",
      contentDigest: contentDigest(bundleBytes),
      body: bundleBytes,
    });

    let repairPromptId: string | null = null;
    let repairCreated = false;
    if (request.bundle.status === "FAILED") {
      const prompt = repairPrompt(request.bundle);
      const promptBytes = jsonBytes(prompt);
      const storedPrompt = await this.#store.putImmutable({
        objectKey: repairObjectKey(request.tenantId, request.projectId, request.bundleDigest),
        contentType: "application/json",
        contentDigest: contentDigest(promptBytes),
        body: promptBytes,
      });
      repairCreated = storedPrompt.created;
      repairPromptId = `repair:${request.bundleDigest}`;
    }

    const receipt: EvidenceArchiveReceipt = Object.freeze({
      schemaVersion: "deviludo.runner-evidence-archive-receipt.v1",
      tenantId: request.tenantId,
      projectId: request.projectId,
      attemptId: request.attemptId,
      bundleDigest: request.bundleDigest,
      objectKey,
      repairPromptId,
    });
    return Object.freeze({ receipt, created: storedBundle.created || repairCreated });
  }

  async probe(): Promise<void> {
    await Promise.all([this.#store.probe(), this.#artifactVerifier?.probe()]);
  }
}

export function parseEvidenceArchiveRequest(value: unknown, now = new Date()): Readonly<EvidenceArchiveRequest> {
  const body = record(value, "archive request");
  exactKeys(body, ["schemaVersion", "tenantId", "projectId", "attemptId", "bundleDigest", "bundle"], "archive request");
  if (body.schemaVersion !== "deviludo.runner-evidence-archive.v1"
    || typeof body.tenantId !== "string" || !UUID.test(body.tenantId)
    || typeof body.projectId !== "string" || !UUID.test(body.projectId)
    || typeof body.attemptId !== "string" || !UUID.test(body.attemptId)
    || typeof body.bundleDigest !== "string" || !SHA256.test(body.bundleDigest)) invalid("archive binding");
  const bundle = parseEvidenceBundle(body.bundle, now);
  if (bundle.id !== body.attemptId || bundle.attemptId !== body.attemptId
    || bundle.bundleDigest !== body.bundleDigest) invalid("archive bundle binding");
  return deepFreeze({
    schemaVersion: "deviludo.runner-evidence-archive.v1",
    tenantId: body.tenantId,
    projectId: body.projectId,
    attemptId: body.attemptId,
    bundleDigest: body.bundleDigest,
    bundle,
  });
}

export function parseEvidenceBundle(value: unknown, now = new Date()): Readonly<EvidenceBundle> {
  const body = record(value, "bundle");
  exactKeys(body, [
    "id", "attemptId", "specRevisionId", "specDigest", "testPlanDigest", "commitSha", "sourceDigest",
    "targetMatrix", "godotTestKitDigest", "buildManifestDigest", "sbomDigest", "vulnerabilityScanDigest",
    "assetLicenseLedgerDigest", "platformEvidence", "bundleDigest", "status", "valid", "createdAt",
  ], "bundle");
  for (const field of ["id", "attemptId", "specRevisionId"] as const) {
    if (typeof body[field] !== "string" || !UUID.test(body[field])) invalid(`bundle ${field}`);
  }
  if (body.id !== body.attemptId || typeof body.commitSha !== "string" || !SHA1.test(body.commitSha)) {
    invalid("bundle identity");
  }
  for (const field of [
    "specDigest", "testPlanDigest", "sourceDigest", "godotTestKitDigest", "buildManifestDigest",
    "sbomDigest", "vulnerabilityScanDigest", "assetLicenseLedgerDigest", "bundleDigest",
  ] as const) {
    if (typeof body[field] !== "string" || !SHA256.test(body[field])) invalid(`bundle ${field}`);
  }
  const targetMatrix = parseMatrix(body.targetMatrix);
  if (!Array.isArray(body.platformEvidence) || body.platformEvidence.length !== targetMatrix.length) {
    invalid("bundle platform evidence");
  }
  const platformEvidence = body.platformEvidence.map(parsePlatformEvidence);
  if (platformEvidence.some((item, index) => item.platform !== targetMatrix[index])) {
    invalid("bundle platform evidence order");
  }
  const status = platformEvidence.every((item) => item.status === "PASSED") ? "PASSED" : "FAILED";
  if (body.status !== status || body.valid !== true || typeof body.createdAt !== "string") invalid("bundle status");
  const created = Date.parse(body.createdAt);
  const observed = now.getTime();
  if (!Number.isFinite(created) || !Number.isFinite(observed) || created > observed + 5 * 60_000) invalid("bundle timestamp");
  const { bundleDigest, ...core } = body;
  if (sha256Canonical(core) !== bundleDigest) invalid("bundle digest");
  return deepFreeze({
    ...(body as unknown as EvidenceBundle),
    targetMatrix,
    platformEvidence,
  });
}

function parsePlatformEvidence(value: unknown): Readonly<PlatformEvidence> {
  const body = record(value, "platform evidence");
  exactKeys(body, [
    "platform", "runnerId", "runnerCapabilityDigest", "exportDigest", "logsDigest", "junitDigest",
    "inputTimelineDigest", "screenshotManifestDigest", "videoManifestDigest", "status",
  ], "platform evidence");
  if (typeof body.platform !== "string" || !TARGETS.has(body.platform as TargetPlatform)
    || typeof body.runnerId !== "string" || !SAFE_ID.test(body.runnerId)
    || (body.status !== "PASSED" && body.status !== "FAILED")) invalid("platform evidence binding");
  for (const field of [
    "runnerCapabilityDigest", "exportDigest", "logsDigest", "junitDigest", "inputTimelineDigest",
    "screenshotManifestDigest", "videoManifestDigest",
  ] as const) {
    if (typeof body[field] !== "string" || !SHA256.test(body[field])) invalid(`platform evidence ${field}`);
  }
  return Object.freeze(body as unknown as PlatformEvidence);
}

function repairPrompt(bundle: EvidenceBundle): Readonly<Record<string, unknown>> {
  const failedPlatforms = bundle.platformEvidence
    .filter((item) => item.status === "FAILED")
    .map((item) => Object.freeze({
      platform: item.platform,
      runnerId: item.runnerId,
      logsDigest: item.logsDigest,
      junitDigest: item.junitDigest,
      screenshotManifestDigest: item.screenshotManifestDigest,
      videoManifestDigest: item.videoManifestDigest,
    }));
  if (!failedPlatforms.length) invalid("repair prompt failure set");
  return deepFreeze({
    schemaVersion: "deviludo.e2e-repair-prompt.v1",
    repairPromptId: `repair:${bundle.bundleDigest}`,
    evidenceBundleDigest: bundle.bundleDigest,
    attemptId: bundle.attemptId,
    commitSha: bundle.commitSha,
    sourceDigest: bundle.sourceDigest,
    testPlanDigest: bundle.testPlanDigest,
    failedPlatforms,
    instruction: "Inspect only the content-addressed failed-platform evidence, repair the frozen candidate, and preserve the approved specification and test plan.",
  });
}

function parseMatrix(value: unknown): readonly TargetPlatform[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3
    || new Set(value).size !== value.length
    || value.some((item) => typeof item !== "string" || !TARGETS.has(item as TargetPlatform))) invalid("target matrix");
  const sorted = [...value].sort();
  if (JSON.stringify(value) !== JSON.stringify(sorted)) invalid("target matrix order");
  return Object.freeze(sorted) as readonly TargetPlatform[];
}

function evidenceObjectKey(tenantId: string, projectId: string, digest: string): string {
  return `tenants/${tenantId}/projects/${projectId}/evidence/${digest}.json`;
}

function repairObjectKey(tenantId: string, projectId: string, digest: string): string {
  return `tenants/${tenantId}/projects/${projectId}/repairs/${digest}.json`;
}

function jsonBytes(value: unknown): Buffer {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_ARCHIVE_BYTES) invalid("archive object size");
  return bytes;
}

function contentDigest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label);
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(body).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid(`${label} fields`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(field: string): never {
  throw new Error(`Evidence archive ${field} is invalid`);
}
