import {
  checkpointOutputMarker,
  interactionActionEvents,
  interactionCheckpointCount,
  interactionHasUserAction,
  validateInteractionScript,
  type CheckpointRole,
  type InteractionScript,
  type ProbeAssertion,
} from "./interaction-script.js";
import { validateProbeAssertion } from "./interaction-script.js";
import { validateVisualTestSpec, type VisualTestSpec } from "./visual-comparison.js";

export const TEST_MANIFEST_SCHEMA = "deviludo.test-manifest" as const;
export const MAX_TEST_REQUIREMENTS = 500 as const;
export const MAX_TEST_FEATURES = 500 as const;
export const MAX_INTERACTIVE_JOURNEYS = 32 as const;
export const MAX_SCREENSHOT_CHECKPOINTS = 64 as const;
export const MAX_JOURNEY_TIMEOUT_MS = 300_000 as const;
export const MIN_PLATFORM_E2E_TIMEOUT_MS = 30 * 60_000;
export const MAX_PLATFORM_E2E_TIMEOUT_MS = 90 * 60_000;
export const MIN_ADAPTIVE_ROLLOUT_TIMEOUT_MS = 60_000;
export const MAX_ADAPTIVE_ROLLOUT_TIMEOUT_MS = 300_000;
export const ADAPTIVE_ROLLOUT_COUNT = 3 as const;
export const ADAPTIVE_REQUIRED_SUCCESSES = 2 as const;

export const TEST_INPUT_PROFILES = ["KEYBOARD_MOUSE", "GAMEPAD"] as const;
export type TestInputProfile = typeof TEST_INPUT_PROFILES[number];
export const ADAPTIVE_ACTION_GROUPS = ["KEYBOARD", "POINTER", "GAMEPAD"] as const;
export type AdaptiveActionGroup = typeof ADAPTIVE_ACTION_GROUPS[number];

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
  source: "CORE_LOOP" | "ACCEPTANCE";
  verificationClass: "PLAYER_INTERACTION" | "SYSTEM";
  systemCategory?: "DATA" | "RUNTIME" | "NETWORK";
  exemptionReason?: string;
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
  launchProfile?: Readonly<{ type: "FRESH" } | { type: "SCENARIO"; scenarioId: string }>;
  expectedVisual?: VisualTestSpec;
}>;

export type AdaptivePlayerContract = Readonly<{
  goal: string;
  requirementIds: readonly string[];
  allowedActions: readonly AdaptiveActionGroup[];
  successAssertions: readonly ProbeAssertion[];
  failureAssertions: readonly ProbeAssertion[];
  rolloutTimeoutMs: number;
  maxDecisions: number;
  seedStrategy: "STABLE_PROJECT_PLATFORM";
}>;

export type TestManifest = Readonly<{
  schema: typeof TEST_MANIFEST_SCHEMA;
  inputProfiles: readonly TestInputProfile[];
  primaryInputProfile: TestInputProfile;
  adaptivePlayer: AdaptivePlayerContract;
  requirements: readonly TestManifestRequirement[];
  features: readonly TestManifestFeature[];
}>;

