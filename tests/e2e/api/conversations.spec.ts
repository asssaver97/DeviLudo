import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/stack";

type Conversation = Readonly<{
  id: string;
  projectId: string;
  mode: "NEW_GAME" | "PROJECT_FEEDBACK";
  messages: readonly Readonly<{
    role: "USER" | "ASSISTANT";
    content: string;
    metadata: Readonly<Record<string, unknown>>;
  }>[];
}>;

test("conversation stream emits reply deltas before the persisted result", async ({ stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "流式会话验证",
    concept: "验证设计搭档的回复会逐段进入对话框。",
  });
  const response = await stack.web("/api/conversations/messages/stream", {
    method: "POST",
    headers: { "idempotency-key": `conversation:${randomUUID()}` },
    data: { projectId: project.id, content: "请先给出一条清晰的玩法建议。" },
  });
  expect(response.status()).toBe(200);
  const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const deltas = events.filter(event => event.type === "agent_delta");
  const completedAt = events.findIndex(event => event.type === "complete");
  const documentAt = events.findIndex(event => event.type === "project_document");
  expect(deltas.length).toBeGreaterThan(1);
  expect(events.findIndex(event => event.type === "agent_delta")).toBeLessThan(completedAt);
  expect(documentAt).toBeGreaterThan(events.findIndex(event => event.type === "agent_delta"));
  expect(documentAt).toBeLessThan(completedAt);
  expect(deltas.map(event => event.delta).join("")).toContain("测试设计 Agent");
  expect(new Set(deltas.map(event => event.agentRole))).toEqual(new Set(["DESIGN", "DEVELOPMENT", "TEST"]));
  const complete = events[completedAt] as {
    conversation: Conversation;
    project: { document: { content: { introduction: string } } };
  };
  expect(complete.conversation.messages.map(message => message.role)).toEqual([
    "USER", "ASSISTANT", "ASSISTANT", "ASSISTANT",
  ]);
  expect(complete.conversation.messages.slice(1).map(message => message.metadata.agentRole)).toEqual([
    "DESIGN", "DEVELOPMENT", "TEST",
  ]);
  expect(complete.project.document.content.introduction).toBe("测试设计 Agent 已整理当前游戏需求。");
});

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

  const unconfigured = await stack.web("/api/conversations/messages", {
    method: "POST",
    headers: { "idempotency-key": `conversation:${randomUUID()}` },
    data: { content: "一款没有完成 Agent 配置的游戏构想" },
  });
  expect(unconfigured.status()).toBe(424);
  expect(await unconfigured.json()).toMatchObject({ code: "AGENT_CONFIG_REQUIRED" });
  expect(await stack.queryRows<{ count: number }>("SELECT count(*)::int AS count FROM deviludo.workspaces")).toEqual([{ count: 0 }]);

  await stack.configureAgent();

  const started = await stack.web("/api/conversations/messages", {
    method: "POST",
    headers: { "idempotency-key": `conversation:${randomUUID()}` },
    data: { content: "我想做一款以时间循环为核心的像素冒险游戏" },
  });
  expect(started.status()).toBe(201);
  const startedBody = await started.json() as {
    workspace: { id: string; name: string };
    project: { id: string; name: string };
    conversation: Conversation;
  };
  const first = startedBody.conversation;
  expect(first.mode).toBe("NEW_GAME");
  expect(first.projectId).toBe(startedBody.project.id);
  expect(startedBody.project.name).toBe("时间回廊");
  expect(startedBody.workspace.name).toBe("Local workspace");
  expect(first.messages.map(message => message.role)).toEqual([
    "USER", "ASSISTANT", "ASSISTANT", "ASSISTANT",
  ]);
  expect(first.messages[1].content).toContain("测试设计 Agent");
  expect(first.messages[1].metadata).toMatchObject({
    source: "AI_AGENT",
    agentRuntime: "CLAUDE_CODE",
    model: "claude-primary",
    settingsRevision: 1,
    appliedToDraft: true,
    projectDocumentUpdated: true,
  });

  const continued = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { conversationId: first.id, content: "单局二十分钟，希望玩家感到紧张又好奇" },
  });
  expect(continued.status()).toBe(200);
  const second = (await continued.json() as { conversation: Conversation }).conversation;
  expect(second.messages).toHaveLength(8);
  expect(second.messages[7].content).toContain("测试设计 Agent");

  const read = await stack.web(`/api/conversations/${first.id}`);
  expect(read.ok()).toBeTruthy();
  expect((await read.json() as { conversation: Conversation }).conversation.messages).toHaveLength(8);
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
  await stack.configureAgent();
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
  const draftedBody = await drafted.json() as {
    conversation: Conversation;
    project: { document: { revision: number; content: { introduction: string; gameplay: string } } };
  };
  const draftConversation = draftedBody.conversation;
  expect(draftConversation.mode).toBe("PROJECT_FEEDBACK");
  expect(draftConversation.projectId).toBe(project.id);
  expect(draftConversation.messages[1].metadata).toMatchObject({
    source: "AI_AGENT",
    appliedToDraft: true,
    readyForDevelopment: true,
    projectDocumentUpdated: true,
    options: ["强化资源管理", "增加随机事件"],
  });
  expect(draftConversation.messages[1].content).toContain("测试设计 Agent");
  expect(draftedBody.project.document).toMatchObject({
    revision: 2,
    content: {
      introduction: "测试设计 Agent 已整理当前游戏需求。",
      gameplay: "围绕玩家确认的核心循环进行操作、反馈与结算。",
    },
  });
  expect((await stack.readProject(project.id)).specification.revisionNotes).toContain(draftFeedback);

  await stack.executeSql(`
    UPDATE deviludo.workflow_instances
       SET state = 'E2E_TESTING', updated_at = clock_timestamp()
     WHERE id = '${project.workflowId}'::uuid;
  `);
  const beforeLockedFeedback = await stack.readProject(project.id);
  const notesBefore = beforeLockedFeedback.specification.revisionNotes;
  const lockedFeedback = "把所有关卡长度缩短一半，但不要影响当前正在执行的交付。";
  const locked = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: project.id, content: lockedFeedback },
  });
  expect(locked.status()).toBe(201);
  const lockedConversation = (await locked.json() as { conversation: Conversation }).conversation;
  expect(lockedConversation.messages[1].metadata).toMatchObject({ source: "AI_AGENT", appliedToDraft: false });
  expect(lockedConversation.messages[1].content).toContain("测试设计 Agent");
  expect((await stack.readProject(project.id)).specification.revisionNotes).toEqual(notesBefore);
});

