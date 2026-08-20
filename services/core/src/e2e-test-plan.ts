import { createHash } from "node:crypto";
import type { AgentRuntimeKind } from "@/lib/product/contracts";
import {
  planE2eExecution,
  specificationRequirementCatalog,
  validateTestManifest,
  type E2eExecutionPlan,
  type TestManifest,
} from "@/lib/product/test-manifest";
import {
  CORE_READY_ASSERTIONS,
  CORE_START_ASSERTIONS,
  isSupportedKeyboardKey,
  validateProbeAssertion,
  type ProbeAssertion,
} from "@/lib/product/interaction-script";
import { runCodexPrompt, type CodexPromptRunner } from "./codex-cli";

const E2E_TEST_PLAN_PROVIDER_BUDGET_MS = 360_000;
export const E2E_TEST_PLAN_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["semanticJourney", "coverage"],
  properties: {
    semanticJourney: {
      type: "object",
      additionalProperties: false,
      required: ["startAction", "primaryAction", "completeAction", "primaryProgressKey", "completionProgressKey", "changeTargetId"],
      properties: {
        startAction: semanticActionOutputSchema(),
        primaryAction: semanticActionOutputSchema(),
        completeAction: semanticActionOutputSchema(),
        primaryProgressKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$" },
        completionProgressKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$" },
        changeTargetId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,119}$" },
      },
    },
    coverage: {
      type: "object",
      additionalProperties: false,
      required: ["regressionOperations", "regressionUi", "changeImpact", "assetApplication"],
      properties: Object.fromEntries([
        "regressionOperations", "regressionUi", "changeImpact", "assetApplication",
      ].map(field => [field, {
        type: "array", minItems: 1, maxItems: 500, items: { type: "string", minLength: 1 },
      }])),
    },
  },
} satisfies Readonly<Record<string, unknown>>);

function semanticActionOutputSchema(): Readonly<Record<string, unknown>> {
  return {
    anyOf: [
      semanticActionVariant(
        ["click", "double_click"],
        { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,119}$" },
        { type: "null" },
        { enum: [null, "LEFT", "RIGHT", "MIDDLE"] },
      ),
      semanticActionVariant(
        ["key_tap", "key_hold"],
        { type: "null" },
        { type: "string", pattern: "^(?:KEY_)?(?:[A-Z0-9]|SPACE|ENTER|TAB|ESCAPE|LEFT|RIGHT|UP|DOWN|MINUS|EQUAL)$" },
        { type: "null" },
      ),
      semanticActionVariant(
        ["gamepad_button_tap", "gamepad_button_hold"],
        { type: "null" },
        { type: "null" },
        { enum: ["A", "B", "X", "Y", "BACK", "GUIDE", "START", "LEFT_STICK", "RIGHT_STICK",
          "LEFT_SHOULDER", "RIGHT_SHOULDER", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT"] },
      ),
    ],
  };
}

function semanticActionVariant(
  types: readonly string[],
  targetId: Readonly<Record<string, unknown>>,
  key: Readonly<Record<string, unknown>>,
  button: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "targetId", "key", "button", "durationMs"],
    properties: {
      type: { type: "string", enum: types },
      targetId,
      key,
      button,
      durationMs: { type: ["integer", "null"], minimum: 1, maximum: 300_000 },
    },
  };
}

export type E2ePlanningCoverage = Readonly<{
  regressionOperations: readonly string[];
  regressionUi: readonly string[];
  changeImpact: readonly string[];
  assetApplication: readonly string[];
}>;

export type GeneratedE2eTestPlan = Readonly<{
  testManifest: TestManifest;
  coverage: E2ePlanningCoverage;
  testManifestDigest: string;
  contractDigest: string;
  executionPlan: E2eExecutionPlan;
}>;

