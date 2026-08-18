import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  createAgentSecretStore,
  isMaskedApiKey,
  LocalAgentSecretStore,
  maskApiKey,
  parseAgentSettingsInput,
  parseClaudeSettingsJson,
} from "@/services/core/src/agent-settings";
import { CoreRepository } from "@/services/core/src/repository";

test("Agent settings accept fixed runtimes and normalize safe provider URLs", () => {
  assert.deepEqual(parseAgentSettingsInput({
    agentRuntime: "CODEX_CLI",
  }, "production"), {
    agentRuntime: "CODEX_CLI",
    baseUrl: "https://chatgpt.com",
    apiKey: null,
    primaryModel: "account-default",
    modelOverrides: { design: null, development: null, test: null, image: null },
  });
  assert.throws(() => parseAgentSettingsInput({
    agentRuntime: "CODEX_CLI",
    baseUrl: "https://api.example.com/v1/",
  }, "production"), /official ChatGPT login/i);
  assert.throws(() => parseAgentSettingsInput({
    agentRuntime: "CODEX_CLI",
    modelOverrides: { design: "custom", development: "custom", test: "custom", image: "custom" },
  }, "production"), /account default model/i);
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
  assert.throws(() => parseAgentSettingsInput({
    agentRuntime: "CLAUDE_CODE",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-valid-secret",
  }), /model format/i);
});

test("Test Agent vision readiness updates only the active Claude configuration", async () => {
  const queries: string[] = [];
  const repository = new CoreRepository({
    pool: {
      async query(sql: string) {
        queries.push(sql);
        return { rows: [{ updated: true }], rowCount: 1 };
      },
    },
  } as never);

  assert.equal(await repository.markTestPolicyReady(7), true);
  assert.equal(await repository.markTestPolicyUnavailable(7), true);
  assert.equal(queries.length, 2);
  for (const sql of queries) {
    assert.match(sql, /^UPDATE deviludo\.instance_agent_settings/);
    assert.doesNotMatch(sql, /instance_agent_provider_profiles/);
  }
});

test("Claude settings.json accepts only the supported connection fields", () => {
  const settingsJson = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic/",
      ANTHROPIC_AUTH_TOKEN: "sk-gateway-secret",
      ANTHROPIC_MODEL: "claude-fable-5-max",
    },
  });
  assert.deepEqual(parseClaudeSettingsJson(settingsJson), {
    baseUrl: "https://gateway.example.com/anthropic/",
    apiKey: "sk-gateway-secret",
    primaryModel: "claude-fable-5-max",
  });
  assert.deepEqual(parseAgentSettingsInput({
    agentRuntime: "CLAUDE_CODE",
    settingsJson,
  }, "production"), {
    agentRuntime: "CLAUDE_CODE",
    baseUrl: "https://gateway.example.com/anthropic",
    apiKey: "sk-gateway-secret",
    primaryModel: "claude-fable-5-max",
    modelOverrides: { design: null, development: null, test: null, image: null },
  });
  assert.throws(() => parseAgentSettingsInput({
    agentRuntime: "CODEX_CLI",
    settingsJson,
  }), /official ChatGPT login/i);
  assert.throws(() => parseClaudeSettingsJson(JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com", SHELL: "/bin/sh" },
  })), /unsupported environment fields/i);
  assert.throws(() => parseClaudeSettingsJson(JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    ANTHROPIC_MODEL: "model-a",
    CLAUDE_CODE_SUBAGENT_MODEL: "model-b",
  } })), /unsupported environment fields/i);
});

test("API keys use a stable first-three and last-four mask", () => {
  assert.equal(maskApiKey("sk-local-secret-value"), "sk-********alue");
  assert.equal(isMaskedApiKey("sk-********alue"), true);
  assert.equal(isMaskedApiKey("sk-local-secret-value"), false);
});

test("the local Secret store writes a versioned instance key and returns only safe metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-agent-settings-"));
  try {
    const store = new LocalAgentSecretStore(root);
    const saved = await store.writeApiKey("sk-local-secret-value");
    assert.match(saved.secretRef, /^vault:\/\/instance\/agent-runtime\/api-key\/versions\//);
    assert.equal(saved.mask, "sk-********alue");
    assert.match(saved.fingerprint, /^sha256:[0-9a-f]{12}$/);
    assert.doesNotMatch(JSON.stringify(saved), /sk-local-secret-value/);
    assert.equal(await store.readApiKey(saved.secretRef), "sk-local-secret-value");
    assert.equal(await store.readApiKeyMask(saved.secretRef), saved.mask);
    const stored = await readFile(join(
      root,
      "instance",
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

test("the Vault Secret store rejects unsafe renewal intervals", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-vault-renewal-"));
  const tokenFile = join(root, "api.token");
  await writeFile(tokenFile, "valid-token-value", { mode: 0o600 });
  try {
    assert.throws(() => createAgentSecretStore({
      NODE_ENV: "development",
      DEVILUDO_VAULT_ADDR: "http://127.0.0.1:8200",
      DEVILUDO_VAULT_TOKEN_FILE: tokenFile,
      DEVILUDO_VAULT_TOKEN_RENEW_INTERVAL_SECONDS: "30",
    }), /renewal interval is invalid/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Vault Secret store retries once when its file-mounted token rotates", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-vault-token-"));
  const tokenFile = join(root, "api.token");
  await writeFile(tokenFile, "stale-token-value", { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  const observedTokens: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const token = new Headers(init?.headers).get("x-vault-token") ?? "";
    observedTokens.push(token);
    if (token === "stale-token-value") {
      await writeFile(tokenFile, "rotated-token-value", { mode: 0o600 });
      return new Response(null, { status: 403 });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const store = createAgentSecretStore({
      NODE_ENV: "development",
      DEVILUDO_VAULT_ADDR: "http://127.0.0.1:8200",
      DEVILUDO_VAULT_TOKEN_FILE: tokenFile,
    });
    const saved = await store.writeApiKey("sk-rotated-secret-value");
    assert.match(saved.secretRef, /^vault:\/\/instance\/agent-runtime\/api-key\/versions\//);
    assert.deepEqual(observedTokens, ["stale-token-value", "rotated-token-value"]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
