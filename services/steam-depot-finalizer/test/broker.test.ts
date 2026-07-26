import assert from "node:assert/strict";
import test from "node:test";
import { steamCanonicalDigest } from "../../steam-publisher/src/artifacts";
import {
  MtlsSteamDepotFinalizer,
  notarizationEvidenceObjectKey,
  signedDepotObjectKey,
  signingEvidenceObjectKey,
} from "../../steam-publisher/src/depot-finalization";
import {
  parseSteamDepotFinalizationRequest,
  validateSteamDepotFinalizationReceipt,
} from "../src/contract";
import type {
  SteamDepotFinalizationReceipt,
  SteamDepotFinalizationRequest,
  SteamDepotNativeFinalizer,
} from "../src/contracts";
import { createSteamDepotFinalizerHandler, createSteamDepotFinalizerHttpsServer } from "../src/ingress-http";
import { InMemorySteamDepotFinalizationOperations } from "../src/operation-memory";
import { DurableSteamDepotFinalizerService } from "../src/service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const identity = Object.freeze({
  spiffeId: "spiffe://deviludo.internal/steam-workflow-executor",
  certificateFingerprint: "f".repeat(64),
  certificateSerial: "01",
  certificateNotAfter: "2026-07-22T00:00:00.000Z",
});

class FixtureNative implements SteamDepotNativeFinalizer {
  executions = 0;
  probes = 0;
  async probe() { this.probes += 1; }
  async finalize(request: SteamDepotFinalizationRequest) {
    this.executions += 1;
    return receipt(request);
  }
}

test("mTLS finalizer durably replays one exact release/platform receipt", async () => {
  const operations = new InMemorySteamDepotFinalizationOperations();
  const native = new FixtureNative();
  let token = 0;
  const service = new DurableSteamDepotFinalizerService(operations, native, {
    now: () => new Date("2026-07-21T10:00:00.000Z"),
    claimToken: () => `${String(++token).padStart(8, "0")}-0000-4000-8000-000000000000`,
  });
  const handler = createSteamDepotFinalizerHandler({
    service,
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => identity,
  });
  const health = await post(handler, "/healthz", {});
  assert.deepEqual(health, {
    status: 200,
    body: {
      schemaVersion: "deviludo.steam-depot-finalizer-health.v1",
      status: "ok",
      service: "deviludo-steam-depot-finalizer",
      supportedSchemes: ["LINUX_SIGSTORE", "MACOS_DEVELOPER_ID", "WINDOWS_AUTHENTICODE"],
    },
  });
  const request = finalizationRequest("windows");
  const first = await post(handler, "/v1/steam-depots/finalize", request);
  const replay = await post(handler, "/v1/steam-depots/finalize", request);
  assert.equal(first.status, 200);
  assert.deepEqual(replay, first);
  assert.equal(native.executions, 1);
  assert.equal(native.probes, 1);
  assert.equal(operations.entries.size, 1);
  assert.equal([...operations.entries.values()][0]?.state, "COMPLETED");
});

