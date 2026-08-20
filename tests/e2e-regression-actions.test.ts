import assert from "node:assert/strict";
import { test } from "node:test";
import { plannedCoreRegressionCandidates } from "../scripts/e2e-regression-actions.mjs";

test("planned regression candidates retain only replay-safe core journey fields and postconditions", () => {
  const changed = [{ source: "PROGRESS", key: "turn_number", operator: "CHANGED" }];
  const candidates = plannedCoreRegressionCandidates({
    features: [{
      id: "core-loop",
      coreJourney: true,
      verificationMethod: "interactive",
      launchProfile: { type: "FRESH" },
      timeoutMs: 120_000,
      interactionScript: { events: [
        { type: "checkpoint", id: "start" },
        {
          type: "click", stepId: "start-game", intent: "START_SESSION",
          targetId: "new-game", button: "LEFT", delay_ms: 400,
          coversRequirementIds: ["req-1"], postconditions: changed,
        },
        { type: "wait", delay_ms: 500 },
        {
          type: "key_hold", stepId: "move", intent: "PRIMARY_ACTION",
          key: "KEY_RIGHT", duration_ms: 250, delay_ms: 100,
          coversRequirementIds: ["req-1"], postconditions: changed,
        },
      ] },
    }],
  });

  assert.deepEqual(candidates, [{
    source: "PLANNED_CORE_JOURNEY",
    estimatedDurationMs: 120_000,
    actions: [
      { type: "click", targetId: "new-game", button: "LEFT", postconditions: changed },
      { type: "key_hold", key: "KEY_RIGHT", duration_ms: 250, postconditions: changed },
    ],
  }]);
});

test("planned regression candidates ignore non-core and scenario journeys", () => {
  assert.deepEqual(plannedCoreRegressionCandidates({ features: [
    { coreJourney: false, verificationMethod: "interactive", launchProfile: { type: "FRESH" }, interactionScript: { events: [] } },
    { coreJourney: true, verificationMethod: "interactive", launchProfile: { type: "SCENARIO" }, interactionScript: { events: [] } },
  ] }), []);
});
