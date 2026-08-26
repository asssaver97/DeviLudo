import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/stack";

type Conversation = Readonly<{
  id: string;
  projectId: string;
  mode: "NEW_GAME" | "PROJECT_FEEDBACK";
  messages: readonly Readonly<{
    id: string;
    role: "USER" | "ASSISTANT";
    content: string;
    attachments: readonly Readonly<{
      id: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
    }>[];
    metadata: Readonly<Record<string, unknown>>;
    createdAt: string;
    completedAt: string;
  }>[];
}>;

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";

test("conversation stream emits reply deltas before the persisted result", async ({ stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "流式会话验证",
    concept: "验证设计搭档的回复会逐段进入对话框。",
  });
  const requestStartedAt = Date.now();
  const response = await stack.web("/api/conversations/messages/stream", {
    method: "POST",
    headers: { "idempotency-key": `conversation:${randomUUID()}` },
    data: { projectId: project.id, content: "请先给出一条清晰的玩法建议。" },
  });
  const requestFinishedAt = Date.now();
  expect(response.status()).toBe(200);
  const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const starts = events.filter(event => event.type === "agent_start");
  const deltas = events.filter(event => event.type === "agent_delta");
  const agentCompleted = events.filter(event => event.type === "agent_complete");
  const completedAt = events.findIndex(event => event.type === "complete");
  const documentAt = events.findIndex(event => event.type === "project_document");
  expect(deltas.length).toBeGreaterThan(1);
  expect(starts).toEqual([{ type: "agent_start", agentRole: "DESIGN" }]);
  expect(agentCompleted).toEqual([{ type: "agent_complete", agentRole: "DESIGN" }]);
  expect(events.findIndex(event => event.type === "agent_start")).toBeLessThan(events.findIndex(event => event.type === "agent_delta"));
  expect(events.findIndex(event => event.type === "agent_delta")).toBeLessThan(events.findIndex(event => event.type === "agent_complete"));
  expect(events.findIndex(event => event.type === "agent_complete")).toBeLessThan(completedAt);
  expect(events.findIndex(event => event.type === "agent_delta")).toBeLessThan(completedAt);
  expect(documentAt).toBe(-1);
  expect(deltas.map(event => event.delta).join("")).toContain("测试设计 Agent");
  expect(new Set(deltas.map(event => event.agentRole))).toEqual(new Set(["DESIGN"]));
  const complete = events[completedAt] as {
    conversation: Conversation;
    project: { document: { revision: number; content: { introduction: string } } };
    intentDecision: { intent: string };
    workflowAction: string;
  };
  expect(complete.conversation.messages.map(message => message.role)).toEqual(["USER", "ASSISTANT"]);
  for (const message of complete.conversation.messages) {
    const createdAt = Date.parse(message.createdAt);
    const messageCompletedAt = Date.parse(message.completedAt);
    expect(Number.isFinite(messageCompletedAt)).toBe(true);
    expect(messageCompletedAt).toBeGreaterThanOrEqual(createdAt);
    expect(messageCompletedAt).toBeGreaterThanOrEqual(requestStartedAt - 1_000);
    expect(messageCompletedAt).toBeLessThanOrEqual(requestFinishedAt + 1_000);
  }
  expect(complete.conversation.messages[1].metadata.agentRole).toBe("DESIGN");
  expect(complete.intentDecision.intent).toBe("QUESTION");
  expect(complete.workflowAction).toBe("NONE");
  expect(complete.project.document.revision).toBe(1);
  expect(complete.project.document.content.introduction).not.toBe("测试设计 Agent 已整理当前游戏需求。");
});

