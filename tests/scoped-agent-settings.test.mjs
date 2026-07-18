import assert from "node:assert/strict";
import test from "node:test";
import { POST as tenantMutation } from "../app/api/settings/agents/[...segments]/route.ts";
import { GET as projectSettings } from "../app/api/projects/[projectId]/agent-settings/route.ts";
import { signTrustedGitHubSession } from "../lib/connections/github-broker.ts";
import { BROWSER_BINDING_COOKIE, SESSION_COOKIE } from "../lib/auth/identity-broker.ts";
import { createAdminPrincipalSignature } from "../services/control-plane/src/admin-principal.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const membershipId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const repositoryBindingId = "55555555-5555-4555-8555-555555555555";
const sessionKey = new Uint8Array(32).fill(71);
const adminKey = Buffer.alloc(32, 72);
const browserBinding = Buffer.from(new Uint8Array(32).fill(73)).toString("base64url");
const sessionToken = `${tenantId}.${Buffer.from(new Uint8Array(32).fill(74)).toString("base64url")}`;
const sessionBinding = Buffer.from(new Uint8Array(32).fill(75)).toString("base64url");

test("TenantAdmin browser session is rebound to its tenant and cannot inject another profile scope", async () => {
  const pathname = "/api/settings/agents/profiles";
  const issuedAt = String(Date.now());
  const sessionSignature = await signTrustedGitHubSession({ method: "POST", pathname, tenantId, userId,
    sessionBinding, githubUserId: "4242", issuedAt, key: sessionKey });
  const previous = snapshotEnvironment();
  let controlPlaneCalls = 0;
  let connectorFailure = null;
  try {
    configureEnvironment();
    globalThis.fetch = async (input, init) => { try {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sessions/assert") {
        return Response.json(sessionPrincipal("TenantAdmin", issuedAt, sessionSignature));
      }
      assert.equal(url.href, "https://admin-control.internal/admin/agent-profiles");
      controlPlaneCalls += 1;
      const headers = new Headers(init.headers);
      const body = JSON.parse(new TextDecoder().decode(init.body));
      assert.equal(body.scope, "tenant");
      assert.equal(body.scopeId, tenantId);
      assert.equal(headers.get("x-deviludo-role"), "TenantAdmin");
      assert.equal(headers.get("x-deviludo-tenant-id"), tenantId);
      assert.equal(headers.has("x-deviludo-project-id"), false);
      assert.equal(headers.has("cookie"), false);
      assertDownstreamSignature(headers, { method: "POST", path: "/admin/agent-profiles", role: "TenantAdmin", projectId: null });
      return Response.json({ data: { profile: { id: "tenant-profile-r1", scope: "tenant", scopeId: tenantId, state: "DRAFT" } } }, { status: 201 });
    } catch (error) { connectorFailure = error; throw error; } };
    const request = browserRequest("POST", pathname, "TenantAdmin", {
      scope: "project", scopeId: "attacker-project", agent: "claude-code",
      installationId: "claude-ready", credentialVersionId: "credential-tenant-v1",
      baseUrl: "https://provider.example/v1", authentication: "x-api-key",
      primaryModel: "claude-sonnet-4-6-20250514", inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15, dataRegion: "cn-east", retentionPolicy: "zero retention", trainingPolicy: "no training",
    });
    const response = await tenantMutation(request, { params: Promise.resolve({ segments: ["profiles"] }) });
    assert.ifError(connectorFailure);
    assert.equal(response.status, 201);
    assert.equal(controlPlaneCalls, 1);

    const crossOrigin = browserRequest("POST", pathname, "TenantAdmin", { agent: "claude-code" }, "https://attacker.example");
    const blocked = await tenantMutation(crossOrigin, { params: Promise.resolve({ segments: ["profiles"] }) });
    assert.equal(blocked.status, 403);
    assert.equal(controlPlaneCalls, 1);
  } finally { restoreEnvironment(previous); }
});

