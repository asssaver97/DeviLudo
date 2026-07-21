# 本地测试站与真实 Godot 验证

DeviLudo 的前端、预览 API、Godot 验证侧车和 Agent 就绪探针可以作为仅本机可访问的测试栈运行。启动脚本固定绑定 `127.0.0.1`，不会监听局域网接口，也不需要 GitHub、Steam、Claude 或 Codex 的真实凭据。

## 准备

- Node.js `22.13.0` 或更高版本
- 在仓库根目录执行过 `npm install`
- Godot 4（macOS 默认寻找 `/Applications/Godot.app/Contents/MacOS/Godot`，也可通过 `DEVILUDO_GODOT_BINARY` 指定）

首次运行真实导出前安装与本机精确 Godot 构建匹配的官方模板：

```bash
npm run local:install-export-templates
```

安装器使用版本化目录中的固定下载 URL、字节数和 SHA-256，拒绝浮动版本、路径穿越、链接、重复文件和现存未验证目录。也可用 `--archive /绝对路径/官方模板.tpz` 对已经下载的归档执行相同校验。安装结果写入 Godot 标准目录并设为只读；每次验证仍会重验安装清单和 macOS 模板摘要，再把精确版本只读挂载进隔离 HOME。

不要把 API Key、GitHub 私钥或 Steam 密码写入命令、脚本或 `.env`。仓库根目录的 `.env.example` 只包含本地默认值、公开 ID 和 Vault 引用示例；测试站的演示操作会停在外部服务门禁处。

## 启动

在第一个终端执行：

```bash
npm run local:dev
```

测试站地址为 <http://127.0.0.1:3000>，Godot 验证侧车为 `http://127.0.0.1:4311`，Agent 就绪探针为 `http://127.0.0.1:4312`，规格对话侧车为 `http://127.0.0.1:4313`。同一命令会检查四个端口并同时启动四个进程。按一次 `Ctrl-C` 会向完整子进程树发送优雅停止信号；五秒后仍未退出会自动强制清理，再按一次 `Ctrl-C` 可立即强制停止。

启动器会为 Godot、Agent 和规格 sidecar 分别生成独立 256-bit 会话 Key。Web 到 sidecar 的每个非健康请求都签名绑定服务受众、方法、路径、正文摘要、时间戳和单次 nonce；Key 以 `0600` 写入被 Git 忽略的 `.deviludo/` 仅供 smoke 验证，并在退出时删除。固定请求头、跨服务 Key、过期请求、正文或路径篡改都会被拒绝。

项目页的构想消息会真实经过规格对话 sidecar，返回完整规格、验收标准和 TestKit 计划；批准会创建独立的已批准/已冻结后继修订。该本地模型明确报告为 `deterministic-loopback`，生产环境不会启用它或假装第三方模型已配置。

候选反馈不会重新打开已批准会话。只有候选 E2E 已进入待验收状态，或 main/Steam 失败已冻结并交给人工修订时，反馈端点才会让规格 sidecar 创建一个新的 DRAFT 会话。旧会话保持 `APPROVED`，旧本地验证与 Agent 回执仍可审计但 `valid=false`；新草稿再次批准后获得不同 Run ID，不能复用上一轮证据。

Agent 探针只运行固定的版本命令。普通独立部署只有精确 CLI 版本匹配、工作负载上报的 `DEVILUDO_WORKER_IMAGE_DIGEST` 等于批准的 `DEVILUDO_LOCAL_EXPECTED_WORKER_IMAGE_DIGEST`、无凭据的 HTTPS Inference Gateway 已配置、锁定 Provider/凭据/四类模型角色通过受信探针且 `DEVILUDO_LOCAL_AGENT_EXECUTION=1` 全部满足时，开发 Worker 才会报告 `READY`。`npm run local:dev` 会在同时启用显式 loopback 测试模式时使用 `LOCAL_DETERMINISTIC` Worker 身份：它根据管理员本地供应链 Broker 已批准的精确 Agent 版本和 Adapter 版本重新计算逻辑 WorkerImage digest，使后台构建/灰度后的新 Profile 可以通过同一不可变镜像绑定；该模式不声称具备生产容器或 microVM 隔离，也不能在非测试部署中仅靠环境开关启用。Primary、Planning、Small/Fast 与 Subagent 模型会随 Profile revision 一起进入不可变运行锁；Primary 与实际 CLI `--model` 不一致时预检直接拒绝。默认配置仍没有受信 Provider 绑定探针，也没有隔离执行器，会安全地报告 `BLOCKED`；这不是测试栈故障。

