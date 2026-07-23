import assert from "node:assert/strict";
import test from "node:test";

import { PUT as selectProjectAgent } from "../app/api/projects/[projectId]/agent-settings/route.ts";
import { POST as acceptCandidate } from "../app/api/projects/[projectId]/acceptance/route.ts";
import { POST as mutateDelivery } from "../app/api/projects/[projectId]/delivery/route.ts";
import { POST as approveSpec } from "../app/api/projects/[projectId]/spec-revisions/route.ts";
import { getDemoStore, resetDemoStore } from "../lib/control-plane/demo-store.ts";
import { ensureLocalProject } from "./helpers/local-project.mjs";

const releaseActions = [
  "advance", "advance", "advance", "advance", "advance", "advance",
  "accept", "advance", "advance", "confirm-mfa", "advance", "advance",
  "external-approve", "external-approve", "external-approve",
];

test("new local runs lock the inherited Claude Profile while later configuration changes cannot mutate them", async () => {
  resetDemoStore();
  const projectId = `claude-lock-${crypto.randomUUID()}`;
  await ensureLocalProject(projectId);
  const approved = await approve(projectId, "claude-approval");
  assert.equal(approved.run.agent, "claude-code");
  assert.equal(approved.run.profileRevisionId, "profile-claude-tenant-r2");
  assert.equal(approved.run.configurationSource, "tenant:tenant-local");
  assert.equal(approved.run.providerRevisionId, "provider-claude-platform-r3");
  assert.equal(approved.run.credentialVersionId, "cred-claude-platform-v4");
  assert.equal(approved.run.exactAgentVersion, "2.1.14");
  assert.equal(approved.run.adapterVersion, "1.3.0");
  assert.equal(approved.run.agentVersionAttestation.validatedAdapterVersion, "1.3.0");
  assert.deepEqual(approved.run.agentVersionAttestation.adapterCompatibility, { min: "1.3.0", maxExclusive: "1.3.1" });
  assert.deepEqual(approved.run.modelRoles, {
    primaryModel: "claude-sonnet-4-6-20250514",
    planningModel: "claude-sonnet-4-6-20250514",
    smallFastModel: "claude-haiku-4-5-20251001",
    subagentModel: "claude-sonnet-4-6-20250514",
  });
  assert.equal(approved.run.budget.maxTurns, 64);
  assert.equal(approved.run.timeoutSeconds, 7200);
  assert.equal(approved.run.locked, true);

  const originalLock = structuredClone(approved.delivery.lockedProfile);
  getDemoStore().defaults[`project:${projectId}`] = "profile-codex-platform-r2";
  const firstStep = await action(projectId, "advance", "claude-first-step");
  assert.deepEqual(firstStep.lockedProfile, originalLock);
  const released = await finish(projectId, "claude", releaseActions.slice(1));
  assert.equal(released.stage, "RELEASED");
  assert.deepEqual(released.lockedProfile, originalLock);
});

test("an explicit project Codex selection is frozen into the same complete local delivery chain", async () => {
  resetDemoStore();
  const projectId = `codex-lock-${crypto.randomUUID()}`;
  await ensureLocalProject(projectId);
  const selection = await selectProjectAgent(localRequest(
    `/api/projects/${projectId}/agent-settings`,
    "PUT",
    { profileRevisionId: "profile-codex-platform-r2" },
    "select-codex",
  ), { params: Promise.resolve({ projectId }) });
  assert.equal(selection.status, 200);

  const approved = await approve(projectId, "codex-approval");
  assert.equal(approved.run.agent, "codex-cli");
  assert.equal(approved.run.profileRevisionId, "profile-codex-platform-r2");
  assert.equal(approved.run.configurationSource, `project:${projectId}`);
  assert.equal(approved.run.installationId, "codex-installation-091");
  assert.equal(approved.run.providerRevisionId, "provider-codex-platform-r2");
  assert.equal(approved.run.providerProtocol, "openai-responses");
  assert.equal(approved.run.credentialVersionId, "cred-codex-platform-v2");
  assert.equal(approved.run.model, "gpt-5.3-codex-2026-06-12");
  assert.equal(approved.run.modelRoles.smallFastModel, "gpt-5.3-mini-2026-06-12");
  assert.equal(approved.delivery.events[0].message.includes("Codex CLI"), true);

  const released = await finish(projectId, "codex", releaseActions);
  assert.equal(released.stage, "RELEASED");
  assert.equal(released.lockedProfile.agent, "codex-cli");
  assert.equal(released.lockedProfile.profileRevisionId, "profile-codex-platform-r2");
  assert.deepEqual(released.targetResults, { linux: "PASSED", windows: "PASSED", macos: "PASSED" });
});

