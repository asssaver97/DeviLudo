import assert from "node:assert";
import { describe, test } from "node:test";
import {
  TEST_MANIFEST_SCHEMA_VERSION,
  VERIFICATION_METHODS,
  FEATURE_CATEGORIES,
  validateTestManifest,
  validateTestExecutionResult,
  type TestManifest,
  type TestExecutionResult,
} from "../lib/product/test-manifest";

describe("test-manifest", () => {
  test("validates a complete test manifest", () => {
    const manifest: TestManifest = {
      schemaVersion: TEST_MANIFEST_SCHEMA_VERSION,
      features: [
        {
          id: "collect-ember",
          category: "core-loop",
          description: "玩家可以收集余烬道具",
          verificationMethod: "unit",
          gdsTestPath: "res://tests/e2e.gd",
          checkNames: ["collect-first-ember", "reject-duplicate-ember"],
        },
        {
          id: "pause-system",
          category: "player-control",
          description: "暂停时游戏时间停止流逝",
          verificationMethod: "unit",
          gdsTestPath: "res://tests/e2e.gd",
          checkNames: ["pause-stops-clock"],
        },
      ],
    };
    assert.strictEqual(validateTestManifest(manifest), true);
  });

  test("rejects invalid schema version", () => {
    const invalid = {
      schemaVersion: "wrong-version",
      features: [],
    };
    assert.strictEqual(validateTestManifest(invalid), false);
  });

  test("rejects non-array features", () => {
    const invalid = {
      schemaVersion: TEST_MANIFEST_SCHEMA_VERSION,
      features: "not-an-array",
    };
    assert.strictEqual(validateTestManifest(invalid), false);
  });

  test("rejects feature with invalid category", () => {
    const invalid = {
      schemaVersion: TEST_MANIFEST_SCHEMA_VERSION,
      features: [
        {
          id: "test",
          category: "invalid-category",
          description: "test",
          verificationMethod: "unit",
        },
      ],
    };
    assert.strictEqual(validateTestManifest(invalid), false);
  });

  test("rejects feature with invalid verification method", () => {
    const invalid = {
      schemaVersion: TEST_MANIFEST_SCHEMA_VERSION,
      features: [
        {
          id: "test",
          category: "core-loop",
          description: "test",
          verificationMethod: "invalid-method",
        },
      ],
    };
    assert.strictEqual(validateTestManifest(invalid), false);
  });

  test("accepts all valid verification methods", () => {
    for (const method of VERIFICATION_METHODS) {
      const manifest = {
        schemaVersion: TEST_MANIFEST_SCHEMA_VERSION,
        features: [
          {
            id: "test",
            category: "core-loop",
            description: "test",
            verificationMethod: method,
          },
        ],
      };
      assert.strictEqual(validateTestManifest(manifest), true, `Failed for method: ${method}`);
    }
  });

  test("accepts all valid categories", () => {
    for (const category of FEATURE_CATEGORIES) {
      const manifest = {
        schemaVersion: TEST_MANIFEST_SCHEMA_VERSION,
        features: [
          {
            id: "test",
            category,
            description: "test",
            verificationMethod: "unit",
          },
        ],
      };
      assert.strictEqual(validateTestManifest(manifest), true, `Failed for category: ${category}`);
    }
  });

  test("validates test execution result", () => {
    const result: TestExecutionResult = {
      suite: "deviludo-local-godot-e2e",
      checks: ["collect-first-ember", "reject-duplicate-ember"],
      failures: [],
      duration_ms: 127.3,
    };
    assert.strictEqual(validateTestExecutionResult(result), true);
  });

  test("rejects test result with non-array checks", () => {
    const invalid = {
      suite: "test",
      checks: "not-an-array",
      failures: [],
      duration_ms: 100,
    };
    assert.strictEqual(validateTestExecutionResult(invalid), false);
  });

  test("rejects test result with non-string check names", () => {
    const invalid = {
      suite: "test",
      checks: ["valid", 123],
      failures: [],
      duration_ms: 100,
    };
    assert.strictEqual(validateTestExecutionResult(invalid), false);
  });

  test("rejects test result without duration_ms", () => {
    const invalid = {
      suite: "test",
      checks: [],
      failures: [],
    };
    assert.strictEqual(validateTestExecutionResult(invalid), false);
  });
});
