# DeviLudo

DeviLudo 将游戏构想转化为经过 Linux、Windows、macOS 验证并可发布到 Steam 的制品。系统由无状态 Web、模块化 Core、PostgreSQL 工作流队列和三台平台 E2E 节点组成。

## 生产拓扑

应用计算固定为五台服务器，不允许自由命名服务器池：

| 服务器池 | 系统 | 运行内容 | 网络入口 |
| --- | --- | --- | --- |
| `WEB` | Linux | Next.js 网站与 BFF | 唯一公网入口 |
| `CORE` | Linux | `api`、`scheduler`、`sandbox` | 仅 WEB 和 E2E 私网访问 |
| `E2E_LINUX` | Linux | 测试、签名、干净回装 | 仅出站 mTLS |
| `E2E_WINDOWS` | Windows | 测试、签名、干净回装 | 仅出站 mTLS |
| `E2E_MACOS` | macOS | 测试、签名、干净回装 | 按需启动，仅出站 mTLS |

PostgreSQL、对象存储、Vault/KMS、OTel 和负载均衡属于托管基础设施，不计入服务器池。

```text
Internet → WEB → CORE → PostgreSQL / 对象存储 / Vault
                  ↑
E2E_LINUX ────────┤
E2E_WINDOWS ─mTLS─┤
E2E_MACOS ────────┘
```

WEB 和 E2E 不得连接数据库；E2E 节点不得安装 Agent。

## 生产部署

准备空 PostgreSQL 数据库、内部镜像仓库、私网 DNS/TLS、三个 E2E 客户端证书，以及各平台可信执行器。所有密码、令牌和证书由部署系统注入，不写入仓库。

### 1. 构建镜像

```bash
export DEVILUDO_IMAGE_REGISTRY=registry.example.com/deviludo
export DEVILUDO_RELEASE_ID=2026.07.29

docker build -f Dockerfile.web -t "$DEVILUDO_IMAGE_REGISTRY/web:$DEVILUDO_RELEASE_ID" .
docker build -f Dockerfile.core -t "$DEVILUDO_IMAGE_REGISTRY/core:$DEVILUDO_RELEASE_ID" .
docker push "$DEVILUDO_IMAGE_REGISTRY/web:$DEVILUDO_RELEASE_ID"
docker push "$DEVILUDO_IMAGE_REGISTRY/core:$DEVILUDO_RELEASE_ID"
```

三个 Core 角色必须使用同一个 `core` 镜像摘要。三台 E2E 服务器检出同一个 release，并执行 `npm ci --omit=dev`。

### 2. 初始化数据库

在迁移任务中通过 Secret 注入 `DATABASE_URL`，只对新的空数据库执行一次：

```bash
NODE_ENV=production npm run db:migrate
```

为 Core 三个进程分别创建数据库登录角色，并仅授予 `deviludo_api`、`deviludo_scheduler`、`deviludo_sandbox` 对应权限；应用角色不得拥有 `BYPASSRLS`。

### 3. 启动 CORE 服务器

创建三个权限独立的环境文件：

| 角色 | 必需配置 |
| --- | --- |
| `api` | `DEVILUDO_CORE_API_DATABASE_URL`、`DEVILUDO_WEB_CORE_TOKEN`、签名授权 Broker、`DEVILUDO_AGENT_SECRET_BROKER_URL`、`DEVILUDO_AGENT_SECRET_BROKER_TOKEN_FILE` |
| `scheduler` | `DEVILUDO_CORE_SCHEDULER_DATABASE_URL` |
| `sandbox` | `DEVILUDO_CORE_SANDBOX_DATABASE_URL`、`DEVILUDO_SANDBOX_EXECUTOR` |

三个文件均设置 `NODE_ENV=production`、`DEVILUDO_DATABASE_SET_ROLE=1` 和 `DEVILUDO_REQUIRED_READY_POOLS=WEB,CORE,E2E_LINUX,E2E_WINDOWS,E2E_MACOS`，并分别设置对应的 `DEVILUDO_CORE_ROLE`。

```bash
docker run -d --name deviludo-core-api --restart unless-stopped \
  --env-file /etc/deviludo/core-api.env -p 8080:8080 \
  registry.example.com/deviludo/core:2026.07.29

docker run -d --name deviludo-core-scheduler --restart unless-stopped \
  --env-file /etc/deviludo/core-scheduler.env \
  registry.example.com/deviludo/core:2026.07.29

docker run -d --name deviludo-core-sandbox --restart unless-stopped \
  --env-file /etc/deviludo/core-sandbox.env \
  registry.example.com/deviludo/core:2026.07.29
```

Core API 只发布到私网。E2E API 必须由 Core 侧终止 mTLS，并校验 `spiffe://deviludo/e2e-node/` 客户端身份。

