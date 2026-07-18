import assert from "node:assert/strict";
import test from "node:test";
import {
  createSteamCleanInstallPreparationHandler,
  createSteamCleanInstallPreparationHttpsServer,
} from "../src/clean-install-http";

const identity = Object.freeze({
  spiffeId: "spiffe://deviludo.internal/runner-workflow",
  certificateFingerprint: "a".repeat(64),
  certificateSerial: "01",
  certificateNotAfter: "2099-01-02T00:00:00.000Z",
});
const request = Object.freeze({
  method: "POST",
  path: "/v1/clean-install-execution-preparations",
  headers: { "content-type": "application/json" },
  socket: {},
  rawBody: JSON.stringify({ schemaVersion: "trigger" }),
});

test("Steam clean-install HTTP ingress returns one secret-free mTLS preparation receipt", async () => {
  let prepared = 0;
  const handler = createSteamCleanInstallPreparationHandler({
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => identity,
    service: {
      async prepare(receivedIdentity, body) {
        prepared += 1;
        assert.deepEqual(receivedIdentity, identity);
        assert.deepEqual(body, { schemaVersion: "trigger" });
        return {
          executionLockId: "11111111-1111-4111-8111-111111111111",
          executionLockDigest: "b".repeat(64),
          sourceDigest: "c".repeat(64),
          steamAppId: "2841930",
          buildId: "91234567",
          betaBranch: "deviludo_private_9",
          installGrantId: "install-grant-9",
          targetMatrix: ["linux", "macos", "windows"],
          created: true,
        };
      },
      async probe() {},
    },
  });
  const response = await handler(request);
  assert.equal(response.status, 200);
  assert.equal(response.body.schemaVersion, "deviludo.steam-clean-install-preparation-receipt.v1");
  assert.equal(response.body.buildId, "91234567");
  assert.equal(prepared, 1);
  assert.doesNotMatch(JSON.stringify(response), /config\.vdf|password|steam.?guard|secret.?ref/i);
});

test("Steam clean-install HTTP ingress rejects identity, routes, content type and preparation failures", async () => {
  const service = { async prepare() { throw new Error("reject"); }, async probe() { throw new Error("not ready"); } };
  const unauthorized = createSteamCleanInstallPreparationHandler({
    allowedSpiffeIds: new Set([identity.spiffeId]), service,
    extractIdentity: () => { throw new Error("no cert"); },
  });
  assert.equal((await unauthorized(request)).status, 401);
  const forbidden = createSteamCleanInstallPreparationHandler({
    allowedSpiffeIds: new Set(["spiffe://deviludo.internal/other"]), service, extractIdentity: () => identity,
  });
  assert.equal((await forbidden(request)).status, 403);
  const handler = createSteamCleanInstallPreparationHandler({
    allowedSpiffeIds: new Set([identity.spiffeId]), service, extractIdentity: () => identity,
  });
  assert.equal((await handler({ ...request, method: "GET", path: "/healthz", rawBody: "" })).status, 503);
  assert.equal((await handler({ ...request, path: "/unknown" })).status, 404);
  assert.equal((await handler({ ...request, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await handler({ ...request, rawBody: "[]" })).status, 400);
  assert.equal((await handler(request)).status, 409);
});

test("Steam clean-install HTTPS server requires TLS 1.3 client authentication and bounded requests", () => {
  const handler = async () => ({ status: 200, body: {} });
  assert.throws(() => createSteamCleanInstallPreparationHttpsServer({ tls: {}, handler }), /incomplete/);
  assert.throws(() => createSteamCleanInstallPreparationHttpsServer({
    tls: { key: "key", cert: "cert", ca: "ca" }, handler, maxBodyBytes: 33 * 1024,
  }), /body limit/);
  assert.throws(() => createSteamCleanInstallPreparationHttpsServer({
    tls: { key: "key", cert: "cert", ca: "ca" }, handler, requestTimeoutMs: 999,
  }), /timeout/);
});
