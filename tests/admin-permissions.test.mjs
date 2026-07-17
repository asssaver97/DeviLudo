import assert from "node:assert/strict";
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
