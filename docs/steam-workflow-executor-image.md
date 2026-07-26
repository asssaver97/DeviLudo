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
