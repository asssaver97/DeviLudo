import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentExecutionRequest, SupervisedExecutionResult, SupervisedRun } from "../../agent-worker/src/contracts";
import type { LocalAgentExecutionRequest } from "../src/contracts";
import { IsolatedLocalAgentExecutor } from "../src/isolated-executor";
import { AGENT_CODE_REVIEW_OUTPUT_PATH } from "../../../lib/agent/code-review";

function request(agent: "claude-code" | "codex-cli", suffix: string): LocalAgentExecutionRequest {
  const claude = agent === "claude-code";
  const prompt = "Implement the immutable test specification.";
  return {
    tenantId: "tenant-1",
    projectId: `project-${suffix}`,
    runId: `run-${suffix}`,
    attemptId: `attempt-${suffix}`,
    specRevisionId: "SPEC-001",
    testPlanRevisionId: "godot-testkit-1.0.0",
    profileRevisionId: `profile-${claude ? "claude" : "codex"}-r1`,
    installationId: `${claude ? "claude" : "codex"}-installation-1`,
    agent,
    expectedVersion: claude ? "2.1.14" : "0.91.0",
    imageDigest: `sha256:${claude ? "a".repeat(64) : "b".repeat(64)}`,
    adapterVersion: claude ? "1.3.0" : "1.2.2",
    providerRevisionId: `provider-${claude ? "claude" : "codex"}-r1`,
    providerProtocol: claude ? "anthropic-messages" : "openai-responses",
    credentialVersionId: `credential-${claude ? "claude" : "codex"}-v1`,
    model: claude ? "claude-sonnet-4-6-20250514" : "gpt-5.3-codex-2026-06-12",
    modelRoles: claude ? {
      primaryModel: "claude-sonnet-4-6-20250514",
      planningModel: "claude-opus-4-6-20250514",
      smallFastModel: "claude-haiku-4-5-20251001",
      subagentModel: "claude-sonnet-4-6-20250514",
    } : {
      primaryModel: "gpt-5.3-codex-2026-06-12",
      planningModel: "gpt-5.3-codex-2026-06-12",
      smallFastModel: "gpt-5.3-mini-2026-06-12",
      subagentModel: "gpt-5.3-codex-2026-06-12",
    },
    budget: { maxTurns: 64, maxCostUsd: 25, maxInputTokens: 200_000, maxOutputTokens: 50_000 },
    timeoutSeconds: 7200,
    promptDigest: createHash("sha256").update(prompt).digest("hex"),
    prompt,
  };
}

function completed(request: AgentExecutionRequest): SupervisedRun {
  const result: SupervisedExecutionResult = Object.freeze({
    status: "completed",
    events: Object.freeze([]),
    result: Object.freeze({
      status: "completed",
      sessionId: `session-${request.runHandle.agent}`,
      summary: "Implemented through the isolated executor.",
      usage: Object.freeze({ inputTokens: 100, outputTokens: 40, costUsd: 0.2 }),
      changedFiles: Object.freeze(["scripts/main.gd"]),
      warnings: Object.freeze([]),
    }),
    diagnostics: Object.freeze({
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      durationMs: 5,
      stderr: "",
      droppedJsonLines: 0,
      adapter: Object.freeze({ eventCount: 1, warningCount: 0, lastEventType: "completed", messages: Object.freeze([]) }),
    }),
  });
  return Object.freeze({ completion: Promise.resolve(result), cancel: () => false });
}

