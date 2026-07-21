import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicConversationId,
  signTrustedSpecSession,
  SpecDialogueBrokerClient,
  verifyTrustedSpecSession,
} from "../lib/spec-dialogue/broker.ts";
import { HttpProblem } from "../lib/control-plane/http.ts";

test("spec dialogue trusted session is short-lived and bound to the exact route", async () => {
  const key = new Uint8Array(32).fill(17);
  const issuedAt = String(Date.now());
  const input = {
    method: "POST", pathname: "/api/projects/11111111-1111-4111-8111-111111111111/conversation",
    tenantId: "22222222-2222-4222-8222-222222222222", userId: "user-1",
    sessionBinding: "session-binding-that-is-at-least-thirty-two-bytes", issuedAt, key,
  };
  const signature = await signTrustedSpecSession(input);
  const request = new Request(`https://app.example${input.pathname}`, {
    method: input.method,
    headers: {
      "x-deviludo-session-tenant": input.tenantId,
      "x-deviludo-session-user": input.userId,
      "x-deviludo-session-binding": input.sessionBinding,
      "x-deviludo-session-issued-at": issuedAt,
      "x-deviludo-session-signature": signature,
    },
  });
  assert.deepEqual(await verifyTrustedSpecSession(request, key), {
    tenantId: input.tenantId, userId: input.userId, sessionBinding: input.sessionBinding,
  });
  await assert.rejects(verifyTrustedSpecSession(new Request("https://app.example/api/projects/other/conversation", {
    method: input.method, headers: request.headers,
  }), key));
  assert.match(await deterministicConversationId(input.tenantId, "11111111-1111-4111-8111-111111111111"), /^[a-f0-9-]{36}$/);
});

test("Web Broker client rejects a response whose immutable binding drifted", async () => {
  const tenantId = "22222222-2222-4222-8222-222222222222";
  const projectId = "11111111-1111-4111-8111-111111111111";
  const conversationId = "33333333-3333-4333-8333-333333333333";
  const command = { tenantId, projectId, conversationId, operationKey: "a".repeat(64) };
  const client = new SpecDialogueBrokerClient("https://spec-dialogue.internal/", async () => new Response(JSON.stringify({
    data: {
      tenantId, projectId: "44444444-4444-4444-8444-444444444444", conversationId,
      revision: 1, state: "DRAFT",
      specRevisionId: "55555555-5555-4555-8555-555555555555", specDigest: "b".repeat(64),
      testPlanRevisionId: "66666666-6666-4666-8666-666666666666", testPlanDigest: "c".repeat(64),
      messages: [], result: {},
    },
  }), { status: 201, headers: { "content-type": "application/json" } }));
  await assert.rejects(client.send(command), /trust binding/);
});

test("Web Broker preserves the explicit Runner toolchain approval gate", async () => {
  const client = new SpecDialogueBrokerClient("https://spec-dialogue.internal/", async () => new Response(JSON.stringify({
    error: { code: "RUNNER_TOOLCHAIN_UNAVAILABLE" },
  }), { status: 503, headers: { "content-type": "application/json" } }));
  await assert.rejects(
    client.approve({ operationKey: "a".repeat(64) }),
    (error) => error instanceof HttpProblem
      && error.status === 503
      && error.code === "RUNNER_TOOLCHAIN_UNAVAILABLE",
  );
});