test("an explicit development command in a draft conversation automatically approves the workflow", async ({ stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "对话批准验证",
    concept: "一个规格完整、可以直接进入开发的双人合作游戏。",
  });
  const started = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: project.id, content: "按照当前需求开始开发" },
  });
  expect(started.status()).toBe(201);
  expect((await started.json() as { project: { workflowState: string } }).project.workflowState).not.toBe("DRAFT");

  const discussionProject = await stack.createProject({
    name: "对话不误触验证",
    concept: "验证关于执行的提问不会被当成批准。",
  });
  const discussed = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: discussionProject.id, content: "如果现在开始开发，会发生什么？" },
  });
  expect(discussed.status()).toBe(201);
  expect((await discussed.json() as { project: { workflowState: string } }).project.workflowState).toBe("DRAFT");
});

test("messages sent during Agent generation become durable live guidance", async ({ stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "实时引导验证",
    concept: "验证开发 Agent 生成期间的进度和玩家引导不会丢失。",
  });
  const drafted = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: project.id, content: "先确认核心循环，再开始生成项目。" },
  });
  expect(drafted.status()).toBe(201);
  const conversation = (await drafted.json() as { conversation: Conversation }).conversation;
  const jobId = randomUUID();
  const leaseToken = randomUUID();
  await stack.executeSql(`
    UPDATE deviludo.workflow_instances
       SET state = 'AGENT_RUNNING', updated_at = clock_timestamp()
     WHERE id = '${project.workflowId}'::uuid;
    INSERT INTO deviludo.jobs(
      workspace_id, id, workflow_id, project_id, kind, pool_kind,
      required_capabilities, exclusive, runtime_image, output_contract,
      state, idempotency_key, lease_owner, lease_token, lease_expires_at, fencing_token
    ) VALUES (
      '${project.workspaceId}'::uuid, '${jobId}'::uuid, '${project.workflowId}'::uuid, '${project.id}'::uuid,
      'AGENT_GENERATION', 'CORE', ARRAY['MICROVM','NETWORK_POLICY'], false,
      'sha256:${"a".repeat(64)}', '{"kinds":["SPECIFICATION"],"maxBytes":1073741824}'::jsonb,
      'RUNNING', 'agent-guidance-e2e', 'e2e-held-agent', '${leaseToken}'::uuid,
      clock_timestamp() + interval '1 hour', 1
    );
  `);

  const guidance = "优先实现键盘操作，并让时间循环提示始终可见。";
  const guided = await stack.web("/api/conversations/messages/stream", {
    method: "POST",
    data: { conversationId: conversation.id, content: guidance },
  });
  expect(guided.status()).toBe(200);
  const completed = (await guided.text()).trim().split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .find(event => event.type === "complete") as { conversation: Conversation };
  expect(completed.conversation.messages).toHaveLength(5);
  expect(completed.conversation.messages[4]).toMatchObject({
    role: "USER",
    content: guidance,
    metadata: { source: "PLAYER_GUIDANCE", jobId },
  });
  expect(await stack.queryRows<{ content: string; state: string }>(`
    SELECT content, state FROM deviludo.job_guidance_messages WHERE job_id = '${jobId}'::uuid
  `)).toEqual([{ content: guidance, state: "PENDING" }]);

  const cookies = (await stack.apiRequest.storageState()).cookies
    .map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  const controller = new AbortController();
  const progressResponse = await fetch(
    new URL(`/api/projects/${project.id}/agent-progress/stream`, stack.webUrl),
    { headers: { cookie: cookies }, signal: controller.signal },
  );
  expect(progressResponse.ok).toBeTruthy();
  expect(progressResponse.headers.get("content-type")).toContain("text/event-stream");
  const reader = progressResponse.body?.getReader();
  expect(reader).toBeTruthy();
  const chunk = await reader!.read();
  controller.abort();
  const progressText = new TextDecoder().decode(chunk.value);
  expect(progressText).toContain("GUIDANCE_ACCEPTED");
  expect(progressText).toContain(guidance);
});