export async function generateE2eTestPlan(input: Readonly<{
  context: Readonly<Record<string, unknown>>;
  runtime: AgentRuntimeKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  codexRunner?: CodexPromptRunner;
  testFixture?: boolean;
}>): Promise<GeneratedE2eTestPlan> {
  const specification = record(input.context.approvedSpecification);
  const requirements = specificationRequirementCatalog(specification);
  if (requirements.length < 1) throw new Error("Approved specification has no testable requirements");
  const assets = Array.isArray(input.context.assets) ? input.context.assets.filter(isRecord) : [];
  const materializedAssetKeys = assets
    .filter(asset => asset.materialized === true && typeof asset.assetKey === "string")
    .map(asset => String(asset.assetKey));
  const structuralBaseline = safeBaselinePlan(requirements, materializedAssetKeys);
  if (input.testFixture === true) {
    return finalizePlan(structuralBaseline, input.context);
  }
  const projectBaseline = projectContractPlan(
    input.context.projectTestContract,
    requirements,
    materializedAssetKeys,
  );
  if (projectBaseline) {
    return finalizePlan(projectBaseline, input.context);
  }
  const prompt = testPlanPrompt(input.context, requirements);
  const fetchImpl = input.fetchImpl ?? fetch;
  const codexRunner = input.codexRunner ?? runCodexPrompt;
  let raw: string;
  try {
    if (input.runtime === "CLAUDE_CODE") {
      const response = await fetchImpl(messagesEndpoint(input.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.apiKey}`,
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: 16_000,
          temperature: 0.1,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(E2E_TEST_PLAN_PROVIDER_BUDGET_MS),
      });
      if (!response.ok) throw new Error(`Test Agent returned ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      const content = Array.isArray(body.content) ? body.content as readonly Record<string, unknown>[] : [];
      raw = String(content.find(item => item.type === "text")?.text ?? "");
    } else {
      raw = await codexRunner({
        authJson: input.apiKey,
        model: input.model,
        prompt,
        outputSchema: E2E_TEST_PLAN_OUTPUT_SCHEMA,
        reasoningEffort: "low",
        timeoutMs: E2E_TEST_PLAN_PROVIDER_BUDGET_MS,
      });
    }
  } catch (error) {
    // Transport, authentication, CLI and Provider failures already have their
    // own retry behavior. Repeating a full plan call creates duplicate work.
    const reason = error instanceof Error ? error.message : "Test Agent provider request failed";
    throw new Error(`Test Agent provider request failed: ${reason}`, { cause: error });
  }
  try {
    const parsed = parsePlan(raw, requirements, materializedAssetKeys, regressionChangeTarget(input.context.regressionTrace));
    assertFrozenRequirements(parsed.testManifest, requirements);
    assertPlanningCoverage(parsed.coverage, materializedAssetKeys);
    assertConcreteProjectPlan(parsed.testManifest);
    return finalizePlan(parsed, input.context);
  } catch (error) {
    // A structurally valid generic manifest cannot know a product's semantic
    // Probe target IDs. Running it would turn a planning defect into a false
    // product failure (for example, an invented `primary-control`).
    const reason = error instanceof Error ? error.message : "invalid structured plan";
    throw new Error(`Test Agent returned an invalid project plan: ${reason}`, { cause: error });
  }
}

function assertConcreteProjectPlan(manifest: TestManifest): void {
  const serialized = JSON.stringify(manifest);
  if (/"(?:id|stepId)":"fixture-/i.test(serialized)
    || /"(?:targetId|changeTargetId)":"(?:primary-control|complete-loop|game-viewport)"/i.test(serialized)) {
    throw new Error("plan still contains schema-template controls instead of project semantic targets");
  }
}

function projectContractPlan(
  value: unknown,
  requirements: ReturnType<typeof specificationRequirementCatalog>,
  materializedAssetKeys: readonly string[],
): Readonly<{ testManifest: TestManifest; coverage: E2ePlanningCoverage }> | null {
  if (!validateTestManifest(value)) return null;
  try {
    assertFrozenRequirements(value, requirements);
  } catch {
    return null;
  }
  return Object.freeze({
    testManifest: value,
    coverage: Object.freeze({
      regressionOperations: Object.freeze(["Revalidate the project's semantic core-loop operations"]),
      regressionUi: Object.freeze(["Revalidate clean start, gameplay UI, and completion evidence"]),
      changeImpact: Object.freeze(["Revalidate every frozen requirement against the current build"]),
      assetApplication: Object.freeze(materializedAssetKeys.length > 0
        ? [...materializedAssetKeys]
        : ["No materialized image assets are present in this build"]),
    }),
  });
}

function parsePlan(
  raw: string,
  requirements: ReturnType<typeof specificationRequirementCatalog>,
  materializedAssetKeys: readonly string[],
  verifiedChangeTargetId: string | null = null,
): Readonly<{ testManifest: TestManifest; coverage: E2ePlanningCoverage }> {
  const source = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(source) as Record<string, unknown>;
  let testManifest: unknown = value?.testManifest;
  if (typeof testManifest === "string") {
    try { testManifest = JSON.parse(testManifest); } catch { /* The validator below reports the bounded failure. */ }
  }
  if (!isRecord(value)) throw new Error("response must contain a testManifest and coverage object");
  if (!validateTestManifest(testManifest)) {
    testManifest = manifestFromSemanticJourney(value.semanticJourney, requirements, verifiedChangeTargetId);
  }
  if (!validateTestManifest(testManifest)) {
    testManifest = repairGeneratedManifest(testManifest, requirements);
  }
  if (!validateTestManifest(testManifest)) {
    throw new Error("response does not contain a usable project-semantic core journey");
  }
  const coverage = normalizePlanningCoverage(value.coverage, materializedAssetKeys);
  return Object.freeze({
    testManifest,
    coverage,
  });
}

function manifestFromSemanticJourney(
  value: unknown,
  requirements: ReturnType<typeof specificationRequirementCatalog>,
  verifiedChangeTargetId: string | null = null,
): TestManifest | null {
  if (!isRecord(value) || !isStablePath(value.primaryProgressKey)
    || !isStablePath(value.completionProgressKey) || !isStableId(value.changeTargetId)) return null;
  const primaryProgress = { source: "PROGRESS", key: value.primaryProgressKey, operator: "CHANGED" } as const;
  const completionProgress = { source: "PROGRESS", key: value.completionProgressKey, operator: "CHANGED" } as const;
  const start = semanticEnvelopeAction(value.startAction, "START_SESSION");
  const primary = semanticEnvelopeAction(value.primaryAction, "PRIMARY_ACTION");
  const complete = semanticEnvelopeAction(value.completeAction, "COMPLETE_LOOP");
  if (!start || !primary || !complete) return null;
  return repairGeneratedManifest({
    adaptivePlayer: { successAssertions: [completionProgress] },
    features: [{ interactionScript: { events: [
      start,
      { ...primary, postconditions: [primaryProgress] },
      { type: "checkpoint", role: "PROGRESS", changeTargetId: verifiedChangeTargetId ?? value.changeTargetId, assertions: [primaryProgress] },
      { ...complete, postconditions: [completionProgress] },
      { type: "checkpoint", role: "COMPLETION", assertions: [completionProgress] },
    ] } }],
  }, requirements);
}

function regressionChangeTarget(value: unknown): string | null {
  if (!isRecord(value) || value.schema !== "deviludo.e2e-regression" || !Array.isArray(value.actions)) return null;
  const semanticTargets = value.actions
    .filter(isRecord)
    .map(action => action.targetId)
    .filter(isStableId);
  return semanticTargets.length >= 3 ? semanticTargets[1]! : null;
}

function semanticEnvelopeAction(value: unknown, intent: string): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  return {
    type: value.type,
    intent,
    ...(typeof value.targetId === "string" ? { targetId: value.targetId } : {}),
    ...(typeof value.key === "string" ? { key: value.key } : {}),
    ...(typeof value.button === "string" ? { button: value.button } : {}),
    ...(Number.isInteger(value.durationMs) ? { duration_ms: value.durationMs } : {}),
  };
}

