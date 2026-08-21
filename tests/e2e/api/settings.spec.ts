import { test, expect } from "../fixtures/stack";

test("instance Agent settings persist safely and freeze into workspace jobs", async ({ stack }) => {
  const initial = await stack.web("/api/settings/agent");
  expect(initial.ok()).toBeTruthy();
  const initialBody = await initial.json();
  expect(initialBody).toMatchObject({
    settings: {
      agentRuntime: "CLAUDE_CODE",
      baseUrl: "https://api.anthropic.com",
      primaryModel: "claude-sonnet-4-5",
      modelOverrides: { design: null, development: null, test: null },
      imageModel: null,
      imageGenerationBackend: null,
      apiKeyConfigured: false,
      apiKeyMasked: null,
      apiKeyFingerprint: null,
      revision: 0,
      updatedAt: null,
    },
  });
  expect(initialBody.runtimes).toEqual([
    { kind: "CLAUDE_CODE", installed: false, version: null, scope: "CORE_RUNTIME", authentication: null },
    { kind: "CODEX_CLI", installed: true, version: "0.149.0", scope: "CORE_RUNTIME", authentication: "SIGNED_OUT" },
  ]);

  for (const invalid of [
    { agentRuntime: "UNKNOWN", baseUrl: "https://api.example.com", apiKey: "sk-valid-value" },
    { agentRuntime: "CODEX_CLI", baseUrl: "http://api.example.com", model: "gpt-5.3-codex", apiKey: "sk-valid-value" },
    { agentRuntime: "CODEX_CLI", baseUrl: "https://user:pass@example.com", model: "gpt-5.3-codex", apiKey: "sk-valid-value" },
    { agentRuntime: "CODEX_CLI", baseUrl: "https://api.example.com", model: "gpt-5.3-codex", workspaceId: "attacker" },
    { agentRuntime: "CODEX_CLI", baseUrl: "https://api.example.com", model: "gpt-5.3-codex" },
  ]) {
    const response = await stack.web("/api/settings/agent", { method: "PUT", data: invalid });
    expect(response.status()).toBe(400);
  }

  const apiKey = "sk-claude-instance-secret";
  const created = await stack.web("/api/settings/agent", {
    method: "PUT",
    data: {
      agentRuntime: "CLAUDE_CODE",
      settingsJson: JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_MODEL: "claude-fable-5-max",
        },
      }),
      imageModel: "gpt-image-1",
    },
  });
  const createdText = await created.text();
  expect(created.ok(), createdText).toBeTruthy();
  const createdBody = JSON.parse(createdText) as { settings: {
    agentRuntime: string;
    baseUrl: string;
    apiKeyConfigured: boolean;
    apiKeyMasked: string;
    apiKeyFingerprint: string;
    primaryModel: string;
    modelOverrides: Record<string, string | null>;
    imageModel: string | null;
    imageGenerationBackend: "HTTP_IMAGES" | "CODEX_IMAGEGEN" | null;
    imageGenerationReady: boolean;
    revision: number;
  } };
  expect(createdBody.settings).toMatchObject({
    agentRuntime: "CLAUDE_CODE",
    baseUrl: "https://api.anthropic.com",
    apiKeyConfigured: true,
    apiKeyMasked: "sk-********cret",
    imageModel: "gpt-image-1",
    imageGenerationBackend: "HTTP_IMAGES",
    imageGenerationReady: true,
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
    runtime: "CLAUDE_CODE",
    baseUrl: "https://api.anthropic.com",
    model: "claude-fable-5-max",
    revision: 1,
  });
  expect(String(locked[0]?.payload.agentConfiguration.credentialRef)).toMatch(
    /^vault:\/\/instance\/agent-runtime\/api-key\/versions\//,
  );

  expect(createdBody.settings.primaryModel).toBe("claude-fable-5-max");
  expect(createdBody.settings.modelOverrides).toEqual({ design: null, development: null, test: null });
  expect(createdBody.settings.imageModel).toBe("gpt-image-1");

  const rows = await stack.queryRows<{
    agent_runtime: string;
    credential_secret_ref: string;
    api_key_mask: string;
    api_key_fingerprint: string;
  }>(`
    SELECT agent_runtime::text, credential_secret_ref, api_key_mask, api_key_fingerprint
      FROM deviludo.instance_agent_settings
  `);
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(apiKey);
  expect(rows[0].agent_runtime).toBe("CLAUDE_CODE");
  expect(rows[0].api_key_mask).toBe(createdBody.settings.apiKeyMasked);
  expect(rows.every(row => /^vault:\/\/instance\/agent-runtime\/api-key\/versions\//.test(row.credential_secret_ref))).toBe(true);
});
