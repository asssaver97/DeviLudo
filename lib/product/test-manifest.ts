export const TEST_MANIFEST_SCHEMA_VERSION = "deviludo.test-manifest.v1" as const;

export const VERIFICATION_METHODS = ["unit", "interactive", "visual", "manual"] as const;
export type VerificationMethod = typeof VERIFICATION_METHODS[number];

export const FEATURE_CATEGORIES = [
  "core-loop",
  "player-control",
  "data-integrity",
  "runtime-quality",
  "ui",
  "audio",
  "network",
] as const;
export type FeatureCategory = typeof FEATURE_CATEGORIES[number];

export type TestManifestFeature = Readonly<{
  id: string;
  category: FeatureCategory;
  description: string;
  verificationMethod: VerificationMethod;
  gdsTestPath?: string;
  checkNames?: readonly string[];
  interactionScript?: string;
  expectedVisual?: string;
}>;

export type TestManifest = Readonly<{
  schemaVersion: typeof TEST_MANIFEST_SCHEMA_VERSION;
  features: readonly TestManifestFeature[];
}>;

export type TestExecutionResult = Readonly<{
  suite: string;
  checks: readonly string[];
  failures: readonly string[];
  duration_ms: number;
}>;

export function validateTestManifest(value: unknown): value is TestManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== TEST_MANIFEST_SCHEMA_VERSION) return false;
  if (!Array.isArray(manifest.features)) return false;
  return manifest.features.every(feature => {
    if (!feature || typeof feature !== "object" || Array.isArray(feature)) return false;
    const f = feature as Record<string, unknown>;
    return typeof f.id === "string"
      && f.id.length > 0
      && typeof f.category === "string"
      && FEATURE_CATEGORIES.includes(f.category as FeatureCategory)
      && typeof f.description === "string"
      && f.description.length > 0
      && typeof f.verificationMethod === "string"
      && VERIFICATION_METHODS.includes(f.verificationMethod as VerificationMethod);
  });
}

export function validateTestExecutionResult(value: unknown): value is TestExecutionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return typeof result.suite === "string"
    && Array.isArray(result.checks)
    && result.checks.every(c => typeof c === "string")
    && Array.isArray(result.failures)
    && result.failures.every(f => typeof f === "string")
    && typeof result.duration_ms === "number";
}
