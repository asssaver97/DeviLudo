import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeCodeAdapter, CodexCliAdapter } from "../adapters/index.ts";
import { normalizeModelRoles } from "../lib/agent/providers.ts";
import { selectRunnableProfile } from "../lib/agent/provider-selection.ts";
import { fingerprintSecret, issueRunToken, verifyRunToken, verifyRunTokenIntegrity } from "../lib/security/credentials.ts";
import { validateEndpointForConnection, validateProviderBaseUrl } from "../lib/security/network.ts";
import {
  GitHubAuthorizationBrokerClient,
  githubCallbackIdempotencyKey,
  signTrustedGitHubSession,
  verifyTrustedGitHubSession,
  verifyTrustedPlatformSession,
} from "../lib/connections/github-broker.ts";
import { SteamEnrollmentBrokerClient } from "../lib/connections/steam-broker.ts";
import { ReleaseAuthorizationBrokerClient } from "../lib/releases/publish-broker.ts";
import { POST as acceptAndPublish } from "../app/api/releases/[releaseId]/accept-and-publish/route.ts";
import { POST as issueInvitation } from "../app/api/admin/invitations/route.ts";
import { isLoopbackTestRequest } from "../lib/security/local-test-mode.ts";
import { createAdminPrincipalSignature } from "../services/control-plane/src/admin-principal.ts";
import {
  BROWSER_BINDING_COOKIE,
  SESSION_COOKIE,
  IdentityBrokerClient,
  browserSessionCookies,
  secureCookie,
} from "../lib/auth/identity-broker.ts";

const digest = `sha256:${"a".repeat(64)}`;

test("local fixture authorization requires explicit mode, non-production and a real loopback URL", () => {
  const loopback = new Request("http://127.0.0.1:3000/api/admin/agents");
  assert.equal(isLoopbackTestRequest(loopback, { NODE_ENV: "development", DEVILUDO_LOCAL_TEST_MODE: "1" }), true);
  assert.equal(isLoopbackTestRequest(loopback, { NODE_ENV: "development" }), false);
  assert.equal(isLoopbackTestRequest(loopback, { NODE_ENV: "production", DEVILUDO_LOCAL_TEST_MODE: "1" }), false);
  assert.equal(isLoopbackTestRequest(
    new Request("https://app.deviludo.example/api/admin/agents", { headers: { host: "127.0.0.1:3000" } }),
    { NODE_ENV: "development", DEVILUDO_LOCAL_TEST_MODE: "1" },
  ), false);
});

function profile(agent) {
  const primaryModel = agent === "claude-code" ? "claude-sonnet-4-6-20250514" : "gpt-5.3-codex-2026-06-12";
  return {
    profileRevisionId: `profile-${agent}-r1`, profileId: `profile-${agent}`, revision: 1, agent,
    installation: { installationId: `install-${agent}`, agent, cliVersion: "1.2.3", imageDigest: digest, adapterVersion: "adapter-1", workerPoolId: "dev-linux" },
    providerRevisionId: `provider-${agent}-r1`, models: normalizeModelRoles({ primaryModel }),
    credential: { bindingId: `binding-${agent}`, credentialVersionId: `credential-${agent}-v1` },
    budget: { maxTurns: 30, maxCostUsd: 12 }, timeoutSeconds: 1800,
    permissions: { sandbox: "workspace-write", network: "inference-gateway-only", scmWrite: "proxy-only", allowProjectHooks: false, allowProjectMcp: false, allowProjectPlugins: false },
    allowedFallbackProfileRevisionIds: [],
  };
}

const context = {
  tenantId: "tenant-1", projectId: "project-1", runId: "run-1", attemptId: "attempt-1",
  commitSha: "8b7e4a2b7c9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f", specificationRevisionId: "SPEC-008",
  testPlanRevisionId: "test-plan-1", runRoot: "/runs/run-1", inferenceGatewayUrl: "https://inference.internal.example/v1",
  runTokenSecretRef: "vault://transit/run-token/run-1",
};

