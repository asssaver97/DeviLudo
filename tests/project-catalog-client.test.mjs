import assert from "node:assert/strict";
import test from "node:test";
import { parseProjectCatalog } from "../components/console/useProjectCatalog.ts";

const base = Object.freeze({
  projectId: "ember-archipelago",
  tenantId: "tenant-local",
  slug: "ember-archipelago",
  name: "余烬群岛",
  repositoryBindingId: "local-fixture-binding",
  installationId: "local-fixture-9001",
  repositoryId: 7001,
  repositoryNodeId: "LOCAL_R_ember_archipelago",
  owner: "north-dock",
  repositoryName: "ember-archipelago",
  defaultBranch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
});

test("client catalog accepts only the explicit local installation identity in fixture mode", () => {
  assert.deepEqual(parseProjectCatalog([base], "LOCAL_FIXTURE"), [base]);
  assert.throws(
    () => parseProjectCatalog([{ ...base, installationId: "9001" }], "LOCAL_FIXTURE"),
    /项目目录格式无效/,
  );
});

test("client catalog keeps production installation IDs numeric and rejects local fixtures", () => {
  const production = {
    ...base,
    tenantId: "tenant-production",
    installationId: "9001",
    repositoryId: 912345,
  };
  assert.deepEqual(parseProjectCatalog([production], "PRODUCTION"), [production]);
  assert.throws(() => parseProjectCatalog([base], "PRODUCTION"), /项目目录格式无效/);
});

test("client catalog still rejects duplicate projects and unknown response fields", () => {
  assert.throws(() => parseProjectCatalog([base, base], "LOCAL_FIXTURE"), /重复项目/);
  assert.throws(
    () => parseProjectCatalog([{ ...base, unexpected: true }], "LOCAL_FIXTURE"),
    /项目目录格式无效/,
  );
});