test("production publisher client and finalizer server share the exact wire contract", async () => {
  const native = new FixtureNative();
  const service = new DurableSteamDepotFinalizerService(
    new InMemorySteamDepotFinalizationOperations(), native,
    { claimToken: () => "55555555-5555-4555-8555-555555555555" },
  );
  const handler = createSteamDepotFinalizerHandler({
    service,
    allowedSpiffeIds: new Set([identity.spiffeId]),
    supportedSchemes: ["LINUX_SIGSTORE"],
    extractIdentity: () => identity,
  });
  const client = new MtlsSteamDepotFinalizer({
    endpoint: "https://steam-depot-finalizer.internal",
    platform: "linux",
    tls: { key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    http: async (input) => {
      const response = await handler({
        method: "POST",
        path: input.url.pathname,
        headers: { "content-type": "application/json" },
        socket: {},
        rawBody: input.body,
      });
      return { statusCode: response.status, headers: {}, payload: response.body };
    },
  });
  await client.probe();
  const request = finalizationRequest("linux");
  const finalized = await client.finalize({
    tenantId: request.tenantId,
    projectId: request.projectId,
    releaseId: request.releaseId,
    mainCommitSha: request.mainCommitSha,
    evidenceBundleDigest: request.evidenceBundleDigest,
    platform: request.platform,
    sourceObjectKey: request.sourceObjectKey,
    sourceArtifactDigest: request.sourceArtifactDigest,
  });
  assert.equal(finalized.signingScheme, "LINUX_SIGSTORE");
  assert.equal(finalized.sourceArtifactDigest, request.sourceArtifactDigest);
  assert.equal(native.executions, 1);
  await assert.rejects(client.finalize({
    tenantId: request.tenantId,
    projectId: request.projectId,
    releaseId: request.releaseId,
    mainCommitSha: request.mainCommitSha,
    evidenceBundleDigest: request.evidenceBundleDigest,
    platform: "macos",
    sourceObjectKey: request.sourceObjectKey,
    sourceArtifactDigest: request.sourceArtifactDigest,
  }), /platform route is invalid/);
});

test("ingress rejects identity, authority drift and credential fields before native execution", async () => {
  const operations = new InMemorySteamDepotFinalizationOperations();
  const native = new FixtureNative();
  const service = new DurableSteamDepotFinalizerService(operations, native);
  const forbidden = createSteamDepotFinalizerHandler({
    service,
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => ({ ...identity, spiffeId: "spiffe://deviludo.internal/web" }),
  });
  assert.equal((await post(forbidden, "/v1/steam-depots/finalize", finalizationRequest("linux"))).status, 403);

  const handler = createSteamDepotFinalizerHandler({
    service,
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => identity,
  });
  const request = finalizationRequest("linux");
  const injected = await post(handler, "/v1/steam-depots/finalize", { ...request, signingPassword: "plaintext" });
  assert.equal(injected.status, 400);
  const escapedCore = {
    ...request,
    sourceObjectKey: `tenants/${tenantId}/projects/${projectId}/../private/${request.sourceArtifactDigest}`,
  };
  const core: Record<string, unknown> = { ...escapedCore };
  delete core.requestDigest;
  const escaped = await post(handler, "/v1/steam-depots/finalize", {
    ...core,
    requestDigest: steamCanonicalDigest(core),
  });
  assert.equal(escaped.status, 400);
  assert.equal(native.executions, 0);
  assert.equal(operations.entries.size, 0);
  assert.throws(() => createSteamDepotFinalizerHttpsServer({ tls: {}, handler }), /configuration is invalid/);
});

test("macOS finalization cannot complete without exact notarization evidence", async () => {
  const request = finalizationRequest("macos");
  const valid = receipt(request);
  assert.equal(validateSteamDepotFinalizationReceipt(valid, request).signingScheme, "MACOS_DEVELOPER_ID");
  assert.throws(() => validateSteamDepotFinalizationReceipt({
    ...valid,
    notarizationEvidenceObjectKey: null,
    notarizationEvidenceDigest: null,
  }, request), /macOS notarization/);
  assert.throws(() => validateSteamDepotFinalizationReceipt({
    ...receipt(finalizationRequest("windows")),
    notarizationEvidenceObjectKey: "forbidden",
    notarizationEvidenceDigest: "d".repeat(64),
  }, finalizationRequest("windows")), /unexpected notarization/);
});

test("native failure releases the exact lease so a retry can finish", async () => {
  const operations = new InMemorySteamDepotFinalizationOperations();
  let attempts = 0;
  let token = 0;
  const service = new DurableSteamDepotFinalizerService(operations, {
    async probe() {},
    async finalize(request) {
      attempts += 1;
      if (attempts === 1) throw new Error("native unavailable");
      return receipt(request);
    },
  }, {
    now: () => new Date("2026-07-21T10:00:00.000Z"),
    claimToken: () => `${String(++token).padStart(8, "0")}-0000-4000-8000-000000000000`,
  });
  const request = finalizationRequest("linux");
  await assert.rejects(service.finalize(request), /native unavailable/);
  assert.equal([...operations.entries.values()][0]?.state, "PENDING");
  assert.equal((await service.finalize(request)).signingScheme, "LINUX_SIGSTORE");
  assert.equal(attempts, 2);
});

function finalizationRequest(platform: "windows" | "linux" | "macos"): SteamDepotFinalizationRequest {
  const sourceArtifactDigest = platform === "windows" ? "a".repeat(64)
    : platform === "linux" ? "b".repeat(64) : "c".repeat(64);
  const core = Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalization.v1" as const,
    operationKey: `steam-depot-finalize:${releaseId}:${platform}`,
    tenantId,
    projectId,
    releaseId,
    mainCommitSha: "1".repeat(40),
    evidenceBundleDigest: "2".repeat(64),
    platform,
    sourceObjectKey: `tenants/${tenantId}/projects/${projectId}/runner-artifacts/${attemptId}/${platform}/production-export/${sourceArtifactDigest}`,
    sourceArtifactDigest,
  });
  return parseSteamDepotFinalizationRequest({ ...core, requestDigest: steamCanonicalDigest(core) });
}

function receipt(request: SteamDepotFinalizationRequest): SteamDepotFinalizationReceipt {
  const artifactDigest = request.platform === "windows" ? "3".repeat(64)
    : request.platform === "linux" ? "4".repeat(64) : "5".repeat(64);
  const signingEvidenceDigest = "6".repeat(64);
  const notaryDigest = request.platform === "macos" ? "7".repeat(64) : null;
  return Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalization-receipt.v1",
    operationKey: request.operationKey,
    requestDigest: request.requestDigest,
    tenantId: request.tenantId,
    projectId: request.projectId,
    releaseId: request.releaseId,
    mainCommitSha: request.mainCommitSha,
    evidenceBundleDigest: request.evidenceBundleDigest,
    platform: request.platform,
    sourceArtifactDigest: request.sourceArtifactDigest,
    artifactObjectKey: signedDepotObjectKey(
      request.tenantId, request.projectId, request.releaseId, request.platform, artifactDigest,
    ),
    artifactDigest,
    signingScheme: request.platform === "windows" ? "WINDOWS_AUTHENTICODE"
      : request.platform === "linux" ? "LINUX_SIGSTORE" : "MACOS_DEVELOPER_ID",
    signingIdentityDigest: "8".repeat(64),
    signingEvidenceObjectKey: signingEvidenceObjectKey(
      request.tenantId, request.projectId, request.releaseId, request.platform, signingEvidenceDigest,
    ),
    signingEvidenceDigest,
    notarizationEvidenceObjectKey: notaryDigest ? notarizationEvidenceObjectKey(
      request.tenantId, request.projectId, request.releaseId, notaryDigest,
    ) : null,
    notarizationEvidenceDigest: notaryDigest,
  });
}

async function post(
  handler: ReturnType<typeof createSteamDepotFinalizerHandler>,
  path: string,
  body: unknown,
) {
  return handler({
    method: "POST",
    path,
    headers: { "content-type": "application/json" },
    socket: {},
    rawBody: JSON.stringify(body),
  });
}

export { finalizationRequest, receipt };
