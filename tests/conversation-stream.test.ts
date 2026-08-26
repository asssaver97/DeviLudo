import assert from "node:assert/strict";
import test from "node:test";
import {
  appendStreamingConversationReply,
  chronologicalMessages,
  completeStreamingConversationReply,
  failedOptimisticConversation,
  initialStreamingConversationReplies,
  optimisticConversation,
  startStreamingConversationReply,
  streamingConversationReplyIsActive,
} from "../lib/product/conversation-stream";
import { MAX_CONVERSATION_IMAGE_BYTES } from "../lib/product/contracts";

test("conversation images allow up to eight MiB per file", () => {
  assert.equal(MAX_CONVERSATION_IMAGE_BYTES, 8 * 1024 * 1024);
});

test("streaming reply activity moves from thinking to typing and then clears its status", () => {
  const initial = initialStreamingConversationReplies();
  assert.deepEqual(initial, {});

  const developmentStarted = startStreamingConversationReply(initial, "DEVELOPMENT");
  assert.deepEqual(developmentStarted, { DEVELOPMENT: { content: "", phase: "THINKING" } });

  const typing = appendStreamingConversationReply(developmentStarted, "DEVELOPMENT", "先检查控制器。");
  assert.deepEqual(typing, { DEVELOPMENT: { content: "先检查控制器。", phase: "TYPING" } });
  assert.equal(streamingConversationReplyIsActive(typing.DEVELOPMENT!), true);

  const complete = completeStreamingConversationReply(typing, "DEVELOPMENT");
  assert.deepEqual(complete, { DEVELOPMENT: { content: "先检查控制器。", phase: "COMPLETE" } });
  assert.equal(streamingConversationReplyIsActive(complete.DEVELOPMENT!), false);
});

test("completed Agent replies remain visible without a status while the next Agent thinks", () => {
  const designComplete = completeStreamingConversationReply(
    appendStreamingConversationReply(initialStreamingConversationReplies(), "DESIGN", "设计结论"),
    "DESIGN",
  );
  assert.deepEqual(startStreamingConversationReply(designComplete, "TEST"), {
    DESIGN: { content: "设计结论", phase: "COMPLETE" },
    TEST: { content: "", phase: "THINKING" },
  });
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