test("ProjectOwner scope is issued only after authoritative project lookup and never from the URL alone", async () => {
  const pathname = `/api/projects/${projectId}/agent-settings`;
  const issuedAt = String(Date.now());
  const sessionSignature = await signTrustedGitHubSession({ method: "GET", pathname, tenantId, userId,
    sessionBinding, githubUserId: "4242", issuedAt, key: sessionKey });
  const previous = snapshotEnvironment();
  let allowProject = false;
  let controlPlaneCalls = 0;
  try {
    configureEnvironment();
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sessions/assert") return Response.json(sessionPrincipal("ProjectOwner", issuedAt, sessionSignature));
      if (url.pathname === "/v1/projects/lookup") {
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body, { principal: { tenantId, userId, githubUserId: 4242 }, projectId });
        if (!allowProject) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ projectId, tenantId, slug: "ember-archipelago", name: "余烬群岛", repositoryBindingId,
          installationId: "9001", repositoryId: 7001, repositoryNodeId: "R_repo", owner: "north-dock",
          repositoryName: "ember-archipelago", defaultBranch: "main", createdAt: "2030-01-01T00:00:00.000Z" });
      }
      assert.equal(url.href, "https://admin-control.internal/admin/agents");
      controlPlaneCalls += 1;
      const headers = new Headers(init.headers);
      assert.equal(headers.get("x-deviludo-role"), "ProjectOwner");
      assert.equal(headers.get("x-deviludo-tenant-id"), tenantId);
      assert.equal(headers.get("x-deviludo-project-id"), projectId);
      assertDownstreamSignature(headers, { method: "GET", path: "/admin/agents", role: "ProjectOwner", projectId });
      return Response.json({ data: { catalog: [], profiles: [], credentials: [], defaults: {} } });
    };
    const denied = await projectSettings(browserRequest("GET", pathname, "ProjectOwner"), { params: Promise.resolve({ projectId }) });
    assert.equal(denied.status, 404);
    assert.equal(controlPlaneCalls, 0);
    allowProject = true;
    const allowed = await projectSettings(browserRequest("GET", pathname, "ProjectOwner"), { params: Promise.resolve({ projectId }) });
    assert.equal(allowed.status, 200);
    assert.equal(controlPlaneCalls, 1);
  } finally { restoreEnvironment(previous); }
});

function browserRequest(method, pathname, _role, body, origin = "https://deviludo.example") {
  return new Request(`https://deviludo.example${pathname}`, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE}=${sessionToken}; ${BROWSER_BINDING_COOKIE}=${browserBinding}`,
      ...(method === "GET" ? {} : { "content-type": "application/json", "idempotency-key": "scoped-agent-test", origin }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function sessionPrincipal(role, issuedAt, signature) {
  return { tenantId, tenantSlug: "north-dock", tenantName: "North Dock", userId, membershipId, role,
    githubUserId: 4242, githubNodeId: "MDQ6VXNlcjQyNDI=", githubLogin: "octocat", displayName: "The Octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/4242?v=4", sessionBinding, issuedAt, signature };
}

function assertDownstreamSignature(headers, expected) {
  const assertion = { method: expected.method, path: expected.path, actorId: userId, role: expected.role,
    tenantId, projectId: expected.projectId, sessionId: sessionBinding, issuedAt: headers.get("x-deviludo-admin-issued-at") };
  assert.equal(headers.get("x-deviludo-admin-signature"), createAdminPrincipalSignature(assertion, adminKey));
}

function configureEnvironment() {
  process.env.DEVILUDO_IDENTITY_BROKER_URL = "https://identity.internal/";
  process.env.DEVILUDO_SESSION_HMAC_KEY = Buffer.from(sessionKey).toString("base64url");
  process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL = "https://project-repository.internal/";
  process.env.DEVILUDO_ADMIN_CONTROL_PLANE_BROKER_URL = "https://admin-control.internal/";
  process.env.DEVILUDO_ADMIN_CONTROL_PLANE_HMAC_KEY = adminKey.toString("base64");
}
function snapshotEnvironment() {
  return { fetch: globalThis.fetch, identity: process.env.DEVILUDO_IDENTITY_BROKER_URL, session: process.env.DEVILUDO_SESSION_HMAC_KEY,
    project: process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL, admin: process.env.DEVILUDO_ADMIN_CONTROL_PLANE_BROKER_URL,
    key: process.env.DEVILUDO_ADMIN_CONTROL_PLANE_HMAC_KEY };
}
function restoreEnvironment(value) {
  globalThis.fetch = value.fetch;
  restore("DEVILUDO_IDENTITY_BROKER_URL", value.identity); restore("DEVILUDO_SESSION_HMAC_KEY", value.session);
  restore("DEVILUDO_PROJECT_REPOSITORY_BROKER_URL", value.project); restore("DEVILUDO_ADMIN_CONTROL_PLANE_BROKER_URL", value.admin);
  restore("DEVILUDO_ADMIN_CONTROL_PLANE_HMAC_KEY", value.key);
}
function restore(name, value) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
