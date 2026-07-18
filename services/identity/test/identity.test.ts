import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Fastify from "fastify";
import { verifyTrustedPlatformSession } from "../../../lib/connections/github-broker";
import { PlatformIdentityBroker } from "../src/broker";
import type {
  GitHubIdentityVerifier,
  IdentityInvitation,
  IdentityLoginIntent,
  IdentityStore,
  OneTimePkceSecretStore,
  StoredIdentityPrincipal,
} from "../src/contracts";
import { GitHubRestIdentityVerifier } from "../src/github-oauth";
import { registerIdentityRoutes } from "../src/http";

const tenantId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2032-01-02T03:04:05.000Z");
const hmacKey = Buffer.alloc(32, 91);
const values = [1, 2, 3, 4, 5, 6].map((value) => Buffer.alloc(32, value).toString("base64url"));

class MemorySecrets implements OneTimePkceSecretStore {
  readonly values = new Map<string, string>();
  deleted = 0;
  async put(value: string): Promise<string> { const ref = `vault://identity/pkce/${this.values.size + 1}`; this.values.set(ref, value); return ref; }
  async take(ref: string): Promise<string | null> { const value = this.values.get(ref) ?? null; this.values.delete(ref); return value; }
  async delete(ref: string): Promise<void> { this.values.delete(ref); this.deleted += 1; }
}

type MutableInvitation = IdentityInvitation & { state: IdentityInvitation["state"]; loginIntentId: string | null; claimExpiresAt: string | null };
type MutableIntent = IdentityLoginIntent & { status: IdentityLoginIntent["status"]; claimToken: string | null; claimExpiresAt: string | null; completedAt: string | null; failureCode: string | null };
class MemoryIdentityStore implements IdentityStore {
  readonly invitations = new Map<string, MutableInvitation>();
  readonly intents = new Map<string, MutableIntent>();
  readonly sessions = new Map<string, { browser: string; expiresAt: string; principal: StoredIdentityPrincipal; state: "ACTIVE" | "REVOKED" }>();
  async createInvitation(value: IdentityInvitation): Promise<void> { this.invitations.set(value.tokenDigest, { ...value }); }
  async beginLogin(input: Parameters<IdentityStore["beginLogin"]>[0]): Promise<void> {
    const invite = this.invitations.get(input.invitationTokenDigest);
    if (!invite || invite.tenantId !== input.tenantId || invite.expiresAt <= input.at || (invite.state !== "ACTIVE" && !(invite.state === "CLAIMED" && invite.claimExpiresAt! <= input.at))) throw new Error("bad invite");
    const intent = { ...input.intent, invitationId: invite.id } as MutableIntent;
    invite.state = "CLAIMED"; invite.loginIntentId = intent.id; invite.claimExpiresAt = intent.expiresAt;
    this.intents.set(intent.stateDigest, intent);
  }
  async claimLogin(input: Parameters<IdentityStore["claimLogin"]>[0]): Promise<IdentityLoginIntent> {
    const intent = this.intents.get(input.stateDigest);
    if (!intent || intent.tenantId !== input.tenantId || intent.browserBindingDigest !== input.browserBindingDigest
      || intent.status !== "PENDING" || intent.expiresAt <= input.claimedAt) throw new Error("bad state");
    intent.status = "CLAIMED"; intent.claimToken = input.claimToken; intent.claimExpiresAt = input.claimExpiresAt;
    return Object.freeze({ ...intent });
  }
  async completeLogin(input: Parameters<IdentityStore["completeLogin"]>[0]): Promise<StoredIdentityPrincipal> {
    const intent = [...this.intents.values()].find((candidate) => candidate.id === input.intentId);
    if (!intent || intent.claimToken !== input.claimToken || intent.status !== "CLAIMED") throw new Error("lost claim");
    const invitation = [...this.invitations.values()].find((candidate) => candidate.id === intent.invitationId)!;
    const principal: StoredIdentityPrincipal = Object.freeze({ tenantId, tenantSlug: "north-dock", tenantName: "North Dock",
      userId: "22222222-2222-4222-8222-222222222222", membershipId: "33333333-3333-4333-8333-333333333333",
      role: invitation.role, ...input.identity });
    intent.status = "COMPLETED"; intent.claimToken = null; intent.claimExpiresAt = null; intent.completedAt = input.completedAt;
    invitation.state = "CONSUMED"; invitation.claimExpiresAt = null;
    this.sessions.set(input.session.tokenDigest, { browser: input.session.browserBindingDigest,
      expiresAt: input.session.expiresAt, principal, state: "ACTIVE" });
    return principal;
  }
  async failLogin(input: Parameters<IdentityStore["failLogin"]>[0]): Promise<void> {
    const intent = [...this.intents.values()].find((candidate) => candidate.id === input.intentId);
    if (!intent || intent.claimToken !== input.claimToken) return;
    intent.status = "FAILED"; intent.claimToken = null; intent.claimExpiresAt = null; intent.completedAt = input.failedAt; intent.failureCode = input.failureCode;
    const invitation = [...this.invitations.values()].find((candidate) => candidate.id === intent.invitationId)!;
    invitation.state = "ACTIVE"; invitation.loginIntentId = null; invitation.claimExpiresAt = null;
  }
  async resolveSession(input: Parameters<IdentityStore["resolveSession"]>[0]): Promise<StoredIdentityPrincipal> {
    const session = this.sessions.get(input.tokenDigest);
    if (!session || session.browser !== input.browserBindingDigest || session.state !== "ACTIVE" || session.expiresAt <= input.at) throw new Error("bad session");
    return session.principal;
  }
  async revokeSession(input: Parameters<IdentityStore["revokeSession"]>[0]): Promise<boolean> {
    const session = this.sessions.get(input.tokenDigest); if (!session || session.browser !== input.browserBindingDigest || session.state !== "ACTIVE") return false;
    session.state = "REVOKED"; return true;
  }
}

