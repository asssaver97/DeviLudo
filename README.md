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

部署配置默认位于 `/etc/deviludo/deploy.env`，Windows 位于 `C:\ProgramData\Deviludo\deploy.json`。数据库 URL、GHCR、Vault、TLS、签名和 Steam 凭据必须通过权限受限的文件提供，不接受命令行明文。首次 CORE 部署只接受空数据库并应用 `001` 基线，不创建默认账号；管理员在首次打开网站时自行设置。

每次安装位于独立 release 目录，`current` 原子切换。`rollback` 仅允许切回 schema 兼容的已验证 release。

## 受限执行

`core-sandbox` 是常驻任务领取器，`DEVILUDO_SANDBOX_EXECUTOR` 固定指向镜像内 client。client 只通过 Unix Socket 调用宿主 `sandbox-executord`；仅 daemon 可访问 Docker/containerd。

生产 Agent 使用经签名 release manifest 固定并校验 SHA-256 的 Kata runtime，以 `io.containerd.kata.v2` 启动 microVM；本地开发才显式降级为受限容器。构建/发布任务容器同样使用签名镜像摘要、固定入口、非 root、只读根文件系统、`CapDrop=ALL`、资源/超时上限和独立工作区。Provider 凭据由 daemon 从 Vault 读取并注入 tmpfs；任务容器不获得 Docker Socket、Vault 或 S3 凭据。Core 只接受 `deviludo.executor-receipt.v2` 的非模拟、签名回执。

工作流 profile：

- `VALIDATE`：Agent → Godot 构建 → 指定平台 E2E。
- `RELEASE`：Agent → 构建 → 三平台 E2E → 三平台签名 → Steam 发布 → 三平台干净回装。

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

Web 地址为 <http://127.0.0.1:3100>，不会占用 `3000`。首次打开会要求设置管理员用户名和强密码，系统没有默认账号。设置全局 Claude Code 或 Codex CLI Provider 后，本地默认执行 `VALIDATE + macos`；本地 E2E 回执明确标记为开发原生隔离，不等同于生产 Tart 隔离。

```bash
npm run local:status
npm run local:logs
npm run local:down
npm run local:reset   # 同时清空本地数据
```

`local:up` 只做检查、构建和启动，不会静默安装宿主依赖。`npm run local:executor:test` 使用固定 Fixture Agent 验证 executor、Godot、MinIO 和原生 macOS E2E，不访问 Provider；`npm run local:database:test` 验证真实 PostgreSQL RLS、并发领取、fencing 和租约回收。设置真实 Provider 后可显式运行 `npm run local:test` 完成付费链路冒烟。

## 数据与账号

工作区同时是项目组织容器和强制 RLS 隔离边界。账号可加入多个工作区，角色为 `OWNER`、`ADMIN`、`MEMBER`；实例管理员另行管理全局 Agent 配置和服务器节点。邀请链接 24 小时有效且只能使用一次，不依赖 SMTP。

项目、对话、任务、制品和对象键均绑定 `workspaceId/projectId`。对象键固定为 `workspaces/{workspaceId}/projects/{projectId}/...`；缺少工作区上下文或跨工作区访问时失败关闭。

可从公开 GitHub/GitLab HTTPS 仓库、本地文件夹或 ZIP 导入现有项目。Core 会过滤缓存、构建目录和凭据文件，保存不可变源码快照，再由全局 Agent 解析代码与玩法、生成项目说明和初始会话；后续对话和交付任务都在该源码基础上继续开发。

每个项目都有带修订历史的协作说明文档，固定维护游戏介绍、玩法、分类和主要特性。用户操作会重新计算空闲时间；项目无活动且没有运行中任务时，Scheduler 才会提交一次受限 Agent 文档维护任务。默认空闲阈值为 24 小时，可通过 `DEVILUDO_PROJECT_DOCUMENT_IDLE_SECONDS` 调整。
