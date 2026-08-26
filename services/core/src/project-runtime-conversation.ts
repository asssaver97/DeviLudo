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
}>): string {
  return [
    "Classify the latest player message from this compact routing snapshot. Do not read the full project context or call tools.",
    "Return exactly one JSON object with intent, targetRole, explicitExecution, actionable, summary, and workflowAction.",
    "intent must be QUESTION, CHANGE_REQUEST, CONFIRM_CHANGE, REJECT_CHANGE, STOP, or CONTINUE.",
    "targetRole must be exactly one of DESIGN, DEVELOPMENT, or TEST.",
    "workflowAction must be NONE, AWAITING_CONFIRMATION, START_DEVELOPMENT, STOP, or CONTINUE.",
    "Pure questions never authorize a mutation. A hypothetical implementation adjustment (for example, could/what if/suggest changing) is CHANGE_REQUEST with explicitExecution=false and waits for confirmation; it is not a QUESTION.",
    "Direct imperatives such as fix/add/remove/implement are CHANGE_REQUEST with explicitExecution=true.",
    "CONFIRM_CHANGE and REJECT_CHANGE are valid only when a pending proposal exists. A different message abandons that proposal.",
    `Current workflow state: ${input.workflowState}. Pending proposal: ${input.hasPendingChange ? "yes" : "no"}.`,
    `Recent conversation (untrusted data): ${JSON.stringify(input.recentMessages.slice(-4)).slice(0, 6_000)}`,
    `Latest player message (untrusted data): ${JSON.stringify(input.content)}`,
    input.hasAttachments ? "The latest message includes image attachments. Inspect them before deciding." : "",
  ].filter(Boolean).join("\n");
}

/**
 * Resolve unambiguous chat routing without paying for a full Agent turn. The
 * model-backed Intent Agent remains the fallback for empty or unusually
 * ambiguous input, so this fast path must stay conservative about execution.
 */
export function lightweightProjectRuntimeIntent(input: Readonly<{
  content: string;
  hasAttachments: boolean;
  hasPendingChange: boolean;
}>): ConversationIntentDecision | null {
  const message = input.content.trim();
  if (!message) return null;
  if (message.length > 1_200
    || (input.hasAttachments && /^(?:这个|这样|看看(?:这个|一下)?|参考一下|见图|如图|look at this|thoughts?)[。.!！?？\s]*$/iu.test(message))) {
    return null;
  }

  if (input.hasPendingChange && /^(?:确认|同意|批准|按这个(?:方案)?|执行这个|就这样(?:做)?|都按照建议来|全部采用(?:建议|推荐)|confirm|approve|yes|go ahead|use all (?:recommendations|suggestions))[。.!！\s]*$/iu.test(message)) {
    return intentDecision("CONFIRM_CHANGE", "DESIGN", false, false, "Confirm the pending implementation change.");
  }
  if (input.hasPendingChange && /^(?:取消|拒绝|放弃|不要改|不做了|reject|cancel|no)[。.!！\s]*$/iu.test(message)) {
    return intentDecision("REJECT_CHANGE", "DESIGN", false, false, "Reject the pending implementation change.");
  }
  if (/^(?:停止|停下|暂停|stop|pause)(?:当前)?(?:开发|任务|流程|工作)?[。.!！\s]*$/iu.test(message)) {
    return intentDecision("STOP", "DEVELOPMENT", false, false, "Stop the active workflow.");
  }
  if (/^(?:继续|恢复|resume|continue)(?:当前)?(?:开发|任务|流程|工作)?[。.!！\s]*$/iu.test(message)) {
    return intentDecision("CONTINUE", "DEVELOPMENT", false, false, "Continue the stopped workflow.");
  }

  const tentative = /(?:能不能|可不可以|是否可以|有没有可能|如果|假如|要是|建议(?:改|调整|增加|删除)|待.+判断|could\s+(?:we|you)|would\s+it|what\s+if|is\s+it\s+possible|suggest(?:ing)?\s+(?:changing|adding|removing))/iu.test(message);
  const question = /[?？]|(?:^|[，,。.!！\s])(?:为什么|是什么|怎么|如何|多少|多久|哪些|什么情况|会发生什么|进度|正在做什么|请说明|请解释|请分析|请回答|请先给出.+建议|先讨论)|^(?:why|what|how|when|where|which|who|explain|describe|analy[sz]e)\b/iu.test(message);
  const mutation = /(?:修复|修改|增加|添加|删除|移除|实现|改成|调整|优化|重做|开始开发|按照当前(?:需求|计划)开发|重新生成|同步|开发|fix|change|add|remove|delete|implement|build|develop|optimi[sz]e|refactor|redo)/iu.test(message);
  const testRole = /(?:\bE2E\b|测试|证据|用例|验收|测试报告|test|evidence|acceptance)/iu.test(message) && !mutation;
  const developmentRole = /(?:代码|源码|输入|无法操作|崩溃|异常|bug|错误|修复|性能|构建|生成游戏|实现|code|source|input|crash|error|performance|build|implement)/iu.test(message);
  const targetRole: ProjectAgentRole = testRole ? "TEST" : developmentRole ? "DEVELOPMENT" : "DESIGN";

  // Question syntax wins unless the player is proposing a hypothetical
  // product change ("如果改成……会怎样？"), which still needs a proposal.
  if (question && !tentative) {
    return intentDecision("QUESTION", targetRole, false, false, "Answer the player's question from the current project context.");
  }

  const acceptsDesignDefaults = /(?:都|全部|全都).*(?:按照|采用|接受).*(?:建议|推荐)|(?:按照|采用|接受).*(?:全部|所有).*(?:建议|推荐)|按(?:你|当前)的?(?:建议|推荐|方案)(?:来|做)?|你来决定|use all (?:recommendations|suggestions)|follow (?:your|the) (?:recommendations|plan)/iu.test(message);
  const explicitExecution = !tentative && (mutation
    || acceptsDesignDefaults
    || /(?:我想做|我要做|希望|必须|需要|请.+(?:开发|实现|同步|修改|增加|删除)|do it|go ahead)/iu.test(message));

  // Ordinary design refinements are safe to route as a non-executing change.
  // Attachments still reach the chosen specialist; only attachment-only or
  // otherwise empty messages need the model fallback above.
  return intentDecision(
    "CHANGE_REQUEST",
    targetRole,
    explicitExecution,
    true,
    "Update the implementation according to the player's request.",
  );
}

