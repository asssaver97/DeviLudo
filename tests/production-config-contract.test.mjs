import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeProductionConfiguration,
  assertProductionConfiguration,
  documentedEnvironmentNames,
  environmentNamesFromSource,
  loadProductionConfiguration,
} from "../scripts/production/config-contract.mjs";

test("all production entrypoints have fixed launchers and documented operator configuration", async () => {
  const report = assertProductionConfiguration(await loadProductionConfiguration());
  assert.equal(report.entrypointCount, report.startScriptCount);
  assert.equal(report.missingEnvironment.length, 0);
  assert.equal(report.missingEntrypointFiles.length, 0);
});

test("optional commented assignments count as documentation but process-owned child values do not", () => {
  assert.deepEqual([...documentedEnvironmentNames([
    "# DEVILUDO_OPTIONAL_PATH=/run/example\nDEVILUDO_REQUIRED=value\n# prose only",
  ])], ["DEVILUDO_OPTIONAL_PATH", "DEVILUDO_REQUIRED"]);
  assert.deepEqual([...environmentNamesFromSource(`
    env.DEVILUDO_REQUIRED;
    env.DEVILUDO_PLATFORM_VERSION;
    env.DEVILUDO_SOURCE_REVISION;
    env.DEVILUDO_WORKFLOW_DESTINATION;
    env.DEVILUDO_TESTKIT_STEAM_CONNECTOR_VERSION;
  `)], ["DEVILUDO_REQUIRED"]);
});

test("configuration analysis rejects undocumented values, legacy ports and stale start mappings", () => {
  const report = analyzeProductionConfiguration({
    entrypointSources: ["env.DEVILUDO_REQUIRED; env.DEVILUDO_UNDOCUMENTED"],
    environmentExamples: ["DEVILUDO_REQUIRED=present"],
    entrypoints: { identity: { entry: "services/identity/src/run-service.ts" } },
    packageScripts: { start: "node scripts/observability/run-service.mjs unknown" },
    rootEnvironment: "CONTROL_PLANE_PORT=4000",
  });
  assert.deepEqual(report.missingEnvironment, ["DEVILUDO_UNDOCUMENTED"]);
  assert.deepEqual(report.missingStartServices, ["identity"]);
  assert.deepEqual(report.unknownStartServices, ["unknown"]);
  assert.throws(() => assertProductionConfiguration(report), (error) => {
    assert.match(error.message, /DEVILUDO_UNDOCUMENTED/);
    assert.match(error.message, /legacy CONTROL_PLANE_PORT/);
    assert.doesNotMatch(error.message, /present/);
    return true;
  });
});
