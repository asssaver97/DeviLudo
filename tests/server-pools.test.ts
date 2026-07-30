import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_POOL_DEFINITIONS,
  SERVER_POOL_KINDS,
  assertPoolOperatingSystem,
  fixedPoolRecords,
  poolReadiness,
} from "@/lib/runtime/server-pools";
import { assertJobPlacement, routeJob } from "@/lib/runtime/job-routing";

test("the application has exactly five fixed server pools", () => {
  assert.deepEqual(SERVER_POOL_KINDS, [
    "WEB", "CORE", "E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS",
  ]);
  assert.equal(Object.keys(SERVER_POOL_DEFINITIONS).length, 5);
  assert.deepEqual(
    SERVER_POOL_KINDS.map(kind => SERVER_POOL_DEFINITIONS[kind].operatingSystem),
    ["linux", "linux", "linux", "windows", "macos"],
  );
  assert.deepEqual(
    SERVER_POOL_KINDS.map(kind => SERVER_POOL_DEFINITIONS[kind].desiredNodes),
    [1, 1, 1, 1, 0],
  );
});

test("job placement cannot escape its fixed pool", () => {
  assert.equal(routeJob("AGENT_GENERATION"), "CORE");
  assert.equal(routeJob("PROJECT_DOCUMENT_MAINTENANCE"), "CORE");
  assert.equal(routeJob("ARTIFACT_BUILD"), "CORE");
  assert.equal(routeJob("STEAM_PUBLISH"), "CORE");
  assert.equal(routeJob("E2E_TEST", "linux"), "E2E_LINUX");
  assert.equal(routeJob("ARTIFACT_SIGN", "windows"), "E2E_WINDOWS");
  assert.equal(routeJob("STEAM_CLEAN_INSTALL", "macos"), "E2E_MACOS");
  assert.throws(() => routeJob("AGENT_GENERATION", "linux"));
  assert.throws(() => routeJob("ARTIFACT_SIGN"));
  assert.throws(() => assertJobPlacement({
    kind: "ARTIFACT_SIGN",
    poolKind: "CORE",
    targetOperatingSystem: "macos",
  }));
  assert.throws(() => assertPoolOperatingSystem("E2E_MACOS", "linux"));
});

test("macOS reports on-demand readiness with zero resident nodes", () => {
  assert.equal(poolReadiness("E2E_MACOS", 0), "ON_DEMAND_READY");
  const pools = fixedPoolRecords([]);
  assert.equal(pools.length, 5);
  assert.equal(pools.find(pool => pool.kind === "E2E_MACOS")?.readiness, "ON_DEMAND_READY");
});
