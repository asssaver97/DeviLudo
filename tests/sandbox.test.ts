import assert from "node:assert/strict";
import test from "node:test";
import type { JobProtocolV3 } from "@/services/core/src/contracts";
import { ProcessSandboxBackend, sandboxPlan } from "@/services/core/src/sandbox";

const baseJob: JobProtocolV3 = Object.freeze({
  schemaVersion: "deviludo.job.v3",
  jobId: "30000000-0000-4000-8000-000000000001",
  workflowId: "30000000-0000-4000-8000-000000000002",
  workspaceId: "30000000-0000-4000-8000-000000000003",
  projectId: "30000000-0000-4000-8000-000000000004",
  poolKind: "CORE",
  jobKind: "AGENT_GENERATION",
  targetOperatingSystem: null,
  requiredCapabilities: Object.freeze(["MICROVM", "NETWORK_POLICY"]),
  exclusive: false,
  isolationGeneration: 1,
  payload: Object.freeze({}),
  lease: Object.freeze({
    token: "lease_token_abcdefghijklmnopqrstuvwxyz",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    fencingToken: 1,
  }),
});

test("sandbox plans isolate each Core job and select the fixed execution policy", () => {
  const agent = sandboxPlan(baseJob);
  assert.equal(agent.mode, "MICROVM");
  assert.equal(agent.networkPolicy, "AGENT_EGRESS_ALLOWLIST");
  assert.match(agent.workspace, new RegExp(`${baseJob.workspaceId}.+${baseJob.jobId}`));

  const build = sandboxPlan(Object.freeze({
    ...baseJob,
    jobKind: "ARTIFACT_BUILD",
    requiredCapabilities: Object.freeze(["RESTRICTED_CONTAINER", "BUILD_TOOLCHAIN"]),
  }));
  assert.equal(build.mode, "RESTRICTED_CONTAINER");
  assert.equal(build.networkPolicy, "BUILD_EGRESS_DENY");

  const publish = sandboxPlan(Object.freeze({
    ...baseJob,
    jobKind: "STEAM_PUBLISH",
    requiredCapabilities: Object.freeze(["RESTRICTED_CONTAINER", "STEAMCMD"]),
  }));
  assert.equal(publish.networkPolicy, "STEAM_ONLY");
  assert.throws(() => sandboxPlan(Object.freeze({ ...baseJob, exclusive: true })));
});

test("Agent sandbox plans consume only the frozen instance configuration reference", () => {
  const configured = sandboxPlan(Object.freeze({
    ...baseJob,
    payload: Object.freeze({
      agentConfiguration: Object.freeze({
        runtime: "CODEX_CLI",
        baseUrl: "https://api.example.com/v1",
        models: null,
        credentialRef: "vault://instance/agent-runtime/api-key/versions/30000000-0000-4000-8000-000000000099",
        revision: 3,
      }),
    }),
  }));
  assert.deepEqual(configured.agentConfiguration, {
    runtime: "CODEX_CLI",
    baseUrl: "https://api.example.com/v1",
    models: null,
    credentialRef: "vault://instance/agent-runtime/api-key/versions/30000000-0000-4000-8000-000000000099",
    credentialEnvironmentVariable: "OPENAI_API_KEY",
    environment: { OPENAI_BASE_URL: "https://api.example.com/v1" },
    revision: 3,
  });
  assert.throws(() => sandboxPlan(Object.freeze({
    ...baseJob,
    payload: Object.freeze({
      agentConfiguration: Object.freeze({
        ...configured.agentConfiguration,
        credentialRef: "vault://invalid/agent-runtime/api-key/versions/x",
      }),
    }),
  })), /configuration lock/i);
});

test("Claude Code sandbox plans map each configured model route to its environment variable", () => {
  const configured = sandboxPlan(Object.freeze({
    ...baseJob,
    payload: Object.freeze({
      agentConfiguration: Object.freeze({
        runtime: "CLAUDE_CODE",
        baseUrl: "https://www.sotamodel.net",
        models: {
          primary: "claude-fable-5-max",
          opus: "claude-opus-route",
          sonnet: "claude-sonnet-route",
          haiku: "claude-haiku-route",
          subagent: "claude-subagent-route",
        },
        credentialRef: "vault://instance/agent-runtime/api-key/versions/30000000-0000-4000-8000-000000000099",
        revision: 4,
      }),
    }),
  }));
  assert.equal(configured.agentConfiguration?.credentialEnvironmentVariable, "ANTHROPIC_AUTH_TOKEN");
  assert.deepEqual(configured.agentConfiguration?.environment, {
    ANTHROPIC_BASE_URL: "https://www.sotamodel.net",
    ANTHROPIC_MODEL: "claude-fable-5-max",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-route",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-route",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-route",
    CLAUDE_CODE_SUBAGENT_MODEL: "claude-subagent-route",
  });
});

test("production sandbox execution fails closed without a trusted backend", async () => {
  const backend = new ProcessSandboxBackend("", true);
  await assert.rejects(() => backend.execute(
    sandboxPlan(baseJob),
    new AbortController().signal,
  ), /trusted sandbox executor/i);
});
