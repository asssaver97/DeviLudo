# Agent microVM Launcher 发布与运行

生产 Agent Worker 只在 Linux KVM 主机上运行。仓库内的 Launcher 固定使用
[Firecracker Jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md)：
不接受管理员 shell、任意参数模板、浮动版本或 `--no-seccomp`，也不会把 Provider URL、
GitHub 凭据或上游 API Key 放进 microVM。

## 1. 主机与 Guest 前置条件

每个开发 Worker 节点必须预装并固定以下只读输入：

- 同一精确版本的官方 musl `firecracker` 和 `jailer`；
- 适用于该 Firecracker 版本的未压缩 Linux kernel；
- 只读 Agent Guest ext4 rootfs，init 会挂载标签为 `deviludo-data` 的第二块盘到
  `/run/deviludo`，运行 `start:agent-microvm-guest`，完成后卸载数据盘并关机；
- 精确版本的 `mke2fs` 和 `debugfs`；
- `/dev/kvm`、cgroup v2，以及 `0700` 的 Jailer/锁目录。

Guest rootfs 必须包含固定 Agent Installation、Adapter、Node runtime、CA 和 Guest
启动逻辑，但不能包含第三方 Provider Key。Guest 的工作负载证书和候选签名能力应由
密封 Guest/KMS 边界提供。rootfs、kernel、Firecracker、Jailer 和 e2fs 工具的实际
SHA-256 全部进入签名发布清单；任何字节漂移都会阻止 Worker 启动。

主机预先建立 `/run/netns/deviludo-agent-*` 网络命名空间。每个命名空间只能有一个
`tap0`，并用 nftables 将 Guest 出站限制为内部 inference Gateway、DNS/NTP 的明确
允许项；必须拒绝 metadata、loopback、link-local、multicast、其他私网和横向 Worker
地址。Launcher 通过 `/run/lock/deviludo-agent-microvms` 的排他锁保证一个命名空间同一
时间只承载一个任务。异常退出后锁保持失败关闭，由节点排空流程核验无 Firecracker/
cgroup 残留后再清理，不能自动猜测并复用。

Firecracker 官方生产建议还要求持续修补内核、microcode、禁用 SMT/KSM、约束 cgroup、
限制日志和网络洪泛；这些是节点镜像验收条件，不由项目配置放宽。

## 2. 构建 Launcher 候选

只允许从干净且等于指定 40 位 revision 的工作树构建：

```bash
npm run build:agent-microvm-launcher -- \
  --source-revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --output-directory /absolute/private/agent-microvm-launcher-candidate
```

构建器锁定 Node `22.13`、esbuild `0.28.0`、官方 package integrity、lockfile 摘要、
完整 bundle 输入集合和源码 revision，输出：

- `deviludo-agent-microvm-launcher.mjs`（`0500`）；
- `agent-microvm-launcher-build-receipt.json`（`0400`）。

对 Launcher 执行 SBOM、恶意软件、漏洞和 provenance 检查。证据文件必须是：

```json
{
  "schemaVersion": "deviludo.agent-microvm-launcher-evidence.v1",
  "scanState": "PASS",
  "artifactDigest": "<64-hex>",
  "buildReceiptDigest": "<64-hex>",
  "configDigest": "<64-hex>",
  "sbomDigest": "<64-hex>",
  "malwareScanDigest": "<64-hex>",
  "vulnerabilityScanDigest": "<64-hex>",
  "provenanceDigest": "<64-hex>"
}
```

配置从 [`infra/agent-microvm-launcher-config.example.json`](../infra/agent-microvm-launcher-config.example.json)
复制。必须替换全部示例 digest；`platformVersion`、Firecracker 版本、所有路径、资源上限和
预置 namespace 列表在签名前冻结。`configDigest` 是配置文件实际字节的 SHA-256，签名后
不得重新格式化或追加换行。

## 3. 独立信任域与 KMS 最终签名

从 [`infra/agent-microvm-launcher-trust-policy.example.json`](../infra/agent-microvm-launcher-trust-policy.example.json)
建立独立策略。模板故意为 `REVOKED`；SecurityAdmin 完成 key ceremony 后才可发布新的
`ACTIVE` revision。可先检查不泄露公钥字节的摘要视图：

```bash
npm run inspect:agent-microvm-launcher-trust -- \
  --trust-policy /absolute/reviewed/agent-microvm-launcher-trust.json
```

Finalizer 的 mTLS 身份只能访问固定 KMS 路由
`/v1/agent-microvm-launchers/sign-ed25519`。私钥不进入环境、文件或 CLI：

```bash
npm run finalize:agent-microvm-launcher -- \
  --artifact /absolute/private/candidate/deviludo-agent-microvm-launcher.mjs \
  --build-receipt /absolute/private/candidate/agent-microvm-launcher-build-receipt.json \
  --config /absolute/reviewed/agent-microvm-launcher.json \
  --evidence /absolute/private/evidence/agent-microvm-launcher-evidence.json \
  --output /absolute/private/release/agent-microvm-launcher-release.json \
  --published-at 2026-07-24T00:00:00.000Z \
  --release-id 11111111-1111-4111-8111-111111111111 \
  --source-revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --trust-policy /absolute/reviewed/agent-microvm-launcher-trust.json \
  --trust-policy-digest '<64-hex>'
```

清单将 Launcher/build/config 与 Firecracker、Jailer、kernel、rootfs、mke2fs、debugfs 和
四类扫描证据绑定到一个 Ed25519 envelope。相同输入可幂等重放；已有输出与重新计算的
claims 不同会失败。

## 4. Worker 挂载与执行顺序

将 Launcher、build receipt、配置、release manifest 和 trust policy 作为不同只读文件
挂载，并设置 `services/agent-execution-broker/.env.example` 中的
`DEVILUDO_AGENT_MICROVM_*` 路径与 digest。Worker 启动顺序固定为：

1. 重算 Launcher、build receipt 和配置的实际摘要；
2. 校验 trust policy 摘要、key 状态/有效期和 Ed25519 manifest；
3. 验证清单内每个 VMM/Guest 输入与配置完全一致；
4. 才创建 PostgreSQL pool、连接源码/候选 Broker 并启动任务消费。

每次任务重新校验运行文件，复制冻结源码和请求到独立 ext4 数据盘，在一个排他网络
namespace 中运行 `jailer --new-pid-ns -- --config-file /machine-config.json`。rootfs 只读、
数据盘可写、SMT 关闭、串口禁用。Guest 关机后 Launcher 只用摘要固定的 `debugfs` 导出
`/control/response.json`，核对 run/attempt 身份后以 `O_EXCL` 写回；不从 Guest 导出任意
主机路径。租约取消或超时会 SIGKILL 整个 Launcher/Jailer 进程组，迟到结果仍由 Worker
fencing 丢弃。

macOS/Windows 本地网站不会尝试运行 Firecracker；它继续使用显式 loopback 测试运行时。
生产闭环还需要由独立发布流水线实际产出上述签名 Guest rootfs 和预配置 Linux KVM 节点，
缺少其中任何一个时健康检查保持失败关闭。
