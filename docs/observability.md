# OpenTelemetry 统一追踪

DeviLudo 的所有 `start` / `start:*` 服务入口都经过固定的 observed-service
launcher。Launcher 在 Fastify、NestJS、PostgreSQL、HTTP Client 或工作流模块
加载前启动 OpenTelemetry Node SDK，并从仓库内的不可变映射确定
`service.name`；浏览器、租户或普通环境变量不能把一个进程伪装成另一个服务。

## 生产配置

生产进程将 `NODE_ENV=production` 时，追踪默认为强制 `otlp`。必须配置：

```text
DEVILUDO_OTEL_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
DEVILUDO_OTEL_TRACE_RATIO=0.1
DEVILUDO_DEPLOYMENT_ENVIRONMENT=production
```

推荐给每个 workload 部署只监听 loopback 的 Collector sidecar。应用到 sidecar
可使用 loopback HTTP；非 loopback 的生产端点必须是 HTTPS。Collector 再通过
mTLS 或平台的 workload identity 向最终后端导出。

应用进程禁止 `OTEL_EXPORTER_OTLP_HEADERS`、
`OTEL_EXPORTER_OTLP_TRACES_HEADERS` 和调用方提供的
`OTEL_RESOURCE_ATTRIBUTES`。因此长期 Bearer Token、API Key 或任意租户数据
不会落入普通环境变量。服务名、版本、namespace 和 deployment environment
由启动器生成。

## 数据最小化

- 仅启用 trace；metrics/log exporter 显式设为 `none`。
- 仅传播 W3C `tracecontext`，不传播任意 baggage。
- HTTP span 在导出前把 URL 收敛为 origin + pathname，清除 query；GitHub
  OAuth `code/state` 等一次性值不会进入 trace。
- 不启用文件系统、Bunyan、Pino 或 Winston 自动插桩；不会记录密钥挂载路径
  或普通日志内容。
- PostgreSQL 不启用 enhanced database reporting，查询参数不会作为 span
  属性采集。
- Collector 再次删除 Cookie、Authorization、API Key、run token、URL query、
  gen-AI 输入/输出和 credential 字段。生产后端仍应采用最短可行保留期和
  严格的审计访问控制。

## Web 就绪门禁

生产 Web 的 `GET /api/health` 是流量就绪探针，不是无条件存活回执。它先用业务
客户端校验身份、GitHub、项目仓库、规格对话、用户验收、交付投影、Agent 管理、
Steam Guard 和发布授权的 HTTPS/凭据配置，再并发访问每个唯一 Broker Origin 的
`GET /healthz`。请求最多等待两秒、禁止重定向且把响应限制为 16 KiB；只有媒体类型、
精确字段和服务或 schema 身份全部匹配才返回 `200`、`status=ok` 和 `ready=true`。
Steam 注册与项目配置共享同一个 Access Broker 时只发一次探针。缺失依赖返回
`NOT_CONFIGURED`，不安全 Origin 或残缺凭据返回 `INVALID_CONFIGURATION`，网络或
非 2xx 响应返回 `UNAVAILABLE`，错误服务、字段、媒体类型或超限正文返回
`IDENTITY_MISMATCH`；任一状态都让总响应返回 `503`。响应不包含 URL、Key、响应正文
或解析错误文本，避免健康端点泄露内部拓扑和凭据。Agent 管理控制面的独立
`GET /healthz` 会实际探测权威目录存储和 Agent 供应链。编排器必须使用 Web 端点
控制流量接入，进程存活由容器运行时单独判断。

这条链路不是只验证 Broker 进程：Identity Broker 会检查六张身份/RLS 表及 Secret
Broker；GitHub Authorization Broker 会检查授权表、installation 表、防重放账本和
Secret Broker；Project Repository Broker 会检查项目、installation、仓库绑定、操作
账本，并要求 GitHub App KMS 返回绑定精确 key ID 与 `RS256` 的
`deviludo.github-app-signer-health.v1`。候选发布和合并服务的自身 `/healthz` 也包含
同一个 KMS 探针。Spec Dialogue 会检查其九张授权/对话/不可变 revision/toolchain 表，
再要求 Spec Model Broker 返回精确 `deviludo.spec-model-health.v1`，并递归检查审批
Bridge；Bridge 还会检查八张 workflow/outbox 表，并调用 Temporal `GetSystemInfo`、
核对部署锁定的 namespace 身份。
User Acceptance 会同时检查反馈模型与反馈、候选证据、验收和取消的完整 schema。
Agent Configuration 会检查配置锁、不可变规格、源码基线、工具链、运行授权和修复证据
所需的全部关系，并递归验证 Source Snapshot Broker 的精确身份；Agent Execution
Broker 会检查运行、Provider failover、事件和队列表，开发 Worker 还会验证冻结规格包。
Inference Gateway 的 `/healthz` 会检查授权、Provider、usage、request claim 等完整关系，
并递归访问 mTLS Secret Broker；仅有监听端口或启动时连接成功不再被视为可接流量。
任何内部错误只折叠为稳定的 `503`，不会向 Web 传播数据库、Vault、KMS、模型或
Temporal 诊断文本。

## 本地验证

本地测试网站默认使用 `DEVILUDO_OTEL_MODE=disabled`，所以不会把开发活动
发送到任何外部后端。需要验证 Collector 时，可先启动本地基础设施，再为
单个 `start:*` 进程设置：

```text
DEVILUDO_OTEL_MODE=otlp
DEVILUDO_OTEL_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
DEVILUDO_OTEL_TRACE_RATIO=1
```

契约测试使用真实 SDK 与内存 exporter，验证固定资源身份、采样和 W3C
上下文注入，不依赖开放本机端口，也不会向外部网络发送数据。
