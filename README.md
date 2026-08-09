# DeviLudo

DeviLudo 将游戏需求推进为可构建、跨平台验证并发布到 Steam 的 Godot 制品。应用计算固定为五类服务器：

| 服务器 | 系统 | 职责 |
| --- | --- | --- |
| `WEB` | Ubuntu 24.04 | Next.js 网站与流式 BFF，唯一公网入口 |
| `CORE` | Ubuntu 24.04 x86_64 | API、调度器、受限 Agent/构建/发布任务 |
| `E2E_LINUX` | Ubuntu 24.04 x86_64 | 一次性 KVM 客体中的 Linux 验证 |
| `E2E_WINDOWS` | Windows 11 Pro x86_64 | 一次性 Hyper-V 客体中的 Windows 验证 |
| `E2E_MACOS` | macOS 15+ Apple Silicon | 一次性 Tart 客体中的 macOS 验证 |

PostgreSQL、S3、Vault/KMS、OTel 和负载均衡使用外部托管服务，不属于服务器池。公网只进入 WEB；WEB 只访问 CORE；E2E 只通过出站 mTLS 访问 CORE；WEB 和 E2E 均不能连接数据库。

## 生产部署

发布流水线 [release.yml](.github/workflows/release.yml) 构建 GHCR 镜像与服务器 bundle，生成带摘要的 `release-manifest.json`，并通过 GitHub OIDC/Cosign 签名。服务器只下载和验证 release，不现场编译 executor。

在每台目标服务器本地执行对应脚本：

```text
deploy/web/deploy.sh
deploy/core/deploy.sh
deploy/e2e-linux/deploy.sh
deploy/e2e-windows/deploy.ps1
deploy/e2e-macos/deploy.sh
```

先复制对应的 `deploy.env.example`（Windows 为 `deploy.json.example`）并填写外部 PostgreSQL、S3、Vault/KMS、OTel、TLS、黄金 VM 和网络配置。WEB/CORE 还要求填写固定的 Docker、containerd、Buildx、Compose 包版本；私有 Release/GHCR 凭据只从权限受限文件读取。

Bash 服务器的统一命令：

```bash
sudo ./deploy/<role>/deploy.sh preflight
sudo ./deploy/<role>/deploy.sh bootstrap
sudo ./deploy/<role>/deploy.sh deploy
sudo ./deploy/<role>/deploy.sh status
sudo ./deploy/<role>/deploy.sh rollback
```

Windows 使用相同动作：

```powershell
.\deploy\e2e-windows\deploy.ps1 -Action preflight
.\deploy\e2e-windows\deploy.ps1 -Action bootstrap
.\deploy\e2e-windows\deploy.ps1 -Action deploy
```

部署配置默认位于 `/etc/deviludo/deploy.env`，Windows 位于 `C:\ProgramData\Deviludo\deploy.json`。数据库 URL、GHCR、Vault、TLS、签名和 Steam 凭据必须通过权限受限的文件提供，不接受命令行明文。Core 必须显式选择 `DEVILUDO_ACCESS_MODE=standalone|platform`；生产环境缺失该配置时拒绝启动。首次部署从 persistent-source `001` 完整快照创建数据库；后续由 `infra/postgres/migrations/` 中带校验和的迁移顺序升级，并通过 PostgreSQL advisory lock 防止多副本并发迁移。只有 compatibility 不匹配的旧架构才要求重建。

`standalone` 不存在账号或登录，任何能访问 Web 的人都具有产品与实例管理权限。`platform` 不保存用户、会话或成员关系，而是通过 `DEVILUDO_PLATFORM_ACCOUNT_API_URL` 对每个浏览器会话进行内部断言；写操作强制刷新，Platform 不可用或成员关系失效时失败关闭。

每次安装位于独立 release 目录，`current` 原子切换。`rollback` 仅允许切回 schema 兼容的已验证 release。

## 受限执行

`core-sandbox` 是常驻任务领取器，`DEVILUDO_SANDBOX_EXECUTOR` 固定指向镜像内 client。client 只通过 Unix Socket 调用宿主 `sandbox-executord`；仅 daemon 可访问 Docker/containerd。

生产 Agent 使用经签名 release manifest 固定并校验 SHA-256 的 Kata runtime，以 `io.containerd.kata.v2` 启动 microVM；本地开发才显式降级为受限容器。构建/发布任务容器同样使用签名镜像摘要、固定入口、非 root、只读根文件系统、`CapDrop=ALL`、资源/超时上限和独立工作区。Provider 凭据由 daemon 从 Vault 读取并注入 tmpfs；任务容器不获得 Docker Socket、Vault 或 S3 凭据。Core 只接受 `deviludo.executor-receipt.v2` 的非模拟、签名回执。

工作流 profile：

- `VALIDATE`：Agent → 图片素材就绪门禁 → Godot 构建 → 指定平台 E2E。
- `RELEASE`：Agent → 图片素材就绪门禁 → 构建 → 三平台 E2E → 三平台签名 → 人工批准 → Steam 发布 → 三平台干净回装。

