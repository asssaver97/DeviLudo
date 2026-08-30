import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";
import { isDevelopmentAuthorization, type ProductConversationMessage } from "@/lib/product/contracts";
import type { ProjectRuntimeTurnResult } from "@/lib/product/project-runtime";
import {
  PROJECT_RUNTIME_IDLE_MS,
  PROJECT_RUNTIME_PAUSED_DESTROY_MS,
} from "@/lib/product/project-runtime";
import {
  createProjectContext,
  ProjectContextStore,
  updateProjectContext,
} from "@/services/core/src/project-context";
import {
  deliverValidatedConversationReply,
} from "@/services/core/src/product-conversation";
import {
  designConversationConvergence,
  designReplyAction,
  implementationChangeReady,
  parseProjectRuntimeIntent,
  parseProjectRuntimeReply,
  projectRuntimeContinuationIntent,
  projectRuntimeIntentPrompt,
  projectRuntimeNewGameIntent,
  projectRuntimeSpecialistPrompt,
} from "@/services/core/src/project-runtime-conversation";
import {
  bundledCjkFontValidationError,
  retryProjectRuntimeLifecycle,
  runtimeTurnHandoff,
  summarizeRuntimeToolCalls,
  summarizeToolAuditValue,
  unobservedTestPlanAssetPlacements,
  unpublishedTestPlanProbeReferences,
} from "@/services/core/src/project-runtime-service";
import {
  createRuntimeEventLineBuffer,
  createStructuredContentDeltaExtractor,
  finalRuntimeContent,
  runtimeEventDeltaText,
  runtimeEventFinalText,
  runtimeEventText,
  structuredRuntimeOutput,
} from "@/services/project-runtime/runtime-events.mjs";

const compressProjectContext = promisify(zstdCompress);
import {
  ProjectRuntimeSupervisor,
  runtimeProgressEvent,
} from "@/services/sandbox-executor/src/project-runtime-supervisor";
import {
  canonicalToolName,
  nativeToolName,
  ROLE_TO_CANONICAL_TOOLS,
  toolInputSchema,
} from "@/services/project-runtime/tool-names.mjs";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const projectId = "10000000-0000-4000-8000-000000000002";

test("Runtime turns wait through lifecycle compaction without consuming a workflow attempt", async () => {
  let attempts = 0;
  let waits = 0;
  const result = await retryProjectRuntimeLifecycle(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("Project Runtime is completing a lifecycle transition");
    return "started";
  }, {
    retryLimit: 3,
    wait: async () => { waits += 1; },
  });
  assert.equal(result, "started");
  assert.equal(attempts, 3);
  assert.equal(waits, 2);

  await assert.rejects(() => retryProjectRuntimeLifecycle(
    async () => { throw new Error("Runtime backend failed"); },
    { wait: async () => { throw new Error("must not wait"); } },
  ), /Runtime backend failed/);
});

test("Design and UI Design completion accept only the current turn's durable next-stage handoff", () => {
  const context = updateProjectContext(createProjectContext({ workspaceId, projectId }), {
    handoffs: Object.freeze([
      Object.freeze({ id: "old", fromRole: "DESIGN", toRole: "UI_DESIGN", summary: "Old gameplay" }),
      Object.freeze({ id: "current", fromRole: "DESIGN", toRole: "UI_DESIGN", summary: "Design the interface" }),
      Object.freeze({ id: "ui-current", fromRole: "UI_DESIGN", toRole: "DEVELOPMENT", summary: "Implement it" }),
    ]),
  });
  assert.equal(runtimeTurnHandoff(context, "current", "DESIGN", "UI_DESIGN")?.summary, "Design the interface");
  assert.equal(runtimeTurnHandoff(context, "ui-current", "UI_DESIGN", "DEVELOPMENT")?.summary, "Implement it");
  assert.equal(runtimeTurnHandoff(context, "old", "DESIGN", "TEST"), null);
  assert.equal(runtimeTurnHandoff(context, "missing", "DESIGN", "UI_DESIGN"), null);
});

test("persistent Runtime intent selects exactly one role and rejects contradictory mutation flags", () => {
  const decision = parseProjectRuntimeIntent(result("INTENT", {
    intent: "CHANGE_REQUEST",
    targetRole: "DEVELOPMENT",
    explicitExecution: true,
    actionable: true,
    summary: "Fix the input path.",
  }));
  assert.equal(decision.targetRole, "DEVELOPMENT");
  assert.equal(decision.explicitExecution, true);
  assert.throws(() => parseProjectRuntimeIntent(result("INTENT", {
    intent: "QUESTION",
    targetRole: "TEST",
    explicitExecution: true,
    actionable: true,
    summary: "Explain the current evidence.",
  })), /inconsistent action flags/);
  assert.match(projectRuntimeIntentPrompt({
    content: "Could this be changed?",
    hasAttachments: false,
    hasPendingChange: false,
    workflowState: "TESTING",
    recentMessages: [],
  }), /targetRole must be exactly one/);
  assert.match(projectRuntimeSpecialistPrompt({
    intent: Object.freeze({
      intent: "CHANGE_REQUEST",
      targetRole: "DESIGN",
      explicitExecution: false,
      actionable: true,
      summary: "Choose the core-loop direction.",
    }),
    content: "帮我设计玩法",
    confirmed: false,
  }), /Each option object needs a concise label and one short description/);
});

