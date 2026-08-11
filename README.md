# DeviLudo

[English](README.en.md) | 简体中文

DeviLudo 是面向 Godot 的 AI 游戏交付平台。它把游戏需求和对话转化为可持续迭代的项目源码、图片素材与可验证制品，并在人工批准后发布到 Steam。

> 项目当前处于 MVP 阶段。完整本地链路面向 macOS；生产部署需要独立基础设施和五类服务器池。

## 能做什么

- 使用 Claude Code 或 Codex CLI Agent 生成、修改并修复 Godot 项目。
- 直接关联已有的本地 Godot 项目目录，或把 GitHub 仓库克隆到指定位置后关联；Agent 成功修改会原地写回工作目录。
- 本地 Git 和 GitHub 项目关联后可在项目页新建并切换分支；GitHub 私有仓库复用宿主机 Git 凭证。
- 按 revision 持久保存源码，支持对话式迭代、失败修复与阶段重跑。
- 根据 Agent 的素材清单自动生成图片，也支持用户上传或使用占位素材。
- 构建 Godot 制品，并按功能清单执行单元、交互、视觉和人工验收测试。
- 在 Linux、Windows 和 macOS 上完成隔离 E2E 验证。
- 对发布制品进行签名，经人工批准后上传 Steam，并验证干净回装。
- 提供 standalone 单机模式，以及接入外部账号系统的 platform 模式。
- 内置 PostgreSQL/S3/源码备份恢复、可观测性和受限任务执行。

## 交付流程

| 模式 | 流程 |
| --- | --- |
| `VALIDATE` | Agent 生成 → 图片素材就绪 → Godot 构建 → 指定平台 E2E |
| `RELEASE` | Agent 生成 → 图片素材就绪 → 构建 → 三平台 E2E → 签名 → 人工批准 → Steam 发布 → 干净回装 |

Agent 生成源码时会同时提交 `assetManifest` 和 `testManifest`。图片会在构建前写入 Godot 项目，测试结果会精确关联到声明的功能点，而不是只返回一个退出码。

## 本地快速启动

本地完整链路目前支持 macOS，使用 Node.js 22、Docker/Colima 和 Godot。

```bash
git clone <repository-url>
cd DeviLudo
npm ci
npm run local:bootstrap
npm run local:up
```

打开 <http://127.0.0.1:3100>。本地默认使用 `standalone`，无需账号；进入设置页配置 Claude Code 或 Codex CLI Provider。图片生成 Provider 为可选配置。

关联本地项目不会上传或复制项目：选择项目根目录后，DeviLudo 会立即以目录名创建项目，源码读取和 Agent 分析在后台异步完成；分析期间项目卡片置灰并显示进度。DeviLudo 只记录受限的目录绑定，每次 Agent 运行前从原目录读取最新源码，并在目录未被并发修改时安全原地写回。关联 GitHub 项目时，DeviLudo 调用宿主机的 `git` 克隆到你选择的位置，再以仓库名关联该工作目录；不经过浏览器上传，因此没有 64 MiB 项目导入上限。Git credential helper 或 SSH agent 只由宿主机 `git` 使用，凭证不会挂载到容器或保存到 DeviLudo。

常用命令：

```bash
npm run local:status   # 查看服务状态
npm run local:logs     # 查看日志
npm run local:down     # 停止服务并保留数据
npm run local:reset    # 停止服务并清空本地数据
```

首次构建镜像可能需要数分钟；后续 `local:up` 会复用镜像、数据库迁移、初始化状态和 macOS E2E 进程。

Agent 默认单任务运行以适配约 8 GiB 的 Docker 环境。资源充足时可在启动前设置 `DEVILUDO_SANDBOX_CONCURRENCY=2` 并行处理两个 Core 任务；这会提高内存占用和 Provider 调用量，允许值仅为 `1` 或 `2`。

## 生产部署

生产环境由五类服务器池组成：

| 服务器池 | 推荐系统 | 职责 |
| --- | --- | --- |
| `WEB` | Ubuntu 24.04 | Next.js 网站、BFF、唯一公网入口 |
| `CORE` | Ubuntu 24.04 x86_64 | API、调度、Agent、构建与发布任务 |
| `E2E_LINUX` | Ubuntu 24.04 x86_64 | KVM 隔离的 Linux 验证 |
| `E2E_WINDOWS` | Windows 11 Pro x86_64 | Hyper-V 隔离的 Windows 验证 |
| `E2E_MACOS` | macOS 15+ Apple Silicon | Tart 隔离的 macOS 验证 |

还需要外部 PostgreSQL、S3、Vault/KMS、OpenTelemetry 和负载均衡。公网流量只能进入 WEB；E2E 节点仅通过出站 mTLS 访问 CORE。

推送 `v*` tag 后，[release workflow](.github/workflows/release.yml) 会运行三平台验收，构建并签名 GHCR 镜像和服务器 bundle。然后在目标服务器上：

1. 复制并填写对应配置：
   - [WEB](deploy/web/deploy.env.example)
   - [CORE](deploy/core/deploy.env.example)
   - [Linux E2E](deploy/e2e-linux/deploy.env.example)
   - [Windows E2E](deploy/e2e-windows/deploy.json.example)
   - [macOS E2E](deploy/e2e-macos/deploy.env.example)
2. 将数据库、S3、Vault、TLS、签名、Steam 和黄金 VM 凭据写入配置指定的权限受限文件。
3. 在每台目标服务器执行部署脚本。

Bash 服务器：

```bash
sudo ./deploy/<role>/deploy.sh preflight
sudo ./deploy/<role>/deploy.sh bootstrap
sudo ./deploy/<role>/deploy.sh deploy
sudo ./deploy/<role>/deploy.sh status
```

Windows：

```powershell
.\deploy\e2e-windows\deploy.ps1 -Action preflight
.\deploy\e2e-windows\deploy.ps1 -Action bootstrap
.\deploy\e2e-windows\deploy.ps1 -Action deploy
```

部署使用带摘要和 Cosign 签名的 release，不在服务器现场编译。Bash 部署还支持 `rollback`，但只允许回滚到数据库 schema 兼容的已验证版本。

## 开发与验证

```bash
npm run check                 # lint、类型检查、单元测试、架构检查、生产构建
npm run local:executor:test   # Agent fixture、图片注入、Godot、MinIO、macOS E2E
npm run local:database:test   # PostgreSQL RLS、并发领取、fencing、恢复和工作流门禁
npm run local:permissions:test
```

真实 Provider 冒烟测试可能产生费用，需要显式运行 `npm run local:test`。

## 安全说明

- `standalone` 没有登录系统，任何能访问 Web 的人都拥有实例管理权限；不要暴露到不可信网络。
- `platform` 模式通过外部账号 API 实时断言会话和成员关系，Core 不保存账号、密码或 OAuth 数据。
- 生产 Agent 在 Kata microVM 中运行；构建与发布容器使用非 root、只读文件系统、资源限制和固定镜像摘要。
- Provider、Steam、数据库和签名凭据不应写入仓库或命令行，生产环境只从 Vault 或权限受限文件读取。

## 更多资料

- [架构说明](docs/architecture.md)
- [CI](.github/workflows/ci.yml)
- [发布流程](.github/workflows/release.yml)

欢迎通过 Issue 提交问题或建议，通过 Pull Request 参与开发。提交前请运行 `npm run check`。
