import assert from "node:assert/strict";
import test from "node:test";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

function request(path, init = {}) {
  return worker.fetch(
    new Request(`http://localhost${path}`, init),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      DB: undefined,
      ARTIFACTS: undefined,
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the DeviLudo workbench and admin console", async () => {
  const home = await request("/", { headers: { accept: "text/html" } });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /DeviLudo/);
  assert.match(html, /游戏开发工作台/);
  assert.match(html, /平台不会用演示项目替代真实租户数据/);
  assert.doesNotMatch(html, /余烬群岛|三平台 E2E/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);

  const admin = await request("/admin/agents", { headers: { accept: "text/html" } });
  assert.equal(admin.status, 200);
  const adminHtml = await admin.text();
  assert.match(adminHtml, /Agent 运维台/);
  assert.match(adminHtml, /Claude Code/);
  assert.match(adminHtml, /Codex CLI/);

  const project = await request("/projects/ember-archipelago", { headers: { accept: "text/html" } });
  assert.equal(project.status, 200);
  assert.match(await project.text(), /Production · Temporal 权威投影/);

  const projects = await request("/projects", { headers: { accept: "text/html" } });
  assert.equal(projects.status, 200);
  const projectsHtml = await projects.text();
  assert.match(projectsHtml, /游戏项目/);
  assert.match(projectsHtml, /GitHub App/);

  const runners = await request("/runners", { headers: { accept: "text/html" } });
  assert.equal(runners.status, 200);
  const runnersHtml = await runners.text();
  assert.match(runnersHtml, /运行节点/);
  assert.match(runnersHtml, /不会以固定演示项目替代/);

  const evidence = await request("/evidence", { headers: { accept: "text/html" } });
  assert.equal(evidence.status, 200);
  const evidenceHtml = await evidence.text();
  assert.match(evidenceHtml, /证据中心/);
  assert.match(evidenceHtml, /不会以固定演示项目替代/);
});

test("production worker exposes health but keeps local admin and specification fixtures disabled", async () => {
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  const healthPayload = await health.json();
  assert.equal(healthPayload.status, "ok");
  assert.equal(healthPayload.mode, "PRODUCTION");

  const agents = await request("/api/admin/agents");
  assert.equal(agents.status, 401);
  const agentPayload = await agents.json();
  assert.equal(agentPayload.error.code, "ADMIN_SESSION_INVALID");

  const init = {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "test-spec-approve" },
    body: JSON.stringify({ action: "approve", revision: "SPEC-008" }),
  };
  const first = await request("/api/projects/ember-archipelago/spec-revisions", init);
  assert.equal(first.status, 400);
  const firstPayload = await first.json();
  assert.equal(firstPayload.error.code, "SPEC_APPROVAL_AUTHORITY_REQUIRED");
});

test("production worker never accepts credential plaintext into the local demo store", async () => {
  const plaintext = "fixture-secret-that-must-never-be-returned";
  const response = await request("/api/admin/credentials", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "test-credential-create",
      "x-deviludo-role": "SecurityAdmin",
    },
    body: JSON.stringify({ label: "test credential", apiKey: plaintext }),
  });
  assert.equal(response.status, 401);
  const serialized = JSON.stringify(await response.json());
  assert.doesNotMatch(serialized, new RegExp(plaintext));
  assert.match(serialized, /ADMIN_SESSION_INVALID/);
});

test("public web worker remains fail-closed for runner event writes", async () => {
  const readOnly = await request("/api/runner/events");
  assert.equal(readOnly.status, 200);
  assert.equal((await readOnly.json()).meta.readOnly, true);

  const write = await request("/api/runner/events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-id": "forged-runner" },
    body: JSON.stringify({ type: "PLATFORM_COMPLETED", status: "PASSED" }),
  });
  assert.equal(write.status, 503);
  assert.equal((await write.json()).error.code, "RUNNER_MTLS_INGRESS_REQUIRED");
});

test("localhost never fabricates a successful GitHub App authorization", async () => {
  const response = await request("/api/connections/github", { method: "POST" });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error.code, "GITHUB_APP_INSTALLATION_BROKER_REQUIRED");
  assert.equal(payload.error.details.passwordAccepted, false);
  assert.doesNotMatch(JSON.stringify(payload), /demo-authorized|github password/i);

  for (const path of [
    "/api/connections/github/setup?installation_id=42&state=attacker-controlled",
    "/api/connections/github/callback?code=secret-code&state=attacker-controlled",
  ]) {
    const callback = await request(path);
    assert.equal(callback.status, 503);
    const serialized = JSON.stringify(await callback.json());
    assert.doesNotMatch(serialized, /attacker-controlled|secret-code|installation_id/);
  }
});

test("localhost never fabricates a Steam Guard or build-account session", async () => {
  const response = await request("/api/connections/steam", { method: "POST" });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error.code, "STEAM_GUARD_ENROLLMENT_BROKER_REQUIRED");
  assert.equal(payload.error.details.storesPrimaryPassword, false);
  assert.doesNotMatch(JSON.stringify(payload), /steam-bootstrap|DeviLudo Build Bot|2841930/);

  const publish = await request("/api/releases/release-forged/accept-and-publish", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "forged", "x-mfa-proof": "forged-mfa-proof-long" },
    body: JSON.stringify({ mainCommitSha: "a".repeat(40), evidenceStatus: "PASSED" }),
  });
  assert.equal(publish.status, 503);
  const publishPayload = await publish.json();
  assert.equal(publishPayload.error.code, "STEAM_PUBLISH_DISPATCH_REQUIRED");
  assert.equal(publishPayload.error.details.acceptsHeaderMfaProof, false);
  assert.equal(publishPayload.error.details.acceptsClientEvidenceStatus, false);
});