export type E2eExecutionPlan = Readonly<{
  plannedTimeoutMs: number;
  setupMs: number;
  unitMs: number;
  deterministicMs: number;
  visualMs: number;
  currentRegressionMs: number;
  adaptiveMs: number;
  solidificationMs: number;
  evidenceMs: number;
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
  if (manifest.schema !== TEST_MANIFEST_SCHEMA || Object.hasOwn(manifest, "schemaVersion") || Object.hasOwn(manifest, "version")
    || Object.hasOwn(manifest, "suite") || Object.hasOwn(manifest, "gdsTestPath")
    || !Array.isArray(manifest.requirements) || manifest.requirements.length < 1 || manifest.requirements.length > MAX_TEST_REQUIREMENTS
    || !Array.isArray(manifest.features) || manifest.features.length < 1 || manifest.features.length > MAX_TEST_FEATURES) return false;

  if (!Array.isArray(manifest.inputProfiles) || manifest.inputProfiles.length < 1 || manifest.inputProfiles.length > TEST_INPUT_PROFILES.length
    || manifest.inputProfiles.some(profile => !TEST_INPUT_PROFILES.includes(profile as TestInputProfile))
    || new Set(manifest.inputProfiles).size !== manifest.inputProfiles.length
    || !TEST_INPUT_PROFILES.includes(manifest.primaryInputProfile as TestInputProfile)
    || !manifest.inputProfiles.includes(manifest.primaryInputProfile)) return false;

  const requirements = manifest.requirements as unknown[];
  const requirementIds = new Set<string>();
  const playerRequirementIds = new Set<string>();
  const coreRequirementIds = new Set<string>();
  for (const requirement of requirements) {
    if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) return false;
    const item = requirement as Record<string, unknown>;
    if (typeof item.requirementId !== "string" || !isStableId(item.requirementId)
      || requirementIds.has(item.requirementId)
      || typeof item.description !== "string" || item.description.trim().length < 1 || item.description.length > 2_000
      || !["CORE_LOOP", "ACCEPTANCE"].includes(String(item.source))
      || !["PLAYER_INTERACTION", "SYSTEM"].includes(String(item.verificationClass))) return false;
    if (item.source === "CORE_LOOP" && item.verificationClass !== "PLAYER_INTERACTION") return false;
    if (item.verificationClass === "SYSTEM") {
      if (item.source !== "ACCEPTANCE"
        || !["DATA", "RUNTIME", "NETWORK"].includes(String(item.systemCategory))
        || typeof item.exemptionReason !== "string" || item.exemptionReason.trim().length < 10 || item.exemptionReason.length > 1_000) return false;
    } else if (item.systemCategory !== undefined || item.exemptionReason !== undefined) return false;
    requirementIds.add(item.requirementId);
    if (item.verificationClass === "PLAYER_INTERACTION") playerRequirementIds.add(item.requirementId);
    if (item.source === "CORE_LOOP") coreRequirementIds.add(item.requirementId);
  }

  if (!validateAdaptivePlayer(manifest.adaptivePlayer, requirementIds, playerRequirementIds, coreRequirementIds, manifest.inputProfiles as TestInputProfile[])) return false;

  const featureIds = new Set<string>();
  const checkNames = new Set<string>();
  const automatedCoverage = new Set<string>();
  let interactiveJourneys = 0;
  let checkpointCount = 0;
  let hasCoreJourney = false;
  const interactiveCoverage = new Set<string>();
  const exercisedInputProfiles = new Set<TestInputProfile>();
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
        || item.checkNames.some(name => typeof name !== "string" || !isStableId(name) || checkNames.has(name))
        || !Number.isInteger(item.timeoutMs) || Number(item.timeoutMs) < 1 || Number(item.timeoutMs) > MAX_JOURNEY_TIMEOUT_MS) return false;
      for (const name of item.checkNames as string[]) checkNames.add(name);
    } else if (item.verificationMethod === "interactive") {
      if (!validateInteractionScript(item.interactionScript)
        || !Number.isInteger(item.timeoutMs) || Number(item.timeoutMs) < 1 || Number(item.timeoutMs) > MAX_JOURNEY_TIMEOUT_MS
        || !validLaunchProfile(item.launchProfile)) return false;
      interactiveJourneys += 1;
      checkpointCount += interactionCheckpointCount(item.interactionScript);
      const actions = interactionActionEvents(item.interactionScript);
      for (const action of actions) {
        exercisedInputProfiles.add(action.type.startsWith("gamepad_") ? "GAMEPAD" : "KEYBOARD_MOUSE");
      }
      const journeyCheckpoints = item.interactionScript.events.filter(event => event.type === "checkpoint");
      if ((item.launchProfile as { type?: unknown } | undefined)?.type === "SCENARIO"
        && !journeyCheckpoints.some(event => event.visualMode === "STABLE_REPLAY")) return false;
      for (const action of actions) {
        for (const requirementId of action.coversRequirementIds) {
          if (!item.requirementIds.includes(requirementId) || !playerRequirementIds.has(requirementId)) return false;
          interactiveCoverage.add(requirementId);
        }
      }
      if (item.coreJourney === true && item.category === "core-loop") {
        const checkpoints = journeyCheckpoints;
        const roles = new Set(checkpoints.map(event => event.role));
        const assertionsComplete = checkpoints.every(event => event.assertions.length > 0
          && (event.referenceImage || event.expectedOutput === undefined || event.expectedOutput === checkpointOutputMarker(event.id)));
        const intents = new Set(actions.map(action => action.intent));
        if ((item.launchProfile as { type?: unknown } | undefined)?.type === "FRESH"
          && ["START", "READY", "PROGRESS", "COMPLETION"].every(role => roles.has(role as CheckpointRole))
          && checkpoints.some(event => event.visualMode === "STABLE_REPLAY")
          && assertionsComplete
          && intents.has("PRIMARY_ACTION") && intents.has("COMPLETE_LOOP")
          && actions.length >= 2
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
    && (manifest.inputProfiles as TestInputProfile[]).every(profile => exercisedInputProfiles.has(profile))
    && [...requirementIds].every(requirementId => automatedCoverage.has(requirementId))
    && [...playerRequirementIds].every(requirementId => interactiveCoverage.has(requirementId));
}

export function planE2eExecution(manifest: TestManifest, currentRegressionMs = 0): E2eExecutionPlan {
  if (!validateTestManifest(manifest)) throw new Error("E2E test manifest is invalid");
  if (!Number.isSafeInteger(currentRegressionMs) || currentRegressionMs < 0 || currentRegressionMs > MAX_ADAPTIVE_ROLLOUT_TIMEOUT_MS) {
    throw new Error("E2E current regression estimate is invalid");
  }
  const setupMs = 3 * 60_000;
  const evidenceMs = 3 * 60_000;
  const unitByPath = new Map<string, number>();
  for (const feature of manifest.features.filter(item => item.verificationMethod === "unit")) {
    unitByPath.set(feature.gdsTestPath!, Math.max(unitByPath.get(feature.gdsTestPath!) ?? 0, feature.timeoutMs!));
  }
  const unitMs = [...unitByPath.values()].reduce((sum, value) => sum + value, 0);
  const deterministicMs = manifest.features.filter(item => item.verificationMethod === "interactive")
    .reduce((sum, item) => sum + item.timeoutMs!, 0);
  const visualMs = manifest.features.filter(item => item.verificationMethod === "visual")
    .reduce((sum, item) => sum + (item.expectedVisual?.captureDelay ?? 1_000) + 30_000, 0);
  const adaptiveMs = ADAPTIVE_ROLLOUT_COUNT * manifest.adaptivePlayer.rolloutTimeoutMs;
  const solidificationMs = 2 * manifest.adaptivePlayer.rolloutTimeoutMs;
  const raw = Math.ceil(1.25 * (setupMs + unitMs + deterministicMs + visualMs
    + currentRegressionMs + adaptiveMs + solidificationMs + evidenceMs));
  const plannedTimeoutMs = Math.ceil(Math.max(MIN_PLATFORM_E2E_TIMEOUT_MS, raw) / 60_000) * 60_000;
  if (plannedTimeoutMs > MAX_PLATFORM_E2E_TIMEOUT_MS) {
    throw Object.assign(new Error("E2E_PLAN_EXCEEDS_LIMIT"), { code: "E2E_PLAN_EXCEEDS_LIMIT", plannedTimeoutMs });
  }
  return Object.freeze({
    plannedTimeoutMs, setupMs, unitMs, deterministicMs, visualMs, currentRegressionMs,
    adaptiveMs, solidificationMs, evidenceMs,
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
      entries.push(Object.freeze({
        requirementId: stableRequirementId(kind, index, item),
        description: item.trim(),
        source: kind === "feature" ? "CORE_LOOP" : "ACCEPTANCE",
        verificationClass: "PLAYER_INTERACTION",
      }));
    });
  }
  return Object.freeze(entries);
}

function validLaunchProfile(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  if (profile.type === "FRESH") return Object.keys(profile).length === 1;
  return profile.type === "SCENARIO" && typeof profile.scenarioId === "string"
    && /^[a-z0-9][a-z0-9-]{0,119}$/.test(profile.scenarioId);
}

function validateAdaptivePlayer(
  value: unknown,
  requirementIds: ReadonlySet<string>,
  playerRequirementIds: ReadonlySet<string>,
  coreRequirementIds: ReadonlySet<string>,
  inputProfiles: readonly TestInputProfile[],
): value is AdaptivePlayerContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const adaptive = value as Record<string, unknown>;
  if (!Array.isArray(adaptive.requirementIds) || !Array.isArray(adaptive.allowedActions)) return false;
  const adaptiveRequirementIds = adaptive.requirementIds;
  const adaptiveAllowedActions = adaptive.allowedActions;
  if (typeof adaptive.goal !== "string" || adaptive.goal.trim().length < 10 || adaptive.goal.length > 4_000
    || adaptiveRequirementIds.length < 1
    || adaptiveRequirementIds.some(id => typeof id !== "string" || !requirementIds.has(id) || !playerRequirementIds.has(id))
    || new Set(adaptiveRequirementIds).size !== adaptiveRequirementIds.length
    || [...coreRequirementIds].some(id => !adaptiveRequirementIds.includes(id))
    || adaptiveAllowedActions.length < 1
    || adaptiveAllowedActions.some(action => !ADAPTIVE_ACTION_GROUPS.includes(action as AdaptiveActionGroup))
    || new Set(adaptiveAllowedActions).size !== adaptiveAllowedActions.length
    || !Array.isArray(adaptive.successAssertions) || adaptive.successAssertions.length < 1 || adaptive.successAssertions.length > 32
    || !adaptive.successAssertions.every(validateProbeAssertion)
    || !adaptive.successAssertions.some(assertion => assertion && typeof assertion === "object"
      && assertion.source === "PROGRESS"
      && ["CHANGED", "NOT_EQUALS", "GREATER_THAN", "GREATER_THAN_OR_EQUALS"].includes(assertion.operator))
    || !Array.isArray(adaptive.failureAssertions) || adaptive.failureAssertions.length < 1 || adaptive.failureAssertions.length > 32
    || !adaptive.failureAssertions.every(validateProbeAssertion)
    || !Number.isInteger(adaptive.rolloutTimeoutMs)
    || Number(adaptive.rolloutTimeoutMs) < MIN_ADAPTIVE_ROLLOUT_TIMEOUT_MS
    || Number(adaptive.rolloutTimeoutMs) > MAX_ADAPTIVE_ROLLOUT_TIMEOUT_MS
    || !Number.isInteger(adaptive.maxDecisions) || Number(adaptive.maxDecisions) < 8 || Number(adaptive.maxDecisions) > 40
    || adaptive.seedStrategy !== "STABLE_PROJECT_PLATFORM") return false;
  if (adaptiveAllowedActions.includes("GAMEPAD") !== inputProfiles.includes("GAMEPAD")) return false;
  if ((adaptiveAllowedActions.includes("KEYBOARD") || adaptiveAllowedActions.includes("POINTER")) !== inputProfiles.includes("KEYBOARD_MOUSE")) return false;
  return true;
}

function isStableId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,119}$/.test(value);
}

function isSafeGodotTestPath(value: string): boolean {
  return /^res:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,219}\.gd$/.test(value)
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value.slice("res://".length));
}
