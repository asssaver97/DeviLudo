import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { sha256Canonical, signCanonical } from "../../runner-control/src/canonical";
import { MtlsSteamDepotFinalizerHostActivationClient } from "../src/host-activation-client";
import {
  createSteamDepotFinalizerHostActivationGrantPayload,
  validateSteamDepotFinalizerHostActivationRequest,
} from "../src/host-activation";

const keys = generateKeyPairSync("ed25519");
const keyId = "steam-finalizer-host-activation-key-2026-01";
const now = new Date("2026-07-26T00:00:00.000Z");

test("host activation client binds drain and signed grant responses to one request", async () => {
  let draining = true;
  const paths: string[] = [];
  const client = clientWith(async (input) => {
    paths.push(input.url.pathname);
    const request = JSON.parse(input.body);
    const data = draining ? {
      schemaVersion: "deviludo.steam-depot-finalizer-host-drain-receipt.v1",
      operationId: request.operationId,
      hostId: request.hostId,
      state: "DRAINING",
      activeOperationCount: 2,
      observedAt: now.toISOString(),
      retryAfterSeconds: 5,
    } : grant(request);
    return { statusCode: 200, payload: {
      schemaVersion: "deviludo.steam-depot-finalizer-host-activation-response.v1", data,
    } };
  });
  const first = await client.authorize(request(), now);
  assert.equal(first.schemaVersion, "deviludo.steam-depot-finalizer-host-drain-receipt.v1");
  draining = false;
  const second = await client.authorize(request(), now);
  assert.equal(second.schemaVersion, "deviludo.steam-depot-finalizer-host-activation-grant.v1");
  assert.equal("payload" in second ? second.payload.hostSpiffeId : "", request().hostSpiffeId);
  assert.deepEqual(paths, [
    "/v1/steam-depot-finalizer-host-activations/authorize",
    "/v1/steam-depot-finalizer-host-activations/authorize",
  ]);
});

test("host activation client posts one exact receipt and verifies the stored replay", async () => {
  const signed = grant(request());
  const receipt = actuationReceipt(signed);
  let observed: unknown;
  const client = clientWith(async (input) => {
    observed = JSON.parse(input.body);
    return { statusCode: 200, payload: {
      schemaVersion: "deviludo.steam-depot-finalizer-host-activation-completion-response.v1",
      data: receipt,
    } };
  });
  assert.deepEqual(await client.complete(signed, receipt, new Date(receipt.completedAt)), receipt);
  assert.deepEqual(observed, {
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-completion.v1",
    grant: signed,
    receipt,
  });
});

test("host activation client uses fixed routes and fails closed on response drift", async () => {
  const paths: string[] = [];
  const client = clientWith(async (input) => {
    paths.push(input.url.pathname);
    if (input.url.pathname === "/healthz") return { statusCode: 200, payload: {
      schemaVersion: "deviludo.steam-depot-finalizer-host-activation-health.v1",
      status: "ok", service: "deviludo-steam-depot-finalizer-host-activation",
    } };
    return { statusCode: 200, payload: {
      schemaVersion: "deviludo.steam-depot-finalizer-host-activation-response.v1",
      data: { ...grant(request()), unexpected: true },
    } };
  });
  await client.probe();
  await assert.rejects(client.authorize(request(), now), /authority response is invalid|grant envelope is invalid/);
  assert.deepEqual(paths, ["/healthz", "/v1/steam-depot-finalizer-host-activations/authorize"]);
  assert.throws(() => clientWith(async () => ({ statusCode: 500, payload: {} }), "http://authority.internal/"),
    /configuration is invalid/);
});

test("host activation contracts validate receipt paths for the target OS, not the authority OS", () => {
  assert.equal(validateSteamDepotFinalizerHostActivationRequest({
    ...request(),
    hostId: "steam-finalizer-windows-01",
    platform: "windows",
    receiptPath: "C:\\ProgramData\\DeviLudo\\NativeActuator\\activation-receipt.json",
  }).platform, "windows");
  assert.throws(() => validateSteamDepotFinalizerHostActivationRequest({
    ...request(), platform: "windows", receiptPath: "/var/lib/deviludo/receipt.json",
  }), /request is invalid/);
});

function clientWith(http: ConstructorParameters<typeof MtlsSteamDepotFinalizerHostActivationClient>[0]["http"],
  endpoint = "https://host-activation-authority.internal/") {
  return new MtlsSteamDepotFinalizerHostActivationClient({
    endpoint, keyId, publicKey: keys.publicKey,
    tls: { key: Buffer.alloc(64), certificate: Buffer.alloc(64), ca: Buffer.alloc(64) }, http,
  });
}

function request() {
  return {
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-request.v1" as const,
    operationId: "00000000-0000-4000-8000-000000000099",
    hostId: "steam-finalizer-linux-01",
    hostSpiffeId: "spiffe://deviludo.internal/steam-depot-finalizer/linux-01",
    hostCertificateFingerprint: "9".repeat(64),
    planDigest: "1".repeat(64), transactionDigest: "2".repeat(64), stagingReceiptDigest: "3".repeat(64),
    releaseId: "00000000-0000-4000-8000-000000000001",
    serviceReleaseDigest: "4".repeat(64), nativeReleaseDigest: "5".repeat(64),
    platform: "linux" as const, architecture: "x86_64" as const, operationState: "INITIALIZING" as const,
    previousPlanDigest: null, previousDefinitionDigest: null, definitionDigest: "6".repeat(64),
    receiptPath: "/var/lib/deviludo/steam-depot-finalizer/activation-receipt.json",
  };
}

function grant(activationRequest: ReturnType<typeof request>) {
  const payload = createSteamDepotFinalizerHostActivationGrantPayload({
    request: activationRequest,
    grantSequence: 1,
    issuedAt: now.toISOString(),
    expiresAt: "2026-07-26T00:10:00.000Z",
  });
  return Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-grant.v1" as const,
    algorithm: "Ed25519" as const,
    keyId,
    payload,
    signature: signCanonical(keys.privateKey, payload),
  });
}

function actuationReceipt(signed: ReturnType<typeof grant>) {
  const payload = signed.payload;
  const core = {
    schemaVersion: "deviludo.steam-depot-finalizer-host-actuation-receipt.v1" as const,
    state: "ACTIVATED" as const,
    operationId: payload.operationId,
    grantSequence: payload.grantSequence,
    hostId: payload.hostId,
    hostSpiffeId: payload.hostSpiffeId,
    hostCertificateFingerprint: payload.hostCertificateFingerprint,
    transactionDigest: payload.transactionDigest,
    planDigest: payload.planDigest,
    stagingReceiptDigest: payload.stagingReceiptDigest,
    releaseId: payload.releaseId,
    platform: payload.platform,
    architecture: payload.architecture,
    previousDefinitionDigest: payload.previousDefinitionDigest,
    failureDigest: null,
    completedAt: "2026-07-26T00:01:00.000Z",
  };
  return Object.freeze({ ...core, receiptDigest: sha256Canonical(core) });
}
