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
import {
  validateAssetUsageTargets,
  type AssetUsageCheckpointRole,
} from "@/lib/product/asset-manifest";
import { runCodexPrompt, type CodexPromptRunner } from "./codex-cli";

const E2E_TEST_PLAN_PROVIDER_BUDGET_MS = 360_000;
const E2E_TEST_PLAN_CORRECTION_BUDGET_MS = 180_000;
export const E2E_TEST_PLAN_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["semanticJourney", "coverage"],
  properties: {
    semanticJourney: {
      type: "object",
      additionalProperties: false,
      required: ["startAction", "startRequirementIds", "coreActions"],
      properties: {
        startAction: semanticActionOutputSchema(),
        startRequirementIds: {
          type: "array", maxItems: 500,
          items: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,119}$" },
        },
        coreActions: {
          type: "array", minItems: 3, maxItems: 32,
          items: semanticCoreActionOutputSchema(),
        },
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

function semanticCoreActionOutputSchema(): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "progressKey", "changeTargetId", "coversRequirementIds"],
    properties: {
      action: semanticActionOutputSchema(),
      progressKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$" },
      changeTargetId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,119}$" },
      coversRequirementIds: {
        type: "array", minItems: 1, maxItems: 500,
        items: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,119}$" },
      },
    },
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

export type PlannedAssetPlacement = Readonly<{
  assetKey: string;
  targetId: string;
  checkpointRole: AssetUsageCheckpointRole;
  expectedResourcePath: string;
  expectedSha256: string | null;
}>;

export type AssetPlacementPlan = Readonly<{
  schema: "deviludo.asset-placement-plan";
  plannedAssetKeys: readonly string[];
  placements: readonly PlannedAssetPlacement[];
  unmappedAssetKeys: readonly string[];
}>;

