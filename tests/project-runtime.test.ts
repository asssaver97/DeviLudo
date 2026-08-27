import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  lightweightProjectRuntimeIntent,
  parseProjectRuntimeIntent,
  parseProjectRuntimeReply,
  projectRuntimeIntentPrompt,
  projectRuntimeSpecialistPrompt,
} from "@/services/core/src/project-runtime-conversation";
import {
  summarizeRuntimeToolCalls,
  summarizeToolAuditValue,
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

test("Design discovery converges after repeated choices or delegated recommendations", () => {
  const question = (id: string, label: string): ProductConversationMessage => Object.freeze({
    id,
    role: "ASSISTANT",
    content: "请选择",
    attachments: Object.freeze([]),
    metadata: Object.freeze({
      agentRole: "DESIGN",
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
  ], "规则 B（推荐）"), {
    consecutiveChoiceTurns: 2,
    consecutiveRecommendedSelections: 2,
    mustConverge: true,
  });
  assert.equal(designConversationConvergence([
    question("q1", "A（推荐）"), player("u1", "自定义 A"),
    question("q2", "B（推荐）"), player("u2", "自定义 B"),
    question("q3", "C（推荐）"),
  ], "自定义 C").mustConverge, true);
  assert.equal(designConversationConvergence([
    question("q1", "A（推荐）"),
  ], "都按照建议来").mustConverge, true);

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
      consecutiveChoiceTurns: 3,
      consecutiveRecommendedSelections: 1,
      mustConverge: true,
    }),
  });
  assert.match(forcedPrompt, /Do not ask another question/);
  assert.match(forcedPrompt, /set readyForDevelopment=true in this turn/);
});

