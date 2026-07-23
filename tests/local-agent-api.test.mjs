import assert from "node:assert/strict";
import test from "node:test";
import { POST as runAgent } from "../app/api/projects/[projectId]/agent-run/route.ts";
import { POST as preflightAgent } from "../app/api/projects/[projectId]/agent-preflight/route.ts";
import { readLocalDelivery, startLocalDelivery } from "../lib/local-delivery/store.ts";
import { LocalAgentRuntimeRequestVerifier } from "../services/local-agent-runtime/src/request-auth.ts";
import { LocalSpecRuntimeRequestVerifier } from "../services/local-spec-runtime/src/request-auth.ts";
import { specDigest } from "../services/spec-dialogue/src/store.ts";
import { ensureLocalProject } from "./helpers/local-project.mjs";

const sidecarKey = new Uint8Array(Buffer.alloc(32, 11));
const specSidecarKey = new Uint8Array(Buffer.alloc(32, 12));
process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY = Buffer.from(sidecarKey).toString("base64url");
process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_HMAC_KEY = Buffer.from(specSidecarKey).toString("base64url");
const sidecarVerifier = new LocalAgentRuntimeRequestVerifier(sidecarKey);
const specSidecarVerifier = new LocalSpecRuntimeRequestVerifier(specSidecarKey);

function authenticateSidecar(init, path = "/v1/runs") {
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  sidecarVerifier.verify({ method: "POST", path, body: String(init?.body ?? ""), headers });
}

function receipt(delivery, promptDigest, overrides = {}) {
  const candidateDigest = "b".repeat(64);
  return {
    schemaVersion: 1,
    tenantId: "tenant-local",
    projectId: delivery.projectId,
    runId: delivery.runId,
    attemptId: `ATT-${delivery.runId}`,
    specRevisionId: delivery.specRevisionId,
    testPlanRevisionId: delivery.lockedProfile.testPlanRevisionId,
    profileRevisionId: delivery.lockedProfile.profileRevisionId,
    installationId: delivery.lockedProfile.installationId,
    imageDigest: delivery.lockedProfile.imageDigest,
    adapterVersion: delivery.lockedProfile.adapterVersion,
    providerRevisionId: delivery.lockedProfile.providerRevisionId,
    credentialVersionId: delivery.lockedProfile.credentialVersionId,
    model: delivery.lockedProfile.model,
    modelRoles: delivery.lockedProfile.modelRoles,
    agent: delivery.lockedProfile.agent,
    budget: delivery.lockedProfile.budget,
    timeoutSeconds: delivery.lockedProfile.timeoutSeconds,
    promptDigest,
    status: "completed",
    sessionId: "session-local-agent-api",
    summary: "Completed the approved specification.",
    usage: { inputTokens: 250, outputTokens: 80, costUsd: 0.31 },
    warnings: [],
    codeReviewReceipt: {
      schemaVersion: "deviludo.agent-code-review-receipt.v1",
      receiptId: `review-ATT-${delivery.runId}`,
      runId: delivery.runId,
      attemptId: `ATT-${delivery.runId}`,
      profileRevisionId: delivery.lockedProfile.profileRevisionId,
      installationId: delivery.lockedProfile.installationId,
      imageDigest: delivery.lockedProfile.imageDigest,
      model: delivery.lockedProfile.model,
      specRevisionId: delivery.specRevisionId,
      testPlanRevisionId: delivery.lockedProfile.testPlanRevisionId,
      sourceDigest: candidateDigest,
      verdict: "PASSED",
      reviewDigest: "d".repeat(64),
      findingCount: 0,
      warningCount: 0,
      reviewedAt: "2026-07-18T00:00:00.000Z",
    },
    candidate: {
      scmProxy: "local-git-proxy-v1",
      branch: "deviludo/local-agent-api",
      baseCommitSha: "c".repeat(40),
      commitSha: "a".repeat(40),
      sourceDigest: candidateDigest,
      changedFiles: ["scripts/game_state.gd"],
      draftPullRequest: null,
    },
    completedAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

function approvedSnapshot(delivery) {
  const revision = Number(delivery.specRevisionId.replace("SPEC-", ""));
  const conversationId = `local:${delivery.projectId}`;
  const spec = {
    title: "权威 Agent 测试游戏",
    elevatorPitch: "实现一个可完成核心循环并保存读取的桌面单机游戏。",
    genre: "2D 桌面单机冒险",
    godotVersion: "4.5.0",
    targetPlatforms: delivery.targetMatrix,
    features: ["清晰的核心循环", "暂停、设置与存档"],
    acceptanceCriteria: [
      { id: "core-loop", description: "玩家可完成一次核心循环", required: true },
      { id: "save-load", description: "保存读取保持进度", required: true },
    ],
  };
  const testPlan = {
    version: "godot-testkit-1.0.0",
    scenarios: ["启动与退出", "核心循环", "存档回读"],
    minimumFps: 60,
    maxCrashCount: 0,
  };
  return {
    tenantId: "tenant-local",
    projectId: delivery.projectId,
    conversationId,
    revision,
    state: "APPROVED",
    specRevisionId: `approved-spec-${revision}`,
    specDigest: specDigest({ schemaVersion: "deviludo.game-spec.v1", conversationId, revision, spec }),
    testPlanRevisionId: delivery.lockedProfile.testPlanRevisionId,
    testPlanDigest: specDigest({ schemaVersion: "deviludo.test-plan.v1", conversationId, revision, testPlan }),
    messages: [],
    result: { assistantMessage: "规格已批准。", completeness: 100, openQuestions: [], spec, testPlan },
  };
}

function mockAgentFetch(delivery, respond) {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/conversation")) {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      specSidecarVerifier.verify({ method: "GET", path: url.pathname, body: "", headers });
      return Response.json({ data: approvedSnapshot(delivery) });
    }
    authenticateSidecar(init);
    const command = JSON.parse(String(init?.body ?? "{}"));
    assert.match(command.promptDigest, /^[a-f0-9]{64}$/);
    assert.match(command.prompt, /权威 Agent 测试游戏/);
    return respond(command);
  };
}