test("option-driven Design replies continue without another Intent Agent turn", () => {
  const newGame = projectRuntimeNewGameIntent(
    "读取公开素材，并制作同名游戏。游戏内容参考人物设定与故事大纲。",
  );
  assert.deepEqual(newGame, {
    intent: "CHANGE_REQUEST",
    targetRole: "DESIGN",
    explicitExecution: false,
    actionable: true,
    summary: "读取公开素材，并制作同名游戏。游戏内容参考人物设定与故事大纲。",
  });
  assert.equal(designReplyAction({ ...newGame, targetRole: "UI_DESIGN" }, "UI_DESIGN"), "AWAITING_CONFIRMATION");
  const message = (metadata: Readonly<Record<string, unknown>>): ProductConversationMessage => Object.freeze({
    id: "choice",
    role: "ASSISTANT",
    content: "请选择设定方向。",
    attachments: Object.freeze([]),
    metadata,
    createdAt: "2026-08-29T00:00:00.000Z",
    completedAt: "2026-08-29T00:00:01.000Z",
  });
  const intentDecision = Object.freeze({
    intent: "CHANGE_REQUEST",
    targetRole: "DESIGN",
    explicitExecution: false,
    actionable: true,
    summary: "Create a new game.",
  });
  assert.deepEqual(projectRuntimeContinuationIntent([message(Object.freeze({
    agentRole: "DESIGN",
    readyForUiDesign: false,
    options: Object.freeze([Object.freeze({ label: "时间循环（推荐）", description: "每轮积累线索。" })]),
    intentDecision,
  }))], "我想让每轮保留一条记忆"), {
    intent: "CHANGE_REQUEST",
    targetRole: "DESIGN",
    explicitExecution: false,
    actionable: true,
    summary: "我想让每轮保留一条记忆",
  });
  assert.equal(projectRuntimeContinuationIntent([message(Object.freeze({
    agentRole: "DESIGN", readyForUiDesign: false, options: Object.freeze([]), intentDecision,
  }))], "改做 UI"), null);
  assert.equal(projectRuntimeContinuationIntent([message(Object.freeze({
    agentRole: "DESIGN", readyForUiDesign: true,
    options: Object.freeze([Object.freeze({ label: "继续", description: "已完成设计。" })]), intentDecision,
  }))], "继续"), null);
});

test("Design discovery converges only after the player explicitly delegates remaining decisions", () => {
  const question = (id: string, label: string): ProductConversationMessage => Object.freeze({
    id,
    role: "ASSISTANT",
    content: "请选择",
    attachments: Object.freeze([]),
    metadata: Object.freeze({
      agentRole: "DESIGN",
      readyForUiDesign: false,
      readyForDevelopment: false,
      options: Object.freeze([Object.freeze({ label, description: "推荐方向" })]),
    }),
    createdAt: "2026-08-27T00:00:00.000Z",
    completedAt: "2026-08-27T00:00:01.000Z",
  });
  const player = (id: string, content: string): ProductConversationMessage => Object.freeze({
    id,
    role: "USER",
    content,
    attachments: Object.freeze([]),
    metadata: Object.freeze({}),
    createdAt: "2026-08-27T00:00:00.000Z",
    completedAt: "2026-08-27T00:00:01.000Z",
  });

  assert.deepEqual(designConversationConvergence([
    question("q1", "方向 A（推荐）"),
    player("u1", "方向 A（推荐）"),
    question("q2", "规则 B（推荐）"),
  ], "规则 B（推荐）"), { remainingDecisionsDelegated: false });
  assert.equal(designConversationConvergence([
    question("q1", "A（推荐）"), player("u1", "自定义 A"),
    question("q2", "B（推荐）"), player("u2", "自定义 B"),
    question("q3", "C（推荐）"),
  ], "自定义 C").remainingDecisionsDelegated, false);
  assert.equal(designConversationConvergence([
    question("q1", "A（推荐）"),
  ], "都按照建议来").remainingDecisionsDelegated, true);

  const forcedPrompt = projectRuntimeSpecialistPrompt({
    intent: Object.freeze({
      intent: "CHANGE_REQUEST",
      targetRole: "DESIGN",
      explicitExecution: false,
      actionable: true,
      summary: "Complete the game design.",
    }),
    content: "继续",
    confirmed: false,
    designConvergence: Object.freeze({
      remainingDecisionsDelegated: true,
    }),
  });
  assert.match(forcedPrompt, /Do not ask another question/);
  assert.match(forcedPrompt, /set readyForUiDesign=true/);
  assert.match(forcedPrompt, /keep readyForDevelopment=false/);

  const openPrompt = projectRuntimeSpecialistPrompt({
    intent: Object.freeze({
      intent: "CHANGE_REQUEST",
      targetRole: "DESIGN",
      explicitExecution: false,
      actionable: true,
      summary: "Continue resolving the game design.",
    }),
    content: "规则 B（推荐）",
    confirmed: false,
    designConvergence: Object.freeze({
      remainingDecisionsDelegated: false,
    }),
  });
  assert.match(openPrompt, /no automatic turn-count or recommended-selection convergence threshold/);
});

test("development authorization labels remain explicit UI actions", () => {
  for (const authorization of [
    "按此计划开发",
    "按当前计划开发（推荐）",
    "按照当前计划开发",
    "BUILD CURRENT PLAN",
  ]) {
    assert.equal(isDevelopmentAuthorization(authorization), true);
  }
  assert.equal(isDevelopmentAuthorization("调整当前计划"), false);
  assert.equal(designReplyAction({
    intent: "CHANGE_REQUEST",
    targetRole: "DESIGN",
    explicitExecution: true,
    actionable: true,
    summary: "Accept every recommended design choice and begin development.",
  }, "DESIGN"), "NONE");
  assert.equal(designReplyAction({
    intent: "CHANGE_REQUEST",
    targetRole: "UI_DESIGN",
    explicitExecution: true,
    actionable: true,
    summary: "Accept every recommended UI choice and begin development.",
  }, "UI_DESIGN"), "START_DEVELOPMENT");
});

