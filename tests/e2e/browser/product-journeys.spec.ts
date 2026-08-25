import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/stack";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNg2PL/PwAFHgKz57crZQAAAABJRU5ErkJggg==", "base64");

test("the conversation composer accepts images above five MiB up to the new eight MiB limit", async ({ page, stack }) => {
  const project = await stack.createProject({
    name: "会话图片边界",
    concept: "验证聊天框放宽后的图片大小边界。",
  });
  await page.goto(`/projects/${project.id}`);
  const imageInput = page.getByLabel("选择会话图片");
  const accepted = Buffer.alloc(6 * 1024 * 1024);
  ONE_PIXEL_PNG.copy(accepted);
  await imageInput.setInputFiles({ name: "six-mib.png", mimeType: "image/png", buffer: accepted });
  await expect(page.locator('.conversation-composer-images img[alt="six-mib.png"]')).toBeVisible();
  await expect(page.locator(".conversation-image-error")).toHaveCount(0);

  const rejected = Buffer.alloc(8 * 1024 * 1024 + 1);
  ONE_PIXEL_PNG.copy(rejected);
  await imageInput.setInputFiles({ name: "over-eight-mib.png", mimeType: "image/png", buffer: rejected });
  await expect(page.locator(".conversation-image-error")).toHaveText("仅支持 8 MB 以内的 PNG、JPEG 或 WebP 图片");
});

