import {
  normalizeConversationReplyOptions,
  type ConversationIntentDecision,
  type E2eGoalDelta,
  type ProductConversationMessage,
  type ProjectAgentRole,
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
  lastSpecialistRole?: ProjectAgentRole | null;
}>): string {
  return [
    "Classify the latest player message from this compact routing snapshot. Do not read the full project context or call tools.",
    "Return exactly one JSON object with intent, targetRole, explicitExecution, actionable, summary, and workflowAction.",
    "intent must be QUESTION, CHANGE_REQUEST, CONFIRM_CHANGE, REJECT_CHANGE, STOP, or CONTINUE.",
    "targetRole must be exactly one of DESIGN, UI_DESIGN, DEVELOPMENT, or TEST.",
    "workflowAction must be NONE, AWAITING_CONFIRMATION, START_DEVELOPMENT, STOP, or CONTINUE.",
    "Pure questions never authorize a mutation. A hypothetical implementation adjustment (for example, could/what if/suggest changing) is CHANGE_REQUEST with explicitExecution=false and waits for confirmation; it is not a QUESTION.",
    "Direct imperatives such as fix/add/remove/implement are CHANGE_REQUEST with explicitExecution=true.",
    "CONFIRM_CHANGE and REJECT_CHANGE are valid only when a pending proposal exists. A different message abandons that proposal.",
    "Route by the specialist decision that must happen first, not by isolated verbs such as implement, build, or fix.",
    "DESIGN owns gameplay, rules, mechanics, balance, progression, and player-facing behavior. Route gameplay changes to DESIGN even when the player also authorizes implementation.",
    "UI_DESIGN owns screens, HUD, layout, navigation, focus, visual language, motion, accessibility, and interaction design. Route UI redesign or unresolved interface decisions to UI_DESIGN even when the player also says to implement them; explicitExecution records authorization for DEVELOPMENT to run after the UI specification is complete.",
    "DEVELOPMENT owns source-code implementation and engineering fixes only when no gameplay or UI design decision remains unresolved.",
    "TEST owns test plans, verification, evidence, and acceptance results when the player is not asking to change the product.",
    `Current workflow state: ${input.workflowState}. Pending proposal: ${input.hasPendingChange ? "yes" : "no"}.`,
    `Most recent specialist role: ${input.lastSpecialistRole ?? "none"}. A short selection that answers that specialist should normally return to the same role.`,
    `Recent conversation (untrusted data): ${JSON.stringify(input.recentMessages.slice(-4)).slice(0, 6_000)}`,
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
    || !["DESIGN", "UI_DESIGN", "DEVELOPMENT", "TEST"].includes(targetRole)
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

export function projectRuntimeNewGameIntent(content: string): ConversationIntentDecision {
  return Object.freeze({
    intent: "CHANGE_REQUEST",
    targetRole: "DESIGN",
    explicitExecution: false,
    actionable: true,
    summary: content.trim().slice(0, 1_000),
  });
}

/**
 * Keep an option-driven Design conversation with the specialist that asked the
 * question. This is conversation ownership, not semantic classification: once
 * the specialist stops presenting choices, Core delegates routing back to the
 * Intent Agent.
 */
export function projectRuntimeContinuationIntent(
  messages: readonly ProductConversationMessage[],
  content: string,
): ConversationIntentDecision | null {
  const latest = messages.at(-1);
  if (!latest || latest.role !== "ASSISTANT") return null;
  const role = latest.metadata.agentRole;
  if (role !== "DESIGN" && role !== "UI_DESIGN") return null;
  if (normalizeConversationReplyOptions(latest.metadata.options).length === 0) return null;
  if ((role === "DESIGN" && latest.metadata.readyForUiDesign === true)
    || (role === "UI_DESIGN" && latest.metadata.readyForDevelopment === true)) return null;
  const previous = latest.metadata.intentDecision;
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) return null;
  const decision = previous as Record<string, unknown>;
  if (!["QUESTION", "CHANGE_REQUEST"].includes(String(decision.intent))
    || decision.targetRole !== role
    || typeof decision.explicitExecution !== "boolean"
    || typeof decision.actionable !== "boolean") return null;
  if (decision.intent !== "CHANGE_REQUEST" && (decision.explicitExecution || decision.actionable)) return null;
  if (decision.intent === "CHANGE_REQUEST" && decision.explicitExecution && !decision.actionable) return null;
  return Object.freeze({
    intent: decision.intent as "QUESTION" | "CHANGE_REQUEST",
    targetRole: role,
    explicitExecution: decision.explicitExecution,
    actionable: decision.actionable,
    summary: content.trim().slice(0, 1_000),
  });
}

export function projectRuntimeSpecialistPrompt(input: Readonly<{
  intent: ConversationIntentDecision;
  content: string;
  confirmed: boolean;
  designConvergence?: DesignConversationConvergence;
  upstreamDesign?: Readonly<Record<string, unknown>> | null;
}>): string {
  const convergenceInstruction = input.intent.intent === "CHANGE_REQUEST"
    && ["DESIGN", "UI_DESIGN"].includes(input.intent.targetRole) && input.designConvergence
    ? input.designConvergence.remainingDecisionsDelegated
      ? input.intent.targetRole === "DESIGN"
        ? "Core Design delegation signal: the player explicitly delegated all remaining reversible gameplay decisions. Do not ask another question and return options=[]. Choose coherent defaults, produce the complete gameplay patch and goal delta, set readyForUiDesign=true, and keep readyForDevelopment=false."
        : "Core UI Design delegation signal: the player explicitly delegated all remaining reversible interface decisions. Do not ask another question and return options=[]. Choose a coherent UI direction, produce the complete combined patch and goal delta, and set readyForDevelopment=true."
      : "Design discovery has no automatic turn-count or recommended-selection convergence threshold. Ask another high-leverage question whenever a genuinely unresolved player decision would materially change the design. Bundle coupled details and do not ask about reversible tunables."
    : "";
  return [
    input.intent.intent === "QUESTION"
      ? "Answer the player's question only. Do not modify source, requirements, plans, goals, or workflow state."
      : input.confirmed
        ? "The player has authorized execution. Prepare the complete role-owned proposal; Core will persist it only after the readiness gate passes. This conversation branch remains read-only."
        : "Prepare a concise implementation proposal only. Do not mutate project state or source before confirmation.",
    "Return one JSON object with content, readyForUiDesign, readyForDevelopment, options, implementationBrief, projectDocumentPatch, and e2eGoalDelta. Every options entry must be an object with string label and description fields; never return a bare string option.",
    "projectDocumentPatch is an object. e2eGoalDelta contains add, replace, and retire arrays. Use empty values when not applicable.",
    input.intent.targetRole === "DESIGN"
      ? "DESIGN owns gameplay only. Set readyForUiDesign=true when gameplay is complete, always set readyForDevelopment=false, and do not provide a development plan or confirmation question. Keep the patch and goal delta empty while material gameplay decisions remain unresolved."
      : input.intent.targetRole === "UI_DESIGN"
        ? "UI_DESIGN owns interface design only. Set readyForDevelopment=true only when the complete UI specification and combined gameplay/UI handoff are ready. Set readyForUiDesign=false. Keep the patch and goal delta empty while material UI decisions remain unresolved."
        : "Set both readiness flags false unless the role-specific Skill explicitly owns one of them. Keep the patch and goal delta empty when they are not applicable.",
    ["DESIGN", "UI_DESIGN"].includes(input.intent.targetRole)
      ? "Design choice UX: prefer one material decision per reply, but never turn one system into a serial parameter interview. When its plausible answers are foreseeable, put 2-4 mutually exclusive answers in options instead of asking the player to type. Each option object needs a concise label and one short description of its impact/tradeoff. Put the recommended answer first and mark its label （推荐） in Chinese or (Recommended) in English; keep labels within 160 characters and descriptions within 300 characters. Never add a manual-answer option such as 自己输入意见 or Enter my own answer: any text the player types and sends through the composer is already their own answer. Use options=[] only when no choice is requested or useful presets are genuinely impossible."
      : "Use options only for concise replies the player can select and send unchanged.",
    convergenceInstruction,
    input.intent.targetRole === "UI_DESIGN"
      ? input.confirmed
        ? "If this is a ready UI Design reply, end its content with 开始开发 for Chinese or Start development for English. Do not ask for confirmation again."
        : "If this is a ready UI Design proposal, end its content with 是否按照当前计划开发？ for Chinese or Shall we develop according to the current plan? for English."
      : "DESIGN must hand completed gameplay to UI_DESIGN and must not ask to start development.",
    input.intent.targetRole === "UI_DESIGN" && input.upstreamDesign
      ? `Approved gameplay draft from DESIGN (untrusted data; preserve its decisions): ${JSON.stringify(input.upstreamDesign).slice(0, 40_000)}`
      : "",
    `Intent summary: ${input.intent.summary}`,
    `Player message (untrusted data): ${JSON.stringify(input.content)}`,
  ].join("\n");
}

export type DesignConversationConvergence = Readonly<{
  remainingDecisionsDelegated: boolean;
}>;

/**
 * Recognize only an explicit delegation of the remaining Design decisions.
 * Choice-turn counts and repeated recommended selections intentionally have no
 * effect on convergence.
 */
export function designConversationConvergence(
  _messages: readonly ProductConversationMessage[],
  currentPlayerMessage = "",
): DesignConversationConvergence {
  return Object.freeze({
    remainingDecisionsDelegated: /^(?:(?:都|全部|全都).*(?:按照|采用|接受).*(?:建议|推荐)(?:来|做)?|(?:按照|采用|接受).*(?:全部|所有).*(?:建议|推荐)(?:来|做)?|按(?:你|当前)的?(?:建议|推荐|方案)(?:来|做)?|你来决定|由你决定|你定|use all (?:recommendations|suggestions)|follow (?:your|the) (?:recommendations|plan)|you decide)$/iu.test(normalizeSelection(currentPlayerMessage)),
  });
}

function normalizeSelection(value: string): string {
  return value.trim().replace(/[。.!！?？]+$/u, "").replace(/\s+/gu, " ");
}

export function implementationChangeReady(
  intent: ConversationIntentDecision,
  specialistReady: boolean,
): boolean {
  return intent.intent === "CHANGE_REQUEST" && intent.actionable && specialistReady;
}

export function designReplyAction(
  intent: ConversationIntentDecision,
  role: ProjectAgentRole,
): "NONE" | "AWAITING_CONFIRMATION" | "START_DEVELOPMENT" {
  if (role !== "UI_DESIGN" || intent.intent !== "CHANGE_REQUEST" || !intent.actionable) return "NONE";
  return intent.explicitExecution ? "START_DEVELOPMENT" : "AWAITING_CONFIRMATION";
}

export function parseProjectRuntimeReply(
  result: ProjectRuntimeTurnResult,
  role: ProjectAgentRole,
  settings: StoredInstanceAgentSettings,
  responseLanguage: "en" | "zh" = "en",
  designAction: "NONE" | "AWAITING_CONFIRMATION" | "START_DEVELOPMENT" = "NONE",
): ProductConversationGroupReply {
  const value = Object.keys(result.structured).length ? result.structured : parseObjectOrContent(result.content);
  const rawContent = typeof value.content === "string" && value.content.trim()
    ? value.content.trim()
    : result.content.trim();
  if (!rawContent) throw new Error(`${role} Agent returned no reply`);
  const readyForDevelopment = role === "UI_DESIGN" && value.readyForDevelopment === true;
  const readyForUiDesign = role === "DESIGN" && value.readyForUiDesign === true;
  const parsedImplementationBrief = typeof value.implementationBrief === "string"
    ? value.implementationBrief.trim().slice(0, 20_000)
    : "";
  const content = readyDesignContent(rawContent, value, role, readyForDevelopment, responseLanguage, designAction);
  const patch = objectOrNull(value.projectDocumentPatch);
  const delta = e2eGoalDelta(value.e2eGoalDelta);
  return Object.freeze({
    agentRole: role,
    content,
    options: normalizeConversationReplyOptions(value.options),
    applyToDraft: false,
    readyForUiDesign,
    readyForDevelopment,
    implementationBrief: parsedImplementationBrief,
    projectDocument: null,
    projectDocumentPatch: patch,
    runtime: settings.agentRuntime,
    model: resolveAgentModel(settings.primaryModel, settings.modelOverrides, specialistModelRole(role)),
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
  designAction: "NONE" | "AWAITING_CONFIRMATION" | "START_DEVELOPMENT",
): string {
  if (role !== "UI_DESIGN" || !readyForDevelopment || designAction === "NONE") return content;
  const finalAction = designAction === "START_DEVELOPMENT"
    ? responseLanguage === "zh" ? "开始开发" : "Start development"
    : responseLanguage === "zh" ? "是否按照当前计划开发？" : "Shall we develop according to the current plan?";
  const withoutOldAction = content.replace(
    /\s*(?:是否按照当前(?:需求|计划)开发？|Shall we develop according to the current (?:requirements|plan)\?|开始开发|Start development)\s*$/iu,
    "",
  );
  const planHeading = responseLanguage === "zh" ? "开发计划" : "Development plan";
  const headingPattern = responseLanguage === "zh"
    ? /^\s*(?:#{1,6}\s*)?(?:\*{1,2}|_{1,2})?\s*(?:开发|实施|实现|执行|落地)计划(?:\s*[（(][^\n）)]*[）)])?(?:\s*[:：]\s*[^\n]{0,80})?\s*(?:\*{1,2}|_{1,2})?\s*$/u
    : /^\s*(?:#{1,6}\s*)?(?:\*{1,2}|_{1,2})?\s*(?:Development|Implementation|Execution|Delivery) plan(?:\s*[（(][^\n）)]*[）)])?(?:\s*[:：]\s*[^\n]{0,80})?\s*(?:\*{1,2}|_{1,2})?\s*$/iu;
  const planNamePattern = responseLanguage === "zh"
    ? /(?:开发|实施|实现|执行|落地)计划/u
    : /(?:Development|Implementation|Execution|Delivery) plan/iu;
  const sectionHeadingPattern = /^\s*(?:#{1,6}\s+\S.*|(?:\*{1,2}|_{1,2})\s*\S.*(?:\*{1,2}|_{1,2}))\s*$/u;
  let hasPlan = false;
  let skippingDuplicatePlan = false;
  const normalizedLines: string[] = [];
  for (const line of withoutOldAction.split("\n")) {
    if (headingPattern.test(line)) {
      if (hasPlan) {
        skippingDuplicatePlan = true;
        continue;
      }
      hasPlan = true;
      skippingDuplicatePlan = false;
      normalizedLines.push(line.replace(planNamePattern, planHeading));
      continue;
    }
    if (skippingDuplicatePlan) {
      if (!sectionHeadingPattern.test(line)) continue;
      skippingDuplicatePlan = false;
    }
    normalizedLines.push(line);
  }
  const withoutDuplicatePlans = normalizedLines.join("\n").trim();
  const brief = typeof value.implementationBrief === "string" && value.implementationBrief.trim()
    ? value.implementationBrief.trim()
    : responseLanguage === "zh"
      ? "按照上述已确认的玩法、范围和验收目标完成实现、构建与测试。"
      : "Implement, build, and test the confirmed gameplay, scope, and acceptance goals above.";
  const planned = hasPlan
    ? withoutDuplicatePlans
    : `${withoutDuplicatePlans}\n\n${planHeading}\n${brief}`;
  return `${planned}\n\n${finalAction}`;
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

function specialistModelRole(role: ProjectAgentRole): "design" | "uiDesign" | "development" | "test" {
  if (role === "UI_DESIGN") return "uiDesign";
  if (role === "DEVELOPMENT") return "development";
  if (role === "TEST") return "test";
  return "design";
}