function repairGeneratedManifest(
  value: unknown,
  requirements: ReturnType<typeof specificationRequirementCatalog>,
): TestManifest | null {
  if (!isRecord(value) || !Array.isArray(value.features)) return null;
  const events = value.features.flatMap(feature => {
    if (!isRecord(feature) || !isRecord(feature.interactionScript)
      || !Array.isArray(feature.interactionScript.events)) return [];
    return feature.interactionScript.events.filter(isRecord);
  });
  const assertionCandidates = [
    ...(isRecord(value.adaptivePlayer) && Array.isArray(value.adaptivePlayer.successAssertions)
      ? value.adaptivePlayer.successAssertions : []),
    ...events.flatMap(event => [
      ...(Array.isArray(event.postconditions) ? event.postconditions : []),
      ...(Array.isArray(event.assertions) ? event.assertions : []),
    ]),
  ];
  const progress = assertionCandidates.find((assertion): assertion is ProbeAssertion =>
    validateProbeAssertion(assertion)
      && assertion.source === "PROGRESS"
      && ["CHANGED", "NOT_EQUALS", "GREATER_THAN", "GREATER_THAN_OR_EQUALS"].includes(assertion.operator));
  if (!progress) return null;

  const startCandidate = events.find(event => event.intent === "START_SESSION");
  const primaryCandidate = events.find(event => event.intent === "PRIMARY_ACTION");
  const completeCandidate = [...events].reverse().find(event => event.intent === "COMPLETE_LOOP");
  const assertionFrom = (candidate: unknown, role: string): ProbeAssertion | null => {
    const eventAssertions = isRecord(candidate) && Array.isArray(candidate.postconditions)
      ? candidate.postconditions : [];
    const checkpointAssertions = events.find(event => event.type === "checkpoint" && event.role === role)?.assertions;
    return [...eventAssertions, ...(Array.isArray(checkpointAssertions) ? checkpointAssertions : [])]
      .find((assertion): assertion is ProbeAssertion => validateProbeAssertion(assertion)
        && assertion.source === "PROGRESS"
        && ["CHANGED", "NOT_EQUALS", "GREATER_THAN", "GREATER_THAN_OR_EQUALS"].includes(assertion.operator)) ?? null;
  };
  const primaryProgress = assertionFrom(primaryCandidate, "PROGRESS") ?? progress;
  const completionProgress = assertionFrom(completeCandidate, "COMPLETION") ?? progress;
  const requirementIds = requirements.map(requirement => requirement.requirementId);
  const start = normalizeSemanticAction(startCandidate, "planned-start-session", "START_SESSION", requirementIds, CORE_READY_ASSERTIONS);
  const primary = normalizeSemanticAction(primaryCandidate, "planned-primary-action", "PRIMARY_ACTION", requirementIds, [primaryProgress]);
  const complete = normalizeSemanticAction(completeCandidate, "planned-complete-loop", "COMPLETE_LOOP", requirementIds, [completionProgress]);
  if (!start || !primary || !complete) return null;

  const changeTargetId = events.find(event => event.type === "checkpoint"
    && event.role === "PROGRESS" && isStableId(event.changeTargetId))?.changeTargetId
    ?? semanticActionTarget(primaryCandidate);
  if (!isStableId(changeTargetId)) return null;
  const actions = [start, primary, complete];
  const usesGamepad = actions.some(action => String(action.type).startsWith("gamepad_"));
  const usesKeyboard = actions.some(action => ["key_tap", "key_hold"].includes(String(action.type)));
  const usesPointer = actions.some(action => ["click", "double_click", "drag", "scroll", "text_input"].includes(String(action.type)));
  const inputProfiles = [
    ...(usesKeyboard || usesPointer ? ["KEYBOARD_MOUSE" as const] : []),
    ...(usesGamepad ? ["GAMEPAD" as const] : []),
  ];
  if (inputProfiles.length < 1) return null;
  const allowedActions = [
    ...(usesKeyboard ? ["KEYBOARD" as const] : []),
    ...(usesPointer ? ["POINTER" as const] : []),
    ...(usesGamepad ? ["GAMEPAD" as const] : []),
  ];
  const candidate: unknown = {
    schema: "deviludo.test-manifest",
    inputProfiles,
    primaryInputProfile: inputProfiles[0],
    adaptivePlayer: {
      goal: "Start a clean game and complete one real project core-loop progress boundary",
      requirementIds,
      allowedActions,
      successAssertions: [completionProgress],
      failureAssertions: [{ source: "STATE", key: "fatal-error", operator: "EQUALS", value: true }],
      rolloutTimeoutMs: 240_000,
      maxDecisions: 20,
      seedStrategy: "STABLE_PROJECT_PLATFORM",
    },
    requirements,
    features: [{
      id: "project-core-loop",
      requirementIds,
      category: "core-loop",
      description: "Exercise the current project's clean start, primary action, progress, and completion path",
      verificationMethod: "interactive",
      timeoutMs: 300_000,
      coreJourney: true,
      launchProfile: { type: "FRESH" },
      interactionScript: { events: [
        { type: "checkpoint", id: "project-start", role: "START", visualMode: "STABLE_REPLAY", assertions: CORE_START_ASSERTIONS },
        start,
        { type: "checkpoint", id: "project-ready", role: "READY", visualMode: "STABLE_REPLAY", assertions: CORE_READY_ASSERTIONS },
        primary,
        { type: "checkpoint", id: "project-progress", role: "PROGRESS", visualMode: "DYNAMIC", changeTargetId, assertions: [primaryProgress] },
        complete,
        { type: "checkpoint", id: "project-completion", role: "COMPLETION", visualMode: "STABLE_REPLAY", assertions: [completionProgress] },
      ] },
    }],
  };
  return validateTestManifest(candidate) ? candidate : null;
}

