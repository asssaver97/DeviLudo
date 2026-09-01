import {
  checkpointOutputMarker,
  interactionActionEvents,
  interactionCheckpointCount,
  interactionHasUserAction,
  validateCoreJourneyLifecycle,
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
export const MAX_JOURNEY_TIMEOUT_MS = 900_000 as const;
export const MIN_JOURNEY_EVENT_BUDGET_MS = 1_500 as const;
export const MIN_PLATFORM_E2E_TIMEOUT_MS = 30 * 60_000;
export const MAX_PLATFORM_E2E_TIMEOUT_MS = 90 * 60_000;
export const MIN_ADAPTIVE_ROLLOUT_TIMEOUT_MS = 240_000;
export const MAX_ADAPTIVE_ROLLOUT_TIMEOUT_MS = 300_000;
export const ADAPTIVE_ROLLOUT_COUNT = 3 as const;
export const ADAPTIVE_REQUIRED_SUCCESSES = 2 as const;
const TEST_PLAN_PLACEHOLDERS = new Set(["loop"]);

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
  adaptivePolicyMs: number;
  solidificationMs: number;
  evidenceMs: number;
}>;

export type TestExecutionResult = Readonly<{
  suite: string;
  checks: readonly string[];
  failures: readonly string[];
  duration_ms: number;
}>;

/**
 * Return a bounded, actionable explanation for Runtime tool callers. The
 * boolean validator remains the single authority; this preflight prevents a
 * model from mistaking a correctable payload-shape error for broken E2E
 * infrastructure.
 */
