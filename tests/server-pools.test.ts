import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_POOL_DEFINITIONS,
  SERVER_POOL_KINDS,
  assertPoolOperatingSystem,
  fixedPoolRecords,
  poolReadiness,
  type ServerNodeRecord,
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
  assert.throws(() => routeJob("ARTIFACT_SIGN", "windows"), /retired historical job kind/);
  assert.throws(() => routeJob("STEAM_CLEAN_INSTALL", "macos"), /retired historical job kind/);
  assert.throws(() => routeJob("AGENT_GENERATION", "linux"));
  assert.throws(() => routeJob("ARTIFACT_SIGN"));
  assert.throws(() => assertJobPlacement({
    kind: "ARTIFACT_SIGN",
    poolKind: "CORE",
    targetOperatingSystem: "macos",
  }));
  assert.throws(() => assertPoolOperatingSystem("E2E_MACOS", "linux"));
  for (const pool of ["E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS"] as const) {
    assert.deepEqual(SERVER_POOL_DEFINITIONS[pool].capabilities, ["E2E_TEST"]);
  }
});

test("macOS reports on-demand readiness with zero resident nodes", () => {
  assert.equal(poolReadiness("E2E_MACOS", 0), "ON_DEMAND_READY");
  const pools = fixedPoolRecords([]);
  assert.equal(pools.length, 5);
  assert.equal(pools.find(pool => pool.kind === "E2E_MACOS")?.readiness, "ON_DEMAND_READY");
});

test("a macOS node becomes ready only after its asynchronous preparation completes", () => {
  const preparing = Object.freeze({
    id: "00000000-0000-4000-8000-000000000005",
    poolKind: "E2E_MACOS",
    operatingSystem: "macos",
    state: "ACTIVE",
    capabilities: Object.freeze(["E2E_TEST"]),
    isolationGeneration: 1,
    currentWorkspaceId: null,
    lastHeartbeatAt: null,
    lastReimageProofAt: null,
    preparation: Object.freeze({
      state: "PREPARING",
      stage: "DOWNLOADING_BASE",
      progress: 37,
      message: "Downloading",
      updatedAt: new Date().toISOString(),
    }),
  }) satisfies ServerNodeRecord;
  assert.equal(fixedPoolRecords([preparing]).find(pool => pool.kind === "E2E_MACOS")?.activeNodes, 0);
  const ready = Object.freeze({ ...preparing, preparation: Object.freeze({
    ...preparing.preparation,
    state: "READY" as const,
    stage: "READY",
    progress: 100,
  }) });
  assert.equal(fixedPoolRecords([ready]).find(pool => pool.kind === "E2E_MACOS")?.activeNodes, 1);
});
