# DeviLudo

DeviLudo 是从游戏构想、规格确认、Agent 生成、制品构建到跨平台测试和 Steam 交付的一体化游戏开发服务。打开本地 Web 后可以创建真实租户项目、修订规格、批准工作流并观察执行进度；服务器池仅作为后台运行状态。

DeviLudo 采用固定五类应用计算池：

- `WEB`：无状态 Next.js 对客网站与流式 BFF。
- `CORE`：同一镜像按 `api`、`scheduler`、`sandbox` 三种角色运行。
- `E2E_LINUX`、`E2E_WINDOWS`、`E2E_MACOS`：平台匹配的测试、签名与干净回装节点。

PostgreSQL 是业务状态与作业队列的唯一事实源。跨租户领取函数只返回作业标识、租户标识和租约标识；执行者随后在事务中设置租户上下文，才能读取作业正文。租约、心跳、fencing token、重试退避、不可变幂等键和外部操作回执都在新的 `001` 基线中定义。

## 本地最小部署

本机部署启动 Web、Core 三角色与 PostgreSQL；macOS E2E 节点作为宿主机守护进程一起启动：

```bash
npm install
npm run local:reset
npm run local:up
npm run local:test
```

服务入口：

- Web：<http://127.0.0.1:3000>
- Core：<http://127.0.0.1:8080>
- PostgreSQL：仅 Core 数据网络可见，不发布宿主机端口

`local:test` 会创建真实 DeviLudo 项目并批准规格，验证 Agent 生成、制品构建和 macOS E2E 的产品链路，同时检查 Web BFF、五池投影、独占领取、租户隔离以及执行前重镜像、工作区清理、执行后重镜像三份证明。`local:down` 与 `local:reset` 会同时停止宿主机 E2E 节点。

## 常用检查

```bash
npm run typecheck
npm run test
npm run build
npm run verify:architecture
```
