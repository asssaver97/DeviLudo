import assert from "node:assert/strict";
import test from "node:test";
import { createSteamInstallGrantHandler, createSteamInstallGrantHttpsServer } from "../src/install-grant-http";

const identity = { spiffeId: "spiffe://deviludo.test/connector/linux", certificateFingerprint: "a".repeat(64), certificateSerial: "01", certificateNotAfter: "2031-01-01T00:00:00.000Z" };
const request = { method: "POST", path: "/v1/steam-install-grant-redemptions", headers: { "content-type": "application/json" }, socket: {}, rawBody: "{}" };

test("grant HTTP boundary delegates only an authenticated Connector request", async () => {
  let calls = 0;
  const handler = createSteamInstallGrantHandler({
    extractIdentity: () => identity,
    service: {
      async probe() {},
      async redeem(received, body) { calls += 1; assert.deepEqual(received, identity); assert.deepEqual(body, {}); return { schemaVersion: "receipt" } as never; },
    },
  });
  assert.equal((await handler(request)).status, 200);
  assert.equal((await handler({ ...request, method: "GET", path: "/healthz", rawBody: "" })).status, 200);
  assert.equal((await handler({ ...request, path: "/missing" })).status, 404);
  assert.equal((await handler({ ...request, headers: {} })).status, 415);
  assert.equal((await handler({ ...request, rawBody: "[]" })).status, 400);
  assert.equal(calls, 1);
});

test("grant HTTP boundary fails closed on missing identity and redemption errors", async () => {
  const service = { async probe() { throw new Error("down"); }, async redeem() { throw new Error("secret database error"); } };
  const noIdentity = createSteamInstallGrantHandler({ service, extractIdentity: () => { throw new Error("no cert"); } });
  assert.equal((await noIdentity(request)).status, 401);
  const handler = createSteamInstallGrantHandler({ service, extractIdentity: () => identity });
  assert.equal((await handler(request)).status, 409);
  assert.equal((await handler({ ...request, method: "GET", path: "/healthz", rawBody: "" })).status, 503);
});

test("grant HTTPS server requires TLS 1.3 client authentication and bounded bodies", () => {
  const handler = createSteamInstallGrantHandler({ service: { async probe() {}, async redeem() { throw new Error("unused"); } } });
  assert.throws(() => createSteamInstallGrantHttpsServer({ tls: {}, handler }), /incomplete/);
  assert.throws(() => createSteamInstallGrantHttpsServer({ tls: { key: "key", cert: "cert", ca: "ca" }, handler, maxBodyBytes: 2 * 1024 * 1024 }), /body limit/);
});