test("conversation images are validated, persisted, displayed through an authenticated boundary, and exposed to the reply Agent", async ({ stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "会话图片验证",
    concept: "验证用户可以把截图作为项目会话上下文发送。",
  });
  const sent = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: {
      projectId: project.id,
      content: "请分析这张界面截图，不要修改实现。",
      attachments: [{
        filename: "game-ui.png",
        contentType: "image/png",
        dataBase64: ONE_PIXEL_PNG,
      }],
    },
  });
  expect(sent.status()).toBe(201);
  const conversation = (await sent.json() as { conversation: Conversation }).conversation;
  const userMessage = conversation.messages[0];
  expect(userMessage.attachments).toHaveLength(1);
  expect(userMessage.attachments[0]).toMatchObject({
    filename: "game-ui.png",
    contentType: "image/png",
    sizeBytes: Buffer.from(ONE_PIXEL_PNG, "base64").length,
  });
  expect(JSON.stringify(userMessage.metadata)).not.toContain("workspaces/");

  const image = await stack.web(
    `/api/conversations/${conversation.id}/messages/${userMessage.id}/images/${userMessage.attachments[0].id}`,
  );
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toContain("image/png");
  expect(Buffer.from(await image.body())).toEqual(Buffer.from(ONE_PIXEL_PNG, "base64"));

  const reloaded = await stack.web(`/api/conversations/${conversation.id}`);
  expect(reloaded.status()).toBe(200);
  expect((await reloaded.json() as { conversation: Conversation }).conversation.messages[0].attachments)
    .toEqual(userMessage.attachments);

  const disguised = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: {
      projectId: project.id,
      content: "这不是 JPEG。",
      attachments: [{ filename: "fake.jpg", contentType: "image/jpeg", dataBase64: ONE_PIXEL_PNG }],
    },
  });
  expect(disguised.status()).toBe(400);

  const maximumImage = Buffer.alloc(8 * 1024 * 1024);
  Buffer.from(ONE_PIXEL_PNG, "base64").copy(maximumImage);
  const acceptedBoundary = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: {
      projectId: project.id,
      content: "验证八兆图片边界。",
      attachments: [{ filename: "eight-mib.png", contentType: "image/png", dataBase64: maximumImage.toString("base64") }],
    },
  });
  expect(acceptedBoundary.status()).toBe(201);

  const oversizedImage = Buffer.alloc(8 * 1024 * 1024 + 1);
  Buffer.from(ONE_PIXEL_PNG, "base64").copy(oversizedImage);
  const rejectedBoundary = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: {
      projectId: project.id,
      content: "拒绝超过八兆的图片。",
      attachments: [{ filename: "over-eight-mib.png", contentType: "image/png", dataBase64: oversizedImage.toString("base64") }],
    },
  });
  expect(rejectedBoundary.status()).toBe(400);
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
  expect(startedBody.project.name).toBe("我想做一款以时间循环为核心的像素冒险游戏");
  expect(startedBody.workspace.name).toBe("Local workspace");
  expect(first.messages.map(message => message.role)).toEqual([
    "USER", "ASSISTANT",
  ]);
  expect(first.messages[1].content).toContain("测试设计 Agent");
  expect(first.messages[1].metadata).toMatchObject({
    source: "AI_AGENT",
    agentRuntime: "CLAUDE_CODE",
    model: "claude-primary",
    settingsRevision: 1,
    appliedToDraft: false,
    projectDocumentUpdated: false,
  });

  const continued = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { conversationId: first.id, content: "单局二十分钟，希望玩家感到紧张又好奇" },
  });
  expect(continued.status()).toBe(200);
  const second = (await continued.json() as { conversation: Conversation }).conversation;
  expect(second.messages).toHaveLength(4);
  expect(second.messages[3].content).toContain("测试设计 Agent");

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