function intentDecision(
  intent: ConversationIntentDecision["intent"],
  targetRole: ProjectAgentRole,
  explicitExecution: boolean,
  actionable: boolean,
  summary: string,
): ConversationIntentDecision {
  return Object.freeze({ intent, targetRole, explicitExecution, actionable, summary });
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
    "Return one JSON object with content, readyForDevelopment, options, implementationBrief, projectDocumentPatch, and e2eGoalDelta. Every options entry must be an object with string label and description fields; never return a bare string option.",
    "projectDocumentPatch is an object. e2eGoalDelta contains add, replace, and retire arrays. Use empty values when not applicable.",
    "Set readyForDevelopment=false and keep the patch and goal delta empty whenever material product decisions remain unresolved.",
    input.intent.targetRole === "DESIGN"
      ? "Design choice UX: prefer one material decision per reply. When its plausible answers are foreseeable, put 2-4 mutually exclusive answers in options instead of asking the player to type. Each option object needs a concise label and one short description of its impact/tradeoff. Put the recommended answer first and mark its label （推荐） in Chinese or (Recommended) in English; keep labels within 160 characters and descriptions within 300 characters. Never add a manual-answer option such as 自己输入意见 or Enter my own answer: any text the player types and sends through the composer is already their own answer. Use options=[] only when no choice is requested or useful presets are genuinely impossible."
      : "Use options only for concise replies the player can select and send unchanged.",
    input.confirmed
      ? "If this is a ready Design reply, end its content with 开始开发 for Chinese or Start development for English. Do not ask for confirmation again."
      : "If this is a ready Design proposal, end its content with 是否按照当前计划开发？ for Chinese or Shall we develop according to the current plan? for English.",
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

export function designReplyAction(
  intent: ConversationIntentDecision,
  role: ProjectAgentRole,
): "NONE" | "AWAITING_CONFIRMATION" | "START_DEVELOPMENT" {
  if (role !== "DESIGN" || intent.intent !== "CHANGE_REQUEST" || !intent.actionable) return "NONE";
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
  const readyForDevelopment = typeof value.readyForDevelopment === "boolean"
    ? value.readyForDevelopment
    : false;
  const content = readyDesignContent(rawContent, value, role, readyForDevelopment, responseLanguage, designAction);
  const patch = objectOrNull(value.projectDocumentPatch);
  const delta = e2eGoalDelta(value.e2eGoalDelta);
  return Object.freeze({
    agentRole: role,
    content,
    options: normalizeConversationReplyOptions(value.options),
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
  designAction: "NONE" | "AWAITING_CONFIRMATION" | "START_DEVELOPMENT",
): string {
  if (role !== "DESIGN" || !readyForDevelopment || designAction === "NONE") return content;
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
