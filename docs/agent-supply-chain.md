# Agent 供应链运维说明

生产 Agent 供应链由 mTLS Broker 和单文件策略执行器组成。Broker 负责持久 claim、幂等重放和终态回执；策略执行器是唯一可以访问官方 NPM、内部 OCI、扫描器、BuildKit、KMS 签名和开发 Worker Fleet 的进程。E2E Runner 与 Steam 节点不安装该执行器或自主 Agent。

## 构建与安装

```bash
npm run build:agent-supply-chain-native
```

命令生成 `dist/agent-supply-chain-native/deviludo-agent-supply-chain-native.mjs` 与包含 SHA-256、输入清单的 `build-metadata.json`。发布流水线必须在受控 Node 22.13+ 镜像中执行、生成 SBOM/扫描和签名证明，再将只读产物安装为 Broker 的 `DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_EXECUTABLE`；产物 SHA-256 填入 `DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_EXECUTABLE_DIGEST`。执行镜像必须在 `/usr/bin/node` 提供固定且签名验证过的 Node runtime。

不要把源码入口、`tsx`、包管理器或 `node_modules` 挂到生产 Broker。不要在生产运行 `npm install`、浮动版本、自更新、管理员 shell 或外部脚本。新执行器与新策略都作为新制品灰度，已运行任务继续使用原 digest。

## 策略配置

从 [`infra/agent-supply-chain-native-policy.example.json`](../infra/agent-supply-chain-native-policy.example.json) 复制配置，并替换所有示例 digest、NPM 官方签名 key id、OCI digest、工具版本和 KMS 引用。示例中的零 digest 绝不能用于生产。最终 JSON 以只读文件挂载，其 SHA-256 同时设置为 `DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_CONFIG_DIGEST`。

配置解析器只接受：

- 固定 `registry.npmjs.org` 官方目录、Claude Code/Codex 两个官方包和精确 SemVer；
- 固定的八个工具及绝对路径、版本、SHA-256；
- digest 固定的基础镜像、合成测试镜像与精确 Adapter 版本；
- `dev`/`development` 开发池，不能指向 E2E 或发布节点；
- HTTPS 内部 Registry、KMS signing ref、只读 Docker registry config、离线 scanner 数据和 Fleet config。

官方包下载会对每次 DNS 解析做公网地址校验、固定 TLS 连接、拒绝 redirect，并验证 NPM ECDSA 签名、SHA-512 integrity 和本地 SHA-256。tar 解包只接受 `package/` 下的 USTAR 普通文件/目录，拒绝链接、设备、PAX、重复路径、穿越和 `.git`。

## 固定门禁

验证阶段固定运行 ClamAV、Trivy 离线扫描、Syft SPDX、无网络/只读/去能力的 Adapter contract 与合成代码任务，然后把包和 SBOM 推入内部 OCI。构建阶段重新下载并核对上一验证回执的 SHA-256，使用 digest 固定基础镜像、扫描最终镜像、KMS 签名并执行无网络 smoke test。灰度只允许 `0→5→25→100`，回滚只允许回到 `0`，且 Fleet 必须确认只影响新任务。

策略失败以退出码 `42` 写入脱敏终态回执：版本验证为 `REJECTED`，构建/灰度为 `QUARANTINED`。网络超时、扫描器不可用、Registry/KMS/Fleet 故障不生成安全终态，而由 Broker 释放 claim 后重试。
