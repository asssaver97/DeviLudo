import assert from "node:assert/strict";
import test from "node:test";
import { POST as runAgent } from "../app/api/projects/[projectId]/agent-run/route.ts";
import { POST as preflightAgent } from "../app/api/projects/[projectId]/agent-preflight/route.ts";
import { readLocalDelivery, startLocalDelivery } from "../lib/local-delivery/store.ts";
import { LocalAgentRuntimeRequestVerifier } from "../services/local-agent-runtime/src/request-auth.ts";
import { ensureLocalProject } from "./helpers/local-project.mjs";

const sidecarKey = new Uint8Array(Buffer.alloc(32, 11));
process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY = Buffer.from(sidecarKey).toString("base64url");
const sidecarVerifier = new LocalAgentRuntimeRequestVerifier(sidecarKey);

function authenticateSidecar(init, path = "/v1/runs") {
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  sidecarVerifier.verify({ method: "POST", path, body: String(init?.body ?? ""), headers });
}

function receipt(delivery, overrides = {}) {
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
    status: "completed",
    sessionId: "session-local-agent-api",
    summary: "Completed the approved specification.",
    usage: { inputTokens: 250, outputTokens: 80, costUsd: 0.31 },
    warnings: [],
    candidate: {
      scmProxy: "local-git-proxy-v1",
      branch: "deviludo/local-agent-api",
      baseCommitSha: "c".repeat(40),
      commitSha: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      changedFiles: ["scripts/game_state.gd"],
      draftPullRequest: null,
    },
    completedAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
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
  const started = await startLocalDelivery(projectId, "SPEC-020", "RUN-AGENT-API-1", "start-agent-api-success");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    authenticateSidecar(init);
    return Response.json({ data: receipt(started.snapshot) }, { status: 201 });
  };
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
  const started = await startLocalDelivery(projectId, "SPEC-021", "RUN-AGENT-API-2", "start-agent-api-drift");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    authenticateSidecar(init);
    return Response.json({ data: receipt(started.snapshot, { model: "claude-unapproved-model-20260718" }) }, { status: 201 });
  };
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
  await startLocalDelivery(projectId, "SPEC-022", "RUN-AGENT-API-3", "start-agent-api-blocked");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    authenticateSidecar(init);
    return Response.json({
      error: { code: "WAITING_PROVIDER", message: "Locked Provider is unavailable" },
      data: { preflight: { status: "BLOCKED", code: "WAITING_PROVIDER" } },
    }, { status: 409 });
  };
  try {
    const response = await runAgent(request(projectId, "execute-agent-api-blocked"), { params: Promise.resolve({ projectId }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "WAITING_PROVIDER");
    assert.equal((await readLocalDelivery(projectId)).stage, "AGENT_QUEUED");
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
