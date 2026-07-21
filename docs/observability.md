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

生产 Web 的 `GET /api/health` 是流量就绪探针，不是无条件存活回执。只有身份、
GitHub、项目仓库、规格对话、用户验收、交付投影、Agent 管理、Steam Guard 和
发布授权这十个 Broker 的完整配置都通过各自客户端的 HTTPS/凭据契约校验时，
才返回 `200`、`status=ok` 和 `ready=true`。缺失依赖返回 `503` 与
`NOT_CONFIGURED`；不安全 Origin、残缺的 HMAC Key 或发布公共 Origin 返回
`INVALID_CONFIGURATION`。响应不包含 URL、Key 或解析错误文本，避免健康端点
泄露内部拓扑和凭据。编排器必须使用该端点控制流量接入，进程存活由容器运行时
单独判断。

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