function normalizeSemanticAction(
  value: unknown,
  stepId: string,
  intent: "START_SESSION" | "PRIMARY_ACTION" | "COMPLETE_LOOP",
  requirementIds: readonly string[],
  postconditions: readonly ProbeAssertion[],
): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const base = { stepId, intent, coversRequirementIds: requirementIds, postconditions };
  if (["click", "double_click"].includes(value.type) && isStableId(value.targetId)) {
    return { type: value.type, targetId: value.targetId, ...base,
      ...(["LEFT", "RIGHT", "MIDDLE"].includes(String(value.button)) ? { button: value.button } : {}) };
  }
  if (value.type === "drag" && isStableId(value.fromTargetId) && isStableId(value.toTargetId)) {
    return { type: value.type, fromTargetId: value.fromTargetId, toTargetId: value.toTargetId,
      duration_ms: boundedDuration(value.duration_ms), ...base };
  }
  if (value.type === "scroll" && isStableId(value.targetId) && Number.isInteger(value.deltaY)
    && Number(value.deltaY) !== 0 && Math.abs(Number(value.deltaY)) <= 10_000) {
    return { type: value.type, targetId: value.targetId, deltaY: value.deltaY, ...base };
  }
  if (value.type === "text_input" && isStableId(value.targetId)
    && typeof value.text === "string" && value.text.length >= 1 && value.text.length <= 1_000) {
    return { type: value.type, targetId: value.targetId, text: value.text, ...base };
  }
  if (value.type === "key_tap" && isSupportedKeyboardKey(value.key)) {
    return { type: value.type, key: value.key, ...base };
  }
  if (value.type === "key_hold" && isSupportedKeyboardKey(value.key)) {
    return { type: value.type, key: value.key, duration_ms: boundedDuration(value.duration_ms), ...base };
  }
  if (["gamepad_button_tap", "gamepad_button_hold"].includes(value.type)
    && ["A", "B", "X", "Y", "BACK", "GUIDE", "START", "LEFT_STICK", "RIGHT_STICK",
      "LEFT_SHOULDER", "RIGHT_SHOULDER", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT"].includes(String(value.button))) {
    return { type: value.type, button: value.button,
      ...(value.type === "gamepad_button_hold" ? { duration_ms: boundedDuration(value.duration_ms) } : {}), ...base };
  }
  return null;
}