test("project conversations apply explicit feedback, defer tentative changes, and abandon an unconfirmed direction", async ({ stack }) => {
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
    changeRequest: { state: string };
    workflowAction: string;
  };
  const draftConversation = draftedBody.conversation;
  expect(draftConversation.mode).toBe("PROJECT_FEEDBACK");
  expect(draftConversation.projectId).toBe(project.id);
  expect(draftConversation.messages[1].metadata).toMatchObject({
    source: "AI_AGENT",
    appliedToDraft: false,
    readyForDevelopment: true,
    projectDocumentUpdated: false,
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
  expect(draftedBody.changeRequest.state).toBe("APPLIED");
  expect(draftedBody.workflowAction).toBe("AGENT_STARTED");
  expect((await stack.readProject(project.id)).specification.revisionNotes).not.toContain(draftFeedback);

  const lockedProject = await stack.createProject({
    name: "运行中含糊变更",
    concept: "验证运行中的假设性调整先等待用户确认。",
  });
  await stack.executeSql(`
    UPDATE deviludo.workflow_instances
       SET state = 'TESTING', updated_at = clock_timestamp()
     WHERE id = '${lockedProject.workflowId}'::uuid;
  `);
  const beforeLockedFeedback = await stack.readProject(lockedProject.id);
  const notesBefore = beforeLockedFeedback.specification.revisionNotes;
  const lockedFeedback = "如果把所有关卡长度缩短一半，会有什么影响？";
  const locked = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: lockedProject.id, content: lockedFeedback },
  });
  expect(locked.status()).toBe(201);
  const lockedBody = await locked.json() as {
    conversation: Conversation;
    workflowAction: string;
    changeRequest: { id: string; state: string };
  };
  const lockedConversation = lockedBody.conversation;
  expect(lockedConversation.messages[1].metadata).toMatchObject({ source: "AI_AGENT", appliedToDraft: false });
  expect(lockedConversation.messages[1].content).toContain("测试设计 Agent");
  expect(lockedBody.workflowAction).toBe("AWAITING_CONFIRMATION");
  expect(lockedBody.changeRequest.state).toBe("PENDING");
  expect((await stack.readProject(lockedProject.id)).specification.revisionNotes).toEqual(notesBefore);

  const followUp = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { conversationId: lockedConversation.id, content: "当前测试进度是什么？" },
  });
  expect(followUp.status()).toBe(200);
  const followUpBody = await followUp.json() as {
    intentDecision: { intent: string };
    project: { pendingImplementationChange: unknown };
    workflowAction: string;
  };
  expect(followUpBody.intentDecision.intent).toBe("QUESTION");
  expect(followUpBody.workflowAction).toBe("NONE");
  expect(followUpBody.project.pendingImplementationChange).toBeNull();
  expect(await stack.queryRows<{ decision: string; state: string }>(`
    SELECT decision, state
      FROM deviludo.implementation_change_requests
     WHERE id = '${lockedBody.changeRequest.id}'::uuid
  `)).toEqual([{ decision: "REJECT", state: "REJECTED" }]);
  expect((await stack.readProject(lockedProject.id)).specification.revisionNotes).toEqual(notesBefore);
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

test("an explicit source fix routes only to Development and starts the workflow rerun", async ({ stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "单角色修复路由",
    concept: "验证代码修复由开发 Agent 单独回应，并在授权后交给游戏生成节点实施。",
  });
  await stack.executeSql(`
    UPDATE deviludo.workflow_instances
       SET state = 'RELEASE_APPROVAL_PENDING', updated_at = clock_timestamp()
     WHERE id = '${project.workflowId}'::uuid;
  `);

  const response = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: project.id, content: "修复代码中的输入处理错误并立即重新生成游戏。" },
  });
  expect(response.status()).toBe(201);
  const body = await response.json() as {
    conversation: Conversation;
    changeRequest: { state: string };
    intentDecision: { targetRole: string };
    workflowAction: string;
  };
  expect(body.intentDecision.targetRole).toBe("DEVELOPMENT");
  expect(body.conversation.messages.map(message => (
    message.role === "USER" ? "USER" : message.metadata.agentRole
  ))).toEqual(["USER", "DEVELOPMENT"]);
  expect(body.changeRequest.state).toBe("APPLIED");
  expect(body.workflowAction).toBe("AGENT_RERUN_STARTED");
  expect((await stack.readProject(project.id)).jobs.filter(job => job.kind === "AGENT_TURN")).toHaveLength(1);
});

