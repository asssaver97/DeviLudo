# Steam Workflow Executor 镜像边界

`steam-workflow-executor` 是唯一可以协调 Steam 私有 Beta 上传和默认分支发布的隔离
编排进程。它不属于共享控制面镜像，也不安装到 Agent、E2E Runner 或 Steam Client
Connector 节点。

## 构建

构建必须使用 digest-pinned Node 22.15+ Debian slim 基础镜像、精确平台版本和 40 位源码
revision：

```bash
npm run image:build-steam-workflow-executor -- \
  --node-base-image registry.internal/base/node:22.15.1-bookworm-slim@sha256:REVIEWED_BASE_DIGEST \
  --native-publisher-image registry.internal/deviludo/native-steam-publisher:1.3.0@sha256:REVIEWED_PUBLISHER_DIGEST \
  --destination registry.internal/deviludo/steam-workflow-executor:0.1.0-beta.1-0123456789ab \
  --source-revision 0123456789abcdef0123456789abcdef01234567 \
  --platform linux/amd64
```

构建器只执行无 shell 的 `docker buildx build`，强制拉取基础镜像、禁用缓存、推送不可变
目标，并要求 `provenance=mode=max` 与 SBOM。目标仓库必须以
`/steam-workflow-executor` 结尾，tag 必须由平台版本和源码前 12 位导出，拒绝 `latest`。
输出 `deviludo.steam-workflow-executor-image-receipt.v1`，绑定 Registry digest、Node 基础镜像、
精确 native publisher 工具镜像、平台、Dockerfile 与 lockfile 的实际 SHA-256。

## 运行边界

[`Dockerfile.steam-workflow-executor`](../Dockerfile.steam-workflow-executor) 以非 root `node`
用户启动固定入口，入口拒绝任何 argv、local fixture authority、动态 `NODE_OPTIONS`、
`LD_PRELOAD` 和不安全本地 PostgreSQL。镜像只包含 Steam 编排服务及其 PostgreSQL、S3、
Runner contract 依赖，不包含 Claude Code、Codex、Godot、Steam Guard 数据、`config.vdf`、
Beta 密码或签名私钥。已独立扫描和签名、以 digest 固定的 publisher 工具镜像只提供
`native-steam-publisher` 与不含秘密的固定配置，二者被复制进最终只读层。

以下秘密文件必须由后续经授权的部署以 root-owned 只读卷提供：

- PostgreSQL、RC signer、Depot Finalizer、S3 的最小权限 mTLS/Secret 文件；
- 仅用于验证 RC 与 MFA authorization 的 Ed25519 公钥。

可写路径仅为 `/var/lib/deviludo/steam-publisher` 的有界临时卷。原生 publisher 每次执行前
仍重新计算自身与配置 digest，并使用固定 argv、空 shell 和受控环境。镜像 receipt 只证明
候选制品，不授权部署；生产还必须锁定外部只读资源、原生 publisher release、部署 scope
并取得短期 SecurityAdmin/KMS authorization。

首先以显式集群 context 和配置 revision 锁定四个 revision-suffixed、`immutable=true` 的
Kubernetes 输入；命令只读取 kind、name、UID、resourceVersion 和 immutable 元数据，不读
Secret data：

```bash
NODE_ENV=production npm run lock:steam-workflow-executor-runtime -- \
  --context prod-steam/security-admin \
  --namespace deviludo-steam-release \
  --configuration-revision abcdef123456
```

锁包含 Registry Secret、非秘密 ConfigMap、环境 Secret 与文件 Secret 的精确身份。后续
授权与每个 apply 阶段必须重新查询同一 context 并拒绝 UID/resourceVersion 漂移；runtime
lock 本身不授予部署权限。

## 发布授权与部署

从 [`infra/steam-workflow-executor-release-trust-policy.example.json`](../infra/steam-workflow-executor-release-trust-policy.example.json)
创建独立 Ed25519 策略；模板 key 故意为 `REVOKED`。该信任域不得复用控制面、Artifact
Preparer、Steam RC signer 或 Depot Finalizer 的 key。先检查不显示公钥材料的语义摘要：

```bash
npm run inspect:steam-workflow-executor-release-trust -- \
  --trust-policy /absolute/reviewed/steam-workflow-executor-release-trust.json
```

配置 `.workflow-executor.env.example` 中五个离线 release signer 变量后，请求最长 30 分钟
的授权。claims 精确绑定镜像回执、Node/native publisher 两个基座、runtime lock、context、
namespace、replica 与 rollout timeout：

```bash
NODE_ENV=production npm run authorize:steam-workflow-executor -- \
  --context prod-steam/security-admin \
  --namespace deviludo-steam-release \
  --receipt /absolute/release/steam-workflow-executor-image-receipt.json \
  --runtime-lock /absolute/release/steam-workflow-executor-runtime-lock.json \
  --trust-policy /absolute/reviewed/steam-workflow-executor-release-trust.json \
  --trust-policy-digest sha256:REVIEWED_POLICY_DIGEST
```

部署命令默认只渲染并无副作用：

```bash
npm run deploy:steam-workflow-executor -- \
  --receipt /absolute/release/steam-workflow-executor-image-receipt.json \
  --runtime-lock /absolute/release/steam-workflow-executor-runtime-lock.json
```

只有显式 `--apply`、显式 context、authorization 和策略摘要齐全时才会写集群。每次写入
Namespace、安全资源和 Deployment 之前都会重新验证短期签名并查询四个运行资源的实时
UID/resourceVersion。渲染的 Pod 禁用 ServiceAccount token、采用 restricted Pod Security、
只读 rootfs、丢弃全部 capabilities、无 hostPath，并仅提供有界 tmpfs/work emptyDir 与只读
Secret 文件卷。该 Worker 无入站服务，namespace-wide default-deny NetworkPolicy 的最小
PostgreSQL、S3、KMS、Depot Finalizer 和 DNS egress 必须由独立评审的集群策略提供。
容器启动时先清除 readiness marker；只有所有外部依赖与 native publisher 探针通过后才以
create-only 方式写入 marker，startup/readiness probe 不会把仅仅“进程仍在”的 Worker 当成可用。

部署器只执行 server-side apply 和等待精确 Deployment Available；不执行 delete、prune、
exec，也不采用当前 kube context。现阶段仓库只生成、验证和授权发布；未配置真实 Registry、
KMS、不可变 Secret/ConfigMap 和集群 context 时不得执行 `--apply`。
