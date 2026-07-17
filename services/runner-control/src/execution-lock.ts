import type { TargetPlatform } from "../../../lib/domain/types";
import { sha256Canonical } from "./canonical";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const GODOT_VERSION = /^4\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9]+)*$/;
const TARGETS = new Set<TargetPlatform>(["windows", "linux", "macos"]);

export type RunnerExecutionMode = "CANDIDATE" | "MAIN_RELEASE_GATE" | "STEAM_CLEAN_INSTALL";

export interface RunnerExecutionLock {
  readonly schemaVersion: "deviludo.runner-execution-lock.v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly mode: RunnerExecutionMode;
  readonly commitSha: string;
  readonly sourceDigest: string;
  readonly steamBuildId: string | null;
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanDigest: string;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly requiredGodotVersion: string;
  readonly godotTestKitDigest: string;
  readonly exportTemplates: Readonly<Partial<Record<TargetPlatform, string>>>;
  readonly buildManifestDigest: string;
  readonly sbomDigest: string;
  readonly vulnerabilityScanDigest: string;
  readonly assetLicenseLedgerDigest: string;
  readonly execution:
    | Readonly<{
        kind: "SOURCE_ARTIFACT";
        objectKey: string;
        artifactDigest: string;
      }>
    | Readonly<{
        kind: "STEAM_CLEAN_INSTALL";
        steamAppId: string;
        buildId: string;
        betaBranch: string;
        installGrantId: string;
      }>;
  readonly preparedAt: string;
}

/** Parses the exact artifact-preparation result used by both scheduler and ingress. */
export function parseRunnerExecutionLock(value: unknown): Readonly<RunnerExecutionLock> {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "tenantId", "projectId", "runId", "mode", "commitSha", "sourceDigest",
    "steamBuildId", "specRevisionId", "specDigest", "testPlanDigest", "targetMatrix",
    "requiredGodotVersion", "godotTestKitDigest", "exportTemplates", "buildManifestDigest",
    "sbomDigest", "vulnerabilityScanDigest", "assetLicenseLedgerDigest", "execution", "preparedAt",
  ], "payload");
  if (body.schemaVersion !== "deviludo.runner-execution-lock.v1") invalid("schema version");
  const mode = executionMode(body.mode);
  const tenantId = required(body.tenantId, UUID, "tenant");
  const projectId = required(body.projectId, UUID, "project");
  const runId = required(body.runId, UUID, "run");
  const commitSha = required(body.commitSha, SHA1, "commit");
  const sourceDigest = required(body.sourceDigest, SHA256, "source digest");
  const specRevisionId = required(body.specRevisionId, UUID, "spec revision");
  const specDigest = required(body.specDigest, SHA256, "spec digest");
  const testPlanDigest = required(body.testPlanDigest, SHA256, "test plan digest");
  const targetMatrix = matrix(body.targetMatrix);
  const requiredGodotVersion = required(body.requiredGodotVersion, GODOT_VERSION, "Godot version");
  const godotTestKitDigest = required(body.godotTestKitDigest, SHA256, "Godot TestKit digest");
  const exportTemplatesBody = record(body.exportTemplates);
  const exportTemplates = Object.freeze(Object.fromEntries(targetMatrix.map((platform) => [
    platform,
    required(exportTemplatesBody[platform], SHA256, `${platform} export templates digest`),
  ]))) as Readonly<Partial<Record<TargetPlatform, string>>>;
  if (Object.keys(exportTemplatesBody).length !== targetMatrix.length) invalid("export template matrix");
  const buildManifestDigest = required(body.buildManifestDigest, SHA256, "build manifest digest");
  const sbomDigest = required(body.sbomDigest, SHA256, "SBOM digest");
  const vulnerabilityScanDigest = required(body.vulnerabilityScanDigest, SHA256, "vulnerability scan digest");
  const assetLicenseLedgerDigest = required(body.assetLicenseLedgerDigest, SHA256, "asset license ledger digest");
  const steamBuildId = body.steamBuildId === null ? null : required(body.steamBuildId, /^[1-9][0-9]{0,19}$/, "Steam BuildID");
  const executionBody = record(body.execution);
  let execution: RunnerExecutionLock["execution"];
  if (mode === "STEAM_CLEAN_INSTALL") {
    if (steamBuildId === null || executionBody.kind !== "STEAM_CLEAN_INSTALL") invalid("Steam execution mode");
    exactKeys(executionBody, ["kind", "steamAppId", "buildId", "betaBranch", "installGrantId"], "Steam execution");
    const buildId = required(executionBody.buildId, /^[1-9][0-9]{0,19}$/, "Steam execution BuildID");
    if (buildId !== steamBuildId) invalid("Steam execution BuildID binding");
    execution = Object.freeze({
      kind: "STEAM_CLEAN_INSTALL",
      steamAppId: required(executionBody.steamAppId, /^[1-9][0-9]{0,19}$/, "Steam AppID"),
      buildId,
      betaBranch: required(executionBody.betaBranch, /^[a-z0-9][a-z0-9_-]{2,39}$/, "Steam Beta branch"),
      installGrantId: required(executionBody.installGrantId, SAFE_ID, "Steam install grant"),
    });
  } else {
    if (steamBuildId !== null || executionBody.kind !== "SOURCE_ARTIFACT") invalid("source execution mode");
    exactKeys(executionBody, ["kind", "objectKey", "artifactDigest"], "source execution");
    const objectKey = required(executionBody.objectKey, /^[A-Za-z0-9][A-Za-z0-9/_.-]{1,1023}$/, "source object key");
    const prefix = `tenants/${tenantId}/projects/${projectId}/`;
    if (!objectKey.startsWith(prefix) || objectKey.includes("..") || objectKey.endsWith("/")) invalid("source object key scope");
    execution = Object.freeze({
      kind: "SOURCE_ARTIFACT",
      objectKey,
      artifactDigest: required(executionBody.artifactDigest, SHA256, "source artifact digest"),
    });
  }
  const preparedAt = requiredDate(body.preparedAt);
  return Object.freeze({
    schemaVersion: "deviludo.runner-execution-lock.v1",
    tenantId,
    projectId,
    runId,
    mode,
    commitSha,
    sourceDigest,
    steamBuildId,
    specRevisionId,
    specDigest,
    testPlanDigest,
    targetMatrix,
    requiredGodotVersion,
    godotTestKitDigest,
    exportTemplates,
    buildManifestDigest,
    sbomDigest,
    vulnerabilityScanDigest,
    assetLicenseLedgerDigest,
    execution,
    preparedAt,
  });
}

export function runnerExecutionLockDigest(lock: RunnerExecutionLock): string {
  return sha256Canonical(parseRunnerExecutionLock(lock));
}

function executionMode(value: unknown): RunnerExecutionMode {
  if (value !== "CANDIDATE" && value !== "MAIN_RELEASE_GATE" && value !== "STEAM_CLEAN_INSTALL") invalid("mode");
  return value;
}

function matrix(value: unknown): readonly TargetPlatform[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length
    || value.some((entry) => typeof entry !== "string" || !TARGETS.has(entry as TargetPlatform))) invalid("target matrix");
  const sorted = [...value].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(value)) invalid("target matrix order");
  return Object.freeze(sorted) as readonly TargetPlatform[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("object");
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid(`${label} fields`);
}

function required(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(label);
  return value;
}

function requiredDate(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid("prepared timestamp");
  return value;
}

function invalid(field: string): never {
  throw new Error(`Runner execution lock ${field} is invalid`);
}
