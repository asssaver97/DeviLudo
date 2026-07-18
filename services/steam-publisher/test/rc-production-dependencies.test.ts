import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { TestKitArtifactBrokerHttp } from "../../runner-control/src/testkit-artifact-client";
import { signSteamRcArtifact, steamCanonicalDigest } from "../src/artifacts";
import type { SteamRcArtifactClaims } from "../src/contracts";
import { MtlsSteamRcArtifactSigner, S3SteamRcObjectInspector } from "../src/rc-production-dependencies";

const keys = generateKeyPairSync("ed25519");
const keyId = "steam-rc-kms-001";
const claims: SteamRcArtifactClaims = Object.freeze({
  kind: "deviludo-steam-rc", version: 1,
  tenantId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  releaseId: "33333333-3333-4333-8333-333333333333",
  mainCommitSha: "a".repeat(40), sourceDigest: "b".repeat(64),
  specRevisionId: "44444444-4444-4444-8444-444444444444",
  specDigest: "c".repeat(64), testPlanDigest: "d".repeat(64), evidenceBundleDigest: "e".repeat(64),
  steamAppId: "2841930", targetMatrix: Object.freeze(["linux"] as const),
  depots: Object.freeze([{ depotId: "2841931", platform: "linux" as const,
    objectRef: "s3://evidence/tenant/export.tar", artifactDigest: "f".repeat(64), sizeBytes: 4096 }]),
  issuedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-01T01:00:00.000Z",
});
const tls = Object.freeze({ key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) });

test("mTLS RC signer sends canonical claims to a fixed KMS route and verifies its Ed25519 receipt", async () => {
  const calls: Array<{ path: string; body: string }> = [];
  const http: TestKitArtifactBrokerHttp = async (input) => {
    calls.push({ path: input.url.pathname, body: input.body });
    if (input.url.pathname === "/healthz") return { statusCode: 200, payload: {
      schemaVersion: "deviludo.steam-rc-signer-health.v1", status: "ok", keyId, algorithm: "Ed25519",
    } };
    const request = JSON.parse(input.body) as { claims: SteamRcArtifactClaims; claimsDigest: string };
    return { statusCode: 200, payload: {
      schemaVersion: "deviludo.steam-rc-sign-receipt.v1", keyId, algorithm: "Ed25519",
      claimsDigest: request.claimsDigest, artifact: signSteamRcArtifact(keyId, keys.privateKey, request.claims),
    } };
  };
  const signer = new MtlsSteamRcArtifactSigner({
    endpoint: "https://kms.internal", keyId, publicKey: keys.publicKey, tls, http,
  });
  await signer.probe();
  const artifact = await signer.sign(claims);
  assert.equal(artifact.keyId, keyId);
  assert.equal(calls[1]?.path, "/v1/steam-rc/sign-ed25519");
  assert.equal((JSON.parse(calls[1]?.body ?? "{}") as { claimsDigest?: string }).claimsDigest, steamCanonicalDigest(claims));
  assert.doesNotMatch(JSON.stringify(calls), /privateKey|PRIVATE KEY/);

  const tampered = new MtlsSteamRcArtifactSigner({
    endpoint: "https://kms.internal", keyId, publicKey: keys.publicKey, tls,
    async http() { return { statusCode: 200, payload: {
      schemaVersion: "deviludo.steam-rc-sign-receipt.v1", keyId, algorithm: "Ed25519",
      claimsDigest: steamCanonicalDigest(claims),
      artifact: { ...signSteamRcArtifact(keyId, keys.privateKey, claims), signature: "tampered" },
    } }; },
  });
  await assert.rejects(tampered.sign(claims), /invalid/);
});

test("S3 RC inspector returns only a checksum-verified content address", async () => {
  const calls: unknown[] = [];
  const inspector = new S3SteamRcObjectInspector({
    async verifyObject(input: Readonly<{ objectKey: string; artifactDigest: string }>) {
      calls.push(input);
      return { sizeBytes: 4096 };
    },
    async probe() { calls.push("probe"); },
  } as never, "deviludo-evidence");
  const result = await inspector.inspect({
    tenantId: claims.tenantId, projectId: claims.projectId, releaseId: claims.releaseId,
    platform: "linux", objectKey: "tenants/1/exports/linux.tar", artifactDigest: "f".repeat(64),
  });
  assert.deepEqual(result, { objectRef: "s3://deviludo-evidence/tenants/1/exports/linux.tar", sizeBytes: 4096 });
  await inspector.probe();
  assert.equal(calls.length, 2);
  await assert.rejects(inspector.inspect({
    tenantId: claims.tenantId, projectId: claims.projectId, releaseId: claims.releaseId,
    platform: "linux", objectKey: "../escape", artifactDigest: "f".repeat(64),
  }), /object binding is invalid/);
});
