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
import { GET as GET_EVIDENCE } from "../app/api/projects/[projectId]/evidence/route.ts";
import { GET as GET_RUNNERS } from "../app/api/projects/[projectId]/runners/route.ts";
import { signTrustedSpecSession } from "../lib/spec-dialogue/broker.ts";
import { signTrustedGitHubSession } from "../lib/connections/github-broker.ts";
import { RUNNER_FLEET_PROJECTION_SCHEMA_VERSION } from "../lib/runner/fleet-projection.ts";
import { EVIDENCE_CATALOG_SCHEMA_VERSION } from "../lib/evidence/catalog-projection.ts";
import { canonicalJson as canonicalEvidenceJson } from "../services/runner-control/src/canonical.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const repositoryBindingId = "33333333-3333-4333-8333-333333333333";

async function trustedProjectReadRequest(pathname, key, userId) {
  const issuedAt = String(Date.now());
  const sessionBinding = "session-binding-that-is-longer-than-thirty-two-bytes";
  const githubUserId = "42";
  const signature = await signTrustedGitHubSession({
    method: "GET", pathname, tenantId, userId, sessionBinding, githubUserId, issuedAt, key,
  });
  return new Request(`https://app.deviludo.example${pathname}`, { headers: {
    "x-deviludo-session-tenant": tenantId,
    "x-deviludo-session-user": userId,
    "x-deviludo-session-binding": sessionBinding,
    "x-deviludo-session-github-user-id": githubUserId,
    "x-deviludo-session-issued-at": issuedAt,
    "x-deviludo-session-signature": signature,
  } });
}

function projectLookup(input, init, expectedUserId) {
  const url = new URL(String(input));
  if (url.pathname !== "/v1/projects/lookup") return null;
  const body = JSON.parse(String(init.body));
  assert.deepEqual(body, {
    principal: { tenantId, userId: expectedUserId, githubUserId: 42 },
    projectId,
  });
  return new Response(JSON.stringify({
    projectId,
    tenantId,
    slug: "evidence-project",
    name: "Evidence project",
    repositoryBindingId,
    installationId: "9001",
    repositoryId: 7001,
    repositoryNodeId: "R_evidence_project",
    owner: "north-dock",
    repositoryName: "evidence-project",
    defaultBranch: "main",
    createdAt: "2026-07-18T00:00:00.000Z",
  }), { status: 200 });
}

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

test("Web Evidence Catalog revalidates manifest digests and excludes archive locations", async () => {
  const expected = evidenceCatalogProjection();
  let request;
  const client = new DeliveryProjectionBrokerClient("https://projection.internal/", async (url, init) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({ data: expected }), { status: 200 });
  });
  assert.deepEqual(await client.readEvidenceCatalog({ tenantId, projectId }), expected);
  assert.equal(request.url, `https://projection.internal/v1/evidence-catalog/${projectId}`);
  assert.equal(request.init.headers["x-deviludo-tenant-id"], tenantId);
  assert.equal("objectKey" in expected.entries[0], false);

  const drifted = new DeliveryProjectionBrokerClient("https://projection.internal/", async () => new Response(JSON.stringify({
    data: {
      ...expected,
      entries: [{
        ...expected.entries[0],
        bundle: { ...expected.entries[0].bundle, commitSha: "f".repeat(40) },
      }],
    },
  }), { status: 200 }));
  await assert.rejects(drifted.readEvidenceCatalog({ tenantId, projectId }), /response binding is invalid/);
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