test("Development readiness turns an initially uncertain change into a confirmable rerun", async ({ stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "开发确认闭环",
    concept: "验证开发 Agent 解决意图不确定性后不会留下没有按钮的死路。",
  });
  await stack.executeSql(`
    UPDATE deviludo.workflow_instances
       SET state = 'RELEASE_APPROVAL_PENDING', updated_at = clock_timestamp()
     WHERE id = '${project.workflowId}'::uuid;
  `);
  const response = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: {
      projectId: project.id,
      content: "待专业 Agent 判断是否可实施：优化局内 UI，并修复真实输入无法操作的问题。",
    },
  });
  expect(response.status()).toBe(201);
  const body = await response.json() as {
    conversation: Conversation;
    intentDecision: {
      intent: string;
      actionable: boolean;
      explicitExecution: boolean;
      responderRoles: string[];
      summary: string;
    };
    changeRequest: { state: string };
    workflowAction: string;
  };
  expect(body.intentDecision).toEqual({
    intent: "CHANGE_REQUEST",
    actionable: true,
    explicitExecution: false,
    targetRole: "DEVELOPMENT",
    summary: "Update the implementation according to the player's request.",
  });
  expect(body.conversation.messages.at(-1)?.metadata).toMatchObject({
    agentRole: "DEVELOPMENT",
    readyForDevelopment: true,
  });
  expect(body.changeRequest.state).toBe("PENDING");
  expect(body.workflowAction).toBe("AWAITING_CONFIRMATION");
});

