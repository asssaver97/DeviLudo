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
