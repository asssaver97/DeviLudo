import assert from "node:assert/strict";
import test from "node:test";
import { POST as CLEANUP } from "../app/api/local/smoke-cleanup/route.ts";
import {
  appendDemoAudit,
  getDemoStore,
  resetDemoStore,
} from "../lib/control-plane/demo-store.ts";
import {
  claimLocalFeedbackCommand,
  cleanupLocalSmokeDeliveries,
  completeLocalFeedbackCommand,
  readLocalDelivery,
  readLocalFeedbackCommand,
} from "../lib/local-delivery/store.ts";
import { createLocalProject, readLocalProject } from "../lib/projects/local-project-catalog.ts";
import { createLocalSmokeMaintenanceHeaders } from "../lib/security/local-smoke-maintenance-auth.ts";

const cleanupPath = "/api/local/smoke-cleanup";

test("authenticated local cleanup removes generated catalog and delivery state", async () => {
  const previousKey = process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY;
  const key = new Uint8Array(Buffer.alloc(32, 23));
  process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY = Buffer.from(key).toString("base64url");
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const projectId = `smoke-spec-${suffix}`;
  try {
    await createLocalProject({
      slug: projectId,
      name: "Generated smoke cleanup",
      installationId: "local-fixture-9001",
      repositoryId: 7001,
    }, `create:${projectId}`);
    await readLocalDelivery(projectId, "SPEC-SMOKE-CLEANUP");
    const body = JSON.stringify({ projectIds: [projectId] });
    const response = await CLEANUP(new Request(`http://127.0.0.1:3000${cleanupPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createLocalSmokeMaintenanceHeaders({ method: "POST", path: cleanupPath, body }, { key }),
      },
      body,
    }));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.catalog.projects, 1);
    assert.equal(payload.data.delivery.snapshots, 1);
    assert.equal(await readLocalProject(projectId), null);
  } finally {
    if (previousKey === undefined) delete process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY;
    else process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY = previousKey;
  }
});

test("authenticated local cleanup removes only run-labelled Agent resources and preserves monotonic IDs", async () => {
  const previousKey = process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY;
  const previousProviderControl = process.env.DEVILUDO_LOCAL_PROVIDER_CONTROL_REQUIRED;
  const key = new Uint8Array(Buffer.alloc(32, 41));
  process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY = Buffer.from(key).toString("base64url");
  delete process.env.DEVILUDO_LOCAL_PROVIDER_CONTROL_REQUIRED;
  const runId = `${process.pid}-${Date.now().toString(36)}`;
  const projectId = `smoke-release-gates-${runId}`;
  try {
    const store = resetDemoStore();
    store.resourceSequences = { credential: 41, provider: 42, profile: 44, audit: 70 };
    store.credentials.push(
      {
        id: "credential-40-v1", familyId: "credential-40", label: "local-sidecar-live-check",
        scope: "platform", scopeId: "global", secretRef: "vault://kv/data/deviludo/credential-40-v1#1",
        fingerprint: `sha256:${"c".repeat(64)}`, masked: "sha256:cccc…cccc", version: 1,
        state: "REVOKED", createdAt: "2026-07-23T23:59:00.000Z", rotatedAt: null,
      },
      {
        id: "credential-41-v1", familyId: "credential-41", label: `Smoke tenant Provider / ${runId}`,
        scope: "tenant", scopeId: "tenant-local", secretRef: "vault://kv/data/deviludo/credential-41-v1#1",
        fingerprint: `sha256:${"a".repeat(64)}`, masked: "sha256:aaaa…aaaa", version: 1,
        state: "REVOKED", createdAt: "2026-07-24T00:00:00.000Z", rotatedAt: "2026-07-24T00:01:00.000Z",
      },
      {
        id: "credential-41-v2", familyId: "credential-41", label: `Smoke tenant Provider / ${runId}`,
        scope: "tenant", scopeId: "tenant-local", secretRef: "vault://kv/data/deviludo/credential-41-v2#2",
        fingerprint: `sha256:${"b".repeat(64)}`, masked: "sha256:bbbb…bbbb", version: 2,
        state: "ACTIVE", createdAt: "2026-07-24T00:01:00.000Z", rotatedAt: "2026-07-24T00:01:00.000Z",
      },
    );
    store.providers.push({
      id: "provider-claude-code-42", revision: 1, agent: "claude-code", protocol: "anthropic-messages",
      baseUrl: "https://gateway.example.com/v1", approvedPorts: [443], authentication: "x-api-key",
      models: {
        primaryModel: "claude-sonnet-4-6-20250514", planningModel: "claude-opus-4-6-20260205",
        smallFastModel: "claude-haiku-4-5-20251001", subagentModel: "claude-sonnet-4-6-20250514",
      },
      pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
      credentialVersionId: "credential-41-v2",
      governance: {
        dataRegion: "us-east", retentionPolicy: "zero application retention", trainingPolicy: "no training",
        confirmedBy: "local-user", confirmedAt: "2026-07-24T00:02:00.000Z",
      },
      state: "DRAFT", probe: {},
    });
    store.profiles.push({
      id: "profile-claude-code-44-r1", revision: 1, scope: "tenant", scopeId: "tenant-local",
      agent: "claude-code", providerRevisionId: "provider-claude-code-42",
      installationId: "claude-installation-214", credentialVersionId: "credential-41-v2", state: "DRAFT",
      budget: { maxUsd: 29, maxTurns: 77, timeoutSeconds: 5400 }, fallbackProfileRevisionId: null,
      createdAt: "2026-07-24T00:02:00.000Z",
    });
    store.defaults[`project:${projectId}`] = "profile-codex-platform-r2";
    store.idempotency[`admin:credentials:tenant:tenant-local:smoke-${runId}`] = { id: "credential-41-v1" };
    appendDemoAudit("AGENT_PROFILE_DRAFTED", "profile-claude-code-44-r1", "TenantAdmin");
    appendDemoAudit("USER_SENTINEL", "profile-claude-platform-r5", "PlatformAgentAdmin");
    const sequenceBefore = structuredClone(store.resourceSequences);
    const body = JSON.stringify({ projectIds: [projectId] });
    const response = await CLEANUP(new Request(`http://127.0.0.1:3000${cleanupPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createLocalSmokeMaintenanceHeaders({ method: "POST", path: cleanupPath, body }, { key }),
      },
      body,
    }));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.data.admin, {
      changed: true, credentials: 3, providers: 1, profiles: 1, defaults: 1,
      feedback: 0, audit: 1, idempotency: 1,
    });
    assert.equal(getDemoStore().credentials.some((item) => item.familyId === "credential-41"), false);
    assert.equal(getDemoStore().providers.some((item) => item.id === "provider-claude-code-42"), false);
    assert.equal(getDemoStore().profiles.some((item) => item.id === "profile-claude-code-44-r1"), false);
    assert.equal(getDemoStore().audit.some((item) => item.action === "USER_SENTINEL"), true);
    assert.deepEqual(getDemoStore().resourceSequences, sequenceBefore);
    const audit = appendDemoAudit("AFTER_CLEANUP", "sentinel", "PlatformAgentAdmin");
    assert.equal(audit.id, `AUD-${String(sequenceBefore.audit + 1).padStart(5, "0")}`);
  } finally {
    resetDemoStore();
    if (previousKey === undefined) delete process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY;
    else process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY = previousKey;
    if (previousProviderControl === undefined) delete process.env.DEVILUDO_LOCAL_PROVIDER_CONTROL_REQUIRED;
    else process.env.DEVILUDO_LOCAL_PROVIDER_CONTROL_REQUIRED = previousProviderControl;
  }
});

