import assert from "node:assert";
import { describe, test } from "node:test";
import {
  TEST_MANIFEST_SCHEMA,
  planE2eExecution,
  stableRequirementId,
  specificationRequirementCatalog,
  testManifestValidationError,
  validateTestExecutionResult,
  validateTestManifest,
  type TestExecutionResult,
  type TestManifest,
} from "../lib/product/test-manifest";

const sceneMain = Object.freeze({ source: "SCENE" as const, operator: "EQUALS" as const, value: "main" });
const changedTurn = Object.freeze({ source: "PROGRESS" as const, key: "turn", operator: "CHANGED" as const });
const menuAssertions = Object.freeze([
  { source: "STATE" as const, key: "screen_mode", operator: "EQUALS" as const, value: "MENU" },
  { source: "STATE" as const, key: "session_active", operator: "EQUALS" as const, value: false },
  { source: "STATE" as const, key: "gameplay_input_enabled", operator: "EQUALS" as const, value: false },
  { source: "STATE" as const, key: "blocking_layer_count", operator: "EQUALS" as const, value: 0 },
]);
const playingAssertions = Object.freeze([
  { source: "STATE" as const, key: "screen_mode", operator: "EQUALS" as const, value: "PLAYING" },
  { source: "STATE" as const, key: "session_active", operator: "EQUALS" as const, value: true },
  { source: "STATE" as const, key: "gameplay_input_enabled", operator: "EQUALS" as const, value: true },
  { source: "STATE" as const, key: "blocking_layer_count", operator: "EQUALS" as const, value: 0 },
]);

function checkpoint(id: string, role: "START" | "READY" | "PROGRESS" | "COMPLETION", stable = false) {
  return { type: "checkpoint" as const, id, role, assertions: [sceneMain], visualMode: stable ? "STABLE_REPLAY" as const : "DYNAMIC" as const,
    ...(!stable && ["PROGRESS", "COMPLETION"].includes(role) ? { changeTargetId: "game-viewport" } : {}) };
}

function completeManifest(): TestManifest {
  return {
    schema: TEST_MANIFEST_SCHEMA,
    inputProfiles: ["KEYBOARD_MOUSE"],
    primaryInputProfile: "KEYBOARD_MOUSE",
    adaptivePlayer: {
      goal: "进入游戏并完成一个完整回合，使回合进度发生变化",
      requirementIds: ["req-core-loop", "req-pause"],
      allowedActions: ["KEYBOARD", "POINTER"],
      successAssertions: [changedTurn],
      failureAssertions: [{ source: "STATE", key: "game_over", operator: "EQUALS", value: true }],
      rolloutTimeoutMs: 240_000,
      maxDecisions: 20,
      seedStrategy: "STABLE_PROJECT_PLATFORM",
    },
    requirements: [
      { requirementId: "req-core-loop", description: "完成一轮游戏", source: "CORE_LOOP", verificationClass: "PLAYER_INTERACTION" },
      { requirementId: "req-pause", description: "通过暂停按钮停止时间", source: "ACCEPTANCE", verificationClass: "PLAYER_INTERACTION" },
      { requirementId: "req-save-data", description: "存档数据格式可恢复", source: "ACCEPTANCE", verificationClass: "SYSTEM", systemCategory: "DATA", exemptionReason: "存档序列化格式由确定性数据检查验证" },
    ],
    features: [
      {
        id: "core-loop-journey", requirementIds: ["req-core-loop"], category: "core-loop",
        description: "从干净用户目录完成核心循环", verificationMethod: "interactive", coreJourney: true,
        launchProfile: { type: "FRESH" }, timeoutMs: 300_000,
        interactionScript: { events: [
          { ...checkpoint("game-start", "START", true), assertions: menuAssertions },
          { type: "click", stepId: "start-session", intent: "START_SESSION", targetId: "new-game", coversRequirementIds: ["req-core-loop"], postconditions: playingAssertions },
          { ...checkpoint("game-ready", "READY", true), assertions: playingAssertions },
          { type: "click", stepId: "activate-primary-control", intent: "PRIMARY_ACTION", targetId: "primary-control", coversRequirementIds: ["req-core-loop"], postconditions: [changedTurn] },
          { type: "click", stepId: "exercise-feature", intent: "FEATURE_ACTION", targetId: "feature-control", coversRequirementIds: ["req-core-loop"], postconditions: [changedTurn] },
          checkpoint("turn-progress", "PROGRESS"),
          { type: "click", stepId: "finish", intent: "COMPLETE_LOOP", targetId: "end-turn", coversRequirementIds: ["req-core-loop"], postconditions: [changedTurn] },
          checkpoint("game-complete", "COMPLETION", true),
        ] },
      },
      {
        id: "pause-journey", requirementIds: ["req-pause"], category: "player-control",
        description: "真实暂停操作", verificationMethod: "interactive", launchProfile: { type: "FRESH" }, timeoutMs: 30_000,
        interactionScript: { events: [
          { type: "key_tap", stepId: "pause", intent: "FEATURE_ACTION", key: "KEY_P", coversRequirementIds: ["req-pause"], postconditions: [{ source: "STATE", key: "paused", operator: "CHANGED" }] },
        ] },
      },
      {
        id: "save-data", requirementIds: ["req-save-data"], category: "data-integrity",
        description: "存档格式", verificationMethod: "unit", gdsTestPath: "res://tests/e2e.gd", checkNames: ["save-round-trip"], timeoutMs: 30_000,
      },
    ],
  };
}

