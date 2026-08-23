import assert from "node:assert/strict";
import test from "node:test";
import { classifyConversationIntent, parseConversationIntent } from "../services/core/src/conversation-intent";
import { e2eGoalsDigest, mergeE2eGoals } from "../services/core/src/e2e-goals";

test("Intent Agent validates structure and safely normalizes inconsistent action flags", () => {
  const question = parseConversationIntent(JSON.stringify({
    intent: "QUESTION",
    explicitExecution: false,
    actionable: false,
    responderRoles: ["DEVELOPMENT", "TEST"],
    summary: "Explain the current E2E failure without modifying the project.",
  }));
  assert.equal(question.intent, "QUESTION");
  assert.deepEqual(question.responderRoles, ["DEVELOPMENT", "TEST"]);

  assert.deepEqual(parseConversationIntent(JSON.stringify({
    intent: "QUESTION",
    explicitExecution: true,
    actionable: true,
    responderRoles: ["DEVELOPMENT"],
    summary: "Invalid question mutation",
  })), {
    intent: "QUESTION",
    explicitExecution: false,
    actionable: false,
    responderRoles: ["DEVELOPMENT"],
    summary: "Invalid question mutation",
  });
  assert.deepEqual(parseConversationIntent(JSON.stringify({
    intent: "CHANGE_REQUEST",
    explicitExecution: true,
    actionable: false,
    responderRoles: ["DEVELOPMENT"],
    summary: "Cannot execute an unactionable request",
  })), {
    intent: "CHANGE_REQUEST",
    explicitExecution: false,
    actionable: false,
    responderRoles: ["DEVELOPMENT"],
    summary: "Cannot execute an unactionable request",
  });
  assert.throws(() => parseConversationIntent("{\"intent\":\"QUESTION\"}"), /invalid decision/);
});

test("Intent Agent inspects conversation images before routing the message", async () => {
  let latestContent: unknown;
  const decision = await classifyConversationIntent({
    content: "请判断截图是在提问还是要求修改。",
    images: Object.freeze([{ contentType: "image/webp" as const, dataBase64: "UklGRg==" }]),
    history: Object.freeze([]),
    project: Object.freeze({
      name: "视觉意图",
      concept: "验证图片意图路由",
      workflowState: "DRAFT",
      specification: Object.freeze({}),
      document: Object.freeze({ introduction: "视觉意图", gameplay: "检查截图", categories: [], features: [] }),
      analysisStatus: "READY" as const,
      discovery: null,
    }),
    pendingChange: null,
    settings: Object.freeze({
      agentRuntime: "CLAUDE_CODE" as const,
      baseUrl: "https://provider.example/v1",
      primaryModel: "claude-primary",
      modelOverrides: Object.freeze({ design: null, development: null, test: null, image: null }),
      revision: 1,
    }),
    apiKey: "sk-test-secret",
    responseLanguage: "zh",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: readonly { content: unknown }[] };
      latestContent = body.messages[0]?.content;
      return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({
        intent: "QUESTION",
        explicitExecution: false,
        actionable: false,
        responderRoles: ["DESIGN"],
        summary: "Answer without changing the project.",
      }) }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(decision.intent, "QUESTION");
  assert.deepEqual((latestContent as readonly Record<string, unknown>[]).map(item => item.type), ["text", "image"]);
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
