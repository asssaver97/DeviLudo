import assert from "node:assert/strict";
import test from "node:test";
import {
  GET as GET_CONVERSATION,
  POST as POST_CONVERSATION,
} from "../app/api/projects/[projectId]/conversation/route.ts";
import {
  GET as GET_SPEC_REVISION,
  POST as POST_SPEC_REVISION,
} from "../app/api/projects/[projectId]/spec-revisions/route.ts";
import { POST as POST_FEEDBACK } from "../app/api/projects/[projectId]/feedback/route.ts";
import { POST as POST_ACCEPTANCE } from "../app/api/projects/[projectId]/acceptance/route.ts";
import { POST as POST_DELIVERY } from "../app/api/projects/[projectId]/delivery/route.ts";
import { signTrustedGitHubSession } from "../lib/connections/github-broker.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

async function trustedRequest(pathname, init = {}) {
  const method = init.method ?? "GET";
  const issuedAt = String(Date.now());
  const sessionBinding = "same-tenant-project-access-test-session-binding";
  const githubUserId = "42";
  const signature = await signTrustedGitHubSession({
    method,
    pathname,
    tenantId,
    userId,
    sessionBinding,
    githubUserId,
    issuedAt,
    key,
  });
  const headers = new Headers(init.headers);
  headers.set("x-deviludo-session-tenant", tenantId);
  headers.set("x-deviludo-session-user", userId);
  headers.set("x-deviludo-session-binding", sessionBinding);
  headers.set("x-deviludo-session-github-user-id", githubUserId);
  headers.set("x-deviludo-session-issued-at", issuedAt);
  headers.set("x-deviludo-session-signature", signature);
  return new Request(`https://app.deviludo.example${pathname}`, { ...init, method, headers });
}

test("revoked same-tenant project access stops every user decision before downstream Brokers", async () => {
  const originalFetch = globalThis.fetch;
  const saved = new Map([
    ["DEVILUDO_PROJECT_REPOSITORY_BROKER_URL", process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL],
    ["DEVILUDO_SPEC_DIALOGUE_BROKER_URL", process.env.DEVILUDO_SPEC_DIALOGUE_BROKER_URL],
    ["DEVILUDO_USER_ACCEPTANCE_BROKER_URL", process.env.DEVILUDO_USER_ACCEPTANCE_BROKER_URL],
    ["DEVILUDO_SESSION_HMAC_KEY", process.env.DEVILUDO_SESSION_HMAC_KEY],
  ]);
  let projectLookups = 0;
  let downstreamCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.origin === "https://project-repository.internal" && url.pathname === "/v1/projects/lookup") {
      projectLookups += 1;
      return new Response("", { status: 404 });
    }
    downstreamCalls += 1;
    return new Response("", { status: 500 });
  };
  process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL = "https://project-repository.internal/";
  process.env.DEVILUDO_SPEC_DIALOGUE_BROKER_URL = "https://spec-dialogue.internal/";
  process.env.DEVILUDO_USER_ACCEPTANCE_BROKER_URL = "https://user-acceptance.internal/";
  process.env.DEVILUDO_SESSION_HMAC_KEY = Buffer.from(key).toString("base64url");

  const context = { params: Promise.resolve({ projectId }) };
  const conversationPath = `/api/projects/${projectId}/conversation`;
  const specPath = `/api/projects/${projectId}/spec-revisions`;
  const feedbackPath = `/api/projects/${projectId}/feedback`;
  const acceptancePath = `/api/projects/${projectId}/acceptance`;
  const deliveryPath = `/api/projects/${projectId}/delivery`;
  try {
    const responses = [
      await GET_CONVERSATION(await trustedRequest(conversationPath), context),
      await POST_CONVERSATION(await trustedRequest(conversationPath, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "conversation-001" },
        body: JSON.stringify({ expectedRevision: 0, message: "做一款合作生存游戏" }),
      }), context),
      await GET_SPEC_REVISION(await trustedRequest(specPath), context),
      await POST_SPEC_REVISION(await trustedRequest(specPath, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "spec-approve-001" },
        body: JSON.stringify({
          action: "approve",
          revision: "SPEC-001",
          conversationId: "44444444-4444-4444-8444-444444444444",
          expectedRevision: 1,
          specRevisionId: "55555555-5555-4555-8555-555555555555",
          testPlanRevisionId: "66666666-6666-4666-8666-666666666666",
        }),
      }), context),
      await POST_FEEDBACK(await trustedRequest(feedbackPath, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "feedback-001" },
        body: JSON.stringify({ feedback: "降低第一关难度" }),
      }), context),
      await POST_ACCEPTANCE(await trustedRequest(acceptancePath, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "acceptance-001" },
        body: "{}",
      }), context),
      await POST_DELIVERY(await trustedRequest(deliveryPath, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "cancel-001" },
        body: JSON.stringify({ action: "cancel", reason: "停止当前迭代" }),
      }), context),
    ];

    for (const response of responses) {
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error.code, "PROJECT_ACCESS_NOT_FOUND");
    }
    assert.equal(projectLookups, responses.length);
    assert.equal(downstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
