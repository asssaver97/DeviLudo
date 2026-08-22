import assert from "node:assert/strict";
import test from "node:test";
import { testAgentConnection } from "@/services/core/src/agent-connection";
import type { StoredInstanceAgentSettings } from "@/services/core/src/repository";

function settings(agentRuntime: "CLAUDE_CODE" | "CODEX_CLI", baseUrl: string): StoredInstanceAgentSettings {
  return Object.freeze({
    agentRuntime,
    baseUrl,
    primaryModel: agentRuntime === "CODEX_CLI" ? "xai/grok-4.6" : "claude-model",
    modelOverrides: Object.freeze({ design: null, development: null, test: null }),
    imageModel: null,
    credentialSecretRef: "vault://instance/agent-runtime/api-key/versions/10000000-0000-4000-8000-000000000001",
    testPolicyReady: false,
    testPolicyCheckedRevision: null,
    apiKeyMask: "sk-********alue",
    apiKeyFingerprint: "sha256:0123456789ab",
    credentialVersion: "10000000-0000-4000-8000-000000000001",
    revision: 1,
    updatedBy: "test",
    updatedAt: "2026-08-22T00:00:00Z",
  });
}

test("Codex connection test sends the saved custom Provider, model, and credential to the CLI", async () => {
  const calls: unknown[] = [];
  await testAgentConnection(
    settings("CODEX_CLI", "https://api.x.ai/v1"),
    "xai-secret-value",
    fetch,
    async input => {
      calls.push(input);
      return "DEVILUDO_CONNECTION_OK";
    },
  );
  assert.deepEqual(calls, [{
    baseUrl: "https://api.x.ai/v1",
    credential: "xai-secret-value",
    model: "xai/grok-4.6",
    prompt: "Reply with exactly DEVILUDO_CONNECTION_OK and nothing else.",
    reasoningEffort: "low",
    timeoutMs: 45_000,
  }]);
});

test("Claude connection test performs a real authenticated Messages request", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  await testAgentConnection(
    settings("CLAUDE_CODE", "https://gateway.example/provider"),
    "claude-secret-value",
    (async (url: URL | RequestInfo, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "DEVILUDO_CONNECTION_OK" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  );
  assert.equal(requests[0].url, "https://gateway.example/provider/v1/messages");
  assert.equal(JSON.stringify(requests).includes("claude-secret-value"), true);
});

test("connection test rejects a Provider that does not follow the probe", async () => {
  await assert.rejects(
    testAgentConnection(
      settings("CODEX_CLI", "https://api.x.ai/v1"),
      "xai-secret-value",
      fetch,
      async () => "not ready",
    ),
    /unexpected connection-test response/,
  );
});
