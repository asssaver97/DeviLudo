import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { InferenceCredentialAuthority } from "../src/contracts";
import { createSecretBrokerHandler } from "../src/http";
import { SecretBrokerService } from "../src/service";
import { MemorySecretBrokerStore } from "../src/store";
import { MemorySecretBackend } from "../src/vault-backend";

const now = new Date("2026-07-19T08:00:00.000Z");
const control = "spiffe://deviludo.internal/control/control-plane";
const github = "spiffe://deviludo.internal/control/identity";
const inference = "spiffe://deviludo.internal/inference/gateway";
const specModel = "spiffe://deviludo.internal/inference/spec-model-broker";
const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const providerPath = "credential-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1";
const providerWriteKey = createHash("sha256").update(`provider-credential\0${providerPath}`).digest("hex");

class MutableAuthority implements InferenceCredentialAuthority {
  secretRef = "";
  runCalls = 0;
  probeCalls = 0;
  async resolveRun() { this.runCalls += 1; return this.secretRef; }
  async resolveProbe() { this.probeCalls += 1; return this.secretRef; }
  async resolveSpecModel() { return this.secretRef; }
  async probe() {}
}

function fixture() {
  const store = new MemorySecretBrokerStore();
  const backend = new MemorySecretBackend();
  const authority = new MutableAuthority();
  const service = new SecretBrokerService({ store, backend, authority, now: () => new Date(now) });
  return { store, backend, authority, service };
}

test("Provider credential writes are immutable, replayable and leased only through run authority", async () => {
  const value = Buffer.from("provider-key-secret-value");
  const f = fixture();
  const first = await f.service.writeProviderCredential({
    path: "credential-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1",
    plaintext: value,
    workloadSpiffeId: control,
  });
  const replay = await f.service.writeProviderCredential({
    path: "credential-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1",
    plaintext: value,
    workloadSpiffeId: control,
  });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.secretRef, first.secretRef);
  assert.equal(f.backend.values.size, 1);
  f.authority.secretRef = first.secretRef;

  const lease = await f.service.resolveInference({
    requestId: "44444444-4444-4444-8444-444444444444",
    tenantId, projectId, runId,
    providerRevisionId: "provider-claude-r1",
    credentialVersionId: "credential-a-v1",
    workloadSpiffeId: inference,
  });
  assert.equal(lease.schemaVersion, "deviludo.inference-credential-lease.v1");
  assert.equal(lease.value, value.toString("base64"));
  assert.equal("workloadSpiffeId" in lease, false);
  assert.equal(f.authority.runCalls, 1);
  assert.equal(JSON.stringify(f.store.audit).includes("provider-key-secret-value"), false);
  assert.deepEqual(f.store.audit.map((item) => item.action), ["CREATED", "LEASED"]);

  await f.service.revoke({ secretRef: first.secretRef, workloadSpiffeId: control });
  await assert.rejects(f.service.resolveInference({
    requestId: "55555555-5555-4555-8555-555555555555",
    tenantId, projectId, runId,
    providerRevisionId: "provider-claude-r1",
    credentialVersionId: "credential-a-v1",
    workloadSpiffeId: inference,
  }), /not active/);
  assert.equal(f.backend.values.size, 0);
});

test("one-time PKCE is fenced, consumed once and physically destroyed", async () => {
  const f = fixture();
  const verifier = Buffer.from("A".repeat(43));
  const written = await f.service.putPkce({
    value: verifier,
    expiresAt: "2026-07-19T08:10:00.000Z",
    workloadSpiffeId: github,
  });
  const taken = await f.service.takePkce({ secretRef: written.secretRef, workloadSpiffeId: github });
  assert.equal(taken?.toString("utf8"), "A".repeat(43));
  taken?.fill(0);
  assert.equal(await f.service.takePkce({ secretRef: written.secretRef, workloadSpiffeId: github }), null);
  assert.equal(f.backend.values.size, 0);
  assert.deepEqual(f.store.audit.map((item) => item.action), ["CREATED", "CONSUMED"]);
});

test("expired unused PKCE is fenced, physically destroyed and audited by the sweeper", async () => {
  let clock = new Date("2026-07-19T08:00:00.000Z");
  const store = new MemorySecretBrokerStore();
  const backend = new MemorySecretBackend();
  const authority = new MutableAuthority();
  const service = new SecretBrokerService({ store, backend, authority, now: () => new Date(clock) });
  const written = await service.putPkce({
    value: Buffer.from("B".repeat(43)), expiresAt: "2026-07-19T08:05:00.000Z", workloadSpiffeId: github,
  });
  clock = new Date("2026-07-19T08:06:00.000Z");
  assert.equal(await service.purgeExpiredPkce(), 1);
  assert.equal(backend.values.size, 0);
  assert.equal(store.records.get(written.secretRef)?.state, "REVOKED");
  assert.deepEqual(store.audit.map((item) => item.action), ["CREATED", "REVOKED"]);
  assert.equal(await service.takePkce({ secretRef: written.secretRef, workloadSpiffeId: github }), null);
});

test("HTTP boundary separates control-plane, GitHub, inference and spec-model workload roles", async () => {
  const f = fixture();
  const handler = createSecretBrokerHandler({
    service: f.service,
    controlPlaneSpiffeIds: new Set([control]),
    githubSpiffeIds: new Set([github]),
    inferenceGatewaySpiffeIds: new Set([inference]),
    specModelSpiffeIds: new Set([specModel]),
    extractIdentity: (socket) => ({ spiffeId: String(socket) }),
  });
  const forbidden = await handler({
    method: "POST", path: "/secrets:write", socket: github,
    headers: { "content-type": "application/octet-stream", "x-deviludo-secret-path": encodeURIComponent(providerPath), "idempotency-key": providerWriteKey },
    body: Buffer.from("provider-key-secret-value"),
  });
  assert.equal(forbidden.status, 403);

  const created = await handler({
    method: "POST", path: "/secrets:write", socket: control,
    headers: { "content-type": "application/octet-stream", "x-deviludo-secret-path": encodeURIComponent(providerPath), "idempotency-key": providerWriteKey },
    body: Buffer.from("provider-key-secret-value"),
  });
  assert.equal(created.status, 201);
  const createdBody = JSON.parse(created.body.toString("utf8")) as { secretRef: string };
  f.authority.secretRef = createdBody.secretRef;

  const wrongInferenceRole = await handler({
    method: "POST", path: "/v1/inference-credentials/resolve", socket: control,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({
      schemaVersion: "deviludo.inference-credential-request.v1",
      requestId: "44444444-4444-4444-8444-444444444444",
      tenantId, projectId, runId,
      providerRevisionId: "provider-claude-r1", credentialVersionId: "credential-a-v1",
    })),
  });
  assert.equal(wrongInferenceRole.status, 403);

  const resolved = await handler({
    method: "POST", path: "/v1/inference-credentials/resolve", socket: inference,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({
      schemaVersion: "deviludo.inference-credential-request.v1",
      requestId: "44444444-4444-4444-8444-444444444444",
      tenantId, projectId, runId,
      providerRevisionId: "provider-claude-r1", credentialVersionId: "credential-a-v1",
    })),
  });
  assert.equal(resolved.status, 200);
  assert.equal(JSON.parse(resolved.body.toString("utf8")).value, Buffer.from("provider-key-secret-value").toString("base64"));
});