export type GeneratedE2eTestPlan = Readonly<{
  testManifest: TestManifest;
  coverage: E2ePlanningCoverage;
  assetPlacementPlan: AssetPlacementPlan;
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
  const assetPlacementPlan = buildAssetPlacementPlan(input.context);
  const materializedAssetKeys = assetPlacementPlan.plannedAssetKeys;
  const structuralBaseline = safeBaselinePlan(requirements, materializedAssetKeys);
  if (input.testFixture === true) {
    return finalizePlan(structuralBaseline, input.context, assetPlacementPlan);
  }
  const projectBaseline = projectContractPlan(
    input.context.projectTestContract,
    requirements,
    materializedAssetKeys,
  );
  if (projectBaseline) {
    return finalizePlan(projectBaseline, input.context, assetPlacementPlan);
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
        baseUrl: input.baseUrl,
        credential: input.apiKey,
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
  const verifiedChangeTargetId = regressionChangeTarget(input.context.regressionTrace);
  let parsed: ReturnType<typeof parsePlan>;
  try {
    parsed = parsePlan(raw, requirements, materializedAssetKeys, verifiedChangeTargetId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid structured plan";
    if (input.runtime !== "CODEX_CLI" || !reason.includes("does not cover ")) {
      throw new Error(`Test Agent returned an invalid project plan: ${reason}`, { cause: error });
    }
    try {
      raw = await codexRunner({
        baseUrl: input.baseUrl,
        credential: input.apiKey,
        model: input.model,
        prompt: testPlanCorrectionPrompt(prompt, raw, reason, requirements),
        outputSchema: E2E_TEST_PLAN_OUTPUT_SCHEMA,
        reasoningEffort: "low",
        timeoutMs: E2E_TEST_PLAN_CORRECTION_BUDGET_MS,
      });
      parsed = parsePlan(raw, requirements, materializedAssetKeys, verifiedChangeTargetId);
    } catch (correctionError) {
      const correctionReason = correctionError instanceof Error
        ? correctionError.message : "Test Agent plan correction failed";
      throw new Error(`Test Agent returned an invalid project plan after one correction: ${correctionReason}`, {
        cause: correctionError,
      });
    }
  }
  try {
    assertFrozenRequirements(parsed.testManifest, requirements);
    assertPlanningCoverage(parsed.coverage, materializedAssetKeys);
    assertConcreteProjectPlan(parsed.testManifest);
    return finalizePlan(parsed, input.context, assetPlacementPlan);
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
  const coreJourney = manifest.features.find(feature => feature.coreJourney === true
    && feature.category === "core-loop" && feature.verificationMethod === "interactive");
  const coreActions = coreJourney?.interactionScript?.events.filter(event => event.type !== "checkpoint" && event.type !== "wait") ?? [];
  const postEntryActions = coreActions.filter(event => event.intent !== "START_SESSION" && event.intent !== "NAVIGATION");
  if (postEntryActions.length < 3 || !postEntryActions.some(event => event.intent === "FEATURE_ACTION")) {
    throw new Error("plan collapses the playable core loop into setup and completion without enough real intermediate operations");
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
    assertConcreteProjectPlan(value);
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
  let semanticFailure: string | null = null;
  if (!validateTestManifest(testManifest)) {
    testManifest = manifestFromSemanticJourney(value.semanticJourney, requirements, verifiedChangeTargetId);
    if (!validateTestManifest(testManifest)) {
      semanticFailure = explainSemanticJourneyFailure(value.semanticJourney, requirements, verifiedChangeTargetId);
    }
  }
  if (!validateTestManifest(testManifest)) {
    testManifest = repairGeneratedManifest(testManifest, requirements);
  }
  if (!validateTestManifest(testManifest)) {
    throw new Error(`response does not contain a usable project-semantic core journey: ${semanticFailure ?? "manifest validation failed"}`);
  }
  const coverage = normalizePlanningCoverage(value.coverage, materializedAssetKeys);
  return Object.freeze({
    testManifest,
    coverage,
  });
}

function explainSemanticJourneyFailure(
  value: unknown,
  requirements: ReturnType<typeof specificationRequirementCatalog>,
  verifiedChangeTargetId: string | null,
): string {
  if (!isRecord(value)) return "semanticJourney is missing or is not an object";
  if (!Array.isArray(value.startRequirementIds)) return "startRequirementIds is not an array";
  if (!Array.isArray(value.coreActions)) return "coreActions is not an array";
  if (value.coreActions.length < 3 || value.coreActions.length > 32) {
    return `coreActions has ${value.coreActions.length} items; expected 3..32`;
  }
  const requirementIds = requirements.map(requirement => requirement.requirementId);
  const requirementSet = new Set(requirementIds);
  const startFailure = requirementIdFailure(value.startRequirementIds, requirementSet, true);
  if (startFailure) return `startRequirementIds ${startFailure}`;
  if (!semanticEnvelopeAction(value.startAction, "START_SESSION")) return "startAction is not executable";
  for (const [index, item] of value.coreActions.entries()) {
    if (!isRecord(item)) return `coreActions[${index}] is not an object`;
    if (!isStablePath(item.progressKey)) return `coreActions[${index}].progressKey is invalid`;
    if (!isStableId(item.changeTargetId) && !(index === 0 && verifiedChangeTargetId)) {
      return `coreActions[${index}].changeTargetId is invalid`;
    }
    const requirementFailure = requirementIdFailure(item.coversRequirementIds, requirementSet, false);
    if (requirementFailure) return `coreActions[${index}].coversRequirementIds ${requirementFailure}`;
    const intent = index === 0 ? "PRIMARY_ACTION"
      : index === value.coreActions.length - 1 ? "COMPLETE_LOOP" : "FEATURE_ACTION";
    if (!semanticEnvelopeAction(item.action, intent)) return `coreActions[${index}].action is not executable`;
  }
  const covered = new Set([
    ...(value.startRequirementIds as readonly string[]),
    ...value.coreActions.flatMap(item => isRecord(item) && Array.isArray(item.coversRequirementIds)
      ? item.coversRequirementIds.filter((id): id is string => typeof id === "string") : []),
  ]);
  const missing = requirementIds.filter(requirementId => !covered.has(requirementId));
  if (missing.length > 0) return `does not cover ${missing.length} frozen requirement(s): ${missing.slice(0, 20).join(", ")}`;
  return "the deterministically assembled test manifest violates the E2E contract";
}

function requirementIdFailure(
  value: unknown,
  allowed: ReadonlySet<string>,
  allowEmpty: boolean,
): string | null {
  if (!Array.isArray(value)) return "is not an array";
  if (!allowEmpty && value.length < 1) return "must not be empty";
  if (value.length > 500) return `has ${value.length} items; maximum is 500`;
  const nonStrings = value.filter(item => typeof item !== "string").length;
  if (nonStrings > 0) return `contains ${nonStrings} non-string item(s)`;
  const ids = value as readonly string[];
  const unknown = [...new Set(ids.filter(item => !allowed.has(item)))];
  if (unknown.length > 0) return `contains unknown ID(s): ${unknown.slice(0, 20).join(", ")}`;
  if (new Set(ids).size !== ids.length) return "contains duplicate IDs";
  return null;
}

function manifestFromSemanticJourney(
  value: unknown,
  requirements: ReturnType<typeof specificationRequirementCatalog>,
  verifiedChangeTargetId: string | null = null,
): TestManifest | null {
  if (!isRecord(value) || !Array.isArray(value.startRequirementIds)
    || !Array.isArray(value.coreActions) || value.coreActions.length < 3 || value.coreActions.length > 32) return null;
  const requirementIds = requirements.map(requirement => requirement.requirementId);
  const requirementSet = new Set(requirementIds);
  const rawCoreActions = value.coreActions;
  const startRequirementIds = normalizedRequirementIds(value.startRequirementIds, requirementSet, true);
  const start = semanticEnvelopeAction(value.startAction, "START_SESSION");
  if (!start || startRequirementIds === null) return null;
  const coreActions = rawCoreActions.map((item, index) => normalizeSemanticCoreAction(
    item, index, rawCoreActions.length, requirementSet,
    index === 0 ? verifiedChangeTargetId : null,
  ));
  if (coreActions.some(item => item === null)) return null;
  const normalizedCoreActions = coreActions as readonly NonNullable<(typeof coreActions)[number]>[];
  const covered = new Set([...startRequirementIds, ...normalizedCoreActions.flatMap(item => item.coversRequirementIds)]);
  if (requirementIds.some(requirementId => !covered.has(requirementId))) return null;
  const coreRequirementIds = requirements.filter(item => item.source === "CORE_LOOP").map(item => item.requirementId);
  if (coreRequirementIds.some(requirementId => !covered.has(requirementId))) return null;

  const events: Record<string, unknown>[] = [
    { type: "checkpoint", id: "project-start", role: "START", visualMode: "STABLE_REPLAY", assertions: CORE_START_ASSERTIONS },
    { ...start, stepId: "planned-start-session", coversRequirementIds: startRequirementIds, postconditions: CORE_READY_ASSERTIONS },
    { type: "checkpoint", id: "project-ready", role: "READY", visualMode: "STABLE_REPLAY", assertions: CORE_READY_ASSERTIONS },
  ];
  for (const item of normalizedCoreActions) {
    events.push(item.action);
    events.push(item.checkpoint);
  }
  const completionProgress = normalizedCoreActions.at(-1)!.progress;
  const actions: readonly Record<string, unknown>[] = [
    start,
    ...normalizedCoreActions.map(item => item.action as Readonly<Record<string, unknown>>),
  ];
  const usesGamepad = actions.some(action => String(action.type).startsWith("gamepad_"));
  const usesKeyboard = actions.some(action => ["key_tap", "key_hold"].includes(String(action.type)));
  const usesPointer = actions.some(action => ["click", "double_click", "drag", "scroll", "text_input"].includes(String(action.type)));
  const inputProfiles = [
    ...(usesKeyboard || usesPointer ? ["KEYBOARD_MOUSE" as const] : []),
    ...(usesGamepad ? ["GAMEPAD" as const] : []),
  ];
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
      goal: "Start a clean game and complete every player-visible operation in one real project core-loop boundary",
      requirementIds,
      allowedActions,
      successAssertions: [completionProgress],
      failureAssertions: [{ source: "STATE", key: "fatal-error", operator: "EQUALS", value: true }],
      rolloutTimeoutMs: 300_000,
      maxDecisions: 40,
      seedStrategy: "STABLE_PROJECT_PLATFORM",
    },
    requirements,
    features: [{
      id: "project-core-loop",
      requirementIds,
      category: "core-loop",
      description: "Exercise every semantic operation in the current project's clean core-loop path",
      verificationMethod: "interactive",
      timeoutMs: 300_000,
      coreJourney: true,
      launchProfile: { type: "FRESH" },
      interactionScript: { events },
    }],
  };
  return validateTestManifest(candidate) ? candidate : null;
}

function normalizeSemanticCoreAction(
  value: unknown,
  index: number,
  count: number,
  requirementIds: ReadonlySet<string>,
  verifiedChangeTargetId: string | null,
) {
  if (!isRecord(value) || !isStablePath(value.progressKey) || !isStableId(value.changeTargetId)) return null;
  const coversRequirementIds = normalizedRequirementIds(value.coversRequirementIds, requirementIds, false);
  if (coversRequirementIds === null) return null;
  const intent = index === 0 ? "PRIMARY_ACTION" : index === count - 1 ? "COMPLETE_LOOP" : "FEATURE_ACTION";
  const action = semanticEnvelopeAction(value.action, intent);
  if (!action) return null;
  const progress = { source: "PROGRESS", key: value.progressKey, operator: "CHANGED" } as const;
  const suffix = String(index + 1).padStart(2, "0");
  const checkpointRole = index === 0 ? "PROGRESS" : index === count - 1 ? "COMPLETION" : "ACTION";
  const changeTargetId = verifiedChangeTargetId ?? value.changeTargetId;
  return Object.freeze({
    progress,
    coversRequirementIds,
    action: Object.freeze({
      ...action,
      stepId: `planned-core-action-${suffix}`,
      coversRequirementIds,
      postconditions: [progress],
    }),
    checkpoint: Object.freeze({
      type: "checkpoint",
      id: `project-core-action-${suffix}`,
      role: checkpointRole,
      visualMode: "DYNAMIC",
      changeTargetId,
      assertions: [progress],
    }),
  });
}

function normalizedRequirementIds(
  value: unknown,
  allowed: ReadonlySet<string>,
  allowEmpty: boolean,
): readonly string[] | null {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > 500
    || value.some(item => typeof item !== "string" || !allowed.has(item))
    || new Set(value).size !== value.length) return null;
  return Object.freeze([...value] as string[]);
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

function buildAssetPlacementPlan(context: Readonly<Record<string, unknown>>): AssetPlacementPlan {
  const assets = Array.isArray(context.assets)
    ? context.assets.filter(asset => isRecord(asset) && asset.materialized === true && typeof asset.assetKey === "string")
    : [];
  const usageManifest = record(context.assetUsageManifest);
  const usageItems = Array.isArray(usageManifest.items) ? usageManifest.items.filter(isRecord) : [];
  const usageByKey = new Map(usageItems
    .filter(item => typeof item.assetKey === "string")
    .map(item => [String(item.assetKey), item] as const));
  const hasUsageManifest = usageItems.length > 0;
  const plannedAssets = assets.filter(asset => {
    const usage = usageByKey.get(String(asset.assetKey));
    return !hasUsageManifest || (usage !== undefined && usage.discoveredSourceImage !== true);
  });
  const placements: PlannedAssetPlacement[] = [];
  const unmappedAssetKeys: string[] = [];
  for (const asset of plannedAssets) {
    const assetKey = String(asset.assetKey);
    const usage = usageByKey.get(assetKey);
    const resourcePath = safeImageResourcePath(asset.expectedResourcePath)
      ? asset.expectedResourcePath : null;
    if (!usage || !validateAssetUsageTargets(usage.usageTargets) || !resourcePath) {
      unmappedAssetKeys.push(assetKey);
      continue;
    }
    const expectedSha256 = typeof asset.expectedSha256 === "string"
      && /^sha256:[0-9a-f]{64}$/.test(asset.expectedSha256) ? asset.expectedSha256 : null;
    for (const target of usage.usageTargets) {
      placements.push(Object.freeze({
        assetKey,
        targetId: target.targetId,
        checkpointRole: target.checkpointRole,
        expectedResourcePath: resourcePath,
        expectedSha256,
      }));
    }
  }
  placements.sort((left, right) => left.assetKey.localeCompare(right.assetKey)
    || left.checkpointRole.localeCompare(right.checkpointRole)
    || left.targetId.localeCompare(right.targetId));
  return Object.freeze({
    schema: "deviludo.asset-placement-plan",
    plannedAssetKeys: Object.freeze(plannedAssets.map(asset => String(asset.assetKey)).sort()),
    placements: Object.freeze(placements),
    unmappedAssetKeys: Object.freeze(unmappedAssetKeys.sort()),
  });
}

function isStableId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,119}$/.test(value);
}

