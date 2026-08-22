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
        Object.freeze({
          assetKey: "ui/end-turn", materialized: true,
          expectedResourcePath: "res://assets/generated/ui/end-turn.png",
          expectedSha256: `sha256:${"a".repeat(64)}`,
        }),
        Object.freeze({
          assetKey: "backgrounds/menu", materialized: true,
          expectedResourcePath: "res://assets/generated/backgrounds/menu.webp",
          expectedSha256: `sha256:${"b".repeat(64)}`,
        }),
      ]),
      assetUsageManifest: Object.freeze({
        schemaVersion: "deviludo.asset-manifest.v1",
        items: Object.freeze([
          Object.freeze({
            assetKey: "ui/end-turn",
            usageTargets: Object.freeze([{ targetId: "end-turn-button", checkpointRole: "ACTION" }]),
          }),
          Object.freeze({
            assetKey: "backgrounds/menu",
            usageTargets: Object.freeze([{ targetId: "start-screen-background", checkpointRole: "START" }]),
          }),
        ]),
      }),
    }),
    runtime: "CLAUDE_CODE",
    baseUrl: "https://fixture.invalid",
    apiKey: "fixture-secret",
    model: "fixture-model",
    testFixture: true,
    fetchImpl: async () => { throw new Error("the provider must not be called for the explicit test fixture"); },
  });

  assert.equal(validateTestManifest(plan.testManifest), true);
  assert.deepEqual(plan.coverage.assetApplication, ["backgrounds/menu", "ui/end-turn"]);
  assert.deepEqual(plan.assetPlacementPlan.unmappedAssetKeys, []);
  assert.deepEqual(plan.assetPlacementPlan.placements.map(item => [
    item.assetKey, item.targetId, item.checkpointRole, item.expectedResourcePath,
  ]), [
    ["backgrounds/menu", "start-screen-background", "START", "res://assets/generated/backgrounds/menu.webp"],
    ["ui/end-turn", "end-turn-button", "ACTION", "res://assets/generated/ui/end-turn.png"],
  ]);
  assert.ok(plan.coverage.regressionOperations.length > 0);
  assert.ok(plan.coverage.regressionUi.length > 0);
  assert.ok(plan.coverage.changeImpact.length > 0);
  assert.match(plan.testManifestDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(plan.contractDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(plan.executionPlan.plannedTimeoutMs >= 30 * 60_000);
});

test("the cross-platform E2E planner exposes missing planned asset-to-control mappings as a product gate", async () => {
  const plan = await generateE2eTestPlan({
    context: Object.freeze({
      ...planningContext(),
      assets: Object.freeze([Object.freeze({
        assetKey: "ui/start-panel", materialized: true,
        expectedResourcePath: "res://assets/generated/ui/start-panel.png",
      })]),
    }),
    runtime: "CODEX_CLI",
    baseUrl: "https://fixture.invalid",
    apiKey: "{}",
    model: "fixture-model",
    testFixture: true,
  });
  assert.deepEqual(plan.assetPlacementPlan.plannedAssetKeys, ["ui/start-panel"]);
  assert.deepEqual(plan.assetPlacementPlan.placements, []);
  assert.deepEqual(plan.assetPlacementPlan.unmappedAssetKeys, ["ui/start-panel"]);
});

test("the cross-platform E2E planner does not multiply Provider or CLI failures", async () => {
  let attempts = 0;
  await assert.rejects(generateE2eTestPlan({
    context: planningContext(),
    runtime: "CODEX_CLI",
    baseUrl: "https://fixture.invalid",
    apiKey: "{}",
    model: "fixture-model",
    codexRunner: async input => {
      attempts += 1;
      assert.equal(input.reasoningEffort, "low");
      assert.equal(input.timeoutMs, 360_000);
      assert.deepEqual(input.outputSchema?.required, ["semanticJourney", "coverage"]);
      assert.deepEqual(
        (input.outputSchema?.properties as Record<string, Record<string, unknown>>)?.semanticJourney?.required,
        ["startAction", "startRequirementIds", "coreActions"],
      );
      assert.deepEqual(
        (input.outputSchema?.properties as Record<string, Record<string, unknown>>)?.coverage?.required,
        ["regressionOperations", "regressionUi", "changeImpact", "assetApplication"],
      );
      assert.doesNotMatch(JSON.stringify(input.outputSchema), /uniqueItems/);
      assert.match(input.prompt, /Return only one JSON object shaped \{semanticJourney,coverage\}/);
      throw new Error("fixture Provider unavailable");
    },
  }), /Test Agent provider request failed: fixture Provider unavailable/);
  assert.equal(attempts, 1);
});

