import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { context, propagation, trace } from "@opentelemetry/api";
import { observabilityConfigFromEnv } from "../lib/observability/config.mjs";
import { scrubHttpSpan, startObservability } from "../lib/observability/register.mjs";
import {
  installTelemetryLifecycle,
  SERVICE_ENTRYPOINTS,
  runObservedService,
} from "../scripts/observability/run-service.mjs";

test("production tracing is mandatory, endpoint-bound and cannot carry static authorization headers", () => {
  assert.throws(() => observabilityConfigFromEnv("identity", "1.0.0", {
    NODE_ENV: "production", DEVILUDO_OTEL_MODE: "disabled",
  }), /cannot be disabled/);
  assert.throws(() => observabilityConfigFromEnv("identity", "1.0.0", {
    NODE_ENV: "production", DEVILUDO_OTEL_MODE: "otlp",
  }), /endpoint is required/);
  assert.throws(() => observabilityConfigFromEnv("identity", "1.0.0", {
    NODE_ENV: "production", DEVILUDO_OTEL_MODE: "otlp",
    DEVILUDO_OTEL_TRACES_ENDPOINT: "http://otel-collector:4318/v1/traces",
  }), /loopback sidecar/);
  assert.throws(() => observabilityConfigFromEnv("identity", "1.0.0", {
    NODE_ENV: "production", DEVILUDO_OTEL_MODE: "otlp",
    DEVILUDO_OTEL_TRACES_ENDPOINT: "https://user:password@telemetry.example/v1/traces",
  }), /endpoint is invalid/);
  assert.throws(() => observabilityConfigFromEnv("identity", "1.0.0", {
    NODE_ENV: "production", DEVILUDO_OTEL_MODE: "otlp",
    DEVILUDO_OTEL_TRACES_ENDPOINT: "https://telemetry.example/v1/traces",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Bearer secret",
  }), /headers are forbidden/);
  assert.throws(() => observabilityConfigFromEnv("identity", "1.0.0", {
    NODE_ENV: "production", DEVILUDO_OTEL_MODE: "otlp",
    DEVILUDO_OTEL_TRACES_ENDPOINT: "https://telemetry.example/v1/traces",
    OTEL_RESOURCE_ATTRIBUTES: "tenant.id=secret",
  }), /platform-owned/);
  assert.deepEqual(observabilityConfigFromEnv("identity", "1.0.0", {
    NODE_ENV: "production", DEVILUDO_OTEL_MODE: "otlp",
    DEVILUDO_OTEL_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
    DEVILUDO_OTEL_TRACE_RATIO: "0.25",
  }), {
    enabled: true,
    serviceName: "deviludo-identity",
    serviceVersion: "1.0.0",
    deploymentEnvironment: "production",
    endpoint: "http://127.0.0.1:4318/v1/traces",
    ratio: 0.25,
  });
  assert.deepEqual(observabilityConfigFromEnv("identity", "1.0.0", {}), {
    enabled: false, serviceName: "deviludo-identity", serviceVersion: "1.0.0",
  });
});

test("HTTP span sanitizer removes OAuth codes, states and query secrets before export", () => {
  const attributes = new Map();
  scrubHttpSpan({ setAttribute(key, value) { attributes.set(key, value); } }, {
    url: "https://app.deviludo.example/api/auth/github/callback?code=oauth-secret&state=state-secret",
  });
  assert.equal(attributes.get("url.full"), "https://app.deviludo.example/api/auth/github/callback");
  assert.equal(attributes.get("http.url"), "https://app.deviludo.example/api/auth/github/callback");
  assert.equal(attributes.get("url.query"), "");
  assert.doesNotMatch(JSON.stringify([...attributes]), /oauth-secret|state-secret/);
});

test("every start entry uses the fixed observed-service launcher", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const starts = Object.entries(packageJson.scripts).filter(([name]) => name === "start" || name.startsWith("start:"));
  assert.equal(starts.length, Object.keys(SERVICE_ENTRYPOINTS).length);
  for (const [name, command] of starts) {
    assert.match(command, /scripts\/observability\/run-service\.mjs/);
    const service = command.split("run-service.mjs ")[1]?.trim();
    assert.ok(service && SERVICE_ENTRYPOINTS[service], `${name} has a fixed service identity`);
  }
  await assert.rejects(runObservedService(["unknown-service"], {}), /service name is invalid/);
});

test("the launcher keeps telemetry active until process completion", async () => {
  const target = new EventEmitter();
  let shutdowns = 0;
  const lifecycle = installTelemetryLifecycle({
    async shutdown() { shutdowns += 1; },
  }, target);
  assert.equal(shutdowns, 0);
  target.emit("beforeExit");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdowns, 1);
  await lifecycle.shutdownNow();
  assert.equal(shutdowns, 1);
});

test("Collector defense-in-depth deletes credential, OAuth query and generative content fields", async () => {
  const config = await readFile(new URL("../infra/otel/collector.yaml", import.meta.url), "utf8");
  for (const attribute of [
    "http.request.header.authorization",
    "http.request.header.cookie",
    "http.response.header.set_cookie",
    "http.request.header.x-api-key",
    "http.request.header.x-deviludo-run-token",
    "url.query",
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.system_instructions",
    "credential.value",
  ]) {
    assert.match(config, new RegExp(`key: ${attribute.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\n\\s+action: delete`));
  }
});

test("the real SDK exports sampled spans and injects W3C trace context", async () => {
  const spans = [];
  const exporter = {
    export(batch, done) { spans.push(...batch); done({ code: 0 }); },
    async shutdown() {},
  };
  const runtime = await startObservability("telemetry-contract", "1.0.0", {
    NODE_ENV: "development",
    DEVILUDO_OTEL_MODE: "otlp",
    DEVILUDO_OTEL_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
    DEVILUDO_OTEL_TRACE_RATIO: "1",
  }, { traceExporter: exporter });
  const carrier = {};
  await new Promise((resolve) => {
    trace.getTracer("deviludo-observability-contract").startActiveSpan("contract-span", (span) => {
      span.setAttribute("deviludo.contract", "unified-tracing");
      propagation.inject(context.active(), carrier);
      span.end();
      resolve();
    });
  });
  await runtime.shutdown();
  assert.match(carrier.traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, "contract-span");
  assert.equal(spans[0].resource.attributes["service.name"], "deviludo-telemetry-contract");
  assert.equal(spans[0].resource.attributes["service.version"], "1.0.0");
  assert.equal(spans[0].resource.attributes["deployment.environment.name"], "development");
});