test("lightweight Intent routes common messages without a Runtime turn", () => {
  for (const authorization of [
    "按此计划开发",
    "按当前计划开发（推荐）",
    "按照当前计划开发",
    "BUILD CURRENT PLAN",
  ]) {
    assert.equal(isDevelopmentAuthorization(authorization), true);
    assert.deepEqual(lightweightProjectRuntimeIntent({
      content: authorization,
      hasAttachments: false,
      hasPendingChange: false,
    }), {
      intent: "CHANGE_REQUEST",
      targetRole: "DEVELOPMENT",
      explicitExecution: true,
      actionable: true,
      summary: "Start development from the approved current plan.",
    });
  }
  assert.equal(isDevelopmentAuthorization("调整当前计划"), false);
  assert.deepEqual(lightweightProjectRuntimeIntent({
    content: "按此计划开发",
    hasAttachments: false,
    hasPendingChange: true,
  }), {
    intent: "CONFIRM_CHANGE",
    targetRole: "DEVELOPMENT",
    explicitExecution: false,
    actionable: false,
    summary: "Confirm the pending implementation change and start development.",
  });
  assert.deepEqual(lightweightProjectRuntimeIntent({
    content: "都按照建议来",
    hasAttachments: false,
    hasPendingChange: false,
  }), {
    intent: "CHANGE_REQUEST",
    targetRole: "DESIGN",
    explicitExecution: true,
    actionable: true,
    summary: "Update the implementation according to the player's request.",
  });
  assert.equal(designReplyAction({
    intent: "CHANGE_REQUEST",
    targetRole: "DESIGN",
    explicitExecution: true,
    actionable: true,
    summary: "Accept every recommended design choice and begin development.",
  }, "DESIGN"), "START_DEVELOPMENT");
  assert.deepEqual(lightweightProjectRuntimeIntent({
    content: "当前测试进度是什么？",
    hasAttachments: false,
    hasPendingChange: true,
  }), {
    intent: "QUESTION",
    targetRole: "TEST",
    explicitExecution: false,
    actionable: false,
    summary: "Answer the player's question from the current project context.",
  });
  assert.deepEqual(lightweightProjectRuntimeIntent({
    content: "能不能增加键盘和手柄都能完成核心循环的能力？",
    hasAttachments: false,
    hasPendingChange: false,
  }), {
    intent: "CHANGE_REQUEST",
    targetRole: "DESIGN",
    explicitExecution: false,
    actionable: true,
    summary: "Update the implementation according to the player's request.",
  });
  assert.equal(lightweightProjectRuntimeIntent({
    content: "看看这个",
    hasAttachments: true,
    hasPendingChange: false,
  }), null);
  assert.deepEqual(lightweightProjectRuntimeIntent({
    content: "都按照建议来",
    hasAttachments: false,
    hasPendingChange: true,
  }), {
    intent: "CONFIRM_CHANGE",
    targetRole: "DESIGN",
    explicitExecution: false,
    actionable: false,
    summary: "Confirm the pending implementation change.",
  });
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
    modelOverrides: { intent: null, analysis: null, design: null, development: null, test: "test-model" },
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

test("ready Design replies end with a development plan and localized confirmation question", () => {
  const settings = {
    agentRuntime: "CODEX_CLI" as const,
    baseUrl: "https://chatgpt.com",
    primaryModel: "primary",
    modelOverrides: { intent: null, analysis: null, design: null, development: null, test: null },
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

  const reply = parseProjectRuntimeReply(result("DESIGN", {
    content: "玩法和验收目标已经明确。",
    readyForDevelopment: true,
    options: [],
    implementationBrief: "先完成核心循环，再接入界面与验收测试。",
    projectDocumentPatch: {},
    e2eGoalDelta: { add: [], replace: [], retire: [] },
  }), "DESIGN", settings, "zh", "AWAITING_CONFIRMATION");
  assert.match(reply.content, /开发计划\n先完成核心循环，再接入界面与验收测试。/u);
  assert.ok(reply.content.endsWith("是否按照当前计划开发？"));

  const authorized = parseProjectRuntimeReply(result("DESIGN", {
    content: "玩法和验收目标已经明确。\n\n## 实施计划（按风险排序）\n先完成核心循环。\n\n**开发计划**\n这段重复计划不应出现。\n\n是否按照当前计划开发？",
    readyForDevelopment: true,
    options: [],
    implementationBrief: "先完成核心循环，再接入界面与验收测试。",
    projectDocumentPatch: {},
    e2eGoalDelta: { add: [], replace: [], retire: [] },
  }), "DESIGN", settings, "zh", "START_DEVELOPMENT");
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
  assert.match(supervisor, /size=64m/);
  assert.match(supervisor, /existing\.imageId !== runtimeImageId/);
  assert.doesNotMatch(supervisor, /docker\.sock|hypervisor|\/dev\/kvm/);
  assert.match(turn, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(turn, /--disable", "shell_tool/);
  assert.match(turn, /\/opt\/deviludo\/readonly-workspace/);
  assert.match(turn, /mcp_servers\.deviludo\.env_vars/);
  assert.match(turn, /ephemeralMcpConfig/);
  assert.match(turn, /request\.role === "INTENT"[\s\S]*model_reasoning_effort=low/);
  assert.match(turn, /child\.stderr\.on\("data"[\s\S]*runtimeErrors\.push\(text\)/);
  assert.doesNotMatch(turn, /--ignore-user-config/);
  assert.match(runtimeService, /workflow\.analysisTurnId !== result\.turnId/);
  assert.match(runtimeService, /normalizeImportedProjectAnalysisReport\(input\.arguments\.analysis\)/);
});

test("conversation persistence does not reject replies when the workflow advances concurrently", async () => {
  const repository = await readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8");
  assert.doesNotMatch(repository, /PROJECT_STATE_CHANGED|expectedWorkflowState/);
});

test("all five signed role Skills exist and define the intended boundary", async () => {
  for (const role of ["intent", "analysis", "design", "development", "test"]) {
    const skill = await readFile(new URL(`../services/project-runtime/skills/${role}/SKILL.md`, import.meta.url), "utf8");
    assert.match(skill, /^---\nname: deviludo-/);
    assert.match(skill, /\n# /);
    assert.match(skill, /MCP|tool/i);
  }
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
