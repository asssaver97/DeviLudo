# 本地测试站与真实 Godot 验证

DeviLudo 的前端、预览 API、Godot 验证侧车和 Agent 就绪探针可以作为仅本机可访问的测试栈运行。启动脚本固定绑定 `127.0.0.1`，不会监听局域网接口，也不需要 GitHub、Steam、Claude 或 Codex 的真实凭据。

## 准备

- Node.js `22.13.0` 或更高版本
- 在仓库根目录执行过 `npm install`
- Godot 4（macOS 默认寻找 `/Applications/Godot.app/Contents/MacOS/Godot`，也可通过 `DEVILUDO_GODOT_BINARY` 指定）

不要把 API Key、GitHub 私钥或 Steam 密码写入命令、脚本或 `.env`。仓库根目录的 `.env.example` 只包含本地默认值、公开 ID 和 Vault 引用示例；测试站的演示操作会停在外部服务门禁处。

## 启动

在第一个终端执行：

```bash
npm run local:dev
```

测试站地址为 <http://127.0.0.1:3000>，Godot 验证侧车为 `http://127.0.0.1:4311`，Agent 就绪探针为 `http://127.0.0.1:4312`。同一命令会检查三个端口并同时启动三个进程。按一次 `Ctrl-C` 会向完整子进程树发送优雅停止信号；五秒后仍未退出会自动强制清理，再按一次 `Ctrl-C` 可立即强制停止。

Agent 探针只运行固定的版本命令，不启动 Claude Code/Codex 编码任务。只有精确 CLI 版本匹配、工作负载上报的 `DEVILUDO_WORKER_IMAGE_DIGEST` 等于批准的 `DEVILUDO_LOCAL_EXPECTED_WORKER_IMAGE_DIGEST`、无凭据的 HTTPS Inference Gateway 已配置、锁定 Provider/凭据/模型通过受信探针且 `DEVILUDO_LOCAL_AGENT_EXECUTION=1` 全部满足时，开发 Worker 才会报告 `READY`。默认配置没有受信 Provider 绑定探针，会安全地报告 `BLOCKED`；这不是测试栈故障。

`/admin/agents` 的管理按钮调用本地 `/api/admin/**`，携带当前模拟角色和幂等键。版本阻止、灰度/回滚、平台默认与 Provider 草稿会写入本地控制面状态和审计。版本批准仍要求供应链证据；Provider 激活仍要求受信 Connector 的完整探针。默认测试栈不会伪造这两类结果，因此相关操作会以明确错误失败关闭。

在项目页批准规格后，点击“运行真实本机验证”。侧车会：

1. 将固定 Godot 样例复制到 `.deviludo/local-runtime/<project>/<run>/workspace`；
2. 初始化隔离的真实 Git 仓库并提交锁定规格；
3. 执行 Godot import、生产场景 headless 启动和 TestKit 核心循环/保存读取/性能检查；
4. 尝试 macOS 导出，并生成 `manifest.json`、`junit.xml` 和 `godot.log`。

证据包含完整 Git SHA、source digest、bundle digest、精确 Godot 版本和逐项检查结果。`.deviludo/` 已被 Git 忽略。

如果本机未安装对应 Godot export templates，测试会如实记录为 `TESTS_PASSED + WAITING_EXPORT_TEMPLATES`，不能授权生产发布。Windows/Linux 也只有真实 Runner 注册并返回有效 evidence 后才会通过。

## Smoke check

保持测试站运行，在第二个终端执行：

```bash
npm run local:smoke
```

检查器最多等待 30 秒让站点就绪，然后验证：

- `/` 返回 DeviLudo HTML 工作台；
- `/admin/agents` 返回 Agent 管理台；
- `/api/admin/agents` 返回服务端默认 Agent、精确版本和部署状态，且不暴露 SecretRef；
- `/api/health` 返回 `status: "ok"` 且服务标识正确。
- 侧车 `/health` 返回 `deviludo-local-runtime` 和实际 Godot 版本。
- Agent 探针 `/health` 返回两个 CLI 的实际版本及 `READY`、`VERSION_MISMATCH` 或 `UNAVAILABLE`；`degraded` 是未启用执行时的预期状态。
- Agent 探针 `/v1/preflight` 使用固定测试运行锁，验证 CLI、镜像、Provider/Gateway 与执行开关；它只返回阻塞原因或 `READY`，不会启动 Agent。

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

Godot 侧车端口默认是 `4311`，Agent 探针端口默认是 `4312`。如需修改，启动与 smoke 命令应同时设置 `DEVILUDO_LOCAL_RUNTIME_PORT` / `DEVILUDO_LOCAL_AGENT_RUNTIME_PORT`。

## 常见问题

- `is already in use`：停止占用对应端口的旧进程，或为启动和检查命令选择相同的新端口。
- `Run npm install`：当前工作区缺少固定版本的 vinext 依赖，先执行 `npm install`。
- Smoke 等待超时：查看启动终端中的 vinext 错误，以及 `.wrangler/wrangler-local.log`。
- `WAITING_EXPORT_TEMPLATES`：在 Godot 编辑器中安装与当前版本完全匹配的 export templates 后重新验证。
- `VERSION_MISMATCH`：本机 CLI 可以被发现，但不等于任务锁定的批准版本；通过新的固定版本 WorkerImage 更新，不要放宽门禁或启用 CLI 自更新。
- 页面通过但外部动作未执行：这是本地预览的预期行为；真实开发 Agent、Windows/Linux Runner、GitHub 和 Steam 工作流需要独立配置安全凭据与基础设施。