Agent 的 `assetManifest` 会在同一次交付中创建图片任务。配置了图片 Provider 时，流程停在 `ASSET_GENERATING`，直到所有计划素材已生成或由用户上传；用户也可明确关闭自动生成，以占位素材继续。就绪素材以内容寻址对象固化到构建任务，并在 Godot 导入前写入 `res://assets/generated/{assetKey}.{png|jpg|webp}`，同时生成带摘要的 `manifest.json`，因此图片实际进入同一组三平台制品，而不只是显示在素材面板。签名完成后流程停在 `RELEASE_APPROVAL_PENDING`，只有工作区 Owner/Admin 的批准接口才能创建 Steam 上传任务。

项目源码不再作为 `SOURCE` 对象制品传递。每个项目的源码 revision 持久保存在 `DEVILUDO_PROJECTS_ROOT/workspaces/{workspaceId}/projects/{projectId}/revisions/`；Agent、构建和重试从指定 revision 创建隔离副本，Agent 成功输出经校验后以同文件系统 staging 和原子 rename 发布。构建、E2E、签名和下载制品仍使用 S3/MinIO。

### 功能验收测试体系

发布 tag 还会在 GitHub 托管的 Ubuntu、Windows 和 macOS 原生 runner 上分别安装固定 Godot 4.5.1，运行 `npm run test:e2e:platform` 并上传逐平台验收报告；任意平台缺席或失败都会阻止 release job 构建发布包。

Agent 生成源码时同时输出 `testManifest`（协议 `deviludo.test-manifest.v1`），声明每个核心功能及其验证方法。E2E 阶段不再盲跑 120 秒，而是：

1. 读取 `agent.json` 中的 `testManifest`
2. 根据 `verificationMethod` 执行对应测试类型
3. 解析 `DEVILUDO_E2E_RESULT` 结构化输出
4. 验证所有声明的 `checkNames` 都被执行
5. 报告具体失败的功能点（而非盲目的退出码）

支持四种验证方法：

#### Unit 测试（verificationMethod: "unit"）

最常用的测试类型，通过 GDScript 断言验证游戏逻辑。

测试脚本要求：
- 继承 `SceneTree`，在 `_initialize()` 执行所有测试
- 用 `check(condition: bool, name: String)` 记录每个断言
- 断言名称必须 kebab-case 且匹配 `testManifest.features[].checkNames`
- 输出 `DEVILUDO_E2E_RESULT:{"suite":"...","checks":[],"failures":[],"duration_ms":...}`
- 用 `quit(0 if failures.is_empty() else 1)` 退出

参考实现：`fixtures/godot-smoke/tests/e2e.gd`

#### Interactive 测试（verificationMethod: "interactive"）

模拟键盘和鼠标输入，验证 UI 交互和玩家控制。

特性需要声明 `interactionScript`：

```json
{
  "id": "menu-navigation",
  "verificationMethod": "interactive",
  "interactionScript": {
    "version": "1",
    "events": [
      { "type": "key_press", "key": "KEY_DOWN", "delay_ms": 200 },
      { "type": "key_release", "key": "KEY_DOWN", "delay_ms": 200 },
      { "type": "mouse_move", "x": 100, "y": 200, "delay_ms": 100 },
      { "type": "mouse_click", "button": "LEFT" },
      { "type": "wait", "delay_ms": 1000 }
    ]
  }
}
```

E2E executor 会设置 `DEVILUDO_INTERACTION_SCRIPT` 环境变量并运行 `fixtures/godot-e2e-helpers/interactive_runner.gd`，该脚本会解析事件序列并通过 `Input.parse_input_event()` 注入输入。

#### Visual 测试（verificationMethod: "visual"）

捕获游戏截图并与参考图像对比，验证 UI 渲染。

特性需要声明 `expectedVisual`：

```json
{
  "id": "main-menu-visual",
  "verificationMethod": "visual",
  "expectedVisual": {
    "version": "1",
    "referenceImage": "screenshots/main_menu.png",
    "threshold": 0.02,
    "captureDelay": 1500
  }
}
```

E2E executor 会：
1. 设置 `DEVILUDO_VISUAL_SPEC` 和 `DEVILUDO_SCREENSHOT_OUTPUT` 环境变量
2. 运行 `fixtures/godot-e2e-helpers/visual_runner.gd` 捕获当前帧
3. 与参考图像进行像素对比（threshold 为允许差异百分比，0-1）

参考图像应保存在项目的 `screenshots/` 目录，首次生成时由 Agent 创建基线。

#### Manual 测试（verificationMethod: "manual"）

需要人工验收的功能（如叙事体验、美术风格、音乐氛围），标记为 `manual` 后不会在自动化 E2E 中执行，但会在 UI 中显示为待确认项。

---

完整示例见 `fixtures/godot-smoke/agent.json`。

E2E 失败时，Agent 修复任务会收到 `testDetails.failures` 列表，精确知道哪些功能点坏了。

