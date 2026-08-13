import assert from "node:assert";
import { describe, test } from "node:test";
import {
  TEST_MANIFEST_SCHEMA_VERSION,
  stableRequirementId,
  specificationRequirementCatalog,
  validateTestExecutionResult,
  validateTestManifest,
  type TestExecutionResult,
  type TestManifest,
} from "../lib/product/test-manifest";

const sceneMain = Object.freeze({ source: "SCENE" as const, operator: "EQUALS" as const, value: "main" });
const changedTurn = Object.freeze({ source: "PROGRESS" as const, key: "turn", operator: "CHANGED" as const });

function checkpoint(id: string, role: "START" | "READY" | "PROGRESS" | "COMPLETION", stable = false) {
  return { type: "checkpoint" as const, id, role, assertions: [sceneMain], visualMode: stable ? "STABLE_REPLAY" as const : "DYNAMIC" as const,
    ...(!stable && ["PROGRESS", "COMPLETION"].includes(role) ? { changeTargetId: "game-viewport" } : {}) };
}

function completeManifest(): TestManifest {
  return {
    schemaVersion: TEST_MANIFEST_SCHEMA_VERSION,
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
        interactionScript: { version: "3", events: [
          checkpoint("game-start", "START", true), checkpoint("game-ready", "READY"),
          { type: "click", stepId: "roll", intent: "PRIMARY_ACTION", targetId: "roll-dice", coversRequirementIds: ["req-core-loop"], postconditions: [changedTurn] },
          checkpoint("turn-progress", "PROGRESS"),
          { type: "click", stepId: "finish", intent: "COMPLETE_LOOP", targetId: "end-turn", coversRequirementIds: ["req-core-loop"], postconditions: [changedTurn] },
          checkpoint("game-complete", "COMPLETION", true),
        ] },
      },
      {
        id: "pause-journey", requirementIds: ["req-pause"], category: "player-control",
        description: "真实暂停操作", verificationMethod: "interactive", launchProfile: { type: "FRESH" }, timeoutMs: 30_000,
        interactionScript: { version: "3", events: [
          { type: "key_tap", stepId: "pause", intent: "FEATURE_ACTION", key: "KEY_P", coversRequirementIds: ["req-pause"], postconditions: [{ source: "STATE", key: "paused", operator: "EQUALS", value: true }] },
        ] },
      },
      {
        id: "save-data", requirementIds: ["req-save-data"], category: "data-integrity",
        description: "存档格式", verificationMethod: "unit", gdsTestPath: "res://tests/e2e.gd", checkNames: ["save-round-trip"],
      },
    ],
  };
}

describe("test-manifest v3", () => {
  test("validates fresh core play, semantic real input, postconditions and system checks", () => {
    assert.equal(validateTestManifest(completeManifest()), true);
  });

  test("rejects v2 and the former two-H blind-start contract", () => {
    const manifest = completeManifest();
    assert.equal(validateTestManifest({ ...manifest, schemaVersion: "deviludo.test-manifest.v2" }), false);
    assert.equal(validateTestManifest({ ...manifest, features: [{
      ...manifest.features[0], launchProfile: undefined,
      interactionScript: { version: "2", events: [{ type: "key_press", key: "KEY_H" }, { type: "key_release", key: "KEY_H" }] },
    }, ...manifest.features.slice(1)] }), false);
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
      { id: "action", event: { type: "key_tap", key: "SPACE", postconditions: [{ source: "STATE", key: "attacks", operator: "GREATER_THAN", value: 0 }] } },
      { id: "turn-strategy", event: { type: "click", targetId: "end-turn", postconditions: [{ source: "PROGRESS", key: "turn", operator: "CHANGED" }] } },
      { id: "pointer", event: { type: "double_click", targetId: "world-target", postconditions: [{ source: "STATE", key: "selected", operator: "EQUALS", value: true }] } },
      { id: "narrative", event: { type: "click", targetId: "choice-a", postconditions: [{ source: "SCENE", operator: "EQUALS", value: "chapter-two" }] } },
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
          interactionScript: { version: "3" as const, events: [action] },
        }, manifest.features[2]],
      };
      assert.equal(validateTestManifest(candidate), true, `${archetype.id} contract should be game-genre neutral`);
    }
  });

  test("requires an operation-after assertion and fresh progress-crossing core journey", () => {
    const manifest = completeManifest();
    const core = manifest.features[0];
    const withoutPostcondition = core.interactionScript?.events.map(event => event.type === "click" ? { ...event, postconditions: [] } : event);
    assert.equal(validateTestManifest({ ...manifest, features: [{ ...core, interactionScript: { version: "3", events: withoutPostcondition } }, ...manifest.features.slice(1)] }), false);
    assert.equal(validateTestManifest({ ...manifest, features: [{ ...core, launchProfile: { type: "SCENARIO", scenarioId: "near-win" } }, ...manifest.features.slice(1)] }), false);
  });

  test("rejects requirement coverage claimed only at journey level", () => {
    const manifest = completeManifest();
    const pause = manifest.features[1];
    const events = pause.interactionScript?.events.map(event => event.type === "key_tap" ? { ...event, coversRequirementIds: [] } : event);
    assert.equal(validateTestManifest({ ...manifest, features: [manifest.features[0], { ...pause, interactionScript: { version: "3", events } }, manifest.features[2]] }), false);
  });

  test("derives stable v3 player requirements from frozen specifications", () => {
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
});
