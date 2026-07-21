import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DeliveryProjectionBrokerClient } from "../lib/delivery-projection/broker.ts";
import {
  canonicalDeliveryJson,
} from "../lib/orchestration/delivery-projection.ts";
import { GameDeliveryWorkflow } from "../lib/orchestration/game-delivery.ts";
import { GET, POST } from "../app/api/projects/[projectId]/delivery/route.ts";
import { GET as GET_RUNNERS } from "../app/api/projects/[projectId]/runners/route.ts";
import { signTrustedSpecSession } from "../lib/spec-dialogue/broker.ts";
import { RUNNER_FLEET_PROJECTION_SCHEMA_VERSION } from "../lib/runner/fleet-projection.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

function projection() {
  const snapshot = new GameDeliveryWorkflow({
    workflowId: "delivery-33333333-3333-4333-8333-333333333333",
    tenantId,
    projectId,
    targetMatrix: ["linux", "macos"],
  }).current();
  return {
    snapshot,
    snapshotDigest: createHash("sha256").update(canonicalDeliveryJson(snapshot)).digest("hex"),
    projectedAt: "2026-07-18T00:00:00.000Z",
  };
}

test("Web projection Broker binds tenant, project, digest and no-store read", async () => {
  const expected = projection();
  const calls = [];
  const client = new DeliveryProjectionBrokerClient("https://projection.internal/", async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: expected }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.deepEqual(await client.read({ tenantId, projectId }), expected);
  assert.equal(calls[0].url, `https://projection.internal/v1/delivery-projections/${projectId}`);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["x-deviludo-tenant-id"], tenantId);
  assert.equal(calls[0].init.cache, "no-store");

  const drifted = new DeliveryProjectionBrokerClient("https://projection.internal/", async () => new Response(JSON.stringify({
    data: { ...expected, snapshotDigest: "0".repeat(64) },
  }), { status: 200 }));
  await assert.rejects(drifted.read({ tenantId, projectId }), /response binding is invalid/);
});

test("Web Runner Fleet read is project-bound and rejects derived connectivity drift", async () => {
  const expected = runnerFleetProjection();
  let request;
  const client = new DeliveryProjectionBrokerClient("https://projection.internal/", async (url, init) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({ data: expected }), { status: 200 });
  });
  assert.deepEqual(await client.readRunnerFleet({ tenantId, projectId }), expected);
  assert.equal(request.url, `https://projection.internal/v1/runner-fleet/${projectId}`);
  assert.equal(request.init.headers["x-deviludo-tenant-id"], tenantId);

  const drifted = new DeliveryProjectionBrokerClient("https://projection.internal/", async () => new Response(JSON.stringify({
    data: { ...expected, runners: [{ ...expected.runners[0], connectivity: "OFFLINE" }] },
  }), { status: 200 }));
  await assert.rejects(drifted.readRunnerFleet({ tenantId, projectId }), /response binding is invalid/);
});

function runnerFleetProjection() {
  return {
    schemaVersion: RUNNER_FLEET_PROJECTION_SCHEMA_VERSION,
    tenantId,
    projectId,
    observedAt: "2026-07-18T00:05:00.000Z",
    runners: [{
      runnerId: "runner-linux-01", platform: "linux", architecture: "x86_64", capabilityDigest: "a".repeat(64),
      registrationState: "ONLINE", connectivity: "READY", lastSeenAt: "2026-07-18T00:04:30.000Z",
      certificateNotAfter: "2027-07-18T00:00:00.000Z", attemptId: "66666666-6666-4666-8666-666666666666",
      leaseState: "RUNNING", fencingToken: "19", leaseExpiresAt: "2026-07-18T00:10:00.000Z",
      updatedAt: "2026-07-18T00:04:31.000Z",
    }],
  };
}