export function testManifestValidationError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "testManifest must be an object";
  }
  const manifest = value as Record<string, unknown>;
  const placeholder = testPlanPlaceholder(value);
  if (placeholder) {
    return `testManifest contains unresolved placeholder ${placeholder}; read the current source and use an exact published Probe key or semantic control ID`;
  }
  if (manifest.schema !== TEST_MANIFEST_SCHEMA) {
    return `testManifest.schema must equal ${TEST_MANIFEST_SCHEMA}`;
  }
  const retired = ["schemaVersion", "version", "suite", "gdsTestPath", "seed", "goalIds", "inputMode", "checkpoints", "globalGates"]
    .filter(field => Object.hasOwn(manifest, field));
  if (retired.length) {
    return `testManifest contains unsupported top-level fields: ${retired.join(", ")}`;
  }
  const requiredTopLevel = ["inputProfiles", "primaryInputProfile", "adaptivePlayer", "requirements", "features"]
    .filter(field => !Object.hasOwn(manifest, field));
  if (requiredTopLevel.length) {
    return `testManifest is missing required fields: ${requiredTopLevel.join(", ")}`;
  }
  if (!Array.isArray(manifest.inputProfiles) || manifest.inputProfiles.length < 1
    || manifest.inputProfiles.length > TEST_INPUT_PROFILES.length
    || manifest.inputProfiles.some(profile => !TEST_INPUT_PROFILES.includes(profile as TestInputProfile))
    || new Set(manifest.inputProfiles).size !== manifest.inputProfiles.length
    || !TEST_INPUT_PROFILES.includes(manifest.primaryInputProfile as TestInputProfile)
    || !manifest.inputProfiles.includes(manifest.primaryInputProfile)) {
    return "inputProfiles must contain unique KEYBOARD_MOUSE and/or GAMEPAD values and include primaryInputProfile";
  }
  if (!manifest.adaptivePlayer || typeof manifest.adaptivePlayer !== "object" || Array.isArray(manifest.adaptivePlayer)) {
    return "adaptivePlayer must be an object";
  }
  const adaptive = manifest.adaptivePlayer as Record<string, unknown>;
  const adaptiveFields = [
    "goal", "requirementIds", "allowedActions", "successAssertions", "failureAssertions",
    "rolloutTimeoutMs", "maxDecisions", "seedStrategy",
  ].filter(field => !Object.hasOwn(adaptive, field));
  if (adaptiveFields.length) {
    return `adaptivePlayer is missing required fields: ${adaptiveFields.join(", ")}`;
  }
  if (typeof adaptive.goal !== "string" || adaptive.goal.trim().length < 10 || adaptive.goal.length > 4_000) {
    return "adaptivePlayer.goal must be a 10-4000 character description";
  }
  if (!Array.isArray(adaptive.requirementIds) || adaptive.requirementIds.length < 1) {
    return "adaptivePlayer.requirementIds must be a non-empty array";
  }
  if (!Array.isArray(adaptive.allowedActions) || adaptive.allowedActions.length < 1
    || adaptive.allowedActions.some(action => !ADAPTIVE_ACTION_GROUPS.includes(action as AdaptiveActionGroup))) {
    return `adaptivePlayer.allowedActions must contain only: ${ADAPTIVE_ACTION_GROUPS.join(", ")}`;
  }
  if (!Array.isArray(adaptive.successAssertions) || adaptive.successAssertions.length < 1
    || !adaptive.successAssertions.every(validateProbeAssertion)
    || !adaptive.successAssertions.some(assertion => assertion && typeof assertion === "object"
      && assertion.source === "PROGRESS"
      && ["CHANGED", "NOT_EQUALS", "GREATER_THAN", "GREATER_THAN_OR_EQUALS"].includes(assertion.operator))) {
    return `adaptivePlayer.successAssertions must contain valid Probe assertions including one progress-changing assertion${retiredProbeScopeHint(adaptive.successAssertions)}`;
  }
  if (!Array.isArray(adaptive.failureAssertions) || adaptive.failureAssertions.length < 1
    || !adaptive.failureAssertions.every(validateProbeAssertion)) {
    return `adaptivePlayer.failureAssertions must contain valid Probe assertions${retiredProbeScopeHint(adaptive.failureAssertions)}`;
  }
  if (adaptive.failureAssertions.every(isFreshStartAssertion)) {
    return "adaptivePlayer.failureAssertions must be false at the required fresh MENU start; use a terminal failure state instead of the normal inactive-session lifecycle fields";
  }
  if (!Number.isInteger(adaptive.rolloutTimeoutMs)
    || Number(adaptive.rolloutTimeoutMs) < MIN_ADAPTIVE_ROLLOUT_TIMEOUT_MS
    || Number(adaptive.rolloutTimeoutMs) > MAX_ADAPTIVE_ROLLOUT_TIMEOUT_MS) {
    return `adaptivePlayer.rolloutTimeoutMs must be an integer from ${MIN_ADAPTIVE_ROLLOUT_TIMEOUT_MS} to ${MAX_ADAPTIVE_ROLLOUT_TIMEOUT_MS}`;
  }
  if (!Number.isInteger(adaptive.maxDecisions) || Number(adaptive.maxDecisions) < 8 || Number(adaptive.maxDecisions) > 40) {
    return "adaptivePlayer.maxDecisions must be an integer from 8 to 40";
  }
  if (adaptive.seedStrategy !== "STABLE_PROJECT_PLATFORM") {
    return "adaptivePlayer.seedStrategy must equal STABLE_PROJECT_PLATFORM";
  }
  if (!Array.isArray(manifest.requirements) || manifest.requirements.length < 1) {
    return "requirements must be a non-empty array";
  }
  for (const [index, requirement] of manifest.requirements.entries()) {
    if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) {
      return `requirements[${index}] must be an object`;
    }
    const item = requirement as Record<string, unknown>;
    const fields = ["requirementId", "description", "source", "verificationClass"]
      .filter(field => !Object.hasOwn(item, field));
    if (fields.length) return `requirements[${index}] is missing required fields: ${fields.join(", ")}`;
    if (typeof item.requirementId !== "string" || !isStableId(item.requirementId)) {
      return `requirements[${index}].requirementId must match ^[a-z0-9][a-z0-9-]{0,119}$`;
    }
    if (typeof item.description !== "string" || item.description.trim().length < 1 || item.description.length > 2_000) {
      return `requirements[${index}].description must contain 1-2000 characters`;
    }
    if (!["CORE_LOOP", "ACCEPTANCE"].includes(String(item.source))) {
      return `requirements[${index}].source must be CORE_LOOP or ACCEPTANCE`;
    }
    if (!["PLAYER_INTERACTION", "SYSTEM"].includes(String(item.verificationClass))) {
      return `requirements[${index}].verificationClass must be PLAYER_INTERACTION or SYSTEM`;
    }
    if (item.verificationClass === "SYSTEM") {
      if (item.source !== "ACCEPTANCE") {
        return `requirements[${index}] CORE_LOOP requirements must use PLAYER_INTERACTION verification`;
      }
      if (!["DATA", "RUNTIME", "NETWORK"].includes(String(item.systemCategory))) {
        return `requirements[${index}].systemCategory must be DATA, RUNTIME, or NETWORK`;
      }
      if (typeof item.exemptionReason !== "string" || item.exemptionReason.trim().length < 10 || item.exemptionReason.length > 1_000) {
        return `requirements[${index}].exemptionReason must contain 10-1000 characters`;
      }
    } else if (item.systemCategory !== undefined || item.exemptionReason !== undefined) {
      return `requirements[${index}] PLAYER_INTERACTION verification must omit systemCategory and exemptionReason`;
    }
  }
  if (!Array.isArray(manifest.features) || manifest.features.length < 1) {
    return "features must be a non-empty array";
  }
  for (const [index, feature] of manifest.features.entries()) {
    if (!feature || typeof feature !== "object" || Array.isArray(feature)) {
      return `features[${index}] must be an object`;
    }
    const item = feature as Record<string, unknown>;
    const fields = ["id", "requirementIds", "category", "description", "verificationMethod"]
      .filter(field => !Object.hasOwn(item, field));
    if (fields.length) return `features[${index}] is missing required fields: ${fields.join(", ")}`;
    if (typeof item.id !== "string" || !isStableId(item.id)) {
      return `features[${index}].id must match ^[a-z0-9][a-z0-9-]{0,119}$`;
    }
    if (!FEATURE_CATEGORIES.includes(item.category as FeatureCategory)) {
      return `features[${index}].category must be one of: ${FEATURE_CATEGORIES.join(", ")}`;
    }
    if (!VERIFICATION_METHODS.includes(item.verificationMethod as VerificationMethod)) {
      return `features[${index}].verificationMethod must be one of: ${VERIFICATION_METHODS.join(", ")}; a core journey uses verificationMethod interactive plus coreJourney true`;
    }
    if (!Array.isArray(item.requirementIds) || item.requirementIds.length < 1) {
      return `features[${index}].requirementIds must be a non-empty array`;
    }
    if (item.verificationMethod === "interactive") {
      const interactiveFields = ["interactionScript", "timeoutMs", "launchProfile"]
        .filter(field => !Object.hasOwn(item, field));
      if (interactiveFields.length) {
        return `features[${index}] interactive verification is missing: ${interactiveFields.join(", ")}`;
      }
      const actionWithoutTransitionOracle = firstActionWithoutTransitionOracle(item.interactionScript);
      if (actionWithoutTransitionOracle) {
        return `features[${index}] action ${actionWithoutTransitionOracle} must include a CHANGED postcondition for the exact STATE, PROGRESS, CONTROL, or SCENE value changed by that input`;
      }
      const bypassAction = firstBypassAction(item.interactionScript);
      if (bypassAction) {
        return `features[${index}] action ${bypassAction.stepId} targets development-only bypass control ${bypassAction.identifier}; deterministic acceptance must reach outcomes through the production player journey`;
      }
      if (!validateInteractionScript(item.interactionScript)) {
        return `features[${index}].interactionScript is invalid; use events ordered START -> START_SESSION -> READY -> PRIMARY_ACTION/FEATURE_ACTION -> PROGRESS -> COMPLETE_LOOP -> COMPLETION`;
      }
      if (!Number.isInteger(item.timeoutMs) || Number(item.timeoutMs) < 1 || Number(item.timeoutMs) > MAX_JOURNEY_TIMEOUT_MS) {
        return `features[${index}].timeoutMs must be an integer from 1 to ${MAX_JOURNEY_TIMEOUT_MS}`;
      }
      const minimumTimeoutMs = minimumJourneyTimeoutMs(item.interactionScript as InteractionScript);
      if (Number(item.timeoutMs) < minimumTimeoutMs) {
        return `features[${index}].timeoutMs must be at least ${minimumTimeoutMs} for ${String((item.interactionScript as InteractionScript).events.length)} interaction events`;
      }
      if (!validLaunchProfile(item.launchProfile)) {
        return `features[${index}].launchProfile must be exactly {"type":"FRESH"} or a valid SCENARIO profile`;
      }
      if (item.coreJourney === true) {
        const actions = interactionActionEvents(item.interactionScript as InteractionScript);
        const postEntryActions = actions.filter(action => !["START_SESSION", "NAVIGATION"].includes(action.intent));
        if (postEntryActions.length < 3 || !actions.some(action => action.intent === "FEATURE_ACTION")) {
          return `features[${index}] coreJourney must contain at least three post-entry actions including PRIMARY_ACTION, FEATURE_ACTION, and COMPLETE_LOOP`;
        }
        if (!validateCoreJourneyLifecycle(item.interactionScript as InteractionScript)) {
          return `features[${index}] coreJourney lifecycle must be START checkpoint -> one START_SESSION action -> READY checkpoint -> PRIMARY_ACTION -> PROGRESS checkpoint -> COMPLETE_LOOP -> COMPLETION checkpoint; START and READY must contain the standard MENU/PLAYING assertions and START_SESSION.postconditions must contain all standard PLAYING assertions`;
        }
      }
    }
    if (item.verificationMethod === "unit") {
      const unitFields = ["gdsTestPath", "checkNames", "timeoutMs"]
        .filter(field => !Object.hasOwn(item, field));
      if (unitFields.length) return `features[${index}] unit verification is missing: ${unitFields.join(", ")}`;
    }
  }
  const requirementItems = manifest.requirements as Record<string, unknown>[];
  const requirementIds = requirementItems.map(item => String(item.requirementId));
  const duplicateRequirementId = requirementIds.find((id, index) => requirementIds.indexOf(id) !== index);
  if (duplicateRequirementId) return `requirements contains duplicate requirementId: ${duplicateRequirementId}`;
  const requirementIdSet = new Set(requirementIds);
  const playerRequirementIds = new Set(requirementItems
    .filter(item => item.verificationClass === "PLAYER_INTERACTION")
    .map(item => String(item.requirementId)));
  const coreRequirementIds = new Set(requirementItems
    .filter(item => item.source === "CORE_LOOP")
    .map(item => String(item.requirementId)));
  const adaptiveRequirementIds = adaptive.requirementIds as unknown[];
  const invalidAdaptiveRequirement = adaptiveRequirementIds.find(id => typeof id !== "string"
    || !requirementIdSet.has(id) || !playerRequirementIds.has(id));
  if (invalidAdaptiveRequirement !== undefined) {
    return `adaptivePlayer.requirementIds contains an unknown or non-player requirement: ${String(invalidAdaptiveRequirement)}`;
  }
  const duplicateAdaptiveRequirement = adaptiveRequirementIds.find((id, index) => adaptiveRequirementIds.indexOf(id) !== index);
  if (duplicateAdaptiveRequirement !== undefined) {
    return `adaptivePlayer.requirementIds contains a duplicate: ${String(duplicateAdaptiveRequirement)}`;
  }
  const missingAdaptiveCore = [...coreRequirementIds].filter(id => !adaptiveRequirementIds.includes(id));
  if (missingAdaptiveCore.length) {
    return `adaptivePlayer.requirementIds is missing CORE_LOOP requirements: ${boundedIdList(missingAdaptiveCore)}`;
  }
  const allowedActions = adaptive.allowedActions as unknown[];
  const duplicateAllowedAction = allowedActions.find((action, index) => allowedActions.indexOf(action) !== index);
  if (duplicateAllowedAction !== undefined) {
    return `adaptivePlayer.allowedActions contains a duplicate: ${String(duplicateAllowedAction)}`;
  }
  if (allowedActions.includes("GAMEPAD") !== manifest.inputProfiles.includes("GAMEPAD")
    || (allowedActions.includes("KEYBOARD") || allowedActions.includes("POINTER")) !== manifest.inputProfiles.includes("KEYBOARD_MOUSE")) {
    return "adaptivePlayer.allowedActions must match inputProfiles exactly: GAMEPAD for GAMEPAD and KEYBOARD and/or POINTER for KEYBOARD_MOUSE";
  }

  const featureIds = new Set<string>();
  const automatedCoverage = new Set<string>();
  const interactiveCoverage = new Set<string>();
  const exercisedInputProfiles = new Set<TestInputProfile>();
  let checkpointCount = 0;
  let coreJourneys = 0;
  for (const [index, feature] of (manifest.features as Record<string, unknown>[]).entries()) {
    const id = String(feature.id);
    if (featureIds.has(id)) return `features contains duplicate id: ${id}`;
    featureIds.add(id);
    const featureRequirementIds = feature.requirementIds as unknown[];
    const invalidFeatureRequirement = featureRequirementIds.find(requirementId => typeof requirementId !== "string"
      || !requirementIdSet.has(requirementId));
    if (invalidFeatureRequirement !== undefined) {
      return `features[${index}].requirementIds contains an unknown requirement: ${String(invalidFeatureRequirement)}`;
    }
    if (feature.verificationMethod !== "manual") {
      for (const requirementId of featureRequirementIds as string[]) automatedCoverage.add(requirementId);
    }
    if (feature.verificationMethod !== "interactive") continue;
    const script = feature.interactionScript as InteractionScript;
    checkpointCount += interactionCheckpointCount(script);
    const actions = interactionActionEvents(script);
    for (const action of actions) {
      exercisedInputProfiles.add(action.type.startsWith("gamepad_") ? "GAMEPAD" : "KEYBOARD_MOUSE");
      for (const requirementId of action.coversRequirementIds) {
        if (!featureRequirementIds.includes(requirementId)) {
          return `features[${index}] action ${action.stepId} covers ${requirementId}, but the feature does not list that requirementId`;
        }
        if (!playerRequirementIds.has(requirementId)) {
          return `features[${index}] action ${action.stepId} covers non-player requirement ${requirementId}`;
        }
        interactiveCoverage.add(requirementId);
      }
    }
    if (feature.coreJourney === true) {
      if (feature.category !== "core-loop" || (feature.launchProfile as { type?: unknown }).type !== "FRESH") {
        return `features[${index}] coreJourney must use category core-loop and launchProfile {"type":"FRESH"}`;
      }
      coreJourneys += 1;
    }
  }
  if (coreJourneys < 1) return "features must contain one interactive FRESH coreJourney with category core-loop";
  if (checkpointCount < 3 || checkpointCount > MAX_SCREENSHOT_CHECKPOINTS) {
    return `interactive features must contain 3-${MAX_SCREENSHOT_CHECKPOINTS} checkpoints in total; received ${checkpointCount}`;
  }
  const missingInputProfiles = (manifest.inputProfiles as TestInputProfile[])
    .filter(profile => !exercisedInputProfiles.has(profile));
  if (missingInputProfiles.length) {
    return `interactive actions do not exercise selected inputProfiles: ${missingInputProfiles.join(", ")}`;
  }
  const missingAutomatedCoverage = requirementIds.filter(id => !automatedCoverage.has(id));
  if (missingAutomatedCoverage.length) {
    return `non-manual features do not cover requirements: ${boundedIdList(missingAutomatedCoverage)}`;
  }
  const missingInteractiveCoverage = [...playerRequirementIds].filter(id => !interactiveCoverage.has(id));
  if (missingInteractiveCoverage.length) {
    return `native interaction actions do not cover player requirements: ${boundedIdList(missingInteractiveCoverage)}`;
  }
  const adaptiveBudgetError = adaptiveCompletionBudgetError(manifest);
  if (adaptiveBudgetError) return adaptiveBudgetError;
  if (!validateTestManifest(value)) {
    return "manifest semantics are invalid: provide one FRESH core-loop journey ordered START -> START_SESSION -> READY -> PRIMARY_ACTION -> PROGRESS -> COMPLETE_LOOP -> COMPLETION; every action needs unique stepId, intent, coversRequirementIds, and postconditions; cover every player requirement with real actions and every requirement with a non-manual feature";
  }
  return null;
}