test("adapters pin safe CLI arguments and route only through the internal gateway", () => {
  const claude = new ClaudeCodeAdapter();
  const claudeRuntime = claude.start(claude.prepare(context, profile("claude-code")), "Implement the approved spec", "/workspace");
  assert.equal(claudeRuntime.executable, "claude");
  assert.ok(claudeRuntime.args.includes("--no-session-persistence"));
  assert.equal(claudeRuntime.env.DISABLE_UPDATES, "1");
  assert.equal(claudeRuntime.env.ANTHROPIC_BASE_URL, context.inferenceGatewayUrl);
  assert.equal(claudeRuntime.secretEnv.ANTHROPIC_API_KEY, context.runTokenSecretRef);
  assert.doesNotMatch(JSON.stringify(claudeRuntime), /dangerously-skip|--yolo/);

  const codex = new CodexCliAdapter();
  const codexRuntime = codex.start(codex.prepare(context, profile("codex-cli")), "Implement the approved spec", "/workspace");
  assert.deepEqual(codexRuntime.args.slice(0, 3), ["exec", "--json", "--ephemeral"]);
  assert.ok(codexRuntime.args.includes("--output-schema"));
  assert.ok(codexRuntime.args.includes("workspace-write"));
  assert.equal(codexRuntime.secretEnv.DEVILUDO_RUN_TOKEN, context.runTokenSecretRef);
});

test("provider validation blocks static and DNS-based SSRF", async () => {
  for (const url of ["http://api.example.com", "https://127.0.0.1", "https://169.254.169.254", "https://user:pass@api.example.com", "https://api.example.com?key=secret", "https://api.example.com:8443"]) {
    assert.throws(() => validateProviderBaseUrl(url), /HTTPS|non-public|user|query|approved/);
  }
  const resolver = { resolve: async () => [{ address: "10.0.0.4", family: 4 }] };
  await assert.rejects(validateEndpointForConnection("https://provider.example.com", resolver), /non-public/);
  const publicResolver = { resolve: async () => [{ address: "93.184.216.34", family: 4 }] };
  const endpoint = await validateEndpointForConnection("https://provider.example.com/v1", publicResolver);
  assert.equal(endpoint.port, 443);
  assert.equal(endpoint.connectAddresses[0].address, "93.184.216.34");
});

test("no fallback means provider failure pauses instead of switching Agent", () => {
  const primary = profile("claude-code");
  const selection = selectRunnableProfile({ primary, primaryHealth: "UNAVAILABLE", projectAllowedFallbackProfileRevisionIds: [] });
  assert.equal(selection.state, "WAITING_PROVIDER");
  assert.equal(selection.usedFallback, false);
  assert.equal(selection.profile, undefined);
});

test("credentials are fingerprinted and short run tokens are bound to one run", async () => {
  const fingerprint = await fingerprintSecret(new TextEncoder().encode("secret-value-long-enough"));
  assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/);
  const key = new Uint8Array(32).fill(7);
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "deviludo-control-plane", aud: "deviludo-inference-gateway", tenantId: "tenant-1", projectId: "project-1", runId: "run-1",
    profileRevisionId: "profile-r1", credentialVersionId: "credential-v1", providerRevisionId: "provider-r1",
    models: ["claude-sonnet-4-6-20250514"], budget: { maxCostUsd: 10 }, iat: now, exp: now + 600, nonce: "nonce-1",
  };
  const token = await issueRunToken(key, claims);
  const verified = await verifyRunToken(key, token, { tenantId: "tenant-1", projectId: "project-1", runId: "run-1", profileRevisionId: "profile-r1" }, now + 1);
  assert.equal(verified.credentialVersionId, "credential-v1");
  const integrity = await verifyRunTokenIntegrity(key, token, now + 1);
  assert.equal(Object.isFrozen(integrity.models), true);
  assert.equal(Object.isFrozen(integrity.budget), true);
  await assert.rejects(verifyRunToken(key, token, { tenantId: "tenant-1", projectId: "other", runId: "run-1", profileRevisionId: "profile-r1" }, now + 1), /binding mismatch/);
});

test("GitHub connection session assertions bind identity, method and callback path", async () => {
  const key = new Uint8Array(32).fill(19);
  const at = new Date("2026-07-17T00:00:00.000Z");
  const values = {
    tenantId: "tenant-001",
    userId: "user-001",
    sessionBinding: "session-binding-with-at-least-thirty-two-random-characters",
    githubUserId: "424242",
    issuedAt: String(at.getTime()),
  };
  const signature = await signTrustedGitHubSession({
    method: "POST",
    pathname: "/api/connections/github",
    ...values,
    key,
  });
  const headers = {
    "x-deviludo-session-tenant": values.tenantId,
    "x-deviludo-session-user": values.userId,
    "x-deviludo-session-binding": values.sessionBinding,
    "x-deviludo-session-github-user-id": values.githubUserId,
    "x-deviludo-session-issued-at": values.issuedAt,
    "x-deviludo-session-signature": signature,
  };
  const principal = await verifyTrustedGitHubSession(
    new Request("https://deviludo.example/api/connections/github", { method: "POST", headers }),
    key,
    at,
  );
  assert.equal(principal.expectedGithubUserId, 424242);
  await assert.rejects(
    verifyTrustedGitHubSession(
      new Request("https://deviludo.example/api/connections/github/callback", { method: "POST", headers }),
      key,
      at,
    ),
    /signature is invalid/,
  );
});

