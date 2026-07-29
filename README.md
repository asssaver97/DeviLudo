# DeviLudo

DeviLudo 将游戏构想转化为经过跨平台验证并可发布到 Steam 的制品。系统采用 Next.js Web、模块化 Core、PostgreSQL 工作流队列和平台 E2E 节点。

## 架构

应用计算固定为五类服务器池：

| 池 | 职责 |
| --- | --- |
| `WEB` | 对客网站、会话转发与 BFF |
| `CORE` | API、调度、Agent、构建与发布编排 |
| `E2E_LINUX` | Linux 测试、签名与干净回装 |
| `E2E_WINDOWS` | Windows 测试、签名与干净回装 |
| `E2E_MACOS` | macOS 测试、签名与干净回装 |

Core 的 `api`、`scheduler`、`sandbox` 使用同一镜像和独立权限运行。PostgreSQL 是业务状态与作业队列的唯一事实源；所有租户数据通过强制 RLS、复合租户外键和事务级租户上下文隔离。

## 本地启动

需要 Node.js 22 和 Docker：

```bash
npm ci
npm run local:up
```

该命令启动 Web、Core 三角色、PostgreSQL，并在宿主机启动 macOS E2E 节点。

- Web：<http://127.0.0.1:3000>
- Core：<http://127.0.0.1:8080>

验证最小链路：

```bash
npm run local:test
```

停止服务或同时清空本地数据：

```bash
npm run local:down
npm run local:reset
```

## 测试

```bash
npm run lint
npm test
npm run build
```

全栈浏览器测试首次运行前安装浏览器：

```bash
npm run test:e2e:install
npm run test:e2e
```

`test:e2e` 使用独立 Compose 项目、动态端口和临时数据库卷，不影响本地开发数据。

## 安全边界

- 公网只进入 Web；Web 和 E2E 节点不能直连数据库。
- E2E 节点通过出站认证领取作业，同一时刻只服务一个租户。
- Agent 只在 Core 隔离沙箱执行，E2E 节点不安装 Agent。
- 签名任务必须平台匹配、独占节点，并完成执行前后重镜像与工作区清理。
