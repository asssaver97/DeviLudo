import assert from "node:assert/strict";
import test from "node:test";
import { createSourceSnapshotHandler, createSourceSnapshotHttpsServer } from "../src/source-snapshot-http";

const spiffeId = "spiffe://deviludo.internal/artifact-preparer/source";
const identity = Object.freeze({
  spiffeId,
  certificateFingerprint: "b".repeat(64),
  certificateSerial: "01",
  certificateNotAfter: "2030-01-01T01:00:00.000Z",
});

test("source snapshot handler delegates an mTLS-authenticated grant without weakening tenant authorization", async () => {
  let observedIdentity: unknown;
  let observedBody: unknown;
  const handler = createSourceSnapshotHandler({
    allowedSpiffeIds: new Set([spiffeId]),
    extractIdentity: () => identity,
    sourceSnapshots: {
      async probe() {},
      async grant(selectedIdentity, body) {
        observedIdentity = selectedIdentity;
        observedBody = body;
        return { schemaVersion: "deviludo.source-snapshot-grant.v1" };
      },
    },
  });
  const request = { schemaVersion: "deviludo.source-snapshot-grant-request.v1" };
  const response = await handler({
    method: "POST",
    path: "/v1/source-snapshot-grants",
    headers: { "content-type": "application/json; charset=utf-8" },
    socket: {},
    rawBody: JSON.stringify(request),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(observedIdentity, identity);
  assert.deepEqual(observedBody, request);
  assert.deepEqual(await handler({ method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" }), {
    status: 200,
    body: { status: "ok", service: "deviludo-source-snapshot" },
  });
});

test("source snapshot handler rejects missing identity, forbidden workloads, malformed JSON and service failures", async () => {
  const service = {
    async probe() { throw new Error("not ready"); },
    async grant() { throw new Error("receipt drift"); },
  };
  const base = {
    method: "POST",
    path: "/v1/source-snapshot-grants",
    headers: { "content-type": "application/json" },
    socket: {},
    rawBody: "{}",
  } as const;
  const missing = createSourceSnapshotHandler({
    sourceSnapshots: service,
    allowedSpiffeIds: new Set([spiffeId]),
    extractIdentity: () => { throw new Error("missing"); },
  });
  assert.equal((await missing(base)).status, 401);
  const forbidden = createSourceSnapshotHandler({
    sourceSnapshots: service,
    allowedSpiffeIds: new Set(["spiffe://deviludo.internal/other"]),
    extractIdentity: () => identity,
  });
  assert.equal((await forbidden(base)).status, 403);
  const allowed = createSourceSnapshotHandler({ sourceSnapshots: service, allowedSpiffeIds: new Set([spiffeId]), extractIdentity: () => identity });
  assert.deepEqual(await allowed(base), { status: 409, body: { error: { code: "SOURCE_SNAPSHOT_GRANT_REJECTED" } } });
  assert.equal((await allowed({ ...base, rawBody: "[1]" })).status, 400);
  assert.equal((await allowed({ ...base, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await allowed({ ...base, path: "/other" })).status, 404);
  assert.equal((await allowed({ ...base, method: "GET", path: "/healthz", rawBody: "" })).status, 503);
});

test("source snapshot HTTPS server requires TLS 1.3 client authentication and bounded bodies", () => {
  assert.throws(() => createSourceSnapshotHttpsServer({ tls: {}, handler: async () => ({ status: 200, body: {} }) }), /incomplete/);
  assert.throws(() => createSourceSnapshotHttpsServer({
    tls: { key: "key", cert: "cert", ca: "ca" },
    handler: async () => ({ status: 200, body: {} }),
    maxBodyBytes: 16,
  }), /body limit/);
});
