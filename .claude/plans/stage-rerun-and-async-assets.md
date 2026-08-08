# 素材异步化 + 节点级重跑

## 背景：先纠正我上一次提交引入的三个问题

调查中发现我之前的 asset 提交有三处真实缺陷，这次一并修掉：

1. **`ASSET_GENERATION` 被塞进了 `PIPELINE` 串行数组**（`components/ProjectStudio.tsx:35`）。
   `PIPELINE` 的每一项都会 `project.jobs.filter(job => job.kind === kind)` 去查 job，
   而 `deviludo.job_kind` 枚举里**没有** `ASSET_GENERATION`，所以它永远查不到 job、
   永远显示 PENDING，还占了一个流程序号。这正是你指出的问题。

2. **`infra/postgres/002_assets.sql` 违反了架构守卫**。
   `scripts/verify-architecture.mjs:56` 断言 `infra/postgres/` 下**只能有 `001_core.sql`**
   （单一 fresh baseline，不做增量迁移）。我实测确认该断言现在会失败。
   本机因为缺 ripgrep 所以 `verify:architecture` 崩在前面、掩盖了这个失败 —
   在有 ripgrep 的 CI 上它会红。同时 `scripts/migrate-postgres.mjs` 只读 `001_core.sql`，
   所以 `002_assets.sql` **从来没有被应用过**，这也是你上次问"为什么打不开"背后的同类隐患：
   素材 API 一旦被调用就会因表不存在而 500。

3. **`assetManifest` 只写进了 Agent 提示词，没有任何消费端**。
   `grep` 确认除 `task-runner.mjs` 的 prompt 字符串外，没有任何代码读取它，
   `createAssetManifest`/`createAssetItems` 零调用方。素材面板永远是空的。

## 设计

### A. 素材脱离串行流程

- 从 `PIPELINE` 移除 `ASSET_GENERATION`，恢复 6 个真实 job kind。
- 素材状态不进 `product-delivery-track`，而是在流程图**下方**独立渲染一条
  “异步素材”条带（复用已有的 `AssetManifestPanel`），明确它与串行流程并行、
  不阻塞 build/E2E。
- `002_assets.sql` 的表定义**合并进 `001_core.sql`**（fresh baseline 约定），
  删除 `002_assets.sql`，让 `verify:architecture` 恢复绿色，并使建表真正生效。
- Agent 产出的 `assetManifest` 在 `complete_job` 的 `AGENT_GENERATION` 分支落库
  （`asset_manifests` + `asset_items`），素材面板从此有数据。

### B. 节点级重跑（核心）

替换现有三个各自为政的 `retry-agent` / `retry-artifact-build` / `retry-e2e`
（它们都硬绑 `workflow.state = 'FAILED'` 且要求“最后一个失败 job 恰好是本阶段”），
改为统一的**从指定节点重跑**：

- 新增单一端点 `POST /v1/projects/:projectId/rerun-stage`，body `{ stage: JobKind }`。
- 新信号 `STAGE_RERUN_REQUESTED`，payload 带 `stage`。
- SQL 侧新函数逻辑（写在 `accept_workflow_signal` 内）：
  1. 允许 `workflow.state IN ('FAILED','SUCCEEDED','CANCELLED')`（按你的选择）；
     若处于运行中状态则报错，提示先取消。
  2. 依 `profile` 计算 stage 顺序，取**选中节点及其所有下游**。
  3. 把这些 stage 下所有非终态 job 置 `CANCELLED`（`fencing_token + 1`，防脏回执），
     把已 `SUCCEEDED` 的下游 job 置 `CANCELLED` 并写 `last_error = 'superseded by stage rerun'`
     —— 即你选的“作废下游、全部重跑”。
  4. 将 workflow 置为选中节点对应的运行态，仅入队**选中节点**的 job；
     后续节点由既有 `complete_job` 前向推进逻辑自然串起来。
  5. `enqueue_job` 的 idempotency key 加 `:rerun:<signal_id>` 后缀，
     绕开 `UNIQUE (workspace_id, idempotency_key)`（沿用现有 retry 的写法）。
- 关键：E2E 重跑**不再 resume**。现有 SQL 会跳过已成功的平台，
  这与“作废下游全部重跑”冲突，需改为无条件入队全部 `target_platforms`。

### C. UI

- 每个流程节点在终态下显示“从此处重跑”按钮，调用 `rerun-stage`。
- 保留失败态下的主行动按钮，但底层统一走 `rerun-stage`。
- `AssetManifestPanel` 的“使用素材重新构建”改为调用 `rerun-stage`
  并传 `ARTIFACT_BUILD`，替换现在那个 `console.log` 占位的 `enqueueDelivery`
  （`services/core/src/delivery.ts` 随之删除，它是纯 stub）。
- 删除 `app/api/projects/[projectId]/rebuild-with-assets/route.ts`（被 rerun-stage 取代）。

## 落地顺序

1. `001_core.sql`：并入 asset 表；`accept_workflow_signal` 增加
   `STAGE_RERUN_REQUESTED`；`complete_job` 落库 `assetManifest`；
   E2E 重跑改为全平台无条件入队。删除 `002_assets.sql`。
2. `contracts.ts`：`WorkflowSignalInput.kind` 加 `STAGE_RERUN_REQUESTED`。
3. `workflow-state-machine.ts`：加 `STAGE_RERUN_REQUESTED` 事件与 stage 顺序推导，
   保持 TS 状态机与 SQL 行为一致。
4. `api.ts`：新增 `rerun-stage`，移除三个旧 retry 端点。
5. UI：`PIPELINE` 去掉 ASSET_GENERATION；节点级重跑按钮；素材面板接线。
6. 测试：stage 顺序/下游作废/终态门槛的单元测试；更新
   `tests/database-contract.test.ts` 里引用旧 retry 信号的用例。

## 验证

- `npm run typecheck`
- `npm run test:unit`
- `node -e` 模拟 `verify-architecture` 的迁移断言，确认恢复为 `["001_core.sql"]`
  （本机缺 ripgrep 跑不了完整 `verify:architecture`，这点我会明确说明而非假装跑过）
- `tests/database-contract.test.ts` 需要真实 PostgreSQL（`npm run local:database:test`），
  本机可跑则跑，不可跑则如实报告

## 影响面

- **破坏性**：三个旧 retry 端点被移除，`002_assets.sql` 被删除。
  由于 asset 表从未真正建成、旧 retry 端点仅前端自用，实际用户影响为零。
- 需要重建本地数据库（`npm run local:reset:source-v1`）才能拿到新 baseline。
