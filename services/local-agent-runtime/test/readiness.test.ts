import assert from "node:assert/strict";
import test from "node:test";
import type { LocalAgentExecutionReceipt } from "../src/contracts";
import { LocalAgentExecutionService } from "../src/execution";
import { LocalAgentReadinessService } from "../src/readiness";

const digest = `sha256:${"c".repeat(64)}`;
const preflight = {
  projectId: "project-1",
  runId: "run-1",
  profileRevisionId: "profile-claude-r5",
  agent: "claude-code" as const,
  expectedVersion: "2.1.14",
  imageDigest: digest,
  providerRevisionId: "provider-claude-r1",
  credentialVersionId: "credential-claude-v1",
  model: "claude-sonnet-4-6-20250514",
};
const execution = {
  ...preflight,
  attemptId: "attempt-1",
  specRevisionId: "SPEC-001",
  installationId: "claude-installation-214",
  adapterVersion: "1.0.0",
  providerProtocol: "anthropic-messages" as const,
  prompt: "Implement the approved immutable game specification.",
};

function readyService() {
  return new LocalAgentReadinessService({
    inspector: { async inspect(executable) { return executable === "claude" ? "2.1.14" : "0.91.0"; } },
    executionEnabled: true,
    inferenceGatewayUrl: "https://inference.internal.example/v1",
    workerImageIdentity: digest,
    expectedWorkerImageIdentity: digest,
    providerBindingVerifier: { async verify() { return true; } },
  });
}

