import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalAgentRuntimeHeaders,
  LocalAgentRuntimeRequestVerifier,
  localAgentRuntimeKeyFromEnvironment,
} from "../src/request-auth";

const key = new Uint8Array(Buffer.alloc(32, 7));
const now = new Date("2026-07-21T12:00:00.000Z");
const body = JSON.stringify({ projectId: "project-1", runId: "run-1" });
const nonce = "abcdefghijklmnopqrstuvwx";

test("local Agent sidecar authenticates one exact method, path and body only once", () => {
  const assertion = { method: "POST" as const, path: "/v1/runs" as const, body };
  const headers = createLocalAgentRuntimeHeaders(assertion, { key, now, nonce });
  const verifier = new LocalAgentRuntimeRequestVerifier(key);
  verifier.verify({ ...assertion, headers }, now);
  assert.throws(() => verifier.verify({ ...assertion, headers }, now), /authentication failed/);

  const bodyVerifier = new LocalAgentRuntimeRequestVerifier(key);
  assert.throws(() => bodyVerifier.verify({ ...assertion, body: `${body} `, headers }, now), /authentication failed/);
  const pathVerifier = new LocalAgentRuntimeRequestVerifier(key);
  assert.throws(() => pathVerifier.verify({ ...assertion, path: "/v1/preflight", headers }, now), /authentication failed/);
});

test("local Agent sidecar rejects stale assertions and non-canonical deployment keys", () => {
  const assertion = { method: "POST" as const, path: "/v1/preflight" as const, body };
  const headers = createLocalAgentRuntimeHeaders(assertion, { key, now, nonce });
  const verifier = new LocalAgentRuntimeRequestVerifier(key);
  assert.throws(() => verifier.verify({ ...assertion, headers }, new Date(now.getTime() + 30_001)), /authentication failed/);

  const encoded = Buffer.from(key).toString("base64url");
  assert.deepEqual(localAgentRuntimeKeyFromEnvironment({ DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY: encoded }), key);
  assert.throws(() => localAgentRuntimeKeyFromEnvironment({ DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY: "short" }), /configuration is invalid/);
  assert.throws(() => localAgentRuntimeKeyFromEnvironment({}), /configuration is invalid/);
});