function evidenceCatalogProjection() {
  const core = {
    id: "66666666-6666-4666-8666-666666666666",
    attemptId: "66666666-6666-4666-8666-666666666666",
    specRevisionId: "77777777-7777-4777-8777-777777777777",
    specDigest: "1".repeat(64), testPlanDigest: "2".repeat(64), commitSha: "a".repeat(40),
    sourceDigest: "3".repeat(64), targetMatrix: ["linux"], godotTestKitDigest: "4".repeat(64),
    buildManifestDigest: "5".repeat(64), sbomDigest: "6".repeat(64), vulnerabilityScanDigest: "7".repeat(64),
    assetLicenseLedgerDigest: "8".repeat(64),
    platformEvidence: [{
      platform: "linux", runnerId: "runner-linux-01", runnerCapabilityDigest: "9".repeat(64),
      exportDigest: "a".repeat(64), logsDigest: "b".repeat(64), junitDigest: "c".repeat(64),
      inputTimelineDigest: "d".repeat(64), screenshotManifestDigest: "e".repeat(64),
      videoManifestDigest: "f".repeat(64), status: "PASSED",
    }],
    status: "PASSED", valid: true, createdAt: "2026-07-18T00:04:00.000Z",
  };
  const bundle = { ...core, bundleDigest: createHash("sha256").update(canonicalEvidenceJson(core)).digest("hex") };
  return {
    schemaVersion: EVIDENCE_CATALOG_SCHEMA_VERSION,
    tenantId,
    projectId,
    observedAt: "2026-07-18T00:05:00.000Z",
    entries: [{
      evidenceBundleId: bundle.id,
      invalidatedAt: null,
      binding: {
        schemaVersion: "deviludo.evidence-binding.v1", attemptId: bundle.attemptId,
        executionLockId: "88888888-8888-4888-8888-888888888888", executionLockDigest: "0".repeat(64),
        specRevisionId: bundle.specRevisionId, specDigest: bundle.specDigest, testPlanDigest: bundle.testPlanDigest,
        runnerToolchainRevisionId: "99999999-9999-4999-8999-999999999999", runnerToolchainDigest: "a".repeat(64),
        commitSha: bundle.commitSha, sourceDigest: bundle.sourceDigest, targetMatrix: bundle.targetMatrix,
      },
      bundle,
    }],
  };
}

