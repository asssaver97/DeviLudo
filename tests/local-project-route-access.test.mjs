import assert from "node:assert/strict";
import test from "node:test";

import { POST as acceptCandidate } from "../app/api/projects/[projectId]/acceptance/route.ts";
import { POST as runAgent } from "../app/api/projects/[projectId]/agent-run/route.ts";
import { POST as preflightAgent } from "../app/api/projects/[projectId]/agent-preflight/route.ts";
import { GET as readAgentSettings } from "../app/api/projects/[projectId]/agent-settings/route.ts";
import { GET as readConversation, POST as sendConversation } from "../app/api/projects/[projectId]/conversation/route.ts";
import { GET as readDelivery, POST as mutateDelivery } from "../app/api/projects/[projectId]/delivery/route.ts";
import { POST as automateDelivery } from "../app/api/projects/[projectId]/delivery/auto/route.ts";
import { GET as readEvidence } from "../app/api/projects/[projectId]/evidence/route.ts";
import { GET as readFeedback, POST as submitFeedback } from "../app/api/projects/[projectId]/feedback/route.ts";
import { GET as readValidationEvidence } from "../app/api/projects/[projectId]/local-validation/evidence/[file]/route.ts";
import { GET as readValidationArtifact } from "../app/api/projects/[projectId]/local-validation/artifact/[file]/route.ts";
import { GET as readMainEvidence } from "../app/api/projects/[projectId]/main-validation/evidence/[file]/route.ts";
import { GET as readMainArtifact } from "../app/api/projects/[projectId]/main-validation/artifact/[file]/route.ts";
import { GET as readValidation, POST as runValidation } from "../app/api/projects/[projectId]/local-validation/route.ts";
import { GET as readRunners } from "../app/api/projects/[projectId]/runners/route.ts";
import { GET as readSpec, POST as approveSpec } from "../app/api/projects/[projectId]/spec-revisions/route.ts";
import { GET as readSteamSettings } from "../app/api/projects/[projectId]/steam-settings/route.ts";
import { getDemoStore, resetDemoStore } from "../lib/control-plane/demo-store.ts";
import { LocalSpecRuntimeRequestVerifier } from "../services/local-spec-runtime/src/request-auth.ts";
import { ensureLocalProject } from "./helpers/local-project.mjs";

const projectId = "missing-local-project";
const context = { params: Promise.resolve({ projectId }) };

function request(path, init = {}) {
  return new Request(`http://127.0.0.1:3000${path}`, init);
}

function post(path, body, key) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