test("production Runner Fleet route requires a signed tenant session and exposes no write authority", async () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const pathname = `/api/projects/${projectId}/runners`;
  const issuedAt = String(Date.now());
  const sessionBinding = "session-binding-that-is-longer-than-thirty-two-bytes";
  const userId = "88888888-8888-4888-8888-888888888888";
  const signature = await signTrustedSpecSession({ method: "GET", pathname, tenantId, userId, sessionBinding, issuedAt, key });
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL;
  const originalKey = process.env.DEVILUDO_SESSION_HMAC_KEY;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `https://projection.internal/v1/runner-fleet/${projectId}`);
    assert.equal(init.headers["x-deviludo-tenant-id"], tenantId);
    return new Response(JSON.stringify({ data: runnerFleetProjection() }), { status: 200 });
  };
  process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL = "https://projection.internal/";
  process.env.DEVILUDO_SESSION_HMAC_KEY = Buffer.from(key).toString("base64url");
  try {
    const response = await GET_RUNNERS(new Request(`https://app.deviludo.example${pathname}`, { headers: {
      "x-deviludo-session-tenant": tenantId,
      "x-deviludo-session-user": userId,
      "x-deviludo-session-binding": sessionBinding,
      "x-deviludo-session-issued-at": issuedAt,
      "x-deviludo-session-signature": signature,
    } }), { params: Promise.resolve({ projectId }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.runners[0].runnerId, "runner-linux-01");
    assert.equal((await GET_RUNNERS(new Request(`https://app.deviludo.example${pathname}`), {
      params: Promise.resolve({ projectId }),
    })).status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint === undefined) delete process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL;
    else process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL = originalEndpoint;
    if (originalKey === undefined) delete process.env.DEVILUDO_SESSION_HMAC_KEY;
    else process.env.DEVILUDO_SESSION_HMAC_KEY = originalKey;
  }
});

