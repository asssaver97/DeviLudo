import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { TestKitArtifactBrokerHttp } from "../../runner-control/src/testkit-artifact-client";
import { signSteamPublishAuthorization, steamCanonicalDigest } from "../src/artifacts";
import type { SteamPublishAuthorizationClaims } from "../src/contracts";
import {
  FixedReleaseMfaChallengeIssuer,
  MtlsReleaseMfaVerifier,
  MtlsSteamConfigVault,
  MtlsSteamInteractiveLoginConnector,
  MtlsSteamPublishAuthorizationSigner,
  PostgresSteamPublishAuthorizationArchive,
  type SteamAccessBinaryHttp,
} from "../src/steam-access-dependencies";

const tls = Object.freeze({ key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) });
const enrollmentId = "61e826cb-0909-4b57-a01f-364d5015253e";

test("Steam login and config.vdf Vault adapters use fixed mTLS routes and opaque binary secret bodies", async () => {
  const calls: Array<{ path: string; method: string; body: Uint8Array | undefined; headers: Readonly<Record<string, string>> | undefined }> = [];
  const http: SteamAccessBinaryHttp = async (input) => {
    calls.push({ path: input.url.pathname, method: input.method, body: input.body, headers: input.headers });
    if (input.url.pathname === "/healthz") return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({
      schemaVersion: calls.length === 1 ? "deviludo.steam-login-connector-health.v1" : "deviludo.steam-config-vault-health.v1",
      status: "ok",
    })) };
    if (input.url.pathname.endsWith("/begin")) return { statusCode: 200, headers: {
      "x-deviludo-steam-login-result": "guard-required",
      "x-deviludo-challenge-secret-ref": "vault://kv/steam/challenges/1",
    }, body: Buffer.alloc(0) };
    if (input.url.pathname.endsWith("/guard")) return { statusCode: 200, headers: {
      "x-deviludo-steam-login-result": "authenticated",
      "x-steam-account-id": "steam-account-42",
      "x-steam-account-name": "deviludo_build_bot",
      "x-steam-allowed-app-ids": "2841930,2841931",
      "x-steam-permissions": "EditAppMetadata,PublishAppChanges",
      "x-steam-session-expires-at": "2099-02-01T00:00:00.000Z",
    }, body: Buffer.from("opaque-config-vdf") };
    if (input.method === "PUT") return { statusCode: 201, headers: {}, body: Buffer.from(JSON.stringify({
      secretRef: "vault://kv/steam/config-vdf/version-1",
      maskedFingerprint: "sha256:1234abcd…987654",
    })) };
    if (input.method === "DELETE") return { statusCode: 204, headers: {}, body: Buffer.alloc(0) };
    throw new Error("unexpected request");
  };
  const login = new MtlsSteamInteractiveLoginConnector({ endpoint: "https://steam-login.internal", tls, http });
  const vault = new MtlsSteamConfigVault({ endpoint: "https://steam-vault.internal", tls, http });
  await login.probe();
  const password = new TextEncoder().encode("not-a-real-password");
  assert.deepEqual(await login.begin({ enrollmentId, accountName: "deviludo_build_bot", password }), {
    kind: "GUARD_REQUIRED", challengeSecretRef: "vault://kv/steam/challenges/1",
  });
  const guardCode = new TextEncoder().encode("ABC123");
  const authenticated = await login.completeGuard({
    enrollmentId,
    challengeSecretRef: "vault://kv/steam/challenges/1",
    guardCode,
  });
  assert.equal(new TextDecoder().decode(authenticated.configVdf), "opaque-config-vdf");
  const configVdf = new TextEncoder().encode("opaque-config-vdf");
  assert.deepEqual(await vault.write({ path: "steam/config-vdf/tenant/credential", plaintext: configVdf }), {
    secretRef: "vault://kv/steam/config-vdf/version-1",
    maskedFingerprint: "sha256:1234abcd…987654",
  });
  await vault.revoke("vault://kv/steam/config-vdf/version-1");
  await vault.probe();
  assert.equal(calls[1]?.path, `/v1/steam-login/enrollments/${enrollmentId}/begin`);
  assert.equal(calls[1]?.body, password);
  assert.equal(calls[2]?.body, guardCode);
  assert.equal(calls[3]?.body, configVdf);
  assert.doesNotMatch(JSON.stringify(calls.map(({ path, method, headers }) => ({ path, method, headers }))), /not-a-real-password|ABC123|opaque-config-vdf/);

  const malformedConfig = Buffer.from("malformed-config-vdf");
  const malformed = new MtlsSteamInteractiveLoginConnector({
    endpoint: "https://steam-login.internal",
    tls,
    async http() {
      return { statusCode: 200, headers: { "x-deviludo-steam-login-result": "authenticated" }, body: malformedConfig };
    },
  });
  await assert.rejects(malformed.begin({ enrollmentId, accountName: "deviludo_build_bot", password }), /invalid/);
  assert.deepEqual([...malformedConfig], new Array(malformedConfig.byteLength).fill(0));
});

