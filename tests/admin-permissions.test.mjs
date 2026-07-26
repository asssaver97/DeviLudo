import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { agentAdminCapabilities } from "../lib/admin/agent-permissions.ts";
import { trustedAgentVersionUrl } from "../lib/admin/agent-ui.ts";
import {
  LOCAL_SHELL_CAPABILITIES,
  adminShellCapabilities,
  tenantShellCapabilities,
} from "../lib/auth/shell-capabilities.ts";

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

test("application shell navigation is derived from authenticated capabilities and live health", () => {
  assert.deepEqual(tenantShellCapabilities("TenantAdmin"), ["connections:manage", "tenant-agents:manage", "invitations:manage"]);
  assert.deepEqual(tenantShellCapabilities("ProjectOwner"), ["connections:manage"]);
  assert.deepEqual(tenantShellCapabilities("Auditor"), ["connections:manage", "tenant-agents:view"]);
  assert.deepEqual(adminShellCapabilities("PlatformAgentAdmin"), ["platform-agents:manage", "invitations:manage"]);
  assert.deepEqual(adminShellCapabilities("SecurityAdmin"), ["platform-agents:manage", "invitations:manage"]);
  assert.deepEqual(adminShellCapabilities("Auditor"), ["platform-agents:view"]);
  assert.equal(LOCAL_SHELL_CAPABILITIES.includes("platform-agents:manage"), true);

  const source = readFileSync(new URL("../components/console/AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /settings\.filter\(\(item\) => item\.capabilities\.some\(\(capability\) => account\.capabilities\.includes\(capability\)\)\)/);
  assert.match(source, /fetch\("\/api\/health"/);
  assert.match(source, /response\.ok && payload\.status === "ok" \? "ok" : "degraded"/);
  assert.match(source, /className=\{`system-pill is-\$\{health\}`\}/);
  assert.match(source, /account\?\.canSignOut/);
  assert.doesNotMatch(source, /className="system-pill"><i \/> 系统正常/);
});

test("new Provider opens an explicit blank draft without mutating the active snapshot", () => {
  const source = readFileSync(new URL("../components/admin/AgentAdminDashboard.tsx", import.meta.url), "utf8");

  assert.match(source, /setProviderEditorKey\(requestId\);[\s\S]*setNewProviderRequest\(requestId\);/);
  assert.match(source, /<ProvidersTab key=\{providerEditorKey\}/);
  assert.match(source, /title=\{editorMode === "new" \? "新建 Provider" : "编辑 Provider"\}/);
  assert.match(source, /const creatingProvider = Boolean\(newDraftRequest\);/);
  assert.match(source, /useState\(creatingProvider \? "" : initialProvider\?\.baseUrl/);
  assert.match(source, /useState\(creatingProvider \? "" : initialProvider\?\.primaryModel/);
  assert.match(source, /useState\(creatingProvider \? "" : initialProvider\?\.models\.subagentModel/);
  assert.match(source, /useState\(creatingProvider \? "" : initialProvider\?\.governance\.dataRegion/);
  assert.match(source, /setDataRegion\(loadExisting \? current\?\.governance\.dataRegion \?\? "新加坡" : ""\);/);
  assert.match(source, /setSubagentModel\(loadExisting \? current\?\.models\.subagentModel \?\? "" : ""\);/);
  assert.match(source, /setMaxBudgetUsd\(String\(currentProfile\?\.budget\.maxUsd \?\? 25\)\);/);
  assert.match(source, /agent === kind && editorMode === "existing"/);
  assert.match(source, /onNewDraftConsumed\(newDraftRequest\)/);
});

test("Agent console distinguishes Provider probe capability from an exact active binding", () => {
  const source = readFileSync(new URL("../components/admin/AgentAdminDashboard.tsx", import.meta.url), "utf8");
  assert.match(source, /activeProviderBinding === "PARTIAL"/);
  assert.match(source, /activeProviderBinding === "BLOCKED"/);
  assert.match(source, /activeProviderBindings\?\.filter\(\(binding\) => binding\.agent === kind\)/);
  assert.match(source, /部分可运行 Profile 的本机 Provider 绑定有效/);
  assert.match(source, /没有与可运行 Profile、精确模型和凭据版本一致的 ACTIVE Provider 绑定/);
  assert.match(source, /` · 本机绑定 \$\{verified\}\/\$\{bindings\.length\}`/);
  assert.match(source, /production \? ""/);
  assert.match(source, /agentCatalogVerified === false/);
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

test("Agent installation upgrades require separate Profile creation, security activation and exact default selection", () => {
  const source = readFileSync(new URL("../components/admin/AgentAdminDashboard.tsx", import.meta.url), "utf8");

  assert.match(source, /agent-profiles\/\$\{encodeURIComponent\(source\.id\)\}\/rebind-installation/);
  assert.match(source, /body: \{ installationId \}/);
  assert.match(source, /生成升级 Profile/);
  assert.match(source, /激活升级 Profile/);
  assert.match(source, /设为平台默认/);
  assert.match(source, /adminRequest\("agent-defaults\/platform", \{ method: "PUT", role, body: \{ profileRevisionId \} \}\)/);
  assert.match(source, /默认选择尚未改变/);
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

test("credential lifecycle controls call rotate, local recovery and revoke APIs with accurate semantics", () => {
  const admin = readFileSync(new URL("../components/admin/AgentAdminDashboard.tsx", import.meta.url), "utf8");
  const tenant = readFileSync(new URL("../components/console/TenantAgentSettings.tsx", import.meta.url), "utf8");
  const project = readFileSync(new URL("../components/console/ProjectAgentSettings.tsx", import.meta.url), "utf8");

  assert.match(admin, /adminRequest\(`credentials\/\$\{encodeURIComponent\(matchingCredential\.id\)\}\/rotate`/);
  assert.match(admin, /adminRequest\(`credentials\/\$\{encodeURIComponent\(matchingCredential\.id\)\}\/restore-local-binding`/);
  assert.match(admin, /adminRequest\(`credentials\/\$\{encodeURIComponent\(credential\.id\)\}\/revoke`/);
  assert.match(admin, /credential\.id === selectedActiveProvider\?\.credentialVersionId/);
  assert.doesNotMatch(admin, /已创建双版本轮换草稿/);
  assert.doesNotMatch(admin, /请为新版本创建 Provider revision/);
  assert.match(admin, /setApiKey\(""\);[\s\S]*setTesting\(false\);/);

  assert.match(tenant, /\/api\/settings\/agents\/credentials\/\$\{encodeURIComponent\(credentialId\)\}\/rotate/);
  assert.match(tenant, /\/api\/settings\/agents\/credentials\/\$\{encodeURIComponent\(credentialId\)\}\/restore-local-binding/);
  assert.match(tenant, /\/api\/settings\/agents\/credentials\/\$\{encodeURIComponent\(credential\.id\)\}\/revoke/);
  assert.match(tenant, /sessionPayload\.data\?\.authMode === "local-fixture"/);
  assert.match(tenant, /window\.confirm\(/);
  assert.match(tenant, /planningModel: String\(form\.get\("planningModel"\)/);
  assert.match(tenant, /smallFastModel: String\(form\.get\("smallFastModel"\)/);
  assert.match(tenant, /subagentModel: String\(form\.get\("subagentModel"\)/);
  assert.match(tenant, /maxTurns: Number\(form\.get\("maxTurns"\)/);
  assert.match(tenant, /timeoutSeconds: Number\(form\.get\("timeoutSeconds"\)/);
  assert.match(tenant, /fallbackProfileRevisionId/);
  assert.match(tenant, /draftInstallations\.map/);

  assert.match(project, /currentProvider\.models\.planningModel/);
  assert.match(project, /currentProvider\.models\.subagentModel/);
  assert.match(project, /current\.budget\.timeoutSeconds/);
  assert.match(project, /profile\.providerRevisionId/);
});