export function validateTestManifest(value: unknown): value is TestManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (testPlanPlaceholder(value)) return false;
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
        || firstActionWithoutTransitionOracle(item.interactionScript) !== null
        || firstBypassAction(item.interactionScript) !== null
        || !Number.isInteger(item.timeoutMs) || Number(item.timeoutMs) < 1 || Number(item.timeoutMs) > MAX_JOURNEY_TIMEOUT_MS
        || Number(item.timeoutMs) < minimumJourneyTimeoutMs(item.interactionScript as InteractionScript)
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
        const postEntryActions = actions.filter(action => !["START_SESSION", "NAVIGATION"].includes(action.intent));
        if ((item.launchProfile as { type?: unknown } | undefined)?.type === "FRESH"
          && ["START", "READY", "PROGRESS", "COMPLETION"].every(role => roles.has(role as CheckpointRole))
          && checkpoints.some(event => event.visualMode === "STABLE_REPLAY")
          && assertionsComplete
          && intents.has("PRIMARY_ACTION") && intents.has("FEATURE_ACTION") && intents.has("COMPLETE_LOOP")
          && postEntryActions.length >= 3
          && interactionHasUserAction(item.interactionScript)
          && validateCoreJourneyLifecycle(item.interactionScript)) hasCoreJourney = true;
      }
    } else if (item.verificationMethod === "visual") {
      if (!validateVisualTestSpec(item.expectedVisual)) return false;
      checkpointCount += 1;
    }
  }

  return interactiveJourneys >= 1 && interactiveJourneys <= MAX_INTERACTIVE_JOURNEYS
    && checkpointCount >= 3 && checkpointCount <= MAX_SCREENSHOT_CHECKPOINTS
    && hasCoreJourney
    && adaptiveCompletionBudgetError(manifest) === null
    && (manifest.inputProfiles as TestInputProfile[]).every(profile => exercisedInputProfiles.has(profile))
    && [...requirementIds].every(requirementId => automatedCoverage.has(requirementId))
    && [...playerRequirementIds].every(requirementId => interactiveCoverage.has(requirementId));
}

