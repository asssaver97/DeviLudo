import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { agentAdminCapabilities } from "../lib/admin/agent-permissions.ts";

test("Agent admin UI capabilities mirror the platform-scoped RBAC boundary", () => {
  const platform = agentAdminCapabilities("PlatformAgentAdmin");
  assert.equal(platform.manageVersions, true);
  assert.equal(platform.manageInstallations, true);
  assert.equal(platform.changePlatformDefault, true);
  assert.equal(platform.editPlatformProvider, true);
  assert.equal(platform.activatePlatformProvider, false);
  assert.equal(platform.manageGlobalCredentials, false);

  const security = agentAdminCapabilities("SecurityAdmin");
  assert.equal(security.manageVersions, false);
  assert.equal(security.editPlatformProvider, true);
  assert.equal(security.activatePlatformProvider, true);
  assert.equal(security.manageGlobalCredentials, true);

  for (const role of ["TenantAdmin", "ProjectOwner", "Auditor"]) {
    assert.deepEqual(agentAdminCapabilities(role), {
      manageVersions: false,
      manageInstallations: false,
      changePlatformDefault: false,
      editPlatformProvider: false,
      activatePlatformProvider: false,
      manageGlobalCredentials: false,
    });
  }
});

test("new Provider opens an explicit blank draft without mutating the active snapshot", () => {
  const source = readFileSync(new URL("../components/admin/AgentAdminDashboard.tsx", import.meta.url), "utf8");

  assert.match(source, /setProviderEditorKey\(requestId\);[\s\S]*setNewProviderRequest\(requestId\);/);
  assert.match(source, /<ProvidersTab key=\{providerEditorKey\}/);
  assert.match(source, /title=\{editorMode === "new" \? "新建 Provider" : "编辑 Provider"\}/);
  assert.match(source, /const creatingProvider = Boolean\(newDraftRequest\);/);
  assert.match(source, /useState\(creatingProvider \? "" : initialProvider\?\.baseUrl/);
  assert.match(source, /useState\(creatingProvider \? "" : initialProvider\?\.primaryModel/);
  assert.match(source, /setDataRegion\(loadExisting \? "新加坡" : ""\);/);
  assert.match(source, /agent === kind && editorMode === "existing"/);
  assert.match(source, /onNewDraftConsumed\(newDraftRequest\)/);
});
