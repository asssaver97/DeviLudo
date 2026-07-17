import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST, PUT } from "../app/api/admin/[...segments]/route.ts";
import { getDemoStore, resetDemoStore } from "../lib/control-plane/demo-store.ts";

function context(path) {
  return { params: Promise.resolve({ segments: path.split("/") }) };
}

function request(path, method, role, body = {}) {
  return new Request(`http://127.0.0.1:3000/api/admin/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": `test-${path}-${crypto.randomUUID()}`,
      "x-deviludo-role": role,
    },
    body: JSON.stringify(body),
  });
}

test("local Agent admin mutations persist behind RBAC and emit audit records", async () => {
  resetDemoStore();
  const initial = await GET(new Request("http://127.0.0.1:3000/api/admin/agents"), context("agents"));
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).meta.defaultAgent, "claude-code");

  const changed = await PUT(
    request("agent-defaults/platform", "PUT", "PlatformAgentAdmin", { profileRevisionId: "profile-codex-platform-r2" }),
    context("agent-defaults/platform"),
  );
  assert.equal(changed.status, 200);

  const refreshed = await GET(new Request("http://127.0.0.1:3000/api/admin/agents"), context("agents"));
  assert.equal((await refreshed.json()).meta.defaultAgent, "codex-cli");

  const blocked = await POST(
    request("agent-versions/block", "POST", "PlatformAgentAdmin", { id: "claude-code@2.1.15" }),
    context("agent-versions/block"),
  );
  assert.equal(blocked.status, 201);
  assert.equal(getDemoStore().agentVersions["claude-code@2.1.15"], "BLOCKED");
  assert.equal(getDemoStore().audit.some((entry) => entry.action === "AGENT_VERSION_BLOCKED"), true);
});

test("version approval and Provider activation fail closed without their external trust gates", async () => {
  resetDemoStore();
  const approval = await POST(
    request("agent-versions/approve", "POST", "PlatformAgentAdmin", { id: "claude-code@2.1.15" }),
    context("agent-versions/approve"),
  );
  assert.equal(approval.status, 409);
  assert.equal((await approval.json()).error.code, "SUPPLY_CHAIN_GATES_FAILED");
  assert.equal(getDemoStore().agentVersions["claude-code@2.1.15"], "DISCOVERED");

  const approved = await POST(
    request("agent-versions/approve", "POST", "PlatformAgentAdmin", {
      id: "claude-code@2.1.15",
      integrity: `sha256:${"a".repeat(64)}`,
      signatureVerified: true,
      scan: "PASS",
      sbomRef: "oci://registry.deviludo.invalid/sbom/claude-code@sha256:aaaa",
    }),
    context("agent-versions/approve"),
  );
  assert.equal(approved.status, 201);
  assert.equal(getDemoStore().agentVersions["claude-code@2.1.15"], "APPROVED");

  const draft = await POST(
    request("agent-profiles", "POST", "SecurityAdmin", {
      agent: "claude-code",
      baseUrl: "https://provider.example.com/v1",
      primaryModel: "claude-sonnet-4-6-20250514",
      installationId: "claude-installation-214",
      credentialId: "cred-claude-platform-v4",
      scope: "platform",
      scopeId: "global",
      budgetUsd: 25,
    }),
    context("agent-profiles"),
  );
  assert.equal(draft.status, 201);
  const profileId = (await draft.json()).data.profile.id;

  const validation = await POST(
    request(`agent-profiles/${profileId}/validate`, "POST", "SecurityAdmin"),
    context(`agent-profiles/${profileId}/validate`),
  );
  assert.equal(validation.status, 503);
  assert.equal((await validation.json()).error.code, "PROVIDER_PROBE_NOT_CONFIGURED");
  assert.equal(getDemoStore().profiles.find((item) => item.id === profileId)?.state, "DRAFT");
  assert.equal(getDemoStore().providers.find((item) => item.id === "provider-claude-platform-r3")?.state, "ACTIVE");
});

test("simulated role headers cannot cross local admin RBAC boundaries", async () => {
  resetDemoStore();
  const forbidden = await POST(
    request("agent-rollouts/claude-installation-214/advance", "POST", "Auditor"),
    context("agent-rollouts/claude-installation-214/advance"),
  );
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, "FORBIDDEN");
  assert.equal(getDemoStore().rollouts["claude-installation-214"].percent, 25);
});