test("production Runner Fleet route requires a project-authorized GitHub session and exposes no write authority", async () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const pathname = `/api/projects/${projectId}/runners`;
  const userId = "88888888-8888-4888-8888-888888888888";
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL;
  const originalProjectEndpoint = process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL;
  const originalKey = process.env.DEVILUDO_SESSION_HMAC_KEY;
  globalThis.fetch = async (url, init) => {
    const lookup = projectLookup(url, init, userId);
    if (lookup) return lookup;
    assert.equal(String(url), `https://projection.internal/v1/runner-fleet/${projectId}`);
    assert.equal(init.headers["x-deviludo-tenant-id"], tenantId);
    return new Response(JSON.stringify({ data: runnerFleetProjection() }), { status: 200 });
  };
  process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL = "https://projection.internal/";
  process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL = "https://project-repository.internal/";
  process.env.DEVILUDO_SESSION_HMAC_KEY = Buffer.from(key).toString("base64url");
  try {
    const response = await GET_RUNNERS(await trustedProjectReadRequest(pathname, key, userId), {
      params: Promise.resolve({ projectId }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.runners[0].runnerId, "runner-linux-01");
    assert.equal((await GET_RUNNERS(new Request(`https://app.deviludo.example${pathname}`), {
      params: Promise.resolve({ projectId }),
    })).status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint === undefined) delete process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL;
    else process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL = originalEndpoint;
    if (originalProjectEndpoint === undefined) delete process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL;
    else process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL = originalProjectEndpoint;
    if (originalKey === undefined) delete process.env.DEVILUDO_SESSION_HMAC_KEY;
    else process.env.DEVILUDO_SESSION_HMAC_KEY = originalKey;
  }
});

test("production Evidence Catalog route requires a project-authorized GitHub session and exposes no object key", async () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const pathname = `/api/projects/${projectId}/evidence`;
  const userId = "88888888-8888-4888-8888-888888888888";
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL;
  const originalProjectEndpoint = process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL;
  const originalKey = process.env.DEVILUDO_SESSION_HMAC_KEY;
  globalThis.fetch = async (url, init) => {
    const lookup = projectLookup(url, init, userId);
    if (lookup) return lookup;
    assert.equal(String(url), `https://projection.internal/v1/evidence-catalog/${projectId}`);
    assert.equal(init.headers["x-deviludo-tenant-id"], tenantId);
    return new Response(JSON.stringify({ data: evidenceCatalogProjection() }), { status: 200 });
  };
  process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL = "https://projection.internal/";
  process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL = "https://project-repository.internal/";
  process.env.DEVILUDO_SESSION_HMAC_KEY = Buffer.from(key).toString("base64url");
  try {
    const response = await GET_EVIDENCE(await trustedProjectReadRequest(pathname, key, userId), {
      params: Promise.resolve({ projectId }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.entries[0].bundle.status, "PASSED");
    assert.equal(JSON.stringify(body).includes("objectKey"), false);
    assert.equal((await GET_EVIDENCE(new Request(`https://app.deviludo.example${pathname}`), {
      params: Promise.resolve({ projectId }),
    })).status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint === undefined) delete process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL;
    else process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL = originalEndpoint;
    if (originalProjectEndpoint === undefined) delete process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL;
    else process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL = originalProjectEndpoint;
    if (originalKey === undefined) delete process.env.DEVILUDO_SESSION_HMAC_KEY;
    else process.env.DEVILUDO_SESSION_HMAC_KEY = originalKey;
  }
});

test("a valid same-tenant session cannot read projections after project access is revoked", async () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const pathname = `/api/projects/${projectId}/evidence`;
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL;
  const originalProjectEndpoint = process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL;
  const originalKey = process.env.DEVILUDO_SESSION_HMAC_KEY;
  let projectionCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/projects/lookup") return new Response("", { status: 404 });
    projectionCalls += 1;
    return new Response(JSON.stringify({ data: evidenceCatalogProjection() }), { status: 200 });
  };
  process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL = "https://projection.internal/";
  process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL = "https://project-repository.internal/";
  process.env.DEVILUDO_SESSION_HMAC_KEY = Buffer.from(key).toString("base64url");
  try {
    const response = await GET_EVIDENCE(await trustedProjectReadRequest(pathname, key, "revoked-user"), {
      params: Promise.resolve({ projectId }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "PROJECT_ACCESS_NOT_FOUND");
    assert.equal(projectionCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint === undefined) delete process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL;
    else process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL = originalEndpoint;
    if (originalProjectEndpoint === undefined) delete process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL;
    else process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL = originalProjectEndpoint;
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

test("production delivery GET requires project authorization and returns only its projection", async () => {
  const expected = projection();
  const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const pathname = `/api/projects/${projectId}/delivery`;
  const userId = "user-001";
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL;
  const originalProjectEndpoint = process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL;
  const originalKey = process.env.DEVILUDO_SESSION_HMAC_KEY;
  globalThis.fetch = async (url, init) => {
    const lookup = projectLookup(url, init, userId);
    if (lookup) return lookup;
    assert.equal(String(url), `https://projection.internal/v1/delivery-projections/${projectId}`);
    assert.equal(init.headers["x-deviludo-tenant-id"], tenantId);
    return new Response(JSON.stringify({ data: expected }), { status: 200 });
  };
  process.env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL = "https://projection.internal/";
  process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL = "https://project-repository.internal/";
  process.env.DEVILUDO_SESSION_HMAC_KEY = Buffer.from(key).toString("base64url");
  try {
    const request = await trustedProjectReadRequest(pathname, key, userId);
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
    if (originalProjectEndpoint === undefined) delete process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL;
    else process.env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL = originalProjectEndpoint;
    if (originalKey === undefined) delete process.env.DEVILUDO_SESSION_HMAC_KEY;
    else process.env.DEVILUDO_SESSION_HMAC_KEY = originalKey;
  }
});
