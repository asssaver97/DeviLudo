# Agent 供应链运维说明

生产 Agent 供应链由 mTLS Broker 和单文件策略执行器组成。Broker 负责持久 claim、幂等重放和终态回执；策略执行器是唯一可以访问官方 NPM、内部 OCI、扫描器、BuildKit、KMS 签名和开发 Worker Fleet 的进程。E2E Runner 与 Steam 节点不安装该执行器或自主 Agent。

## 构建、签名与安装

```bash
npm run build:agent-supply-chain-native -- \
  --source-revision 0123456789abcdef0123456789abcdef01234567 \
  --output-directory /absolute/private/agent-supply-chain-native-candidate
```

构建器拒绝相对输出路径、脏工作树、非当前 HEAD、浮动平台版本和未由
`package-lock.json` 固定的 esbuild。它原子生成：

- `deviludo-agent-supply-chain-native.mjs`：权限为 `0500` 的单文件策略执行器；
- `agent-supply-chain-native-build-receipt.json`：绑定平台版本、40 位源码 revision、
  Node 22.13 target、lockfile、esbuild、完整 bundle 输入集合和最终字节。

在隔离发布流水线中对这两个文件生成 SPDX SBOM、恶意软件扫描、漏洞扫描和
构建 provenance。最终证据文件只接受以下精确结构，所有 digest 均为 64 位
小写 SHA-256；`artifactDigest` 和 `buildReceiptDigest` 必须等于文件实际字节：

```json
{
  "schemaVersion": "deviludo.agent-supply-chain-native-evidence.v1",
  "scanState": "PASS",
  "artifactDigest": "...",
  "buildReceiptDigest": "...",
  "sbomDigest": "...",
  "malwareScanDigest": "...",
  "vulnerabilityScanDigest": "...",
  "provenanceDigest": "..."
}
```

从 [`infra/agent-supply-chain-native-trust-policy.example.json`](../infra/agent-supply-chain-native-trust-policy.example.json)
建立独立评审的 Ed25519 信任策略。示例 key 故意是 `REVOKED`，不能用于生产。
先检查不含公钥材料的语义摘要：

```bash
npm run inspect:agent-supply-chain-native-trust -- \
  --trust-policy /absolute/reviewed/agent-supply-chain-native-trust.json
```

配置专用 TLS 1.3 mTLS KMS Broker 的五个
`DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_SIGNER_*`/`_SIGNING_KEY_ID` 变量后，请求一份
只绑定公开 claims 的签名封装：

```bash
npm run finalize:agent-supply-chain-native -- \
  --artifact /absolute/private/candidate/deviludo-agent-supply-chain-native.mjs \
  --build-receipt /absolute/private/candidate/agent-supply-chain-native-build-receipt.json \
  --evidence /absolute/private/evidence/agent-supply-chain-native-evidence.json \
  --output /absolute/private/release/agent-supply-chain-native-release.json \
  --published-at 2026-07-24T00:00:00.000Z \
  --release-id 11111111-1111-4111-8111-111111111111 \
  --source-revision 0123456789abcdef0123456789abcdef01234567 \
  --trust-policy /absolute/reviewed/agent-supply-chain-native-trust.json \
  --trust-policy-digest REVIEWED_64_CHARACTER_SHA256
```

Finalizer 固定调用 `/v1/agent-supply-chain-native/sign-ed25519`，本地验证 KMS
签名后才以 `0400` 写入结果；相同输入可幂等重放，已有文件内容不同则失败。
私钥不离开 KMS。

将执行器、构建回执、发布封装和评审后的信任策略作为四个只读文件挂载给
Broker，并配置：

- `DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_EXECUTABLE` 与 `_DIGEST`；
- `DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_PLATFORM_VERSION`；
- `DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_BUILD_RECEIPT_FILE`；
- `DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_RELEASE_MANIFEST_FILE`；
- `DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_TRUST_POLICY_FILE` 与 `_DIGEST`。

