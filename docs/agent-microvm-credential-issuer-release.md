# Agent microVM Credential Issuer 生产发布

短期凭据盘签发服务持有 Guest 候选签名材料和多组工作负载证书，因此不属于共享控制面，
也不能复用 Agent supply-chain、control-plane 或 native artifact 的发布授权。生产发布固定经过：

`镜像回执 → 运行时资源锁 → 独立信任策略审核 → 短期 KMS 授权 → 分阶段 apply`

## 1. 镜像回执

先使用 digest 固定的 Node 与内部 e2fs 工具链构建并推送镜像：

```bash
npm run image:build-agent-microvm-credential-issuer -- \
  --node-base-image registry.internal/base/node:22.13.1-bookworm-slim@sha256:NODE_DIGEST \
  --toolchain-base-image registry.internal/deviludo/agent-microvm-credential-toolchain:0.1.0-beta.1@sha256:TOOLCHAIN_DIGEST \
  --destination registry.internal/deviludo/agent-microvm-credential-issuer:0.1.0-beta.1-SOURCE_PREFIX \
  --source-revision 40_CHARACTER_GIT_SHA \
  > /absolute/private/agent-credential-issuer-image-receipt.json
```

回执固定最终 registry digest、两张基础镜像、Dockerfile、lockfile、源码 revision、平台、
BuildKit 最大 provenance 和 SBOM。浮动 tag、浮动版本、非源码派生目标 tag 都会被拒绝。

## 2. 锁定外部运行时资源

先由运维系统创建以下带同一 12 位小写十六进制 revision 且 `immutable: true` 的资源：

- `deviludo-agent-credential-registry-REVISION` Secret；
- `deviludo-agent-credential-config-REVISION` ConfigMap；
- `deviludo-agent-credential-environment-REVISION` Secret；
- `deviludo-agent-credential-files-REVISION` Secret。

Files Secret 包含服务端 TLS、Worker CA、Guest relay/Gateway/短期 Secret Broker 证书和
候选签名私钥，键名必须与
[`credential-issuer.env.example`](../services/agent-execution-broker/credential-issuer.env.example)
中的固定文件名一致。Environment Secret 只承载服务自己的 PostgreSQL 连接配置；Provider
Key、DLRT、Steam 或 GitHub 凭据不得进入这些资源。ConfigMap 承载 mke2fs digest、固定
Worker SPIFFE、内部 Origin、公开 CA 和超时等非密钥配置。

锁定命令只读取 Kubernetes metadata，不读取 Secret data：

```bash
NODE_ENV=production npm run lock:agent-microvm-credential-issuer-runtime -- \
  --context production-ap-east-1/admin \
  --namespace deviludo-agent-credentials \
  --configuration-revision fedcba987654 \
  > /absolute/private/agent-credential-issuer-runtime-lock.json
```

输出记录四个对象的 kind/name/UID/resourceVersion。发布的每个变更阶段都会重新读取这些
metadata；删除重建、更新或取消 immutable 都会在下一次变更前失败关闭。

## 3. 独立 SecurityAdmin 授权

复制默认撤销的
[`agent-microvm-credential-issuer-release-trust-policy.example.json`](../infra/agent-microvm-credential-issuer-release-trust-policy.example.json)，
替换为独立 KMS 公钥、精确有效期和经 SecurityAdmin 审核的 `ACTIVE` key。不能复用其他
DeviLudo 发布 key。先检查不含公钥字节的摘要视图：

```bash
npm run inspect:agent-microvm-credential-issuer-release-trust -- \
  --trust-policy /absolute/reviewed/agent-credential-issuer-release-trust.json
```

配置 `DEVILUDO_AGENT_CREDENTIAL_ISSUER_RELEASE_SIGNER_*` 和
`DEVILUDO_AGENT_CREDENTIAL_ISSUER_RELEASE_SIGNING_KEY_ID` 后签发最长 30 分钟的授权：

```bash
NODE_ENV=production npm run authorize:agent-microvm-credential-issuer -- \
  --context production-ap-east-1/admin \
  --receipt /absolute/private/agent-credential-issuer-image-receipt.json \
  --runtime-lock /absolute/private/agent-credential-issuer-runtime-lock.json \
  --trust-policy /absolute/reviewed/agent-credential-issuer-release-trust.json \
  --trust-policy-digest sha256:REVIEWED_DIGEST \
  --replicas 2 \
  --timeout-seconds 900 \
  > /absolute/private/agent-credential-issuer-release-authorization.json
```

客户端只调用 `/v1/agent-microvm-credential-issuer-releases/sign-ed25519`。签名 claims 同时绑定
镜像/工具链/源码、运行时锁、集群、namespace、replicas 和 timeout；修改任一字段都必须
重新授权。

## 4. 渲染与显式 apply

先离线渲染，不连接集群：

```bash
npm run deploy:agent-microvm-credential-issuer -- \
  --receipt /absolute/private/agent-credential-issuer-image-receipt.json \
  --runtime-lock /absolute/private/agent-credential-issuer-runtime-lock.json \
  --replicas 2 \
  --render
```

审核后才可显式 apply：

```bash
npm run deploy:agent-microvm-credential-issuer -- \
  --apply \
  --context production-ap-east-1/admin \
  --receipt /absolute/private/agent-credential-issuer-image-receipt.json \
  --runtime-lock /absolute/private/agent-credential-issuer-runtime-lock.json \
  --authorization /absolute/private/agent-credential-issuer-release-authorization.json \
  --trust-policy /absolute/reviewed/agent-credential-issuer-release-trust.json \
  --trust-policy-digest sha256:REVIEWED_DIGEST \
  --replicas 2
```

发布器仅使用 `kubectl apply --server-side --validate=strict` 和最终 `wait`，不执行 delete、
prune、exec 或 force。它创建 restricted Namespace、无 Token ServiceAccount、默认拒绝
NetworkPolicy、ClusterIP Service 和固定 Deployment。不会创建占位 Secret、ConfigMap 或
放宽网络规则。

## 5. 运行安全边界

- Pod 固定运行在带 `deviludo.io/workload=agent-microvm-credential-issuer` 的 Linux 节点；
- root filesystem 只读、UID/GID 1000、RuntimeDefault seccomp、drop ALL capabilities；
- `/run/deviludo-credential-images` 是 256 MiB 的私有 memory-backed `emptyDir`；
- 文件 Secret 以 `0440` 只读挂载，所有敏感路径由 Deployment 固定，ConfigMap 不能改写；
- `mke2fs` 路径固定且服务启动时重新校验实际 SHA-256；
- Service 只暴露 TLS 1.3 mTLS 端口 4673，应用层只允许一个 native Worker SPIFFE；
- 默认 NetworkPolicy 拒绝全部流量。集群平台必须另外配置最小化 Worker ingress、
  PostgreSQL/Gateway/短期 Secret Broker egress 和 DNS 规则，否则服务保持不可用；
- 该镜像不包含 Claude Code、Codex CLI、Godot、SteamCMD 或 Kubernetes Token。

变更运行配置时创建新 revision、重新锁定、重新授权并滚动发布。旧 Pod 在终止宽限期内完成
当前响应；新请求只进入已就绪副本。任一资源漂移或授权过期都会停止后续变更，不执行自动
回退到其他信任域。
