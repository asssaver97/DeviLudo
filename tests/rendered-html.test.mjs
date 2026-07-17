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
  assert.match(html, /余烬群岛/);
  assert.match(html, /三平台 E2E/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);

  const admin = await request("/admin/agents", { headers: { accept: "text/html" } });
  assert.equal(admin.status, 200);
  const adminHtml = await admin.text();
  assert.match(adminHtml, /Agent 运维台/);
  assert.match(adminHtml, /Claude Code/);
  assert.match(adminHtml, /Codex CLI/);

  const project = await request("/projects/ember-archipelago", { headers: { accept: "text/html" } });
  assert.equal(project.status, 200);
  assert.match(await project.text(), /真实 Agent 必须先通过独立预检/);
});

test("exposes health, agent catalog and idempotent spec approval APIs", async () => {
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");

  const agents = await request("/api/admin/agents");
  assert.equal(agents.status, 200);
  const agentPayload = await agents.json();
  assert.equal(agentPayload.meta.defaultAgent, "claude-code");
  assert.deepEqual(agentPayload.data.map((agent) => agent.id), ["claude-code", "codex-cli"]);

  const init = {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "test-spec-approve" },
    body: JSON.stringify({ action: "approve", revision: "SPEC-008" }),
  };
  const first = await request("/api/projects/ember-archipelago/spec-revisions", init);
  assert.equal(first.status, 201);
  const firstPayload = await first.json();
  assert.equal(firstPayload.data.run.locked, true);
  assert.equal(firstPayload.data.run.exactAgentVersion, "2.1.14");

  const replay = await request("/api/projects/ember-archipelago/spec-revisions", init);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).meta.idempotentReplay, true);
});

test("credential ingress never echoes or stores the plaintext API key", async () => {
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
  assert.equal(response.status, 201);
  const serialized = JSON.stringify(await response.json());
  assert.doesNotMatch(serialized, new RegExp(plaintext));
  assert.match(serialized, /vault:\/\//);
  assert.match(serialized, /plaintextRecoverable.*false/);
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
