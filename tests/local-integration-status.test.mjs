import assert from "node:assert/strict";
import test from "node:test";

import { inspectLocalIntegration, resolveIntegrationConfig } from "../scripts/local/integration-status.mjs";

const environment = Object.freeze({
  DATABASE_URL: "postgresql://deviludo:local-secret@127.0.0.1:55432/deviludo",
  REDIS_URL: "redis://:local-secret@localhost:56379",
  TEMPORAL_ADDRESS: "127.0.0.1:57233",
  S3_ENDPOINT: "http://127.0.0.1:59000",
  VAULT_ADDR: "http://localhost:58200",
  DEVILUDO_OTEL_HEALTH_URL: "http://127.0.0.1:53133",
});

test("local integration status accepts only explicit loopback dependency endpoints", () => {
  const config = resolveIntegrationConfig(environment);
  assert.equal(config.database.port, "55432");
  assert.equal(config.redis.port, "56379");
  assert.deepEqual(config.temporal, { host: "127.0.0.1", port: 57233 });
  assert.equal(config.minio.origin, "http://127.0.0.1:59000");
  assert.equal(config.vault.origin, "http://localhost:58200");
  assert.equal(config.telemetry.origin, "http://127.0.0.1:53133");

  assert.throws(() => resolveIntegrationConfig({ ...environment, DATABASE_URL: "postgresql://db.internal/deviludo" }), /loopback/);
  assert.throws(() => resolveIntegrationConfig({ ...environment, DATABASE_URL: "postgresql://127.0.0.1/deviludo" }), /credentials/);
  assert.throws(() => resolveIntegrationConfig({ ...environment, REDIS_URL: "redis://127.0.0.1:6379" }), /password/);
  assert.throws(() => resolveIntegrationConfig({ ...environment, REDIS_URL: "redis://other:local-secret@127.0.0.1:6379" }), /password-only/);
  assert.throws(() => resolveIntegrationConfig({ ...environment, VAULT_ADDR: "https://operator:secret@127.0.0.1:8200" }), /loopback/);
  assert.throws(() => resolveIntegrationConfig({ ...environment, TEMPORAL_ADDRESS: "0.0.0.0:7233" }), /loopback/);
});

test("local integration status verifies schema, authenticated cache and every service endpoint", async () => {
  const calls = [];
  const results = await inspectLocalIntegration(environment, {
    postgres: async (url) => { calls.push(["postgres", url.port]); },
    redis: async (url) => { calls.push(["redis", url.port]); },
    tcp: async (address) => { calls.push(["temporal", address.port]); },
    http: async (url) => { calls.push(["http", url.pathname]); },
  });
  assert.equal(results.length, 6);
  assert.ok(results.every((result) => result.ready && result.detail === "READY"));
  assert.deepEqual(calls, [
    ["postgres", "55432"],
    ["redis", "56379"],
    ["temporal", 57233],
    ["http", "/minio/health/live"],
    ["http", "/v1/sys/health"],
    ["http", "/"],
  ]);
});

test("local integration status reports bounded failures without leaking connection secrets", async () => {
  const results = await inspectLocalIntegration(environment, {
    postgres: async () => { throw new Error("postgresql://deviludo:local-secret@127.0.0.1 migration is missing"); },
    redis: async () => { throw new Error("AUTH local-secret failed"); },
    tcp: async () => { throw new Error("connection timed out"); },
    http: async () => { throw new Error("health endpoint returned 503"); },
  });
  assert.equal(results[0].detail, "migration is missing");
  assert.equal(results[1].detail, "unavailable");
  assert.equal(results[2].detail, "connection timed out");
  assert.equal(results[3].detail, "health endpoint returned 503");
  assert.doesNotMatch(JSON.stringify(results), /local-secret|postgresql:\/\//);
});
