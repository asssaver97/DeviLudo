import assert from "node:assert/strict";
import test from "node:test";
import { generateProjectName, normalizeGeneratedProjectName } from "@/services/core/src/project-naming";
import type { StoredInstanceAgentSettings } from "@/services/core/src/repository";

const settings: StoredInstanceAgentSettings = Object.freeze({
  agentRuntime: "CLAUDE_CODE",
  baseUrl: "https://gateway.example.com/anthropic/v1",
  model: null,
  models: Object.freeze({
    primary: "claude-primary",
    opus: "claude-opus",
    sonnet: "claude-sonnet",
    haiku: "claude-haiku",
    subagent: "claude-subagent",
  }),
  roleModels: Object.freeze({ design: "claude-sonnet", development: "claude-primary", test: "claude-haiku" }),
  credentialSecretRef: "vault://instance/agent-runtime/api-key/versions/30000000-0000-4000-8000-000000000099",
  apiKeyMask: "sk-********alue",
  apiKeyFingerprint: "sha256:0123456789ab",
  credentialVersion: "30000000-0000-4000-8000-000000000099",
  testPolicyReady: false,
  testPolicyCheckedRevision: null,
  revision: 1,
  updatedBy: "TEST_OPERATOR",
  updatedAt: new Date(0).toISOString(),
});

test("Claude-compatible naming uses the configured instance endpoint and primary model", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  const name = await generateProjectName({
    concept: "玩家在暴风雨中修复一座会移动的灯塔。",
    settings,
    apiKey: "sk-local-secret-value",
    fetchImpl: (async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ content: [{ type: "text", text: "《逐浪灯塔》" }] });
    }) as typeof fetch,
  });
  assert.equal(name, "逐浪灯塔");
  assert.equal(requestedUrl, "https://gateway.example.com/anthropic/v1/messages");
  assert.equal(requestedBody.model, "claude-primary");
  assert.equal(requestedBody.max_tokens, 512);
});

test("generated project names fail closed when the provider returns invalid text", () => {
  assert.throws(() => normalizeGeneratedProjectName("x"), /无效/);
  assert.throws(() => normalizeGeneratedProjectName("a".repeat(41)), /无效/);
});
