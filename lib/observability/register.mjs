import { observabilityConfigFromEnv } from "./config.mjs";

export async function startObservability(service, version, env = process.env, options = {}) {
  const config = observabilityConfigFromEnv(service, version, env);
  if (!config.enabled) return Object.freeze({ enabled: false, async shutdown() {} });

  process.env.OTEL_SERVICE_NAME = config.serviceName;
  process.env.OTEL_RESOURCE_ATTRIBUTES = [
    "service.namespace=deviludo",
    `service.version=${config.serviceVersion}`,
    `deployment.environment.name=${config.deploymentEnvironment}`,
  ].join(",");
  process.env.OTEL_PROPAGATORS = "tracecontext";
  process.env.OTEL_TRACES_SAMPLER = "parentbased_traceidratio";
  process.env.OTEL_TRACES_SAMPLER_ARG = String(config.ratio);
  process.env.OTEL_METRICS_EXPORTER = "none";
  process.env.OTEL_LOGS_EXPORTER = "none";
  process.env.OTEL_LOG_LEVEL = "error";

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { HttpInstrumentation },
    { default: FastifyOtelInstrumentation },
    { PgInstrumentation },
    { NestInstrumentation },
    { GrpcInstrumentation },
    { UndiciInstrumentation },
    { DnsInstrumentation },
    { NetInstrumentation },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("@opentelemetry/instrumentation-http"),
    import("@fastify/otel"),
    import("@opentelemetry/instrumentation-pg"),
    import("@opentelemetry/instrumentation-nestjs-core"),
    import("@opentelemetry/instrumentation-grpc"),
    import("@opentelemetry/instrumentation-undici"),
    import("@opentelemetry/instrumentation-dns"),
    import("@opentelemetry/instrumentation-net"),
  ]);
  const sdk = new NodeSDK({
    traceExporter: options.traceExporter ?? new OTLPTraceExporter({ url: config.endpoint }),
    instrumentations: [
      new HttpInstrumentation({ requestHook: scrubHttpSpan }),
      new FastifyOtelInstrumentation({ registerOnInitialization: true, instrumentHooks: false,
        requestHook: (span, request) => scrubHttpSpan(span, request) }),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new NestInstrumentation(),
      new GrpcInstrumentation(),
      new UndiciInstrumentation({ requestHook: scrubHttpSpan }),
      new DnsInstrumentation(),
      new NetInstrumentation(),
    ],
  });
  await sdk.start();
  let stopped = false;
  return Object.freeze({
    enabled: true,
    async shutdown() {
      if (stopped) return;
      stopped = true;
      await sdk.shutdown();
    },
  });
}

export function scrubHttpSpan(span, request) {
  const raw = typeof request?.url === "string"
    ? request.url
    : typeof request?.path === "string"
      ? request.path
      : null;
  if (!raw) return;
  const sanitized = sanitizeUrl(raw);
  span.setAttribute("url.full", sanitized);
  span.setAttribute("http.url", sanitized);
  span.setAttribute("url.query", "");
  span.setAttribute("deviludo.telemetry.sanitized", true);
}

function sanitizeUrl(value) {
  try {
    const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
    const url = new URL(value, "https://redacted.invalid");
    return absolute ? `${url.protocol}//${url.host}${url.pathname}` : url.pathname;
  } catch {
    return "/invalid-url";
  }
}