function receipt(overrides: Partial<LocalAgentExecutionReceipt> = {}): LocalAgentExecutionReceipt {
  return {
    schemaVersion: 1 as const,
    projectId: execution.projectId,
    runId: execution.runId,
    attemptId: execution.attemptId,
    specRevisionId: execution.specRevisionId,
    profileRevisionId: execution.profileRevisionId,
    installationId: execution.installationId,
    imageDigest: execution.imageDigest,
    adapterVersion: execution.adapterVersion,
    providerRevisionId: execution.providerRevisionId,
    credentialVersionId: execution.credentialVersionId,
    model: execution.model,
    agent: execution.agent,
    status: "completed" as const,
    sessionId: "session-1",
    summary: "Implemented the approved fixture.",
    usage: { inputTokens: 120, outputTokens: 48, costUsd: 0.21 },
    warnings: [],
    candidate: {
      scmProxy: "local-git-proxy-v1" as const,
      branch: "deviludo/run-1-attempt-1",
      commitSha: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      changedFiles: ["scripts/game_state.gd"],
      draftPullRequest: null,
    },
    completedAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

test("reports exact local CLI matches without claiming execution readiness", async () => {
  const service = new LocalAgentReadinessService({
    inspector: { async inspect(executable) { return executable === "claude" ? "2.1.14" : "0.91.0"; } },
    executionEnabled: false,
  });
  const health = await service.health();
  assert.equal(health.status, "degraded");
  assert.equal(health.executionEnabled, false);
  assert.equal(health.inferenceGateway, "NOT_CONFIGURED");
  assert.equal(health.workerImageIdentity, null);
  assert.equal(health.expectedWorkerImageIdentity, null);
  assert.equal(health.workerImageVerified, false);
  assert.deepEqual(health.agents.map(({ agent, state }) => ({ agent, state })), [
    { agent: "claude-code", state: "READY" },
    { agent: "codex-cli", state: "READY" },
  ]);
});

test("becomes ready only with an exact CLI, image identity, gateway and explicit execution enablement", async () => {
  const service = new LocalAgentReadinessService({
    inspector: { async inspect(executable) { return executable === "claude" ? "2.1.14" : "0.145.0-alpha.18"; } },
    executionEnabled: true,
    inferenceGatewayUrl: "https://inference.internal.example/v1",
    workerImageIdentity: digest,
    expectedWorkerImageIdentity: digest,
    providerBindingVerifier: { async verify() { return true; } },
  });
  const health = await service.health();
  assert.equal(health.status, "ok");
  assert.equal(health.inferenceGateway, "CONFIGURED");
  assert.equal(health.providerBindingProbe, "CONFIGURED");
  assert.equal(health.workerImageVerified, true);
  assert.equal(health.agents[0]?.state, "READY");
  assert.equal(health.agents[1]?.state, "VERSION_MISMATCH");
});

test("preflight reports exact installation mismatch before any execution work", async () => {
  const service = new LocalAgentReadinessService({
    inspector: { async inspect(executable) { return executable === "claude" ? "2.1.201" : "0.91.0"; } },
  });
  const result = await service.preflight(preflight);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "INSTALLATION_MISMATCH");
  assert.equal(result.observedVersion, "2.1.201");
  assert.equal(result.runId, preflight.runId);
});

test("preflight distinguishes WAITING_PROVIDER, disabled execution and ready", async () => {
  const inspector = { async inspect(executable: "claude" | "codex") { return executable === "claude" ? "2.1.14" : "0.91.0"; } };
  const base = { inspector, workerImageIdentity: digest, expectedWorkerImageIdentity: digest };
  assert.equal((await new LocalAgentReadinessService({ ...base, executionEnabled: true }).preflight(preflight)).code, "WAITING_PROVIDER");
  assert.equal((await new LocalAgentReadinessService({ ...base, inferenceGatewayUrl: "https://inference.internal.example/v1" }).preflight(preflight)).code, "WAITING_PROVIDER");
  const providerBindingVerifier = { async verify() { return true; } };
  assert.equal((await new LocalAgentReadinessService({ ...base, inferenceGatewayUrl: "https://inference.internal.example/v1", providerBindingVerifier }).preflight(preflight)).code, "EXECUTION_DISABLED");
  const ready = await new LocalAgentReadinessService({
    ...base,
    executionEnabled: true,
    inferenceGatewayUrl: "https://inference.internal.example/v1",
    providerBindingVerifier,
  }).preflight(preflight);
  assert.equal(ready.status, "READY");
  assert.equal(ready.code, "READY");
});

test("rejects an unpinned image identity and unsafe gateway value", async () => {
  const service = new LocalAgentReadinessService({
    inspector: { async inspect() { return "2.1.14"; } },
    executionEnabled: true,
    inferenceGatewayUrl: "https://user:secret@inference.internal.example/?token=secret",
    workerImageIdentity: `sha256:${"a".repeat(64)}`,
    expectedWorkerImageIdentity: `sha256:${"b".repeat(64)}`,
  });
  const health = await service.health();
  assert.equal(health.status, "degraded");
  assert.equal(health.inferenceGateway, "NOT_CONFIGURED");
  assert.equal(health.workerImageVerified, false);
});

test("does not expose probe errors and rejects floating expected versions", async () => {
  const service = new LocalAgentReadinessService({
    inspector: { async inspect() { throw new Error("/secret/path: api-key-value"); } },
  });
  const health = await service.health();
  assert.equal(health.status, "degraded");
  assert.ok(health.agents.every((agent) => agent.state === "UNAVAILABLE" && agent.observedVersion === null));
  assert.throws(() => new LocalAgentReadinessService({ claudeVersion: "latest" }), /exact versions/);
});

test("execution cannot reach an executor until every preflight gate is ready", async () => {
  let calls = 0;
  const blocked = new LocalAgentExecutionService({
    readiness: new LocalAgentReadinessService({ inspector: { async inspect() { return "2.1.201"; } } }),
    executor: { async execute() { calls += 1; return receipt(); } },
  });
  const outcome = await blocked.execute(execution);
  assert.equal(outcome.state, "BLOCKED");
  assert.equal(outcome.state === "BLOCKED" ? outcome.preflight.code : null, "INSTALLATION_MISMATCH");
  assert.equal(calls, 0);

  const missing = await new LocalAgentExecutionService({ readiness: readyService() }).execute(execution);
  assert.equal(missing.state, "EXECUTOR_NOT_CONFIGURED");
});

test("execution accepts only a complete receipt bound to the immutable lock", async () => {
  const service = new LocalAgentExecutionService({
    readiness: readyService(),
    executor: { async execute() { return receipt(); } },
  });
  const outcome = await service.execute(execution);
  assert.equal(outcome.state, "COMPLETED");
  if (outcome.state !== "COMPLETED") return;
  assert.equal(outcome.receipt.candidate.commitSha.length, 40);
  assert.equal(Object.isFrozen(outcome.receipt.candidate.changedFiles), true);

  const drifted = new LocalAgentExecutionService({
    readiness: readyService(),
    executor: { async execute() { return receipt({ credentialVersionId: "credential-other-v2" }); } },
  });
  await assert.rejects(drifted.execute(execution), /immutable run lock/);
});