test("delivery route keeps localhost fixture mode and production mutations read-only", async () => {
  const local = await GET(new Request("http://127.0.0.1:3000/api/projects/test-project/delivery"), {
    params: Promise.resolve({ projectId: "test-project" }),
  });
  assert.equal(local.status, 200);
  assert.equal((await local.json()).meta.mode, "LOCAL_D1");

  const productionMutation = await POST(new Request(`https://app.deviludo.example/api/projects/${projectId}/delivery`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "must-not-run-local-fixture" },
    body: JSON.stringify({ action: "advance" }),
  }), { params: Promise.resolve({ projectId }) });
  assert.equal(productionMutation.status, 405);
  assert.equal(productionMutation.headers.get("allow"), "GET, POST");
  assert.equal((await productionMutation.json()).error.code, "DELIVERY_PROJECTION_READ_ONLY");

  const source = readFileSync(new URL("../components/console/LocalDeliveryPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /Production · Temporal 权威投影/);
  assert.match(source, /if \(production\) return <ProductionDeliveryProjection/);
  assert.match(source, /模拟 main 门禁失败/);
  assert.match(source, /模拟 Steam 回装失败/);
  assert.match(source, /snapshot\.repairHandoff/);
  assert.doesNotMatch(source.slice(source.indexOf("function ProductionDeliveryProjection")), /runAction\(/);
  assert.match(source, /expected.*Temporal|取消请求已送达 Temporal/);
  const routeSource = readFileSync(new URL("../app/api/projects/[projectId]/delivery/route.ts", import.meta.url), "utf8");
  assert.match(routeSource, /isLoopbackTestRequest\(request\)/);
  assert.match(routeSource, /"main-gate-fail"/);
  assert.match(routeSource, /"steam-reinstall-fail"/);
});

test("production cancellation accepts only a signed reason and server derives workflow authority", async () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const pathname = `/api/projects/${projectId}/delivery`;
  const issuedAt = String(Date.now());
  const sessionBinding = "session-binding-that-is-longer-than-thirty-two-bytes";
  const actorId = "55555555-5555-4555-8555-555555555555";
  const signature = await signTrustedSpecSession({
    method: "POST", pathname, tenantId, userId: actorId, sessionBinding, issuedAt, key,
  });
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.DEVILUDO_USER_ACCEPTANCE_BROKER_URL;
  const originalKey = process.env.DEVILUDO_SESSION_HMAC_KEY;
  let brokerCommand;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://user-acceptance.internal/v1/delivery-cancellations");
    brokerCommand = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: {
      ...brokerCommand,
      workflowId: "delivery-33333333-3333-4333-8333-333333333333",
      projectionSequence: 7,
      projectionKey: `projection:${"a".repeat(64)}`,
      projectionState: "DEVELOPING",
      projectionDigest: "b".repeat(64),
      signalId: "cancel-44444444-4444-4444-8444-444444444444",
      requestedAt: "2026-07-21T06:00:00.000Z",
      state: "CANCEL_REQUESTED",
      deliveredAt: "2026-07-21T06:00:01.000Z",
    } }), { status: 201 });
  };
  process.env.DEVILUDO_USER_ACCEPTANCE_BROKER_URL = "https://user-acceptance.internal/";
  process.env.DEVILUDO_SESSION_HMAC_KEY = Buffer.from(key).toString("base64url");
  try {
    const response = await POST(new Request(`https://app.deviludo.example${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "cancel-request-001",
        "x-deviludo-session-tenant": tenantId,
        "x-deviludo-session-user": actorId,
        "x-deviludo-session-binding": sessionBinding,
        "x-deviludo-session-issued-at": issuedAt,
        "x-deviludo-session-signature": signature,
      },
      body: JSON.stringify({ action: "cancel", reason: "项目方向已改变。" }),
    }), { params: Promise.resolve({ projectId }) });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).data.state, "CANCEL_REQUESTED");
    assert.equal(brokerCommand.reason, "项目方向已改变。");
    assert.equal(brokerCommand.tenantId, tenantId);
    assert.equal("workflowId" in brokerCommand, false);
    assert.equal("projectionState" in brokerCommand, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint === undefined) delete process.env.DEVILUDO_USER_ACCEPTANCE_BROKER_URL;
    else process.env.DEVILUDO_USER_ACCEPTANCE_BROKER_URL = originalEndpoint;
    if (originalKey === undefined) delete process.env.DEVILUDO_SESSION_HMAC_KEY;
    else process.env.DEVILUDO_SESSION_HMAC_KEY = originalKey;
  }
});

test("production delivery GET requires a signed tenant session and returns only its projection", async () => {
  const expected = projection();
  const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const pathname = `/api/projects/${projectId}/delivery`;
  const issuedAt = String(Date.now());
  const sessionBinding = "session-binding-that-is-longer-than-thirty-two-bytes";
  const signature = await signTrustedSpecSession({
    method: "GET", pathname, tenantId, userId: "user-001", sessionBinding, issuedAt, key,
  });
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL;
  const originalKey = process.env.DEVILUDO_SESSION_HMAC_KEY;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers["x-deviludo-tenant-id"], tenantId);
    return new Response(JSON.stringify({ data: expected }), { status: 200 });
  };
  process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL = "https://projection.internal/";
  process.env.DEVILUDO_SESSION_HMAC_KEY = Buffer.from(key).toString("base64url");
  try {
    const request = new Request(`https://app.deviludo.example${pathname}`, { headers: {
      "x-deviludo-session-tenant": tenantId,
      "x-deviludo-session-user": "user-001",
      "x-deviludo-session-binding": sessionBinding,
      "x-deviludo-session-issued-at": issuedAt,
      "x-deviludo-session-signature": signature,
    } });
    const response = await GET(request, { params: Promise.resolve({ projectId }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.meta.mode, "PRODUCTION");
    assert.equal(body.data.tenantId, tenantId);

    const unauthorized = await GET(new Request(`https://app.deviludo.example${pathname}`), {
      params: Promise.resolve({ projectId }),
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint === undefined) delete process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL;
    else process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL = originalEndpoint;
    if (originalKey === undefined) delete process.env.DEVILUDO_SESSION_HMAC_KEY;
    else process.env.DEVILUDO_SESSION_HMAC_KEY = originalKey;
  }
});