function semanticActionTarget(value: unknown): unknown {
  if (!isRecord(value)) return null;
  return value.targetId ?? value.toTargetId ?? value.fromTargetId;
}

function boundedDuration(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 300_000 ? Number(value) : 100;
}

function isStableId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,119}$/.test(value);
}

function isStablePath(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value);
}

function normalizePlanningCoverage(value: unknown, materializedAssetKeys: readonly string[]): E2ePlanningCoverage {
  const coverage = isRecord(value) ? value : {};
  const strings = (field: string, fallback: readonly string[]) => {
    const items = Array.isArray(coverage[field])
      ? coverage[field].filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 500)
      : [];
    return Object.freeze(items.length > 0 ? items : [...fallback]);
  };
  const assetApplication = [...strings("assetApplication", materializedAssetKeys.length > 0
    ? materializedAssetKeys : ["No materialized image assets are present in this build"])];
  for (const assetKey of materializedAssetKeys) if (!assetApplication.includes(assetKey)) assetApplication.push(assetKey);
  return Object.freeze({
    regressionOperations: strings("regressionOperations", ["Start, operate, and complete the project core loop"]),
    regressionUi: strings("regressionUi", ["Verify clean menu, active gameplay, progress, and completion UI"]),
    changeImpact: strings("changeImpact", ["Revalidate every frozen requirement in the current iteration"]),
    assetApplication: Object.freeze(assetApplication),
  });
}