function safeImageResourcePath(value: unknown): value is string {
  const path = typeof value === "string" && value.startsWith("res://") ? value.slice("res://".length) : "";
  return typeof value === "string" && value.startsWith("res://") && value.length <= 506
    && /\.(?:png|jpe?g|webp|svg)$/i.test(value)
    && !path.includes("\\") && !path.includes("//") && !/(^|\/)\.{1,2}(\/|$)/.test(path);
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
  return Object.freeze({
    regressionOperations: strings("regressionOperations", ["Start, operate, and complete the project core loop"]),
    regressionUi: strings("regressionUi", ["Verify clean menu, active gameplay, progress, and completion UI"]),
    changeImpact: strings("changeImpact", ["Revalidate every frozen requirement in the current iteration"]),
    // This field is an inventory, not proof. Runtime placement evidence is the
    // only thing allowed to satisfy the asset gate.
    assetApplication: Object.freeze(materializedAssetKeys.length > 0
      ? [...materializedAssetKeys]
      : ["No planned materialized image assets are present in this build"]),
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
  assetPlacementPlan: AssetPlacementPlan,
): GeneratedE2eTestPlan {
  const regression = record(context.regression);
  const regressionMs = regression.available === true && Number.isSafeInteger(regression.estimatedDurationMs)
    ? Math.max(0, Math.min(300_000, Number(regression.estimatedDurationMs)))
    : 0;
  const executionPlan = planE2eExecution(parsed.testManifest, regressionMs);
  const testManifestDigest = jsonDigest(parsed.testManifest);
  return Object.freeze({
    ...parsed,
    assetPlacementPlan,
    testManifestDigest,
    contractDigest: jsonDigest({
      testManifest: parsed.testManifest,
      assetPlacementPlan,
      runner: "adaptive-real-input",
    }),
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
        { type: "click", stepId: "fixture-feature", intent: "FEATURE_ACTION", targetId: "primary-control", coversRequirementIds: requirementIds, postconditions: [progress] },
        { type: "checkpoint", id: "fixture-action", role: "ACTION", visualMode: "DYNAMIC", changeTargetId: "game-viewport", assertions: [progress] },
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
    "You are the cross-platform E2E Test Agent. Identify every player-visible operation needed to complete the current project's semantic core loop; Development Agent does not own this plan.",
    "Return only one JSON object shaped {semanticJourney,coverage}. No markdown and no testManifest.",
    "Core will freeze requirements and deterministically build the full validated manifest. You own only project-specific semanticJourney values.",
    "semanticJourney needs startAction, startRequirementIds, and coreActions. Every frozen requirement ID must appear in startRequirementIds or at least one coreActions.coversRequirementIds array. Never omit a frozen ID.",
    "startRequirementIds may be empty. Put clean-launch/menu-state requirements there because the START checkpoint proves the pre-action state and the startAction proves the transition to READY. Also put explicit out-of-scope/exclusion requirements there to preserve the approved boundary without inventing an excluded player operation.",
    "coreActions is the ordered post-entry player path and must contain at least three items. Decompose combined prose into every real operation: selection, roll/draw, target choice, movement, interaction/confirmation, turn completion, AI/response resolution, and result settlement whenever the approved core loop requires them. Never collapse a multi-operation loop into one generic primary action plus end turn.",
    "Each coreActions item contains action, progressKey, changeTargetId, and coversRequirementIds. action needs type plus targetId/key/button/durationMs; set unused fields to null. progressKey must change because of that exact action, changeTargetId must be the visible Probe region whose pixels change, and coversRequirementIds must list only frozen requirements that action genuinely proves. The final item must cross the approved loop-completion boundary.",
    "Prefer click or double_click with a real Probe control targetId. Use key_tap/key_hold or gamepad_button_tap/gamepad_button_hold only when the game has no Probe control for that action. Do not use coordinates.",
    "The plan must test the installed/exported game through real OS keyboard, pointer, and declared gamepad input. Probe data is an oracle only and must never invoke actions.",
    "When priorRegressionTrace is present, treat its previously successful semantic targets, actions, and assertions as the strongest evidence. Preserve them unless the current specification explicitly changes that player path.",
    "coverage.regressionOperations lists prior and full-project player operations exercised; coverage.regressionUi lists menus, overlays, HUD/layout and clean-start regressions; coverage.changeImpact lists every risk from the current iteration versus the previous specification; coverage.assetApplication lists every materialized assetKey and the plan must verify it is loaded, visible in the correct game/UI context, correctly cropped/aspected, and not merely present on disk.",
    `Frozen requirements: ${JSON.stringify(requirements)}`,
    `Frozen planning context: ${JSON.stringify(compactPlanningContext(context))}`,
  ].join("\n");
}

function testPlanCorrectionPrompt(
  originalPrompt: string,
  previousOutput: string,
  validationReason: string,
  requirements: ReturnType<typeof specificationRequirementCatalog>,
): string {
  return [
    originalPrompt,
    "Your previous structured plan was otherwise usable but failed frozen-requirement coverage validation.",
    `Validation failure: ${validationReason}`,
    `Required frozen IDs: ${JSON.stringify(requirements.map(requirement => requirement.requirementId))}`,
    "Return a corrected complete {semanticJourney,coverage} object. Preserve real semantic target IDs and action ordering. Add every missing ID to the action that proves it; use startRequirementIds for clean-launch/menu-state or explicit scope-exclusion requirements. Do not invent an action for excluded scope.",
    `Previous structured output: ${previousOutput.slice(0, 80_000)}`,
  ].join("\n");
}

function compactPlanningContext(context: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const assets = Array.isArray(context.assets) ? context.assets.filter(isRecord) : [];
  const usageItems = Array.isArray(record(context.assetUsageManifest).items)
    ? (record(context.assetUsageManifest).items as readonly unknown[]).filter(isRecord) : [];
  const usageByKey = new Map(usageItems
    .filter(item => typeof item.assetKey === "string")
    .map(item => [String(item.assetKey), item] as const));
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
        expectedResourcePath: asset.expectedResourcePath,
        usageTargets: usageByKey.get(String(asset.assetKey))?.usageTargets ?? null,
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
