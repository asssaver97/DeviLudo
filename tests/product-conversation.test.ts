import assert from "node:assert/strict";
import test from "node:test";
import { createProductConversationReply } from "../services/core/src/product-conversation";

test("new game conversations ask for concrete design constraints over successive turns", () => {
  const first = createProductConversationReply({
    userContent: "一款双人合作修理太空站的游戏",
    turnNumber: 1,
    project: null,
  });
  assert.equal(first.appliedToDraft, false);
  assert.match(first.content, /玩家每分钟最常做的动作/);

  const next = createProductConversationReply({
    userContent: "每局十分钟，强调混乱中的默契",
    turnNumber: 2,
    project: null,
  });
  assert.match(next.content, /失败与成功的判定/);
});

test("project feedback only mutates draft specifications", () => {
  const draft = createProductConversationReply({
    userContent: "增加手柄震动提示",
    turnNumber: 1,
    project: { name: "星港维修队", workflowState: "DRAFT" },
  });
  assert.equal(draft.appliedToDraft, true);
  assert.match(draft.content, /加入《星港维修队》的规格草案/);

  const running = createProductConversationReply({
    userContent: "把所有关卡缩短一半",
    turnNumber: 1,
    project: { name: "星港维修队", workflowState: "E2E_TESTING" },
  });
  assert.equal(running.appliedToDraft, false);
  assert.match(running.content, /本轮规格已经锁定/);
  assert.match(running.content, /跨平台测试中/);
});

test("conversation summaries stay compact", () => {
  const reply = createProductConversationReply({
    userContent: "很长的想法".repeat(40),
    turnNumber: 1,
    project: null,
  });
  assert.ok(reply.content.length < 220);
  assert.match(reply.content, /…/);
});
