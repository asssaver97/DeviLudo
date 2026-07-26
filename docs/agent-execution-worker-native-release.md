# Agent Execution Worker 原生发布

Agent Execution Worker 是 Linux KVM 开发节点上的宿主服务。它需要调用已经独立签名的
Firecracker/Jailer Launcher、管理网络命名空间和任务工作目录，因此不打包进控制面容器，
也不安装到 E2E Runner 或 Steam 节点。

## 候选包

只从干净工作树和当前 40 位 Git revision 构建：

```bash
npm run build:agent-execution-worker-native -- \
  --source-revision 0123456789abcdef0123456789abcdef01234567 \
  --output-directory /absolute/private/agent-execution-worker-native-candidate
```

构建器固定 `package-lock.json`、esbuild 0.28.0 和 Node 22.13 target，原子生成权限为
`0500` 的 `deviludo-agent-execution-worker-native.mjs` 与权限为 `0400` 的
`agent-execution-worker-native-build-receipt.json`。回执绑定平台版本、源码、lockfile、
esbuild library、完整 bundle 输入集合及最终字节；相对目录、脏工作树、非当前 HEAD 或
浮动版本均被拒绝。

隔离流水线必须生成 SPDX SBOM、恶意软件扫描、漏洞扫描和 provenance，并写入：

```json
{
  "schemaVersion": "deviludo.agent-execution-worker-native-evidence.v1",
  "scanState": "PASS",
  "artifactDigest": "64-character-lowercase-sha256",
  "buildReceiptDigest": "64-character-lowercase-sha256",
  "sbomDigest": "64-character-lowercase-sha256",
  "malwareScanDigest": "64-character-lowercase-sha256",
  "vulnerabilityScanDigest": "64-character-lowercase-sha256",
  "provenanceDigest": "64-character-lowercase-sha256"
}
```

## 独立签名域

从 [`infra/agent-execution-worker-native-trust-policy.example.json`](../infra/agent-execution-worker-native-trust-policy.example.json)
创建经 SecurityAdmin 评审的策略。模板故意将 key 标记为 `REVOKED`。先检查语义摘要：

```bash
npm run inspect:agent-execution-worker-native-trust -- \
  --trust-policy /absolute/reviewed/agent-execution-worker-native-trust.json
```

配置 `DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_SIGNER_*` 与 `_SIGNING_KEY_ID` 后，在
`NODE_ENV=production` 的离线发布任务中执行：

```bash
NODE_ENV=production npm run finalize:agent-execution-worker-native -- \
  --artifact /absolute/private/candidate/deviludo-agent-execution-worker-native.mjs \
  --build-receipt /absolute/private/candidate/agent-execution-worker-native-build-receipt.json \
  --evidence /absolute/private/evidence/agent-execution-worker-native-evidence.json \
  --output /absolute/private/release/agent-execution-worker-native-release.json \
  --published-at 2026-07-26T01:00:00.000Z \
  --release-id 11111111-1111-4111-8111-111111111111 \
  --source-revision 0123456789abcdef0123456789abcdef01234567 \
  --trust-policy /absolute/reviewed/agent-execution-worker-native-trust.json \
  --trust-policy-digest REVIEWED_64_CHARACTER_SHA256
```

Finalizer 只访问 TLS 1.3 mTLS KMS 路径
`/v1/agent-execution-worker-native/sign-ed25519`。签名 claims 固定候选包、构建回执、
源码、lockfile、bundle 输入及全部扫描证据；私钥不离开 KMS。相同结果可幂等重放，
已有输出不同时失败。

## 宿主启动门禁

把 bundle、构建回执、发布封装和信任策略安装为 root-owned 只读文件，并配置
`services/agent-execution-broker/.env.example` 中全部
`DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_*` 运行变量。生产必须直接执行 bundle，不能用
`tsx` 启动仓库源码。服务在构造数据库池、Vault Secret store 或任一 mTLS Broker client
之前核对：

- 实际执行路径就是声明的 bundle；
- bundle 与构建回执的实际 SHA-256 等于环境固定值；
- 信任策略摘要精确匹配且 key 为 `ACTIVE`；
- Ed25519 release 的平台版本、字节大小、构建回执和证据 claims 全部匹配。

`DEVILUDO_LOCAL_TEST_MODE=1` 只在非 production 进程允许跳过该门禁。撤销 key、替换文件、
修改 digest 或尝试用源码入口启动生产进程都会在任何外部连接前失败。Launcher、Guest
rootfs、Worker placement binding 仍分别验证，不能由本发布封装替代。

当前阶段只授权不可变 Worker 字节；将 release、Launcher/Guest release、placement
binding 和 systemd/launch transaction 绑定到一台具体 KVM 宿主仍需单独的安装授权。
