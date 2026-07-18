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

test("isolated Steam UI routes accept only binary secrets and wipe their request buffers", async () => {
  const enrollmentId = "61e826cb-0909-4b57-a01f-364d5015253e";
  const observed: Uint8Array[] = [];
  let unauthorizedBody: Buffer | null = null;
  const server = Fastify();
  registerSteamEnrollmentBrokerRoutes(server, {
    authorize() { throw new Error("the secure UI is not the Web workload"); },
    authorizeInteractive(request, requestedEnrollmentId, action) {
      if (request.headers["x-ui-session"] !== "authorized" && Buffer.isBuffer(request.body)) {
        unauthorizedBody = request.body;
      }
      assert.equal(request.headers["x-ui-session"], "authorized");
      assert.equal(requestedEnrollmentId, enrollmentId);
      assert.ok(action === "SUBMIT_CREDENTIALS" || action === "SUBMIT_GUARD_CODE");
      return {
        tenantId: "tenant-north-dock",
        userId: "user-ada",
        sessionBinding: "session-binding-with-at-least-thirty-two-random-characters",
      };
    },
    broker: { async begin() { throw new Error("must not run"); } },
    interactiveBroker: {
      async submitCredentials(input) {
        assert.equal(input.accountName, "deviludo_build_bot");
        assert.equal(new TextDecoder().decode(input.password), "not-a-real-password");
        observed.push(input.password);
        return { enrollmentId, state: "WAITING_STEAM_GUARD", enrollmentUrl: "https://steam.example/enrollments/x", expiresAt: "2099-01-01T00:15:00.000Z" };
      },
      async submitGuardCode(input) {
        assert.equal(new TextDecoder().decode(input.guardCode), "ABC123");
        observed.push(input.guardCode);
        return { enrollmentId, state: "READY", enrollmentUrl: null, expiresAt: "2099-01-01T00:15:00.000Z" };
      },
    },
  });

  const wrongContentType = await server.inject({
    method: "POST",
    url: `/v1/steam/enrollments/${enrollmentId}/credentials`,
    headers: { "x-ui-session": "authorized", "x-steam-account-name": "deviludo_build_bot" },
    payload: { password: "must-not-be-json" },
  });
  assert.equal(wrongContentType.statusCode, 415);
  assert.equal(observed.length, 0);

  const unauthorized = await server.inject({
    method: "POST",
    url: `/v1/steam/enrollments/${enrollmentId}/credentials`,
    headers: { "content-type": "application/octet-stream", "x-steam-account-name": "deviludo_build_bot" },
    payload: Buffer.from("unauthorized-password"),
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.ok(unauthorizedBody);
  assert.deepEqual([...(unauthorizedBody as Buffer)], new Array((unauthorizedBody as Buffer).byteLength).fill(0));

  const credentials = await server.inject({
    method: "POST",
    url: `/v1/steam/enrollments/${enrollmentId}/credentials`,
    headers: {
      "content-type": "application/octet-stream",
      "x-ui-session": "authorized",
      "x-steam-account-name": "deviludo_build_bot",
    },
    payload: Buffer.from("not-a-real-password"),
  });
  assert.equal(credentials.statusCode, 202);
  assert.equal(credentials.json().state, "WAITING_STEAM_GUARD");
  assert.deepEqual([...observed[0]!], new Array(observed[0]!.byteLength).fill(0));

  const guard = await server.inject({
    method: "POST",
    url: `/v1/steam/enrollments/${enrollmentId}/guard`,
    headers: { "content-type": "application/octet-stream", "x-ui-session": "authorized" },
    payload: Buffer.from("ABC123"),
  });
  assert.equal(guard.statusCode, 200);
  assert.equal(guard.json().state, "READY");
  assert.deepEqual([...observed[1]!], new Array(observed[1]!.byteLength).fill(0));
  assert.doesNotMatch(`${credentials.body}${guard.body}${wrongContentType.body}${unauthorized.body}`, /not-a-real-password|ABC123|must-not-be-json|unauthorized-password/);
  await server.close();
});
