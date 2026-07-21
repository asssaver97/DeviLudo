import type { EvidenceBundle, PlatformEvidence } from "@/lib/domain/e2e";

export const EVIDENCE_CATALOG_SCHEMA_VERSION = "deviludo.evidence-catalog-projection.v1" as const;

export interface EvidenceAuthorityBinding {
  readonly schemaVersion: "deviludo.evidence-binding.v1";
  readonly attemptId: string;
  readonly executionLockId: string;
  readonly executionLockDigest: string;
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanDigest: string;
  readonly runnerToolchainRevisionId: string;
  readonly runnerToolchainDigest: string;
  readonly commitSha: string;
  readonly sourceDigest: string;
  readonly targetMatrix: readonly ("linux" | "macos" | "windows")[];
}

export interface EvidenceCatalogEntry {
  readonly evidenceBundleId: string;
  readonly invalidatedAt: string | null;
  readonly binding: EvidenceAuthorityBinding;
  readonly bundle: EvidenceBundle;
}

export interface EvidenceCatalogProjection {
  readonly schemaVersion: typeof EVIDENCE_CATALOG_SCHEMA_VERSION;
  readonly tenantId: string;
  readonly projectId: string;
  readonly observedAt: string;
  readonly entries: readonly EvidenceCatalogEntry[];
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUNNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PLATFORMS = ["linux", "macos", "windows"] as const;

export async function parseEvidenceCatalogProjection(
  value: unknown,
  binding?: Readonly<{ tenantId: string; projectId: string }>,
): Promise<EvidenceCatalogProjection> {
  const body = exact(value, ["entries", "observedAt", "projectId", "schemaVersion", "tenantId"]);
  if (body.schemaVersion !== EVIDENCE_CATALOG_SCHEMA_VERSION
    || typeof body.tenantId !== "string" || !UUID.test(body.tenantId)
    || typeof body.projectId !== "string" || !UUID.test(body.projectId)
    || (binding && (body.tenantId !== binding.tenantId || body.projectId !== binding.projectId))
    || !Array.isArray(body.entries) || body.entries.length > 50) invalid();
  const observedAt = iso(body.observedAt);
  const entries = await Promise.all(body.entries.map((entry) => parseEntry(entry, observedAt)));
  const identities = entries.map((entry) => entry.evidenceBundleId);
  const digests = entries.map((entry) => entry.bundle.bundleDigest);
  if (new Set(identities).size !== identities.length || new Set(digests).size !== digests.length) invalid();
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!;
    const current = entries[index]!;
    const previousTime = Date.parse(previous.bundle.createdAt);
    const currentTime = Date.parse(current.bundle.createdAt);
    if (previousTime < currentTime
      || (previousTime === currentTime && previous.evidenceBundleId.localeCompare(current.evidenceBundleId) < 0)) invalid();
  }
  return deepFreeze({
    schemaVersion: EVIDENCE_CATALOG_SCHEMA_VERSION,
    tenantId: body.tenantId,
    projectId: body.projectId,
    observedAt,
    entries,
  });
}

async function parseEntry(value: unknown, observedAt: string): Promise<EvidenceCatalogEntry> {
  const item = exact(value, ["binding", "bundle", "evidenceBundleId", "invalidatedAt"]);
  if (typeof item.evidenceBundleId !== "string" || !UUID.test(item.evidenceBundleId)) invalid();
  const bundle = await parseBundle(item.bundle, observedAt);
  const authority = parseAuthorityBinding(item.binding);
  const invalidatedAt = item.invalidatedAt === null ? null : iso(item.invalidatedAt);
  if (item.evidenceBundleId !== bundle.id || bundle.id !== bundle.attemptId
    || authority.attemptId !== bundle.attemptId
    || authority.specRevisionId !== bundle.specRevisionId
    || authority.specDigest !== bundle.specDigest
    || authority.testPlanDigest !== bundle.testPlanDigest
    || authority.commitSha !== bundle.commitSha
    || authority.sourceDigest !== bundle.sourceDigest
    || JSON.stringify(authority.targetMatrix) !== JSON.stringify(bundle.targetMatrix)
    || (invalidatedAt !== null && (Date.parse(invalidatedAt) < Date.parse(bundle.createdAt)
      || Date.parse(invalidatedAt) > Date.parse(observedAt) + 5 * 60_000))) invalid();
  return deepFreeze({ evidenceBundleId: item.evidenceBundleId, invalidatedAt, binding: authority, bundle });
}

function parseAuthorityBinding(value: unknown): EvidenceAuthorityBinding {
  const item = exact(value, [
    "attemptId", "commitSha", "executionLockDigest", "executionLockId", "runnerToolchainDigest",
    "runnerToolchainRevisionId", "schemaVersion", "sourceDigest", "specDigest", "specRevisionId",
    "targetMatrix", "testPlanDigest",
  ]);
  if (item.schemaVersion !== "deviludo.evidence-binding.v1") invalid();
  for (const field of ["attemptId", "executionLockId", "runnerToolchainRevisionId", "specRevisionId"] as const) {
    if (typeof item[field] !== "string" || !UUID.test(item[field])) invalid();
  }
  for (const field of ["executionLockDigest", "runnerToolchainDigest", "sourceDigest", "specDigest", "testPlanDigest"] as const) {
    if (typeof item[field] !== "string" || !SHA256.test(item[field])) invalid();
  }
  if (typeof item.commitSha !== "string" || !SHA1.test(item.commitSha)) invalid();
  const targetMatrix = matrix(item.targetMatrix);
  return deepFreeze({
    schemaVersion: "deviludo.evidence-binding.v1",
    attemptId: item.attemptId,
    executionLockId: item.executionLockId,
    executionLockDigest: item.executionLockDigest,
    specRevisionId: item.specRevisionId,
    specDigest: item.specDigest,
    testPlanDigest: item.testPlanDigest,
    runnerToolchainRevisionId: item.runnerToolchainRevisionId,
    runnerToolchainDigest: item.runnerToolchainDigest,
    commitSha: item.commitSha,
    sourceDigest: item.sourceDigest,
    targetMatrix,
  } as EvidenceAuthorityBinding);
}

