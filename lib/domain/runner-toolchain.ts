import type { TargetPlatform } from "./types";

const SHA256 = /^[a-f0-9]{64}$/;
const GODOT_VERSION = /^4\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9]+)*$/;
const TARGETS = new Set<TargetPlatform>(["windows", "linux", "macos"]);

export interface RunnerToolchainRevisionPayload {
  readonly schemaVersion: "deviludo.runner-toolchain.v1";
  readonly requiredGodotVersion: string;
  readonly godotTestKitDigest: string;
  readonly exportTemplates: Readonly<Partial<Record<TargetPlatform, string>>>;
  readonly buildManifestDigest: string;
  readonly sbomDigest: string;
  readonly vulnerabilityScanDigest: string;
  readonly assetLicenseLedgerDigest: string;
}

/**
 * Canonical parser shared by specification approval and artifact preparation.
 * Keeping the two trust boundaries on one parser prevents approval from
 * freezing a toolchain that the physical Runner would later interpret
 * differently.
 */
export function parseRunnerToolchainRevision(
  value: unknown,
  expectedTargetMatrix: readonly TargetPlatform[],
): Readonly<RunnerToolchainRevisionPayload> {
  const targetMatrix = matrix(expectedTargetMatrix);
  const toolchain = record(value, "toolchain");
  exactKeys(toolchain, [
    "schemaVersion", "requiredGodotVersion", "godotTestKitDigest", "exportTemplates", "buildManifestDigest",
    "sbomDigest", "vulnerabilityScanDigest", "assetLicenseLedgerDigest",
  ], "toolchain");
  if (toolchain.schemaVersion !== "deviludo.runner-toolchain.v1") invalid("toolchain schema version");
  const exportTemplatesBody = record(toolchain.exportTemplates, "export templates");
  const exportTemplates = Object.fromEntries(targetMatrix.map((platform) => [
    platform,
    required(exportTemplatesBody[platform], SHA256, `${platform} export template`),
  ])) as Partial<Record<TargetPlatform, string>>;
  if (Object.keys(exportTemplatesBody).length !== targetMatrix.length) invalid("export template matrix");
  return deepFreeze({
    schemaVersion: "deviludo.runner-toolchain.v1",
    requiredGodotVersion: required(toolchain.requiredGodotVersion, GODOT_VERSION, "Godot version"),
    godotTestKitDigest: required(toolchain.godotTestKitDigest, SHA256, "TestKit digest"),
    exportTemplates,
    buildManifestDigest: required(toolchain.buildManifestDigest, SHA256, "build manifest"),
    sbomDigest: required(toolchain.sbomDigest, SHA256, "SBOM"),
    vulnerabilityScanDigest: required(toolchain.vulnerabilityScanDigest, SHA256, "vulnerability scan"),
    assetLicenseLedgerDigest: required(toolchain.assetLicenseLedgerDigest, SHA256, "asset license ledger"),
  });
}

function matrix(value: unknown): readonly TargetPlatform[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length
    || value.some((item) => typeof item !== "string" || !TARGETS.has(item as TargetPlatform))) invalid("target matrix");
  const parsed = [...value].sort() as TargetPlatform[];
  if (JSON.stringify(parsed) !== JSON.stringify(value)) invalid("target matrix ordering");
  return Object.freeze(parsed);
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
  throw new Error(`Runner toolchain ${label} is invalid`);
}