test("messages during Agent generation are intent-routed and confirmed changes safely rerun it", async ({ stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "运行中意图验证",
    concept: "验证 Agent 生成期间的问题只回复，实现调整则安全重跑。",
  });
  const jobId = randomUUID();
  const leaseToken = randomUUID();
  await stack.executeSql(`
    UPDATE deviludo.workflow_instances
       SET state = 'DEVELOPING', updated_at = clock_timestamp()
     WHERE id = '${project.workflowId}'::uuid;
    INSERT INTO deviludo.jobs(
      workspace_id, id, workflow_id, project_id, kind, pool_kind,
      required_capabilities, exclusive, runtime_image, output_contract,
      state, idempotency_key, lease_owner, lease_token, lease_expires_at, fencing_token
    ) VALUES (
      '${project.workspaceId}'::uuid, '${jobId}'::uuid, '${project.workflowId}'::uuid, '${project.id}'::uuid,
      'AGENT_TURN', 'CORE', ARRAY['MICROVM','NETWORK_POLICY'], false,
      'sha256:${"a".repeat(64)}', '{"kinds":["SPECIFICATION"],"maxBytes":1073741824}'::jsonb,
      'RUNNING', 'intent-routing-e2e', 'e2e-held-agent', '${leaseToken}'::uuid,
      clock_timestamp() + interval '1 hour', 1
    );
  `);

  const documentBefore = (await stack.readProject(project.id)).document.revision;
  const asked = await stack.web("/api/conversations/messages/stream", {
    method: "POST",
    data: { projectId: project.id, content: "当前 Agent 正在做什么？" },
  });
  expect(asked.status()).toBe(200);
  const questionResult = (await asked.text()).trim().split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .find(event => event.type === "complete") as {
      conversation: Conversation;
      intentDecision: { intent: string; responderRoles: string[] };
      workflowAction: string;
    };
  expect(questionResult.intentDecision).toMatchObject({ intent: "QUESTION", targetRole: "DESIGN" });
  expect(questionResult.workflowAction).toBe("NONE");
  expect(questionResult.conversation.messages).toHaveLength(2);
  expect((await stack.readProject(project.id)).document.revision).toBe(documentBefore);
  expect(await stack.queryRows<{ state: string; fencing_token: string }>(`
    SELECT state::text, fencing_token::text FROM deviludo.jobs WHERE id = '${jobId}'::uuid
  `)).toEqual([{ state: "RUNNING", fencing_token: "1" }]);

  const proposed = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: {
      conversationId: questionResult.conversation.id,
      content: "能不能增加键盘和手柄都能完成核心循环的能力？",
    },
  });
  expect(proposed.status()).toBe(200);
  const proposedBody = await proposed.json() as {
    conversation: Conversation;
    changeRequest: { id: string; state: string };
    workflowAction: string;
    intentDecision: { intent: string; explicitExecution: boolean };
  };
  expect(proposedBody.intentDecision).toMatchObject({ intent: "CHANGE_REQUEST", explicitExecution: false });
  expect(proposedBody.workflowAction).toBe("AWAITING_CONFIRMATION");
  expect(proposedBody.changeRequest.state).toBe("PENDING");
  expect(proposedBody.conversation.messages.slice(-2).map(message => (
    message.role === "USER" ? "USER" : message.metadata.agentRole
  ))).toEqual(["USER", "DESIGN"]);
  expect((await stack.readProject(project.id)).document.revision).toBe(documentBefore);

  const confirmKey = `confirm:${randomUUID()}`;
  const decisionUrl = `/api/projects/${project.id}/change-requests/${proposedBody.changeRequest.id}/decision`;
  const confirmed = await stack.web(
    decisionUrl,
    {
      method: "POST",
      data: { decision: "CONFIRM", idempotencyKey: confirmKey, responseLanguage: "zh" },
    },
  );
  expect(confirmed.status()).toBe(200);
  expect((await confirmed.json() as { workflowAction: string }).workflowAction).toBe("AGENT_RERUN_STARTED");
  expect(await stack.queryRows<{ state: string; fencing_token: string; lease_token: string | null }>(`
    SELECT state::text, fencing_token::text, lease_token::text
      FROM deviludo.jobs WHERE id = '${jobId}'::uuid
  `)).toEqual([{ state: "CANCELLED", fencing_token: "2", lease_token: null }]);
  expect(await stack.queryRows<{ event_kind: string }>(`
    SELECT event_kind FROM deviludo.job_progress_events
     WHERE job_id = '${jobId}'::uuid AND event_kind = 'SUPERSEDED'
  `)).toEqual([{ event_kind: "SUPERSEDED" }]);
  expect((await stack.readProject(project.id)).e2eGoalRevision).toBe(2);
  expect((await stack.readProject(project.id)).jobs.filter(job => (
    job.kind === "AGENT_TURN" && job.id !== jobId
  ))).toHaveLength(1);
  const replay = await stack.web(decisionUrl, {
    method: "POST",
    data: { decision: "CONFIRM", idempotencyKey: confirmKey, responseLanguage: "zh" },
  });
  expect(replay.status()).toBe(200);
  expect((await replay.json() as { workflowAction: string }).workflowAction).toBe("AGENT_RERUN_STARTED");
  expect((await stack.web(decisionUrl, {
    method: "POST",
    data: { decision: "CONFIRM", idempotencyKey: `confirm:${randomUUID()}`, responseLanguage: "zh" },
  })).status()).toBe(409);
});