function fixture(options: { rejectGitHub?: boolean } = {}) {
  const store = new MemoryIdentityStore(); const secrets = new MemorySecrets(); const calls: Array<{ code: string; codeVerifier: string }> = [];
  const github: GitHubIdentityVerifier = { async verify(input) {
    calls.push(input); if (options.rejectGitHub) throw new Error("rejected");
    return Object.freeze({ githubUserId: 4242, githubNodeId: "MDQ6VXNlcjQyNDI=", githubLogin: "octocat",
      displayName: "The Octocat", avatarUrl: "https://avatars.githubusercontent.com/u/4242?v=4" });
  } };
  let index = 0;
  const broker = new PlatformIdentityBroker({ clientId: "Iv1.0123456789abcdef", redirectUri: "https://console.deviludo.example/api/auth/github/callback",
    store, secrets, github, sessionHmacKey: hmacKey, clock: () => new Date(now), randomValue: () => values[index++]! });
  return { broker, store, secrets, calls };
}

test("invite -> PKCE GitHub login -> route-bound assertion -> revoke is complete and one-time", async () => {
  const { broker, store, secrets, calls } = fixture();
  const invitation = await broker.createInvitation({ tenantId, role: "ProjectOwner", expiresAt: "2032-01-03T00:00:00.000Z", createdBy: "platform-admin" });
  assert.match(invitation.invitationToken, new RegExp(`^${tenantId.replaceAll("-", "\\-")}\\.`));
  assert.equal([...store.invitations.values()][0]?.tokenDigest, sha(invitation.invitationToken));
  assert.doesNotMatch(JSON.stringify([...store.invitations.values()]), new RegExp(invitation.invitationToken.replaceAll(".", "\\.")));

  const browserBinding = values[4]!;
  const login = await broker.begin({ invitationToken: invitation.invitationToken, browserBinding });
  const authorize = new URL(login.authorizeUrl);
  assert.equal(authorize.origin, "https://github.com");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("allow_signup"), "false");
  assert.equal(authorize.searchParams.get("prompt"), "select_account");
  assert.equal(authorize.searchParams.has("scope"), false);
  assert.equal(secrets.values.size, 1);
  const state = authorize.searchParams.get("state")!;
  const completed = await broker.complete({ state, code: "temporary-code", browserBinding });
  assert.equal(completed.principal.githubUserId, 4242);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.codeVerifier, values[2]);
  assert.equal(secrets.values.size, 0);
  assert.equal([...store.invitations.values()][0]?.state, "CONSUMED");
  assert.rejects(() => broker.complete({ state, code: "replay", browserBinding }), /bad state/);

  const assertion = await broker.assertSession({ sessionToken: completed.sessionToken, browserBinding, method: "POST", pathname: "/api/projects" });
  const request = new Request("https://console.deviludo.example/api/projects", { method: "POST", headers: {
    "x-deviludo-session-tenant": assertion.tenantId, "x-deviludo-session-user": assertion.userId,
    "x-deviludo-session-binding": assertion.sessionBinding, "x-deviludo-session-github-user-id": String(assertion.githubUserId),
    "x-deviludo-session-issued-at": assertion.issuedAt, "x-deviludo-session-signature": assertion.signature,
  } });
  assert.deepEqual(await verifyTrustedPlatformSession(request, hmacKey, now), {
    tenantId, userId: assertion.userId, sessionBinding: assertion.sessionBinding, githubUserId: 4242,
  });
  await assert.rejects(() => verifyTrustedPlatformSession(new Request("https://console.deviludo.example/api/projects", { method: "GET", headers: request.headers }), hmacKey, now), /signature/);
  await assert.rejects(() => broker.assertSession({ sessionToken: completed.sessionToken, browserBinding: values[5]!, method: "POST", pathname: "/api/projects" }), /bad session/);
  assert.equal(await broker.revokeSession({ sessionToken: completed.sessionToken, browserBinding }), true);
  await assert.rejects(() => broker.assertSession({ sessionToken: completed.sessionToken, browserBinding, method: "POST", pathname: "/api/projects" }), /bad session/);
});

