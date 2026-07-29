import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  createAgentSecretStore,
  LocalAgentSecretStore,
  parseAgentSettingsInput,
} from "@/services/core/src/agent-settings";

const tenantId = "50000000-0000-4000-8000-000000000001";

test("Agent settings accept fixed runtimes and normalize safe provider URLs", () => {
  assert.deepEqual(parseAgentSettingsInput({
    agentRuntime: "CODEX_CLI",
    baseUrl: "https://api.example.com/v1/",
    apiKey: "sk-valid-secret",
  }, "production"), {
    agentRuntime: "CODEX_CLI",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-valid-secret",
  });
  assert.throws(() => parseAgentSettingsInput({
    agentRuntime: "UNKNOWN",
    baseUrl: "https://api.example.com",
  }), /runtime/i);
  assert.throws(() => parseAgentSettingsInput({
    agentRuntime: "CLAUDE_CODE",
    baseUrl: "http://api.example.com",
  }), /HTTPS/i);
  assert.throws(() => parseAgentSettingsInput({
    agentRuntime: "CLAUDE_CODE",
    baseUrl: "https://user:pass@example.com/v1",
  }), /credentials/i);
});

test("the local Secret store writes a versioned tenant key and returns only a fingerprint reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-agent-settings-"));
  try {
    const store = new LocalAgentSecretStore(root);
    const saved = await store.writeApiKey(tenantId, "sk-local-secret-value");
    assert.match(saved.secretRef, new RegExp(`^vault://tenants/${tenantId}/`));
    assert.match(saved.fingerprint, /^sha256:[0-9a-f]{12}$/);
    assert.doesNotMatch(JSON.stringify(saved), /sk-local-secret-value/);
    const stored = await readFile(join(
      root,
      "tenants",
      tenantId,
      "agent-runtime",
      "api-key",
      "versions",
      `${saved.version}.key`,
    ), "utf8");
    assert.equal(stored, "sk-local-secret-value");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production fails closed when the Agent Secret broker is not configured", () => {
  assert.throws(() => createAgentSecretStore({ NODE_ENV: "production" }), /broker URL is required/i);
});
