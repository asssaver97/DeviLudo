# 本地测试站

DeviLudo 的前端与预览 API 可以作为仅本机可访问的 vinext 测试站运行。启动脚本固定绑定 `127.0.0.1`，不会监听局域网接口，也不需要 GitHub、Steam、Claude 或 Codex 的真实凭据。

## 准备

- Node.js `22.13.0` 或更高版本
- 在仓库根目录执行过 `npm install`

不要把 API Key、GitHub 私钥或 Steam 密码写入命令、脚本或 `.env`。仓库根目录的 `.env.example` 只包含本地默认值、公开 ID 和 Vault 引用示例；测试站的演示操作会停在外部服务门禁处。

## 启动

在第一个终端执行：

```bash
npm run local:dev
```

测试站地址为 <http://127.0.0.1:3000>。脚本会先检查端口是否可用，再启动 vinext。按一次 `Ctrl-C` 会向完整子进程树发送优雅停止信号；五秒后仍未退出会自动强制清理，再按一次 `Ctrl-C` 可立即强制停止。

## Smoke check

保持测试站运行，在第二个终端执行：

```bash
npm run local:smoke
```

检查器最多等待 30 秒让站点就绪，然后验证：

- `/` 返回 DeviLudo HTML 工作台；
- `/admin/agents` 返回 Agent 管理台；
- `/api/health` 返回 `status: "ok"` 且服务标识正确。

任何路由超时、非 2xx、错误内容类型或内容标记缺失都会以非零状态退出，适合本地脚本和 CI 调用。

## 自定义端口

两个终端必须使用同一个端口：

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

## 常见问题

- `is already in use`：停止占用对应端口的旧进程，或为启动和检查命令选择相同的新端口。
- `Run npm install`：当前工作区缺少固定版本的 vinext 依赖，先执行 `npm install`。
- Smoke 等待超时：查看启动终端中的 vinext 错误，以及 `.wrangler/wrangler-local.log`。
- 页面通过但外部动作未执行：这是本地预览的预期行为；真实开发 Agent、Runner、GitHub 和 Steam 工作流需要独立配置安全凭据与基础设施。
