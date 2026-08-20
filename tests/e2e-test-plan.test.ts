import assert from "node:assert/strict";
import test from "node:test";
import { validateTestManifest } from "@/lib/product/test-manifest";
import { generateE2eTestPlan } from "@/services/core/src/e2e-test-plan";

test("the cross-platform E2E planner freezes regression, change-impact, UI, and materialized-asset coverage", async () => {
  const plan = await generateE2eTestPlan({
    context: Object.freeze({
      projectName: "Generic fixture",
      iterationNumber: 2,
      platform: "macos",
      approvedSpecification: Object.freeze({
        coreLoop: Object.freeze(["Start a session and complete one turn"]),
        acceptanceCriteria: Object.freeze(["The HUD updates after the player action"]),
      }),
      previousSpecification: Object.freeze({ coreLoop: Object.freeze(["Start a session"]) }),
      revisionNotes: Object.freeze(["Add the turn-completion action"]),
      regression: Object.freeze({ available: true, estimatedDurationMs: 5_000 }),
      assets: Object.freeze([
        Object.freeze({ assetKey: "ui/end-turn", materialized: true }),
        Object.freeze({ assetKey: "backgrounds/menu", materialized: true }),
      ]),
    }),
    runtime: "CLAUDE_CODE",
    baseUrl: "https://fixture.invalid",
    apiKey: "fixture-secret",
    model: "fixture-model",
    testFixture: true,
    fetchImpl: async () => { throw new Error("the provider must not be called for the explicit test fixture"); },
  });

  assert.equal(validateTestManifest(plan.testManifest), true);
  assert.deepEqual(plan.coverage.assetApplication, ["ui/end-turn", "backgrounds/menu"]);
  assert.ok(plan.coverage.regressionOperations.length > 0);
  assert.ok(plan.coverage.regressionUi.length > 0);
  assert.ok(plan.coverage.changeImpact.length > 0);
  assert.match(plan.testManifestDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(plan.contractDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(plan.executionPlan.plannedTimeoutMs >= 30 * 60_000);
});