test("the cross-platform E2E planner rejects invented generic controls when the Provider plan is invalid", async () => {
  let attempts = 0;
  await assert.rejects(generateE2eTestPlan({
    context: planningContext(),
    runtime: "CODEX_CLI",
    baseUrl: "https://fixture.invalid",
    apiKey: "{}",
    model: "fixture-model",
    codexRunner: async () => {
      attempts += 1;
      return "{}";
    },
  }), /Test Agent returned an invalid project plan/);
  assert.equal(attempts, 1);
});

test("the cross-platform E2E planner never executes generic semantic controls as a product plan", async () => {
  await assert.rejects(generateE2eTestPlan({
    context: planningContext(),
    runtime: "CODEX_CLI",
    baseUrl: "https://fixture.invalid",
    apiKey: "{}",
    model: "fixture-model",
    codexRunner: async () => JSON.stringify({
      semanticJourney: semanticJourney("new-game", ["primary-control", "game-viewport", "complete-loop"]),
      coverage: planningCoverage(),
    }),
  }), /plan still contains schema-template controls/);
});

test("the cross-platform E2E planner rejects a start-primary-end shortcut without intermediate play", async () => {
  await assert.rejects(generateE2eTestPlan({
    context: planningContext(),
    runtime: "CODEX_CLI",
    baseUrl: "https://fixture.invalid",
    apiKey: "{}",
    model: "fixture-model",
    codexRunner: async () => JSON.stringify({
      semanticJourney: {
        startAction: semanticAction("start-campaign"),
        startRequirementIds: ["req-feature-001-fb00a811"],
        coreActions: [
          { action: semanticAction("roll-dice"), progressKey: "move-budget", changeTargetId: "roll-dice", coversRequirementIds: ["req-feature-001-fb00a811"] },
          { action: semanticAction("end-turn-button"), progressKey: "campaign-turn", changeTargetId: "end-turn-button", coversRequirementIds: ["req-acceptance-001-213f5922"] },
        ],
      },
      coverage: planningCoverage(),
    }),
  }), /invalid project plan/);
});

test("the cross-platform E2E planner deterministically repairs a semantic journey envelope", async () => {
  const plan = await generateE2eTestPlan({
    context: planningContext(),
    runtime: "CODEX_CLI",
    baseUrl: "https://fixture.invalid",
    apiKey: "{}",
    model: "fixture-model",
    codexRunner: async () => JSON.stringify({
      semanticJourney: semanticJourney("start-campaign", ["territory-board", "confirm-territory", "end-turn-button"]),
      coverage: planningCoverage(),
    }),
  });
  assert.equal(validateTestManifest(plan.testManifest), true);
  assert.deepEqual(plan.testManifest.requirements.map(item => item.requirementId), [
    "req-feature-001-fb00a811",
    "req-acceptance-001-213f5922",
  ]);
  assert.match(JSON.stringify(plan.testManifest), /"targetId":"territory-board"/);
  assert.doesNotMatch(JSON.stringify(plan.testManifest), /"targetId":"(?:primary-control|complete-loop)"|fixture-/);
});

