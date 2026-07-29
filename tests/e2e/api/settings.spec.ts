import { test, expect } from "../fixtures/stack";

test("tenant Agent settings persist safely and freeze into new Agent jobs", async ({ stack }) => {
  const initial = await stack.web("/api/settings/agent");
  expect(initial.ok()).toBeTruthy();
  expect(await initial.json()).toEqual({
    settings: {
      agentRuntime: "CLAUDE_CODE",
      baseUrl: "https://api.anthropic.com",
      apiKeyConfigured: false,
      apiKeyFingerprint: null,
      revision: 0,
      updatedAt: null,
    },
  });

  for (const invalid of [
    { agentRuntime: "UNKNOWN", baseUrl: "https://api.example.com", apiKey: "sk-valid-value" },
    { agentRuntime: "CODEX_CLI", baseUrl: "http://api.example.com", apiKey: "sk-valid-value" },
    { agentRuntime: "CODEX_CLI", baseUrl: "https://user:pass@example.com", apiKey: "sk-valid-value" },
    { agentRuntime: "CODEX_CLI", baseUrl: "https://api.example.com", tenantId: "attacker" },
    { agentRuntime: "CODEX_CLI", baseUrl: "https://api.example.com" },
  ]) {
    const response = await stack.web("/api/settings/agent", { method: "PUT", data: invalid });
    expect(response.status()).toBe(400);
  }

  const apiKey = "sk-tenant-secret-value";
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
    apiKeyFingerprint: string;
    revision: number;
  } };
  expect(createdBody.settings).toMatchObject({
    agentRuntime: "CODEX_CLI",
    baseUrl: "https://api.example.com/v1",
    apiKeyConfigured: true,
    revision: 1,
  });
  expect(createdBody.settings.apiKeyFingerprint).toMatch(/^sha256:[0-9a-f]{12}$/);
  expect(JSON.stringify(createdBody)).not.toContain(apiKey);

  const project = await stack.createProject({ concept: "灯塔修理队。玩家合作维护暴风雨中的海上灯塔。" });
  const approved = await stack.web(`/api/projects/${project.id}/approve`, { method: "POST", data: {} });
  expect(approved.status()).toBe(202);
  const locked = await stack.queryRows<{ payload: { agentConfiguration: Record<string, unknown> } }>(`
    SELECT payload
      FROM deviludo.jobs
     WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
       AND workflow_id = '${project.workflowId}'::uuid
       AND kind = 'AGENT_GENERATION'
  `);
  expect(locked[0]?.payload.agentConfiguration).toMatchObject({
    runtime: "CODEX_CLI",
    baseUrl: "https://api.example.com/v1",
    revision: 1,
  });
  expect(String(locked[0]?.payload.agentConfiguration.credentialRef)).toMatch(
    /^vault:\/\/tenants\/00000000-0000-4000-8000-000000000001\//,
  );

  const updated = await stack.web("/api/settings/agent", {
    method: "PUT",
    data: { agentRuntime: "CLAUDE_CODE", baseUrl: "https://api.anthropic.com" },
  });
  expect(updated.ok()).toBeTruthy();
  const updatedBody = await updated.json() as { settings: { apiKeyFingerprint: string; revision: number } };
  expect(updatedBody.settings.apiKeyFingerprint).toBe(createdBody.settings.apiKeyFingerprint);
  expect(updatedBody.settings.revision).toBe(2);

  const rows = await stack.queryRows<{ credential_secret_ref: string; api_key_fingerprint: string }>(`
    SELECT credential_secret_ref, api_key_fingerprint
      FROM deviludo.tenant_agent_settings
     WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
  `);
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(apiKey);
  expect(rows[0].credential_secret_ref).toMatch(/^vault:\/\/tenants\/00000000-0000-4000-8000-000000000001\//);
});