test("every localhost project surface rejects a syntactically valid project missing from the durable catalog", async () => {
  const base = `/api/projects/${projectId}`;
  const originalFetch = globalThis.fetch;
  let downstreamCalls = 0;
  globalThis.fetch = async () => {
    downstreamCalls += 1;
    throw new Error("a missing project must not reach a sidecar");
  };
  try {
    const responses = [
      await readConversation(request(`${base}/conversation`), context),
      await sendConversation(post(`${base}/conversation`, { expectedRevision: 0, message: "幽灵项目" }, "missing-conversation"), context),
      await readSpec(request(`${base}/spec-revisions`), context),
      await approveSpec(post(`${base}/spec-revisions`, { action: "approve", revision: "SPEC-001" }, "missing-approval"), context),
      await readFeedback(request(`${base}/feedback`), context),
      await submitFeedback(post(`${base}/feedback`, { feedback: "不应保存" }, "missing-feedback"), context),
      await readDelivery(request(`${base}/delivery`), context),
      await mutateDelivery(post(`${base}/delivery`, { action: "advance" }, "missing-delivery"), context),
      await automateDelivery(post(`${base}/delivery/auto`, {}, "missing-delivery-auto"), context),
      await acceptCandidate(post(`${base}/acceptance`, {}, "missing-acceptance"), context),
      await readValidation(request(`${base}/local-validation`), context),
      await runValidation(post(`${base}/local-validation`, {}, "missing-validation"), context),
      await readValidationEvidence(request(`${base}/local-validation/evidence/manifest.json`), {
        params: Promise.resolve({ projectId, file: "manifest.json" }),
      }),
      await readValidationArtifact(request(`${base}/local-validation/artifact/DeviLudoLocal.zip`), {
        params: Promise.resolve({ projectId, file: "DeviLudoLocal.zip" }),
      }),
      await readMainEvidence(request(`${base}/main-validation/evidence/manifest.json`), {
        params: Promise.resolve({ projectId, file: "manifest.json" }),
      }),
      await readMainArtifact(request(`${base}/main-validation/artifact/DeviLudoMain.zip`), {
        params: Promise.resolve({ projectId, file: "DeviLudoMain.zip" }),
      }),
      await preflightAgent(post(`${base}/agent-preflight`, {}, "missing-preflight"), context),
      await runAgent(post(`${base}/agent-run`, {}, "missing-agent-run"), context),
      await readAgentSettings(request(`${base}/agent-settings`), context),
      await readSteamSettings(request(`${base}/steam-settings`), context),
      await readRunners(request(`${base}/runners`), context),
      await readEvidence(request(`${base}/evidence`), context),
    ];
    for (const response of responses) {
      assert.equal(response.status, 404);
      const payload = await response.json();
      assert.match(payload.error.code, /PROJECT_(?:ACCESS_)?NOT_FOUND/);
    }
    assert.equal(downstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("localhost specification reads remain bound to each catalog project instead of the global fixture revision", async () => {
  const projects = ["spec-scope-alpha", "spec-scope-bravo"];
  await Promise.all(projects.map(ensureLocalProject));
  const key = new Uint8Array(Buffer.alloc(32, 91));
  const previousKey = process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_HMAC_KEY;
  process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_HMAC_KEY = Buffer.from(key).toString("base64url");
  const verifier = new LocalSpecRuntimeRequestVerifier(key);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const requestedProject = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    verifier.verify({ method: "GET", path: url.pathname, body: "", headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const revision = requestedProject === projects[0] ? 4 : 9;
    return Response.json({ data: {
      tenantId: "tenant-local",
      projectId: requestedProject,
      conversationId: `local:${requestedProject}`,
      revision,
      state: requestedProject === projects[0] ? "DRAFT" : "APPROVED",
      specRevisionId: `spec-${requestedProject}-${revision}`,
      specDigest: "a".repeat(64),
      testPlanRevisionId: `plan-${requestedProject}-${revision}`,
      testPlanDigest: "b".repeat(64),
      messages: [],
      result: {
        assistantMessage: "继续完善。",
        completeness: 80,
        openQuestions: [],
        spec: {
          title: requestedProject,
          elevatorPitch: requestedProject,
          genre: "2D 桌面单机",
          godotVersion: "4.5.0",
          targetPlatforms: ["macos"],
          features: ["核心循环"],
          acceptanceCriteria: [{ id: "core", description: "完成核心循环", required: true }],
        },
        testPlan: { version: "godot-testkit-1.0.0", scenarios: ["核心循环"], minimumFps: 60, maxCrashCount: 0 },
      },
    } });
  };
  try {
    const first = await readSpec(request(`/api/projects/${projects[0]}/spec-revisions`), {
      params: Promise.resolve({ projectId: projects[0] }),
    });
    const second = await readSpec(request(`/api/projects/${projects[1]}/spec-revisions`), {
      params: Promise.resolve({ projectId: projects[1] }),
    });
    const firstPayload = await first.json();
    const secondPayload = await second.json();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(firstPayload.data.revision, 4);
    assert.equal(firstPayload.data.state, "DRAFT");
    assert.equal(secondPayload.data.revision, 9);
    assert.equal(secondPayload.data.state, "APPROVED");
    assert.notEqual(firstPayload.data.id, secondPayload.data.id);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_HMAC_KEY;
    else process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_HMAC_KEY = previousKey;
  }
});

test("localhost feedback history is filtered by its authoritative project", async () => {
  resetDemoStore();
  await Promise.all([ensureLocalProject("feedback-scope-alpha"), ensureLocalProject("feedback-scope-bravo")]);
  getDemoStore().feedback.push({
    projectId: "feedback-scope-alpha",
    id: "ITER-SCOPED-001",
    text: "只属于 alpha",
    revision: 3,
    at: "2026-07-23T00:00:00.000Z",
  });
  const alpha = await readFeedback(request("/api/projects/feedback-scope-alpha/feedback"), {
    params: Promise.resolve({ projectId: "feedback-scope-alpha" }),
  });
  const bravo = await readFeedback(request("/api/projects/feedback-scope-bravo/feedback"), {
    params: Promise.resolve({ projectId: "feedback-scope-bravo" }),
  });
  assert.deepEqual((await alpha.json()).data.map((item) => item.id), ["ITER-SCOPED-001"]);
  assert.deepEqual((await bravo.json()).data, []);
});
