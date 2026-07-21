import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { agentAdminCapabilities } from "../lib/admin/agent-permissions.ts";
import { trustedAgentVersionUrl } from "../lib/admin/agent-ui.ts";

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

test("Agent version discovery accepts an exact version and reuses the observed local CLI", () => {
  const source = readFileSync(new URL("../components/admin/AgentAdminDashboard.tsx", import.meta.url), "utf8");

  assert.match(source, /const \[discoveryVersion, setDiscoveryVersion\] = useState\(""\);/);
  assert.match(source, /localAgents\.find\(\(item\) => item\.agent === agent\)\?\.observedVersion/);
  assert.match(source, /\{ agent, \.\.\.\(requestedVersion \? \{ version: requestedVersion \} : \{\}\) \}/);
  assert.match(source, /aria-label="要发现的精确 Agent 版本"/);
  assert.match(source, /row\.sourceUrl/);
  assert.match(source, /row\.releaseNotesUrl/);
});

test("Agent version links accept only the fixed official source and release-note hosts", () => {
  assert.equal(
    trustedAgentVersionUrl("claude-code", "2.1.201", "source", "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.201.tgz"),
    "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.201.tgz",
  );
  assert.equal(
    trustedAgentVersionUrl("codex-cli", "0.145.0-alpha.18", "source", "https://github.com/openai/codex"),
    "https://github.com/openai/codex",
  );
  assert.equal(
    trustedAgentVersionUrl("codex-cli", "0.145.0-alpha.18", "release-notes", "https://github.com/openai/codex/releases/tag/rust-v0.145.0-alpha.18"),
    "https://github.com/openai/codex/releases/tag/rust-v0.145.0-alpha.18",
  );
  for (const value of [
    "https://registry.npmjs.org.evil.example/@openai/codex/-/codex-1.0.0.tgz",
    "https://user:password@github.com/openai/codex/releases",
    "https://github.com/openai/codex/releases?token=secret",
    "http://github.com/openai/codex/releases",
  ]) {
    assert.throws(() => trustedAgentVersionUrl("codex-cli", "0.145.0-alpha.18", value.includes("tgz") ? "source" : "release-notes", value), /URL|允许列表/);
  }
  assert.throws(() => trustedAgentVersionUrl(
    "codex-cli",
    "0.145.0-alpha.18",
    "source",
    "https://registry.npmjs.org/@openai/codex/-/codex-0.144.0.tgz",
  ), /允许列表/);
});

test("credential lifecycle controls call the real rotate and revoke APIs", () => {
  const admin = readFileSync(new URL("../components/admin/AgentAdminDashboard.tsx", import.meta.url), "utf8");
  const tenant = readFileSync(new URL("../components/console/TenantAgentSettings.tsx", import.meta.url), "utf8");

  assert.match(admin, /adminRequest\(`credentials\/\$\{encodeURIComponent\(matchingCredential\.id\)\}\/rotate`/);
  assert.match(admin, /adminRequest\(`credentials\/\$\{encodeURIComponent\(credential\.id\)\}\/revoke`/);
  assert.match(admin, /credential\.id === selectedActiveProvider\?\.credentialVersionId/);
  assert.doesNotMatch(admin, /已创建双版本轮换草稿/);
  assert.match(admin, /setApiKey\(""\);[\s\S]*setTesting\(false\);/);

  assert.match(tenant, /\/api\/settings\/agents\/credentials\/\$\{encodeURIComponent\(credentialId\)\}\/rotate/);
  assert.match(tenant, /\/api\/settings\/agents\/credentials\/\$\{encodeURIComponent\(credential\.id\)\}\/revoke/);
  assert.match(tenant, /window\.confirm\(/);
});
