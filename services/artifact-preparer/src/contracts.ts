import type { TargetPlatform } from "../../../lib/domain/types";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GODOT_VERSION = /^4\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9]+)*$/;
const TARGETS = new Set<TargetPlatform>(["windows", "linux", "macos"]);

export interface SourceExecutionPreparationRequest {
  readonly schemaVersion: "deviludo.source-execution-preparation.v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly lockKey: string;
  readonly mode: "CANDIDATE" | "MAIN_RELEASE_GATE";
  readonly commitSha: string;
  readonly sourceDigest: string;
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanDigest: string;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly toolchain: Readonly<{
    requiredGodotVersion: string;
    godotTestKitDigest: string;
    exportTemplates: Readonly<Partial<Record<TargetPlatform, string>>>;
    buildManifestDigest: string;
    sbomDigest: string;
    vulnerabilityScanDigest: string;
    assetLicenseLedgerDigest: string;
  }>;
}

export function parseSourceExecutionPreparationRequest(value: unknown): SourceExecutionPreparationRequest {
  const body = record(value, "request");
  exactKeys(body, [
    "schemaVersion", "tenantId", "projectId", "runId", "lockKey", "mode", "commitSha",
    "sourceDigest", "specRevisionId", "specDigest", "testPlanDigest", "targetMatrix", "toolchain",
  ], "request");
  if (body.schemaVersion !== "deviludo.source-execution-preparation.v1") invalid("schema version");
  const targetMatrix = matrix(body.targetMatrix);
  const toolchain = record(body.toolchain, "toolchain");
  exactKeys(toolchain, [
    "requiredGodotVersion", "godotTestKitDigest", "exportTemplates", "buildManifestDigest",
    "sbomDigest", "vulnerabilityScanDigest", "assetLicenseLedgerDigest",
  ], "toolchain");
  const exportTemplatesBody = record(toolchain.exportTemplates, "export templates");
  const exportTemplates = Object.fromEntries(targetMatrix.map((platform) => [
    platform,
    required(exportTemplatesBody[platform], SHA256, `${platform} export template`),
  ])) as Partial<Record<TargetPlatform, string>>;
  if (Object.keys(exportTemplatesBody).length !== targetMatrix.length) invalid("export template matrix");
  return deepFreeze({
    schemaVersion: "deviludo.source-execution-preparation.v1",
    tenantId: required(body.tenantId, UUID, "tenant"),
    projectId: required(body.projectId, UUID, "project"),
    runId: required(body.runId, UUID, "run"),
    lockKey: required(body.lockKey, SHA256, "lock key"),
    mode: mode(body.mode),
    commitSha: required(body.commitSha, SHA1, "commit"),
    sourceDigest: required(body.sourceDigest, SHA256, "source digest"),
    specRevisionId: required(body.specRevisionId, UUID, "spec revision"),
    specDigest: required(body.specDigest, SHA256, "spec digest"),
    testPlanDigest: required(body.testPlanDigest, SHA256, "test plan digest"),
    targetMatrix,
    toolchain: {
      requiredGodotVersion: required(toolchain.requiredGodotVersion, GODOT_VERSION, "Godot version"),
      godotTestKitDigest: required(toolchain.godotTestKitDigest, SHA256, "TestKit digest"),
      exportTemplates,
      buildManifestDigest: required(toolchain.buildManifestDigest, SHA256, "build manifest"),
      sbomDigest: required(toolchain.sbomDigest, SHA256, "SBOM"),
      vulnerabilityScanDigest: required(toolchain.vulnerabilityScanDigest, SHA256, "vulnerability scan"),
      assetLicenseLedgerDigest: required(toolchain.assetLicenseLedgerDigest, SHA256, "asset license ledger"),
    },
  });
}

function matrix(value: unknown): readonly TargetPlatform[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length
    || value.some((item) => typeof item !== "string" || !TARGETS.has(item as TargetPlatform))) invalid("target matrix");
  const parsed = [...value].sort() as TargetPlatform[];
  if (JSON.stringify(parsed) !== JSON.stringify(value)) invalid("target matrix ordering");
  return Object.freeze(parsed);
}

function mode(value: unknown): "CANDIDATE" | "MAIN_RELEASE_GATE" {
  if (value !== "CANDIDATE" && value !== "MAIN_RELEASE_GATE") invalid("mode");
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid(`${label} fields`);
}

function required(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(label);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(label: string): never {
  throw new Error(`Artifact preparation ${label} is invalid`);
}