test("Intent routes role boundaries while option-driven design replies preserve their specialist", async () => {
  const [api, conversation, intentSkill] = await Promise.all([
    readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/project-runtime-conversation.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/project-runtime/skills/intent/SKILL.md", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(api, /lightweightProjectRuntimeIntent/);
  assert.doesNotMatch(conversation, /lightweightProjectRuntimeIntent|const mutation =|const developmentRole =/);
  assert.match(api, /onStart\("INTENT"\)[\s\S]*role: "INTENT"[\s\S]*parseProjectRuntimeIntent/);
  assert.match(api, /const intentDecision = projectRuntimeNewGameIntent\(command\.content\)/);
  assert.match(api, /project\.workflowState === "DRAFT" && !pending[\s\S]*projectRuntimeContinuationIntent/);
  assert.match(intentSkill, /semantic router at ambiguous conversation entry points and role boundaries/);
  assert.match(intentSkill, /assigns new-game creation directly to Design/);
  assert.match(intentSkill, /preserve an active Design or UI Design choice conversation without invoking you/);
  assert.match(intentSkill, /UI\/UX redesign[\s\S]*even when the player also says to implement them/);
  assert.match(projectRuntimeIntentPrompt({
    content: "重新设计并实现游戏界面 UI",
    hasAttachments: false,
    hasPendingChange: false,
    workflowState: "RELEASE_PENDING",
    recentMessages: [],
  }), /Route UI redesign or unresolved interface decisions to UI_DESIGN even when the player also says to implement them/);
});

test("specialist output is attributed to the real persistent role session", () => {
  const reply = parseProjectRuntimeReply(result("TEST", {
    content: "The current plan covers input and visual evidence.",
    readyForDevelopment: false,
    options: [],
    projectDocumentPatch: null,
    e2eGoalDelta: { add: [], replace: [], retire: [] },
  }), "TEST", {
    agentRuntime: "CODEX_CLI",
    baseUrl: "https://chatgpt.com",
    primaryModel: "primary",
    modelOverrides: { intent: null, analysis: null, design: null, uiDesign: null, development: null, test: "test-model" },
    imageModel: null,
    credentialSecretRef: "vault://instance/agent-runtime/api-key/versions/10000000-0000-4000-8000-000000000004",
    credentialVersion: "10000000-0000-4000-8000-000000000004",
    apiKeyMask: "••••",
    apiKeyFingerprint: "sha256:000000000000",
    testPolicyReady: true,
    testPolicyCheckedRevision: 3,
    revision: 3,
    updatedBy: "test",
    updatedAt: new Date(0).toISOString(),
  });
  assert.equal(reply.agentRole, "TEST");
  assert.equal(reply.runtime, "CODEX_CLI");
  assert.equal(reply.model, "test-model");
});

test("ready UI Design replies end with one development plan and the localized final action", () => {
  const settings = {
    agentRuntime: "CODEX_CLI" as const,
    baseUrl: "https://chatgpt.com",
    primaryModel: "primary",
    modelOverrides: { intent: null, analysis: null, design: null, uiDesign: null, development: null, test: null },
    imageModel: null,
    credentialSecretRef: "vault://instance/agent-runtime/api-key/versions/10000000-0000-4000-8000-000000000004",
    credentialVersion: "10000000-0000-4000-8000-000000000004",
    apiKeyMask: "••••",
    apiKeyFingerprint: "sha256:000000000000",
    testPolicyReady: true,
    testPolicyCheckedRevision: 3,
    revision: 3,
    updatedBy: "test",
    updatedAt: new Date(0).toISOString(),
  };
  const discovery = parseProjectRuntimeReply(result("DESIGN", {
    content: "请选择核心循环方向。",
    readyForUiDesign: false,
    readyForDevelopment: false,
    options: [
      { label: " 采用探索驱动方案（推荐） ", description: "通过探索发现持续改变后续路线的机会。" },
      "采用战斗驱动方案",
      { label: "采用战斗驱动方案", description: "重复项应被忽略。" },
      { label: "很".repeat(200), description: "长".repeat(400) },
      { label: "自己输入意见", description: "说明你希望采用的核心循环。" },
      { label: "Enter my own answer", description: "Legacy English manual option." },
    ],
    implementationBrief: "",
    projectDocumentPatch: {},
    e2eGoalDelta: { add: [], replace: [], retire: [] },
  }), "DESIGN", settings, "zh");
  assert.deepEqual(discovery.options.slice(0, 2), [
    { label: "采用探索驱动方案（推荐）", description: "通过探索发现持续改变后续路线的机会。" },
    { label: "采用战斗驱动方案", description: "" },
  ]);
  assert.equal(discovery.options.length, 3);
  assert.equal(discovery.options[2]?.label.length, 160);
  assert.equal(discovery.options[2]?.description.length, 300);
  assert.equal(discovery.options.some(option => option.label === "自己输入意见"), false);
  assert.equal(discovery.options.some(option => option.label === "Enter my own answer"), false);

  const invalidDesignReadiness = parseProjectRuntimeReply(result("DESIGN", {
    content: "玩法完成，但 UI 设计尚未完成。",
    readyForUiDesign: true,
    readyForDevelopment: true,
    options: [],
    implementationBrief: "交给 UI 设计 Agent。",
    projectDocumentPatch: {},
    e2eGoalDelta: { add: [], replace: [], retire: [] },
  }), "DESIGN", settings, "zh", "START_DEVELOPMENT");
  assert.equal(invalidDesignReadiness.readyForUiDesign, true);
  assert.equal(invalidDesignReadiness.readyForDevelopment, false);
  assert.doesNotMatch(invalidDesignReadiness.content, /开发计划|是否按照当前计划开发|开始开发/u);

  const reply = parseProjectRuntimeReply(result("UI_DESIGN", {
    content: "玩法、界面和验收目标已经明确。",
    readyForUiDesign: false,
    readyForDevelopment: true,
    options: [],
    implementationBrief: "先完成核心循环，再接入界面与验收测试。",
    projectDocumentPatch: {},
    e2eGoalDelta: { add: [], replace: [], retire: [] },
  }), "UI_DESIGN", settings, "zh", "AWAITING_CONFIRMATION");
  assert.match(reply.content, /开发计划\n先完成核心循环，再接入界面与验收测试。/u);
  assert.ok(reply.content.endsWith("是否按照当前计划开发？"));

  const authorized = parseProjectRuntimeReply(result("UI_DESIGN", {
    content: "玩法、界面和验收目标已经明确。\n\n## 实施计划（按风险排序）\n先完成核心循环。\n\n**开发计划**\n这段重复计划不应出现。\n\n是否按照当前计划开发？",
    readyForUiDesign: false,
    readyForDevelopment: true,
    options: [],
    implementationBrief: "先完成核心循环，再接入界面与验收测试。",
    projectDocumentPatch: {},
    e2eGoalDelta: { add: [], replace: [], retire: [] },
  }), "UI_DESIGN", settings, "zh", "START_DEVELOPMENT");
  assert.equal(authorized.content.match(/(?:开发|实施|实现|执行|落地)计划/gu)?.length, 1);
  assert.match(authorized.content, /## 开发计划（按风险排序）/u);
  assert.doesNotMatch(authorized.content, /这段重复计划不应出现/u);
  assert.ok(authorized.content.endsWith("开始开发"));
  assert.doesNotMatch(authorized.content, /是否按照当前计划开发？/u);
});

test("Runtime progress preserves every provider JSONL record without rewriting it", () => {
  const lines: string[] = [];
  const buffer = createRuntimeEventLineBuffer(line => lines.push(line));
  buffer.push('{"delta":{"te');
  buffer.push('xt":"正在实现核心循环"}}\n{"type":"turn.completed"');
  buffer.push("}\n");
  buffer.flush();
  assert.deepEqual(lines, [
    '{"delta":{"text":"正在实现核心循环"}}',
    '{"type":"turn.completed"}',
  ]);
  assert.equal(runtimeEventText({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "实时文本" } },
  }), "实时文本");
  assert.equal(runtimeEventDeltaText({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "增量文本" } },
  }), "增量文本");
  assert.equal(runtimeEventFinalText({
    type: "item.completed",
    item: { type: "agent_message", text: "最终文本" },
  }), "最终文本");
  const commandOutput = JSON.stringify({
    type: "item.started",
    item: { type: "command_execution", command: "/bin/bash -lc 'API_KEY=secret npm test'" },
  });
  assert.deepEqual(runtimeProgressEvent(`DEVILUDO_RUNTIME_EVENT:${commandOutput}`), {
    kind: "RUNTIME_OUTPUT",
    content: `${commandOutput}\n`,
  });
  const toolOutput = JSON.stringify({
    type: "item.completed",
    item: { type: "mcp_tool_call", tool: "source_checkpoint_create" },
  });
  assert.deepEqual(runtimeProgressEvent(`DEVILUDO_RUNTIME_EVENT:${toolOutput}`), {
    kind: "RUNTIME_OUTPUT",
    content: `${toolOutput}\n`,
  });
  const contextStart = JSON.stringify({
    type: "item.started",
    item: { type: "mcp_tool_call", tool: "context_read" },
  });
  assert.deepEqual(runtimeProgressEvent(`DEVILUDO_RUNTIME_EVENT:${contextStart}`), {
    kind: "RUNTIME_OUTPUT",
    content: `${contextStart}\n`,
  });
  const contextComplete = JSON.stringify({
    type: "item.completed",
    item: { type: "mcp_tool_call", tool: "context_read" },
  });
  assert.deepEqual(runtimeProgressEvent(`DEVILUDO_RUNTIME_EVENT:${contextComplete}`), {
    kind: "RUNTIME_OUTPUT",
    content: `${contextComplete}\n`,
  });
  const reasoningStart = JSON.stringify({
    type: "item.started",
    item: { type: "reasoning" },
  });
  assert.deepEqual(runtimeProgressEvent(`DEVILUDO_RUNTIME_EVENT:${reasoningStart}`), {
    kind: "RUNTIME_OUTPUT",
    content: `${reasoningStart}\n`,
  });
  assert.deepEqual(runtimeProgressEvent(`DEVILUDO_RUNTIME_EVENT:${JSON.stringify({
    type: "deviludo.content_delta",
    delta: "玩家可见正文",
  })}`), {
    kind: "CONTENT_DELTA",
    content: "玩家可见正文",
  });
  const agentMessage = JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "I'm using the mandatory design skill." },
  });
  assert.deepEqual(runtimeProgressEvent(`DEVILUDO_RUNTIME_EVENT:${agentMessage}`), {
    kind: "RUNTIME_OUTPUT",
    content: `${agentMessage}\n`,
  });
  assert.deepEqual(runtimeProgressEvent("DEVILUDO_RUNTIME_EVENT:not-json"), {
    kind: "RUNTIME_OUTPUT",
    content: "not-json\n",
  });
});

