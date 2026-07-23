import assert from "node:assert/strict";
import test from "node:test";
import { POST as CLEANUP } from "../app/api/local/smoke-cleanup/route.ts";
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
