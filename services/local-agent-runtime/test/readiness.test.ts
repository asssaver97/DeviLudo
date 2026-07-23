import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { LocalAgentExecutionReceipt } from "../src/contracts";
import { LocalAgentExecutionService, LocalAgentRunCancelledError } from "../src/execution";
import { LocalAgentReadinessService } from "../src/readiness";
import { localWorkerImageDigest } from "../../../lib/agent/local-worker-identity";

const digest = `sha256:${"c".repeat(64)}`;
const preflight = {
  projectId: "project-1",
  runId: "run-1",
  profileRevisionId: "profile-claude-r5",
  installationId: "claude-installation-214",
  agent: "claude-code" as const,
  expectedVersion: "2.1.14",
  imageDigest: digest,
  adapterVersion: "1.3.0",
  providerRevisionId: "provider-claude-r1",
  credentialVersionId: "credential-claude-v1",
  model: "claude-sonnet-4-6-20250514",
  modelRoles: {
    primaryModel: "claude-sonnet-4-6-20250514",
    planningModel: "claude-opus-4-6-20250514",
    smallFastModel: "claude-haiku-4-5-20251001",
    subagentModel: "claude-sonnet-4-6-20250514",
  },
};
const execution = {
  ...preflight,
  tenantId: "tenant-1",
  attemptId: "attempt-1",
  specRevisionId: "SPEC-001",
  testPlanRevisionId: "godot-testkit-1.0.0",
  providerProtocol: "anthropic-messages" as const,
  budget: { maxTurns: 64, maxCostUsd: 25, maxInputTokens: 200_000, maxOutputTokens: 50_000 },
  timeoutSeconds: 7200,
  promptDigest: createHash("sha256").update("Implement the approved immutable game specification.").digest("hex"),
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
    tenantId: execution.tenantId,
    projectId: execution.projectId,
    runId: execution.runId,
    attemptId: execution.attemptId,
    specRevisionId: execution.specRevisionId,
    testPlanRevisionId: execution.testPlanRevisionId,
    profileRevisionId: execution.profileRevisionId,
    installationId: execution.installationId,
    imageDigest: execution.imageDigest,
    adapterVersion: execution.adapterVersion,
    providerRevisionId: execution.providerRevisionId,
    credentialVersionId: execution.credentialVersionId,
    model: execution.model,
    modelRoles: execution.modelRoles,
    agent: execution.agent,
    budget: execution.budget,
    timeoutSeconds: execution.timeoutSeconds,
    promptDigest: execution.promptDigest,
    status: "completed" as const,
    sessionId: "session-1",
    summary: "Implemented the approved fixture.",
    usage: { inputTokens: 120, outputTokens: 48, costUsd: 0.21 },
    warnings: [],
    codeReviewReceipt: {
      schemaVersion: "deviludo.agent-code-review-receipt.v1", receiptId: `review-${execution.attemptId}`,
      runId: execution.runId, attemptId: execution.attemptId, profileRevisionId: execution.profileRevisionId,
      installationId: execution.installationId, imageDigest: execution.imageDigest, model: execution.model,
      specRevisionId: execution.specRevisionId, testPlanRevisionId: execution.testPlanRevisionId,
      sourceDigest: "b".repeat(64), verdict: "PASSED", reviewDigest: "d".repeat(64),
      findingCount: 0, warningCount: 0, reviewedAt: "2026-07-18T00:00:00.000Z",
    },
    candidate: {
      scmProxy: "local-git-proxy-v1" as const,
      branch: "deviludo/run-1-attempt-1",
      baseCommitSha: "c".repeat(40),
      commitSha: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      changedFiles: ["scripts/game_state.gd"],
      draftPullRequest: null,
    },
    completedAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  } as LocalAgentExecutionReceipt;
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
  assert.equal(health.workerIdentityMode, "NOT_CONFIGURED");
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
  assert.equal(health.workerIdentityMode, "PINNED_ENV");
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

test("preflight accepts an admin-updated exact task version when it matches the observed CLI", async () => {
  const service = new LocalAgentReadinessService({
    inspector: { async inspect(executable) { return executable === "claude" ? "2.1.201" : "0.91.0"; } },
    executionEnabled: true,
    inferenceGatewayUrl: "https://inference.internal.example/v1",
    workerImageIdentity: digest,
    expectedWorkerImageIdentity: digest,
    providerBindingVerifier: { async verify() { return true; } },
  });
  const result = await service.preflight({ ...preflight, expectedVersion: "2.1.201" });
  assert.equal(result.status, "READY");
  assert.equal(result.code, "READY");
  assert.equal(result.observedVersion, "2.1.201");
});