test("browser identity client accepts only fixed session contracts and rejects cookie smuggling", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const userId = "22222222-2222-4222-8222-222222222222";
  const membershipId = "33333333-3333-4333-8333-333333333333";
  const random = new Uint8Array(32).fill(4);
  const browserBinding = Buffer.from(random).toString("base64url");
  const sessionToken = `${tenantId}.${Buffer.from(new Uint8Array(32).fill(5)).toString("base64url")}`;
  const broker = new IdentityBrokerClient({ endpoint: "https://identity.internal/", async fetch(url, init) {
    assert.equal(String(url), "https://identity.internal/v1/sessions/assert");
    assert.equal(init.redirect, "error");
    return Response.json({ tenantId, tenantSlug: "north-dock", tenantName: "North Dock", userId, membershipId,
      role: "ProjectOwner", githubUserId: 4242, githubNodeId: "MDQ6VXNlcjQyNDI=", githubLogin: "octocat",
      displayName: "The Octocat", avatarUrl: "https://avatars.githubusercontent.com/u/4242?v=4",
      sessionBinding: Buffer.from(new Uint8Array(32).fill(6)).toString("base64url"),
      issuedAt: "1970000000000", signature: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url") });
  } });
  assert.equal((await broker.assert({ sessionToken, browserBinding, method: "GET", pathname: "/api/projects" })).githubUserId, 4242);
  const request = new Request("https://deviludo.example/api/projects", { headers: {
    cookie: `${SESSION_COOKIE}=${sessionToken}; ${BROWSER_BINDING_COOKIE}=${browserBinding}`,
  } });
  assert.deepEqual(browserSessionCookies(request), { sessionToken, browserBinding });
  assert.match(secureCookie(SESSION_COOKIE, sessionToken, "2032-01-01T00:00:00.000Z"), /HttpOnly; Secure; SameSite=Lax/);
  assert.throws(() => browserSessionCookies(new Request(request.url, { headers: {
    cookie: `${SESSION_COOKIE}=${sessionToken}; ${SESSION_COOKIE}=${sessionToken}; ${BROWSER_BINDING_COOKIE}=${browserBinding}`,
  } })), /Duplicate/);
  assert.throws(() => new IdentityBrokerClient({ endpoint: "http://identity.internal/" }), /contract/);
});

test("platform APIs exchange browser cookies for a fresh route-bound Broker assertion", async () => {
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.DEVILUDO_IDENTITY_BROKER_URL;
  const key = new Uint8Array(32).fill(29);
  const at = new Date("2032-01-02T03:04:05.000Z");
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const userId = "22222222-2222-4222-8222-222222222222";
  const membershipId = "33333333-3333-4333-8333-333333333333";
  const browserBinding = Buffer.from(new Uint8Array(32).fill(8)).toString("base64url");
  const sessionToken = `${tenantId}.${Buffer.from(new Uint8Array(32).fill(9)).toString("base64url")}`;
  const sessionBinding = Buffer.from(new Uint8Array(32).fill(10)).toString("base64url");
  const issuedAt = String(at.getTime());
  const signature = await signTrustedGitHubSession({ method: "GET", pathname: "/api/projects", tenantId, userId,
    sessionBinding, githubUserId: "4242", issuedAt, key });
  try {
    process.env.DEVILUDO_IDENTITY_BROKER_URL = "https://identity.internal/";
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://identity.internal/v1/sessions/assert");
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { sessionToken, browserBinding, method: "GET", pathname: "/api/projects" });
      return Response.json({ tenantId, tenantSlug: "north-dock", tenantName: "North Dock", userId, membershipId,
        role: "ProjectOwner", githubUserId: 4242, githubNodeId: "MDQ6VXNlcjQyNDI=", githubLogin: "octocat",
        displayName: "The Octocat", avatarUrl: "https://avatars.githubusercontent.com/u/4242?v=4",
        sessionBinding, issuedAt, signature });
    };
    const principal = await verifyTrustedPlatformSession(new Request("https://deviludo.example/api/projects", { headers: {
      cookie: `${SESSION_COOKIE}=${sessionToken}; ${BROWSER_BINDING_COOKIE}=${browserBinding}`,
    } }), key, at);
    assert.deepEqual(principal, { tenantId, userId, sessionBinding, githubUserId: 4242 });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint === undefined) delete process.env.DEVILUDO_IDENTITY_BROKER_URL;
    else process.env.DEVILUDO_IDENTITY_BROKER_URL = originalEndpoint;
  }
});

