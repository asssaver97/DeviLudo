import assert from "node:assert/strict";
import test from "node:test";
import { chronologicalMessages } from "../lib/product/conversation-stream";

test("conversation messages are ordered oldest first even when timestamps are equal", () => {
  const messages = [
    { id: "12", role: "ASSISTANT" as const, content: "第三条", metadata: {}, createdAt: "2026-07-30T01:00:00.000Z" },
    { id: "10", role: "USER" as const, content: "第一条", metadata: {}, createdAt: "2026-07-30T01:00:00.000Z" },
    { id: "11", role: "ASSISTANT" as const, content: "第二条", metadata: {}, createdAt: "2026-07-30T01:00:00.000Z" },
  ];
  assert.deepEqual(chronologicalMessages(messages).map(message => message.id), ["10", "11", "12"]);
});