test("product navigation preserves the shell and reuses project data without reconnecting",async({page,stack})=>{
  expect(stack.webUrl.protocol).toBe("http:");
  let instanceRequests=0;
  let projectListRequests=0;
  page.on("request",request=>{
    const url=new URL(request.url());
    if(url.pathname==="/api/instance")instanceRequests++;
    if(url.pathname==="/api/projects"&&request.method()==="GET")projectListRequests++;
  });
  await page.goto("/");
  await expect(page.getByRole("heading",{name:"今天想做什么游戏？"})).toBeVisible();
  await page.getByRole("link",{name:"项目",exact:true}).click();
  await expect(page.getByRole("heading",{name:"游戏项目",exact:true})).toBeVisible();
  await expect(page.getByText("正在连接…",{exact:true})).toHaveCount(0);
  await page.getByRole("link",{name:"设置",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Agent 设置"})).toBeVisible();
  await expect(page.getByText("正在连接…",{exact:true})).toHaveCount(0);
  await page.getByRole("link",{name:"首页",exact:true}).click();
  await expect(page.getByRole("heading",{name:"今天想做什么游戏？"})).toBeVisible();
  expect(instanceRequests).toBe(1);
  expect(projectListRequests).toBe(1);
});

test("display typography, readable body copy and English locale persist across the project journey", async ({ page, stack }) => {
  const project = await stack.createProject({
    name: "Pixel Language Lab",
    concept: "A compact arcade tactics game used to verify localized project screens.",
  });
  await page.goto("/");
  const chineseHeading = page.getByRole("heading", { name: "今天想做什么游戏？" });
  await expect(chineseHeading).toBeVisible();
  expect(await chineseHeading.evaluate(element => getComputedStyle(element).fontFamily)).toContain("Press Start 2P");
  const composerFont = await page.locator(".home-conversation-box textarea").evaluate(element => getComputedStyle(element).fontFamily);
  expect(composerFont).not.toContain("DotGothic16");
  expect(composerFont).not.toContain("Press Start 2P");

  await page.getByRole("button", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "WHAT WILL YOU BUILD TODAY?" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await expect(page.getByLabel("Import existing project")).toBeVisible();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "WHAT WILL YOU BUILD TODAY?" })).toBeVisible();

  await page.goto(`/projects/${project.id}`);
  const pipeline = page.getByRole("region", { name: "Delivery pipeline" });
  await expect(pipeline).toBeVisible();
  await expect(page.getByRole("heading", { name: "DELIVERY PIPELINE" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "CONVERSATION HISTORY" })).toBeVisible();
  await expect(page.getByText("NOT STARTED", { exact: true })).toHaveCount(4);
  await expect(page.getByText("游戏规格", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("region", { name: "交付流程" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "会话记录" })).toBeVisible();
});

test("the top delivery pipeline distinguishes completed, active and pending stages", async ({ page, stack }) => {
  const project = await stack.createProject({
    name: "横向流水线",
    concept: "一款用于验证交付阶段展示顺序的像素动作游戏。",
  });
  const detailResponse = await stack.web(`/api/projects/${project.id}`);
  expect(detailResponse.ok(), await detailResponse.text()).toBeTruthy();
  const detail = await detailResponse.json() as { project: Record<string, unknown> };
  detail.project = {
    ...detail.project,
    workflowState: "ARTIFACT_BUILDING",
    jobs: [
      { id: randomUUID(), kind: "AGENT_GENERATION", poolKind: "CORE", targetOperatingSystem: null, state: "SUCCEEDED", attempt: 1, lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: randomUUID(), kind: "ARTIFACT_BUILD", poolKind: "CORE", targetOperatingSystem: null, state: "RUNNING", attempt: 1, lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: randomUUID(), kind: "E2E_TEST", poolKind: "E2E_MACOS", targetOperatingSystem: "macos", state: "CANCELLED", attempt: 1, lastError: "superseded by stage rerun from ARTIFACT_BUILD", createdAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString() },
    ],
  };
  await page.route(new RegExp(`/api/projects/${project.id}$`), route => route.fulfill({ json: detail }));
  await page.goto(`/projects/${project.id}`);

  const pipeline = page.getByRole("region", { name: "交付流程" });
  const workspace = page.getByRole("region", { name: "项目会话" });
  await expect(pipeline).toBeVisible();
  await expect(page.locator(".product-delivery-stage.status-completed")).toHaveCount(2);
  await expect(page.locator(".product-delivery-stage.status-active")).toHaveCount(1);
  // E2E, Steam, Art, and Music are all waiting while the build is active.
  await expect(page.locator(".product-delivery-stage.status-pending")).toHaveCount(4);
  await expect(pipeline.locator('[data-stage-kind="ARTIFACT_BUILD"] strong')).toHaveText("进行中");
  await expect(pipeline.locator('[data-stage-kind="E2E_TEST"] strong')).toHaveText("等待中");
  await expect(pipeline.locator('[data-stage-kind="E2E_TEST"] small').first()).toHaveText("等待上一步完成");
  await expect(pipeline.locator('[data-stage-kind="STEAM_PUBLISH"] strong')).toHaveText("等待中");
  await expect(pipeline.getByText("已取消", { exact: true })).toHaveCount(0);
  await expect(page.getByText("游戏规格", { exact: true })).toHaveCount(0);
  await expect(page.locator(".product-studio-state")).toHaveCount(0);
  const conversationPanel = await page.locator(".project-conversation-panel").boundingBox();
  const documentPanel = await page.locator(".product-document-sidebar").boundingBox();
  expect(conversationPanel).not.toBeNull();
  expect(documentPanel).not.toBeNull();
  // Native font metrics vary slightly across Chromium, Firefox, and WebKit;
  // retain visual row alignment without requiring impossible sub-pixel parity.
  const crossBrowserAlignmentTolerance = 16;
  expect(Math.abs(conversationPanel!.y - documentPanel!.y)).toBeLessThanOrEqual(crossBrowserAlignmentTolerance);
  expect(Math.abs((conversationPanel!.y + conversationPanel!.height) - (documentPanel!.y + documentPanel!.height))).toBeLessThanOrEqual(crossBrowserAlignmentTolerance);
  const messageFontSize = await page.locator(".project-conversation-box textarea").evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  expect(messageFontSize).toBeGreaterThanOrEqual(15);
  const messageViewport = await page.locator(".project-conversation-box .conversation-box-messages").evaluate(element => ({
    height: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(messageViewport.height).toBeLessThanOrEqual(520);
  expect(messageViewport.height).toBeGreaterThanOrEqual(300);
  expect(messageViewport.overflowY).toBe("auto");
  const conversationBox = await page.locator(".project-conversation-box").boundingBox();
  const composer = await page.locator(".project-conversation-box .conversation-box-composer").boundingBox();
  expect(conversationBox).not.toBeNull();
  expect(composer).not.toBeNull();
  expect(Math.abs((conversationBox!.y + conversationBox!.height) - (composer!.y + composer!.height))).toBeLessThanOrEqual(1);
  expect((await pipeline.boundingBox())?.y).toBeLessThan((await workspace.boundingBox())?.y ?? 0);
});

test("an Agent runtime failure is explained without exposing raw executor JSON", async ({ page, stack }) => {
  const project = await stack.createProject({
    name: "失败原因面板",
    concept: "验证 Agent 生成失败时显示清晰原因和安全重试入口。",
  });
  const detailResponse = await stack.web(`/api/projects/${project.id}`);
  const detail = await detailResponse.json() as { project: Record<string, unknown> };
  detail.project = {
    ...detail.project,
    workflowState: "FAILED",
    jobs: [{
      id: randomUUID(), kind: "AGENT_GENERATION", poolKind: "CORE", targetOperatingSystem: null,
      state: "FAILED", attempt: 5,
      lastError: 'Sandbox executor failed: {"code":"EXECUTOR_REJECTED","message":"Runtime image is not in the signed release allowlist"}',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }],
  };
  await page.route(new RegExp(`/api/projects/${project.id}$`), route => route.fulfill({ json: detail }));
  await page.goto(`/projects/${project.id}`);

  const failure = page.getByRole("alert", { name: "交付失败原因" });
  await expect(failure.getByText("Agent 生成失败", { exact: true })).toBeVisible();
  await expect(failure.getByText("任务引用的运行环境已被本地更新替换，旧镜像无法再安全启动。", { exact: true })).toBeVisible();
  await expect(failure.getByText("已尝试 5 次", { exact: true })).toBeVisible();
  await expect(failure.getByRole("button", { name: "重跑失败阶段" })).toBeVisible();
  await expect(failure).not.toContainText("Sandbox executor failed: {");
  await failure.getByText("技术详情", { exact: true }).click();
  await expect(failure.getByText("EXECUTOR_REJECTED: Runtime image is not in the signed release allowlist", { exact: true })).toBeVisible();
});

test("confirmed requirements update the project document before the streamed turn completes", async ({ page, stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "需求同步面板",
    concept: "验证玩家确认需求后，项目说明会在同一轮对话中同步刷新。",
  });
  await page.goto(`/projects/${project.id}`);

  const input = page.getByLabel("继续项目会话");
  await input.fill("确认核心循环以资源管理为主，并加入随机事件。项目说明也要同步。");
  await page.getByRole("button", { name: "发送项目消息" }).click();

  await expect(page.getByText("测试设计 Agent 已整理当前游戏需求。", { exact: true })).toBeVisible();
  await expect(page.locator(".product-document-sidebar .revision-badge")).toContainText("R2");
  await expect(page.getByText("E2E G2", { exact: true })).toBeVisible();
});

test("a Development reply that resolves an uncertain change exposes the confirmation action", async ({ page, stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "开发确认按钮",
    concept: "验证开发 Agent 完成规划后显示确认修改入口。",
  });
  await stack.executeSql(`
    UPDATE deviludo.workflow_instances
       SET state = 'RELEASE_DECISION_PENDING', updated_at = clock_timestamp()
     WHERE id = '${project.workflowId}'::uuid;
  `);
  await page.goto(`/projects/${project.id}`);
  await page.getByLabel("继续项目会话").fill(
    "待专业 Agent 判断是否可实施：优化局内 UI，并修复真实输入无法操作的问题。",
  );
  await page.getByRole("button", { name: "发送项目消息" }).click();
  await expect(page.locator(".conversation-box-message.role-development")).toBeVisible();
  await expect(page.locator(".conversation-box-composer").getByRole("button", { name: "确认修改并重跑" })).toBeVisible();
});

test("the project chat streams Agent progress, answers questions, and confirms implementation reruns", async ({ page, stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "生成进度控制台",
    concept: "验证玩家可以在开发 Agent 工作时查看输出、提问并确认实现调整。",
  });
  const jobId = randomUUID();
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
      'sha256:${"b".repeat(64)}', '{"kinds":["SPECIFICATION"],"maxBytes":1073741824}'::jsonb,
      'RUNNING', 'browser-agent-progress', 'browser-held-agent', gen_random_uuid(),
      clock_timestamp() + interval '1 hour', 1
    );
    INSERT INTO deviludo.job_progress_events(
      workspace_id, project_id, workflow_id, job_id, event_kind, content
    ) VALUES
      ('${project.workspaceId}'::uuid, '${project.id}'::uuid, '${project.workflowId}'::uuid, '${jobId}'::uuid, 'PHASE', '正在分析项目结构'),
      ('${project.workspaceId}'::uuid, '${project.id}'::uuid, '${project.workflowId}'::uuid, '${jobId}'::uuid, 'AGENT_OUTPUT', '正在实现时间循环控制'),
      ('${project.workspaceId}'::uuid, '${project.id}'::uuid, '${project.workflowId}'::uuid, '${jobId}'::uuid, 'AGENT_OUTPUT', E'器并保持文本连续\\n');
  `);

  await page.goto(`/projects/${project.id}`);
  const liveProgress = page.locator(".conversation-live-progress");
  await expect(liveProgress.getByText("游戏生成进度", { exact: true })).toBeVisible();
  await expect(page.locator(".conversation-box-messages .agent-generation-progress")).toHaveCount(0);
  await expect(page.getByText("正在分析项目结构", { exact: true })).toBeVisible();
  const progressOutput = page.locator(".agent-generation-progress-events .progress-agent_output");
  await expect(progressOutput).toHaveCount(1);
  await expect(progressOutput).toContainText("正在实现时间循环控制器并保持文本连续");
  const progressViewport = page.locator(".agent-generation-progress-events");
  await stack.executeSql(`
    INSERT INTO deviludo.job_progress_events(
      workspace_id, project_id, workflow_id, job_id, event_kind, content
    )
    SELECT '${project.workspaceId}'::uuid, '${project.id}'::uuid, '${project.workflowId}'::uuid, '${jobId}'::uuid,
           'AGENT_OUTPUT', string_agg('生成进度行 ' || value::text || E'\\n', '' ORDER BY value)
      FROM generate_series(1, 24) AS lines(value);
  `);
  await expect(progressOutput).toContainText("生成进度行 24");
  await expect.poll(() => progressViewport.evaluate(element => (
    element.scrollHeight - element.scrollTop - element.clientHeight <= 2
  ))).toBe(true);

  await progressViewport.evaluate(element => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await stack.executeSql(`
    INSERT INTO deviludo.job_progress_events(
      workspace_id, project_id, workflow_id, job_id, event_kind, content
    ) VALUES (
      '${project.workspaceId}'::uuid, '${project.id}'::uuid, '${project.workflowId}'::uuid, '${jobId}'::uuid,
      'AGENT_OUTPUT', E'用户上滑后出现的新进度\\n'
    );
  `);
  await expect(progressOutput).toContainText("用户上滑后出现的新进度");
  expect(await progressViewport.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1);

  await progressViewport.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await stack.executeSql(`
    INSERT INTO deviludo.job_progress_events(
      workspace_id, project_id, workflow_id, job_id, event_kind, content
    ) VALUES (
      '${project.workspaceId}'::uuid, '${project.id}'::uuid, '${project.workflowId}'::uuid, '${jobId}'::uuid,
      'AGENT_OUTPUT', E'底部自动跟随的新进度\\n'
    );
  `);
  await expect(progressOutput).toContainText("底部自动跟随的新进度");
  await expect.poll(() => progressViewport.evaluate(element => (
    element.scrollHeight - element.scrollTop - element.clientHeight <= 2
  ))).toBe(true);
  const input = page.getByLabel("继续项目会话");
  await expect(input).toHaveAttribute("placeholder", "提问，或提出实现调整…");
  const question = "当前 Agent 正在做什么？";
  await input.fill(question);
  await page.getByRole("button", { name: "发送项目消息" }).click();
  const completedQuestion = page.locator(".project-conversation-box .conversation-box-message", { hasText: question });
  await expect(completedQuestion).toBeVisible();
  const completedTime = completedQuestion.locator(".conversation-message-completed-at");
  await expect(completedTime).toBeVisible();
  await expect(completedTime).toHaveAttribute("datetime", /\d{4}-\d{2}-\d{2}T/);
  const bubbleAndTime = await completedQuestion.evaluate(element => {
    const bubble = element.querySelector("p")?.getBoundingClientRect();
    const time = element.querySelector("time")?.getBoundingClientRect();
    const timeElement = element.querySelector("time");
    return {
      below: Boolean(bubble && time && time.top >= bubble.bottom),
      color: timeElement ? getComputedStyle(timeElement).color : "",
    };
  });
  expect(bubbleAndTime.below).toBe(true);
  expect(bubbleAndTime.color).not.toBe("");
  await expect(page.locator(".project-conversation-box .conversation-box-message.is-thinking")).toHaveCount(0);
  expect(await stack.queryRows<{ state: string }>(`
    SELECT state::text FROM deviludo.jobs WHERE id = '${jobId}'::uuid
  `)).toEqual([{ state: "RUNNING" }]);

  await input.fill("能不能增加键盘和手柄都能完成核心循环的能力？");
  await page.getByRole("button", { name: "发送项目消息" }).click();
  await stack.executeSql(`
    UPDATE deviludo.implementation_change_requests
       SET summary = '采用方案 B 重设计主菜单：使用中央极简纵向导航，弱化容器感，并让按钮组与背景之间保留大面积呼吸空间；保留既有功能、焦点顺序、分辨率适配以及全部 E2E 目标，同时继续说明不属于确认提示的内部实施细节。'
     WHERE project_id = '${project.id}'::uuid AND state = 'PENDING';
  `);
  await page.reload();
  const confirmAction = page.locator(".conversation-box-composer .conversation-change-action");
  const confirmChange = confirmAction.getByRole("button", { name: "确认修改并重跑" });
  const sendMessage = page.getByRole("button", { name: "发送项目消息" });
  const implementation = confirmAction.getByRole("tooltip");
  await expect(confirmAction).toBeVisible();
  await expect(confirmChange).toBeVisible();
  await expect(confirmChange).toBeInViewport();
  await expect(page.getByRole("button", { name: "保持当前实现" })).toHaveCount(0);
  const confirmBounds = await confirmChange.boundingBox();
  const sendBounds = await sendMessage.boundingBox();
  expect(confirmBounds).not.toBeNull();
  expect(sendBounds).not.toBeNull();
  expect(confirmBounds!.x + confirmBounds!.width).toBeLessThanOrEqual(sendBounds!.x);
  await page.getByRole("button", { name: "浅色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(implementation).toBeHidden();
  await confirmChange.hover();
  await expect(implementation).toBeVisible();
  await expect(implementation).toHaveCSS("background-color", "rgb(243, 248, 251)");
  await expect(implementation).toHaveCSS("border-top-color", "rgb(140, 166, 185)");
  await expect(implementation).toHaveCSS("color", "rgb(23, 33, 45)");
  expect((await implementation.textContent())?.length).toBeLessThanOrEqual(120);
  await expect(implementation).not.toContainText("内部实施细节");
  const composerBounds = await page.locator(".conversation-box-composer").boundingBox();
  const implementationBounds = await implementation.boundingBox();
  expect(composerBounds).not.toBeNull();
  expect(implementationBounds).not.toBeNull();
  expect(implementationBounds!.x).toBeGreaterThanOrEqual(composerBounds!.x);
  expect(implementationBounds!.x + implementationBounds!.width).toBeLessThanOrEqual(composerBounds!.x + composerBounds!.width);
  expect(implementationBounds!.y).toBeGreaterThanOrEqual(composerBounds!.y);
  expect(implementationBounds!.y + implementationBounds!.height).toBeLessThanOrEqual(composerBounds!.y + composerBounds!.height);
  await page.reload();
  await expect(confirmAction).toBeVisible();
  await confirmChange.click();
  await expect(confirmAction).toHaveCount(0);
  await expect.poll(async () => await stack.queryRows<{ state: string }>(`
    SELECT state::text FROM deviludo.jobs WHERE id = '${jobId}'::uuid
  `)).toEqual([{ state: "CANCELLED" }]);
  await expect(page.getByText("E2E G2", { exact: true })).toBeVisible();
});

test("game generation progress is isolated from conversation history and resets between jobs", async ({ page, stack }) => {
  const project = await stack.createProject({
    name: "进度生命周期隔离",
    concept: "验证长会话不会与游戏生成进度共享滚动和历史状态。",
  });
  const conversationId = randomUUID();
  const firstJobId = randomUUID();
  const secondJobId = randomUUID();
  await stack.executeSql(`
    INSERT INTO deviludo.project_conversations(workspace_id, id, project_id, mode, title)
    VALUES (
      '${project.workspaceId}'::uuid, '${conversationId}'::uuid, '${project.id}'::uuid,
      'PROJECT_FEEDBACK', '进度与历史隔离测试'
    );
    WITH conversation AS (
      SELECT workspace_id, id
        FROM deviludo.project_conversations
       WHERE id = '${conversationId}'::uuid
    )
    INSERT INTO deviludo.conversation_messages(
      workspace_id, conversation_id, role, content, metadata
    )
    SELECT conversation.workspace_id, conversation.id,
           CASE WHEN entry % 2 = 1 THEN 'USER' ELSE 'ASSISTANT' END,
           '用于填充长会话历史的消息 ' || entry::text || '，确保滚动区域足够长。',
           CASE WHEN entry % 2 = 1 THEN '{}'::jsonb ELSE '{"agentRole":"DESIGN"}'::jsonb END
      FROM conversation
      CROSS JOIN generate_series(1, 36) AS entries(entry);

    UPDATE deviludo.workflow_instances
       SET state = 'AGENT_RUNNING', updated_at = clock_timestamp()
     WHERE id = '${project.workflowId}'::uuid;
    INSERT INTO deviludo.jobs(
      workspace_id, id, workflow_id, project_id, kind, pool_kind,
      required_capabilities, exclusive, runtime_image, output_contract,
      state, idempotency_key, lease_owner, lease_token, lease_expires_at, fencing_token
    ) VALUES (
      '${project.workspaceId}'::uuid, '${firstJobId}'::uuid, '${project.workflowId}'::uuid, '${project.id}'::uuid,
      'AGENT_GENERATION', 'CORE', ARRAY['MICROVM','NETWORK_POLICY'], false,
      'sha256:${"c".repeat(64)}', '{"kinds":["SPECIFICATION"],"maxBytes":1073741824}'::jsonb,
      'RUNNING', 'browser-progress-lifecycle-first', 'browser-progress-lifecycle-first', gen_random_uuid(),
      clock_timestamp() + interval '1 hour', 1
    );
    INSERT INTO deviludo.job_progress_events(
      workspace_id, project_id, workflow_id, job_id, event_kind, content
    ) VALUES (
      '${project.workspaceId}'::uuid, '${project.id}'::uuid, '${project.workflowId}'::uuid, '${firstJobId}'::uuid,
      'AGENT_OUTPUT', '第一轮生成进度'
    );
  `);

  await page.goto(`/projects/${project.id}`);
  const liveProgress = page.locator(".conversation-live-progress");
  const messageViewport = page.locator(".conversation-box-messages");
  await expect(liveProgress.getByText("游戏生成进度", { exact: true })).toBeVisible();
  await expect(liveProgress).toContainText("第一轮生成进度");
  await expect(messageViewport.locator(".agent-generation-progress")).toHaveCount(0);

  const historyMetrics = await messageViewport.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(historyMetrics.scrollHeight).toBeGreaterThan(historyMetrics.clientHeight + 200);
  await messageViewport.evaluate(element => {
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    element.dispatchEvent(new Event("scroll"));
  });
  const historyScrollTop = await messageViewport.evaluate(element => element.scrollTop);
  await stack.executeSql(`
    INSERT INTO deviludo.job_progress_events(
      workspace_id, project_id, workflow_id, job_id, event_kind, content
    ) VALUES (
      '${project.workspaceId}'::uuid, '${project.id}'::uuid, '${project.workflowId}'::uuid, '${firstJobId}'::uuid,
      'AGENT_OUTPUT', '刷新进度不得移动会话历史'
    );
  `);
  await expect(liveProgress).toContainText("刷新进度不得移动会话历史");
  expect(await messageViewport.evaluate(element => element.scrollTop)).toBe(historyScrollTop);

  await stack.executeSql(`
    UPDATE deviludo.jobs
       SET state = 'SUCCEEDED', lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, updated_at = clock_timestamp()
     WHERE id = '${firstJobId}'::uuid;
    UPDATE deviludo.workflow_instances
       SET state = 'ARTIFACT_BUILDING', updated_at = clock_timestamp()
     WHERE id = '${project.workflowId}'::uuid;
  `);
  await expect(liveProgress).toHaveCount(0, { timeout: 10_000 });

  await stack.executeSql(`
    UPDATE deviludo.workflow_instances
       SET state = 'AGENT_RUNNING', updated_at = clock_timestamp()
     WHERE id = '${project.workflowId}'::uuid;
    INSERT INTO deviludo.jobs(
      workspace_id, id, workflow_id, project_id, kind, pool_kind,
      required_capabilities, exclusive, runtime_image, output_contract,
      state, idempotency_key, lease_owner, lease_token, lease_expires_at, fencing_token
    ) VALUES (
      '${project.workspaceId}'::uuid, '${secondJobId}'::uuid, '${project.workflowId}'::uuid, '${project.id}'::uuid,
      'AGENT_GENERATION', 'CORE', ARRAY['MICROVM','NETWORK_POLICY'], false,
      'sha256:${"d".repeat(64)}', '{"kinds":["SPECIFICATION"],"maxBytes":1073741824}'::jsonb,
      'RUNNING', 'browser-progress-lifecycle-second', 'browser-progress-lifecycle-second', gen_random_uuid(),
      clock_timestamp() + interval '1 hour', 2
    );
    INSERT INTO deviludo.job_progress_events(
      workspace_id, project_id, workflow_id, job_id, event_kind, content
    ) VALUES (
      '${project.workspaceId}'::uuid, '${project.id}'::uuid, '${project.workflowId}'::uuid, '${secondJobId}'::uuid,
      'AGENT_OUTPUT', '第二轮独立生成进度'
    );
  `);
  await expect(liveProgress).toContainText("第二轮独立生成进度", { timeout: 10_000 });
  await expect(liveProgress).not.toContainText("第一轮生成进度");
  await expect(liveProgress).not.toContainText("刷新进度不得移动会话历史");
});

test("an Agent reply follows the conversation without moving the whole page", async ({ page, stack }) => {
  const project = await stack.createProject({
    name: "稳定视窗",
    concept: "用于验证流式回复不会把整个项目页面拖到最底部。",
  });
  let releaseRequest: () => void = () => {};
  const requestGate = new Promise<void>(resolve => { releaseRequest = resolve; });
  await page.route("**/api/conversations/messages/stream", async route => {
    await requestGate;
    await route.abort("failed");
  });
  try {
    await page.goto(`/projects/${project.id}`);
    const input = page.getByLabel("继续项目会话");
    await input.scrollIntoViewIfNeeded();
    await input.fill("请给这个玩法增加一个新的循环机制。");
    await page.getByLabel("选择会话图片").setInputFiles({
      name: "project-feedback.png",
      mimeType: "image/png",
      buffer: ONE_PIXEL_PNG,
    });
    const sendButton = page.getByRole("button", { name: "发送项目消息" });
    // Establish the user's viewport after the actionable control is visible.
    // Otherwise Playwright's WebKit driver may scroll the page merely to click
    // the button, which measures test automation rather than message insertion.
    await sendButton.scrollIntoViewIfNeeded();
    const pageScrollBefore = await page.evaluate(() => window.scrollY);
    await sendButton.click();
    await expect(page.locator(".project-conversation-box .conversation-composer-images")).toHaveCount(0);
    await expect(page.locator('.project-conversation-box .conversation-message-images img[alt="project-feedback.png"]')).toBeVisible();
    await expect(page.locator(".project-conversation-box .conversation-box-message.user .conversation-message-completed-at")).toHaveCount(0);
    await expect(page.locator(".project-conversation-box .conversation-box-message.is-thinking")).toBeVisible();
    await expect(page.getByText("正在思考", { exact: true })).toBeVisible();
    await page.waitForTimeout(250);
    const pageScrollAfter = await page.evaluate(() => window.scrollY);
    expect(Math.abs(pageScrollAfter - pageScrollBefore)).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "English" }).click();
    await expect(page.getByText("Thinking", { exact: true })).toBeVisible();
  } finally {
    releaseRequest();
  }
  await expect(page.locator(".project-conversation-box .conversation-composer-images")).toHaveCount(0);
});

test("a creator can refine and deliver a game through every Core and platform stage", async ({ page, stack }) => {
  test.setTimeout(180_000);
  await stack.configureAgent();
  const nodes = await stack.registerFixedNodes();
  await stack.startLogicalNodes(nodes);

  await page.goto("/");
  await expect(page.locator('link[rel="icon"][href="/favicon-deviludo.png"]')).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "今天想做什么游戏？" })).toBeVisible();
  await expect(page.getByRole("link", { name: "首页", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "开始新游戏" })).toHaveCount(0);
  await page.getByRole("link", { name: "项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "游戏项目", exact: true })).toBeVisible();
  await expect(page.getByText("Local workspace", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("SYSTEM ONLINE")).toBeVisible();
  await expect(page.getByRole("heading", { name: "还没有游戏项目" })).toBeVisible();
  await page.getByRole("button", { name: "通知" }).click();

  await page.getByRole("link", { name: "开始新构想" }).click();
  await expect(page).toHaveURL(/\/projects\/new$/);
  const name = `星港维修队-${randomUUID().slice(0, 6)}`;
  const concept = "一款双人合作的太空维修游戏，玩家需要在十五分钟内处理火灾、电力和导航故障。";
  await page.getByLabel("游戏名称").fill(name);
  await page.getByLabel("游戏构想").fill("太短");
  await expect(page.getByRole("button", { name: "创建项目" })).toBeDisabled();
  await page.getByLabel("游戏构想").fill(concept);
  await page.getByRole("button", { name: "创建项目" }).click();

  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText(concept).first()).toBeVisible();
  await expect(page.getByText("等待启动", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "启动交付" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "按照当前需求开发" })).toHaveCount(0);
  await expect(page.getByText("游戏规格", { exact: true })).toHaveCount(0);
  // Four delivery stages plus the Art and Music material nodes are waiting
  // before requirements discovery has approved the iteration.
  await expect(page.locator(".product-delivery-stage.status-pending")).toHaveCount(6);

  await page.getByLabel("继续项目会话").fill("玩法目标、操作方式和胜负条件已经确认，请判断是否可以开始开发。");
  await page.getByRole("button", { name: "发送项目消息" }).click();
  await expect(page.getByRole("button", { name: "按照当前需求开发" })).toBeVisible();
  await expect(page.getByText("测试设计 Agent 已结合项目上下文生成回复。", { exact: true })).toBeVisible();
  await expect(page.getByText("QUESTION", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "按照当前需求开发" }).click();
  // Three isolated platform nodes run concurrently but can spend close to a
  // minute preparing their deterministic guest evidence on a cold CI host.
  await expect(page.getByText("等待发布决策", { exact: true })).toBeVisible({ timeout: 120_000 });
  await page.getByLabel("展开项目交付配置").click();
  await expect(page.getByRole("button", { name: "完成本轮，不发布" })).toBeVisible();
  for (const stage of ["游戏生成", "制品构建", "跨平台 E2E", "Steam 上传"]) {
    await expect(page.getByText(stage, { exact: true })).toBeVisible();
  }
  for (const stage of ["AGENT_GENERATION", "ARTIFACT_BUILD", "E2E_TEST"]) {
    await expect(page.locator(`[data-stage-kind="${stage}"]`)).toHaveAttribute("data-stage-status", "completed");
  }
  await expect(page.locator('[data-stage-kind="STEAM_PUBLISH"]')).toHaveAttribute("data-stage-status", "pending");
  await expect(page.getByText(/linux · 完成/).first()).toBeVisible();
  await expect(page.getByText(/windows · 完成/).first()).toBeVisible();
  await expect(page.getByText(/macos · 完成/).first()).toBeVisible();

  const generationStage = page.locator('[data-stage-kind="AGENT_GENERATION"]');
  const generationRerun = generationStage.getByRole("button", { name: /从「游戏生成」重新执行/ });
  await generationStage.getByRole("button", { name: "打开需求快照" }).hover();
  await expect(generationRerun).toHaveCSS("opacity", "0");
  await expect(generationRerun).toHaveCSS("pointer-events", "none");
  await generationStage.locator(":scope > b").hover();
  await expect(generationRerun).toHaveCSS("opacity", "1");
  await expect(generationRerun).toHaveCSS("pointer-events", "auto");
  await generationStage.locator(":scope > strong").hover();
  await expect(generationRerun).toHaveCSS("opacity", "1");
  await generationStage.getByRole("button", { name: "打开需求快照" }).hover();
  const generationMarker = await generationStage.locator(":scope > .product-delivery-stage-marker").boundingBox();
  expect(generationMarker).not.toBeNull();
  await page.mouse.move(
    generationMarker!.x + generationMarker!.width / 2,
    generationMarker!.y + generationMarker!.height / 2,
  );
  await expect(generationRerun).toHaveCSS("opacity", "1");

  const e2eStage = page.locator('[data-stage-kind="E2E_TEST"]');
  const e2eRerun = e2eStage.getByRole("button", { name: /从「跨平台 E2E」重新执行/ });
  await e2eStage.getByRole("button", { name: "打开E2E 报告" }).first().hover();
  await expect(e2eRerun).toHaveCSS("opacity", "0");
  await expect(e2eRerun).toHaveCSS("pointer-events", "none");

  await page.getByRole("button", { name: "完成本轮，不发布" }).click();
  await expect(page.getByText("交付完成", { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("button", { name: "按照当前需求开发" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "取消本次交付" })).toHaveCount(0);

  const projectId = page.url().split("/").pop() ?? "";
  const browserInstance = await (await page.request.get("/api/instance")).json() as {
    instance: { workspace: { id: string } };
  };
  await stack.selectWorkspace(browserInstance.instance.workspace.id);
  const project = await stack.readProject(projectId);
  expect(project.workflowState).toBe("SUCCEEDED");
  expect(project.jobs).toHaveLength(5);
  expect(project.jobs.every(job => job.state === "SUCCEEDED")).toBeTruthy();
  // A transient executor failure may consume a bounded retry; the product
  // guarantee is successful recovery with no stale failure surfaced.
  expect(project.jobs.every(job => job.lastError === null)).toBeTruthy();
  const evidence = await stack.queryRows<{
    total_jobs: number;
    exclusive_jobs_with_proofs: number;
    core_jobs_with_receipts: number;
  }>(`
    SELECT count(*)::int AS total_jobs,
           count(*) FILTER (
             WHERE exclusive
               AND before_reimage_proof IS NOT NULL
               AND cleanup_proof IS NOT NULL
               AND after_reimage_proof IS NOT NULL
           )::int AS exclusive_jobs_with_proofs,
           count(*) FILTER (WHERE pool_kind = 'CORE' AND receipt IS NOT NULL)::int AS core_jobs_with_receipts
      FROM deviludo.jobs
     WHERE workflow_id = '${project.workflowId}'::uuid
  `);
  expect(evidence[0]).toEqual({ total_jobs: 5, exclusive_jobs_with_proofs: 3, core_jobs_with_receipts: 2 });
  const signingReceipts = await stack.queryRows<{ receipt: unknown }>(`
    SELECT receipt FROM deviludo.jobs
     WHERE workflow_id = '${project.workflowId}'::uuid AND kind = 'ARTIFACT_SIGN'
  `);
  expect(signingReceipts).toHaveLength(0);

  await page.getByRole("link", { name: "游戏项目" }).first().click();
  await expect(page.getByRole("heading", { name: "游戏项目", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.getByRole("link", { name: `打开${name}项目` }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  await page.getByRole("link", { name: "运行状态" }).click();
  await expect(page.getByRole("heading", { name: "固定服务器池" })).toBeVisible();
  for (const pool of ["WEB", "CORE", "E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS"]) {
    await expect(page.getByRole("heading", { name: pool, exact: true })).toBeVisible();
  }
  await expect(page.getByText("READY", { exact: true })).toHaveCount(5);
});

test("keyboard creation derives a name and an active delivery can be cancelled", async ({ page, stack }) => {
  expect(stack.webUrl.protocol).toBe("http:");
  await stack.configureAgent();
  await stack.registerFixedNodes();
  await page.goto("/projects/new");
  const concept = "月影邮差。玩家驾驶滑翔翼在夜间群岛之间投递会发光的信件。";
  await page.getByLabel("游戏构想").fill(concept);
  await page.getByLabel("游戏构想").press("Control+Enter");

  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "时间回廊" })).toBeVisible();
  await page.getByLabel("继续项目会话").fill("需求已经完整，请确认可以按照当前方案开发。");
  await page.getByRole("button", { name: "发送项目消息" }).click();
  await page.getByRole("button", { name: "按照当前需求开发" }).click();
  await expect(page.getByRole("button", { name: "取消本次交付" })).toBeVisible();
  await page.getByRole("button", { name: "取消本次交付" }).click();
  await expect(page.getByText("已取消", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "取消本次交付" })).toHaveCount(0);

  await page.getByRole("link", { name: "项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "时间回廊" })).toBeVisible();
  await page.getByRole("link", { name: "首页", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("the home chat supports both project feedback and a fresh game conversation", async ({ page, stack }) => {
  await stack.configureAgent();
  const project = await stack.createProject({
    name: "雾港列车",
    concept: "玩家在风暴中调度幽灵列车并营救乘客。",
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想做什么游戏？" })).toBeVisible();
  await page.getByRole("button", { name: "浅色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const attachButton = page.getByRole("button", { name: "添加图片" });
  await expect(attachButton).toBeVisible();
  await expect(attachButton).toHaveText("");
  await expect(attachButton).not.toHaveAttribute("title", /.+/);
  const [composerBounds, attachBounds] = await Promise.all([
    page.locator(".home-conversation-box .conversation-box-composer").boundingBox(),
    attachButton.boundingBox(),
  ]);
  expect(composerBounds).not.toBeNull();
  expect(attachBounds).not.toBeNull();
  expect(attachBounds!.x - composerBounds!.x).toBeLessThan(30);
  expect(attachBounds!.y).toBeGreaterThan(composerBounds!.y + composerBounds!.height / 2);
  expect(attachBounds!.width).toBe(36);
  await attachButton.hover();
  expect(await attachButton.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderTopColor,
      color: style.color,
    };
  })).toEqual({
    backgroundColor: "rgb(226, 242, 247)",
    borderColor: "rgb(141, 184, 200)",
    color: "rgb(8, 127, 167)",
  });
  await page.getByLabel("导入已有项目").selectOption(project.id);
  const feedbackQuestion = "当前玩法如果增加低视野模式，会对资源管理产生什么影响？";
  await page.getByLabel("游戏想法或修改意见").fill(feedbackQuestion);
  const imageTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(
      [Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNg2PL/PwAFHgKz57crZQAAAABJRU5ErkJggg=="), character => character.charCodeAt(0))],
      "fog-mode.png",
      { type: "image/png" },
    ));
    transfer.items.add(new File(
      [Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNg2PL/PwAFHgKz57crZQAAAABJRU5ErkJggg=="), character => character.charCodeAt(0))],
      "unused-ui.png",
      { type: "image/png" },
    ));
    return transfer;
  });
  const composer = page.locator(".home-conversation-box .conversation-box-composer");
  await composer.dispatchEvent("dragenter", { dataTransfer: imageTransfer });
  await expect(composer).toHaveClass(/is-image-dragover/);
  await expect(page.getByText("松开以添加图片", { exact: true })).toBeVisible();
  await composer.dispatchEvent("drop", { dataTransfer: imageTransfer });
  await expect(composer).not.toHaveClass(/is-image-dragover/);
  await expect(page.locator(".conversation-composer-images figcaption")).toHaveText(["fog-mode.png", "unused-ui.png"]);
  const removeUnusedImage = page.getByRole("button", { name: "移除 unused-ui.png" });
  await expect(removeUnusedImage).toBeVisible();
  expect(await removeUnusedImage.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderTopColor,
      color: style.color,
    };
  })).toEqual({
    backgroundColor: "rgb(255, 255, 255)",
    borderColor: "rgb(141, 156, 175)",
    color: "rgb(38, 54, 72)",
  });
  await removeUnusedImage.click();
  await expect(page.getByText("unused-ui.png", { exact: true })).toHaveCount(0);
  await expect(page.locator(".conversation-composer-images figcaption")).toHaveText("fog-mode.png");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText(feedbackQuestion, { exact: true })).toBeVisible();
  const sentImage = page.locator('.home-conversation-box .conversation-message-images img[alt="fog-mode.png"]');
  await expect(sentImage).toBeVisible();
  await expect.poll(() => sentImage.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(page.getByText(/测试设计 Agent 已结合项目上下文生成回复/).first()).toBeVisible();
  await expect(page.getByText("正在思考", { exact: true })).toHaveCount(0);
  await expect(page.getByText("对方正在输入中", { exact: true })).toHaveCount(0);
  await expect(page.locator(".home-conversation-box .conversation-box-message > div > p")).toHaveText([
    feedbackQuestion,
    "测试设计 Agent 已结合项目上下文生成回复。",
  ]);
  const suggestedReplies = page.getByRole("group", { name: "可选回复" });
  await expect(suggestedReplies).toBeVisible();
  await expect(suggestedReplies.getByRole("button")).toHaveText(["强化资源管理", "增加随机事件"]);

  let releaseManualReply: () => void = () => {};
  const manualReplyGate = new Promise<void>(resolve => { releaseManualReply = resolve; });
  await page.route("**/api/conversations/messages/stream", async route => {
    await manualReplyGate;
    await route.continue();
  }, { times: 1 });
  const followUpQuestion = "请说明车灯亮度会如何影响幽灵出现频率。";
  await page.getByLabel("游戏想法或修改意见").fill(followUpQuestion);
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.locator(".home-conversation-box .conversation-box-message.is-thinking")).toBeVisible();
  await expect(suggestedReplies).toHaveCount(0);
  releaseManualReply();
  await expect(suggestedReplies).toBeVisible();
  await expect(page.getByText(followUpQuestion, { exact: true })).toBeVisible();

  const homeMessageViewport = await page.locator(".home-conversation-box .conversation-box-messages").evaluate(element => ({
    height: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(homeMessageViewport.height).toBeLessThanOrEqual(460);
  expect(homeMessageViewport.height).toBeGreaterThanOrEqual(300);
  expect(homeMessageViewport.overflowY).toBe("auto");
  const homeConversationBounds = await page.locator(".homeChat-threadShell").boundingBox();
  const viewport = page.viewportSize();
  expect(homeConversationBounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(homeConversationBounds!.y + homeConversationBounds!.height).toBeLessThanOrEqual(viewport!.height);
  await expect(page.getByText("QUESTION", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "按照当前需求开发" })).toBeVisible();
  await expect(page.getByRole("link", { name: "打开项目" })).toHaveAttribute("href", `/projects/${project.id}`);
  expect((await stack.readProject(project.id)).workflowState).toBe("DRAFT");

  await suggestedReplies.getByRole("button", { name: "强化资源管理" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}`);
  await expect(page.getByRole("heading", { name: "会话记录" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "历史会话" })).toBeVisible();
  await expect(page.getByText(feedbackQuestion, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("强化资源管理", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("测试设计 Agent 已整理当前游戏需求。", { exact: true })).toBeVisible();
  await expect(page.getByText("E2E G2", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除项目" })).toBeVisible();
  await expect(page.getByRole("region", { name: "项目说明内容" })).toBeVisible();

  await page.getByRole("link", { name: "首页", exact: true }).click();

  await expect(page.getByRole("heading", { name: "今天想做什么游戏？" })).toBeVisible();
  await expect(page.getByLabel("导入已有项目")).toHaveValue("");
  await expect(page.getByLabel("导入已有项目").locator('option[value="__import_existing_project__"]')).toHaveText("导入已有项目…");
  const concept = "我想做一款以时间循环为核心的像素冒险游戏。";
  await page.getByLabel("游戏想法或修改意见").fill(concept);
  await page.getByLabel("游戏想法或修改意见").press("Control+Enter");
  await expect(page.getByText(concept, { exact: true })).toBeVisible();
  await expect(page.getByText(/测试设计 Agent 已结合项目上下文生成回复/).first()).toBeVisible();
});

test("home chat enters the thread immediately and shows animated waiting dots", async ({ page, stack }) => {
  await stack.configureAgent();
  let releaseRequest: () => void = () => {};
  const requestGate = new Promise<void>(resolve => { releaseRequest = resolve; });
  await page.route("**/api/conversations/messages/stream", async route => {
    await requestGate;
    await route.abort("failed");
  });
  try {
    await page.goto("/");
    const concept = "先进入会话，再等待设计搭档的流式回复。";
    await page.getByLabel("游戏想法或修改意见").fill(concept);
    await page.getByLabel("选择会话图片").setInputFiles({
      name: "new-game-reference.png",
      mimeType: "image/png",
      buffer: ONE_PIXEL_PNG,
    });
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".home-conversation-box .conversation-composer-images")).toHaveCount(0);
    await expect(page.locator('.home-conversation-box .conversation-message-images img[alt="new-game-reference.png"]')).toBeVisible();
    await expect(page.getByText(concept, { exact: true })).toBeVisible();
    const waiting = page.locator(".home-conversation-box .conversation-box-message.is-thinking [aria-label='等待回复']");
    await expect(waiting).toBeVisible();
    await expect(page.getByText("正在思考", { exact: true })).toBeVisible();
    await expect(waiting.locator("i")).toHaveCount(3);
  } finally {
    releaseRequest();
  }
  await expect(page.locator(".homeChat-error")).toContainText("消息发送失败");
  await expect(page.locator(".home-conversation-box .conversation-composer-images")).toHaveCount(0);
});

test("a creator can link a local project without uploading it and continue its Agent analysis conversation", async ({ page, stack }) => {
  await stack.configureAgent();
  await page.goto("/projects");
  await expect(page.locator(".project-catalog-heading").getByRole("link", { name: "导入已有项目" })).toBeVisible();
  await page.locator(".project-catalog-heading").getByRole("link", { name: "导入已有项目" }).click();
  await expect(page).toHaveURL(/\/projects\/import$/);
  await expect(page.getByRole("heading", { name: "导入已有项目" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新构想" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "导入项目" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "本地项目" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "GITHUB" }).click();
  await expect(page.getByLabel("GitHub 仓库地址")).toBeVisible();
  await expect(page.getByLabel("GitHub 新分支")).toHaveCount(0);
  await page.getByRole("tab", { name: "本地项目" }).click();
  await expect(page.getByLabel("本地项目新分支")).toHaveCount(0);
  const bindingId = randomUUID();
  let currentBranch = "main";
  await page.route("http://127.0.0.1:3199/directory/select", async route => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: {
        "access-control-allow-origin": stack.webUrl.origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      } });
      return;
    }
    expect(route.request().postDataJSON()).toBeNull();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { bindingId, displayName: "clock-game", gitRepository: true, gitBranch: currentBranch },
      headers: { "access-control-allow-origin": stack.webUrl.origin },
    });
  });
  await page.route("http://127.0.0.1:3199/directory/git/status", async route => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: {
        "access-control-allow-origin": stack.webUrl.origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      } });
      return;
    }
    expect(route.request().postDataJSON()).toEqual({ bindingId });
    await route.fulfill({ status: 200, contentType: "application/json", json: {
      repository: true,
      branch: currentBranch,
    }, headers: { "access-control-allow-origin": stack.webUrl.origin } });
  });
  await page.route("http://127.0.0.1:3199/directory/git/branch", async route => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: {
        "access-control-allow-origin": stack.webUrl.origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      } });
      return;
    }
    expect(route.request().postDataJSON()).toEqual({ bindingId, branchName: "codex/local-import" });
    currentBranch = "codex/local-import";
    await route.fulfill({ status: 200, contentType: "application/json", json: {
      repository: true,
      branch: currentBranch,
    }, headers: { "access-control-allow-origin": stack.webUrl.origin } });
  });
  await expect(page.getByLabel("项目 ZIP")).toHaveCount(0);
  await page.getByRole("button", { name: "选择项目文件夹并关联" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  const linkedProject = page.getByRole("link", { name: "打开clock-game项目" });
  await expect(linkedProject).toBeVisible({ timeout: 30_000 });
  await linkedProject.click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "clock-game" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "会话记录" })).toBeVisible();
  await expect(page.getByText(/现有信息足以进入需求确认；如需调整分析结论/)).toBeVisible();
  await expect(page.getByText("探索场景、记录线索并重置时间线来改变事件结果。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("展开项目交付配置").getByText("main", { exact: true })).toBeVisible();
  await page.getByLabel("展开项目交付配置").click();
  await page.getByRole("button", { name: "修改分支" }).click();
  await page.getByLabel("新建 Git 分支").fill("codex/local-import");
  await page.getByRole("button", { name: "新建并切换" }).click();
  await expect(page.getByLabel("Git 配置").getByText("codex/local-import", { exact: true })).toBeVisible();
  const followUp = "加入一个跨循环保留线索的玩家日志。";
  await page.getByLabel("继续项目会话").fill(followUp);
  await page.getByRole("button", { name: "发送项目消息" }).click();
  await expect(page.getByText(followUp, { exact: true })).toBeVisible();
  await expect(page.getByText(/测试设计 Agent 已结合项目上下文生成回复/).first()).toBeVisible();
});

test("an unknown project presents a stable product error", async ({ page, stack }) => {
  expect(stack.webUrl.protocol).toBe("http:");
  await page.goto(`/projects/${randomUUID()}`);
  await expect(page.getByText("项目读取失败 (404)")).toBeVisible();
  await page.getByRole("link", { name: "DeviLudo 首页" }).click();
  await expect(page.getByRole("heading", { name: "今天想做什么游戏？" })).toBeVisible();
});
