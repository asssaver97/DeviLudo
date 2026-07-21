import assert from "node:assert/strict";
import test from "node:test";
import type { TestKitArtifactBrokerHttp } from "../../runner-control/src/testkit-artifact-client";
import {
  MtlsSteamReleaseWebAuthnClient,
  MtlsSteamSecureUiAccessClient,
  MtlsSteamSecureUiIdentityClient,
  steamSecureUiBrowserSession,
} from "../src/steam-secure-ui-clients";
import type { SteamAccessBinaryHttp } from "../src/steam-access-dependencies";

const tls = Object.freeze({ key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) });
const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const enrollmentId = "61e826cb-0909-4b57-a01f-364d5015253e";
const projectId = "33333333-3333-4333-8333-333333333333";
const configurationIntentId = "55555555-5555-4555-8555-555555555555";

test("Secure UI identity and WebAuthn clients pin their mTLS routes and exact receipts", async () => {
  const calls: Array<{ origin: string; path: string; body: unknown }> = [];
  const http: TestKitArtifactBrokerHttp = async (input) => {
    const body = JSON.parse(input.body) as unknown;
    calls.push({ origin: input.url.origin, path: input.url.pathname, body });
    if (input.url.pathname === "/v1/sessions/assert") return { statusCode: 200, payload: {
      tenantId, tenantSlug: "north-dock", tenantName: "North Dock", userId,
      membershipId: "33333333-3333-4333-8333-333333333333", role: "TenantAdmin", githubUserId: 42,
      githubNodeId: "MDQ6VXNlcjQy", githubLogin: "ada", displayName: "Ada", avatarUrl: "https://avatars.example/42",
      sessionBinding: "s".repeat(43), issuedAt: "4070908920000", signature: "x".repeat(43),
    } };
    if (input.url.pathname === "/v1/steam-release-mfa/challenges") return { statusCode: 201, payload: {
      schemaVersion: "deviludo.steam-release-webauthn-challenge.v1", approvalId: "approval-001", challengeId: "challenge-001",
      publicKey: { challenge: "c".repeat(43), rpId: "app.deviludo.example", timeout: 120000, userVerification: "required",
        allowCredentials: [{ id: "d".repeat(43), type: "public-key", transports: ["internal", "hybrid"] }] },
    } };
    throw new Error("unexpected request");
  };
  const identity = new MtlsSteamSecureUiIdentityClient({ endpoint: "https://identity.internal", tls, http });
  const session = steamSecureUiBrowserSession(`__Host-deviludo-session=44444444-4444-4444-8444-444444444444.${"a".repeat(43)}; __Host-deviludo-browser=${"b".repeat(43)}`);
  assert.equal((await identity.assert(session, "/api/steam-access-ui/enrollments/61e826cb-0909-4b57-a01f-364d5015253e", "GET")).displayName, "Ada");
  const webauthn = new MtlsSteamReleaseWebAuthnClient({ endpoint: "https://mfa.internal", tls, http });
  const challenge = await webauthn.begin({ approvalId: "approval-001", tenantId, userId });
  assert.equal(challenge.publicKey.userVerification, "required");
  assert.deepEqual(calls.map(({ origin, path }) => ({ origin, path })), [
    { origin: "https://identity.internal", path: "/v1/sessions/assert" },
    { origin: "https://mfa.internal", path: "/v1/steam-release-mfa/challenges" },
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /password|guardCode|configVdf/i);
  assert.throws(() => steamSecureUiBrowserSession(`__Host-deviludo-session=bad; __Host-deviludo-browser=${"b".repeat(43)}`), /invalid/);
});

test("Secure UI access client forwards binary secrets and a resource capability to fixed Broker routes", async () => {
  const calls: Array<{ path: string; contentType?: string; body: Uint8Array | undefined; token?: string; projectId?: string }> = [];
  const uiSession = `${"a".repeat(80)}.${"b".repeat(80)}.${"c".repeat(80)}`;
  const http: SteamAccessBinaryHttp = async (input) => {
    calls.push({ path: input.url.pathname, contentType: input.headers?.["content-type"], body: input.body,
      token: input.headers?.["x-deviludo-steam-ui-session"], projectId: input.headers?.["x-deviludo-project-id"] });
    if (input.url.pathname.endsWith("/credentials")) return { statusCode: 202, headers: {}, body: Buffer.from(JSON.stringify({
      enrollmentId, state: "WAITING_STEAM_GUARD", enrollmentUrl: `https://app.deviludo.example/enrollments/${enrollmentId}`,
      expiresAt: "2099-01-01T00:15:00.000Z",
    })) };
    if (input.url.pathname.endsWith("/guard")) return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({
      enrollmentId, state: "READY", enrollmentUrl: null, expiresAt: "2099-01-01T00:15:00.000Z",
    })) };
    if (input.url.pathname.includes("/project-configurations/")) return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({
      intentId: configurationIntentId, projectId, state: "READY", configurationUrl: null,
      expiresAt: "2099-01-01T00:05:00.000Z", revision: 1,
    })) };
    return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({
      releaseId: "release-001", state: "DISPATCHED", approvalId: "approval-001", authorizationUrl: null,
      workflowId: "delivery-release-001", expiresAt: "2099-01-01T00:10:00.000Z",
    })) };
  };
  const access = new MtlsSteamSecureUiAccessClient({ endpoint: "https://steam-access.internal", tls, http });
  const password = new TextEncoder().encode("not-a-real-password");
  const guardCode = new TextEncoder().encode("ABC123");
  const branchPassword = new TextEncoder().encode("privateBeta42!");
  assert.equal((await access.submitCredentials({ enrollmentId, accountName: "deviludo_build_bot", password, uiSession })).state, "WAITING_STEAM_GUARD");
  assert.equal((await access.submitGuard({ enrollmentId, guardCode, uiSession })).state, "READY");
  assert.equal((await access.completeApproval({ approvalId: "approval-001", assertion: { credential: "opaque" }, uiSession })).state, "DISPATCHED");
  assert.equal((await access.completeProjectConfiguration({ intentId: configurationIntentId, projectId,
    steamAppId: "480", betaBranch: "deviludo_beta", platformDepots: { windows: "481" }, branchPassword, uiSession })).revision, 1);
  assert.deepEqual(calls.map((entry) => entry.path), [
    `/v1/steam/enrollments/${enrollmentId}/credentials`, `/v1/steam/enrollments/${enrollmentId}/guard`,
    "/v1/mfa/approvals/approval-001/complete", `/v1/steam/project-configurations/${configurationIntentId}/complete`,
  ]);
  assert.equal(calls[0]?.body, password);
  assert.equal(calls[1]?.body, guardCode);
  assert.equal(calls[2]?.contentType, "application/json");
  assert.equal(calls[3]?.body, branchPassword);
  assert.equal(calls[3]?.projectId, projectId);
  assert.ok(calls.every((entry) => entry.token === uiSession));
  assert.doesNotMatch(JSON.stringify(calls.map(({ path, contentType, token }) => ({ path, contentType, tokenLength: token?.length }))), /not-a-real-password|ABC123|privateBeta42|opaque/);
});