test("Project Runtime deletion is idempotent when its Docker container is already absent", async () => {
  const dockerCalls: string[][] = [];
  const supervisor = new ProjectRuntimeSupervisor({
    docker: async arguments_ => {
      dockerCalls.push([...arguments_]);
      if (arguments_[0] === "inspect") throw new Error("No such container");
      return "";
    },
    resolveSecret: async () => "",
    executorId: "executor-test",
    projectsRoot: "/tmp/deviludo-project-runtime-test",
    projectsVolume: "deviludo-projects-test",
    agentNetwork: "agent-test",
    egressProxy: "http://provider-proxy:3128",
    mcpGateway: "http://core-api:8080",
    allowlistedImages: new Set(),
  });
  const status = await supervisor.destroy({
    schemaVersion: "deviludo.project-runtime.v2",
    workspaceId,
    projectId,
    generation: 1,
    fencingToken: 1,
    runtime: "CODEX_CLI",
  });

  assert.equal(status.state, "DESTROYED");
  assert.equal(status.containerId, null);
  assert.deepEqual(dockerCalls.map(arguments_ => arguments_[0]), ["inspect", "rm", "volume"]);
  assert.deepEqual(dockerCalls[1]?.slice(0, 3), ["rm", "-f", "-v"]);
  assert.deepEqual(dockerCalls[2]?.slice(0, 3), ["volume", "rm", "-f"]);
});

