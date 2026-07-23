import assert from "node:assert/strict";
import test from "node:test";

import { POST as mutateDelivery } from "../app/api/projects/[projectId]/delivery/route.ts";
import { readLocalDelivery, startLocalDelivery } from "../lib/local-delivery/store.ts";
import { LocalAgentRuntimeRequestVerifier } from "../services/local-agent-runtime/src/request-auth.ts";
import { ensureLocalProject } from "./helpers/local-project.mjs";

test("local delivery cancellation stops the exact active Agent attempt before committing CANCELLED", async () => {
  const projectId = `cancel-active-agent-${crypto.randomUUID()}`;
  await ensureLocalProject(projectId);
  const started = await startLocalDelivery(
    projectId,
    "SPEC-CANCEL-ACTIVE-001",
    "RUN-CANCEL-ACTIVE-001",
    `start:${projectId}`,
  );
  assert.equal(started.snapshot.stage, "AGENT_QUEUED");

  const key = new Uint8Array(Buffer.alloc(32, 73));
  const previousKey = process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY;
  const previousFetch = globalThis.fetch;
  process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY = Buffer.from(key).toString("base64url");
  const verifier = new LocalAgentRuntimeRequestVerifier(key);
  let cancellationCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.href, "http://127.0.0.1:4312/v1/runs/cancel");
    const body = String(init.body);
    verifier.verify({
      method: "POST",
      path: "/v1/runs/cancel",
      body,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    const command = JSON.parse(body);
    assert.deepEqual(command, {
      tenantId: "tenant-local",
      projectId,
      runId: started.snapshot.runId,
      attemptId: `ATT-${started.snapshot.runId}`,
      reason: "用户决定停止本轮开发。",
    });
    cancellationCalls += 1;
    return Response.json({ data: {
      tenantId: command.tenantId,
      projectId: command.projectId,
      runId: command.runId,
      attemptId: command.attemptId,
      state: "CANCELLATION_REQUESTED",
    } }, { status: 202 });
  };

  try {
    const response = await mutateDelivery(new Request(`http://127.0.0.1:3000/api/projects/${projectId}/delivery`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `cancel:${projectId}` },
      body: JSON.stringify({ action: "cancel", reason: "用户决定停止本轮开发。" }),
    }), { params: Promise.resolve({ projectId }) });
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.data.stage, "CANCELLED");
    assert.equal(payload.meta.agentCancellation.state, "CANCELLATION_REQUESTED");
    assert.equal(cancellationCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY;
    else process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY = previousKey;
  }
});

test("local delivery remains active when the Agent cancellation receipt drifts", async () => {
  const projectId = `cancel-agent-drift-${crypto.randomUUID()}`;
  await ensureLocalProject(projectId);
  const started = await startLocalDelivery(
    projectId,
    "SPEC-CANCEL-DRIFT-001",
    "RUN-CANCEL-DRIFT-001",
    `start:${projectId}`,
  );
  const key = new Uint8Array(Buffer.alloc(32, 74));
  const previousKey = process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY;
  const previousFetch = globalThis.fetch;
  process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY = Buffer.from(key).toString("base64url");
  let cancellationCalls = 0;
  globalThis.fetch = async (_input, init) => {
    cancellationCalls += 1;
    const command = JSON.parse(String(init.body));
    return Response.json({ data: {
      tenantId: command.tenantId,
      projectId: "different-project",
      runId: command.runId,
      attemptId: command.attemptId,
      state: "CANCELLATION_REQUESTED",
    } }, { status: 202 });
  };
  try {
    const widened = await mutateDelivery(new Request(`http://127.0.0.1:3000/api/projects/${projectId}/delivery`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `widened:${projectId}` },
      body: JSON.stringify({ action: "cancel", signal: "SIGKILL" }),
    }), { params: Promise.resolve({ projectId }) });
    assert.equal(widened.status, 400);
    assert.equal((await widened.json()).error.code, "INVALID_LOCAL_DELIVERY_REQUEST");
    assert.equal(cancellationCalls, 0);

    const response = await mutateDelivery(new Request(`http://127.0.0.1:3000/api/projects/${projectId}/delivery`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `cancel:${projectId}` },
      body: JSON.stringify({ action: "cancel" }),
    }), { params: Promise.resolve({ projectId }) });
    const payload = await response.json();
    assert.equal(response.status, 502);
    assert.equal(payload.error.code, "LOCAL_AGENT_CANCELLATION_INVALID");
    assert.equal((await readLocalDelivery(projectId)).stage, started.snapshot.stage);
    assert.equal(cancellationCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY;
    else process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY = previousKey;
  }
});
