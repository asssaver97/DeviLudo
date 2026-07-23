import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { LocalAgentExecutionReceipt, LocalAgentExecutionRequest } from "../src/contracts";
import { localAgentRuntimeFromEnvironment, parseLocalAgentExecutionRequest } from "../src/server";

const key = new Uint8Array(Buffer.alloc(32, 11));
const imageDigest = `sha256:${"c".repeat(64)}`;
const request: LocalAgentExecutionRequest = Object.freeze({
  tenantId: "tenant-1",
  projectId: "project-1",
  runId: "run-1",
  attemptId: "attempt-1",
  specRevisionId: "SPEC-001",
  testPlanRevisionId: "godot-testkit-1.0.0",
  profileRevisionId: "profile-claude-r5",
  installationId: "claude-installation-214",
  agent: "claude-code",
  expectedVersion: "2.1.14",
  imageDigest,
  adapterVersion: "1.3.0",
  providerRevisionId: "provider-claude-r1",
  credentialVersionId: "credential-claude-v1",
  providerProtocol: "anthropic-messages",
  model: "claude-sonnet-4-6-20250514",
  modelRoles: Object.freeze({
    primaryModel: "claude-sonnet-4-6-20250514",
    planningModel: "claude-opus-4-6-20250514",
    smallFastModel: "claude-haiku-4-5-20251001",
    subagentModel: "claude-sonnet-4-6-20250514",
  }),
  budget: Object.freeze({ maxTurns: 64, maxCostUsd: 25, maxInputTokens: 200_000, maxOutputTokens: 50_000 }),
  timeoutSeconds: 7200,
  promptDigest: createHash("sha256").update("Implement the approved immutable game specification.").digest("hex"),
  prompt: "Implement the approved immutable game specification.",
});

test("standalone local Agent host factory composes trusted Provider and isolated executor dependencies", async () => {
  let providerChecks = 0;
  let executions = 0;
  const runtime = localAgentRuntimeFromEnvironment({
    DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY: Buffer.from(key).toString("base64url"),
    DEVILUDO_LOCAL_AGENT_RUNTIME_PORT: "4312",
    DEVILUDO_LOCAL_CLAUDE_EXPECTED_VERSION: "2.1.14",
    DEVILUDO_LOCAL_CODEX_EXPECTED_VERSION: "0.91.0",
    DEVILUDO_LOCAL_AGENT_EXECUTION: "1",
    DEVILUDO_LOCAL_INFERENCE_GATEWAY_URL: "https://inference.internal.example/v1",
    DEVILUDO_WORKER_IMAGE_DIGEST: imageDigest,
    DEVILUDO_LOCAL_EXPECTED_WORKER_IMAGE_DIGEST: imageDigest,
  }, {
    cliVersionInspector: { async inspect(executable) { return executable === "claude" ? "2.1.14" : "0.91.0"; } },
    providerBindingVerifier: {
      async verify(binding) {
        providerChecks += 1;
        return binding.providerRevisionId === request.providerRevisionId
          && binding.credentialVersionId === request.credentialVersionId
          && binding.model === request.model;
      },
    },
    executor: {
      async execute(command) {
        executions += 1;
        assert.deepEqual(command, request);
        return receipt(command);
      },
    },
  });

  assert.equal(runtime.server.listening, false);
  const health = await runtime.readiness.health();
  assert.equal(health.status, "ok");
  const outcome = await runtime.execution.execute(request);
  assert.equal(outcome.state, "COMPLETED");
  if (outcome.state !== "COMPLETED") assert.fail("expected a completed local Agent run");
  assert.equal(outcome.receipt.candidate.commitSha, "a".repeat(40));
  assert.equal(outcome.receipt.providerRevisionId, request.providerRevisionId);
  assert.equal(providerChecks, 1);
  assert.equal(executions, 1);
});