`POST /v1/runs` 会先执行同一预检。预检未通过时返回原始门禁码；全部通过但没有隔离执行器时返回 `LOCAL_AGENT_EXECUTOR_NOT_CONFIGURED`。启用隔离执行器后，Claude Code/Codex 还必须按严格 schema 写入保留的 `.deviludo-agent-code-review.json`；执行器以禁止符号链接和限长方式读取后立即删除它，只在没有阻断项时生成绑定当前 Run、Attempt、镜像、固定模型、规格、测试计划和候选 source digest 的不可变评审回执。缺失、畸形、浮动模型或阻断评审均失败关闭，候选不能进入 E2E。项目 API 只接受逐项匹配锁定运行的完成回执，并保存 SCM 代理产生的完整候选 SHA、源码摘要、评审回执、changed-files、usage 和警告；浏览器不能直接提交或伪造回执。

`/admin/agents` 的管理按钮调用本地 `/api/admin/**`，携带当前模拟角色和幂等键。版本发现可以填写精确版本；在本地测试环境留空时，页面会复用只读探针实际看到的 CLI 版本，方便把已经安装的 Claude Code 或 Codex CLI 写入候选目录，但仍不会自动批准、安装、灰度或激活。版本目录同时显示精确官方包来源、发现时间、发行说明、完整性、SBOM 和扫描状态；可点击链接必须与 Agent、精确版本和固定官方域名/路径一致。版本阻止、弃用、灰度/回滚、平台默认与 Provider 草稿会写入本地控制面状态和审计；Provider 草稿会完整保存四类模型、计价、数据地域/保留/训练政策和确认时间，Profile 保存预算、turn、超时、凭据及同作用域 fallback，刷新或重启后不会回落到 UI 默认值。旧 v1/v2 D1 快照会升级到 v3；凭据新增不可变的 platform/tenant 所有权，无法证明归属的旧凭据按平台范围失败关闭。租户/项目代理把认证 tenant/project 绑定传入本地控制面，因此响应、轮换、撤销和默认选择都不能跨作用域；项目页面不返回任何凭据版本目录。弃用只阻止新镜像构建，已有安装与运行任务保持锁定。凭据列表显示创建时间和原子轮换完成时间，并从本地追加式用量记录计算最后使用时间。本地供应链按钮只消费明确标记为 `LOCAL_DETERMINISTIC_BROKER`、且不接受管理员自报签名/hash 的隔离夹具回执；它不等于生产扫描证据。Provider 激活仍要求受信 Connector 的完整真实探针，默认测试栈不会伪造上游通过。

任务预检以不可变 Run 中锁定的精确版本直接核对实际 CLI。服务启动时的版本基线只用于健康投影和提示，不会把已经由管理员更新并锁入新任务的精确版本误判为旧版本；WorkerImage、Provider、凭据、预算和显式执行开关仍逐项校验。

生产数据库会在 `agent_run_provider_failovers` 提交时原子物化追加式 `AGENT_RUN_PROVIDER_FAILOVER_ACTIVATED` 管理审计事件，标明原/目标 Profile、Provider、模型、预算和授权到期时间。投影不复制一次性授权 nonce，也不暴露 SecretRef 或密钥；租户和项目管理员仍按请求身份过滤可见范围。

`/settings/agents` 使用租户作用域的本地代理验证 BYOK 只写响应、Provider 草稿和默认 Profile；`/projects/ember-archipelago/agent-settings` 验证项目从 ACTIVE 继承 Profile 中选择。规格批准会按项目、租户、平台顺序解析最高优先级配置，并把 Profile 来源与全部精确运行字段复制到不可变 D1 快照；若该覆盖的 Installation 或 Provider 已失效，审批返回 `AGENT_PROFILE_NOT_READY`，不会静默回退或在 Claude/Codex 间切换。两条本地路径与生产页面相同，但只对真实 loopback URL 且显式 `DEVILUDO_LOCAL_TEST_MODE=1` 生效，不会联系第三方 Provider。

在项目页批准规格后，点击“运行真实本机验证”。侧车会：