test("a successful replacement Manifest retires generated objects but preserves user uploads", async ({ stack }) => {
  test.setTimeout(90_000);
  await stack.configureAgent();
  const nodes = await stack.registerFixedNodes();
  await stack.startLogicalNodes(nodes);
  const project = await stack.createProject({
    name: "素材回收验证",
    concept: "验证游戏界面改版后只回收废弃生成素材，并保留用户上传的美术。",
  });
  const started = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: project.id, content: "按照当前需求开始开发。" },
  });
  expect(started.status()).toBe(201);
  await expect.poll(async () => (await stack.queryRows<{ count: number }>(`
    SELECT count(*)::int AS count
      FROM deviludo.jobs
     WHERE project_id = '${project.id}'::uuid
       AND kind = 'AGENT_TURN' AND payload->>'role' = 'DEVELOPMENT'
       AND state = 'SUCCEEDED'
  `))[0]?.count ?? 0, { timeout: 45_000 }).toBe(1);
  await expect.poll(async () => (await stack.readProject(project.id)).workflowState,
    { timeout: 45_000 }).toBe("RELEASE_APPROVAL_PENDING");
  await expect.poll(async () => (await stack.queryRows<{ retired: number; uploads: number }>(`
    SELECT (result_summary->>'retiredAssets')::int AS retired,
           (result_summary->>'retainedUploads')::int AS uploads
     FROM deviludo.agent_tool_calls
     WHERE project_id = '${project.id}'::uuid AND tool_name = 'assets.plan'
       AND state = 'SUCCEEDED'
     ORDER BY completed_at DESC LIMIT 1
  `))[0] ?? null).toEqual({ retired: 0, uploads: 0 });

  const changed = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: project.id, content: "删除废弃的旧面板并重新生成游戏实现。" },
  });
  expect(changed.status()).toBe(201);
  expect((await changed.json() as { workflowAction: string }).workflowAction).toBe("AGENT_RERUN_STARTED");
  await expect.poll(async () => (await stack.queryRows<{ succeeded: number }>(`
    SELECT count(*) FILTER (WHERE state = 'SUCCEEDED')::int AS succeeded
      FROM deviludo.jobs
     WHERE project_id = '${project.id}'::uuid
       AND kind = 'AGENT_TURN' AND payload->>'role' = 'DEVELOPMENT'
  `))[0]?.succeeded ?? 0, { timeout: 45_000 }).toBe(2);
  await expect.poll(async () => (await stack.readProject(project.id)).workflowState,
    { timeout: 45_000 }).toBe("RELEASE_APPROVAL_PENDING");

  await expect.poll(async () => (await stack.queryRows<{ retired: number; uploads: number }>(`
    SELECT (result_summary->>'retiredAssets')::int AS retired,
           (result_summary->>'retainedUploads')::int AS uploads
      FROM deviludo.agent_tool_calls
     WHERE project_id = '${project.id}'::uuid AND tool_name = 'assets.plan'
       AND state = 'SUCCEEDED' AND (result_summary->>'retiredAssets')::int > 0
     ORDER BY completed_at DESC LIMIT 1
  `))[0] ?? null).toEqual({ retired: 1, uploads: 1 });
  const plans = await stack.queryRows<{ planned_asset_keys: string[] }>(`
    SELECT ARRAY(
      SELECT jsonb_array_elements_text(plan->'assetPlacementPlan'->'plannedAssetKeys')
      ORDER BY 1
    ) AS planned_asset_keys
      FROM deviludo.test_plans_v2
     WHERE project_id = '${project.id}'::uuid
     ORDER BY source_revision DESC, plan_revision DESC LIMIT 1
  `);
  expect(plans).toEqual([{ planned_asset_keys: ["ui/user-banner"] }]);
});

test("a stale pending change is replanned once and confirmation retries remain idempotent", async ({ stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "过期提案验证",
    concept: "验证协作者更新项目说明后，旧提案会基于新版本重新规划。",
  });
  const proposed = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: project.id, content: "能不能增加一个可配置的辅助瞄准模式？" },
  });
  const proposal = (await proposed.json() as {
    changeRequest: { id: string };
    project: { document: { revision: number; content: Record<string, unknown> } };
  });
  expect(proposed.status()).toBe(201);

  const edited = await stack.web(`/api/projects/${project.id}/document`, {
    method: "PUT",
    data: {
      expectedRevision: proposal.project.document.revision,
      content: { ...proposal.project.document.content, introduction: "另一位协作者刚刚更新了项目说明。" },
      responseLanguage: "zh",
    },
  });
  expect(edited.status()).toBe(200);

  const decisionUrl = `/api/projects/${project.id}/change-requests/${proposal.changeRequest.id}/decision`;
  const idempotencyKey = `confirm:${randomUUID()}`;
  const replanned = await stack.web(decisionUrl, {
    method: "POST",
    data: { decision: "CONFIRM", idempotencyKey, responseLanguage: "zh" },
  });
  expect(replanned.status()).toBe(200);
  const replannedBody = await replanned.json() as {
    workflowAction: string;
    changeRequest: { id: string; state: string };
  };
  expect(replannedBody.workflowAction).toBe("AWAITING_CONFIRMATION");
  expect(replannedBody.changeRequest).toMatchObject({ state: "PENDING" });
  expect(replannedBody.changeRequest.id).not.toBe(proposal.changeRequest.id);

  const replay = await stack.web(decisionUrl, {
    method: "POST",
    data: { decision: "CONFIRM", idempotencyKey, responseLanguage: "zh" },
  });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toMatchObject({
    workflowAction: "AWAITING_CONFIRMATION",
    changeRequest: { id: replannedBody.changeRequest.id, state: "PENDING" },
  });
  expect((await stack.web(decisionUrl, {
    method: "POST",
    data: { decision: "CONFIRM", idempotencyKey: `confirm:${randomUUID()}`, responseLanguage: "zh" },
  })).status()).toBe(409);
});

