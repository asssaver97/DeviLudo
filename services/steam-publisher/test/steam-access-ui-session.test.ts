import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import type { FastifyRequest } from "fastify";
import { SteamAccessUiSessionVerifier } from "../src/steam-access-ui-session";

const keys = generateKeyPairSync("ed25519");
const now = new Date("2099-01-01T00:02:00.000Z");

function token(overrides: Readonly<Record<string, unknown>> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "steam-ui-key-1", typ: "DEVILUDO-STEAM-UI" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    schemaVersion: "deviludo.steam-ui-session.v1",
    tenantId: "tenant-north-dock",
    userId: "user-ada",
    sessionBinding: "session-binding-with-at-least-thirty-two-random-characters",
    resourceKind: "STEAM_ENROLLMENT",
    resourceId: "61e826cb-0909-4b57-a01f-364d5015253e",
    action: "SUBMIT_CREDENTIALS",
    issuedAt: "2099-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:05:00.000Z",
    nonce: "nonce-001",
    ...overrides,
  })).toString("base64url");
  const signingInput = `${header}.${claims}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput, "ascii"), keys.privateKey).toString("base64url")}`;
}

function request(value: string): FastifyRequest {
  return { headers: { "x-deviludo-steam-ui-session": value } } as unknown as FastifyRequest;
}

test("Steam secure UI sessions are short-lived Ed25519 capabilities bound to one resource and action", () => {
  const verifier = new SteamAccessUiSessionVerifier("steam-ui-key-1", keys.publicKey, () => now);
  const principal = verifier.verify(request(token()), {
    resourceKind: "STEAM_ENROLLMENT",
    resourceId: "61e826cb-0909-4b57-a01f-364d5015253e",
    action: "SUBMIT_CREDENTIALS",
  });
  assert.deepEqual(principal, {
    tenantId: "tenant-north-dock",
    userId: "user-ada",
    sessionBinding: "session-binding-with-at-least-thirty-two-random-characters",
  });
  assert.throws(() => verifier.verify(request(token()), {
    resourceKind: "STEAM_ENROLLMENT",
    resourceId: "61e826cb-0909-4b57-a01f-364d5015253e",
    action: "SUBMIT_GUARD_CODE",
  }), /invalid/);
  assert.throws(() => verifier.verify(request(token({ resourceId: "different-enrollment" })), {
    resourceKind: "STEAM_ENROLLMENT",
    resourceId: "61e826cb-0909-4b57-a01f-364d5015253e",
    action: "SUBMIT_CREDENTIALS",
  }), /invalid/);
  assert.throws(() => verifier.verify(request(token({ expiresAt: "2099-01-01T00:01:00.000Z" })), {
    resourceKind: "STEAM_ENROLLMENT",
    resourceId: "61e826cb-0909-4b57-a01f-364d5015253e",
    action: "SUBMIT_CREDENTIALS",
  }), /invalid/);
  const tokenParts = token().split(".");
  const tamperedSignature = Buffer.from(tokenParts[2]!, "base64url");
  tamperedSignature[0] = tamperedSignature[0]! ^ 1;
  const tampered = `${tokenParts[0]}.${tokenParts[1]}.${tamperedSignature.toString("base64url")}`;
  assert.throws(() => verifier.verify(request(tampered), {
    resourceKind: "STEAM_ENROLLMENT",
    resourceId: "61e826cb-0909-4b57-a01f-364d5015253e",
    action: "SUBMIT_CREDENTIALS",
  }), /invalid/);
});