工作流成功后，Core 写入可重放的 `project.source.ready` outbox。托管部署中的 DeviLudo Platform 使用服务认证拉取事件和确定性源码归档，再独立完成 GitHub 同步；Core 不保存 GitHub token、仓库连接或同步任务，主工作流也不依赖远端同步结果。

## 本地 macOS

首次显式安装依赖：

```bash
npm ci
npm run local:bootstrap
```

启动最小真实链路（Web + Core 三角色 + executord + PostgreSQL + MinIO + Vault + OTel + 原生 macOS E2E）：

```bash
npm run local:up
```

Web 地址为 <http://127.0.0.1:3100>，不会占用 `3000`。本地默认使用 `standalone`，首次访问直接进入项目界面，无账号、密码或 OAuth 配置。源码默认存放在 Compose 的持久 `projects-data` volume；也可在 `.env` 中设置 `DEVILUDO_PROJECTS_ROOT`。设置全局 Claude Code 或 Codex CLI Provider 后，本地默认执行 `VALIDATE + macos`；本地 E2E 回执明确标记为开发原生隔离，不等同于生产 Tart 隔离。

```bash
npm run local:status
npm run local:logs
npm run local:down
npm run local:reset   # 同时清空本地数据
```

从任何旧源码制品或账号基线切换时，普通启动会拒绝原地迁移。确认不再需要本地 PostgreSQL、MinIO 制品、项目源码目录和 Core Vault 数据后，执行一次：

```bash
npm run local:reset:source-v1
```

该命令会完整重建本地 Compose volumes 并继续启动，不调用任何远端删除接口。后续恢复使用 `npm run local:up`。生产环境使用 `npm run db:reset:source-v1 -- --confirm=RESET_DEVILUDO_SOURCE_V1`，并必须提供精确且非宽泛的 `DEVILUDO_PROJECTS_ROOT`。

`local:up` 只做检查、构建和启动，不会静默安装宿主依赖。`npm run local:executor:test` 使用固定 Fixture Agent 验证 executor、图片素材注入、Godot、MinIO 和原生 macOS E2E，不访问 Provider；`npm run local:database:test` 验证真实 PostgreSQL RLS、并发领取、fencing、图片门禁/快照、发布审批和租约回收。设置真实 Provider 后可显式运行 `npm run local:test` 完成付费链路冒烟。

首次构建镜像可能需要数分钟；`local:up` 会输出 `building_images` 阶段和 BuildKit 实时进度。看到基础设施仍在运行、应用容器暂时停止，表示脚本正在用新镜像替换服务，并非流程卡死。

## 备份与恢复

Core 镜像内置 PostgreSQL client。备份同时覆盖数据库、`DEVILUDO_PROJECTS_ROOT` 和 `DEVILUDO_ARTIFACT_BUCKET`，并记录数据库迁移、每个源码文件和对象的 SHA-256。备份期间数据库表处于只读屏障，结束后以原子 rename 发布目录：

```bash
npm run state:backup -- --output=/srv/backups/deviludo-2026-08-09
```

生产环境必须通过 `DEVILUDO_MIGRATION_DATABASE_URL_FILE` 提供数据库凭据，同时配置 `DEVILUDO_PROJECTS_ROOT`、S3 endpoint/region/credentials 和 `DEVILUDO_ARTIFACT_BUCKET`。恢复只接受空数据库、尚不存在的项目源码根目录和空对象桶，并在写入前验证整个备份：

```bash
npm run state:restore -- \
  --input=/srv/backups/deviludo-2026-08-09 \
  --confirm=RESTORE_DEVILUDO_BACKUP
```

Vault/KMS 中的 Provider、签名和 Steam 密钥应使用托管 Vault 自身的快照/灾备机制恢复，不会被应用级备份导出为明文。

## 数据与访问边界

工作区同时是项目组织容器和强制 RLS 隔离边界。Core 仅保存外部 `workspace_id` 与不可解释的 `actor_account_id`，不复制账号资料、会话、组织成员关系或 OAuth 数据。Platform 模式下，组织角色和平台管理员角色来自实时断言；standalone 使用固定本地工作区和匿名 actor。

项目、对话、任务、对象制品和源码 revision 均绑定 `workspaceId/projectId`。对象键固定为 `workspaces/{workspaceId}/projects/{projectId}/...`，源码目录固定为同结构下的项目目录；所有真实路径、归档条目、符号链接、设备文件和敏感凭据文件均在发布前校验。

删除项目会先拒绝仍有活动交付的项目，随后删除 Core 数据库记录、S3/MinIO 对象制品以及该项目的精确源码目录。Core 不接触远端 GitHub 仓库或分支；仓库绑定、导入、创建与同步均由外层 DeviLudo Platform 负责。

每个项目都有带修订历史的协作说明文档，固定维护游戏介绍、玩法、分类和主要特性。用户操作会重新计算空闲时间；项目无活动且没有运行中任务时，Scheduler 才会提交一次受限 Agent 文档维护任务。默认空闲阈值为 24 小时，可通过 `DEVILUDO_PROJECT_DOCUMENT_IDLE_SECONDS` 调整。
