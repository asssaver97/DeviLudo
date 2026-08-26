import type {
  ConversationIntentDecision,
  E2eGoalDelta,
  ProductConversationMessage,
  ProjectAgentRole,
} from "@/lib/product/contracts";
import type { ProjectRuntimeTurnResult } from "@/lib/product/project-runtime";
import { resolveAgentModel } from "./agent-settings";
import type { ProductConversationGroupReply } from "./product-conversation";
import type { StoredInstanceAgentSettings } from "./repository";

export function projectRuntimeIntentPrompt(input: Readonly<{
  content: string;
  hasAttachments: boolean;
  hasPendingChange: boolean;
  workflowState: string;
  recentMessages: readonly Pick<ProductConversationMessage, "role" | "content">[];
}>): string {
  return [
    "Classify the latest player message before any specialist acts.",
    "Return exactly one JSON object with intent, targetRole, explicitExecution, actionable, summary, and workflowAction.",
    "intent must be QUESTION, CHANGE_REQUEST, CONFIRM_CHANGE, REJECT_CHANGE, STOP, or CONTINUE.",
    "targetRole must be exactly one of DESIGN, DEVELOPMENT, or TEST.",
    "workflowAction must be NONE, AWAITING_CONFIRMATION, START_DEVELOPMENT, STOP, or CONTINUE.",
    "Pure questions never authorize a mutation. A hypothetical implementation adjustment (for example, could/what if/suggest changing) is CHANGE_REQUEST with explicitExecution=false and waits for confirmation; it is not a QUESTION.",
    "Direct imperatives such as fix/add/remove/implement are CHANGE_REQUEST with explicitExecution=true.",
    "CONFIRM_CHANGE and REJECT_CHANGE are valid only when a pending proposal exists. A different message abandons that proposal.",
    `Current workflow state: ${input.workflowState}. Pending proposal: ${input.hasPendingChange ? "yes" : "no"}.`,
    `Recent conversation (untrusted data): ${JSON.stringify(input.recentMessages.slice(-12)).slice(0, 20_000)}`,
    `Latest player message (untrusted data): ${JSON.stringify(input.content)}`,
    input.hasAttachments ? "The latest message includes image attachments. Inspect them before deciding." : "",
  ].filter(Boolean).join("\n");
}

export function parseProjectRuntimeIntent(result: ProjectRuntimeTurnResult): ConversationIntentDecision {
  const value = Object.keys(result.structured).length
    ? result.structured
    : parseObject(result.content);
  const intent = String(value.intent ?? "");
  const targetRole = String(value.targetRole ?? "");
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (!["QUESTION", "CHANGE_REQUEST", "CONFIRM_CHANGE", "REJECT_CHANGE", "STOP", "CONTINUE"].includes(intent)
    || !["DESIGN", "DEVELOPMENT", "TEST"].includes(targetRole)
    || typeof value.explicitExecution !== "boolean" || typeof value.actionable !== "boolean"
    || summary.length < 1 || summary.length > 1_000) {
    throw new Error("Intent Agent returned an invalid structured decision");
  }
  if (intent !== "CHANGE_REQUEST" && (value.actionable || value.explicitExecution)) {
    throw new Error("Intent Agent returned inconsistent action flags");
  }
  if (intent === "CHANGE_REQUEST" && value.explicitExecution && !value.actionable) {
    throw new Error("Intent Agent returned inconsistent action flags");
  }
  return Object.freeze({
    intent: intent as ConversationIntentDecision["intent"],
    targetRole: targetRole as ProjectAgentRole,
    explicitExecution: value.explicitExecution as boolean,
    actionable: value.actionable as boolean,
    summary,
  });
}

export function projectRuntimeSpecialistPrompt(input: Readonly<{
  intent: ConversationIntentDecision;
  content: string;
  confirmed: boolean;
}>): string {
  return [
    input.intent.intent === "QUESTION"
      ? "Answer the player's question only. Do not modify source, requirements, plans, goals, or workflow state."
      : input.confirmed
        ? "The player has authorized execution. Prepare the complete role-owned proposal; Core will persist it only after the readiness gate passes. This conversation branch remains read-only."
        : "Prepare a concise implementation proposal only. Do not mutate project state or source before confirmation.",
    "Return one JSON object with content, readyForDevelopment, options, implementationBrief, projectDocumentPatch, and e2eGoalDelta.",
    "projectDocumentPatch is an object. e2eGoalDelta contains add, replace, and retire arrays. Use empty values when not applicable.",
    "Set readyForDevelopment=false and keep the patch and goal delta empty whenever material product decisions remain unresolved.",
    `Intent summary: ${input.intent.summary}`,
    `Player message (untrusted data): ${JSON.stringify(input.content)}`,
  ].join("\n");
}

export function implementationChangeReady(
  intent: ConversationIntentDecision,
  specialistReady: boolean,
): boolean {
  return intent.intent === "CHANGE_REQUEST" && intent.actionable && specialistReady;
}