async function parseBundle(value: unknown, observedAt: string): Promise<EvidenceBundle> {
  const item = exact(value, [
    "assetLicenseLedgerDigest", "attemptId", "buildManifestDigest", "bundleDigest", "commitSha", "createdAt",
    "godotTestKitDigest", "id", "platformEvidence", "sbomDigest", "sourceDigest", "specDigest",
    "specRevisionId", "status", "targetMatrix", "testPlanDigest", "valid", "vulnerabilityScanDigest",
  ]);
  for (const field of ["attemptId", "id", "specRevisionId"] as const) {
    if (typeof item[field] !== "string" || !UUID.test(item[field])) invalid();
  }
  for (const field of [
    "assetLicenseLedgerDigest", "buildManifestDigest", "bundleDigest", "godotTestKitDigest", "sbomDigest",
    "sourceDigest", "specDigest", "testPlanDigest", "vulnerabilityScanDigest",
  ] as const) {
    if (typeof item[field] !== "string" || !SHA256.test(item[field])) invalid();
  }
  if (typeof item.commitSha !== "string" || !SHA1.test(item.commitSha)
    || item.valid !== true || (item.status !== "PASSED" && item.status !== "FAILED")) invalid();
  const targetMatrix = matrix(item.targetMatrix);
  if (!Array.isArray(item.platformEvidence) || item.platformEvidence.length !== targetMatrix.length) invalid();
  const platformEvidence = item.platformEvidence.map(parsePlatformEvidence);
  if (platformEvidence.some((entry, index) => entry.platform !== targetMatrix[index])) invalid();
  const status = platformEvidence.every((entry) => entry.status === "PASSED") ? "PASSED" : "FAILED";
  const createdAt = iso(item.createdAt);
  if (item.status !== status || Date.parse(createdAt) > Date.parse(observedAt) + 5 * 60_000) invalid();
  const core = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "bundleDigest"));
  if (item.bundleDigest !== await sha256(canonicalJson(core))) invalid();
  return deepFreeze({
    id: item.id,
    attemptId: item.attemptId,
    specRevisionId: item.specRevisionId,
    specDigest: item.specDigest,
    testPlanDigest: item.testPlanDigest,
    commitSha: item.commitSha,
    sourceDigest: item.sourceDigest,
    targetMatrix,
    godotTestKitDigest: item.godotTestKitDigest,
    buildManifestDigest: item.buildManifestDigest,
    sbomDigest: item.sbomDigest,
    vulnerabilityScanDigest: item.vulnerabilityScanDigest,
    assetLicenseLedgerDigest: item.assetLicenseLedgerDigest,
    platformEvidence,
    bundleDigest: item.bundleDigest,
    status,
    valid: true,
    createdAt,
  } as EvidenceBundle);
}

function parsePlatformEvidence(value: unknown): PlatformEvidence {
  const item = exact(value, [
    "exportDigest", "inputTimelineDigest", "junitDigest", "logsDigest", "platform", "runnerCapabilityDigest",
    "runnerId", "screenshotManifestDigest", "status", "videoManifestDigest",
  ]);
  const platform = oneOf(item.platform, PLATFORMS);
  if (typeof item.runnerId !== "string" || !RUNNER_ID.test(item.runnerId)
    || (item.status !== "PASSED" && item.status !== "FAILED")) invalid();
  for (const field of [
    "exportDigest", "inputTimelineDigest", "junitDigest", "logsDigest", "runnerCapabilityDigest",
    "screenshotManifestDigest", "videoManifestDigest",
  ] as const) {
    if (typeof item[field] !== "string" || !SHA256.test(item[field])) invalid();
  }
  return deepFreeze({
    platform,
    runnerId: item.runnerId,
    runnerCapabilityDigest: item.runnerCapabilityDigest,
    exportDigest: item.exportDigest,
    logsDigest: item.logsDigest,
    junitDigest: item.junitDigest,
    inputTimelineDigest: item.inputTimelineDigest,
    screenshotManifestDigest: item.screenshotManifestDigest,
    videoManifestDigest: item.videoManifestDigest,
    status: item.status,
  } as PlatformEvidence);
}

function matrix(value: unknown): readonly ("linux" | "macos" | "windows")[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) invalid();
  const result = value.map((item) => oneOf(item, PLATFORMS));
  if (new Set(result).size !== result.length || JSON.stringify(result) !== JSON.stringify([...result].sort())) invalid();
  return Object.freeze(result);
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...keys].sort())) invalid();
  return result;
}
function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) invalid();
  return value as T[number];
}
function iso(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid();
  const normalized = new Date(value).toISOString();
  if (value !== normalized) invalid();
  return normalized;
}
function canonicalJson(value: unknown): string { return JSON.stringify(canonicalize(value)); }
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol"
    || (typeof value === "number" && !Number.isFinite(value))) invalid();
  return value;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function invalid(): never { throw new Error("Evidence catalog projection is invalid"); }