test("local cleanup rejects ordinary project identities without deleting them", async () => {
  const previousKey = process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY;
  const key = new Uint8Array(Buffer.alloc(32, 29));
  process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY = Buffer.from(key).toString("base64url");
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const projectId = `user-game-${suffix}`;
  try {
    await createLocalProject({
      slug: projectId,
      name: "User project sentinel",
      installationId: "local-fixture-9001",
      repositoryId: 7001,
    }, `create:${projectId}`);
    const body = JSON.stringify({ projectIds: [projectId] });
    const response = await CLEANUP(new Request(`http://127.0.0.1:3000${cleanupPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createLocalSmokeMaintenanceHeaders({ method: "POST", path: cleanupPath, body }, { key }),
      },
      body,
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_LOCAL_SMOKE_CLEANUP");
    assert.equal((await readLocalProject(projectId))?.projectId, projectId);
  } finally {
    if (previousKey === undefined) delete process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY;
    else process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY = previousKey;
  }
});

test("local cleanup requires a signed maintenance assertion", async () => {
  const previousKey = process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY;
  process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY = Buffer.alloc(32, 31).toString("base64url");
  try {
    const response = await CLEANUP(new Request(`http://127.0.0.1:3000${cleanupPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectIds: ["smoke-spec-12345-mrxqiuav"] }),
    }));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "LOCAL_SMOKE_AUTH_REQUIRED");
  } finally {
    if (previousKey === undefined) delete process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY;
    else process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY = previousKey;
  }
});

test("local feedback command replays exactly and is removed with its smoke project", async () => {
  const projectId = `smoke-feedback-${process.pid}-${Date.now().toString(36)}`;
  const commandKey = `feedback:${projectId}:repeatable`;
  const requestDigest = "a".repeat(64);
  const response = JSON.stringify({ projectId, state: "AWAITING_SPEC_APPROVAL" });
  assert.equal((await readLocalFeedbackCommand(projectId, commandKey, requestDigest)).kind, "MISSING");
  assert.equal((await claimLocalFeedbackCommand(projectId, commandKey, requestDigest)).kind, "CLAIMED");
  await completeLocalFeedbackCommand(projectId, commandKey, requestDigest, response);
  const replay = await readLocalFeedbackCommand(projectId, commandKey, requestDigest);
  assert.equal(replay.kind, "REPLAY");
  assert.equal(replay.response, response);
  assert.equal((await readLocalFeedbackCommand(projectId, commandKey, "b".repeat(64))).kind, "CONFLICT");
  const cleanup = await cleanupLocalSmokeDeliveries([projectId]);
  assert.equal(cleanup.feedbackCommands, 1);
  assert.equal((await readLocalFeedbackCommand(projectId, commandKey, requestDigest)).kind, "MISSING");
});