test("TenantAdmin invitation issuance is tenant-bound, role-narrowing and never persists the raw link in Web state", async () => {
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.DEVILUDO_IDENTITY_BROKER_URL;
  const originalAdminEndpoint = process.env.DEVILUDO_IDENTITY_ADMIN_BROKER_URL;
  const originalSessionKey = process.env.DEVILUDO_SESSION_HMAC_KEY;
  const key = new Uint8Array(32).fill(31);
  const at = new Date();
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const userId = "22222222-2222-4222-8222-222222222222";
  const membershipId = "33333333-3333-4333-8333-333333333333";
  const browserBinding = Buffer.from(new Uint8Array(32).fill(11)).toString("base64url");
  const sessionToken = `${tenantId}.${Buffer.from(new Uint8Array(32).fill(12)).toString("base64url")}`;
  const sessionBinding = Buffer.from(new Uint8Array(32).fill(13)).toString("base64url");
  const issuedAt = String(at.getTime());
  const signature = await signTrustedGitHubSession({ method: "POST", pathname: "/api/admin/invitations", tenantId, userId,
    sessionBinding, githubUserId: "4242", issuedAt, key });
  const invitationToken = `${tenantId}.${Buffer.from(new Uint8Array(32).fill(14)).toString("base64url")}`;
  try {
    process.env.DEVILUDO_IDENTITY_BROKER_URL = "https://identity.internal/";
    process.env.DEVILUDO_IDENTITY_ADMIN_BROKER_URL = "https://identity-admin.internal/";
    process.env.DEVILUDO_SESSION_HMAC_KEY = Buffer.from(key).toString("base64url");
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/v1/sessions/assert")) return Response.json({ tenantId, tenantSlug: "north-dock", tenantName: "North Dock",
        userId, membershipId, role: "TenantAdmin", githubUserId: 4242, githubNodeId: "MDQ6VXNlcjQyNDI=", githubLogin: "octocat",
        displayName: "The Octocat", avatarUrl: "https://avatars.githubusercontent.com/u/4242?v=4", sessionBinding, issuedAt, signature });
      assert.equal(String(url), "https://identity-admin.internal/v1/invitations");
      const body = JSON.parse(init.body);
      assert.equal(body.tenantId, tenantId); assert.equal(body.role, "ProjectOwner"); assert.equal(body.createdBy, userId);
      return Response.json({ invitationToken, invitationId: "44444444-4444-4444-8444-444444444444", expiresAt: body.expiresAt }, { status: 201 });
    };
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const response = await issueInvitation(new Request("https://deviludo.example/api/admin/invitations", { method: "POST",
      headers: { "content-type": "application/json", origin: "https://deviludo.example", cookie: `${SESSION_COOKIE}=${sessionToken}; ${BROWSER_BINDING_COOKIE}=${browserBinding}` },
      body: JSON.stringify({ tenantId, role: "ProjectOwner", expiresAt }) }));
    assert.equal(response.status, 201); const payload = await response.json();
    assert.match(payload.data.invitationUrl, /^https:\/\/deviludo\.example\/api\/auth\/github\?invite=/);
    assert.doesNotMatch(JSON.stringify(payload.data), /invitationToken/);
    const escalation = await issueInvitation(new Request("https://deviludo.example/api/admin/invitations", { method: "POST",
      headers: { "content-type": "application/json", origin: "https://deviludo.example", cookie: `${SESSION_COOKIE}=${sessionToken}; ${BROWSER_BINDING_COOKIE}=${browserBinding}` },
      body: JSON.stringify({ tenantId, role: "TenantAdmin", expiresAt }) }));
    assert.equal(escalation.status, 403);
    const crossOrigin = await issueInvitation(new Request("https://deviludo.example/api/admin/invitations", { method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.deviludo.example",
        cookie: `${SESSION_COOKIE}=${sessionToken}; ${BROWSER_BINDING_COOKIE}=${browserBinding}` },
      body: JSON.stringify({ tenantId, role: "ProjectOwner", expiresAt }) }));
    assert.equal(crossOrigin.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("DEVILUDO_IDENTITY_BROKER_URL", originalEndpoint); restoreEnv("DEVILUDO_IDENTITY_ADMIN_BROKER_URL", originalAdminEndpoint);
    restoreEnv("DEVILUDO_SESSION_HMAC_KEY", originalSessionKey);
  }
});