test("localhost deterministic Worker attestation matches the admin-built immutable image identity", async () => {
  const imageDigest = await localWorkerImageDigest("claude-code", "2.1.201", "1.3.0");
  const service = new LocalAgentReadinessService({
    inspector: { async inspect(executable) { return executable === "claude" ? "2.1.201" : "0.91.0"; } },
    executionEnabled: true,
    inferenceGatewayUrl: "https://inference.internal.example/v1",
    localDeterministicWorkerAttestation: true,
    providerBindingVerifier: { async verify() { return true; } },
  });
  const request = { ...preflight, expectedVersion: "2.1.201", adapterVersion: "1.3.0", imageDigest };
  const health = await service.health();
  assert.equal(health.workerIdentityMode, "LOCAL_DETERMINISTIC");
  assert.equal(health.workerImageVerified, true);
  assert.equal((await service.preflight(request)).code, "READY");
  assert.equal((await service.preflight({ ...request, imageDigest: digest })).code, "WORKER_IMAGE_MISMATCH");
  const futureAdapterDigest = await localWorkerImageDigest("claude-code", "2.1.201", "1.4.0");
  assert.equal((await service.preflight({ ...request, adapterVersion: "1.4.0", imageDigest: futureAdapterDigest })).code, "ADAPTER_MISMATCH");
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

  const roleDrift = new LocalAgentExecutionService({
    readiness: readyService(),
    executor: { async execute() { return receipt({ modelRoles: { ...execution.modelRoles, smallFastModel: "claude-haiku-other-20260101" } }); } },
  });
  await assert.rejects(roleDrift.execute(execution), /immutable run lock/);

  await assert.rejects(
    service.execute({ ...execution, promptDigest: "f".repeat(64) }),
    /prompt digest/,
  );
});

test("active execution is coalesced and an exact cancellation aborts every waiter", async () => {
  let calls = 0;
  let observedSignal: AbortSignal | undefined;
  const service = new LocalAgentExecutionService({
    readiness: readyService(),
    executor: {
      async execute(_request, signal) {
        calls += 1;
        observedSignal = signal;
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("executor observed cancellation"));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
        return receipt();
      },
    },
  });
  const first = service.execute(execution);
  const second = service.execute(execution);
  const settled = Promise.allSettled([first, second]);
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));

  const cancellation = service.cancel({
    tenantId: execution.tenantId,
    projectId: execution.projectId,
    runId: execution.runId,
    attemptId: execution.attemptId,
    reason: "The project owner cancelled this delivery.",
  });
  assert.equal(cancellation.state, "CANCELLATION_REQUESTED");
  assert.equal(observedSignal?.aborted, true);
  const results = await settled;
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.status === "rejected" && result.reason instanceof LocalAgentRunCancelledError));
  assert.equal(service.cancel({
    tenantId: execution.tenantId,
    projectId: execution.projectId,
    runId: execution.runId,
    attemptId: execution.attemptId,
    reason: "Idempotent cancellation replay.",
  }).state, "NOT_RUNNING");
});

test("active execution rejects attempt rebinding and propagates caller disconnect", async () => {
  let calls = 0;
  const service = new LocalAgentExecutionService({
    readiness: readyService(),
    executor: {
      async execute(_request, signal) {
        calls += 1;
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("disconnected"));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
        return receipt();
      },
    },
  });
  const disconnected = new AbortController();
  const pending = service.execute(execution, disconnected.signal);
  const settled = Promise.allSettled([pending]);
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  const changedPrompt = "Implement a different specification.";
  await assert.rejects(service.execute({
    ...execution,
    prompt: changedPrompt,
    promptDigest: createHash("sha256").update(changedPrompt).digest("hex"),
  }), /already owns this immutable attempt/);
  assert.throws(() => service.cancel({
    tenantId: "tenant-other",
    projectId: execution.projectId,
    runId: execution.runId,
    attemptId: execution.attemptId,
    reason: "Cross-tenant cancellation.",
  }), /binding does not match/);
  disconnected.abort();
  const [result] = await settled;
  assert.equal(result?.status, "rejected");
  if (result?.status === "rejected") assert.ok(result.reason instanceof LocalAgentRunCancelledError);
});

test("cancellation arriving during preflight tombstones the attempt before any CLI can start", async () => {
  let releasePreflight!: () => void;
  const preflightHeld = new Promise<void>((resolve) => { releasePreflight = resolve; });
  let executorCalls = 0;
  const service = new LocalAgentExecutionService({
    readiness: new LocalAgentReadinessService({
      inspector: {
        async inspect(executable) {
          await preflightHeld;
          return executable === "claude" ? "2.1.14" : "0.91.0";
        },
      },
      executionEnabled: true,
      inferenceGatewayUrl: "https://inference.internal.example/v1",
      workerImageIdentity: digest,
      expectedWorkerImageIdentity: digest,
      providerBindingVerifier: { async verify() { return true; } },
    }),
    executor: { async execute() { executorCalls += 1; return receipt(); } },
  });
  const pending = service.execute(execution);
  const settled = Promise.allSettled([pending]);
  assert.equal(service.cancel({
    tenantId: execution.tenantId,
    projectId: execution.projectId,
    runId: execution.runId,
    attemptId: execution.attemptId,
    reason: "Cancellation raced with preflight.",
  }).state, "NOT_RUNNING");
  releasePreflight();
  const [result] = await settled;
  assert.equal(result?.status, "rejected");
  if (result?.status === "rejected") assert.ok(result.reason instanceof LocalAgentRunCancelledError);
  assert.equal(executorCalls, 0);
});

test("preflight rejects a primary/model-role mismatch before Provider verification", async () => {
  await assert.rejects(
    readyService().preflight({ ...preflight, modelRoles: { ...preflight.modelRoles, primaryModel: "claude-opus-4-6-20250514" } }),
    /primary model binding/,
  );
});
