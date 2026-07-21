import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { SteamAccessUiSessionSigner, SteamAccessUiSessionVerifier } from "../src/steam-access-ui-session";
import { registerSteamSecureUiRoutes } from "../src/steam-secure-ui";

const now = new Date("2099-01-01T00:02:00.000Z");
const keys = generateKeyPairSync("ed25519");
const enrollmentId = "61e826cb-0909-4b57-a01f-364d5015253e";
const projectId = "44444444-4444-4444-8444-444444444444";
const configurationIntentId = "55555555-5555-4555-8555-555555555555";
const approvalId = "approval-001";
const principal = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  sessionBinding: "s".repeat(43),
  displayName: "Ada <安全>",
});
const cookies = `__Host-deviludo-session=33333333-3333-4333-8333-333333333333.${"a".repeat(43)}; __Host-deviludo-browser=${"b".repeat(43)}`;

function capability(resourceKind: "STEAM_ENROLLMENT" | "STEAM_RELEASE_APPROVAL" | "STEAM_PROJECT_CONFIGURATION", resourceId: string,
  action: "SUBMIT_CREDENTIALS" | "SUBMIT_GUARD_CODE" | "COMPLETE_RELEASE_MFA" | "SUBMIT_PROJECT_CONFIGURATION") {
  return new SteamAccessUiSessionSigner("steam-ui-key-1", keys.privateKey, () => now).issue({ ...principal, resourceKind, resourceId, action });
}