test("project conversations are listed by recency and project deletion removes the whole project boundary", async ({ stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "回声档案馆",
    concept: "玩家整理会改变历史的录音，并通过对话逐步确认游戏规则。",
  });
  const first = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: project.id, content: "先讨论录音回放与历史改写之间的核心循环。" },
  });
  expect(first.status()).toBe(201);
  const firstConversation = (await first.json() as { conversation: Conversation }).conversation;
  const continued = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { conversationId: firstConversation.id, content: "每次改写都消耗一段不可恢复的记忆。" },
  });
  expect(continued.status()).toBe(200);

  const second = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: project.id, content: "再单独讨论美术风格和声音反馈。" },
  });
  expect(second.status()).toBe(201);
  const secondConversation = (await second.json() as { conversation: Conversation }).conversation;

  const history = await stack.web(`/api/projects/${project.id}/conversations`);
  expect(history.status()).toBe(200);
  const summaries = (await history.json() as {
    conversations: readonly Readonly<{
      id: string;
      preview: string;
      messageCount: number;
      userMessageCount: number;
      systemGenerated: boolean;
    }>[];
  }).conversations;
  expect(summaries.map(item => item.id)).toEqual([secondConversation.id, firstConversation.id]);
  expect(summaries[0]).toMatchObject({
    preview: "再单独讨论美术风格和声音反馈。",
    messageCount: 4,
    userMessageCount: 1,
    systemGenerated: false,
  });
  expect(summaries[1]).toMatchObject({
    preview: "先讨论录音回放与历史改写之间的核心循环。",
    messageCount: 8,
    userMessageCount: 2,
    systemGenerated: false,
  });

  const deleted = await stack.web(`/api/projects/${project.id}`, { method: "DELETE" });
  expect(deleted.status()).toBe(204);
  expect((await stack.web(`/api/projects/${project.id}`)).status()).toBe(404);
  expect((await stack.web(`/api/projects/${project.id}/conversations`)).status()).toBe(404);
  expect((await stack.web(`/api/conversations/${firstConversation.id}`)).status()).toBe(404);
});