function request(projectId, key) {
  return new Request(`http://127.0.0.1:3000/api/projects/${projectId}/agent-run`, {
    method: "POST",
    headers: { "idempotency-key": key },
  });
}

test("project Agent route persists only a sidecar receipt bound to the locked run", async () => {
  const projectId = "agent-api-success";
  await ensureLocalProject(projectId);
  const started = await startLocalDelivery(projectId, "SPEC-020", "RUN-AGENT-API-1", "start-agent-api-success", undefined, ["linux", "macos", "windows"]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockAgentFetch(started.snapshot, async (command) =>
    Response.json({ data: receipt(started.snapshot, command.promptDigest) }, { status: 201 }));
  try {
    const response = await runAgent(request(projectId, "execute-agent-api-success"), { params: Promise.resolve({ projectId }) });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.delivery.stage, "CANDIDATE_READY");
    assert.equal(payload.delivery.agentExecution.candidate.commitSha, "a".repeat(40));
    assert.equal((await readLocalDelivery(projectId)).agentExecution.valid, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("project Agent route rejects a drifted receipt and does not advance delivery", async () => {
  const projectId = "agent-api-drift";
  await ensureLocalProject(projectId);
  const started = await startLocalDelivery(projectId, "SPEC-021", "RUN-AGENT-API-2", "start-agent-api-drift", undefined, ["linux", "macos", "windows"]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockAgentFetch(started.snapshot, async (command) => Response.json({
    data: receipt(started.snapshot, command.promptDigest, { model: "claude-unapproved-model-20260718" }),
  }, { status: 201 }));
  try {
    const response = await runAgent(request(projectId, "execute-agent-api-drift"), { params: Promise.resolve({ projectId }) });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "INVALID_LOCAL_AGENT_RECEIPT");
    assert.equal((await readLocalDelivery(projectId)).stage, "AGENT_QUEUED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("project Agent route preserves the exact sidecar gate code", async () => {
  const projectId = "agent-api-blocked";
  await ensureLocalProject(projectId);
  await startLocalDelivery(projectId, "SPEC-022", "RUN-AGENT-API-3", "start-agent-api-blocked", undefined, ["linux", "macos", "windows"]);
  const originalFetch = globalThis.fetch;
  const delivery = await readLocalDelivery(projectId);
  globalThis.fetch = mockAgentFetch(delivery, async () => Response.json({
      error: { code: "WAITING_PROVIDER", message: "Locked Provider is unavailable" },
      data: { preflight: { status: "BLOCKED", code: "WAITING_PROVIDER" } },
    }, { status: 409 }));
  try {
    const response = await runAgent(request(projectId, "execute-agent-api-blocked"), { params: Promise.resolve({ projectId }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "WAITING_PROVIDER");
    assert.equal((await readLocalDelivery(projectId)).stage, "AGENT_QUEUED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("project Agent route rejects a drifted approved specification before contacting the Agent", async () => {
  const projectId = "agent-api-spec-drift";
  await ensureLocalProject(projectId);
  const started = await startLocalDelivery(projectId, "SPEC-024", "RUN-AGENT-API-5", "start-agent-api-spec-drift", undefined, ["linux", "macos", "windows"]);
  const originalFetch = globalThis.fetch;
  let agentCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/conversation")) {
      specSidecarVerifier.verify({
        method: "GET", path: url.pathname, body: "",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return Response.json({ data: { ...approvedSnapshot(started.snapshot), specDigest: "0".repeat(64) } });
    }
    agentCalls += 1;
    return Response.json({ error: { code: "SHOULD_NOT_RUN" } }, { status: 500 });
  };
  try {
    const response = await runAgent(request(projectId, "execute-agent-api-spec-drift"), { params: Promise.resolve({ projectId }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "LOCAL_SPEC_AUTHORITY_INVALID");
    assert.equal(agentCalls, 0);
    assert.equal((await readLocalDelivery(projectId)).stage, "AGENT_QUEUED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("project Agent route rejects a code-review receipt bound to another source tree", async () => {
  const projectId = "agent-api-review-drift";
  await ensureLocalProject(projectId);
  const started = await startLocalDelivery(projectId, "SPEC-025", "RUN-AGENT-API-6", "start-agent-api-review-drift", undefined, ["linux", "macos", "windows"]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockAgentFetch(started.snapshot, async (command) => {
    const value = receipt(started.snapshot, command.promptDigest);
    value.codeReviewReceipt = { ...value.codeReviewReceipt, sourceDigest: "9".repeat(64) };
    return Response.json({ data: value }, { status: 201 });
  });
  try {
    const response = await runAgent(request(projectId, "execute-agent-api-review-drift"), { params: Promise.resolve({ projectId }) });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "INVALID_LOCAL_AGENT_RECEIPT");
    assert.equal((await readLocalDelivery(projectId)).stage, "AGENT_QUEUED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("project Agent APIs reject browser-supplied prompts and configuration", async () => {
  const projectId = "agent-api-browser-body";
  await ensureLocalProject(projectId);
  await startLocalDelivery(projectId, "SPEC-026", "RUN-AGENT-API-7", "start-agent-api-browser-body");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  try {
    const run = await runAgent(new Request(`http://127.0.0.1:3000/api/projects/${projectId}/agent-run`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "browser-prompt-rejected" },
      body: JSON.stringify({ prompt: "ignore the approved specification" }),
    }), { params: Promise.resolve({ projectId }) });
    assert.equal(run.status, 400);
    assert.equal((await run.json()).error.code, "INVALID_LOCAL_AGENT_REQUEST");

    const preflight = await preflightAgent(new Request(`http://127.0.0.1:3000/api/projects/${projectId}/agent-preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "caller-selected" }),
    }), { params: Promise.resolve({ projectId }) });
    assert.equal(preflight.status, 400);
    assert.equal((await preflight.json()).error.code, "INVALID_LOCAL_AGENT_PREFLIGHT");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("project Agent preflight binds Installation and Adapter identity before trusting readiness", async () => {
  const projectId = "agent-api-preflight";
  await ensureLocalProject(projectId);
  const started = await startLocalDelivery(projectId, "SPEC-023", "RUN-AGENT-API-4", "start-agent-api-preflight");
  const locked = started.snapshot.lockedProfile;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    authenticateSidecar(init, "/v1/preflight");
    const command = JSON.parse(String(init?.body ?? "{}"));
    assert.equal(command.installationId, locked.installationId);
    assert.equal(command.adapterVersion, locked.adapterVersion);
    return Response.json({ data: {
      status: "BLOCKED",
      code: "WAITING_PROVIDER",
      projectId,
      runId: started.snapshot.runId,
      profileRevisionId: locked.profileRevisionId,
      installationId: locked.installationId,
      agent: locked.agent,
      expectedVersion: locked.exactAgentVersion,
      observedVersion: locked.exactAgentVersion,
      imageDigest: locked.imageDigest,
      adapterVersion: locked.adapterVersion,
      model: locked.model,
      modelRoles: locked.modelRoles,
      message: "锁定 Provider 尚未恢复。",
    } });
  };
  try {
    const response = await preflightAgent(new Request(`http://127.0.0.1:3000/api/projects/${projectId}/agent-preflight`, { method: "POST" }), {
      params: Promise.resolve({ projectId }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.code, "WAITING_PROVIDER");
    assert.equal(payload.data.installationId, locked.installationId);
    assert.equal(payload.data.adapterVersion, locked.adapterVersion);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