describe("test-manifest", () => {
  test("validates fresh core play, semantic real input, postconditions and system checks", () => {
    const manifest = completeManifest();
    assert.equal(validateTestManifest(manifest), true);
    assert.equal(testManifestValidationError(manifest), null);
  });

  test("returns actionable contract errors instead of misclassifying an invalid plan as infrastructure", () => {
    const manifest = completeManifest();
    assert.match(testManifestValidationError({
      schema: TEST_MANIFEST_SCHEMA,
      requirements: manifest.requirements,
      features: manifest.features,
    }) ?? "", /missing required fields: inputProfiles, primaryInputProfile, adaptivePlayer/);
    assert.match(testManifestValidationError({
      ...manifest,
      requirements: manifest.requirements.map(item => ({ requirementId: item.requirementId })),
    }) ?? "", /requirements\[0\].*description, source, verificationClass/);
    assert.match(testManifestValidationError({
      ...manifest,
      seed: 19870531,
    }) ?? "", /unsupported top-level fields: seed/);
    assert.match(testManifestValidationError({
      ...manifest,
      features: [{ ...manifest.features[0], verificationMethod: "CORE_JOURNEY" }],
    }) ?? "", /verificationMethod must be one of: unit, interactive, visual, manual/);
    assert.match(testManifestValidationError({
      ...manifest,
      adaptivePlayer: {
        ...manifest.adaptivePlayer,
        successAssertions: [{ source: "PROGRESS", key: "loop", operator: "CHANGED" }],
      },
    }) ?? "", /unresolved placeholder.*PROGRESS|unresolved placeholder.*key/);
    assert.match(testManifestValidationError({
      ...manifest,
      features: [{ ...manifest.features[0], interactionScript: { events: [] } }],
    }) ?? "", /interactionScript is invalid/);
    const equalityOnly = manifest.features[0]!.interactionScript!.events.map(event =>
      event.type === "click" && event.stepId === "exercise-feature"
        ? { ...event, postconditions: [{ source: "CONTROL", targetId: "move", property: "enabled", operator: "EQUALS", value: true }] }
        : event);
    assert.match(testManifestValidationError({
      ...manifest,
      features: [{ ...manifest.features[0], interactionScript: { events: equalityOnly } }, ...manifest.features.slice(1)],
    }) ?? "", /action exercise-feature must include a CHANGED postcondition/);
    assert.equal(validateTestManifest({
      ...manifest,
      features: [{ ...manifest.features[0], interactionScript: { events: equalityOnly } }, ...manifest.features.slice(1)],
    }), false);
    const coreFeature = manifest.features[0]!;
    assert.match(testManifestValidationError({
      ...manifest,
      features: [{
        ...coreFeature,
        interactionScript: {
          events: coreFeature.interactionScript!.events.filter(event => event.type !== "click" || event.intent !== "FEATURE_ACTION"),
        },
      }, ...manifest.features.slice(1)],
    }) ?? "", /PRIMARY_ACTION, FEATURE_ACTION, and COMPLETE_LOOP/);
  });

  test("rejects versioned contracts and blind raw-key launch contracts", () => {
    const manifest = completeManifest();
    assert.equal(validateTestManifest({ ...manifest, schema: "deviludo.test-manifest.v3" }), false);
    assert.equal(validateTestManifest({ ...manifest, schemaVersion: "deviludo.test-manifest" }), false);
    assert.equal(validateTestManifest({ ...manifest, suite: "retired-suite" }), false);
    assert.equal(validateTestManifest({ ...manifest, gdsTestPath: "res://tests/e2e.gd" }), false);
    assert.equal(validateTestManifest({ ...manifest, features: [{
      ...manifest.features[0], launchProfile: undefined,
      interactionScript: { events: [{ type: "key_press", key: "KEY_H" }, { type: "key_release", key: "KEY_H" }] },
    }, ...manifest.features.slice(1)] }), false);
  });

  test("does not accept checkpoint marker aliases", () => {
    const manifest = completeManifest();
    const core = manifest.features[0];
    const events = core.interactionScript!.events.map((event, index) => index === 0
      ? { ...event, expectedOutput: "DEVILUDO_E2E_CHECKPOINT:old-start" }
      : event);
    assert.equal(validateTestManifest({
      ...manifest,
      features: [{ ...core, interactionScript: { events } }, ...manifest.features.slice(1)],
    }), false);
  });

  test("does not accept values on CHANGED or EXISTS assertions", () => {
    const manifest = completeManifest();
    const core = manifest.features[0];
    const events = core.interactionScript!.events.map(event => event.type === "click"
      ? { ...event, postconditions: [{ ...changedTurn, value: 1 }] }
      : event);
    assert.equal(validateTestManifest({
      ...manifest,
      features: [{ ...core, interactionScript: { events } }, ...manifest.features.slice(1)],
    }), false);
  });

  test("forces coreLoop and default acceptance requirements through real player actions", () => {
    const manifest = completeManifest();
    assert.equal(validateTestManifest({ ...manifest, requirements: manifest.requirements.map(item => item.requirementId === "req-core-loop" ? { ...item, verificationClass: "SYSTEM", systemCategory: "RUNTIME", exemptionReason: "不允许的核心循环豁免" } : item) }), false);
    const pauseJourney = manifest.features[1];
    assert.equal(validateTestManifest({ ...manifest, features: [manifest.features[0], { ...pauseJourney, verificationMethod: "manual", interactionScript: undefined, launchProfile: undefined, timeoutMs: undefined }, manifest.features[2]] }), false);
  });

  test("requires valid SYSTEM category and a concrete exemption reason", () => {
    const manifest = completeManifest();
    assert.equal(validateTestManifest({ ...manifest, requirements: manifest.requirements.map(item => item.requirementId === "req-save-data" ? { ...item, systemCategory: "UI", exemptionReason: "短" } : item) }), false);
  });

  test("supports action, turn-strategy, pointer and narrative semantic player contracts", () => {
    const archetypes = [
      { id: "action", event: { type: "key_tap", key: "SPACE", postconditions: [{ source: "STATE", key: "attacks", operator: "CHANGED" }] } },
      { id: "turn-strategy", event: { type: "click", targetId: "end-turn", postconditions: [{ source: "PROGRESS", key: "turn", operator: "CHANGED" }] } },
      { id: "pointer", event: { type: "double_click", targetId: "world-target", postconditions: [{ source: "STATE", key: "selected", operator: "CHANGED" }] } },
      { id: "narrative", event: { type: "click", targetId: "choice-a", postconditions: [{ source: "SCENE", operator: "CHANGED" }] } },
    ] as const;
    for (const archetype of archetypes) {
      const manifest = completeManifest();
      const pause = manifest.features[1];
      const action = {
        ...archetype.event, stepId: `${archetype.id}-action`, intent: "FEATURE_ACTION" as const,
        coversRequirementIds: ["req-pause"],
      };
      const candidate = {
        ...manifest,
        features: [manifest.features[0], {
          ...pause, id: `${archetype.id}-journey`, description: `${archetype.id} 真实玩家操作`,
          interactionScript: { events: [action] },
        }, manifest.features[2]],
      };
      assert.equal(validateTestManifest(candidate), true, `${archetype.id} contract should be game-genre neutral`);
    }
  });

  test("requires an operation-after assertion and fresh progress-crossing core journey", () => {
    const manifest = completeManifest();
    const core = manifest.features[0];
    const withoutPostcondition = core.interactionScript?.events.map(event => event.type === "click" ? { ...event, postconditions: [] } : event);
    assert.equal(validateTestManifest({ ...manifest, features: [{ ...core, interactionScript: { events: withoutPostcondition } }, ...manifest.features.slice(1)] }), false);
    assert.equal(validateTestManifest({ ...manifest, features: [{ ...core, launchProfile: { type: "SCENARIO", scenarioId: "near-win" } }, ...manifest.features.slice(1)] }), false);
    assert.equal(validateTestManifest({
      ...manifest,
      adaptivePlayer: {
        ...manifest.adaptivePlayer,
        successAssertions: [{ source: "CONTROL", targetId: "end-turn", property: "enabled", operator: "EQUALS", value: true }],
      },
    }), false);
  });

  test("rejects a menu captured over an already-running game and a start action mislabeled as gameplay", () => {
    const manifest = completeManifest();
    const core = manifest.features[0];
    const events = core.interactionScript!.events;
    const falsePositiveSequence = [
      { ...events[0], assertions: playingAssertions },
      { ...events[2], assertions: playingAssertions },
      { ...events[1], intent: "PRIMARY_ACTION" as const, postconditions: playingAssertions },
      ...events.slice(3),
    ];
    assert.equal(validateTestManifest({
      ...manifest,
      features: [{ ...core, interactionScript: { events: falsePositiveSequence } }, ...manifest.features.slice(1)],
    }), false);
  });

  test("rejects requirement coverage claimed only at journey level", () => {
    const manifest = completeManifest();
    const pause = manifest.features[1];
    const events = pause.interactionScript?.events.map(event => event.type === "key_tap" ? { ...event, coversRequirementIds: [] } : event);
    assert.equal(validateTestManifest({ ...manifest, features: [manifest.features[0], { ...pause, interactionScript: { events } }, manifest.features[2]] }), false);
  });

  test("derives stable player requirements from frozen specifications", () => {
    const specification = { coreLoop: ["进入游戏"], acceptanceCriteria: ["可以获胜"] };
    const result = specificationRequirementCatalog(specification);
    assert.equal(result[0].requirementId, stableRequirementId("feature", 0, "进入游戏"));
    assert.deepEqual(result.map(item => [item.source, item.verificationClass]), [["CORE_LOOP", "PLAYER_INTERACTION"], ["ACCEPTANCE", "PLAYER_INTERACTION"]]);
  });

  test("validates exact headless execution result shapes", () => {
    const result: TestExecutionResult = { suite: "deviludo", checks: ["save-round-trip"], failures: [], duration_ms: 127.3 };
    assert.equal(validateTestExecutionResult(result), true);
    assert.equal(validateTestExecutionResult({ ...result, checks: "invalid" }), false);
    assert.equal(validateTestExecutionResult({ ...result, duration_ms: -1 }), false);
  });

  test("freezes a dynamic 30-90 minute platform execution budget", () => {
    const manifest = completeManifest();
    const withoutRegression = planE2eExecution(manifest);
    const withRegression = planE2eExecution(manifest, 300_000);
    assert.equal(withoutRegression.plannedTimeoutMs, 55 * 60_000);
    assert.ok(withRegression.plannedTimeoutMs >= withoutRegression.plannedTimeoutMs);
    assert.equal(withRegression.adaptiveMs, 3 * manifest.adaptivePlayer.rolloutTimeoutMs);
    assert.equal(withRegression.adaptivePolicyMs, withRegression.adaptiveMs);
    assert.equal(withRegression.solidificationMs, 2 * manifest.adaptivePlayer.rolloutTimeoutMs);

    const expensiveUnits = Array.from({ length: 20 }, (_, index) => ({
      id: `long-unit-${index}`,
      requirementIds: ["req-save-data"],
      category: "runtime-quality" as const,
      description: `独立长时确定性检查 ${index}`,
      verificationMethod: "unit" as const,
      gdsTestPath: `res://tests/long-${index}.gd`,
      checkNames: [`long-check-${index}`],
      timeoutMs: 300_000,
    }));
    const overBudget = { ...manifest, features: [...manifest.features, ...expensiveUnits] };
    assert.equal(validateTestManifest(overBudget), true);
    assert.throws(() => planE2eExecution(overBudget), (error: unknown) => (
      (error as { code?: string }).code === "E2E_PLAN_EXCEEDS_LIMIT"
    ));
    assert.throws(() => planE2eExecution(manifest, 300_001), /regression estimate/i);
  });
});
