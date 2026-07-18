const SERVICE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const ENVIRONMENT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOOPBACK = new Set(["127.0.0.1", "[::1]"]);
const FORBIDDEN_HEADER_ENV = [
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
];

export function observabilityConfigFromEnv(service, version, env = process.env) {
  if (!SERVICE.test(service)) throw new Error("OpenTelemetry service name is invalid");
  if (!VERSION.test(version)) throw new Error("OpenTelemetry service version is invalid");
  const production = env.NODE_ENV === "production";
  const mode = env.DEVILUDO_OTEL_MODE?.trim() || (production ? "otlp" : "disabled");
  if (mode === "disabled") {
    if (production) throw new Error("OpenTelemetry cannot be disabled in production");
    return Object.freeze({ enabled: false, serviceName: `deviludo-${service}`, serviceVersion: version });
  }
  if (mode !== "otlp") throw new Error("OpenTelemetry mode is invalid");
  for (const name of FORBIDDEN_HEADER_ENV) {
    if (env[name]?.trim()) throw new Error("OpenTelemetry static authorization headers are forbidden");
  }
  if (env.OTEL_RESOURCE_ATTRIBUTES?.trim()) {
    throw new Error("OpenTelemetry resource attributes must be platform-owned");
  }
  const serviceName = `deviludo-${service}`;
  if (env.OTEL_SERVICE_NAME?.trim() && env.OTEL_SERVICE_NAME.trim() !== serviceName) {
    throw new Error("OpenTelemetry service name override is forbidden");
  }
  const endpoint = traceEndpoint(
    env.DEVILUDO_OTEL_TRACES_ENDPOINT?.trim()
      || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
      || "",
    production,
  );
  const ratio = samplingRatio(env.DEVILUDO_OTEL_TRACE_RATIO?.trim() || (production ? "0.1" : "1"));
  const deploymentEnvironment = env.DEVILUDO_DEPLOYMENT_ENVIRONMENT?.trim()
    || (production ? "production" : "development");
  if (!ENVIRONMENT.test(deploymentEnvironment)) {
    throw new Error("OpenTelemetry deployment environment is invalid");
  }
  return Object.freeze({
    enabled: true,
    serviceName,
    serviceVersion: version,
    deploymentEnvironment,
    endpoint,
    ratio,
  });
}

function traceEndpoint(value, production) {
  if (!value) throw new Error("OpenTelemetry traces endpoint is required");
  let url;
  try { url = new URL(value); }
  catch { throw new Error("OpenTelemetry traces endpoint is invalid"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname
    || url.username || url.password || url.search || url.hash || url.pathname !== "/v1/traces") {
    throw new Error("OpenTelemetry traces endpoint is invalid");
  }
  if (production && url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    throw new Error("Production OpenTelemetry HTTP endpoint must be a loopback sidecar");
  }
  if (url.port && (!/^\d{2,5}$/.test(url.port) || Number(url.port) > 65_535)) {
    throw new Error("OpenTelemetry traces endpoint is invalid");
  }
  return url.href;
}

function samplingRatio(value) {
  if (!/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(value)) {
    throw new Error("OpenTelemetry sampling ratio is invalid");
  }
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error("OpenTelemetry sampling ratio is invalid");
  }
  return ratio;
}
