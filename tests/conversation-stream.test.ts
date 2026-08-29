import assert from "node:assert/strict";
import test from "node:test";
import {
  appendStreamingConversationProcess,
  appendStreamingConversationReply,
  appendStreamingDevelopmentLog,
  chronologicalMessages,
  completeStreamingConversationReply,
  failedOptimisticConversation,
  initialStreamingConversationReplies,
  optimisticConversation,
  replaceStreamingConversationReply,
  sendConversationMessageStream,
  startStreamingConversationReply,
  streamingConversationReplyIsActive,
  updateStreamingConversationActivity,
} from "../lib/product/conversation-stream";
import { MAX_CONVERSATION_IMAGE_BYTES } from "../lib/product/contracts";

test("conversation images allow up to eight MiB per file", () => {
  assert.equal(MAX_CONVERSATION_IMAGE_BYTES, 8 * 1024 * 1024);
});

test("streaming reply activity moves from thinking to typing and then clears its status", () => {
  const initial = initialStreamingConversationReplies();
  assert.deepEqual(initial, {});

  const developmentStarted = startStreamingConversationReply(initial, "DEVELOPMENT");
  assert.deepEqual(developmentStarted, {
    DEVELOPMENT: { content: "", processEvents: [], phase: "THINKING", activity: null, developmentLogs: [] },
  });

  const withLog = appendStreamingDevelopmentLog(developmentStarted, "DEVELOPMENT", "正在执行测试");
  assert.deepEqual(withLog, {
    DEVELOPMENT: { content: "", processEvents: [], phase: "TYPING", activity: null, developmentLogs: ["正在执行测试"] },
  });

  const typing = appendStreamingConversationReply(withLog, "DEVELOPMENT", "先检查控制器。");
  assert.deepEqual(typing, {
    DEVELOPMENT: { content: "先检查控制器。", processEvents: [], phase: "TYPING", activity: null, developmentLogs: ["正在执行测试"] },
  });
  assert.equal(streamingConversationReplyIsActive(typing.DEVELOPMENT!), true);

  const complete = completeStreamingConversationReply(typing, "DEVELOPMENT");
  assert.deepEqual(complete, {
    DEVELOPMENT: { content: "先检查控制器。", processEvents: [], phase: "COMPLETE", activity: null, developmentLogs: ["正在执行测试"] },
  });
  assert.equal(streamingConversationReplyIsActive(complete.DEVELOPMENT!), false);
});

test("completed Agent replies remain visible without a status while the next Agent thinks", () => {
  const designComplete = completeStreamingConversationReply(
    appendStreamingConversationReply(
      updateStreamingConversationActivity(initialStreamingConversationReplies(), "DESIGN", "正在读取项目上下文"),
      "DESIGN",
      "设计结论",
    ),
    "DESIGN",
  );
  assert.deepEqual(startStreamingConversationReply(designComplete, "TEST"), {
    DESIGN: { content: "设计结论", processEvents: [], phase: "COMPLETE", activity: null, developmentLogs: [] },
    TEST: { content: "", processEvents: [], phase: "THINKING", activity: null, developmentLogs: [] },
  });
});

test("a UI Design stream replaces the completed transient Intent reply", () => {
  const intentComplete = completeStreamingConversationReply(
    startStreamingConversationReply(initialStreamingConversationReplies(), "INTENT"),
    "INTENT",
  );
  assert.deepEqual(startStreamingConversationReply(intentComplete, "UI_DESIGN"), {
    UI_DESIGN: { content: "", processEvents: [], phase: "THINKING", activity: null, developmentLogs: [] },
  });
});

