import assert from "node:assert/strict";
import test from "node:test";

import { POST as automateDelivery } from "../app/api/projects/[projectId]/delivery/auto/route.ts";
import { startLocalDelivery } from "../lib/local-delivery/store.ts";
import { LocalRuntimeRequestVerifier } from "../services/local-runtime/src/request-auth.ts";
import { ensureLocalProject } from "./helpers/local-project.mjs";

const sidecarKey = new Uint8Array(Buffer.alloc(32, 37));
process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY = Buffer.from(sidecarKey).toString("base64url");

function request(projectId, key, body = {}) {
  return new Request(`http://127.0.0.1:3000/api/projects/${projectId}/delivery/auto`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

test("localhost automatic delivery persists an exact replay and invokes Godot only once", async () => {
  const projectId = `auto-route-${crypto.randomUUID()}`;
  await ensureLocalProject(projectId);
  const started = await startLocalDelivery(
    projectId,
    "SPEC-AUTO-ROUTE",
    "RUN-AUTO-ROUTE",
    `start:${projectId}`,
    undefined,
    ["macos"],
  );
  const verifier = new LocalRuntimeRequestVerifier(sidecarKey);
  const originalFetch = globalThis.fetch;
  let runtimeCalls = 0;
  globalThis.fetch = async (_input, init) => {
    runtimeCalls += 1;
    const body = String(init?.body ?? "");
    verifier.verify({
      method: "POST",
      path: "/v1/runs",
      body,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const command = JSON.parse(body);
    assert.deepEqual(command.targetMatrix, ["macos"]);
    return Response.json({ data: {
      schemaVersion: 3,
      projectId,
      runId: started.snapshot.runId,
      specRevisionId: started.snapshot.specRevisionId,
      targetMatrix: ["macos"],
      platform: "macos",
      fixtureOnly: true,
      buildArtifact: {
        fileName: "DeviLudoLocal.zip", platform: "macos", contentType: "application/zip",
        sha256: "f".repeat(64), sizeBytes: 4096,
      },
      evidenceId: "EV-LOCAL-ABCDEF123456",
      status: "TESTS_PASSED",
      releaseGate: "LOCAL_VALIDATION_PASSED",
      candidateSha: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      bundleDigest: "c".repeat(64),
      godotVersion: "4.6.2.stable",
      checks: [
        { name: "import", status: "PASSED", durationMs: 1, detail: "fixture" },
        { name: "boot", status: "PASSED", durationMs: 1, detail: "fixture" },
        { name: "core-loop", status: "PASSED", durationMs: 1, detail: "fixture" },
        { name: "save-load", status: "PASSED", durationMs: 1, detail: "fixture" },
      ],
      artifactDigests: { "junit.xml": "d".repeat(64), "godot.log": "e".repeat(64) },
      createdAt: "2026-07-23T00:00:00.000Z",
    } });
  };
  try {
    const context = { params: Promise.resolve({ projectId }) };
    const first = await automateDelivery(request(projectId, "auto-route-command"), context);
    const firstPayload = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstPayload.data.stage, "AWAITING_ACCEPTANCE");
    assert.equal(firstPayload.meta.stopReason, "USER_ACCEPTANCE_REQUIRED");
    assert.equal(firstPayload.meta.validationExecuted, true);
    assert.equal(firstPayload.meta.idempotentReplay, false);
    assert.deepEqual(firstPayload.data.targetResults, { macos: "PASSED" });

    const replay = await automateDelivery(request(projectId, "auto-route-command"), context);
    const replayPayload = await replay.json();
    assert.equal(replay.status, 200);
    assert.equal(replayPayload.meta.idempotentReplay, true);
    assert.deepEqual(replayPayload.data, firstPayload.data);
    assert.equal(runtimeCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("automatic delivery endpoint is absent outside explicit loopback test mode", async () => {
  const response = await automateDelivery(new Request("https://example.com/api/projects/project/delivery/auto", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "outside-loopback" },
    body: "{}",
  }), { params: Promise.resolve({ projectId: "project" }) });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "LOCAL_AUTOMATION_UNAVAILABLE");
});