export function minimumJourneyTimeoutMs(script: InteractionScript): number {
  return Math.min(MAX_JOURNEY_TIMEOUT_MS, script.events.length * MIN_JOURNEY_EVENT_BUDGET_MS);
}

/**
 * The adaptive player observes the production UI after each decision. A
 * success condition that the deterministic contract exposes only at its final
 * checkpoint cannot be used as a bounded discovery goal when that journey is
 * already longer than the adaptive decision budget. Requiring it produced an
 * unwinnable 40-decision replay of 18-scene campaigns.
 */
export function adaptiveCompletionBudgetError(manifest: Readonly<Record<string, unknown>>): string | null {
  const adaptive = manifest.adaptivePlayer;
  const features = manifest.features;
  if (!adaptive || typeof adaptive !== "object" || Array.isArray(adaptive)
    || !Array.isArray((adaptive as Record<string, unknown>).successAssertions)
    || !Number.isInteger((adaptive as Record<string, unknown>).maxDecisions)
    || !Array.isArray(features)) return null;
  const successAssertions = (adaptive as Record<string, unknown>).successAssertions as unknown[];
  const maxDecisions = Number((adaptive as Record<string, unknown>).maxDecisions);
  for (const candidate of features) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const feature = candidate as Record<string, unknown>;
    if (feature.coreJourney !== true || !validateInteractionScript(feature.interactionScript)) continue;
    const script = feature.interactionScript as InteractionScript;
    const actions = interactionActionEvents(script);
    if (actions.length <= maxDecisions) continue;
    const completion = script.events.find(event => event.type === "checkpoint" && event.role === "COMPLETION");
    if (!completion || completion.type !== "checkpoint") continue;
    const earlierAssertions = script.events
      .filter(event => event !== completion)
      .flatMap(event => event.type === "checkpoint" ? event.assertions
        : event.type === "wait" ? [] : event.postconditions);
    const completionOnly = successAssertions.find(success => validateProbeAssertion(success)
      && completion.assertions.some(candidateAssertion => sameAssertionReferenceAndOperator(candidateAssertion, success))
      && !earlierAssertions.some(candidateAssertion => sameAssertionReferenceAndOperator(candidateAssertion, success)));
    if (completionOnly && validateProbeAssertion(completionOnly)) {
      const reference = completionOnly.key ?? completionOnly.targetId ?? completionOnly.source;
      return `adaptivePlayer success assertion ${reference} is evidenced only at COMPLETION after ${actions.length} deterministic actions, beyond maxDecisions ${maxDecisions}; use a bounded representative-loop assertion instead of the terminal campaign outcome`;
    }
  }
  return null;
}

