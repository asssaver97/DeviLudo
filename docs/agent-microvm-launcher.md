# Agent microVM Launcher 发布与运行

生产 Agent Worker 只在 Linux KVM 主机上运行。仓库内的 Launcher 固定使用
[Firecracker Jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md)：
不接受管理员 shell、任意参数模板、浮动版本或 `--no-seccomp`，也不会把 Provider URL、
GitHub 凭据或上游 API Key 放进 microVM。

## 1. 主机与 Guest 前置条件

每个开发 Worker 节点必须预装并固定以下只读输入：

- 同一精确版本的官方 musl `firecracker` 和 `jailer`；
- 适用于该 Firecracker 版本的未压缩 Linux kernel；
- 只读 Agent Guest SquashFS rootfs，kernel 参数固定为 `root=/dev/vda rootfstype=squashfs ro`；
- 每次任务独立生成的 ext4 数据盘和只读短期凭据盘，分别作为 `/dev/vdb`、`/dev/vdc`；
- 精确版本的 `mke2fs` 和 `debugfs`；
- `/dev/kvm`、cgroup v2，以及 `0700` 的 Jailer/锁目录。

Guest rootfs 必须包含固定 Agent Installation、Adapter、Node runtime、公开 CA 和 Guest
启动逻辑，但不能包含私钥、工作负载证书、第三方 Provider Key、CLI 会话或配置。Worker
通过 mTLS Credential Issuer 获取绑定 `tenant + project + run + attempt + installation + expiry`
的短期 ext4 凭据盘；Launcher 只读挂载，Guest init 校验严格 JSON 环境契约，任务结束后
Worker 删除该盘。rootfs、kernel、Firecracker、Jailer 和 e2fs 工具的实际 SHA-256 全部
进入签名发布清单；任何字节漂移都会阻止 Worker 启动。

主机预先建立 `/run/netns/deviludo-agent-*` 网络命名空间。每个命名空间只能有一个
`tap0`，并用 nftables 将 Guest 出站限制为内部 inference Gateway、DNS/NTP 的明确
允许项；必须拒绝 metadata、loopback、link-local、multicast、其他私网和横向 Worker
地址。Launcher 通过 `/run/lock/deviludo-agent-microvms` 的排他锁保证一个命名空间同一
时间只承载一个任务。异常退出后锁保持失败关闭，由节点排空流程核验无 Firecracker/
cgroup 残留后再清理，不能自动猜测并复用。

Firecracker 官方生产建议还要求持续修补内核、microcode、禁用 SMT/KSM、约束 cgroup、
限制日志和网络洪泛；这些是节点镜像验收条件，不由项目配置放宽。

## 2. 构建并签名 Guest rootfs

每个 Agent Installation 单独构建一个 rootfs。输入必须是 Agent 供应链已经批准、扫描和
签名的精确 WorkerImage digest；Claude Code 和 Codex CLI 不共享 rootfs：

```bash
npm run build:agent-microvm-guest-rootfs -- \
  --agent claude-code \
  --exact-agent-version 2.1.14 \
  --adapter-version 1.3.0 \
  --worker-image 'registry.internal/deviludo/agents/claude-code:build-locked@sha256:<64-hex>' \
  --node-base-image 'registry.internal/runtime/node:22.13.1-bookworm-slim@sha256:<64-hex>' \
  --source-revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --source-date-epoch 1767225600 \
  --mksquashfs /opt/deviludo/tools/mksquashfs \
  --mksquashfs-digest '<64-hex>' \
  --output-directory /absolute/private/agent-microvm-guest-candidate
```

构建器固定 Dockerfile、BuildKit 参数、`linux/amd64`、源时间戳和 mksquashfs 参数，并检查
Node、Agent CLI、Guest 服务和 init 均存在，同时拒绝 `.env`、CLI 会话、Steam 会话和疑似
私钥文件。输出为 `agent-microvm-guest.squashfs` 和不可变 build receipt。随后对 rootfs
执行 SBOM、恶意软件、HIGH/CRITICAL 漏洞、secret scan 和 provenance 检查，形成：

