import assert from "node:assert/strict";
import test from "node:test";
import {
  chronologicalMessages,
  failedOptimisticConversation,
  optimisticConversation,
} from "../lib/product/conversation-stream";

test("conversation messages are ordered oldest first even when timestamps are equal", () => {
  const messages = [
    { id: "12", role: "ASSISTANT" as const, content: "第三条", metadata: {}, createdAt: "2026-07-30T01:00:00.000Z" },
    { id: "10", role: "USER" as const, content: "第一条", metadata: {}, createdAt: "2026-07-30T01:00:00.000Z" },
    { id: "11", role: "ASSISTANT" as const, content: "第二条", metadata: {}, createdAt: "2026-07-30T01:00:00.000Z" },
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
  const failed = failedOptimisticConversation(pending, "设计 Agent 返回无效结构");
  assert.equal(failed.messages.length, 1);
  assert.equal(failed.messages[0].content, "增加新手引导");
  assert.equal(failed.messages[0].metadata.failed, true);
  assert.equal(failed.messages[0].metadata.pending, false);

  const retried = optimisticConversation(failed, "project-1", "增加新手引导");
  assert.equal(retried.messages.length, 1);
  assert.equal(retried.messages[0].metadata.pending, true);
  assert.equal(retried.messages[0].metadata.failed, undefined);
});