function sameAssertionReferenceAndOperator(left: ProbeAssertion, right: ProbeAssertion): boolean {
  return left.source === right.source && left.key === right.key
    && left.targetId === right.targetId && left.property === right.property
    && left.operator === right.operator && left.value === right.value;
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
  // The rollout timeout measures active gameplay and intentionally pauses
  // while the visual policy is thinking. Reserve a separate, equally bounded
  // wall-clock allowance so valid exploration is not killed by the platform
  // deadline merely because inference is slower than native input.
  const adaptivePolicyMs = adaptiveMs;
  const solidificationMs = 2 * manifest.adaptivePlayer.rolloutTimeoutMs;
  const raw = Math.ceil(1.25 * (setupMs + unitMs + deterministicMs + visualMs
    + currentRegressionMs + adaptiveMs + adaptivePolicyMs + solidificationMs + evidenceMs));
  const plannedTimeoutMs = Math.ceil(Math.max(MIN_PLATFORM_E2E_TIMEOUT_MS, raw) / 60_000) * 60_000;
  if (plannedTimeoutMs > MAX_PLATFORM_E2E_TIMEOUT_MS) {
    throw Object.assign(new Error("E2E_PLAN_EXCEEDS_LIMIT"), { code: "E2E_PLAN_EXCEEDS_LIMIT", plannedTimeoutMs });
  }
  return Object.freeze({
    plannedTimeoutMs, setupMs, unitMs, deterministicMs, visualMs, currentRegressionMs,
    adaptiveMs, adaptivePolicyMs, solidificationMs, evidenceMs,
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
    || adaptive.failureAssertions.every(isFreshStartAssertion)
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

function isFreshStartAssertion(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const assertion = value as Record<string, unknown>;
  if (assertion.source !== "STATE" || assertion.operator !== "EQUALS") return false;
  return (assertion.key === "screen_mode" && assertion.value === "MENU")
    || (assertion.key === "session_active" && assertion.value === false)
    || (assertion.key === "gameplay_input_enabled" && assertion.value === false)
    || (assertion.key === "blocking_layer_count" && assertion.value === 0);
}

function testPlanPlaceholder(value: unknown, path = "testManifest"): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = testPlanPlaceholder(item, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const itemPath = `${path}.${key}`;
    if (["requirementId", "targetId", "changeTargetId", "fromTargetId", "toTargetId", "key"].includes(key)
      && typeof item === "string" && TEST_PLAN_PLACEHOLDERS.has(item)) {
      return `${itemPath}=${JSON.stringify(item)}`;
    }
    const found = testPlanPlaceholder(item, itemPath);
    if (found) return found;
  }
  return null;
}

/**
 * The real-window runner requires every post-session input to prove its own
 * transition. Equality-only assertions can already be true before the input,
 * which turns a malformed plan into a false product failure. START_SESSION is
 * the sole exception because the core lifecycle fixes its before/after states.
 */
function firstActionWithoutTransitionOracle(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const action = event as Record<string, unknown>;
    if (action.intent === undefined || action.intent === "START_SESSION") continue;
    if (!Array.isArray(action.postconditions)
      || !action.postconditions.some(assertion => assertion && typeof assertion === "object"
        && !Array.isArray(assertion) && (assertion as { operator?: unknown }).operator === "CHANGED")) {
      return typeof action.stepId === "string" ? action.stepId : "<missing-stepId>";
    }
  }
  return null;
}

/**
 * Acceptance evidence must traverse the same production path available to a
 * player. A development shortcut can make every Probe assertion true while
 * skipping the content and progression those assertions are meant to prove.
 * Keep the check deliberately narrow to explicit bypass identifiers so normal
 * in-world controls such as a network test or a playable demo remain valid.
 */
function firstBypassAction(value: unknown): Readonly<{ stepId: string; identifier: string }> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events)) return null;
  const bypass = /(?:^|-)(?:debug|cheat)(?:-|$)|(?:^|-)skip-(?:to|ahead|ending|level|chapter)(?:-|$)|(?:^|-)(?:force-win|unlock-all|final-demo|ending-demo|demo-ending)(?:-|$)/;
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const action = event as Record<string, unknown>;
    if (action.intent === undefined) continue;
    for (const identifier of [action.targetId, action.stepId]) {
      if (typeof identifier === "string" && bypass.test(identifier)) {
        return Object.freeze({
          stepId: typeof action.stepId === "string" ? action.stepId : "<missing-stepId>",
          identifier,
        });
      }
    }
  }
  return null;
}

function isSafeGodotTestPath(value: string): boolean {
  return /^res:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,219}\.gd$/.test(value)
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value.slice("res://".length));
}

function retiredProbeScopeHint(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const index = value.findIndex(assertion => assertion && typeof assertion === "object"
    && !Array.isArray(assertion)
    && Object.hasOwn(assertion, "scope")
    && !Object.hasOwn(assertion, "source"));
  return index < 0 ? "" : `; assertion ${index} uses retired scope, use source`;
}

function boundedIdList(ids: readonly string[]): string {
  const shown = ids.slice(0, 12).join(", ");
  return ids.length <= 12 ? shown : `${shown} (+${ids.length - 12} more)`;
}