test("local approval freezes the dialogue-selected target matrix and gates only those systems", { concurrency: false }, async (context) => {
  resetDemoStore();
  const projectId = `windows-only-${crypto.randomUUID()}`;
  await ensureLocalProject(projectId);
  const previousKey = process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_HMAC_KEY;
  process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_HMAC_KEY = Buffer.alloc(32, 19).toString("base64url");
  context.after(() => {
    if (previousKey === undefined) delete process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_HMAC_KEY;
    else process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_HMAC_KEY = previousKey;
  });
  context.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, `/v1/projects/${projectId}/spec-approval`);
    assert.equal(init?.method, "POST");
    assert.ok(new Headers(init?.headers).get("x-deviludo-local-sidecar-signature"));
    return new Response(JSON.stringify({
      data: {
        conversationId: "conversation-windows-only",
        revision: 4,
        specRevisionId: "spec-windows-only-approved",
        testPlanRevisionId: "test-plan-windows-only-frozen",
        state: "APPROVED",
        specDigest: "a".repeat(64),
        testPlanDigest: "b".repeat(64),
        targetMatrix: ["windows"],
        godotVersion: "4.5.0",
        approvedAt: "2026-07-23T00:00:00.000Z",
      },
    }), { status: 201, headers: { "content-type": "application/json" } });
  });

  const response = await approveSpec(localRequest(
    `/api/projects/${projectId}/spec-revisions`,
    "POST",
    {
      action: "approve",
      revision: "SPEC-004",
      conversationId: "conversation-windows-only",
      expectedRevision: 3,
      specRevisionId: "spec-windows-only-draft",
      testPlanRevisionId: "test-plan-windows-only-draft",
    },
    "windows-only-approval",
  ), { params: Promise.resolve({ projectId }) });
  assert.equal(response.status, 201);
  const approved = (await response.json()).data;
  assert.deepEqual(approved.run.targetMatrix, ["windows"]);
  assert.deepEqual(approved.delivery.targetMatrix, ["windows"]);
  assert.deepEqual(approved.delivery.targetResults, { windows: "QUEUED" });

  const releasedCandidate = await finish(projectId, "windows-only", ["advance", "advance", "advance", "advance"]);
  assert.equal(releasedCandidate.stage, "AWAITING_ACCEPTANCE");
  assert.deepEqual(releasedCandidate.targetMatrix, ["windows"]);
  assert.deepEqual(releasedCandidate.targetResults, { windows: "PASSED" });
});

test("a project may explicitly pin its current tenant Profile but not another project's Profile", async () => {
  resetDemoStore();
  const projectId = `tenant-lock-${crypto.randomUUID()}`;
  await ensureLocalProject(projectId);
  const accepted = await selectProjectAgent(localRequest(
    `/api/projects/${projectId}/agent-settings`,
    "PUT",
    { profileRevisionId: "profile-claude-tenant-r2" },
    "select-tenant-claude",
  ), { params: Promise.resolve({ projectId }) });
  assert.equal(accepted.status, 200);
  const approved = await approve(projectId, "tenant-profile-approval");
  assert.equal(approved.run.profileRevisionId, "profile-claude-tenant-r2");
  assert.equal(approved.run.configurationSource, `project:${projectId}`);

  const rejected = await selectProjectAgent(localRequest(
    `/api/projects/${projectId}/agent-settings`,
    "PUT",
    { profileRevisionId: "profile-codex-project-r1" },
    "select-other-project",
  ), { params: Promise.resolve({ projectId }) });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.code, "PROFILE_SCOPE_MISMATCH");
});

