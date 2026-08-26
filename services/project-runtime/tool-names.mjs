export const ROLE_TO_CANONICAL_TOOLS = Object.freeze({
  INTENT: Object.freeze(["context.read", "conversation.reply", "workflow.intent_decision", "workflow.stop", "workflow.continue"]),
  ANALYSIS: Object.freeze(["context.read", "source.list", "source.read", "diagnostics.run", "context.update_analysis", "conversation.reply"]),
  DESIGN: Object.freeze(["context.read", "requirements.update", "project_document.update", "e2e_goals.update", "conversation.reply", "handoff.create"]),
  DEVELOPMENT: Object.freeze(["context.read", "source.list", "source.read", "source.checkpoint", "assets.plan", "assets.cleanup", "build.request", "conversation.reply", "handoff.create"]),
  TEST: Object.freeze(["context.read", "source.list", "source.read", "test_plan.replace", "e2e.start", "e2e.observe", "evidence.read", "test.verdict", "conversation.reply", "handoff.create"]),
});

export function nativeToolName(canonicalName) {
  if (typeof canonicalName !== "string" || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(canonicalName)) {
    throw new Error("Canonical project Runtime tool name is invalid");
  }
  return canonicalName.replace(".", "_");
}

export function canonicalToolName(role, nativeName) {
  const tools = ROLE_TO_CANONICAL_TOOLS[role];
  if (!tools || typeof nativeName !== "string") return null;
  return tools.find(name => nativeToolName(name) === nativeName) ?? null;
}

export function toolInputSchema(canonicalName) {
  nativeToolName(canonicalName);
  if (canonicalName !== "context.update_analysis") {
    return Object.freeze({ type: "object", additionalProperties: true });
  }
  const text = (maxLength, minLength = 1) => Object.freeze({ type: "string", minLength, maxLength });
  const list = (minItems, maxItems) => Object.freeze({
    type: "array",
    minItems,
    maxItems,
    items: text(300),
  });
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["analysis"]),
    properties: Object.freeze({
      analysis: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze([
          "name", "introduction", "gameplay", "categories", "features", "coreLoop",
          "playerExperience", "acceptanceCriteria", "gameContent", "currentDevelopmentState",
          "completedWork", "remainingWork", "startupFlow", "startupIssues", "risks",
        ]),
        properties: Object.freeze({
          name: text(200, 2),
          introduction: text(20_000),
          gameplay: text(20_000),
          categories: list(1, 32),
          features: list(1, 32),
          coreLoop: list(1, 32),
          playerExperience: text(4_000),
          acceptanceCriteria: list(1, 32),
          gameContent: text(4_000),
          currentDevelopmentState: text(4_000),
          completedWork: list(0, 32),
          remainingWork: list(0, 32),
          startupFlow: text(4_000),
          startupIssues: list(0, 32),
          risks: list(0, 32),
        }),
      }),
    }),
  });
}
