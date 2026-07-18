import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactPreparationHandler, createArtifactPreparationHttpsServer } from "../src/ingress-http";

const spiffeId = "spiffe://deviludo.internal/runner-control/artifact-preparer";
const identity = Object.freeze({
  spiffeId,
  certificateFingerprint: "a".repeat(64),
  certificateSerial: "01",
  certificateNotAfter: "2030-01-01T00:00:00.000Z",
});

test("Artifact Preparer HTTP ingress returns one bounded mTLS preparation receipt", async () => {
  let observedIdentity: unknown;
  let observedBody: unknown;
  const handler = createArtifactPreparationHandler({
    allowedSpiffeIds: new Set([spiffeId]),
    extractIdentity: () => identity,
    service: {
      async probe() {},
      async prepare(selectedIdentity, body) {
        observedIdentity = selectedIdentity;
        observedBody = body;
        return {
          executionLockId: "11111111-1111-4111-8111-111111111111",
          executionLockDigest: "a".repeat(64),
          sourceDigest: "b".repeat(64),
          sourceArtifactDigest: "c".repeat(64),
          sourceObjectKey: "source",
          testPlanDigest: "d".repeat(64),
          testPlanObjectKey: "plan",
          created: true,
        };
      },
    },
  });
  const body = { schemaVersion: "deviludo.source-execution-preparation-trigger.v1" };
  const response = await handler({
    method: "POST",
    path: "/v1/source-execution-preparations",
    headers: { "content-type": "application/json; charset=utf-8" },
    socket: {},
    rawBody: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.schemaVersion, "deviludo.source-execution-preparation-receipt.v1");
  assert.deepEqual(observedIdentity, identity);
  assert.deepEqual(observedBody, body);
  assert.deepEqual(await handler({ method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" }), {
    status: 200,
    body: { status: "ok", service: "deviludo-artifact-preparer" },
  });
});

test("Artifact Preparer HTTP ingress rejects unauthenticated, malformed and failed requests", async () => {
  const service = { async probe() { throw new Error("down"); }, async prepare() { throw new Error("rejected"); } };
  const base = {
    method: "POST",
    path: "/v1/source-execution-preparations",
    headers: { "content-type": "application/json" },
    socket: {},
    rawBody: "{}",
  } as const;
  const missing = createArtifactPreparationHandler({
    service,
    allowedSpiffeIds: new Set([spiffeId]),
    extractIdentity: () => { throw new Error("missing"); },
  });
  assert.equal((await missing(base)).status, 401);
  const forbidden = createArtifactPreparationHandler({
    service,
    allowedSpiffeIds: new Set(["spiffe://deviludo.internal/other"]),
    extractIdentity: () => identity,
  });
  assert.equal((await forbidden(base)).status, 403);
  const allowed = createArtifactPreparationHandler({ service, allowedSpiffeIds: new Set([spiffeId]), extractIdentity: () => identity });
  assert.deepEqual(await allowed(base), { status: 409, body: { error: { code: "ARTIFACT_PREPARATION_REJECTED" } } });
  assert.equal((await allowed({ ...base, rawBody: "[1]" })).status, 400);
  assert.equal((await allowed({ ...base, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await allowed({ ...base, path: "/other" })).status, 404);
  assert.equal((await allowed({ ...base, method: "GET", path: "/healthz", rawBody: "" })).status, 503);
});

test("Artifact Preparer HTTPS server requires TLS 1.3 client authentication and bounded requests", () => {
  assert.throws(() => createArtifactPreparationHttpsServer({ tls: {}, handler: async () => ({ status: 200, body: {} }) }), /incomplete/);
  assert.throws(() => createArtifactPreparationHttpsServer({
    tls: { key: "key", cert: "cert", ca: "ca" },
    handler: async () => ({ status: 200, body: {} }),
    maxBodyBytes: 16,
  }), /body limit/);
  assert.throws(() => createArtifactPreparationHttpsServer({
    tls: { key: "key", cert: "cert", ca: "ca" },
    handler: async () => ({ status: 200, body: {} }),
    requestTimeoutMs: 29_999,
  }), /timeout/);
});
