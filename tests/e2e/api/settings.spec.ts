import { test, expect } from "../fixtures/stack";

test("instance Agent settings persist safely and freeze into workspace jobs", async ({ stack }) => {
  const initial = await stack.web("/api/settings/agent");
  expect(initial.ok()).toBeTruthy();
  const initialBody = await initial.json();
  expect(initialBody).toMatchObject({
    settings: {
      agentRuntime: "CLAUDE_CODE",
      baseUrl: "https://api.anthropic.com",
      models: null,
      apiKeyConfigured: false,
      apiKeyMasked: null,
      apiKeyFingerprint: null,
      revision: 0,
      updatedAt: null,
    },
  });
  expect(initialBody.runtimes).toEqual([
    { kind: "CLAUDE_CODE", installed: false, version: null, scope: "CORE_RUNTIME" },
    { kind: "CODEX_CLI", installed: false, version: null, scope: "CORE_RUNTIME" },
  ]);

  for (const invalid of [
    { agentRuntime: "UNKNOWN", baseUrl: "https://api.example.com", apiKey: "sk-valid-value" },
    { agentRuntime: "CODEX_CLI", baseUrl: "http://api.example.com", apiKey: "sk-valid-value" },
    { agentRuntime: "CODEX_CLI", baseUrl: "https://user:pass@example.com", apiKey: "sk-valid-value" },
    { agentRuntime: "CODEX_CLI", baseUrl: "https://api.example.com", workspaceId: "attacker" },
    { agentRuntime: "CODEX_CLI", baseUrl: "https://api.example.com" },
  ]) {
    const response = await stack.web("/api/settings/agent", { method: "PUT", data: invalid });
    expect(response.status()).toBe(400);
  }

  const apiKey = "sk-instance-secret-value";
  const created = await stack.web("/api/settings/agent", {
    method: "PUT",
    data: { agentRuntime: "CODEX_CLI", baseUrl: "https://api.example.com/v1/", apiKey },
  });
  const createdText = await created.text();
  expect(created.ok(), createdText).toBeTruthy();
  const createdBody = JSON.parse(createdText) as { settings: {
    agentRuntime: string;
    baseUrl: string;
    apiKeyConfigured: boolean;
    apiKeyMasked: string;
    apiKeyFingerprint: string;
    revision: number;
  } };
  expect(createdBody.settings).toMatchObject({
    agentRuntime: "CODEX_CLI",
    baseUrl: "https://api.example.com/v1",
    apiKeyConfigured: true,
    apiKeyMasked: "sk-********alue",
    revision: 1,
  });
  expect(createdBody.settings.apiKeyFingerprint).toMatch(/^sha256:[0-9a-f]{12}$/);
  expect(JSON.stringify(createdBody)).not.toContain(apiKey);

  const mismatchedMask = await stack.web("/api/settings/agent", {
    method: "PUT",
    data: {
      agentRuntime: "CODEX_CLI",
      baseUrl: "https://api.example.com/v1",
      apiKey: "bad********mask",
    },
  });
  expect(mismatchedMask.status()).toBe(400);

  const project = await stack.createProject({ concept: "灯塔修理队。玩家合作维护暴风雨中的海上灯塔。" });
  const approved = await stack.web(`/api/projects/${project.id}/approve`, { method: "POST", data: {} });
  expect(approved.status()).toBe(202);
  const locked = await stack.queryRows<{ payload: { agentConfiguration: Record<string, unknown> } }>(`
    SELECT payload
      FROM deviludo.jobs
     WHERE workspace_id = '${project.workspaceId}'::uuid
       AND workflow_id = '${project.workflowId}'::uuid
       AND kind = 'AGENT_GENERATION'
  `);
  expect(locked[0]?.payload.agentConfiguration).toMatchObject({
    runtime: "CODEX_CLI",
    baseUrl: "https://api.example.com/v1",
    revision: 1,
  });
  expect(String(locked[0]?.payload.agentConfiguration.credentialRef)).toMatch(
    /^vault:\/\/instance\/agent-runtime\/api-key\/versions\//,
  );

  const updated = await stack.web("/api/settings/agent", {
    method: "PUT",
    data: {
      agentRuntime: "CLAUDE_CODE",
      settingsJson: JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_AUTH_TOKEN: createdBody.settings.apiKeyMasked,
          ANTHROPIC_MODEL: "claude-fable-5-max",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-route",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-route",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-route",
          CLAUDE_CODE_SUBAGENT_MODEL: "claude-subagent-route",
        },
      }),
    },
  });
  expect(updated.ok()).toBeTruthy();
  const updatedBody = await updated.json() as {
    settings: {
      apiKeyMasked: string;
      apiKeyFingerprint: string;
      models: Record<string, string> | null;
      revision: number;
    };
  };
  expect(updatedBody.settings.apiKeyMasked).toBe(createdBody.settings.apiKeyMasked);
  expect(updatedBody.settings.apiKeyFingerprint).toBe(createdBody.settings.apiKeyFingerprint);
  expect(updatedBody.settings.revision).toBe(2);
  expect(updatedBody.settings.models).toEqual({
    primary: "claude-fable-5-max",
    opus: "claude-opus-route",
    sonnet: "claude-sonnet-route",
    haiku: "claude-haiku-route",
    subagent: "claude-subagent-route",
  });

  const rows = await stack.queryRows<{
    credential_secret_ref: string;
    api_key_mask: string;
    api_key_fingerprint: string;
  }>(`
    SELECT credential_secret_ref, api_key_mask, api_key_fingerprint
      FROM deviludo.instance_agent_settings
     WHERE singleton = true
  `);
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(apiKey);
  expect(rows[0].api_key_mask).toBe(createdBody.settings.apiKeyMasked);
  expect(rows[0].credential_secret_ref).toMatch(/^vault:\/\/instance\/agent-runtime\/api-key\/versions\//);
});
