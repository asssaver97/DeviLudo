import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/stack";

type Conversation = Readonly<{
  id: string;
  projectId: string | null;
  mode: "NEW_GAME" | "PROJECT_FEEDBACK";
  messages: readonly Readonly<{
    role: "USER" | "ASSISTANT";
    content: string;
    metadata: Readonly<Record<string, unknown>>;
  }>[];
}>;

test("new-game conversations validate, persist and keep their context locked", async ({ stack }) => {
  for (const data of [
    null,
    { content: "x" },
    { content: "有效内容", conversationId: "not-a-uuid" },
    { content: "有效内容", projectId: "not-a-uuid" },
  ]) {
    const invalid = await stack.web("/api/conversations/messages", { method: "POST", data });
    expect(invalid.status()).toBe(400);
  }

  const missing = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: randomUUID(), content: "为这个不存在的项目提意见" },
  });
  expect(missing.status()).toBe(404);

  const started = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { content: "我想做一款以时间循环为核心的像素冒险游戏" },
  });
  expect(started.status()).toBe(201);
  const first = (await started.json() as { conversation: Conversation }).conversation;
  expect(first.mode).toBe("NEW_GAME");
  expect(first.projectId).toBeNull();
  expect(first.messages.map(message => message.role)).toEqual(["USER", "ASSISTANT"]);
  expect(first.messages[1].content).toContain("玩家每分钟最常做的动作");

  const continued = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { conversationId: first.id, content: "单局二十分钟，希望玩家感到紧张又好奇" },
  });
  expect(continued.status()).toBe(200);
  const second = (await continued.json() as { conversation: Conversation }).conversation;
  expect(second.messages).toHaveLength(4);
  expect(second.messages[3].content).toContain("失败与成功的判定");

  const read = await stack.web(`/api/conversations/${first.id}`);
  expect(read.ok()).toBeTruthy();
  expect((await read.json() as { conversation: Conversation }).conversation.messages).toHaveLength(4);
  expect((await stack.web(`/api/conversations/${randomUUID()}`)).status()).toBe(404);
  expect((await stack.web("/api/conversations/not-a-uuid")).status()).toBe(404);

  const project = await stack.createProject({ concept: "一个足够详细的现有游戏项目构想，用于验证上下文不能切换。" });
  const switched = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { conversationId: first.id, projectId: project.id, content: "尝试切换上下文" },
  });
  expect(switched.status()).toBe(409);
});

test("project conversations apply draft feedback and preserve locked deliveries", async ({ stack }) => {
  const project = await stack.createProject({
    name: "星港维修队",
    concept: "双人合作修理太空站，处理火灾、电力和导航故障。",
  });
  const draftFeedback = "增加手柄震动，并把每局时间调整为十分钟。";
  const drafted = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: project.id, content: draftFeedback },
  });
  expect(drafted.status()).toBe(201);
  const draftConversation = (await drafted.json() as { conversation: Conversation }).conversation;
  expect(draftConversation.mode).toBe("PROJECT_FEEDBACK");
  expect(draftConversation.projectId).toBe(project.id);
  expect(draftConversation.messages[1].metadata).toEqual({ appliedToDraft: true });
  expect(draftConversation.messages[1].content).toContain("规格草案");
  expect((await stack.readProject(project.id)).specification.revisionNotes).toContain(draftFeedback);

  const approved = await stack.web(`/api/projects/${project.id}/approve`, { method: "POST", data: {} });
  expect(approved.status()).toBe(202);
  const beforeLockedFeedback = await stack.waitForProject(project.id, value => value.workflowState !== "DRAFT");
  const notesBefore = beforeLockedFeedback.specification.revisionNotes;
  const lockedFeedback = "把所有关卡长度缩短一半，但不要影响当前正在执行的交付。";
  const locked = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: project.id, content: lockedFeedback },
  });
  expect(locked.status()).toBe(201);
  const lockedConversation = (await locked.json() as { conversation: Conversation }).conversation;
  expect(lockedConversation.messages[1].metadata).toEqual({ appliedToDraft: false });
  expect(lockedConversation.messages[1].content).toContain("本轮规格已经锁定");
  expect((await stack.readProject(project.id)).specification.revisionNotes).toEqual(notesBefore);
});