test("conversation SSE accepts UI Design Agent lifecycle events", async () => {
  const originalFetch = globalThis.fetch;
  const observed: string[] = [];
  globalThis.fetch = async () => new Response([
    JSON.stringify({ type: "agent_start", agentRole: "UI_DESIGN" }),
    JSON.stringify({ type: "agent_process", agentRole: "UI_DESIGN", event: "正在规划界面" }),
    JSON.stringify({ type: "agent_complete", agentRole: "UI_DESIGN" }),
    JSON.stringify({
      type: "complete",
      workspace: { id: "workspace" },
      project: { id: "project" },
      conversation: { id: "conversation" },
      intentDecision: { targetRole: "UI_DESIGN" },
      workflowAction: "NONE",
    }),
    "",
  ].join("\n"), { status: 200 });
  try {
    await sendConversationMessageStream({ content: "重新设计 UI" }, "request", {
      onAgentStart: role => observed.push(`start:${role}`),
      onAgentProcess: role => observed.push(`process:${role}`),
      onAgentDelta: role => observed.push(`delta:${role}`),
      onAgentReplace: role => observed.push(`replace:${role}`),
      onAgentActivity: role => observed.push(`activity:${role}`),
      onAgentDevelopmentLog: role => observed.push(`log:${role}`),
      onAgentComplete: role => observed.push(`complete:${role}`),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(observed, ["start:UI_DESIGN", "process:UI_DESIGN", "complete:UI_DESIGN"]);
});

test("completed tool activity clears immediately and final normalization can replace streamed text", () => {
  const reading = updateStreamingConversationActivity(
    startStreamingConversationReply(initialStreamingConversationReplies(), "DESIGN"),
    "DESIGN",
    "正在读取项目上下文",
  );
  const cleared = updateStreamingConversationActivity(reading, "DESIGN", "");
  assert.deepEqual(cleared.DESIGN, {
    content: "",
    processEvents: [],
    phase: "THINKING",
    activity: null,
    developmentLogs: [],
  });
  const partial = appendStreamingConversationReply(cleared, "DESIGN", "原始计划");
  assert.deepEqual(replaceStreamingConversationReply(partial, "DESIGN", "规范化后的开发计划").DESIGN, {
    content: "规范化后的开发计划",
    processEvents: [],
    phase: "TYPING",
    activity: null,
    developmentLogs: [],
  });
});

test("Runtime process rendering extracts text and ignores JSON-only transport events", () => {
  const started = startStreamingConversationReply(initialStreamingConversationReplies(), "DESIGN");
  const thinking = appendStreamingConversationProcess(started, "DESIGN", "{\"type\":\"item.started\"}\n");
  assert.deepEqual(thinking.DESIGN?.processEvents, []);
  assert.equal(thinking.DESIGN?.phase, "THINKING");
  const reasoningEvent = `${JSON.stringify({
    type: "item.completed",
    item: { type: "reasoning", text: "先检查核心循环。" },
  })}\n`;
  const reading = appendStreamingConversationProcess(thinking, "DESIGN", reasoningEvent);
  const duplicate = appendStreamingConversationProcess(reading, "DESIGN", reasoningEvent);
  assert.deepEqual(duplicate.DESIGN?.processEvents, [
    "先检查核心循环。\n",
    "先检查核心循环。\n",
  ]);
  assert.equal(duplicate.DESIGN?.phase, "TYPING");
  const replaced = replaceStreamingConversationReply(duplicate, "DESIGN", "最终设计结论");
  assert.equal(replaced.DESIGN?.content, "最终设计结论");
  assert.deepEqual(replaced.DESIGN?.processEvents, []);
});

test("development logs cannot be attached to a Design Agent reply", () => {
  const design = appendStreamingDevelopmentLog(
    startStreamingConversationReply(initialStreamingConversationReplies(), "DESIGN"),
    "DESIGN",
    "不应显示的开发日志",
  );
  assert.deepEqual(design.DESIGN?.developmentLogs, []);
});

test("conversation messages are ordered oldest first even when timestamps are equal", () => {
  const messages = [
    { id: "12", role: "ASSISTANT" as const, content: "第三条", attachments: [], metadata: {}, createdAt: "2026-07-30T01:00:00.000Z", completedAt: "2026-07-30T01:00:03.000Z" },
    { id: "10", role: "USER" as const, content: "第一条", attachments: [], metadata: {}, createdAt: "2026-07-30T01:00:00.000Z", completedAt: "2026-07-30T01:00:01.000Z" },
    { id: "11", role: "ASSISTANT" as const, content: "第二条", attachments: [], metadata: {}, createdAt: "2026-07-30T01:00:00.000Z", completedAt: "2026-07-30T01:00:02.000Z" },
  ];
  assert.deepEqual(chronologicalMessages(messages).map(message => message.id), ["10", "11", "12"]);
});

test("failed optimistic requirements remain visible and can be retried without duplication", () => {
  const conversation = {
    id: "conversation-1",
    projectId: "project-1",
    mode: "PROJECT_FEEDBACK" as const,
    title: "项目会话",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    messages: Object.freeze([]),
  };
  const pending = optimisticConversation(conversation, "project-1", "增加新手引导");
  assert.equal(pending.messages[0].completedAt, null);
  const failed = failedOptimisticConversation(pending, "设计 Agent 返回无效结构");
  assert.equal(failed.messages.length, 1);
  assert.equal(failed.messages[0].content, "增加新手引导");
  assert.equal(failed.messages[0].metadata.failed, true);
  assert.equal(failed.messages[0].metadata.pending, false);
  assert.ok(Number.isFinite(Date.parse(failed.messages[0].completedAt ?? "")));

  const retried = optimisticConversation(failed, "project-1", "增加新手引导");
  assert.equal(retried.messages.length, 1);
  assert.equal(retried.messages[0].metadata.pending, true);
  assert.equal(retried.messages[0].metadata.failed, undefined);
  assert.equal(retried.messages[0].completedAt, null);
});