### 4. 注册五台服务器

通过 Core 私网管理接口创建节点，再调用 `/v1/admin/server-nodes/{nodeId}/activate` 激活。创建参数固定如下：

| `poolKind` | `operatingSystem` | `capabilities` |
| --- | --- | --- |
| `WEB` | `linux` | `CUSTOMER_WEB, STREAMING_BFF` |
| `CORE` | `linux` | `BUSINESS_API, WORKFLOW_SCHEDULER, AGENT_GENERATION, ARTIFACT_BUILD, STEAM_PUBLISH` |
| `E2E_LINUX` | `linux` | `E2E_TEST, ARTIFACT_SIGN, STEAM_CLEAN_INSTALL` |
| `E2E_WINDOWS` | `windows` | `E2E_TEST, ARTIFACT_SIGN, STEAM_CLEAN_INSTALL` |
| `E2E_MACOS` | `macos` | `E2E_TEST, ARTIFACT_SIGN, STEAM_CLEAN_INSTALL` |

保存三个 E2E 节点返回的 UUID，分别作为对应服务器的 `DEVILUDO_E2E_NODE_ID`。macOS 无常驻容量时保持未激活，按容量意图启动并激活。

### 5. 启动 WEB 服务器

`/etc/deviludo/web.env` 只包含 `NODE_ENV=production`、`DEVILUDO_CORE_API_URL` 和至少 32 字节的 `DEVILUDO_WEB_CORE_TOKEN`：

```bash
docker run -d --name deviludo-web --restart unless-stopped \
  --env-file /etc/deviludo/web.env -p 3000:3000 \
  registry.example.com/deviludo/web:2026.07.29
```

负载均衡只向 WEB 转发公网流量；Core、数据库和 E2E 节点均不得暴露公网端口。

### 6. 启动三台 E2E 服务器

每台服务器通过系统服务管理器运行同一入口：Linux 使用 systemd，Windows 使用 Windows Service，macOS 使用 launchd。

```bash
NODE_ENV=production npm run e2e-node
```

每台服务器必须注入：

- `DEVILUDO_E2E_NODE_ID` 和平台匹配的 `DEVILUDO_E2E_POOL_KIND`。
- `DEVILUDO_CORE_API_URL=https://...`。
- `DEVILUDO_E2E_CLIENT_CERT_FILE`、`DEVILUDO_E2E_CLIENT_KEY_FILE`、`DEVILUDO_E2E_CORE_CA_FILE`。
- `DEVILUDO_E2E_ISOLATION_EXECUTOR`、`DEVILUDO_E2E_TEST_EXECUTOR`、`DEVILUDO_E2E_SIGN_EXECUTOR`、`DEVILUDO_E2E_CLEAN_INSTALL_EXECUTOR` 的绝对路径。

可信执行器必须保证单节点单工作区、签名前短期授权、执行前后重镜像和工作区清理。测试执行器不得读取签名凭据。

### 7. 上线检查

```bash
curl -fsS https://core.internal.example.com/health/live
curl -fsS https://core.internal.example.com/health/ready
curl -fsS https://deviludo.example.com/api/health/live
```

`/health/ready` 必须分别报告五类池；未常驻的 macOS 池可以是 `ON_DEMAND_READY`。

## 工作区与安全边界

- 工作区是项目、对话、任务和制品的隔离边界，不是登录账号；当前本地实例采用单操作者模式。
- 未选择工作区时，创建项目会自动建立同名工作区；对话新建项目时由全局 Agent 配置生成名称。
- Agent 连接配置属于整个 Deviludo 实例，由所有工作区共享；API Key 只保存在 Core 的 Secret 边界。
- 所有工作区业务表强制 RLS；跨表关系同时包含 `workspace_id`，缺少工作区上下文时拒绝访问。
- Core 三角色使用独立数据库登录、服务身份和 Vault 策略。
- 对象键、Vault 路径、日志和工作区均绑定 `workspaceId/projectId`。
- Agent 仅在 CORE 的任务级 microVM 或受限容器中执行。
- E2E 作业使用租约、心跳、fencing token 和不可变幂等键；跨工作区前必须清理或重镜像。

## 本地开发

需要 Node.js 22 和 Docker：

```bash
npm ci
npm run local:up
```

本地最小栈包含 Web、Core 三角色、PostgreSQL 和宿主机 macOS E2E 节点：

- Web：<http://127.0.0.1:3100>
- Core：<http://127.0.0.1:8080>

如需改用其他端口，设置 `DEVILUDO_WEB_HOST_PORT`；本地启动脚本不会占用 `3000`。
启动时会检测宿主机上的 Claude Code 与 Codex CLI，并在设置页显示安装状态和版本。

```bash
npm run local:down   # 停止
npm run local:reset  # 停止并清空本地数据
```