test("isolated Secure UI renders no-store pages and forwards only bound, wiped binary Steam secrets", async () => {
  const observed: Uint8Array[] = [];
  const identityCalls: unknown[] = [];
  const server = Fastify();
  registerSteamSecureUiRoutes(server, {
    publicOrigin: "https://app.deviludo.example/",
    sessions: new SteamAccessUiSessionSigner("steam-ui-key-1", keys.privateKey, () => now),
    sessionVerifier: new SteamAccessUiSessionVerifier("steam-ui-key-1", keys.publicKey, () => now),
    identity: { async assert(session, pathname, method) { identityCalls.push({ session, pathname, method }); return principal; } },
    webauthn: { async begin() { throw new Error("not used"); } },
    access: {
      async submitCredentials(input) {
        assert.equal(input.accountName, "deviludo_build_bot");
        assert.equal(new TextDecoder().decode(input.password), "not-a-real-password"); observed.push(input.password);
        return { enrollmentId, state: "WAITING_STEAM_GUARD", enrollmentUrl: `https://app.deviludo.example/enrollments/${enrollmentId}`, expiresAt: "2099-01-01T00:15:00.000Z" };
      },
      async submitGuard(input) {
        assert.equal(new TextDecoder().decode(input.guardCode), "ABC123"); observed.push(input.guardCode);
        return { enrollmentId, state: "READY", enrollmentUrl: null, expiresAt: "2099-01-01T00:15:00.000Z" };
      },
      async completeApproval() { throw new Error("not used"); },
      async completeProjectConfiguration() { throw new Error("not used"); },
    },
  });
  const page = await server.inject({ method: "GET", url: `/enrollments/${enrollmentId}`, headers: { cookie: cookies } });
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.match(page.headers["content-security-policy"] ?? "", /script-src 'nonce-/);
  assert.match(page.body, /Steam Build Account/);
  assert.match(page.body, /Ada &lt;安全&gt;/);
  assert.doesNotMatch(page.body, /not-a-real-password|ABC123/);

  const credentialSession = capability("STEAM_ENROLLMENT", enrollmentId, "SUBMIT_CREDENTIALS");
  const credentials = await server.inject({ method: "POST", url: `/v1/steam-ui/enrollments/${enrollmentId}/credentials`,
    headers: { cookie: cookies, origin: "https://app.deviludo.example", "sec-fetch-site": "same-origin",
      "content-type": "application/octet-stream", "x-steam-account-name": "deviludo_build_bot", "x-deviludo-steam-ui-session": credentialSession },
    payload: Buffer.from("not-a-real-password") });
  assert.equal(credentials.statusCode, 202);
  assert.deepEqual([...observed[0]!], new Array(observed[0]!.byteLength).fill(0));

  const rejectedSecret = Buffer.from("cross-site-password");
  const rejected = await server.inject({ method: "POST", url: `/v1/steam-ui/enrollments/${enrollmentId}/credentials`,
    headers: { cookie: cookies, origin: "https://evil.example", "content-type": "application/octet-stream",
      "x-steam-account-name": "deviludo_build_bot", "x-deviludo-steam-ui-session": credentialSession }, payload: rejectedSecret });
  assert.equal(rejected.statusCode, 403);
  assert.doesNotMatch(rejected.body, /cross-site-password/);

  const guardSession = capability("STEAM_ENROLLMENT", enrollmentId, "SUBMIT_GUARD_CODE");
  const guard = await server.inject({ method: "POST", url: `/v1/steam-ui/enrollments/${enrollmentId}/guard`,
    headers: { cookie: cookies, origin: "https://app.deviludo.example", "content-type": "application/octet-stream",
      "x-deviludo-steam-ui-session": guardSession }, payload: Buffer.from("ABC123") });
  assert.equal(guard.statusCode, 200);
  assert.deepEqual([...observed[1]!], new Array(observed[1]!.byteLength).fill(0));
  assert.equal(identityCalls.length, 3);
  await server.close();
});

test("isolated Secure UI obtains one WebAuthn challenge and completes only the matching release capability", async () => {
  const calls: unknown[] = [];
  const server = Fastify();
  registerSteamSecureUiRoutes(server, {
    publicOrigin: "https://app.deviludo.example/",
    sessions: new SteamAccessUiSessionSigner("steam-ui-key-1", keys.privateKey, () => now),
    sessionVerifier: new SteamAccessUiSessionVerifier("steam-ui-key-1", keys.publicKey, () => now),
    identity: { async assert() { return principal; } },
    webauthn: { async begin(input) { calls.push(input); return { challengeId: "challenge-001", publicKey: {
      challenge: "c".repeat(43), rpId: "app.deviludo.example", timeout: 120000, userVerification: "required",
      allowCredentials: [{ id: "d".repeat(43), type: "public-key", transports: ["internal"] }],
    } }; } },
    access: {
      async submitCredentials() { throw new Error("not used"); }, async submitGuard() { throw new Error("not used"); },
      async completeApproval(input) { calls.push(input); return { releaseId: "release-001", state: "DISPATCHED", approvalId,
        authorizationUrl: null, workflowId: "delivery-release-001", expiresAt: "2099-01-01T00:10:00.000Z" }; },
      async completeProjectConfiguration() { throw new Error("not used"); },
    },
  });
  const page = await server.inject({ method: "GET", url: `/approvals/${approvalId}`, headers: { cookie: cookies } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /navigator\.credentials\.get/);
  assert.equal(page.headers["permissions-policy"], "publickey-credentials-get=(self)");
  assert.deepEqual(calls[0], { approvalId, tenantId: principal.tenantId, userId: principal.userId });

  const uiSession = capability("STEAM_RELEASE_APPROVAL", approvalId, "COMPLETE_RELEASE_MFA");
  const assertion = { challengeId: "challenge-001", id: "credential-1", response: { signature: "opaque" } };
  const completed = await server.inject({ method: "POST", url: `/v1/steam-ui/approvals/${approvalId}/complete`,
    headers: { cookie: cookies, origin: "https://app.deviludo.example", "content-type": "application/json",
      "x-deviludo-steam-ui-session": uiSession }, payload: { assertion } });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().state, "DISPATCHED");
  assert.deepEqual((calls[1] as { assertion: unknown }).assertion, assertion);

  const wrongAction = capability("STEAM_ENROLLMENT", enrollmentId, "SUBMIT_CREDENTIALS");
  const rejected = await server.inject({ method: "POST", url: `/v1/steam-ui/approvals/${approvalId}/complete`,
    headers: { cookie: cookies, origin: "https://app.deviludo.example", "content-type": "application/json",
      "x-deviludo-steam-ui-session": wrongAction }, payload: { assertion } });
  assert.equal(rejected.statusCode, 401);
  assert.equal(calls.length, 2);
  await server.close();
});

test("isolated Secure UI collects project release fields and wipes the Beta branch password after one bound submission", async () => {
  const observed: Uint8Array[] = [];
  const identityPaths: string[] = [];
  const server = Fastify();
  registerSteamSecureUiRoutes(server, {
    publicOrigin: "https://app.deviludo.example/",
    sessions: new SteamAccessUiSessionSigner("steam-ui-key-1", keys.privateKey, () => now),
    sessionVerifier: new SteamAccessUiSessionVerifier("steam-ui-key-1", keys.publicKey, () => now),
    identity: { async assert(_session, pathname) { identityPaths.push(pathname); return principal; } },
    webauthn: { async begin() { throw new Error("not used"); } },
    access: {
      async submitCredentials() { throw new Error("not used"); }, async submitGuard() { throw new Error("not used"); },
      async completeApproval() { throw new Error("not used"); },
      async completeProjectConfiguration(input) {
        assert.equal(input.projectId, projectId); assert.equal(input.intentId, configurationIntentId);
        assert.equal(input.steamAppId, "480"); assert.equal(input.betaBranch, "deviludo_beta");
        assert.deepEqual(input.platformDepots, { windows: "481", linux: "482" });
        assert.equal(new TextDecoder().decode(input.branchPassword), "privateBeta42!");
        observed.push(input.branchPassword);
        return { intentId: configurationIntentId, projectId, state: "READY", configurationUrl: null,
          expiresAt: "2099-01-01T00:05:00.000Z", revision: 1 };
      },
    },
  });
  const pagePath = `/projects/${projectId}/steam-configuration/${configurationIntentId}`;
  const page = await server.inject({ method: "GET", url: pagePath, headers: { cookie: cookies } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /配置项目发布目标/);
  assert.match(page.body, /分支密码只进入隔离进程与 Vault/);
  assert.doesNotMatch(page.body, /privateBeta42!/);

  const uiSession = capability("STEAM_PROJECT_CONFIGURATION", configurationIntentId, "SUBMIT_PROJECT_CONFIGURATION");
  const response = await server.inject({ method: "POST", url: `/v1/steam-ui/project-configurations/${configurationIntentId}/complete`,
    headers: { cookie: cookies, origin: "https://app.deviludo.example", "content-type": "application/octet-stream",
      "x-deviludo-steam-ui-session": uiSession, "x-deviludo-project-id": projectId,
      "x-steam-app-id": "480", "x-steam-beta-branch": "deviludo_beta", "x-steam-depot-windows": "481", "x-steam-depot-linux": "482" },
    payload: Buffer.from("privateBeta42!") });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().revision, 1);
  assert.deepEqual([...observed[0]!], new Array(observed[0]!.byteLength).fill(0));
  assert.deepEqual(identityPaths, [
    `/api/steam-access-ui/projects/${projectId}/steam-configuration/${configurationIntentId}`,
    `/api/steam-access-ui/projects/${projectId}/steam-configuration/${configurationIntentId}`,
  ]);
  await server.close();
});
