import { createHash } from "node:crypto";
import type { AgentRuntimeKind } from "@/lib/product/contracts";
import {
  planE2eExecution,
  specificationRequirementCatalog,
  validateTestManifest,
  type E2eExecutionPlan,
  type TestManifest,
} from "@/lib/product/test-manifest";
import { runCodexPrompt, type CodexPromptRunner } from "./codex-cli";

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
  if (input.testFixture === true) {
    return finalizePlan(fixturePlan(requirements, materializedAssetKeys), input.context);
  }
  const prompt = testPlanPrompt(input.context, requirements);
  const fetchImpl = input.fetchImpl ?? fetch;
  const codexRunner = input.codexRunner ?? runCodexPrompt;
  let previous = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const correction = previous
      ? `\nThe previous JSON was rejected. Regenerate the complete plan without weakening coverage. Validator summary: ${previous.slice(0, 1_500)}`
      : "";
    let raw = "";
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
            messages: [{ role: "user", content: prompt + correction }],
          }),
          signal: AbortSignal.timeout(180_000),
        });
        if (!response.ok) throw new Error(`Test Agent returned ${response.status}`);
        const body = await response.json() as Record<string, unknown>;
        const content = Array.isArray(body.content) ? body.content as readonly Record<string, unknown>[] : [];
        raw = String(content.find(item => item.type === "text")?.text ?? "");
      } else {
        raw = await codexRunner({
          authJson: input.apiKey,
          model: input.model,
          prompt: prompt + correction,
          reasoningEffort: "high",
          timeoutMs: 180_000,
        });
      }
      const parsed = parsePlan(raw);
      assertFrozenRequirements(parsed.testManifest, requirements);
      assertPlanningCoverage(parsed.coverage, materializedAssetKeys);
      return finalizePlan(parsed, input.context);
    } catch (error) {
      previous = error instanceof Error ? error.message : "invalid Test Agent plan";
    }
  }
  throw new Error(`Test Agent did not produce a valid cross-platform E2E plan: ${previous}`);
}

function parsePlan(raw: string): Readonly<{ testManifest: TestManifest; coverage: E2ePlanningCoverage }> {
  const source = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(source) as Record<string, unknown>;
  if (!isRecord(value) || !validateTestManifest(value.testManifest) || !isRecord(value.coverage)) {
    throw new Error("response must contain a valid testManifest and coverage object");
  }
  const coverage = value.coverage;
  const fields = ["regressionOperations", "regressionUi", "changeImpact", "assetApplication"] as const;
  if (fields.some(field => !Array.isArray(coverage[field])
    || (coverage[field] as unknown[]).some(item => typeof item !== "string" || item.trim().length < 1))) {
    throw new Error("coverage arrays are invalid");
  }
  return Object.freeze({
    testManifest: value.testManifest,
    coverage: Object.freeze(
      Object.fromEntries(fields.map(field => [field, Object.freeze([...(coverage[field] as string[])])])),
    ) as E2ePlanningCoverage,
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

function fixturePlan(
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

function testPlanPrompt(context: Readonly<Record<string, unknown>>, requirements: ReturnType<typeof specificationRequirementCatalog>): string {
  return [
    "You are the cross-platform E2E Test Agent. Generate the current platform test plan now; Development Agent does not own this plan.",
    "Return only one JSON object shaped {testManifest,coverage}. No markdown.",
    "The plan must test the installed/exported game through real OS keyboard, pointer, and declared gamepad input. Probe data is an oracle only and must never invoke actions.",
    "testManifest.schema is deviludo.test-manifest and has no version fields. It needs inputProfiles, primaryInputProfile, adaptivePlayer, the exact frozen requirements, and features.",
    "Every PLAYER_INTERACTION requirement needs at least one interactive action with coversRequirementIds and a postcondition proving a real state/progress/control/scene change.",
    "Create a short FRESH core-loop journey with START, READY, PROGRESS, and COMPLETION screenshots; START must prove a clean MENU with no active gameplay behind it, then real START_SESSION, PRIMARY_ACTION, and COMPLETE_LOOP inputs must cross a genuine progress boundary.",
    "Use only semantic Probe target IDs, never fixed coordinates or unrelated keys. Use coherent separate journeys for mutually exclusive modes.",
    "Checkpoint assertions must validate UI structure and lifecycle. Dynamic checkpoints must identify the changed semantic target. Include at least three valid screenshots and a STABLE_REPLAY launch checkpoint.",
    "adaptivePlayer must cover all CORE_LOOP requirements, use allowed native action groups, include real progress success assertions and failure assertions, use STABLE_PROJECT_PLATFORM, 240000-300000 rolloutTimeoutMs, and 8-40 maxDecisions.",
    "coverage.regressionOperations lists prior and full-project player operations exercised; coverage.regressionUi lists menus, overlays, HUD/layout and clean-start regressions; coverage.changeImpact lists every risk from the current iteration versus the previous specification; coverage.assetApplication lists every materialized assetKey and the plan must verify it is loaded, visible in the correct game/UI context, correctly cropped/aspected, and not merely present on disk.",
    "Do not declare referenceImage paths: the E2E node owns a final build, not the source worktree. Verify rendered assets with Probe-linked screenshot regions, state changes, and stable replay instead.",
    "Do not invent a unit-test path. Prefer real interactive journeys and Probe assertions; add unit checks only when the supplied context explicitly names an existing script.",
    `Frozen requirements: ${JSON.stringify(requirements)}`,
    `Frozen planning context: ${JSON.stringify(context)}`,
  ].join("\n");
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