test("standalone local Agent host stays fail-closed when trusted dependencies are absent", async () => {
  const runtime = localAgentRuntimeFromEnvironment({
    DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY: Buffer.from(key).toString("base64url"),
    DEVILUDO_LOCAL_AGENT_RUNTIME_PORT: "4312",
  }, {
    cliVersionInspector: { async inspect(executable) { return executable === "claude" ? "2.1.14" : "0.91.0"; } },
  });
  const health = await runtime.readiness.health();
  assert.equal(health.status, "degraded");
  assert.equal(health.executionEnabled, false);
  assert.equal(health.providerBindingProbe, "NOT_CONFIGURED");
  assert.equal(health.workerImageVerified, false);
  assert.equal(health.workerIdentityMode, "NOT_CONFIGURED");
  const result = await runtime.execution.execute(request);
  assert.equal(result.state, "BLOCKED");
});

test("standalone local Agent request contract rejects caller-controlled workspace fields", () => {
  assert.throws(
    () => parseLocalAgentExecutionRequest({ ...request, workspaceRoot: "/tmp/caller-selected" }),
    /request shape/,
  );
  assert.deepEqual(parseLocalAgentExecutionRequest(request), request);
});

test("deterministic Worker attestation can only be enabled by the explicit localhost test deployment", async () => {
  const base = {
    DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY: Buffer.from(key).toString("base64url"),
    DEVILUDO_LOCAL_AGENT_RUNTIME_PORT: "4312",
    DEVILUDO_LOCAL_DETERMINISTIC_WORKER_ATTESTATION: "1",
  };
  const dependencies = {
    cliVersionInspector: { async inspect(executable: "claude" | "codex") { return executable === "claude" ? "2.1.14" : "0.91.0"; } },
  };
  const productionLike = localAgentRuntimeFromEnvironment(base, dependencies);
  assert.equal((await productionLike.readiness.health()).workerIdentityMode, "NOT_CONFIGURED");

  const localhost = localAgentRuntimeFromEnvironment({ ...base, DEVILUDO_LOCAL_TEST_MODE: "1" }, dependencies);
  const health = await localhost.readiness.health();
  assert.equal(health.workerIdentityMode, "LOCAL_DETERMINISTIC");
  assert.equal(health.workerImageVerified, true);
});

function receipt(command: LocalAgentExecutionRequest): LocalAgentExecutionReceipt {
  return Object.freeze({
    schemaVersion: 1,
    tenantId: command.tenantId,
    projectId: command.projectId,
    runId: command.runId,
    attemptId: command.attemptId,
    specRevisionId: command.specRevisionId,
    testPlanRevisionId: command.testPlanRevisionId,
    profileRevisionId: command.profileRevisionId,
    installationId: command.installationId,
    imageDigest: command.imageDigest,
    adapterVersion: command.adapterVersion,
    providerRevisionId: command.providerRevisionId,
    credentialVersionId: command.credentialVersionId,
    model: command.model,
    modelRoles: command.modelRoles,
    agent: command.agent,
    budget: command.budget,
    timeoutSeconds: command.timeoutSeconds,
    promptDigest: command.promptDigest,
    status: "completed",
    sessionId: "session-1",
    summary: "Implemented the approved fixture.",
    usage: Object.freeze({ inputTokens: 120, outputTokens: 48, costUsd: 0.21 }),
    warnings: Object.freeze([]),
    codeReviewReceipt: Object.freeze({
      schemaVersion: "deviludo.agent-code-review-receipt.v1", receiptId: `review-${command.attemptId}`,
      runId: command.runId, attemptId: command.attemptId, profileRevisionId: command.profileRevisionId,
      installationId: command.installationId, imageDigest: command.imageDigest, model: command.model,
      specRevisionId: command.specRevisionId, testPlanRevisionId: command.testPlanRevisionId,
      sourceDigest: "b".repeat(64), verdict: "PASSED", reviewDigest: "d".repeat(64),
      findingCount: 0, warningCount: 0, reviewedAt: "2026-07-21T00:00:00.000Z",
    }),
    candidate: Object.freeze({
      scmProxy: "local-git-proxy-v1",
      branch: "deviludo/run-1-attempt-1",
      baseCommitSha: "c".repeat(40),
      commitSha: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      changedFiles: Object.freeze(["scripts/game_state.gd"]),
      draftPullRequest: null,
    }),
    completedAt: "2026-07-21T00:00:00.000Z",
  });
}
