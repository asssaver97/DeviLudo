import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/stack";

test("a creator can refine and deliver a game through every Core and platform stage", async ({ page, stack }) => {
  const nodes = await stack.registerFixedNodes();
  await stack.startLogicalNodes(nodes);

  await page.goto("/");
  await expect(page.locator('link[rel="icon"][href="/favicon-deviludo.png"]')).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "今天想做什么游戏？" })).toBeVisible();
  await expect(page.getByRole("link", { name: "首页", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "开始新游戏" })).toHaveCount(0);
  await page.locator("summary.workspace-switcher").click();
  await expect(page.getByRole("menu", { name: "工作区菜单" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "添加工作区" })).toBeVisible();
  await page.getByRole("link", { name: "项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "游戏项目", exact: true })).toBeVisible();
  await expect(page.getByText("未选择工作区", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("SYSTEM ONLINE")).toBeVisible();
  await expect(page.getByRole("heading", { name: "还没有游戏项目" })).toBeVisible();
  await page.getByRole("button", { name: "通知" }).click();

  await page.getByRole("link", { name: "开始新构想" }).click();
  await expect(page).toHaveURL(/\/projects\/new$/);
  const name = `星港维修队-${randomUUID().slice(0, 6)}`;
  const concept = "一款双人合作的太空维修游戏，玩家需要在十五分钟内处理火灾、电力和导航故障。";
  await page.getByLabel("游戏名称").fill(name);
  await page.getByLabel("游戏构想").fill("太短");
  await expect(page.getByRole("button", { name: "生成游戏规格" })).toBeDisabled();
  await page.getByLabel("游戏构想").fill(concept);
  await page.getByRole("button", { name: "生成游戏规格" }).click();

  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText(concept).first()).toBeVisible();
  await expect(page.getByText("等待你的批准")).toBeVisible();

  const revision = "单局改为十分钟，并增加手柄震动和高对比度故障提示。";
  const revisionBox = page.getByPlaceholder(/补充或修正规格/);
  await expect(page.getByRole("button", { name: "提交修订" })).toBeDisabled();
  await revisionBox.fill(revision);
  await page.getByRole("button", { name: "提交修订" }).click();
  await expect(page.getByText(revision)).toBeVisible();

  await page.getByRole("button", { name: /批准规格并启动 Agent/ }).click();
  await expect(page.getByText("交付完成", { exact: true })).toBeVisible({ timeout: 45_000 });
  for (const stage of ["Agent 生成", "制品构建", "跨平台 E2E", "平台签名", "Steam 上传", "干净回装"]) {
    await expect(page.getByText(stage, { exact: true })).toBeVisible();
  }
  await expect(page.getByText(/linux: SUCCEEDED/).first()).toBeVisible();
  await expect(page.getByText(/windows: SUCCEEDED/).first()).toBeVisible();
  await expect(page.getByText(/macos: SUCCEEDED/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /批准规格/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "取消本次交付" })).toHaveCount(0);

  const projectId = page.url().split("/").pop() ?? "";
  const browserSession = await (await page.request.get("/api/session")).json() as {
    session: { selectedWorkspace: { id: string } | null };
  };
  expect(browserSession.session.selectedWorkspace).not.toBeNull();
  await stack.selectWorkspace(browserSession.session.selectedWorkspace!.id);
  const project = await stack.readProject(projectId);
  expect(project.workflowState).toBe("SUCCEEDED");
  expect(project.jobs).toHaveLength(12);
  expect(project.jobs.every(job => job.state === "SUCCEEDED")).toBeTruthy();
  expect(project.jobs.every(job => job.attempt === 1)).toBeTruthy();
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
  expect(evidence[0]).toEqual({ total_jobs: 12, exclusive_jobs_with_proofs: 9, core_jobs_with_receipts: 3 });
  const signingReceipts = await stack.queryRows<{ receipt: unknown }>(`
    SELECT receipt FROM deviludo.jobs
     WHERE workflow_id = '${project.workflowId}'::uuid AND kind = 'ARTIFACT_SIGN'
  `);
  expect(JSON.stringify(signingReceipts)).not.toContain("development-wrapped");

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
  await expect(page.getByText("ACTIVE", { exact: true })).toHaveCount(5);
});

test("keyboard creation derives a name and an active delivery can be cancelled", async ({ page, stack }) => {
  expect(stack.webUrl.protocol).toBe("http:");
  await stack.configureAgent();
  await page.goto("/projects/new");
  const concept = "月影邮差。玩家驾驶滑翔翼在夜间群岛之间投递会发光的信件。";
  await page.getByLabel("游戏构想").fill(concept);
  await page.getByLabel("游戏构想").press("Control+Enter");

  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "时间回廊" })).toBeVisible();
  await page.getByRole("button", { name: /批准规格并启动 Agent/ }).click();
  await expect(page.getByRole("button", { name: "取消本次交付" })).toBeVisible();
  await page.getByRole("button", { name: "取消本次交付" }).click();
  await expect(page.getByText("已取消", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "提交修订" })).toHaveCount(0);
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
  const selected = await page.request.put("/api/session/workspace", { data: { workspaceId: project.workspaceId } });
  expect(selected.ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想做什么游戏？" })).toBeVisible();
  await page.getByLabel("关联项目").selectOption(project.id);
  const feedback = "增加一个低视野模式，并让车灯成为需要管理的资源。";
  await page.getByLabel("游戏想法或修改意见").fill(feedback);
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText(feedback, { exact: true })).toBeVisible();
  await expect(page.getByText(/加入《雾港列车》的规格草案/)).toBeVisible();
  await expect(page.getByText("已写入规格草案", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "打开项目" })).toHaveAttribute("href", `/projects/${project.id}`);
  expect((await stack.readProject(project.id)).specification.revisionNotes).toContain(feedback);

  await page.getByRole("button", { name: "新对话" }).click();
  await expect(page.getByRole("heading", { name: "今天想做什么游戏？" })).toBeVisible();
  await expect(page.getByLabel("关联项目")).toHaveValue("");
  const concept = "我想做一款以时间循环为核心的像素冒险游戏。";
  await page.getByLabel("游戏想法或修改意见").fill(concept);
  await page.getByLabel("游戏想法或修改意见").press("Control+Enter");
  await expect(page.getByText(concept, { exact: true })).toBeVisible();
  await expect(page.getByText(/玩家每分钟最常做的动作/)).toBeVisible();
});

test("an unknown project presents a stable product error", async ({ page }) => {
  const selected = await page.request.post("/api/workspaces", { data: { name: "错误边界工作区" } });
  expect(selected.status()).toBe(201);
  await page.goto(`/projects/${randomUUID()}`);
  await expect(page.getByText("项目读取失败 (404)")).toBeVisible();
  await page.getByRole("link", { name: "DeviLudo 首页" }).click();
  await expect(page.getByRole("heading", { name: "今天想做什么游戏？" })).toBeVisible();
});