test("Runtime streams only the decoded player-facing content field", () => {
  const deltas: string[] = [];
  const extractor = createStructuredContentDeltaExtractor(delta => deltas.push(delta));
  extractor.push('```json\n{"readyForDevelopment":false,"con');
  extractor.push('tent":"第一行\\n带引号：\\"测试\\"，Unicode：\\u6e38');
  extractor.push('\\u620f","implementationBrief":"不得流出"}\n```');
  assert.equal(deltas.join(""), '第一行\n带引号："测试"，Unicode：游戏');
  assert.doesNotMatch(deltas.join(""), /readyForDevelopment|implementationBrief|不得流出/u);
});

test("a Runtime without token deltas still renders its validated reply progressively", async () => {
  const deltas: string[] = [];
  const replacements: string[] = [];
  const content = "一".repeat(120);
  await deliverValidatedConversationReply({
    role: "DESIGN",
    content,
    streamedContent: "",
    stream: {
      onStart() {},
      onProcess() {},
      onDelta(_role, delta) { deltas.push(delta); },
      onReplace(_role, replacement) { replacements.push(replacement); },
      onActivity() {},
      onDevelopmentLog() {},
      onComplete() {},
    },
  });
  assert.equal(deltas.length, 3);
  assert.equal(deltas.join(""), content);
  assert.deepEqual(replacements, []);
});

test("an authoritative reply replaces temporary process events", async () => {
  const deltas: string[] = [];
  const replacements: string[] = [];
  await deliverValidatedConversationReply({
    role: "TEST",
    content: "最终测试结论",
    streamedContent: "最终测试结论",
    hasStreamedProcess: true,
    stream: {
      onStart() {},
      onProcess() {},
      onDelta(_role, delta) { deltas.push(delta); },
      onReplace(_role, replacement) { replacements.push(replacement); },
      onActivity() {},
      onDevelopmentLog() {},
      onComplete() {},
    },
  });
  assert.deepEqual(deltas, []);
  assert.deepEqual(replacements, ["最终测试结论"]);
});

test("incomplete design discovery cannot stage or execute an implementation change", () => {
  const change = parseProjectRuntimeIntent(result("INTENT", {
    intent: "CHANGE_REQUEST",
    targetRole: "DESIGN",
    explicitExecution: true,
    actionable: true,
    summary: "Create a new game from an incomplete seed.",
  }));
  assert.equal(implementationChangeReady(change, false), false);
  assert.equal(implementationChangeReady(change, true), true);
  const question = parseProjectRuntimeIntent(result("INTENT", {
    intent: "QUESTION",
    targetRole: "DESIGN",
    explicitExecution: false,
    actionable: false,
    summary: "Explain the proposed core loop.",
  }));
  assert.equal(implementationChangeReady(question, true), false);
});

