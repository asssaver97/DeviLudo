import assert from "node:assert/strict";
import test from "node:test";

import { POST as automateDelivery } from "../app/api/projects/[projectId]/delivery/auto/route.ts";
import { startLocalDelivery } from "../lib/local-delivery/store.ts";
import { LocalRuntimeRequestVerifier } from "../services/local-runtime/src/request-auth.ts";
import { LocalAgentRuntimeRequestVerifier } from "../services/local-agent-runtime/src/request-auth.ts";
import { LocalSpecRuntimeRequestVerifier } from "../services/local-spec-runtime/src/request-auth.ts";
import { specDigest } from "../services/spec-dialogue/src/store.ts";
import { ensureLocalProject } from "./helpers/local-project.mjs";

const sidecarKey = new Uint8Array(Buffer.alloc(32, 37));
const agentSidecarKey = new Uint8Array(Buffer.alloc(32, 38));
const specSidecarKey = new Uint8Array(Buffer.alloc(32, 39));
process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY = Buffer.from(sidecarKey).toString("base64url");
process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY = Buffer.from(agentSidecarKey).toString("base64url");
process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_HMAC_KEY = Buffer.from(specSidecarKey).toString("base64url");

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
    "SPEC-020",
    "RUN-AUTO-ROUTE",
    `start:${projectId}`,
    undefined,
    ["macos"],
  );
  const verifier = new LocalRuntimeRequestVerifier(sidecarKey);
  const agentVerifier = new LocalAgentRuntimeRequestVerifier(agentSidecarKey);
  const specVerifier = new LocalSpecRuntimeRequestVerifier(specSidecarKey);
  const originalFetch = globalThis.fetch;
  let runtimeCalls = 0;
  let agentCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/conversation")) {
      specVerifier.verify({ method: "GET", path: url.pathname, body: "", headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      const revision = 20;
      const conversationId = `local:${projectId}`;
      const spec = {
        title: "自动编排样例", elevatorPitch: "验证自动 Agent 选择与 Godot 链路。", genre: "2D 桌面单机冒险",
        godotVersion: "4.5.0", targetPlatforms: ["macos"], features: ["清晰的核心循环"],
        acceptanceCriteria: [{ id: "core-loop", description: "玩家可完成一次核心循环", required: true }],
      };
      const testPlan = { version: "godot-testkit-1.0.0", scenarios: ["核心循环"], minimumFps: 60, maxCrashCount: 0 };
      return Response.json({ data: {
        tenantId: "tenant-local", projectId, conversationId, revision, state: "APPROVED",
        specRevisionId: "approved-spec-20",
        specDigest: specDigest({ schemaVersion: "deviludo.game-spec.v1", conversationId, revision, spec }),
        testPlanRevisionId: started.snapshot.lockedProfile.testPlanRevisionId,
        testPlanDigest: specDigest({ schemaVersion: "deviludo.test-plan.v1", conversationId, revision, testPlan }),
        messages: [], result: { assistantMessage: "规格已批准。", completeness: 100, openQuestions: [], spec, testPlan },
      } });
    }
    if (url.port === "4312") {
      agentCalls += 1;
      const body = String(init?.body ?? "");
      agentVerifier.verify({ method: "POST", path: "/v1/runs", body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return Response.json({ error: { code: "INSTALLATION_MISMATCH", message: "locked CLI is unavailable in this test" } }, { status: 409 });
    }
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
    assert.deepEqual(command.sourceAuthority, {
      kind: "FIXTURE", fixtureId: "godot-smoke-v1", attemptId: "fixture-attempt-1",
    });
    return Response.json({ data: {
      schemaVersion: 4,
      projectId,
      runId: started.snapshot.runId,
      specRevisionId: started.snapshot.specRevisionId,
      targetMatrix: ["macos"],
      platform: "macos",
      fixtureOnly: true,
      sourceAuthority: command.sourceAuthority,
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
        { name: "macos-export-boot", status: "PASSED", durationMs: 1, detail: "exported app booted" },
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
    assert.equal(firstPayload.meta.agentExecutionAttempted, true);
    assert.equal(firstPayload.meta.developmentMode, "FIXTURE");
    assert.equal(firstPayload.meta.fixtureFallbackCode, "INSTALLATION_MISMATCH");
    assert.equal(firstPayload.meta.idempotentReplay, false);
    assert.deepEqual(firstPayload.data.targetResults, { macos: "PASSED" });

    const replay = await automateDelivery(request(projectId, "auto-route-command"), context);
    const replayPayload = await replay.json();
    assert.equal(replay.status, 200);
    assert.equal(replayPayload.meta.idempotentReplay, true);
    assert.deepEqual(replayPayload.data, firstPayload.data);
    assert.equal(runtimeCalls, 1);
    assert.equal(agentCalls, 1);
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
