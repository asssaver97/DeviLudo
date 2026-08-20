import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TELEMETRY_ENDPOINT, loadCoreConfig } from "@/services/core/src/config";

const base = Object.freeze({
  NODE_ENV: "development",
  DEVILUDO_CORE_ROLE: "sandbox",
  DEVILUDO_CORE_SANDBOX_DATABASE_URL: "postgresql://deviludo:local@postgres:5432/deviludo",
  DEVILUDO_INSTALLATION_ID: "01234567-89ab-5def-8abc-0123456789ab",
});

test("sandbox concurrency defaults to one and accepts an explicit second worker", () => {
  assert.equal(loadCoreConfig(base).sandboxConcurrency, 1);
  assert.equal(loadCoreConfig({ ...base, DEVILUDO_SANDBOX_CONCURRENCY: "2" }).sandboxConcurrency, 2);
});

test("sandbox concurrency rejects unsafe worker counts", () => {
  assert.throws(() => loadCoreConfig({ ...base, DEVILUDO_SANDBOX_CONCURRENCY: "0" }), /DEVILUDO_SANDBOX_CONCURRENCY/);
  assert.throws(() => loadCoreConfig({ ...base, DEVILUDO_SANDBOX_CONCURRENCY: "3" }), /DEVILUDO_SANDBOX_CONCURRENCY/);
});

test("telemetry defaults to the official collector and validates developer overrides", () => {
  const defaults = loadCoreConfig(base);
  assert.equal(defaults.telemetryEndpoint, DEFAULT_TELEMETRY_ENDPOINT);
  assert.equal(loadCoreConfig({ ...base, DEVILUDO_TELEMETRY_ENDPOINT: "" }).telemetryEndpoint, DEFAULT_TELEMETRY_ENDPOINT);
  assert.equal(defaults.releaseVersion, "development");
  assert.equal(defaults.installationId, base.DEVILUDO_INSTALLATION_ID);
  const configured = loadCoreConfig({
    ...base,
    DEVILUDO_TELEMETRY_ENDPOINT: "http://localhost:4319/active",
    DEVILUDO_RELEASE_VERSION: "v1.2.3",
  });
  assert.equal(configured.telemetryEndpoint, "http://localhost:4319/active");
  assert.equal(configured.releaseVersion, "v1.2.3");
  assert.throws(() => loadCoreConfig({ ...base, DEVILUDO_TELEMETRY_ENDPOINT: "http://collector.example/active" }), /DEVILUDO_TELEMETRY_ENDPOINT/);
  assert.throws(() => loadCoreConfig({ ...base, DEVILUDO_TELEMETRY_ENDPOINT: "https://collector.example/active?token=secret" }), /DEVILUDO_TELEMETRY_ENDPOINT/);
  assert.throws(() => loadCoreConfig({ ...base, DEVILUDO_INSTALLATION_ID: "random-per-deployment" }), /DEVILUDO_INSTALLATION_ID/);
});
