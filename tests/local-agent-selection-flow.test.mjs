import assert from "node:assert/strict";
import test from "node:test";

import { PUT as selectProjectAgent } from "../app/api/projects/[projectId]/agent-settings/route.ts";
import { POST as mutateDelivery } from "../app/api/projects/[projectId]/delivery/route.ts";
import { POST as approveSpec } from "../app/api/projects/[projectId]/spec-revisions/route.ts";
import { getDemoStore, resetDemoStore } from "../lib/control-plane/demo-store.ts";

const releaseActions = [
  "advance", "advance", "advance", "advance", "advance", "advance",
  "accept", "advance", "advance", "confirm-mfa", "advance", "advance",
  "external-approve", "external-approve", "external-approve",
];

test("new local runs lock the inherited Claude Profile while later configuration changes cannot mutate them", async () => {
  resetDemoStore();
  const projectId = `claude-lock-${crypto.randomUUID()}`;
  const approved = await approve(projectId, "claude-approval");
  assert.equal(approved.run.agent, "claude-code");
  assert.equal(approved.run.profileRevisionId, "profile-claude-tenant-r2");
  assert.equal(approved.run.configurationSource, "tenant:north-dock");
  assert.equal(approved.run.providerRevisionId, "provider-claude-platform-r3");
  assert.equal(approved.run.credentialVersionId, "cred-claude-platform-v4");
  assert.equal(approved.run.exactAgentVersion, "2.1.14");
  assert.equal(approved.run.adapterVersion, "1.3.0");
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
  assert.equal(approved.delivery.events[0].message.includes("Codex CLI"), true);

  const released = await finish(projectId, "codex", releaseActions);
  assert.equal(released.stage, "RELEASED");
  assert.equal(released.lockedProfile.agent, "codex-cli");
  assert.equal(released.lockedProfile.profileRevisionId, "profile-codex-platform-r2");
  assert.deepEqual(released.targetResults, { linux: "PASSED", windows: "PASSED", macos: "PASSED" });
});

test("a project may explicitly pin its current tenant Profile but not another project's Profile", async () => {
  resetDemoStore();
  const projectId = `tenant-lock-${crypto.randomUUID()}`;
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
  const response = await mutateDelivery(localRequest(
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
