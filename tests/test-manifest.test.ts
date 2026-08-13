import assert from "node:assert";
import { describe, test } from "node:test";
import {
  TEST_MANIFEST_SCHEMA_VERSION,
  stableRequirementId,
  specificationRequirementCatalog,
  validateTestManifest,
  validateTestExecutionResult,
  type TestManifest,
  type TestExecutionResult,
} from "../lib/product/test-manifest";

function completeManifest(): TestManifest {
  return {
    schemaVersion: TEST_MANIFEST_SCHEMA_VERSION,
    requirements: [
      { requirementId: "req-core-loop", description: "完成一轮游戏" },
      { requirementId: "req-pause", description: "暂停时停止时间" },
    ],
    features: [
      {
        id: "core-loop-journey",
        requirementIds: ["req-core-loop"],
        category: "core-loop",
        description: "真实窗口中完成核心循环",
        verificationMethod: "interactive",
        coreJourney: true,
        timeoutMs: 300_000,
        interactionScript: {
          version: "2",
          events: [
            { type: "checkpoint", id: "game-start", role: "START", expectedOutput: "DEVILUDO_E2E_CHECKPOINT:game-start" },
            { type: "key_press", key: "KEY_SPACE" },
            { type: "checkpoint", id: "first-turn", role: "KEY_STATE", expectedOutput: "DEVILUDO_E2E_CHECKPOINT:first-turn" },
            { type: "key_release", key: "KEY_SPACE" },
            { type: "checkpoint", id: "game-complete", role: "COMPLETION", expectedOutput: "DEVILUDO_E2E_CHECKPOINT:game-complete" },
          ],
        },
      },
      {
        id: "pause-system",
        requirementIds: ["req-pause"],
        category: "player-control",
        description: "暂停时游戏时间停止流逝",
        verificationMethod: "unit",
        gdsTestPath: "res://tests/e2e.gd",
        checkNames: ["pause-stops-clock"],
      },
    ],
  };
}

describe("test-manifest v2", () => {
  test("validates complete automated requirement coverage and a core journey", () => {
    assert.strictEqual(validateTestManifest(completeManifest()), true);
  });
  test("rejects v1 and missing requirements", () => {
    assert.strictEqual(validateTestManifest({ schemaVersion: "deviludo.test-manifest.v1", features: [] }), false);
    assert.strictEqual(validateTestManifest({ schemaVersion: TEST_MANIFEST_SCHEMA_VERSION, requirements: [], features: [] }), false);
  });
  test("rejects manual-only coverage", () => {
    const manifest = completeManifest();
    const invalid = { ...manifest, features: manifest.features.map(feature => feature.id === "pause-system" ? { ...feature, verificationMethod: "manual", gdsTestPath: undefined, checkNames: undefined } : feature) };
    assert.strictEqual(validateTestManifest(invalid), false);
  });
  test("rejects a journey without all three required checkpoint roles", () => {
    const manifest = completeManifest();
    const journey = manifest.features[0];
    const invalid = { ...manifest, features: [{ ...journey, interactionScript: { version: "2", events: [{ type: "checkpoint", id: "only-start", role: "START" }] } }, manifest.features[1]] };
    assert.strictEqual(validateTestManifest(invalid), false);
  });
  test("rejects a wait-only core journey without a real user action", () => {
    const manifest = completeManifest();
    const journey = manifest.features[0];
    const events = journey.interactionScript?.events.filter(event => event.type !== "key_press" && event.type !== "key_release");
    assert.strictEqual(validateTestManifest({
      ...manifest,
      features: [{ ...journey, interactionScript: { version: "2", events } }, manifest.features[1]],
    }), false);
  });
  test("rejects a core journey whose screenshots do not assert their claimed game state", () => {
    const manifest = completeManifest();
    const journey = manifest.features[0];
    const events = journey.interactionScript?.events.map(event => event.type === "checkpoint"
      ? { type: event.type, id: event.id, role: event.role }
      : event);
    assert.strictEqual(validateTestManifest({
      ...manifest,
      features: [{ ...journey, interactionScript: { version: "2", events } }, manifest.features[1]],
    }), false);
  });
  test("rejects an unknown requirement mapping and unsafe test path", () => {
    const manifest = completeManifest();
    assert.strictEqual(validateTestManifest({ ...manifest, features: [{ ...manifest.features[0], requirementIds: ["req-missing"] }, manifest.features[1]] }), false);
    assert.strictEqual(validateTestManifest({ ...manifest, features: [manifest.features[0], { ...manifest.features[1], gdsTestPath: "res://../escape.gd" }] }), false);
  });
  test("derives stable requirement IDs from frozen specification lists", () => {
    const specification = { coreLoop: ["进入游戏"], acceptanceCriteria: ["可以获胜"] };
    const first = specificationRequirementCatalog(specification);
    const second = specificationRequirementCatalog(specification);
    assert.deepStrictEqual(first, second);
    assert.equal(first[0].requirementId, stableRequirementId("feature", 0, "进入游戏"));
    assert.equal(first.length, 2);
  });
  test("validates test execution results", () => {
    const result: TestExecutionResult = { suite: "deviludo", checks: ["pause-stops-clock"], failures: [], duration_ms: 127.3 };
    assert.strictEqual(validateTestExecutionResult(result), true);
    assert.strictEqual(validateTestExecutionResult({ ...result, checks: "invalid" }), false);
    assert.strictEqual(validateTestExecutionResult({ ...result, duration_ms: -1 }), false);
  });
});