test("failed GitHub verification consumes PKCE once but releases the unexpired invitation", async () => {
  const { broker, store, secrets } = fixture({ rejectGitHub: true });
  const invitation = await broker.createInvitation({ tenantId, role: "Auditor", expiresAt: "2032-01-03T00:00:00.000Z", createdBy: "security-admin" });
  const browserBinding = values[4]!;
  const login = await broker.begin({ invitationToken: invitation.invitationToken, browserBinding });
  await assert.rejects(() => broker.complete({ state: new URL(login.authorizeUrl).searchParams.get("state")!, code: "bad-code", browserBinding }), /rejected/);
  assert.equal(secrets.values.size, 0);
  assert.equal([...store.invitations.values()][0]?.state, "ACTIVE");
});

test("HTTP surface separates admin and Web workload authority and never caches credentials", async () => {
  const { broker } = fixture(); const server = Fastify({ logger: false });
  registerIdentityRoutes(server, { broker,
    authorizeAdmin(request) { if (request.headers["x-test-workload"] !== "admin") throw new Error(); },
    authorizeWeb(request) { if (request.headers["x-test-workload"] !== "web") throw new Error(); } });
  const denied = await server.inject({ method: "POST", url: "/v1/invitations", payload: {} });
  assert.equal(denied.statusCode, 401); assert.equal(denied.headers["cache-control"], "no-store");
  const created = await server.inject({ method: "POST", url: "/v1/invitations", headers: { "x-test-workload": "admin" },
    payload: { tenantId, role: "TenantAdmin", expiresAt: "2032-01-03T00:00:00.000Z", createdBy: "platform-admin" } });
  assert.equal(created.statusCode, 201); assert.match(created.json().invitationToken, /\./);
  const crossed = await server.inject({ method: "POST", url: "/v1/invitations", headers: { "x-test-workload": "web" }, payload: {} });
  assert.equal(crossed.statusCode, 401);
  await server.close();
});

test("GitHub verifier revalidates /user and revokes the ephemeral token", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []; let destroyed = false;
  const verifier = new GitHubRestIdentityVerifier({ clientId: "Iv1.0123456789abcdef", clientSecretRef: "vault://github/client-secret/v1",
    redirectUri: "https://console.deviludo.example/api/auth/github/callback",
    secrets: { async resolve() { return { get value() { return "client-secret-value"; }, destroy() { destroyed = true; } }; } },
    fetch: async (input, init) => {
      const url = input.toString(); calls.push({ url, init });
      if (url.includes("access_token")) return Response.json({ access_token: "ghu_temporary012345", token_type: "bearer" });
      if (url.endsWith("/user")) return Response.json({ id: 4242, node_id: "MDQ6VXNlcjQyNDI=", login: "octocat", name: "The Octocat", avatar_url: "https://avatars.githubusercontent.com/u/4242?v=4" });
      return new Response(null, { status: 204 });
    } });
  const identity = await verifier.verify({ code: "oauth-code", codeVerifier: values[0]!, at: now.toISOString() });
  assert.equal(identity.githubLogin, "octocat"); assert.equal(calls.length, 3);
  assert.equal(calls[2]?.init?.method, "DELETE"); assert.match(String((calls[2]?.init?.headers as Record<string, string>).authorization), /^Basic /);
  assert.equal(destroyed, true);
});

test("identity migration stores only digests and forces tenant RLS on every credential-bearing table", async () => {
  const sql = await readFile(new URL("../../../infra/postgres/044_invited_platform_identity.sql", import.meta.url), "utf8");
  assert.match(sql, /token_digest text NOT NULL/); assert.match(sql, /browser_binding_digest text NOT NULL/);
  assert.doesNotMatch(sql, /session_token text|invitation_token text|access_token text|code_verifier text/);
  for (const table of ["users", "tenant_memberships", "tenant_invitations", "identity_login_intents", "platform_sessions"]) {
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
});

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
