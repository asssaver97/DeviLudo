import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/stack";

test("health, authentication, readiness and the fixed node lifecycle", async ({ stack }) => {
  const webLive = await stack.web("/api/health/live");
  expect(webLive.ok()).toBeTruthy();
  expect(await webLive.json()).toMatchObject({ service: "web", status: "ok" });

  const coreLive = await stack.apiRequest.get(new URL("/health/live", stack.coreUrl).href);
  expect(coreLive.ok()).toBeTruthy();
  expect(await coreLive.json()).toMatchObject({ service: "core", role: "api", status: "ok" });

  const notReady = await stack.apiRequest.get(new URL("/health/ready", stack.coreUrl).href);
  expect(notReady.status()).toBe(503);
  expect(await notReady.json()).toMatchObject({ status: "not_ready" });

  const unauthorized = await stack.apiRequest.get(new URL("/v1/admin/server-pools", stack.coreUrl).href);
  expect(unauthorized.status()).toBe(401);

  const poolsThroughBff = await stack.web("/api/admin/server-pools");
  expect(poolsThroughBff.ok()).toBeTruthy();
  expect((await poolsThroughBff.json() as { pools: unknown[] }).pools).toHaveLength(5);

  const invalidNode = await stack.coreWeb("/v1/admin/server-nodes", {
    method: "POST",
    data: { poolKind: "UNKNOWN", operatingSystem: "linux", capabilities: [] },
  });
  expect(invalidNode.status()).toBe(400);

  const mismatchedNode = await stack.coreWeb("/v1/admin/server-nodes", {
    method: "POST",
    data: { poolKind: "E2E_WINDOWS", operatingSystem: "linux", capabilities: ["E2E_TEST"] },
  });
  expect(mismatchedNode.status()).toBe(400);

  const nodes = await stack.registerFixedNodes();
  expect(nodes).toHaveLength(5);

  const ready = await stack.apiRequest.get(new URL("/health/ready", stack.coreUrl).href);
  expect(ready.status()).toBe(200);
  expect(await ready.json()).toMatchObject({ status: "ready" });

  const mac = nodes.find(node => node.poolKind === "E2E_MACOS");
  expect(mac).toBeTruthy();
  for (const [action, state] of [["drain", "DRAINING"], ["disable", "DISABLED"], ["activate", "ACTIVE"]] as const) {
    const response = await stack.coreWeb(`/v1/admin/server-nodes/${mac?.id}/${action}`, {
      method: "POST",
      data: {},
    });
    expect(response.ok()).toBeTruthy();
    expect((await response.json() as { node: { state: string } }).node.state).toBe(state);
  }

  const unknownAction = await stack.coreWeb(`/v1/admin/server-nodes/${mac?.id}/restart`, {
    method: "POST",
    data: {},
  });
  expect(unknownAction.status()).toBe(404);

  const missingNode = await stack.coreWeb(`/v1/admin/server-nodes/${randomUUID()}/activate`, {
    method: "POST",
    data: {},
  });
  expect(missingNode.status()).toBe(404);

  const nodeList = await stack.web("/api/admin/server-nodes");
  expect(nodeList.ok()).toBeTruthy();
  expect((await nodeList.json() as { nodes: unknown[] }).nodes).toHaveLength(5);
});

test("the BFF forwards product requests, enforces its body limit and reports Core outages", async ({ stack }) => {
  const session = await stack.web("/api/session?source=e2e");
  expect(session.ok()).toBeTruthy();
  expect(await session.json()).toMatchObject({
    session: { authenticated:true,authMode:"STANDALONE",selectedWorkspace: { name:"Local workspace" } },
  });
  expect(session.headers()["cache-control"]).toContain("no-store");

  const upstreamValidation = await stack.web("/api/projects", {
    method: "POST",
    data: { concept: "太短" },
  });
  expect(upstreamValidation.status()).toBe(400);
  expect(await upstreamValidation.json()).toMatchObject({ code: "INVALID_GAME_CONCEPT" });

  const oversized = await stack.web("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    data: JSON.stringify({ concept: "x".repeat(2 * 1024 * 1024 + 1) }),
  });
  expect(oversized.status()).toBe(413);
  expect(await oversized.json()).toMatchObject({ code: "REQUEST_TOO_LARGE" });

  try {
    await stack.service("stop", "core-api");
    const unavailable = await stack.web("/api/projects", { timeout: 10_000 });
    expect(unavailable.status()).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "CORE_UNAVAILABLE" });
    expect((await stack.web("/api/health/live")).ok()).toBeTruthy();
  } finally {
    await stack.service("start", "core-api");
  }
});
