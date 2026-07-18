import assert from "node:assert/strict";
import { test } from "node:test";
import { createEvidenceArchiveHandler, createEvidenceArchiveHttpsServer } from "../src/ingress-http";

const spiffeId = "spiffe://deviludo.internal/runner-control/ingress";
const digest = "a".repeat(64);
const identity = Object.freeze({
  spiffeId,
  certificateFingerprint: "b".repeat(64),
  certificateSerial: "01",
  certificateNotAfter: "2030-01-01T01:00:00.000Z",
});

test("mTLS archive handler authorizes one workload and preserves idempotency binding", async () => {
  let persisted: unknown;
  const handler = createEvidenceArchiveHandler({
    allowedSpiffeIds: new Set([spiffeId]),
    extractIdentity: () => identity,
    archive: {
      probe: async () => undefined,
      persist: async (value) => {
        persisted = value;
        return {
          created: true,
          receipt: {
            schemaVersion: "deviludo.runner-evidence-archive-receipt.v1",
            tenantId: "tenant",
            projectId: "project",
            attemptId: "attempt",
            bundleDigest: digest,
            objectKey: `evidence/${digest}.json`,
            repairPromptId: null,
          },
        };
      },
    },
  });
  const body = { bundleDigest: digest };
  const response = await handler({
    method: "POST",
    path: "/v1/runner-evidence",
    headers: {
      "content-type": "application/json",
      "idempotency-key": digest,
      "x-deviludo-bundle-digest": digest,
    },
    socket: {},
    rawBody: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(persisted, body);
  const health = await handler({ method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" });
  assert.deepEqual(health, { status: 200, body: { status: "ok", service: "deviludo-evidence-archive" } });
});

test("archive handler rejects missing mTLS, forbidden workload and header/body drift", async () => {
  const archive = { probe: async () => undefined, persist: async () => { throw new Error("must not persist"); } };
  const request = {
    method: "POST",
    path: "/v1/runner-evidence",
    headers: {
      "content-type": "application/json",
      "idempotency-key": digest,
      "x-deviludo-bundle-digest": digest,
    },
    socket: {},
    rawBody: JSON.stringify({ bundleDigest: digest }),
  } as const;
  const missing = createEvidenceArchiveHandler({
    archive,
    allowedSpiffeIds: new Set([spiffeId]),
    extractIdentity: () => { throw new Error("no peer"); },
  });
  assert.equal((await missing(request)).status, 401);
  const forbidden = createEvidenceArchiveHandler({
    archive,
    allowedSpiffeIds: new Set(["spiffe://deviludo.internal/other"]),
    extractIdentity: () => identity,
  });
  assert.equal((await forbidden(request)).status, 403);
  const allowed = createEvidenceArchiveHandler({ archive, allowedSpiffeIds: new Set([spiffeId]), extractIdentity: () => identity });
  assert.equal((await allowed({ ...request, headers: { ...request.headers, "idempotency-key": "c".repeat(64) } })).status, 400);
  assert.equal((await allowed({ ...request, rawBody: JSON.stringify({ bundleDigest: "d".repeat(64) }) })).status, 400);
});

test("archive HTTPS server forces TLS 1.3 client certificates and bounded bodies", () => {
  assert.throws(() => createEvidenceArchiveHttpsServer({ tls: {}, handler: async () => ({ status: 200, body: {} }) }), /incomplete/);
  assert.throws(() => createEvidenceArchiveHttpsServer({
    tls: { key: "key", cert: "cert", ca: "ca" },
    handler: async () => ({ status: 200, body: {} }),
    maxBodyBytes: 16,
  }), /body limit/);
});

test("physical Runner artifact routes delegate only after mTLS and return bounded grant failures", async () => {
  const calls: string[] = [];
  const handler = createEvidenceArchiveHandler({
    archive: { probe: async () => undefined, persist: async () => { throw new Error("not evidence"); } },
    allowedSpiffeIds: new Set([spiffeId]),
    extractIdentity: () => identity,
    runnerArtifacts: {
      grant: async (_identity, value) => {
        calls.push(`grant:${String((value as Record<string, unknown>).schemaVersion)}`);
        return { schemaVersion: "grant-receipt" };
      },
      commit: async (_identity, value) => {
        calls.push(`commit:${String((value as Record<string, unknown>).schemaVersion)}`);
        return { schemaVersion: "commit-receipt" };
      },
    },
  });
  const headers = { "content-type": "application/json" };
  assert.equal((await handler({
    method: "POST", path: "/v1/runner-artifact-grants", headers, socket: {},
    rawBody: JSON.stringify({ schemaVersion: "grant-request" }),
  })).status, 200);
  assert.equal((await handler({
    method: "POST", path: "/v1/runner-artifact-commits", headers, socket: {},
    rawBody: JSON.stringify({ schemaVersion: "commit-request" }),
  })).status, 200);
  assert.deepEqual(calls, ["grant:grant-request", "commit:commit-request"]);

  const rejecting = createEvidenceArchiveHandler({
    archive: { probe: async () => undefined, persist: async () => { throw new Error("not evidence"); } },
    allowedSpiffeIds: new Set([spiffeId]),
    extractIdentity: () => identity,
    runnerArtifacts: {
      grant: async () => { throw new Error("bad job"); },
      commit: async () => { throw new Error("bad object"); },
    },
  });
  assert.deepEqual(await rejecting({
    method: "POST", path: "/v1/runner-artifact-grants", headers, socket: {}, rawBody: "{}",
  }), { status: 409, body: { error: { code: "RUNNER_ARTIFACT_GRANT_REJECTED" } } });
});

test("prepared-input routes delegate identity and fail health when signed assignments are unavailable", async () => {
  const calls: string[] = [];
  let ready = true;
  const handler = createEvidenceArchiveHandler({
    archive: { probe: async () => undefined, persist: async () => { throw new Error("not evidence"); } },
    allowedSpiffeIds: new Set([spiffeId]),
    extractIdentity: () => identity,
    preparedInputs: {
      async probe() { if (!ready) throw new Error("assignment expired"); },
      async grant(observed, value) {
        assert.deepEqual(observed, identity);
        calls.push(`grant:${String((value as Record<string, unknown>).schemaVersion)}`);
        return { schemaVersion: "prepared-input-grant" };
      },
      async commit(observed, value) {
        assert.deepEqual(observed, identity);
        calls.push(`commit:${String((value as Record<string, unknown>).schemaVersion)}`);
        return { schemaVersion: "prepared-input-receipt" };
      },
    },
  });
  const headers = { "content-type": "application/json" };
  assert.equal((await handler({
    method: "POST", path: "/v1/prepared-input-grants", headers, socket: {},
    rawBody: JSON.stringify({ schemaVersion: "grant-request" }),
  })).status, 200);
  assert.equal((await handler({
    method: "POST", path: "/v1/prepared-input-commits", headers, socket: {},
    rawBody: JSON.stringify({ schemaVersion: "commit-request" }),
  })).status, 200);
  assert.deepEqual(calls, ["grant:grant-request", "commit:commit-request"]);
  ready = false;
  assert.deepEqual(await handler({ method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" }), {
    status: 503,
    body: { error: { code: "EVIDENCE_ARCHIVE_NOT_READY" } },
  });

  const absent = createEvidenceArchiveHandler({
    archive: { probe: async () => undefined, persist: async () => { throw new Error("not evidence"); } },
    allowedSpiffeIds: new Set([spiffeId]),
    extractIdentity: () => identity,
  });
  assert.equal((await absent({
    method: "POST", path: "/v1/prepared-input-grants", headers, socket: {}, rawBody: "{}",
  })).status, 404);
});
