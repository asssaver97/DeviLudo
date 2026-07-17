import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeCodeAdapter, CodexCliAdapter } from "../adapters/index.ts";
import { normalizeModelRoles } from "../lib/agent/providers.ts";
import { selectRunnableProfile } from "../lib/agent/provider-selection.ts";
import { fingerprintSecret, issueRunToken, verifyRunToken, verifyRunTokenIntegrity } from "../lib/security/credentials.ts";
import { validateEndpointForConnection, validateProviderBaseUrl } from "../lib/security/network.ts";

const digest = `sha256:${"a".repeat(64)}`;

function profile(agent) {
  const primaryModel = agent === "claude-code" ? "claude-sonnet-4-6-20250514" : "gpt-5.3-codex-2026-06-12";
  return {
    profileRevisionId: `profile-${agent}-r1`, profileId: `profile-${agent}`, revision: 1, agent,
    installation: { installationId: `install-${agent}`, agent, cliVersion: "1.2.3", imageDigest: digest, adapterVersion: "adapter-1", workerPoolId: "dev-linux" },
    providerRevisionId: `provider-${agent}-r1`, models: normalizeModelRoles({ primaryModel }),
    credential: { bindingId: `binding-${agent}`, credentialVersionId: `credential-${agent}-v1` },
    budget: { maxTurns: 30, maxCostUsd: 12 }, timeoutSeconds: 1800,
    permissions: { sandbox: "workspace-write", network: "inference-gateway-only", scmWrite: "proxy-only", allowProjectHooks: false, allowProjectMcp: false, allowProjectPlugins: false },
    allowedFallbackProfileRevisionIds: [],
  };
}

const context = {
  tenantId: "tenant-1", projectId: "project-1", runId: "run-1", attemptId: "attempt-1",
  commitSha: "8b7e4a2b7c9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f", specificationRevisionId: "SPEC-008",
  testPlanRevisionId: "test-plan-1", runRoot: "/runs/run-1", inferenceGatewayUrl: "https://inference.internal.example/v1",
  runTokenSecretRef: "vault://transit/run-token/run-1",
};

test("adapters pin safe CLI arguments and route only through the internal gateway", () => {
  const claude = new ClaudeCodeAdapter();
  const claudeRuntime = claude.start(claude.prepare(context, profile("claude-code")), "Implement the approved spec", "/workspace");
  assert.equal(claudeRuntime.executable, "claude");
  assert.ok(claudeRuntime.args.includes("--no-session-persistence"));
  assert.equal(claudeRuntime.env.DISABLE_UPDATES, "1");
  assert.equal(claudeRuntime.env.ANTHROPIC_BASE_URL, context.inferenceGatewayUrl);
  assert.equal(claudeRuntime.secretEnv.ANTHROPIC_API_KEY, context.runTokenSecretRef);
  assert.doesNotMatch(JSON.stringify(claudeRuntime), /dangerously-skip|--yolo/);

  const codex = new CodexCliAdapter();
  const codexRuntime = codex.start(codex.prepare(context, profile("codex-cli")), "Implement the approved spec", "/workspace");
  assert.deepEqual(codexRuntime.args.slice(0, 3), ["exec", "--json", "--ephemeral"]);
  assert.ok(codexRuntime.args.includes("--output-schema"));
  assert.ok(codexRuntime.args.includes("workspace-write"));
  assert.equal(codexRuntime.secretEnv.DEVILUDO_RUN_TOKEN, context.runTokenSecretRef);
});

test("provider validation blocks static and DNS-based SSRF", async () => {
  for (const url of ["http://api.example.com", "https://127.0.0.1", "https://169.254.169.254", "https://user:pass@api.example.com", "https://api.example.com?key=secret", "https://api.example.com:8443"]) {
    assert.throws(() => validateProviderBaseUrl(url), /HTTPS|non-public|user|query|approved/);
  }
  const resolver = { resolve: async () => [{ address: "10.0.0.4", family: 4 }] };
  await assert.rejects(validateEndpointForConnection("https://provider.example.com", resolver), /non-public/);
  const publicResolver = { resolve: async () => [{ address: "93.184.216.34", family: 4 }] };
  const endpoint = await validateEndpointForConnection("https://provider.example.com/v1", publicResolver);
  assert.equal(endpoint.port, 443);
  assert.equal(endpoint.connectAddresses[0].address, "93.184.216.34");
});

test("no fallback means provider failure pauses instead of switching Agent", () => {
  const primary = profile("claude-code");
  const selection = selectRunnableProfile({ primary, primaryHealth: "UNAVAILABLE", projectAllowedFallbackProfileRevisionIds: [] });
  assert.equal(selection.state, "WAITING_PROVIDER");
  assert.equal(selection.usedFallback, false);
  assert.equal(selection.profile, undefined);
});

test("credentials are fingerprinted and short run tokens are bound to one run", async () => {
  const fingerprint = await fingerprintSecret(new TextEncoder().encode("secret-value-long-enough"));
  assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/);
  const key = new Uint8Array(32).fill(7);
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "deviludo-control-plane", aud: "deviludo-inference-gateway", tenantId: "tenant-1", projectId: "project-1", runId: "run-1",
    profileRevisionId: "profile-r1", credentialVersionId: "credential-v1", providerRevisionId: "provider-r1",
    models: ["claude-sonnet-4-6-20250514"], budget: { maxCostUsd: 10 }, iat: now, exp: now + 600, nonce: "nonce-1",
  };
  const token = await issueRunToken(key, claims);
  const verified = await verifyRunToken(key, token, { tenantId: "tenant-1", projectId: "project-1", runId: "run-1", profileRevisionId: "profile-r1" }, now + 1);
  assert.equal(verified.credentialVersionId, "credential-v1");
  const integrity = await verifyRunTokenIntegrity(key, token, now + 1);
  assert.equal(Object.isFrozen(integrity.models), true);
  assert.equal(Object.isFrozen(integrity.budget), true);
  await assert.rejects(verifyRunToken(key, token, { tenantId: "tenant-1", projectId: "other", runId: "run-1", profileRevisionId: "profile-r1" }, now + 1), /binding mismatch/);
});
