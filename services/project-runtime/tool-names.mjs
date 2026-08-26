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