test("platform administrator invitation issuance requires the existing signed admin principal", async () => {
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.DEVILUDO_IDENTITY_ADMIN_BROKER_URL;
  const originalAdminKey = process.env.DEVILUDO_ADMIN_SESSION_HMAC_KEY;
  const key = Buffer.alloc(32, 41); const issuedAt = new Date().toISOString();
  const assertion = { method: "POST", path: "/api/admin/invitations", actorId: "platform-admin-1", role: "PlatformAgentAdmin",
    tenantId: null, projectId: null, sessionId: "admin-session-1", issuedAt };
  const signature = createAdminPrincipalSignature(assertion, key);
  const tenantId = "11111111-1111-4111-8111-111111111111";
  try {
    process.env.DEVILUDO_IDENTITY_ADMIN_BROKER_URL = "https://identity-admin.internal/";
    process.env.DEVILUDO_ADMIN_SESSION_HMAC_KEY = key.toString("base64");
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://identity-admin.internal/v1/invitations"); const body = JSON.parse(init.body);
      assert.equal(body.createdBy, assertion.actorId); assert.equal(body.role, "TenantAdmin");
      return Response.json({ invitationToken: `${tenantId}.${Buffer.from(new Uint8Array(32).fill(15)).toString("base64url")}`,
        invitationId: "44444444-4444-4444-8444-444444444444", expiresAt: body.expiresAt }, { status: 201 });
    };
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const headers = { "content-type": "application/json", "x-deviludo-role": assertion.role, "x-deviludo-actor": assertion.actorId,
      "x-deviludo-admin-session": assertion.sessionId, "x-deviludo-admin-issued-at": issuedAt, "x-deviludo-admin-signature": signature };
    const response = await issueInvitation(new Request("https://deviludo.example/api/admin/invitations", { method: "POST", headers,
      body: JSON.stringify({ tenantId, role: "TenantAdmin", expiresAt }) }));
    assert.equal(response.status, 201);
    const forged = await issueInvitation(new Request("https://deviludo.example/api/admin/invitations", { method: "POST",
      headers: { "content-type": "application/json", "x-deviludo-role": "PlatformAgentAdmin" },
      body: JSON.stringify({ tenantId, role: "TenantAdmin", expiresAt }) }));
    assert.equal(forged.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("DEVILUDO_IDENTITY_ADMIN_BROKER_URL", originalEndpoint); restoreEnv("DEVILUDO_ADMIN_SESSION_HMAC_KEY", originalAdminKey);
  }
});

test("GitHub Web broker client accepts only fixed GitHub redirects and hashes callback idempotency", async () => {
  const state = "s".repeat(43);
  const challenge = "c".repeat(43);
  const requests = [];
  const broker = new GitHubAuthorizationBrokerClient({
    endpoint: "https://github-auth.internal/",
    async fetch(url, init) {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/begin")) {
        return Response.json({
          authorizeUrl: `https://github.com/apps/deviludo/installations/new?state=${state}`,
          expiresAt: "2026-07-17T00:10:00.000Z",
        });
      }
      if (String(url).endsWith("/setup")) {
        return Response.json({
          authorizeUrl: `https://github.com/login/oauth/authorize?client_id=Iv1.abcdefghijklmnop&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`,
          expiresAt: "2026-07-17T00:10:00.000Z",
        });
      }
      return Response.json({ returnPath: "/settings/connections" });
    },
  });
  const principal = {
    tenantId: "tenant-001",
    userId: "user-001",
    sessionBinding: "session-binding-with-at-least-thirty-two-random-characters",
    expectedGithubUserId: 424242,
  };
  const begin = await broker.begin(principal, "github-begin-001");
  assert.match(begin.authorizeUrl, /^https:\/\/github\.com\/apps\//);
  const setup = await broker.setup({
    principal,
    state,
    installationId: "99",
    setupAction: "install",
    idempotencyKey: "github-setup-001",
  });
  assert.match(setup.authorizeUrl, /code_challenge_method=S256/);
  assert.equal((await broker.complete({ principal, state, code: "oauth-code-value", idempotencyKey: "github-oauth-001" })).returnPath, "/settings/connections");
  assert.equal(requests.every((entry) => entry.init.redirect === "error"), true);
  const callbackKey = await githubCallbackIdempotencyKey("oauth", state);
  assert.match(callbackKey, /^github-oauth-[a-f0-9]{64}$/);
  assert.doesNotMatch(callbackKey, new RegExp(state));

  const malicious = new GitHubAuthorizationBrokerClient({
    endpoint: "https://github-auth.internal/",
    fetch: async () => Response.json({
      authorizeUrl: `https://evil.example/install?state=${state}`,
      expiresAt: "2026-07-17T00:10:00.000Z",
    }),
  });
  await assert.rejects(malicious.begin(principal, "github-begin-evil"), /invalid installation URL/);
});