1. 将固定 Godot 样例复制到 `.deviludo/local-runtime/<project>/<run>/workspace`；
2. 通过 SCM 代理在工作区外初始化 base Git 元数据，再由代理提交样例候选并生成 base/candidate SHA 与 tree digest；
3. 执行 Godot import、生产场景 headless 启动和 TestKit 核心循环/保存读取/性能检查；
4. 尝试 macOS 导出，并生成 `manifest.json`、`junit.xml` 和 `godot.log`。

证据包含完整 Git SHA、source digest、bundle digest、精确 Godot 版本和逐项检查结果。`.deviludo/` 已被 Git 忽略。

如果本机没有通过上述固定安装器安装对应 Godot export templates，验证会如实记录为 `WAITING_DEPENDENCY + WAITING_EXPORT_TEMPLATES`。这份证据仍可下载审计，但目标矩阵入口返回 `409 LOCAL_EXPORT_TEMPLATES_REQUIRED`，不能进入候选验收或授权发布；安装完全匹配的模板后可对同一锁定运行重新验证。Windows/Linux 也只有真实 Runner 注册并返回有效 evidence 后才会通过。

Fixture 成功链走到 `main SHA 发布门禁` 或 `Steam 回装测试` 时，可以分别点击“模拟 main 门禁失败”或“模拟 Steam 回装失败”。本地 D1 会持久化失败 evidence、冻结修复指令和失败 main 基线，同时清空旧 main、MFA、Steam Build/Release 与外部批准授权。项目页随后只显示人工修改入口；创建不同的新规格草稿并再次批准后才会签发新运行。该演练完全在 loopback Fixture 内完成，不会请求 GitHub、Steam 或开发模型。

## Smoke check

保持测试站运行，在第二个终端执行：

```bash
npm run local:smoke
```

检查器最多等待 30 秒让站点就绪，然后验证：

- `/` 返回 DeviLudo HTML 工作台；
- `/admin/agents` 返回 Agent 管理台；
- `/settings/agents` 返回租户 BYOK、Provider 与默认 Agent 页面；
- `/projects/ember-archipelago/agent-settings` 返回项目 Profile 选择页；
- `/api/admin/agents` 返回服务端默认 Agent、精确版本和部署状态，且不暴露 SecretRef；
- 本地 Agent 管理写入追加到不可修改的 D1 修订；停止并重新启动 `local:dev` 后，版本、安装、Profile、默认选择、幂等响应与脱敏审计仍可恢复；
- `/api/admin/agent-versions/discover` 接受精确稳定版或预发布版本、拒绝浮动别名，且发现候选不会自动激活；
- `/api/admin/agent-versions/deprecate` 只接受已批准版本，并禁止后续 WorkerImage 构建而不改变已有安装；
- 租户 Profile、BYOK 与管理员 rollout 写入拒绝未知/旧版字段和客户端作用域，并通过写入前后投影对比证明拒绝请求没有修改状态或回显未知值；
- 租户 BYOK 通过真实页面 API 创建新不可变版本、停止旧版本签发并撤销指定旧版本；响应和投影均不包含明文或 SecretRef；
- `/api/health` 返回 `status: "ok"` 且服务标识正确。
- 侧车 `/health` 返回 `deviludo-local-runtime` 和实际 Godot 版本。
- Agent 探针 `/health` 返回两个 CLI 的实际版本及 `READY`、`VERSION_MISMATCH` 或 `UNAVAILABLE`，并公开 `PINNED_ENV`、`LOCAL_DETERMINISTIC` 或 `NOT_CONFIGURED` 身份模式；`degraded` 是未启用执行时的预期状态。
- Agent 探针 `/v1/preflight` 使用固定测试运行锁，验证 CLI、镜像、Provider/Gateway 与执行开关；它只返回阻塞原因或 `READY`，不会启动 Agent。
- Agent `/v1/runs` 在默认测试栈必须以明确门禁码返回 409/503，证明没有执行器时失败关闭。
- 通过 Web API 真实运行固定 Godot 样例并下载同一 bundle 的 `manifest.json`，覆盖签名后的执行和证据读取链路。
- 在候选 E2E 前拒绝反馈；若导出模板缺失，确认真实候选不能启动目标矩阵。独立的完整 Fixture 候选在待验收后创建、精确重放并批准新反馈草稿，再对后继 Run 运行真实 Godot，证明旧验收权限不能被复用。
- 候选接受只通过空 JSON 的 `/api/projects/{projectId}/acceptance` 提交，精确重放同一个幂等决定；通用 `/delivery` 的 `accept` 动作必须返回 400，不能绕过正式验收门禁。
- 直接向 Godot、Agent、规格三个 sidecar 发送旧固定请求头，必须全部返回 403，证明 loopback 本身不构成权限。
- 两个隔离项目分别选择 Claude Code 与 Codex CLI Profile，从规格批准一直推进到三平台通过和 `RELEASED`，并确认整个链路保持最初的不可变 Agent 锁。

