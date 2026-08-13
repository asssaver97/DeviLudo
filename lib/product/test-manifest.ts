import {
  CHECKPOINT_ROLES,
  checkpointOutputMarker,
  interactionCheckpointCount,
  interactionHasUserAction,
  validateInteractionScript,
  type InteractionScript,
} from "./interaction-script.js";
import { validateVisualTestSpec, type VisualTestSpec } from "./visual-comparison.js";

export const TEST_MANIFEST_SCHEMA_VERSION = "deviludo.test-manifest.v2" as const;
export const MAX_TEST_REQUIREMENTS = 500 as const;
export const MAX_TEST_FEATURES = 500 as const;
export const MAX_INTERACTIVE_JOURNEYS = 32 as const;
export const MAX_SCREENSHOT_CHECKPOINTS = 20 as const;
export const MAX_JOURNEY_TIMEOUT_MS = 300_000 as const;

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

export type TestManifestRequirement = Readonly<{
  requirementId: string;
  description: string;
}>;

export type TestManifestFeature = Readonly<{
  id: string;
  requirementIds: readonly string[];
  category: FeatureCategory;
  description: string;
  verificationMethod: VerificationMethod;
  gdsTestPath?: string;
  checkNames?: readonly string[];
  interactionScript?: InteractionScript;
  timeoutMs?: number;
  coreJourney?: boolean;
  expectedVisual?: VisualTestSpec;
}>;

export type TestManifest = Readonly<{
  schemaVersion: typeof TEST_MANIFEST_SCHEMA_VERSION;
  requirements: readonly TestManifestRequirement[];
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
  if (manifest.schemaVersion !== TEST_MANIFEST_SCHEMA_VERSION
    || !Array.isArray(manifest.requirements) || manifest.requirements.length < 1 || manifest.requirements.length > MAX_TEST_REQUIREMENTS
    || !Array.isArray(manifest.features) || manifest.features.length < 1 || manifest.features.length > MAX_TEST_FEATURES) return false;

  const requirements = manifest.requirements as unknown[];
  const requirementIds = new Set<string>();
  for (const requirement of requirements) {
    if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) return false;
    const item = requirement as Record<string, unknown>;
    if (typeof item.requirementId !== "string" || !isStableId(item.requirementId)
      || requirementIds.has(item.requirementId)
      || typeof item.description !== "string" || item.description.trim().length < 1 || item.description.length > 2_000) return false;
    requirementIds.add(item.requirementId);
  }

  const featureIds = new Set<string>();
  const checkNames = new Set<string>();
  const automatedCoverage = new Set<string>();
  let interactiveJourneys = 0;
  let checkpointCount = 0;
  let hasCoreJourney = false;
  for (const feature of manifest.features as unknown[]) {
    if (!feature || typeof feature !== "object" || Array.isArray(feature)) return false;
    const item = feature as Record<string, unknown>;
    if (typeof item.id !== "string" || !isStableId(item.id) || featureIds.has(item.id)
      || typeof item.category !== "string" || !FEATURE_CATEGORIES.includes(item.category as FeatureCategory)
      || typeof item.description !== "string" || item.description.trim().length < 1 || item.description.length > 2_000
      || typeof item.verificationMethod !== "string" || !VERIFICATION_METHODS.includes(item.verificationMethod as VerificationMethod)
      || !Array.isArray(item.requirementIds) || item.requirementIds.length < 1
      || item.requirementIds.some(id => typeof id !== "string" || !requirementIds.has(id))) return false;
    featureIds.add(item.id);
    if (item.verificationMethod !== "manual") {
      for (const requirementId of item.requirementIds as string[]) automatedCoverage.add(requirementId);
    }

    if (item.verificationMethod === "unit") {
      if (typeof item.gdsTestPath !== "string" || !isSafeGodotTestPath(item.gdsTestPath)
        || !Array.isArray(item.checkNames) || item.checkNames.length < 1
        || item.checkNames.some(name => typeof name !== "string" || !isStableId(name) || checkNames.has(name))) return false;
      for (const name of item.checkNames as string[]) checkNames.add(name);
    } else if (item.verificationMethod === "interactive") {
      if (!validateInteractionScript(item.interactionScript)
        || !Number.isInteger(item.timeoutMs) || Number(item.timeoutMs) < 1 || Number(item.timeoutMs) > MAX_JOURNEY_TIMEOUT_MS) return false;
      interactiveJourneys += 1;
      checkpointCount += interactionCheckpointCount(item.interactionScript);
      if (item.coreJourney === true && item.category === "core-loop") {
        const checkpoints = item.interactionScript.events.filter(event => event.type === "checkpoint");
        const roles = new Set(checkpoints.map(event => event.role));
        const assertionsComplete = checkpoints.every(event => event.referenceImage
          || event.expectedOutput === checkpointOutputMarker(event.id));
        if (CHECKPOINT_ROLES.every(role => roles.has(role))
          && assertionsComplete
          && interactionHasUserAction(item.interactionScript)) hasCoreJourney = true;
      }
    } else if (item.verificationMethod === "visual") {
      if (!validateVisualTestSpec(item.expectedVisual)) return false;
      checkpointCount += 1;
    }
  }

  return interactiveJourneys >= 1 && interactiveJourneys <= MAX_INTERACTIVE_JOURNEYS
    && checkpointCount >= 3 && checkpointCount <= MAX_SCREENSHOT_CHECKPOINTS
    && hasCoreJourney
    && [...requirementIds].every(requirementId => automatedCoverage.has(requirementId));
}

export function validateTestExecutionResult(value: unknown): value is TestExecutionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return typeof result.suite === "string"
    && Array.isArray(result.checks)
    && result.checks.every(c => typeof c === "string")
    && Array.isArray(result.failures)
    && result.failures.every(f => typeof f === "string")
    && typeof result.duration_ms === "number" && Number.isFinite(result.duration_ms) && result.duration_ms >= 0;
}

export function stableRequirementId(kind: "feature" | "acceptance", index: number, text: string): string {
  let hash = 0x811c9dc5;
  for (const character of `${kind}\0${index}\0${text.normalize("NFKC").trim()}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `req-${kind}-${String(index + 1).padStart(3, "0")}-${hash.toString(16).padStart(8, "0")}`;
}

export function specificationRequirementCatalog(specification: Readonly<Record<string, unknown>>): readonly TestManifestRequirement[] {
  const entries: TestManifestRequirement[] = [];
  for (const [kind, value] of [["feature", specification.coreLoop], ["acceptance", specification.acceptanceCriteria]] as const) {
    if (!Array.isArray(value)) continue;
    value.forEach((item, index) => {
      if (typeof item !== "string" || !item.trim()) return;
      entries.push(Object.freeze({ requirementId: stableRequirementId(kind, index, item), description: item.trim() }));
    });
  }
  return Object.freeze(entries);
}

function isStableId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,119}$/.test(value);
}

function isSafeGodotTestPath(value: string): boolean {
  return /^res:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,219}\.gd$/.test(value)
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value.slice("res://".length));
}
