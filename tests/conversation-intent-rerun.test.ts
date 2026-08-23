import assert from "node:assert/strict";
import test from "node:test";
import { parseConversationIntent } from "../services/core/src/conversation-intent";
import { e2eGoalsDigest, mergeE2eGoals } from "../services/core/src/e2e-goals";

test("Intent Agent accepts only internally consistent structured decisions", () => {
  const question = parseConversationIntent(JSON.stringify({
    intent: "QUESTION",
    explicitExecution: false,
    actionable: false,
    responderRoles: ["DEVELOPMENT", "TEST"],
    summary: "Explain the current E2E failure without modifying the project.",
  }));
  assert.equal(question.intent, "QUESTION");
  assert.deepEqual(question.responderRoles, ["DEVELOPMENT", "TEST"]);

  assert.throws(() => parseConversationIntent(JSON.stringify({
    intent: "QUESTION",
    explicitExecution: true,
    actionable: true,
    responderRoles: ["DEVELOPMENT"],
    summary: "Invalid question mutation",
  })), /inconsistent action flags/);
  assert.throws(() => parseConversationIntent(JSON.stringify({
    intent: "CHANGE_REQUEST",
    explicitExecution: true,
    actionable: false,
    responderRoles: ["DEVELOPMENT"],
    summary: "Cannot execute an unactionable request",
  })), /inconsistent action flags/);
  assert.throws(() => parseConversationIntent("{\"intent\":\"QUESTION\"}"), /invalid decision/);
});

test("E2E goal revisions retain non-conflicting goals and explicitly replace or retire IDs", () => {
  const current = Object.freeze([
    Object.freeze({ id: "goal-a", description: "Player can start a new game", source: "CORE_LOOP" as const }),
    Object.freeze({ id: "goal-b", description: "Keyboard completes one turn", source: "ACCEPTANCE" as const }),
  ]);
  const specification = Object.freeze({
    coreLoop: Object.freeze(["Player can start a new game"]),
    acceptanceCriteria: Object.freeze([
      "Controller completes one turn",
      "Frame pacing remains smooth during gameplay",
    ]),
  });
  const merged = mergeE2eGoals(current, Object.freeze({
    add: Object.freeze([Object.freeze({
      description: "Frame pacing remains smooth during gameplay",
      source: "ACCEPTANCE" as const,
    })]),
    replace: Object.freeze([Object.freeze({
      id: "goal-b",
      description: "Controller completes one turn",
      source: "ACCEPTANCE" as const,
    })]),
    retire: Object.freeze([]),
  }), specification);

  assert.equal(merged.find(goal => goal.id === "goal-a")?.description, "Player can start a new game");
  assert.equal(merged.find(goal => goal.id === "goal-b")?.description, "Controller completes one turn");
  assert.equal(merged.filter(goal => goal.description.includes("Frame pacing")).length, 1);
  assert.match(e2eGoalsDigest(merged), /^sha256:[0-9a-f]{64}$/);

  assert.throws(() => mergeE2eGoals(current, Object.freeze({
    add: Object.freeze([]), replace: Object.freeze([]), retire: Object.freeze(["unknown-goal"]),
  }), specification), /unknown or duplicate E2E goal id/);
});