test("a change during Steam upload starts a child iteration without touching the upload", async ({ stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "发布中迭代验证",
    concept: "验证发布上传期间的新需求进入独立迭代。",
  });
  const steamJobId = randomUUID();
  const steamLease = randomUUID();
  await stack.executeSql(`
    UPDATE deviludo.workflow_instances
       SET state = 'STEAM_PUBLISHING', updated_at = clock_timestamp()
     WHERE id = '${project.workflowId}'::uuid;
    INSERT INTO deviludo.jobs(
      workspace_id, id, workflow_id, project_id, kind, pool_kind,
      required_capabilities, exclusive, runtime_image, output_contract,
      state, idempotency_key, lease_owner, lease_token, lease_expires_at, fencing_token
    ) VALUES (
      '${project.workspaceId}'::uuid, '${steamJobId}'::uuid, '${project.workflowId}'::uuid, '${project.id}'::uuid,
      'STEAM_PUBLISH', 'CORE', ARRAY['RESTRICTED_CONTAINER','STEAMCMD'], false,
      'sha256:${"d".repeat(64)}', '{"kinds":["PUBLISH_RECEIPT"],"maxBytes":1073741824}'::jsonb,
      'RUNNING', 'steam-upload-in-progress', 'held-steam-upload', '${steamLease}'::uuid,
      clock_timestamp() + interval '1 hour', 1
    );
  `);

  const changed = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { projectId: project.id, content: "增加一个发布后可配置的高对比度模式。" },
  });
  expect(changed.status()).toBe(201);
  expect((await changed.json() as { workflowAction: string }).workflowAction).toBe("NEW_ITERATION_STARTED");
  const latest = await stack.readProject(project.id);
  expect(latest.iterationNumber).toBe(2);
  expect(latest.workflowId).not.toBe(project.workflowId);
  expect(await stack.queryRows<{ workflow_state: string; job_state: string; fencing_token: string; lease_token: string }>(`
    SELECT workflow.state::text AS workflow_state, job.state::text AS job_state,
           job.fencing_token::text, job.lease_token::text
      FROM deviludo.workflow_instances workflow
      JOIN deviludo.jobs job ON job.workflow_id = workflow.id
     WHERE workflow.id = '${project.workflowId}'::uuid AND job.id = '${steamJobId}'::uuid
  `)).toEqual([{
    workflow_state: "STEAM_PUBLISHING",
    job_state: "RUNNING",
    fencing_token: "1",
    lease_token: steamLease,
  }]);
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
    messageCount: 2,
    userMessageCount: 1,
    systemGenerated: false,
  });
  expect(summaries[1]).toMatchObject({
    preview: "先讨论录音回放与历史改写之间的核心循环。",
    messageCount: 4,
    userMessageCount: 2,
    systemGenerated: false,
  });

  const deleted = await stack.web(`/api/projects/${project.id}`, { method: "DELETE" });
  expect(deleted.status(), await deleted.text()).toBe(204);
  expect((await stack.web(`/api/projects/${project.id}`)).status()).toBe(404);
  expect((await stack.web(`/api/projects/${project.id}/conversations`)).status()).toBe(404);
  expect((await stack.web(`/api/conversations/${firstConversation.id}`)).status()).toBe(404);
});