Broker 在创建数据库连接、探针或子进程之前重新读取文件，验证 Ed25519 key
仍为 `ACTIVE`、策略摘要、平台版本、源码/Node 合同、构建回执摘要、执行器
摘要与大小。撤销 key、替换任一文件或仅修改环境 digest 都会使启动失败。
执行镜像必须在 `/usr/bin/node` 提供固定且签名验证过的 Node 22.13+ runtime。

不要把源码入口、`tsx`、包管理器或 `node_modules` 挂到生产 Broker。不要在生产运行 `npm install`、浮动版本、自更新、管理员 shell 或外部脚本。新执行器与新策略都作为新制品灰度，已运行任务继续使用原 digest。信任策略与业务策略是两个独立对象：前者只决定哪些平台发布签名可启动，后者决定官方 Agent 源、扫描器、镜像与 Fleet 权限，不能用一个 digest 代替另一个。

## 策略配置

从 [`infra/agent-supply-chain-native-policy.example.json`](../infra/agent-supply-chain-native-policy.example.json) 复制配置，并替换所有示例 digest、NPM 官方签名 key id、OCI digest、工具版本和 KMS 引用。示例中的零 digest 绝不能用于生产。最终 JSON 以只读文件挂载，其 SHA-256 同时设置为 `DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_CONFIG_DIGEST`。

配置解析器只接受：

- 固定 `registry.npmjs.org` 官方目录、Claude Code/Codex 两个官方包和精确 SemVer；
- 固定的八个工具及绝对路径、版本、SHA-256；
- digest 固定的基础镜像、合成测试镜像与精确 Adapter 版本；
- `dev`/`development` 开发池，不能指向 E2E 或发布节点；
- HTTPS 内部 Registry、KMS signing ref、只读 Docker registry config、离线 scanner 数据和 Fleet config。

Adapter 不是管理员可上传的插件。当前平台发布内置不可变 `deviludo.agent-registry.v1`，分别锁定 Claude Code `claude-code-v1@1.3.0` 与 Codex CLI `codex-cli-v1@1.2.2`，并声明各自 Provider 协议和配置 Schema。控制面、本地测试管理 API 与原生策略解析器都会在构建预留前校验这一绑定；即使请求给出格式正确的其他 SemVer，也以 `ADAPTER_NOT_APPROVED` 拒绝且不创建 WorkerImage 记录。升级 Adapter 必须随新的平台/策略制品发布，不能只修改管理请求或策略 JSON。

官方包下载会对每次 DNS 解析做公网地址校验、固定 TLS 连接、拒绝 redirect，并验证 NPM ECDSA 签名、SHA-512 integrity 和本地 SHA-256。tar 解包只接受 `package/` 下的 USTAR 普通文件/目录，拒绝链接、设备、PAX、重复路径、穿越和 `.git`。

## 固定门禁

验证阶段固定运行 ClamAV、Trivy 离线扫描、Syft SPDX、无网络/只读/去能力的 Adapter contract 与合成代码任务，然后把包和 SBOM 推入内部 OCI。构建阶段重新下载并核对上一验证回执的 SHA-256，使用 digest 固定基础镜像、扫描最终镜像、KMS 签名并执行无网络 smoke test。灰度只允许 `0→5→25→100`，回滚只允许回到 `0`，且 Fleet 必须确认只影响新任务。每次 `100%` 回执记录权威激活时间，后续候选只把同 Agent、同 Worker 池中最近激活且仍健康的 `100% ACTIVE` 安装作为回滚目标，而不依赖目录插入顺序。回滚回执与 Agent 目录在同一事务提交：平台为所有受影响 ACTIVE Profile 建立指向该安装的不可变后继，连同 fallback 依赖和默认选择一起迁移，但不改变 Provider、模型、凭据或预算；没有合格目标时 Profile 进入 `DEGRADED` 并停止接收新任务。

策略失败以退出码 `42` 写入脱敏终态回执：版本验证为 `REJECTED`，构建/灰度为 `QUARANTINED`。网络超时、扫描器不可用、Registry/KMS/Fleet 故障不生成安全终态，而由 Broker 释放 claim 后重试。