test("release MFA and KMS adapters verify exact receipts and the returned Ed25519 authorization", async () => {
  const keys = generateKeyPairSync("ed25519");
  const keyId = "steam-publish-key-1";
  const claims: SteamPublishAuthorizationClaims = Object.freeze({
    kind: "deviludo-steam-publish-authorization",
    version: 1,
    operation: "PRIVATE_BETA_UPLOAD",
    tenantId: "tenant-north-dock",
    projectId: "project-ember",
    releaseId: "release-9",
    mainCommitSha: "a".repeat(40),
    evidenceBundleDigest: "b".repeat(64),
    acceptedBy: "user-ada",
    mfaAssertionId: "mfa-assertion-91",
    nonce: "approval-9",
    issuedAt: "2099-01-01T00:05:00.000Z",
    expiresAt: "2099-01-01T00:15:00.000Z",
  });
  const calls: string[] = [];
  const http: TestKitArtifactBrokerHttp = async (input) => {
    calls.push(input.url.pathname);
    if (input.url.pathname === "/healthz") return { statusCode: 200, payload: input.url.origin.includes("mfa") ? {
      schemaVersion: "deviludo.steam-release-mfa-verifier-health.v1", status: "ok",
    } : {
      schemaVersion: "deviludo.steam-publish-authorization-signer-health.v1", status: "ok", keyId, algorithm: "Ed25519",
    } };
    if (input.url.pathname.includes("verifications")) return { statusCode: 200, payload: {
      schemaVersion: "deviludo.steam-release-mfa-verification-receipt.v1",
      approvalId: "approval-9", userId: "user-ada", assertionId: "mfa-assertion-91",
      assuranceLevel: "AAL2", verifiedAt: "2099-01-01T00:05:00.000Z",
    } };
    const request = JSON.parse(input.body) as { claims: SteamPublishAuthorizationClaims; claimsDigest: string };
    return { statusCode: 200, payload: {
      schemaVersion: "deviludo.steam-publish-authorization-sign-receipt.v1",
      keyId, algorithm: "Ed25519", claimsDigest: request.claimsDigest,
      authorization: signSteamPublishAuthorization(keyId, keys.privateKey, request.claims),
    } };
  };
  const mfa = new MtlsReleaseMfaVerifier({ endpoint: "https://mfa.internal", tls, http });
  const signer = new MtlsSteamPublishAuthorizationSigner({
    endpoint: "https://kms.internal", keyId, publicKey: keys.publicKey, tls, http,
  });
  await mfa.probe();
  await signer.probe();
  assert.equal((await mfa.verify({ approvalId: "approval-9", assertion: { webauthn: "opaque" } })).assuranceLevel, "AAL2");
  const authorization = await signer.sign(claims);
  assert.equal(steamCanonicalDigest(authorization.claims), steamCanonicalDigest(claims));
  assert.deepEqual(calls, ["/healthz", "/healthz", "/v1/steam-release-mfa/verifications", "/v1/steam-publish-authorization/sign-ed25519"]);

  const challenge = new FixedReleaseMfaChallengeIssuer("https://steam-access.example/");
  assert.deepEqual(await challenge.begin({ approvalId: "approval-9" }), {
    authorizationUrl: "https://steam-access.example/approvals/approval-9",
  });
  const archive = new PostgresSteamPublishAuthorizationArchive({
    async find() {
      return { state: "VERIFIED", snapshot: { releaseId: "release-9" }, signedAuthorization: authorization } as never;
    },
  });
  await archive.persist({ approvalId: "approval-9", tenantId: "tenant-north-dock", releaseId: "release-9", authorization });
  await assert.rejects(archive.persist({ approvalId: "approval-9", tenantId: "tenant-north-dock", releaseId: "different", authorization }), /invalid/);
});