test("project context is zstd-compressed, digest-verified, atomic durable state", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-context-"));
  try {
    const store = new ProjectContextStore(root);
    const initial = createProjectContext({ workspaceId, projectId, concept: "A playable game" });
    const changed = updateProjectContext(initial, { workflow: { state: "DEVELOPING", stopped: false } });
    const stored = await store.write(changed);
    assert.equal(stored.relativePath, `workspaces/${workspaceId}/projects/${projectId}/context/project-context.json.zst`);
    assert.match(stored.sha256, /^sha256:[0-9a-f]{64}$/);
    const packed = await readFile(store.path(workspaceId, projectId));
    assert.notEqual(packed.subarray(0, 1).toString("utf8"), "{");
    assert.deepEqual((await store.read(workspaceId, projectId, stored.sha256)).context, changed);
    await assert.rejects(store.read(workspaceId, projectId, `sha256:${"0".repeat(64)}`), /digest/);
    assert.throws(() => updateProjectContext(initial, {
      workflow: { state: "DRAFT", apiKey: "must-not-persist" },
    }), /sensitive field/);
    let nested: Record<string, unknown> = {};
    const nestedRoot = nested;
    for (let depth = 0; depth < 24; depth += 1) {
      nested.child = {};
      nested = nested.child as Record<string, unknown>;
    }
    assert.doesNotThrow(() => updateProjectContext(initial, { workflow: nestedRoot }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project context materializes newly registered Agent role sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-context-role-"));
  try {
    const store = new ProjectContextStore(root);
    const initial = createProjectContext({ workspaceId, projectId, concept: "A playable game" });
    const storedShape = structuredClone(initial) as unknown as { roles: Record<string, unknown> };
    delete storedShape.roles.UI_DESIGN;
    const path = store.path(workspaceId, projectId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await compressProjectContext(Buffer.from(JSON.stringify(storedShape), "utf8")));

    const restored = (await store.read(workspaceId, projectId)).context;
    assert.deepEqual(restored.roles.UI_DESIGN, {
      sessionId: null,
      summary: "",
      lastTurnId: null,
      updatedAt: null,
    });
    assert.deepEqual(restored.roles.DESIGN, initial.roles.DESIGN);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Runtime lifecycle uses fixed five-minute pause and thirty-minute destruction windows", () => {
  assert.equal(PROJECT_RUNTIME_IDLE_MS, 5 * 60_000);
  assert.equal(PROJECT_RUNTIME_PAUSED_DESTROY_MS, 30 * 60_000);
});

test("Codex JSONL returns the final agent message instead of the entire event stream", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Inspecting the project." } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"name":"Big Rich","complete":true}' } }),
  ].join("\n");
  const content = finalRuntimeContent(output);
  assert.equal(content, '{"name":"Big Rich","complete":true}');
  assert.deepEqual(structuredRuntimeOutput(content), { name: "Big Rich", complete: true });
});

test("Runtime exposes provider-safe native MCP names and maps them to authorized Core tools", () => {
  for (const [role, canonicalNames] of Object.entries(ROLE_TO_CANONICAL_TOOLS)) {
    for (const canonicalName of canonicalNames) {
      const nativeName = nativeToolName(canonicalName);
      assert.match(nativeName, /^[a-z][a-z0-9_]*$/);
      assert.equal(canonicalToolName(role, nativeName), canonicalName);
    }
  }
  assert.equal(nativeToolName("context.read"), "context_read");
  assert.equal(canonicalToolName("ANALYSIS", "source_checkpoint"), null);
});

test("UI Design persistence tools expose exact input contracts", () => {
  const document = toolInputSchema("project_document.update") as {
    required: readonly string[];
    additionalProperties: boolean;
  };
  const goals = toolInputSchema("e2e_goals.update") as { required: readonly string[] };
  const handoff = toolInputSchema("handoff.create") as { required: readonly string[] };
  assert.deepEqual(document.required, ["document"]);
  assert.equal(document.additionalProperties, false);
  assert.deepEqual(goals.required, ["goals"]);
  assert.deepEqual(handoff.required, ["toRole", "summary"]);
});

test("Analysis MCP advertises the complete canonical report schema", () => {
  const schema = toolInputSchema("context.update_analysis") as {
    required: readonly string[];
    properties: { analysis: { required: readonly string[]; properties: Record<string, Record<string, unknown>> } };
  };
  assert.deepEqual(schema.required, ["analysis"]);
  assert.equal(schema.properties.analysis.required.length, 15);
  for (const field of ["categories", "features", "coreLoop", "acceptanceCriteria", "completedWork", "remainingWork", "startupIssues", "risks"]) {
    assert.equal(schema.properties.analysis.properties[field]?.type, "array");
  }
  assert.equal(schema.properties.analysis.properties.completedWork?.maxItems, 32);
  assert.equal(schema.properties.analysis.properties.recommendedPlan, undefined);
  assert.equal(schema.properties.analysis.properties.questions, undefined);
});

test("Test MCP advertises the current complete manifest contract", () => {
  const schema = toolInputSchema("test_plan.replace") as {
    required: readonly string[];
    properties: {
      plan: {
        required: readonly string[];
        properties: {
          testManifest: { required: readonly string[]; properties: Record<string, unknown> };
          assetPlacementPlan: { required: readonly string[] };
        };
      };
    };
  };
  assert.deepEqual(schema.required, ["plan"]);
  assert.deepEqual(schema.properties.plan.required, ["testManifest", "assetPlacementPlan"]);
  assert.deepEqual(schema.properties.plan.properties.testManifest.required, [
    "schema", "inputProfiles", "primaryInputProfile", "adaptivePlayer", "requirements", "features",
  ]);
  assert.ok(schema.properties.plan.properties.testManifest.properties.adaptivePlayer);
  assert.deepEqual(schema.properties.plan.properties.assetPlacementPlan.required, [
    "schema", "plannedAssetKeys", "placements", "unmappedAssetKeys",
  ]);
});

test("source.read advertises bounded line ranges for large source files", () => {
  const schema = toolInputSchema("source.read") as {
    required: readonly string[];
    additionalProperties: boolean;
    properties: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(schema.required, ["path"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.startLine?.minimum, 1);
  assert.equal(schema.properties.endLine?.minimum, 1);
});

test("Test plans cannot freeze Probe references absent from the current publisher source", () => {
  const plan = {
    testManifest: {
      adaptivePlayer: {
        successAssertions: [{ source: "PROGRESS", key: "move_budget", operator: "GREATER_THAN", value: 0 }],
      },
      features: [{ interactionScript: { events: [
        { type: "click", targetId: "reachable-hex", postconditions: [{ source: "CONTROL", targetId: "move", property: "enabled", operator: "EQUALS", value: true }] },
        { type: "click", targetId: "relationship-xiaotian", postconditions: [{ source: "STATE", key: "screen_mode", operator: "EQUALS", value: "PLAYING" }] },
        { type: "click", targetId: "move-target", postconditions: [{ source: "PROGRESS", key: "owned_tiles", operator: "CHANGED" }] },
        { type: "checkpoint", changeTargetId: "resource-food-icon", assertions: [{ source: "STATE", key: "screen_mode", operator: "EQUALS", value: "PLAYING" }] },
      ] } }],
    },
    assetPlacementPlan: { placements: [] },
  };
  const publisher = `
    # Container descendants receive the engine's settled sizes.
    var narrative = "${"x".repeat(500)}"
    var empty = ""
    { "schema": "deviludo.e2e-ui-probe", "state": { "screen_mode": "PLAYING" },
      "progress": { "move_budget": 2, "owned_tiles": 1 },
      "controls": ["reachable-", "relationship-xiaotian", "move", "resource-%s-icon"] }
    # The publisher's atomic replacement is complete.
  `;
  assert.deepEqual(unpublishedTestPlanProbeReferences(plan, [publisher]), [
    { kind: "CONTROL", value: "move-target" },
  ]);
});

test("cross-platform CJK UI requires a bundled and runtime-bound font", () => {
  const ui = 'title.text = "新建人生线"';
  assert.match(bundledCjkFontValidationError([ui], []) ?? "", /does not bundle/);
  assert.match(bundledCjkFontValidationError([ui], ["assets/fonts/game.ttf"]) ?? "", /does not reference/);
  assert.equal(bundledCjkFontValidationError([
    `${ui}\nvar font = load("res://assets/fonts/game.ttf")`,
  ], ["assets/fonts/game.ttf"]), null);
  assert.equal(bundledCjkFontValidationError(['# 中文注释\ntitle.text = "New game"'], []), null);
});

test("conditional asset placements require an explicit scripted observation at their checkpoint", () => {
  const plan = {
    testManifest: { features: [{ interactionScript: { events: [
      { type: "checkpoint", role: "READY", assertions: [] },
      { type: "checkpoint", role: "COMPLETION", changeTargetId: "next-event", assertions: [] },
    ] } }] },
    assetPlacementPlan: { placements: [
      { targetId: "relationship-xiaotian", checkpointRole: "READY" },
      { targetId: "ending-perfect-concealment", checkpointRole: "COMPLETION" },
    ] },
  };
  assert.deepEqual(unobservedTestPlanAssetPlacements(plan), [
    { targetId: "ending-perfect-concealment", checkpointRole: "COMPLETION" },
  ]);
  plan.testManifest.features[0].interactionScript.events[1].assertions.push({
    source: "CONTROL", targetId: "ending-perfect-concealment", property: "visible", operator: "EQUALS", value: true,
  } as never);
  assert.deepEqual(unobservedTestPlanAssetPlacements(plan), []);
});

test("MCP audit records summarize large tool results and redact credentials", () => {
  const result = summarizeToolAuditValue({
    context: { plan: "x".repeat(70_000), credentialSecretRef: "vault://must-not-persist" },
  });
  assert.ok(JSON.stringify(result).length < 8_000);
  assert.match(String((result.context as Record<string, unknown>).plan), /…$/);
  assert.equal((result.context as Record<string, unknown>).credentialSecretRef, "[REDACTED]");

  assert.deepEqual(summarizeToolAuditValue({
    path: "res://main.gd",
    apiKey: "sensitive",
  }), { path: "res://main.gd", apiKey: "[REDACTED]" });

  const calls = summarizeRuntimeToolCalls([{
    name: "context.read",
    arguments: {},
    result: { context: { nested: "x".repeat(70_000) } },
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
  }]);
  assert.ok(JSON.stringify(calls[0]).length < 8_000);
  assert.equal(summarizeRuntimeToolCalls([{
    name: "Bash (shell_command)",
    arguments: {}, result: {},
    startedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(),
  }])[0]?.name, "bash_shell_command");
  assert.throws(() => summarizeRuntimeToolCalls([{
    name: "",
    arguments: {}, result: {},
    startedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(),
  }]), /invalid tool call summary/);
});

test("Core has one Runtime path and controlled task images cannot execute Agent turns", async () => {
  const [api, runner, fixture, supervisor, turn, runtimeService] = await Promise.all([
    readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/sandbox-executor/task-runner.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/sandbox-executor/task-fixture-agent.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/sandbox-executor/src/project-runtime-supervisor.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/project-runtime/turn.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/project-runtime-service.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(api, /generateE2eTestPlan|generateE2ePlayerDecision|classifyConversationIntent|generateProductConversationReply/);
  assert.doesNotMatch(runner, /AGENT_TURN|runAgent|runProjectDocumentMaintenance/);
  assert.doesNotMatch(fixture, /AGENT_TURN/);
  assert.match(supervisor, /--cap-drop=ALL/);
  assert.match(supervisor, /--security-opt=no-new-privileges/);
  assert.match(supervisor, /size=256m/);
  assert.match(supervisor, /existing\.imageId !== runtimeImageId/);
  assert.doesNotMatch(supervisor, /docker\.sock|hypervisor|\/dev\/kvm/);
  assert.match(turn, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(turn, /--disable", "shell_tool/);
  assert.match(turn, /\/opt\/deviludo\/readonly-workspace/);
  assert.match(turn, /mcp_servers\.deviludo\.env_vars/);
  assert.match(turn, /ephemeralMcpConfig/);
  assert.match(turn, /request\.role === "INTENT"[\s\S]*model_reasoning_effort=low/);
  assert.match(turn, /liveWebSearch = request\.role === "DESIGN" \|\| request\.role === "UI_DESIGN"/);
  assert.match(turn, /liveWebSearch \? \["--search"\] : \[\]/);
  assert.match(turn, /liveWebSearch \? "WebSearch," : ""/);
  assert.match(turn, /WebFetch\$\{liveWebSearch \? "" : ",WebSearch"\}/);
  assert.match(turn, /Live web search is not authorized for this role/);
  assert.match(turn, /child\.stderr\.on\("data"[\s\S]*runtimeErrors\.push\(text\)/);
  assert.doesNotMatch(turn, /--ignore-user-config/);
  assert.match(runtimeService, /workflow\.analysisTurnId !== result\.turnId/);
  assert.match(runtimeService, /normalizeImportedProjectAnalysisReport\(input\.arguments\.analysis\)/);
});

test("conversation persistence does not reject replies when the workflow advances concurrently", async () => {
  const repository = await readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8");
  assert.doesNotMatch(repository, /PROJECT_STATE_CHANGED|expectedWorkflowState/);
});

test("all six signed role Skills exist and define the intended boundary", async () => {
  for (const role of ["intent", "analysis", "design", "ui-design", "development", "test"]) {
    const skill = await readFile(new URL(`../services/project-runtime/skills/${role}/SKILL.md`, import.meta.url), "utf8");
    assert.match(skill, /^---\nname: deviludo-/);
    assert.match(skill, /\n# /);
    assert.match(skill, /MCP|tool/i);
  }
  const designSkill = await readFile(new URL("../services/project-runtime/skills/design/SKILL.md", import.meta.url), "utf8");
  assert.match(designSkill, /readyForUiDesign/);
  assert.match(designSkill, /UI_DESIGN handoff/);
  assert.match(designSkill, /Do not design screen layouts/);
  assert.doesNotMatch(designSkill, /toRole":"DEVELOPMENT/);
  const uiDesignSkill = await readFile(new URL("../services/project-runtime/skills/ui-design/SKILL.md", import.meta.url), "utf8");
  assert.match(uiDesignSkill, /stable lowercase-hyphen control IDs/);
  assert.match(uiDesignSkill, /subject-grounded aesthetic thesis/);
  assert.match(uiDesignSkill, /DEVELOPMENT owns all UI code/);
  assert.match(uiDesignSkill, /handoff_create\(\{\"toRole\":\"DEVELOPMENT\"/);
  const testSkill = await readFile(new URL("../services/project-runtime/skills/test/SKILL.md", import.meta.url), "utf8");
  const developmentSkill = await readFile(new URL("../services/project-runtime/skills/development/SKILL.md", import.meta.url), "utf8");
  assert.match(developmentSkill, /Every generated game must publish the real-window E2E Probe/);
  assert.match(developmentSkill, /deviludo\.e2e-ui-probe/);
  assert.match(developmentSkill, /screen_mode.*session_active.*gameplay_input_enabled.*blocking_layer_count/s);
  assert.match(developmentSkill, /schedule one coalesced publication after the next `SceneTree\.process_frame`/);
  assert.match(developmentSkill, /do not sample construction-frame rectangles, sleep for a fixed duration, or invoke `NOTIFICATION_SORT_CHILDREN` manually/);
  assert.match(developmentSkill, /Every published interactive control must remain in the client root's `CanvasItem` ancestry/);
  assert.match(developmentSkill, /never publish a child control of a separate native `Window` as though its rectangle belonged to the main client/);
  assert.match(developmentSkill, /Each live stable ID must occur exactly once in every snapshot/);
  assert.match(developmentSkill, /generated gameplay IDs in a namespace disjoint from reserved navigation and overlay IDs/);
  assert.match(developmentSkill, /choice-\$\{domainId\}[\s\S]*choice-confirm/);
  assert.match(developmentSkill, /Give each native action exactly one activation authority/);
  assert.match(developmentSkill, /never let a `BaseButton` receive normal GUI handling[\s\S]*also calls `pressed\.emit\(\)`/);
  assert.match(developmentSkill, /Treat a repeated invalid rectangle sampled after the normal layout frame as conclusive layout evidence/);
  assert.match(developmentSkill, /native-input client coordinate space/);
  assert.match(developmentSkill, /start with `control\.get_transform\(\)`/);
  assert.match(developmentSkill, /left-multiplying each parent's `get_transform\(\)`/);
  assert.match(developmentSkill, /Do not derive this matrix from `Control\.get_global_rect\(\)`, `get_global_transform\(\)`/);
  assert.match(developmentSkill, /Do not convert client geometry through `get_screen_transform\(\)`/);
  assert.match(developmentSkill, /Do not substitute `get_stretch_transform\(\)`/);
  assert.match(developmentSkill, /do not move the rendered UI to compensate/);
  assert.match(testSkill, /sole test-manifest contract/);
  assert.match(testSkill, /call `source_list` and then `source_read`/);
  assert.match(testSkill, /return REPLAN without a Development handoff/);
  assert.match(testSkill, /preserve that exit activation and assert the lifecycle field it changes/);
  assert.match(testSkill, /A checkpoint role label alone does not prove that a conditional ending, overlay, or result screen was reached/);
  assert.match(testSkill, /do not ask DEVELOPMENT to expose an ending asset on an unrelated earlier screen/);
  assert.match(testSkill, /`inputProfiles` contains one or both unique values `KEYBOARD_MOUSE` and `GAMEPAD`/);
  assert.match(testSkill, /`PROJECT_CONCEPT` is design context only/);
  assert.match(testSkill, /Every interactive feature includes integer `timeoutMs` from 1 through 300000/);
  assert.match(testSkill, /Supply every `adaptivePlayer` field in the first call/);
  assert.match(testSkill, /Write `launchProfile` as the object/);
  assert.match(testSkill, /Never emit `event`, `eventType`, `captureMode`, `actions`, or `requirementIds` aliases/);
  assert.match(testSkill, /Never use an empty or partial plan to probe validation/);
  assert.match(testSkill, /never batch or parallelize alternative plan submissions/);
  assert.match(testSkill, /SOURCE_PROBE_CONTRACT_MISSING/);
  assert.match(testSkill, /Call `handoff_create` once with `toRole: "DEVELOPMENT"`/);
  assert.doesNotMatch(testSkill, /"key":"loop"/);
  assert.match(testSkill, /validation rejection is a correctable plan-authoring error/);
  assert.match(testSkill, /only no-plan completion is the durable `SOURCE_PROBE_CONTRACT_MISSING` Development handoff/);
});

test("UI Design uses the signed hyphenated Skill slug everywhere in the Runtime", async () => {
  const runtimeTurn = await readFile(new URL("../services/project-runtime/turn.mjs", import.meta.url), "utf8");
  assert.match(runtimeTurn, /UI_DESIGN: "ui-design"/);
  assert.match(runtimeTurn, /skills\/\$\{roleSkillSlug\}\/SKILL\.md/);
  assert.match(runtimeTurn, /deviludo-\$\{roleSkillSlug\}/);
  assert.doesNotMatch(runtimeTurn, /request\.role\.toLowerCase\(\)/);
  assert.doesNotMatch(runtimeTurn, /\["intent", "analysis", "design", "development", "test"\]/);
});

function result(role: ProjectRuntimeTurnResult["role"], structured: Readonly<Record<string, unknown>>): ProjectRuntimeTurnResult {
  return Object.freeze({
    schemaVersion: "deviludo.project-runtime.v2",
    turnId: "10000000-0000-4000-8000-000000000003",
    role,
    mode: "PRIMARY",
    content: JSON.stringify(structured),
    structured,
    toolCalls: [],
    sessionId: "session",
    branchId: null,
    sourceRevision: null,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
  });
}
