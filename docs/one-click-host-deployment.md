# E2E 与 Agent 宿主一键部署

## E2E Runner

从 [`infra/e2e-host-deployment.example.json`](../infra/e2e-host-deployment.example.json)
创建 root-owned 配置，填入本系统原生签名发布物、machine config、环境文件、trust policy
和回执的绝对路径。首次注册令 `previousPlanPath`、`operationId` 为 `null`；升级时绑定上一
plan 和新的 UUID v4。Windows 还必须提供已签名 SCM Bridge、Native Actuator 及独立策略。
Windows 配置样例见
[`infra/e2e-windows-host-deployment.example.json`](../infra/e2e-windows-host-deployment.example.json)。

```bash
openssl dgst -sha256 -r /etc/deviludo/e2e-host-deployment.json

sudo NODE_ENV=production npm run deploy:e2e-host -- \
  --config /etc/deviludo/e2e-host-deployment.json \
  --config-digest <64位SHA256> \
  --apply
```

入口自动执行 release 验签、不可变计划、只读暂存、service transaction、首次注册或排空
升级和失败回滚。去掉 `--apply` 只执行验证与计划。Linux 使用 systemd，macOS 使用
launchd；Windows 只把固定 request 交给签名 Native Actuator。

Windows 请在管理员 PowerShell 中运行：

```powershell
cd C:\DeviLudo-Platform\submodules\deviludo
$env:NODE_ENV = "production"
$config = "C:\ProgramData\DeviLudo\Config\e2e-host-deployment.json"
$digest = (Get-FileHash -Algorithm SHA256 $config).Hash.ToLowerInvariant()
npm run deploy:e2e-host -- --config $config --config-digest $digest --apply
```

## Linux KVM Agent Worker

基于 [`services/agent-execution-broker/.env.example`](../services/agent-execution-broker/.env.example)
建立 `0400/0600` 的 `/etc/deviludo/agent-execution-worker.env`，再从
[`infra/agent-worker-host-deployment.example.json`](../infra/agent-worker-host-deployment.example.json)
创建部署配置并填入环境文件摘要。

```bash
openssl dgst -sha256 -r /etc/deviludo/agent-execution-worker.env
openssl dgst -sha256 -r /etc/deviludo/agent-worker-host-deployment.json

sudo NODE_ENV=production npm run deploy:agent-host -- \
  --config /etc/deviludo/agent-worker-host-deployment.json \
  --config-digest <部署配置64位SHA256> \
  --apply
```

入口在写 systemd 前重验 Worker、Launcher、Guest、placement binding、全部运行时摘要、
`/dev/kvm`、cgroup v2、锁目录和预置 network namespace。unit 只引用环境文件，回执不含
环境值。失败会恢复上一 unit；去掉 `--apply` 可执行无宿主变更的预检。

这两个入口不负责购买云服务器、签发证书、构建或签名发布物，也不接受 SSH 密码、云
API Key、任意命令、任意下载 URL 或浮动版本。