test("an unhealthy higher-precedence override blocks enqueue instead of silently changing Agent", async () => {
  const store = resetDemoStore();
  const projectId = `blocked-lock-${crypto.randomUUID()}`;
  await ensureLocalProject(projectId);
  store.defaults[`project:${projectId}`] = "profile-codex-platform-r2";
  const installation = store.installations.find((item) => item.id === "codex-installation-091");
  assert.ok(installation);
  installation.health = "UNHEALTHY";

  const response = await approveSpec(localRequest(
    `/api/projects/${projectId}/spec-revisions`,
    "POST",
    { action: "approve", revision: "SPEC-008" },
    "blocked-approval",
  ), { params: Promise.resolve({ projectId }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "AGENT_PROFILE_NOT_READY");
});

test("a locally revoked credential blocks new runs instead of reusing the active Profile", async () => {
  const store = resetDemoStore();
  const projectId = `revoked-credential-${crypto.randomUUID()}`;
  await ensureLocalProject(projectId);
  store.credentials.push({
    id: "cred-claude-platform-v4",
    label: "Revoked Claude fixture",
    secretRef: "vault://kv/data/deviludo/cred-claude-platform-v4#4",
    fingerprint: `sha256:${"a".repeat(64)}`,
    masked: `sha256:${"a".repeat(8)}…${"a".repeat(8)}`,
    version: 4,
    state: "REVOKED",
    createdAt: "2026-07-18T08:42:00.000Z",
  });

  const response = await approveSpec(localRequest(
    `/api/projects/${projectId}/spec-revisions`,
    "POST",
    { action: "approve", revision: "SPEC-008" },
    "revoked-credential-approval",
  ), { params: Promise.resolve({ projectId }) });

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "AGENT_PROFILE_NOT_READY");
});

test("a missing or incompatible local AgentVersion attestation blocks enqueue", async () => {
  const missingStore = resetDemoStore();
  const projectId = `unattested-agent-${crypto.randomUUID()}`;
  await ensureLocalProject(projectId);
  missingStore.agentVersionMetadata["claude-code@2.1.14"].validatedAdapterVersion = null;
  missingStore.agentVersionMetadata["claude-code@2.1.14"].adapterCompatibility = null;
  const missing = await approveSpec(localRequest(
    `/api/projects/${projectId}/spec-revisions`, "POST",
    { action: "approve", revision: "SPEC-008" }, "unattested-agent-approval",
  ), { params: Promise.resolve({ projectId }) });
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).error.code, "AGENT_PROFILE_NOT_READY");

  const incompatibleStore = resetDemoStore();
  incompatibleStore.agentVersionMetadata["claude-code@2.1.14"].validatedAdapterVersion = "1.2.9";
  incompatibleStore.agentVersionMetadata["claude-code@2.1.14"].adapterCompatibility = {
    min: "1.2.9", maxExclusive: "1.2.10",
  };
  const incompatible = await approveSpec(localRequest(
    `/api/projects/${projectId}/spec-revisions`, "POST",
    { action: "approve", revision: "SPEC-008" }, "incompatible-agent-approval",
  ), { params: Promise.resolve({ projectId }) });
  assert.equal(incompatible.status, 409);
  assert.equal((await incompatible.json()).error.code, "AGENT_PROFILE_NOT_READY");

  const malformedStore = resetDemoStore();
  malformedStore.agentVersionMetadata["claude-code@2.1.14"].validationReceiptDigest = "sha256:truncated";
  const malformed = await approveSpec(localRequest(
    `/api/projects/${projectId}/spec-revisions`, "POST",
    { action: "approve", revision: "SPEC-008" }, "malformed-agent-attestation-approval",
  ), { params: Promise.resolve({ projectId }) });
  assert.equal(malformed.status, 409);
  assert.equal((await malformed.json()).error.code, "AGENT_PROFILE_NOT_READY");
});

async function approve(projectId, key) {
  const response = await approveSpec(localRequest(
    `/api/projects/${projectId}/spec-revisions`,
    "POST",
    { action: "approve", revision: "SPEC-008" },
    key,
  ), { params: Promise.resolve({ projectId }) });
  assert.equal(response.status, 201);
  return (await response.json()).data;
}

async function finish(projectId, prefix, actions) {
  let snapshot;
  for (const [index, next] of actions.entries()) {
    snapshot = await action(projectId, next, `${prefix}-${index + 1}`);
  }
  return snapshot;
}

async function action(projectId, next, key) {
  const response = next === "accept"
    ? await acceptCandidate(localRequest(
      `/api/projects/${projectId}/acceptance`,
      "POST",
      {},
      key,
    ), { params: Promise.resolve({ projectId }) })
    : await mutateDelivery(localRequest(
      `/api/projects/${projectId}/delivery`,
      "POST",
      { action: next },
      key,
    ), { params: Promise.resolve({ projectId }) });
  assert.equal(response.status, 201, `${next} should advance ${projectId}`);
  return (await response.json()).data;
}

function localRequest(pathname, method, body, key) {
  return new Request(`http://127.0.0.1:3000${pathname}`, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}