test("Steam enrollment client sends no password and accepts only the configured isolated UI", async () => {
  const calls = [];
  const broker = new SteamEnrollmentBrokerClient({
    endpoint: "https://steam-enrollment.internal/",
    publicOrigin: "https://steam-enroll.deviludo.example/",
    now: () => new Date("2026-07-17T00:00:00.000Z"),
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      return Response.json({
        enrollmentId: "enrollment-001",
        state: "WAITING_STEAM_GUARD",
        enrollmentUrl: "https://steam-enroll.deviludo.example/enrollments/enrollment-001",
        expiresAt: "2026-07-17T00:10:00.000Z",
      });
    },
  });
  const result = await broker.begin({
    tenantId: "tenant-001",
    userId: "user-001",
    sessionBinding: "session-binding-with-at-least-thirty-two-random-characters",
    githubUserId: 424242,
  }, "steam-enrollment-001");
  assert.equal(result.state, "WAITING_STEAM_GUARD");
  assert.equal(result.enrollmentUrl, "https://steam-enroll.deviludo.example/enrollments/enrollment-001");
  const serializedRequest = JSON.stringify(calls[0]);
  assert.doesNotMatch(serializedRequest, /password|guardCode|config\.vdf/i);
  assert.equal(calls[0].init.redirect, "error");

  const malicious = new SteamEnrollmentBrokerClient({
    endpoint: "https://steam-enrollment.internal/",
    publicOrigin: "https://steam-enroll.deviludo.example/",
    now: () => new Date("2026-07-17T00:00:00.000Z"),
    fetch: async () => Response.json({
      enrollmentId: "enrollment-001",
      state: "WAITING_STEAM_GUARD",
      enrollmentUrl: "https://evil.example/enrollments/enrollment-001",
      expiresAt: "2026-07-17T00:10:00.000Z",
    }),
  });
  await assert.rejects(
    malicious.begin({ tenantId: "tenant-001", userId: "user-001", sessionBinding: "x".repeat(40), githubUserId: 424242 }, "steam-enrollment-evil"),
    /URL is invalid/,
  );
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("release authorization sends no client evidence or MFA proof and pins the isolated challenge UI", async () => {
  const calls = [];
  const broker = new ReleaseAuthorizationBrokerClient({
    endpoint: "https://release-authorization.internal/",
    publicOrigin: "https://mfa.deviludo.example/",
    now: () => new Date("2026-07-17T00:00:00.000Z"),
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      return Response.json({
        releaseId: "release-001",
        state: "MFA_REQUIRED",
        approvalId: "approval-001",
        authorizationUrl: "https://mfa.deviludo.example/approvals/approval-001",
        workflowId: null,
        expiresAt: "2026-07-17T00:05:00.000Z",
      });
    },
  });
  const result = await broker.begin({
    tenantId: "tenant-001",
    userId: "user-001",
    sessionBinding: "session-binding-with-at-least-thirty-two-random-characters",
    githubUserId: 424242,
  }, "release-001", "release-authorization-001");
  assert.equal(result.state, "MFA_REQUIRED");
  assert.equal(result.authorizationUrl, "https://mfa.deviludo.example/approvals/approval-001");
  assert.equal(calls[0].init.redirect, "error");
  assert.doesNotMatch(JSON.stringify(calls[0]), /mainCommitSha|evidenceStatus|mfaProof|x-mfa-proof/i);

  const malicious = new ReleaseAuthorizationBrokerClient({
    endpoint: "https://release-authorization.internal/",
    publicOrigin: "https://mfa.deviludo.example/",
    now: () => new Date("2026-07-17T00:00:00.000Z"),
    fetch: async () => Response.json({
      releaseId: "release-001",
      state: "MFA_REQUIRED",
      approvalId: "approval-001",
      authorizationUrl: "https://evil.example/approvals/approval-001",
      workflowId: null,
      expiresAt: "2026-07-17T00:05:00.000Z",
    }),
  });
  await assert.rejects(
    malicious.begin({ tenantId: "tenant-001", userId: "user-001", sessionBinding: "x".repeat(40), githubUserId: 424242 }, "release-001", "release-authorization-evil"),
    /URL is invalid/,
  );
});