test("the cross-platform E2E planner gives the Test Agent one bounded correction for omitted frozen requirements", async () => {
  let attempts = 0;
  const plan = await generateE2eTestPlan({
    context: planningContext(),
    runtime: "CODEX_CLI",
    baseUrl: "https://fixture.invalid",
    apiKey: "{}",
    model: "fixture-model",
    codexRunner: async input => {
      attempts += 1;
      if (attempts === 1) {
        return JSON.stringify({
          semanticJourney: {
            ...semanticJourney("start-campaign", ["territory-board", "confirm-territory", "end-turn-button"]),
            startRequirementIds: [],
            coreActions: semanticJourney(
              "start-campaign", ["territory-board", "confirm-territory", "end-turn-button"],
            ).coreActions.map(item => ({ ...item, coversRequirementIds: ["req-feature-001-fb00a811"] })),
          },
          coverage: planningCoverage(),
        });
      }
      assert.equal(input.timeoutMs, 180_000);
      assert.match(input.prompt, /failed frozen-requirement coverage validation/);
      assert.match(input.prompt, /req-acceptance-001-213f5922/);
      return JSON.stringify({
        semanticJourney: semanticJourney("start-campaign", ["territory-board", "confirm-territory", "end-turn-button"]),
        coverage: planningCoverage(),
      });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(validateTestManifest(plan.testManifest), true);
});

test("the cross-platform E2E planner prefers the prior successful regression region for visual progress", async () => {
  const plan = await generateE2eTestPlan({
    context: Object.freeze({
      ...planningContext(),
      regressionTrace: Object.freeze({
        schema: "deviludo.e2e-regression",
        actions: Object.freeze([
          Object.freeze({ type: "click", targetId: "start-campaign" }),
          Object.freeze({ type: "click", targetId: "campaign-board" }),
          Object.freeze({ type: "click", targetId: "end-turn-button" }),
        ]),
        successAssertions: Object.freeze([{ source: "PROGRESS", key: "campaign-turn", operator: "CHANGED" }]),
      }),
    }),
    runtime: "CODEX_CLI",
    baseUrl: "https://fixture.invalid",
    apiKey: "{}",
    model: "fixture-model",
    codexRunner: async () => JSON.stringify({
      semanticJourney: semanticJourney("start-campaign", ["roll-dice", "campaign-board", "end-turn-button"], [
        "move-budget", "campaign-position", "campaign-turn",
      ], ["tiny-roll-indicator", "campaign-board", "end-turn-button"]),
      coverage: planningCoverage(),
    }),
  });
  const feature = plan.testManifest.features[0];
  assert.ok(feature);
  assert.ok(feature.interactionScript);
  const progress = feature.interactionScript.events.find(event => event.type === "checkpoint" && event.role === "PROGRESS");
  assert.ok(progress?.type === "checkpoint");
  assert.equal(progress.changeTargetId, "campaign-board");
});

test("the cross-platform E2E planner revalidates and reuses a matching project semantic contract", async () => {
  const fixture = await generateE2eTestPlan({
    context: planningContext(),
    runtime: "CODEX_CLI",
    baseUrl: "https://fixture.invalid",
    apiKey: "{}",
    model: "fixture-model",
    codexRunner: async () => JSON.stringify({
      semanticJourney: semanticJourney("start-campaign", ["territory-board", "confirm-territory", "end-turn-button"]),
      coverage: planningCoverage(),
    }),
  });
  let attempts = 0;
  const plan = await generateE2eTestPlan({
    context: Object.freeze({ ...planningContext(), projectTestContract: fixture.testManifest }),
    runtime: "CODEX_CLI",
    baseUrl: "https://fixture.invalid",
    apiKey: "{}",
    model: "fixture-model",
    codexRunner: async () => {
      attempts += 1;
      throw new Error("a validated project contract must not be replaced by invented controls");
    },
  });
  assert.equal(attempts, 0);
  assert.deepEqual(plan.testManifest, fixture.testManifest);
  assert.equal(validateTestManifest(plan.testManifest), true);
});

function planningContext() {
  return Object.freeze({
    projectName: "Generic fixture",
    iterationNumber: 1,
    platform: "macos",
    approvedSpecification: Object.freeze({
      coreLoop: Object.freeze(["Start a session and complete one turn"]),
      acceptanceCriteria: Object.freeze(["The HUD updates after the player action"]),
    }),
    previousSpecification: null,
    revisionNotes: Object.freeze([]),
    regression: Object.freeze({ available: false }),
    assets: Object.freeze([]),
  });
}

function semanticAction(targetId: string) {
  return { type: "click", targetId, key: null, button: null, durationMs: null };
}

function semanticJourney(
  startTargetId: string,
  actionTargetIds: readonly string[],
  progressKeys: readonly string[] = ["campaign-action", "campaign-confirmation", "campaign-turn"],
  changeTargetIds: readonly string[] = actionTargetIds,
) {
  const requirementIds = ["req-feature-001-fb00a811", "req-acceptance-001-213f5922"];
  return {
    startAction: semanticAction(startTargetId),
    startRequirementIds: [requirementIds[0]],
    coreActions: actionTargetIds.map((targetId, index) => ({
      action: semanticAction(targetId),
      progressKey: progressKeys[index],
      changeTargetId: changeTargetIds[index],
      coversRequirementIds: [requirementIds[Math.min(index, requirementIds.length - 1)]],
    })),
  };
}

function planningCoverage() {
  return {
    regressionOperations: ["Start and complete one turn"],
    regressionUi: ["Verify the campaign HUD"],
    changeImpact: ["Verify the current core loop"],
    assetApplication: ["No materialized image assets are present in this build"],
  };
}
