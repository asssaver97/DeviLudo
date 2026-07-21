import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerSteamProjectConfigurationRoutes } from "../src/project-configuration-http";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const intentId = "44444444-4444-4444-8444-444444444444";
const principal = Object.freeze({ tenantId, userId, sessionBinding: "s".repeat(43) });

test("Steam project configuration HTTP separates Web metadata from the bound binary Secure UI secret", async () => {
  const calls: unknown[] = [];
  const observed: Uint8Array[] = [];
  const server = Fastify();
  registerSteamProjectConfigurationRoutes(server, {
    authorize(request) { if (request.headers["x-workload"] !== "web") throw new Error("denied"); },
    broker: {
      async status(input, id) { calls.push({ operation: "status", input, id }); return { state: "UNCONFIGURED", projectId: id,
        configurationUrl: null, intentExpiresAt: null, revision: null, steamAppId: null, betaBranch: null,
        platformDepots: {}, accountName: null, sessionExpiresAt: null }; },
      async begin(input, id, idempotencyKey) { calls.push({ operation: "begin", input, id, idempotencyKey });
        return { intentId, projectId: id, state: "CONFIGURING", configurationUrl: `https://steam.example/projects/${id}/steam-configuration/${intentId}`,
          expiresAt: "2099-01-01T00:05:00.000Z", revision: null }; },
    },
    authorizeInteractive(request, id, requestedProjectId) {
      assert.equal(request.headers["x-ui"], "secure"); assert.equal(id, intentId); assert.equal(requestedProjectId, projectId); return principal;
    },
    interactive: { async completeConfiguration(input) { calls.push({ operation: "complete", ...input, branchPassword: "redacted" });
      observed.push(input.branchPassword); return { intentId, projectId, state: "READY", configurationUrl: null,
        expiresAt: "2099-01-01T00:05:00.000Z", revision: 1 }; } },
  });

  const status = await server.inject({ method: "POST", url: "/v1/steam/project-configurations/status", headers: { "x-workload": "web" },
    payload: { principal, projectId } });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().state, "UNCONFIGURED");
  const begin = await server.inject({ method: "POST", url: "/v1/steam/project-configurations",
    headers: { "x-workload": "web", "idempotency-key": "project-config-1" }, payload: { principal, projectId } });
  assert.equal(begin.statusCode, 201);

  const completed = await server.inject({ method: "POST", url: `/v1/steam/project-configurations/${intentId}/complete`,
    headers: { "x-ui": "secure", "content-type": "application/octet-stream", "x-deviludo-project-id": projectId,
      "x-steam-app-id": "480", "x-steam-beta-branch": "deviludo_beta", "x-steam-depot-windows": "481" },
    payload: Buffer.from("privateBeta42!") });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().revision, 1);
  assert.deepEqual([...observed[0]!], new Array(observed[0]!.byteLength).fill(0));
  assert.doesNotMatch(JSON.stringify(calls.slice(0, 2)), /password|privateBeta42/i);
  await server.close();
});

test("Steam project configuration HTTP fails closed on workload, body and content-type drift", async () => {
  const server = Fastify();
  registerSteamProjectConfigurationRoutes(server, {
    authorize() { throw new Error("denied"); },
    broker: { async status() { throw new Error("must not run"); }, async begin() { throw new Error("must not run"); } },
    authorizeInteractive() { throw new Error("denied"); },
    interactive: { async completeConfiguration() { throw new Error("must not run"); } },
  });
  const denied = await server.inject({ method: "POST", url: "/v1/steam/project-configurations/status", payload: { principal, projectId } });
  assert.equal(denied.statusCode, 401);
  const wrongType = await server.inject({ method: "POST", url: `/v1/steam/project-configurations/${intentId}/complete`,
    headers: { "content-type": "application/json" }, payload: { branchPassword: "must-not-be-accepted" } });
  assert.equal(wrongType.statusCode, 415);
  assert.doesNotMatch(wrongType.body, /must-not-be-accepted/);
  await server.close();
});
