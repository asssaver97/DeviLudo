import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerSteamEnrollmentBrokerRoutes } from "../src/enrollment-http";

test("Steam internal enrollment route requires workload identity and rejects credential fields", async () => {
  const calls: unknown[] = [];
  const server = Fastify();
  registerSteamEnrollmentBrokerRoutes(server, {
    authorize(request) {
      if (request.headers["x-workload"] !== "web") throw new Error("unauthorized");
    },
    broker: {
      async begin(principal, idempotencyKey) {
        calls.push({ principal, idempotencyKey });
        return {
          enrollmentId: "61e826cb-0909-4b57-a01f-364d5015253e",
          state: "WAITING_CREDENTIALS",
          enrollmentUrl: "https://steam-enroll.deviludo.example/enrollments/61e826cb-0909-4b57-a01f-364d5015253e",
          expiresAt: "2099-01-01T00:15:00.000Z",
        };
      },
    },
  });
  const body = {
    principal: {
      tenantId: "tenant-north-dock",
      userId: "user-ada",
      sessionBinding: "session-binding-with-at-least-thirty-two-random-characters",
    },
  };
  const unauthorized = await server.inject({ method: "POST", url: "/v1/steam/enrollments", payload: body });
  assert.equal(unauthorized.statusCode, 401);

  const accepted = await server.inject({
    method: "POST",
    url: "/v1/steam/enrollments",
    headers: { "x-workload": "web", "idempotency-key": "steam-begin-1" },
    payload: body,
  });
  assert.equal(accepted.statusCode, 201);
  assert.equal(accepted.headers["cache-control"], "no-store");
  assert.equal(accepted.json().state, "WAITING_CREDENTIALS");
  assert.equal(calls.length, 1);

  const credentialSmuggling = await server.inject({
    method: "POST",
    url: "/v1/steam/enrollments",
    headers: { "x-workload": "web", "idempotency-key": "steam-begin-2" },
    payload: { ...body, password: "must-never-cross-web-boundary" },
  });
  assert.equal(credentialSmuggling.statusCode, 400);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(credentialSmuggling.body, /must-never-cross-web-boundary/);
  await server.close();
});
