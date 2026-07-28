import assert from "node:assert/strict";
import test from "node:test";
import { GET as adminGet } from "../app/api/admin/[...segments]/route.ts";
import { GET as tenantSettingsGet } from "../app/api/settings/agents/route.ts";
import { isTrustedLocalScopedAgentRequest, localAdminRequest } from "../lib/admin/scoped-agent-proxy.ts";

const principal = {
  accountId: "11111111-1111-4111-8111-111111111111",
  email: "operator@example.com",
  displayName: "Operator",
  avatarUrl: null,
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspaceSlug: "operator-workspace",
  workspaceName: "Operator workspace",
  membershipId: "33333333-3333-4333-8333-333333333333",
  role: "Owner",
  platformRole: "TenantAdmin",
  sessionId: "44444444-4444-4444-8444-444444444444",
};

test("platform-managed admin API ignores caller role escalation and rejects ordinary Workspace sessions", async () => {
  const previous = {
    managed: process.env.DEVILUDO_PLATFORM_MANAGED_CONFIGURATION,
    endpoint: process.env.DEVILUDO_ACCOUNT_API_URL,
    token: process.env.DEVILUDO_INTERNAL_SERVICE_TOKEN,
    insecure: process.env.DEVILUDO_ACCOUNT_ALLOW_INSECURE_LOCAL,
    fetch: globalThis.fetch,
  };
  process.env.DEVILUDO_PLATFORM_MANAGED_CONFIGURATION = "1";
  process.env.DEVILUDO_ACCOUNT_API_URL = "http://account-api:4100";
  process.env.DEVILUDO_INTERNAL_SERVICE_TOKEN = "service-token";
  process.env.DEVILUDO_ACCOUNT_ALLOW_INSECURE_LOCAL = "1";
  let roles = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: { principal, githubUserId: 12345, platformAdminRoles: roles },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const request = () => new Request("http://127.0.0.1:3000/api/admin/agents", { headers: {
    cookie: `deviludo-session=${"s".repeat(43)}`,
    "x-deviludo-role": "SecurityAdmin",
  } });
  try {
    const tenantSettings = await tenantSettingsGet(new Request("http://127.0.0.1:3000/api/settings/agents"));
    assert.equal(tenantSettings.status, 404);
    assert.equal((await tenantSettings.json()).error.code, "PLATFORM_MANAGED_CONFIGURATION");

    const ordinary = await adminGet(request(), { params: Promise.resolve({ segments: ["agents"] }) });
    assert.equal(ordinary.status, 401);

    const scoped = localAdminRequest(
      new Request("http://127.0.0.1:3000/api/projects/project-managed/agent-settings"),
      "/admin/agents",
      "ProjectOwner",
      undefined,
      { actorId: principal.accountId, sessionId: principal.sessionId, tenantId: principal.workspaceId, projectId: "project-managed" },
    );
    assert.equal(isTrustedLocalScopedAgentRequest(scoped), true);
    const scopedProjection = await adminGet(scoped, { params: Promise.resolve({ segments: ["agents"] }) });
    assert.equal(scopedProjection.status, 200);
    assert.equal((await scopedProjection.json()).meta.credentials.length, 0);
    assert.equal(isTrustedLocalScopedAgentRequest(new Request(scoped.url, { headers: scoped.headers })), false);

    roles = ["PlatformAgentAdmin"];
    const administrator = await adminGet(request(), { params: Promise.resolve({ segments: ["agents"] }) });
    assert.equal(administrator.status, 200);
    assert.equal(administrator.headers.get("x-deviludo-effective-role"), "PlatformAgentAdmin");
    assert.equal(administrator.headers.get("x-deviludo-allowed-roles"), "PlatformAgentAdmin");
    assert.equal(administrator.headers.get("x-deviludo-admin-auth-mode"), "account-platform");
  } finally {
    restore("DEVILUDO_PLATFORM_MANAGED_CONFIGURATION", previous.managed);
    restore("DEVILUDO_ACCOUNT_API_URL", previous.endpoint);
    restore("DEVILUDO_INTERNAL_SERVICE_TOKEN", previous.token);
    restore("DEVILUDO_ACCOUNT_ALLOW_INSECURE_LOCAL", previous.insecure);
    globalThis.fetch = previous.fetch;
  }
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