function assertFrozenRequirements(manifest: TestManifest, expected: ReturnType<typeof specificationRequirementCatalog>): void {
  const actual = new Map(manifest.requirements.map(requirement => [requirement.requirementId, requirement]));
  if (actual.size !== expected.length || expected.some(requirement => {
    const item = actual.get(requirement.requirementId);
    return !item || item.description !== requirement.description || item.source !== requirement.source;
  })) throw new Error("testManifest does not preserve the frozen approved requirements");
}

function assertPlanningCoverage(coverage: E2ePlanningCoverage, materializedAssetKeys: readonly string[]): void {
  if (coverage.regressionOperations.length < 1 || coverage.regressionUi.length < 1
    || coverage.changeImpact.length < 1 || coverage.assetApplication.length < 1) {
    throw new Error("plan must cover operational regression, UI regression, current change impact, and asset application");
  }
  const coveredAssets = new Set(coverage.assetApplication);
  const missing = materializedAssetKeys.filter(assetKey => !coveredAssets.has(assetKey));
  if (missing.length > 0) throw new Error(`plan does not verify materialized assets: ${missing.slice(0, 20).join(", ")}`);
}

function finalizePlan(
  parsed: Readonly<{ testManifest: TestManifest; coverage: E2ePlanningCoverage }>,
  context: Readonly<Record<string, unknown>>,
): GeneratedE2eTestPlan {
  const regression = record(context.regression);
  const regressionMs = regression.available === true && Number.isSafeInteger(regression.estimatedDurationMs)
    ? Math.max(0, Math.min(300_000, Number(regression.estimatedDurationMs)))
    : 0;
  const executionPlan = planE2eExecution(parsed.testManifest, regressionMs);
  const testManifestDigest = jsonDigest(parsed.testManifest);
  return Object.freeze({
    ...parsed,
    testManifestDigest,
    contractDigest: jsonDigest({ testManifest: parsed.testManifest, runner: "adaptive-real-input" }),
    executionPlan,
  });
}