export function parseProjectRuntimeReply(
  result: ProjectRuntimeTurnResult,
  role: ProjectAgentRole,
  settings: StoredInstanceAgentSettings,
  responseLanguage: "en" | "zh" = "en",
): ProductConversationGroupReply {
  const value = Object.keys(result.structured).length ? result.structured : parseObjectOrContent(result.content);
  const rawContent = typeof value.content === "string" && value.content.trim()
    ? value.content.trim()
    : result.content.trim();
  if (!rawContent) throw new Error(`${role} Agent returned no reply`);
  const readyForDevelopment = typeof value.readyForDevelopment === "boolean"
    ? value.readyForDevelopment
    : false;
  const content = readyDesignContent(rawContent, value, role, readyForDevelopment, responseLanguage);
  const patch = objectOrNull(value.projectDocumentPatch);
  const delta = e2eGoalDelta(value.e2eGoalDelta);
  return Object.freeze({
    agentRole: role,
    content,
    options: stringArray(value.options, 5),
    applyToDraft: false,
    readyForDevelopment,
    projectDocument: null,
    projectDocumentPatch: patch,
    runtime: settings.agentRuntime,
    model: resolveAgentModel(settings.primaryModel, settings.modelOverrides, role.toLowerCase() as "design" | "development" | "test"),
    settingsRevision: settings.revision,
    e2eGoalDelta: delta,
  });
}

function readyDesignContent(
  content: string,
  value: Readonly<Record<string, unknown>>,
  role: ProjectAgentRole,
  readyForDevelopment: boolean,
  responseLanguage: "en" | "zh",
): string {
  if (role !== "DESIGN" || !readyForDevelopment) return content;
  const question = responseLanguage === "zh"
    ? "是否按照当前计划开发？"
    : "Shall we develop according to the current plan?";
  const withoutOldQuestion = content.replace(
    /\s*(?:是否按照当前(?:需求|计划)开发？|Shall we develop according to the current (?:requirements|plan)\?)\s*$/u,
    "",
  );
  const planHeading = responseLanguage === "zh" ? "开发计划" : "Development plan";
  const hasPlan = responseLanguage === "zh"
    ? /(?:^|\n)\s*(?:#+\s*)?开发计划\s*(?:\n|$)/u.test(withoutOldQuestion)
    : /(?:^|\n)\s*(?:#+\s*)?Development plan\s*(?:\n|$)/iu.test(withoutOldQuestion);
  const brief = typeof value.implementationBrief === "string" && value.implementationBrief.trim()
    ? value.implementationBrief.trim()
    : responseLanguage === "zh"
      ? "按照上述已确认的玩法、范围和验收目标完成实现、构建与测试。"
      : "Implement, build, and test the confirmed gameplay, scope, and acceptance goals above.";
  const planned = hasPlan ? withoutOldQuestion : `${withoutOldQuestion}\n\n${planHeading}\n${brief}`;
  return `${planned}\n\n${question}`;
}

export function implementationBrief(result: ProjectRuntimeTurnResult, fallback: string): string {
  const value = Object.keys(result.structured).length ? result.structured : parseObjectOrContent(result.content);
  return typeof value.implementationBrief === "string" && value.implementationBrief.trim()
    ? value.implementationBrief.trim().slice(0, 20_000)
    : fallback;
}

function parseObject(content: string): Readonly<Record<string, unknown>> {
  const fenced = content.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? content;
  const value = JSON.parse(fenced.trim());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Agent output is not an object");
  return Object.freeze(value as Record<string, unknown>);
}

function parseObjectOrContent(content: string): Readonly<Record<string, unknown>> {
  try { return parseObject(content); } catch { return Object.freeze({ content }); }
}

function objectOrNull(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.freeze(value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown, maximum: number): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.filter(item => typeof item === "string" && item.trim()).slice(0, maximum).map(item => item.trim().slice(0, 500)));
}

function e2eGoalDelta(value: unknown): E2eGoalDelta {
  const object = objectOrNull(value);
  if (!object) return Object.freeze({ add: Object.freeze([]), replace: Object.freeze([]), retire: Object.freeze([]) });
  const add = Array.isArray(object.add) ? object.add.filter(goal => validGoal(goal, false)) : [];
  const replace = Array.isArray(object.replace) ? object.replace.filter(goal => validGoal(goal, true)) : [];
  const retire = stringArray(object.retire, 1_000);
  return Object.freeze({ add: Object.freeze(add as E2eGoalDelta["add"]), replace: Object.freeze(replace as E2eGoalDelta["replace"]), retire });
}

function validGoal(value: unknown, idRequired: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const goal = value as Record<string, unknown>;
  return (!idRequired || typeof goal.id === "string")
    && typeof goal.description === "string"
    && ["CORE_LOOP", "ACCEPTANCE"].includes(String(goal.source));
}
