import assert from "node:assert/strict";
import test from "node:test";

import { evaluateLocalP0BootstrapReadiness } from "../lib/health/local-p0-readiness.ts";
import { GET as liveness } from "../app/api/health/live/route.ts";
import { GET as publicReadiness } from "../app/api/health/public-ready/route.ts";

const ENVIRONMENT = Object.freeze({
  DEVILUDO_PLATFORM_MANAGED_CONFIGURATION: "1",
  DEVILUDO_ACCOUNT_API_URL: "http://127.0.0.1:4100",
  DEVILUDO_LOCAL_RUNTIME_URL: "http://127.0.0.1:4311",
  DEVILUDO_LOCAL_AGENT_RUNTIME_URL: "http://127.0.0.1:4312",
  DEVILUDO_LOCAL_SPEC_RUNTIME_URL: "http://127.0.0.1:4313",
  DEVILUDO_LOCAL_INFERENCE_GATEWAY_URL: "http://127.0.0.1:4314/v1",
});

test("local P0 bootstrap accepts an identity-checked unconfigured inference Gateway", async () => {
  const calls = [];
  const readiness = await evaluateLocalP0BootstrapReadiness(ENVIRONMENT, { fetch: async (input, init) => {
    assert.equal(typeof input, "string");
    assert.equal(init.redirect, undefined);
    const url = new URL(input); calls.push(url.href);
    const bodies = {
      "4100/healthz": { status: "ok", service: "deviludo-account-api" },
      "4311/health": { status: "ok", service: "deviludo-local-runtime", godotVersion: "4.6.2", exportTemplatesRoot: "/templates" },
      "4312/health": { status: "ok", service: "deviludo-local-agent-runtime", executionEnabled: true, workerImageVerified: true },
      "4313/health": { status: "ok", service: "deviludo-local-spec-runtime" },
      "4314/healthz": { schemaVersion: "deviludo.inference-gateway-health.v1", status: "unavailable",
        service: "deviludo-inference-gateway", connector: "CONFIGURED", providerProbe: "NOT_CONFIGURED", reconciliation: "NOT_CONFIGURED" },
    };
    return Response.json(bodies[`${url.port}${url.pathname}`], { status: url.port === "4314" ? 503 : 200 });
  } });
  assert.equal(readiness.ready, true);
  assert.deepEqual(new Set(Object.values(readiness.dependencies)), new Set(["READY"]));
  assert.equal(readiness.inferenceProbe.status, "unavailable");
  assert.equal(calls.length, 5);
});

test("local P0 bootstrap reads managed-platform variables through the runtime environment", async () => {
  const names = Object.keys(ENVIRONMENT);
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, ENVIRONMENT);
  const calls = [];
  try {
    const readiness = await evaluateLocalP0BootstrapReadiness(undefined, { fetch: async (input) => {
      const url = new URL(input); calls.push(url.port);
      if (url.port === "4100") return Response.json({ status: "ok", service: "deviludo-account-api" });
      if (url.port === "4311") return Response.json({ status: "ok", service: "deviludo-local-runtime", godotVersion: "4.6.2", exportTemplatesRoot: "/templates" });
      if (url.port === "4312") return Response.json({ status: "ok", service: "deviludo-local-agent-runtime", executionEnabled: true, workerImageVerified: true });
      if (url.port === "4313") return Response.json({ status: "ok", service: "deviludo-local-spec-runtime" });
      return Response.json({ schemaVersion: "deviludo.inference-gateway-health.v1", status: "unavailable",
        service: "deviludo-inference-gateway", connector: "CONFIGURED", providerProbe: "NOT_CONFIGURED", reconciliation: "NOT_CONFIGURED" }, { status: 503 });
    } });
    assert.equal(readiness.ready, true);
    assert.equal(readiness.dependencies.accountPlatform, "READY");
    assert.ok(calls.includes("4100"));
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("local P0 bootstrap fails closed for a missing export template or a forged service identity", async () => {
  const readiness = await evaluateLocalP0BootstrapReadiness(ENVIRONMENT, { fetch: async (input) => {
    const url = new URL(input);
    if (url.port === "4311") return Response.json({ status: "ok", service: "deviludo-local-runtime", godotVersion: "4.6.2", exportTemplatesRoot: null });
    if (url.port === "4313") return Response.json({ status: "ok", service: "forged-spec-runtime" });
    if (url.port === "4314") return Response.json({ schemaVersion: "deviludo.inference-gateway-health.v1", status: "unavailable",
      service: "deviludo-inference-gateway", connector: "CONFIGURED", providerProbe: "NOT_CONFIGURED", reconciliation: "NOT_CONFIGURED" });
    if (url.port === "4312") return Response.json({ status: "ok", service: "deviludo-local-agent-runtime", executionEnabled: true, workerImageVerified: true });
    return Response.json({ status: "ok", service: "deviludo-account-api" });
  } });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.dependencies.localGodot, "IDENTITY_MISMATCH");
  assert.equal(readiness.dependencies.localSpecRuntime, "IDENTITY_MISMATCH");
});

test("liveness never claims dependency readiness and public readiness stays behind the external gate", async () => {
  const live = await liveness();
  assert.equal(live.status, 200);
  assert.equal((await live.json()).status, "ok");
  const original = process.env.PUBLIC_PRODUCT_ENABLED;
  delete process.env.PUBLIC_PRODUCT_ENABLED;
  try {
    const blocked = await publicReadiness();
    assert.equal(blocked.status, 503);
    const body = await blocked.json();
    assert.equal(body.status, "EXTERNAL_APPROVAL_REQUIRED");
    assert.deepEqual(body.gates, ["PUBLIC_DOMAIN", "DNS_DELEGATION", "PUBLIC_TLS", "EXTERNAL_OAUTH"]);
  } finally {
    if (original === undefined) delete process.env.PUBLIC_PRODUCT_ENABLED;
    else process.env.PUBLIC_PRODUCT_ENABLED = original;
  }
});