test("accept-and-publish production route trusts only signed session context and its fixed broker", async () => {
  const key = new Uint8Array(32).fill(29);
  const at = new Date();
  const pathname = "/api/releases/release-001/accept-and-publish";
  const values = {
    tenantId: "tenant-001",
    userId: "user-001",
    sessionBinding: "session-binding-with-at-least-thirty-two-random-characters",
    githubUserId: "424242",
    issuedAt: String(at.getTime()),
  };
  const signature = await signTrustedGitHubSession({ method: "POST", pathname, ...values, key });
  const headers = {
    "idempotency-key": "release-authorization-route-001",
    "x-deviludo-session-tenant": values.tenantId,
    "x-deviludo-session-user": values.userId,
    "x-deviludo-session-binding": values.sessionBinding,
    "x-deviludo-session-github-user-id": values.githubUserId,
    "x-deviludo-session-issued-at": values.issuedAt,
    "x-deviludo-session-signature": signature,
  };
  const previous = {
    endpoint: process.env.DEVILUDO_RELEASE_AUTHORIZATION_BROKER_URL,
    publicOrigin: process.env.DEVILUDO_RELEASE_AUTHORIZATION_PUBLIC_ORIGIN,
    key: process.env.DEVILUDO_SESSION_HMAC_KEY,
    fetch: globalThis.fetch,
  };
  const brokerCalls = [];
  process.env.DEVILUDO_RELEASE_AUTHORIZATION_BROKER_URL = "https://release-authorization.internal/";
  process.env.DEVILUDO_RELEASE_AUTHORIZATION_PUBLIC_ORIGIN = "https://mfa.deviludo.example/";
  process.env.DEVILUDO_SESSION_HMAC_KEY = Buffer.from(key).toString("base64url");
  globalThis.fetch = async (url, init) => {
    brokerCalls.push({ url: String(url), init });
    return Response.json({
      releaseId: "release-001",
      state: "MFA_REQUIRED",
      approvalId: "approval-001",
      authorizationUrl: "https://mfa.deviludo.example/approvals/approval-001",
      workflowId: null,
      expiresAt: new Date(at.getTime() + 5 * 60_000).toISOString(),
    });
  };
  try {
    const response = await acceptAndPublish(
      new Request(`https://deviludo.example${pathname}`, { method: "POST", headers }),
      { params: Promise.resolve({ releaseId: "release-001" }) },
    );
    assert.equal(response.status, 202);
    assert.equal((await response.json()).data.state, "MFA_REQUIRED");
    assert.equal(brokerCalls.length, 1);
    assert.doesNotMatch(JSON.stringify(brokerCalls[0]), /mainCommitSha|evidenceStatus|mfaProof|x-mfa-proof/i);

    const rejected = await acceptAndPublish(
      new Request(`https://deviludo.example${pathname}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "x-mfa-proof": "forged" },
        body: JSON.stringify({ evidenceStatus: "PASSED" }),
      }),
      { params: Promise.resolve({ releaseId: "release-001" }) },
    );
    assert.equal(rejected.status, 400);
    assert.equal(brokerCalls.length, 1);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [name, value] of [
      ["DEVILUDO_RELEASE_AUTHORIZATION_BROKER_URL", previous.endpoint],
      ["DEVILUDO_RELEASE_AUTHORIZATION_PUBLIC_ORIGIN", previous.publicOrigin],
      ["DEVILUDO_SESSION_HMAC_KEY", previous.key],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
