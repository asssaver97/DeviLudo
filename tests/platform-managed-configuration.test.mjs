import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { configurationOwnership, platformManagedConfiguration } from "../lib/config/platform-managed.ts";

test("platform ownership is enabled only by the explicit deployment flag", () => {
  assert.equal(platformManagedConfiguration({ DEVILUDO_PLATFORM_MANAGED_CONFIGURATION: "1" }), true);
  assert.equal(configurationOwnership({ DEVILUDO_PLATFORM_MANAGED_CONFIGURATION: "1" }), "platform");
  for (const value of [undefined, "", "0", "true", "yes"]) {
    assert.equal(platformManagedConfiguration({ DEVILUDO_PLATFORM_MANAGED_CONFIGURATION: value }), false);
  }
});

test("managed Workspace routes hide provider/server administration and redact project selection projections", () => {
  const settingsPage = readFileSync(new URL("../app/settings/agents/page.tsx", import.meta.url), "utf8");
  const settingsApi = readFileSync(new URL("../app/api/settings/agents/route.ts", import.meta.url), "utf8");
  const projectApi = readFileSync(new URL("../app/api/projects/[projectId]/agent-settings/route.ts", import.meta.url), "utf8");
  const projectUi = readFileSync(new URL("../components/console/ProjectAgentSettings.tsx", import.meta.url), "utf8");

  assert.match(settingsPage, /platformManagedConfiguration\(\)[\s\S]*notFound\(\)/);
  assert.match(settingsApi, /PLATFORM_MANAGED_CONFIGURATION/);
  assert.match(projectApi, /platformManagedProjectProjection/);
  assert.doesNotMatch(projectApi, /credentialVersionId:\s*profile\.credentialVersionId/);
  assert.doesNotMatch(projectApi, /baseUrl:\s*provider\.baseUrl/);
  assert.match(projectUi, /API Key、Base URL 与执行服务器均由 DeviLudo Platform 管理员集中配置/);
  assert.doesNotMatch(projectUi, /href="\/settings\/agents"/);
});

test("the shared Agent console owns Provider secrets and both execution server pools", () => {
  const source = readFileSync(new URL("../components/admin/AgentAdminDashboard.tsx", import.meta.url), "utf8");
  assert.match(source, /id: "execution", label: "执行服务器"/);
  assert.match(source, /E2E 测试服务器/);
  assert.match(source, /Agent 开发服务器/);
  assert.match(source, /OUTBOUND MTLS/);
  assert.match(source, /Base URL/);
  assert.match(source, /API Key/);
});
