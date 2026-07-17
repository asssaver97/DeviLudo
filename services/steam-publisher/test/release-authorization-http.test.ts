import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerReleaseAuthorizationBrokerRoutes } from "../src/release-authorization-http";

test("release authorization HTTP boundaries separate Web workload and MFA assertion trust", async () => {
  const calls: { operation: string; value: unknown }[] = [];
  const server = Fastify();
  registerReleaseAuthorizationBrokerRoutes(server, {
    authorizeInternal(request) {
      if (request.headers["x-workload"] !== "web") throw new Error("unauthorized");
    },
    authorizeMfaCompletion(request, approvalId) {
      if (request.headers["x-mfa-session"] !== "verified-ui-session" || approvalId !== "approval-001") throw new Error("unauthorized");
      return { tenantId: "tenant-001", userId: "user-001" };
    },
    broker: {
      async begin(principal, releaseId, idempotencyKey) {
        calls.push({ operation: "begin", value: { principal, releaseId, idempotencyKey } });
        return {
          releaseId,
          state: "MFA_REQUIRED",
          approvalId: "approval-001",
          authorizationUrl: "https://mfa.deviludo.example/approvals/approval-001",
          workflowId: null,
          expiresAt: "2099-01-01T00:10:00.000Z",
        };
      },
      async complete(input) {
        calls.push({ operation: "complete", value: input });
        return {
          releaseId: "release-001",
          state: "DISPATCHED",
          approvalId: input.approvalId,
          authorizationUrl: null,
          workflowId: "delivery-release-001",
          expiresAt: "2099-01-01T00:10:00.000Z",
        };
      },
    },
  });
  const principal = {
    tenantId: "tenant-001",
    userId: "user-001",
    sessionBinding: "session-binding-with-at-least-thirty-two-random-characters",
  };
  const unauthorized = await server.inject({
    method: "POST",
    url: "/v1/releases/release-001/accept-and-publish",
    payload: { principal },
  });
  assert.equal(unauthorized.statusCode, 401);
  const started = await server.inject({
    method: "POST",
    url: "/v1/releases/release-001/accept-and-publish",
    headers: { "x-workload": "web", "idempotency-key": "release-begin-001" },
    payload: { principal },
  });
  assert.equal(started.statusCode, 201);
  assert.equal(started.json().state, "MFA_REQUIRED");

  const smuggled = await server.inject({
    method: "POST",
    url: "/v1/releases/release-001/accept-and-publish",
    headers: { "x-workload": "web", "idempotency-key": "release-begin-002" },
    payload: { principal, mainCommitSha: "a".repeat(40), evidenceStatus: "PASSED", mfaProof: "forged" },
  });
  assert.equal(smuggled.statusCode, 400);
  assert.equal(calls.length, 1);

  const untrustedMfa = await server.inject({
    method: "POST",
    url: "/v1/mfa/approvals/approval-001/complete",
    payload: { assertion: { credential: "opaque" } },
  });
  assert.equal(untrustedMfa.statusCode, 401);
  const completed = await server.inject({
    method: "POST",
    url: "/v1/mfa/approvals/approval-001/complete",
    headers: { "x-mfa-session": "verified-ui-session" },
    payload: { assertion: { credential: "opaque" } },
  });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().state, "DISPATCHED");
  assert.equal(calls.length, 2);
  assert.doesNotMatch(smuggled.body, /forged|mainCommitSha|evidenceStatus/);
  await server.close();
});