for (const agent of ["claude-code", "codex-cli"] as const) {
  test(`isolated executor composes ${agent}, a short token and the authoritative SCM candidate`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), `deviludo-executor-${agent}-`));
    const storageRoot = path.join(root, "storage");
    const input = request(agent, agent === "claude-code" ? "claude" : "codex");
    let supervisorCalls = 0;
    let tokenCalls = 0;
    const executor = new IsolatedLocalAgentExecutor({
      storageRoot,
      gatewayUrl: "https://inference.internal.example/v1",
      workspaceProvisioner: {
        async provision(_request, workspaceRoot) {
          await mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });
          await writeFile(path.join(workspaceRoot, "project.godot"), "[application]\nconfig/name=\"Executor\"\n", "utf8");
          await writeFile(path.join(workspaceRoot, "scripts", "main.gd"), "extends Node\n", "utf8");
        },
      },
      runTokenBroker: {
        async issue({ request: issued, baseCommitSha }) {
          tokenCalls += 1;
          assert.equal(issued.runId, input.runId);
          assert.match(baseCommitSha, /^[a-f0-9]{40}$/);
          return { secretRef: `secret://run-token/${issued.runId}/${issued.attemptId}` };
        },
      },
      supervisor: {
        async start(supervised) {
          supervisorCalls += 1;
          assert.equal(supervised.adapter.agent, agent);
          assert.equal(supervised.installationProbe.expectedVersion, input.expectedVersion);
          assert.equal(supervised.runtimeSpec.cwd, supervised.workspaceRoot);
          assert.equal(JSON.stringify(supervised.runtimeSpec).includes("raw-upstream-key"), false);
          assert.equal(Object.values(supervised.runtimeSpec.secretEnv)[0]?.startsWith("secret://run-token/"), true);
          if (agent === "claude-code") assert.equal(supervised.runtimeSpec.args.includes("--no-session-persistence"), true);
          else assert.equal(supervised.runtimeSpec.args.includes("--ephemeral"), true);
          await writeFile(path.join(supervised.workspaceRoot, "scripts", "main.gd"), "extends Node\nfunc _ready():\n\tprint(\"agent\")\n", "utf8");
          await writeFile(path.join(supervised.workspaceRoot, AGENT_CODE_REVIEW_OUTPUT_PATH), JSON.stringify({
            schemaVersion: "deviludo.agent-code-review-output.v1", verdict: "PASSED",
            summary: "Reviewed the local candidate against the frozen specification and test plan.", findings: [],
          }), "utf8");
          return completed(supervised);
        },
      },
    });

    const receipt = await executor.execute(input);
    assert.equal(receipt.agent, agent);
    assert.equal(receipt.candidate.baseCommitSha.length, 40);
    assert.equal(receipt.candidate.commitSha.length, 40);
    assert.notEqual(receipt.candidate.commitSha, receipt.candidate.baseCommitSha);
    assert.deepEqual(receipt.candidate.changedFiles, ["scripts/main.gd"]);
    assert.equal(receipt.codeReviewReceipt.verdict, "PASSED");
    assert.equal(receipt.codeReviewReceipt.sourceDigest, receipt.candidate.sourceDigest);
    assert.equal(receipt.budget.maxOutputTokens, input.budget.maxOutputTokens);
    assert.equal(JSON.stringify(receipt).includes("secret://"), false);

    const replay = await executor.execute(input);
    assert.deepEqual(replay, receipt);
    assert.equal(supervisorCalls, 1);
    assert.equal(tokenCalls, 1);
  });
}

test("isolated executor fails before process launch when the token broker returns raw material", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deviludo-executor-token-"));
  let supervisorCalls = 0;
  const executor = new IsolatedLocalAgentExecutor({
    storageRoot: path.join(root, "storage"),
    gatewayUrl: "https://inference.internal.example/v1",
    workspaceProvisioner: {
      async provision(_request, workspaceRoot) {
        await mkdir(workspaceRoot, { recursive: true });
        await writeFile(path.join(workspaceRoot, "project.godot"), "[application]\n", "utf8");
      },
    },
    runTokenBroker: { async issue() { return { secretRef: "raw-upstream-key" }; } },
    supervisor: { async start() { supervisorCalls += 1; throw new Error("must not start"); } },
  });
  await assert.rejects(executor.execute(request("claude-code", "bad-token")), /invalid SecretRef/);
  assert.equal(supervisorCalls, 0);
});

test("isolated executor propagates cancellation to the supervised CLI before candidate finalization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deviludo-executor-cancel-"));
  const input = request("claude-code", "cancelled");
  const controller = new AbortController();
  let started!: () => void;
  const supervisorStarted = new Promise<void>((resolve) => { started = resolve; });
  let observedAbort = false;
  const executor = new IsolatedLocalAgentExecutor({
    storageRoot: path.join(root, "storage"),
    gatewayUrl: "https://inference.internal.example/v1",
    workspaceProvisioner: {
      async provision(_request, workspaceRoot) {
        await mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });
        await writeFile(path.join(workspaceRoot, "project.godot"), "[application]\n", "utf8");
        await writeFile(path.join(workspaceRoot, "scripts", "main.gd"), "extends Node\n", "utf8");
      },
    },
    runTokenBroker: {
      async issue() { return { secretRef: `secret://run-token/${input.runId}/${input.attemptId}` }; },
    },
    supervisor: {
      async start(supervised) {
        assert.equal(supervised.abortSignal, controller.signal);
        const baseline = await completed(supervised).completion;
        const completion = new Promise<SupervisedExecutionResult>((resolve) => {
          const abort = () => {
            observedAbort = true;
            resolve(Object.freeze({
              ...baseline,
              status: "cancelled",
              result: Object.freeze({ ...baseline.result, status: "cancelled" }),
              diagnostics: Object.freeze({ ...baseline.diagnostics, cancelled: true }),
            }));
          };
          supervised.abortSignal?.addEventListener("abort", abort, { once: true });
          if (supervised.abortSignal?.aborted) abort();
        });
        started();
        return Object.freeze({ completion, cancel: () => false });
      },
    },
  });

  const pending = executor.execute(input, controller.signal);
  await supervisorStarted;
  controller.abort();
  await assert.rejects(pending, /did not complete \(cancelled\)/);
  assert.equal(observedAbort, true);
});