```json
{
  "schemaVersion": "deviludo.agent-microvm-guest-evidence.v1",
  "scanState": "PASS",
  "rootfsDigest": "<64-hex>",
  "buildReceiptDigest": "<64-hex>",
  "sbomDigest": "<64-hex>",
  "malwareScanDigest": "<64-hex>",
  "vulnerabilityScanDigest": "<64-hex>",
  "secretScanDigest": "<64-hex>",
  "provenanceDigest": "<64-hex>"
}
```

使用独立的 [`infra/agent-microvm-guest-trust-policy.example.json`](../infra/agent-microvm-guest-trust-policy.example.json)
完成检查和 KMS 签名；模板 key 故意为 `REVOKED`：

```bash
npm run inspect:agent-microvm-guest-trust -- --trust-policy /absolute/reviewed/guest-trust.json
npm run finalize:agent-microvm-guest-rootfs -- \
  --rootfs /absolute/private/agent-microvm-guest-candidate/agent-microvm-guest.squashfs \
  --build-receipt /absolute/private/agent-microvm-guest-candidate/agent-microvm-guest-build-receipt.json \
  --evidence /absolute/private/evidence/agent-microvm-guest-evidence.json \
  --output /absolute/private/release/agent-microvm-guest-release.json \
  --published-at 2026-07-26T00:00:00.000Z \
  --release-id 11111111-1111-4111-8111-111111111111 \
  --source-revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --trust-policy /absolute/reviewed/guest-trust.json \
  --trust-policy-digest '<64-hex>'
```

签名 claims 固定 Agent、CLI、Adapter、原 WorkerImage digest、SquashFS digest、构建 receipt、
全部扫描证据、无内嵌 secret 和禁用自更新断言。Launcher 配置还固定 Guest manifest 文件
字节摘要及 Guest trust policy 摘要，两个签名域缺一不可。

## 3. 构建 Launcher 候选

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

## 4. 独立信任域与 KMS 最终签名

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

## 5. Worker 挂载与执行顺序

将 Launcher、build receipt、配置、release manifest 和 trust policy 作为不同只读文件
挂载，并设置 `services/agent-execution-broker/.env.example` 中的
`DEVILUDO_AGENT_MICROVM_*` 路径与 digest。Worker 启动顺序固定为：

1. 重算 Launcher、build receipt 和配置的实际摘要；
2. 校验 Launcher trust policy、key 状态/有效期和 Ed25519 manifest；
3. 校验 Guest manifest 文件摘要、独立 trust policy、rootfs digest 和发布 claims；
4. 验证清单内每个 VMM/Guest 输入与配置完全一致；
5. 才创建 PostgreSQL pool、连接源码/候选 Broker 并启动任务消费。

每次任务重新校验运行文件，复制冻结源码和请求到独立 ext4 数据盘，在一个排他网络
namespace 中运行 `jailer --new-pid-ns -- --config-file /machine-config.json`。rootfs 只读、
数据盘可写、短期凭据盘只读、SMT 关闭、串口禁用。每个请求先向 Credential Issuer 取得
绑定任务且限时的 ext4 镜像；镜像摘要和 ext4 superblock 校验通过后才允许进入 Jailer。
Guest 关机后 Launcher 只用摘要固定的 `debugfs` 导出
`/control/response.json`，核对 run/attempt 身份后以 `O_EXCL` 写回；不从 Guest 导出任意
主机路径。租约取消或超时会 SIGKILL 整个 Launcher/Jailer 进程组，迟到结果仍由 Worker
fencing 丢弃。

macOS/Windows 本地网站不会尝试运行 Firecracker；它继续使用显式 loopback 测试运行时。
生产仍需要配置 Linux KVM 节点、受信 Credential Issuer 和实际签名产物；缺少其中任何一个
时健康检查保持失败关闭。