function safeBaselinePlan(
  requirements: ReturnType<typeof specificationRequirementCatalog>,
  materializedAssetKeys: readonly string[],
): Readonly<{ testManifest: TestManifest; coverage: E2ePlanningCoverage }> {
  const requirementIds = requirements.map(requirement => requirement.requirementId);
  const menu = [
    { source: "STATE", key: "screen_mode", operator: "EQUALS", value: "MENU" },
    { source: "STATE", key: "session_active", operator: "EQUALS", value: false },
    { source: "STATE", key: "gameplay_input_enabled", operator: "EQUALS", value: false },
    { source: "STATE", key: "blocking_layer_count", operator: "EQUALS", value: 0 },
  ];
  const playing = [
    { source: "STATE", key: "screen_mode", operator: "EQUALS", value: "PLAYING" },
    { source: "STATE", key: "session_active", operator: "EQUALS", value: true },
    { source: "STATE", key: "gameplay_input_enabled", operator: "EQUALS", value: true },
    { source: "STATE", key: "blocking_layer_count", operator: "EQUALS", value: 0 },
  ];
  const progress = { source: "PROGRESS", key: "core-loop", operator: "CHANGED" };
  const candidate: unknown = {
    schema: "deviludo.test-manifest",
    inputProfiles: ["KEYBOARD_MOUSE"],
    primaryInputProfile: "KEYBOARD_MOUSE",
    adaptivePlayer: {
      goal: "Start a clean game and complete one real core-loop progress boundary",
      requirementIds,
      allowedActions: ["KEYBOARD", "POINTER"],
      successAssertions: [progress],
      failureAssertions: [{ source: "STATE", key: "fatal-error", operator: "EQUALS", value: true }],
      rolloutTimeoutMs: 240_000,
      maxDecisions: 20,
      seedStrategy: "STABLE_PROJECT_PLATFORM",
    },
    requirements,
    features: [{
      id: "fixture-core-loop",
      requirementIds,
      category: "core-loop",
      description: "Test-only deterministic platform fixture covering the frozen requirement set",
      verificationMethod: "interactive",
      coreJourney: true,
      launchProfile: { type: "FRESH" },
      timeoutMs: 300_000,
      interactionScript: { events: [
        { type: "checkpoint", id: "fixture-start", role: "START", visualMode: "STABLE_REPLAY", assertions: menu },
        { type: "click", stepId: "fixture-start-session", intent: "START_SESSION", targetId: "new-game", coversRequirementIds: requirementIds, postconditions: playing },
        { type: "checkpoint", id: "fixture-ready", role: "READY", visualMode: "STABLE_REPLAY", assertions: playing },
        { type: "click", stepId: "fixture-primary", intent: "PRIMARY_ACTION", targetId: "primary-control", coversRequirementIds: requirementIds, postconditions: [progress] },
        { type: "checkpoint", id: "fixture-progress", role: "PROGRESS", visualMode: "DYNAMIC", changeTargetId: "game-viewport", assertions: [progress] },
        { type: "click", stepId: "fixture-complete", intent: "COMPLETE_LOOP", targetId: "complete-loop", coversRequirementIds: requirementIds, postconditions: [progress] },
        { type: "checkpoint", id: "fixture-complete", role: "COMPLETION", visualMode: "STABLE_REPLAY", assertions: [progress] },
      ] },
    }],
  };
  if (!validateTestManifest(candidate)) throw new Error("Internal E2E test fixture is invalid");
  return Object.freeze({
    testManifest: candidate,
    coverage: Object.freeze({
      regressionOperations: Object.freeze(["Start, operate, and complete the fixture core loop"]),
      regressionUi: Object.freeze(["Clean menu, active game state, and completion state"]),
      changeImpact: Object.freeze(["Exercise every frozen requirement in the current iteration"]),
      assetApplication: Object.freeze(materializedAssetKeys.length > 0
        ? materializedAssetKeys.map(assetKey => assetKey)
        : ["No materialized image assets are present in this test fixture"]),
    }),
  });
}