任何路由超时、非 2xx、错误内容类型或内容标记缺失都会以非零状态退出，适合本地脚本和 CI 调用。

## 自定义端口

两个终端必须使用同一个 Web 端口：

```bash
npm run local:dev -- --port 4310
npm run local:smoke -- --port 4310
```

也可以使用项目专用环境变量：

```bash
DEVILUDO_LOCAL_PORT=4310 npm run local:dev
DEVILUDO_LOCAL_PORT=4310 npm run local:smoke
```

脚本不读取通用 `PORT` 变量，避免被其他开发工具的环境配置意外影响。

Godot 侧车、Agent 探针和规格侧车端口默认分别是 `4311`、`4312`、`4313`。如需修改，启动与 smoke 命令应同时设置 `DEVILUDO_LOCAL_RUNTIME_PORT`、`DEVILUDO_LOCAL_AGENT_RUNTIME_PORT`、`DEVILUDO_LOCAL_SPEC_RUNTIME_PORT`。

`npm run local:dev` 会在所有本地进程上显式设置 `DEVILUDO_LOCAL_TEST_MODE=1`，并只监听 loopback。Web 本地样例 API 同时要求该开关、非生产 `NODE_ENV` 和 loopback 请求 URL；伪造 `Host` 头或在生产进程误设本地开关都不会启用 D1/内存演示控制面。Agent 管理写操作使用 D1 不可变 revision log；只有缺少 D1 绑定的纯 Node 合同测试才回退到进程内存。

## 本地生产依赖

需要启动 PostgreSQL RLS、Temporal、Redis、MinIO、Vault 和 OpenTelemetry
来联调生产服务时，先把 `.env.example` 复制为被 Git 忽略的 `.env`，替换
其中所有 `deviludo-local-only` 值，然后执行：

```bash
npm run infra:up
npm run infra:status
```

Compose 只把依赖端口绑定到 `127.0.0.1`。`infra:status` 不只检查端口：
它会使用 `DATABASE_URL` 验证 PostgreSQL 已应用到 migration `059`，使用
`REDIS_URL` 完成认证 PING，并检查 Temporal、MinIO、Vault 与 OTel Collector
的就绪端点。任何依赖缺失、密码不一致或数据库仍是旧 schema 都会返回
非零退出码。该集成栈与上面的无凭据测试站互相独立；测试页面仍使用
`npm run local:dev`。

## 常见问题

- `is already in use`：停止占用对应端口的旧进程，或为启动和检查命令选择相同的新端口。
- `Run npm install`：当前工作区缺少固定版本的 vinext 依赖，先执行 `npm install`。
- Smoke 等待超时：查看启动终端中的 vinext 错误，以及 `.wrangler/wrangler-local.log`。
- `WAITING_EXPORT_TEMPLATES`：运行 `npm run local:install-export-templates` 安装并校验当前固定版本后重新验证；仅由 Godot 编辑器放入可变 HOME 的模板不会被隔离 Runner 信任。
- `VERSION_MISMATCH`：本机 CLI 可以被发现，但不等于当前健康基线或任务锁定版本。在 `/admin/agents` 发现实际精确版本后，仍需按供应链流程批准、构建新 WorkerImage、灰度并让新任务锁定该版本；不要放宽门禁或启用 CLI 自更新。
- 页面通过但外部动作未执行：这是本地预览的预期行为；真实开发 Agent、Windows/Linux Runner、GitHub 和 Steam 工作流需要独立配置安全凭据与基础设施。
- `/api/runner/events` 在本地仅提供只读演示状态；任何 POST 都会以 `RUNNER_MTLS_INGRESS_REQUIRED` 拒绝。真实 Runner 必须接入独立 mTLS 服务，不能通过浏览器或伪造 Header 上报结果。
