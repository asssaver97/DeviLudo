import assert from "node:assert/strict";
import test from "node:test";
import { loadCoreConfig } from "@/services/core/src/config";

const base = Object.freeze({
  NODE_ENV: "development",
  DEVILUDO_CORE_ROLE: "sandbox",
  DEVILUDO_CORE_SANDBOX_DATABASE_URL: "postgresql://deviludo:local@postgres:5432/deviludo",
});

test("sandbox concurrency defaults to one and accepts an explicit second worker", () => {
  assert.equal(loadCoreConfig(base).sandboxConcurrency, 1);
  assert.equal(loadCoreConfig({ ...base, DEVILUDO_SANDBOX_CONCURRENCY: "2" }).sandboxConcurrency, 2);
});

test("sandbox concurrency rejects unsafe worker counts", () => {
  assert.throws(() => loadCoreConfig({ ...base, DEVILUDO_SANDBOX_CONCURRENCY: "0" }), /DEVILUDO_SANDBOX_CONCURRENCY/);
  assert.throws(() => loadCoreConfig({ ...base, DEVILUDO_SANDBOX_CONCURRENCY: "3" }), /DEVILUDO_SANDBOX_CONCURRENCY/);
});
