# Steam Workflow Executor 镜像边界

`steam-workflow-executor` 是唯一可以协调 Steam 私有 Beta 上传和默认分支发布的隔离
编排进程。它不属于共享控制面镜像，也不安装到 Agent、E2E Runner 或 Steam Client
Connector 节点。

## 构建

构建必须使用 digest-pinned Node 22.15+ Debian slim 基础镜像、精确平台版本和 40 位源码
revision：

```bash
npm run image:build-steam-workflow-executor -- \
  --base-image registry.internal/base/node:22.15.1-bookworm-slim@sha256:REVIEWED_BASE_DIGEST \
  --destination registry.internal/deviludo/steam-workflow-executor:0.1.0-beta.1-0123456789ab \
  --source-revision 0123456789abcdef0123456789abcdef01234567 \
  --platform linux/amd64
```

构建器只执行无 shell 的 `docker buildx build`，强制拉取基础镜像、禁用缓存、推送不可变
目标，并要求 `provenance=mode=max` 与 SBOM。目标仓库必须以
`/steam-workflow-executor` 结尾，tag 必须由平台版本和源码前 12 位导出，拒绝 `latest`。
输出 `deviludo.steam-workflow-executor-image-receipt.v1`，绑定 Registry digest、基础镜像、
平台、Dockerfile 与 lockfile 的实际 SHA-256。

## 运行边界

[`Dockerfile.steam-workflow-executor`](../Dockerfile.steam-workflow-executor) 以非 root `node`
用户启动固定入口，入口拒绝任何 argv、local fixture authority、动态 `NODE_OPTIONS`、
`LD_PRELOAD` 和不安全本地 PostgreSQL。镜像只包含 Steam 编排服务及其 PostgreSQL、S3、
Runner contract 依赖，不包含 Claude Code、Codex、Godot、SteamCMD、Steam Guard 数据、
`config.vdf`、Beta 密码或签名私钥。

以下文件必须由后续经授权的部署以 root-owned 只读卷提供：

- `/opt/deviludo/bin/native-steam-publisher`，以及环境中固定的实际 SHA-256；
- `/opt/deviludo/config/native-steam-publisher.json`，以及环境中固定的实际 SHA-256；
- PostgreSQL、RC signer、Depot Finalizer、S3 的最小权限 mTLS/Secret 文件；
- 仅用于验证 RC 与 MFA authorization 的 Ed25519 公钥。

可写路径仅为 `/var/lib/deviludo/steam-publisher` 的有界临时卷。原生 publisher 每次执行前
仍重新计算自身与配置 digest，并使用固定 argv、空 shell 和受控环境。镜像 receipt 只证明
候选制品，不授权部署；生产还必须锁定外部只读资源、原生 publisher release、部署 scope
并取得短期 SecurityAdmin/KMS authorization。
