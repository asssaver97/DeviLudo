import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  matchingLocalAgentRuntimeDefault,
  publicLocalAgentRuntimeDefault,
  readLocalAgentRuntimeDefaults,
} from "@/services/core/src/agent-local-defaults";

test("local Runtime defaults expose connection fields without exposing credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-runtime-defaults-"));
  const path = join(root, "defaults.json");
  try {
    await writeFile(path, JSON.stringify({
      version: 1,
      runtimes: [
        {
          agentRuntime: "CLAUDE_CODE",
          baseUrl: "https://gateway.example.com/anthropic/",
          apiKey: "claude-local-secret",
          primaryModel: "claude-fable-5-max",
          source: "~/.claude/settings.json",
        },
        {
          agentRuntime: "CODEX_CLI",
          baseUrl: "https://chatgpt.com",
          apiKey: null,
          primaryModel: "gpt-5.6-sol",
          source: "~/.codex/config.toml",
        },
      ],
    }));
    const defaults = readLocalAgentRuntimeDefaults(path, "production");
    assert.equal(defaults.length, 2);
    assert.equal(defaults[0]?.baseUrl, "https://gateway.example.com/anthropic");
    assert.deepEqual(publicLocalAgentRuntimeDefault(defaults[0]!), {
      agentRuntime: "CLAUDE_CODE",
      baseUrl: "https://gateway.example.com/anthropic",
      primaryModel: "claude-fable-5-max",
      apiKeyConfigured: true,
      apiKeyMasked: "cla********cret",
      source: "~/.claude/settings.json",
    });
    assert.doesNotMatch(JSON.stringify(defaults.map(publicLocalAgentRuntimeDefault)), /claude-local-secret/);
    assert.equal(matchingLocalAgentRuntimeDefault(
      defaults, "CODEX_CLI", "https://chatgpt.com",
    )?.primaryModel, "gpt-5.6-sol");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local Runtime defaults reject duplicate runtimes and unsupported fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-runtime-defaults-invalid-"));
  const path = join(root, "defaults.json");
  const runtime = {
    agentRuntime: "CODEX_CLI",
    baseUrl: "https://chatgpt.com",
    apiKey: null,
    primaryModel: "account-default",
    source: "~/.codex/config.toml",
  };
  try {
    await writeFile(path, JSON.stringify({ version: 1, runtimes: [runtime, runtime] }));
    assert.throws(() => readLocalAgentRuntimeDefaults(path), /duplicate runtimes/i);
    await writeFile(path, JSON.stringify({ version: 1, runtimes: [{ ...runtime, credentialPath: "/tmp/key" }] }));
    assert.throws(() => readLocalAgentRuntimeDefaults(path), /unsupported fields/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