function testPlanPrompt(
  context: Readonly<Record<string, unknown>>,
  requirements: ReturnType<typeof specificationRequirementCatalog>,
): string {
  return [
    "You are the cross-platform E2E Test Agent. Identify the current project's semantic core-loop controls and progress signal; Development Agent does not own this plan.",
    "Return only one JSON object shaped {semanticJourney,coverage}. No markdown and no testManifest.",
    "Core will freeze requirements and deterministically build the full validated manifest. You own only project-specific semanticJourney values.",
    "semanticJourney needs startAction, primaryAction, completeAction, primaryProgressKey, completionProgressKey, and changeTargetId. Each action needs type plus targetId/key/button/durationMs; set fields unused by that action to null.",
    "Prefer click or double_click with a real Probe control targetId. Use key_tap/key_hold or gamepad_button_tap/gamepad_button_hold only when the game has no Probe control for that action. Do not use coordinates.",
    "primaryProgressKey must be the real Probe PROGRESS key changed immediately by primaryAction. completionProgressKey must be the real Probe PROGRESS key changed by completeAction. They may differ. changeTargetId must be the real visible Probe control/region whose rendered pixels change after primaryAction.",
    "The plan must test the installed/exported game through real OS keyboard, pointer, and declared gamepad input. Probe data is an oracle only and must never invoke actions.",
    "When priorRegressionTrace is present, treat its previously successful semantic targets, actions, and assertions as the strongest evidence. Preserve them unless the current specification explicitly changes that player path.",
    "coverage.regressionOperations lists prior and full-project player operations exercised; coverage.regressionUi lists menus, overlays, HUD/layout and clean-start regressions; coverage.changeImpact lists every risk from the current iteration versus the previous specification; coverage.assetApplication lists every materialized assetKey and the plan must verify it is loaded, visible in the correct game/UI context, correctly cropped/aspected, and not merely present on disk.",
    `Frozen requirements: ${JSON.stringify(requirements)}`,
    `Frozen planning context: ${JSON.stringify(compactPlanningContext(context))}`,
  ].join("\n");
}

function compactPlanningContext(context: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const assets = Array.isArray(context.assets) ? context.assets.filter(isRecord) : [];
  return Object.freeze({
    projectName: context.projectName,
    iterationNumber: context.iterationNumber,
    platform: context.platform,
    concept: context.concept,
    approvedSpecification: context.approvedSpecification,
    previousSpecification: context.previousSpecification,
    revisionNotes: context.revisionNotes,
    regression: context.regression,
    priorRegressionTrace: compactRegressionTrace(context.regressionTrace),
    materializedAssets: Object.freeze(assets
      .filter(asset => asset.materialized === true)
      .map(asset => Object.freeze({
        assetKey: asset.assetKey,
        assetType: asset.assetType,
        description: asset.description,
      }))),
  });
}

function compactRegressionTrace(value: unknown): unknown {
  if (!isRecord(value) || value.schema !== "deviludo.e2e-regression") return null;
  return Object.freeze({
    inputProfile: value.inputProfile,
    goal: value.goal,
    actions: Array.isArray(value.actions) ? Object.freeze(value.actions.slice(0, 50)) : Object.freeze([]),
    successAssertions: Array.isArray(value.successAssertions)
      ? Object.freeze(value.successAssertions.slice(0, 32)) : Object.freeze([]),
  });
}

function messagesEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/messages`.replace(/\/{2,}/g, "/");
  return url.href;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
