import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresSteamDepotFinalizerHostActivations } from "../src/postgres-host-activations";
import {
  createSteamDepotFinalizerHostActivationHandler,
  createSteamDepotFinalizerHostActivationHttpsServer,
  type SteamDepotFinalizerHostActivationHttpRequest,
} from "../src/host-activation-ingress";

const identity = Object.freeze({
  spiffeId: "spiffe://deviludo.internal/steam-depot-finalizer/linux-01",
  certificateFingerprint: "9".repeat(64),
});

test("host activation ingress authorizes only the mTLS-bound host request", async () => {
  const calls: unknown[] = [];
  const authority = {
    async authorize(receivedIdentity: unknown, request: unknown) {
      calls.push({ receivedIdentity, request });
      return {
        schemaVersion: "deviludo.steam-depot-finalizer-host-drain-receipt.v1" as const,
        operationId: activationRequest().operationId,
        hostId: activationRequest().hostId,
        state: "DRAINING" as const,
        activeOperationCount: 1,
        observedAt: "2026-07-26T00:00:00.000Z",
        retryAfterSeconds: 5,
      };
    },
    async complete() { throw new Error("not called"); },
    async probe() {},
  } satisfies Pick<PostgresSteamDepotFinalizerHostActivations, "authorize" | "complete" | "probe">;
  const handler = createSteamDepotFinalizerHostActivationHandler({
    authority,
    allowedHostSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => identity,
  });
  const response = await handler(request("POST", "/v1/steam-depot-finalizer-host-activations/authorize",
    activationRequest(), { "x-deviludo-spiffe-id": "spiffe://attacker.invalid/forged" }));
  assert.equal(response.status, 200);
  assert.equal((response.body.data as { state: string }).state, "DRAINING");
  assert.deepEqual(calls[0], { receivedIdentity: identity, request: activationRequest() });

  const mismatch = await handler(request("POST", "/v1/steam-depot-finalizer-host-activations/authorize",
    { ...activationRequest(), hostCertificateFingerprint: "8".repeat(64) }));
  assert.deepEqual(mismatch, failure(403, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_IDENTITY_MISMATCH"));
  assert.equal(calls.length, 1);
});

test("host activation ingress accepts one exact completion envelope and delegates identity", async () => {
  const calls: unknown[] = [];
  const receipt = Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalizer-host-actuation-receipt.v1" as const,
    state: "ACTIVATED" as const,
    operationId: activationRequest().operationId,
    grantSequence: 1,
    hostId: activationRequest().hostId,
    hostSpiffeId: identity.spiffeId,
    hostCertificateFingerprint: identity.certificateFingerprint,
    transactionDigest: "2".repeat(64), planDigest: "1".repeat(64), stagingReceiptDigest: "3".repeat(64),
    releaseId: activationRequest().releaseId, platform: "linux" as const, architecture: "x86_64" as const,
    previousDefinitionDigest: null, failureDigest: null,
    completedAt: "2026-07-26T00:01:00.000Z", receiptDigest: "7".repeat(64),
  });
  const authority = {
    async authorize() { throw new Error("not called"); },
    async complete(receivedIdentity: unknown, grant: unknown, receivedReceipt: unknown) {
      calls.push({ receivedIdentity, grant, receivedReceipt }); return receipt;
    },
    async probe() {},
  } satisfies Pick<PostgresSteamDepotFinalizerHostActivations, "authorize" | "complete" | "probe">;
  const handler = createSteamDepotFinalizerHostActivationHandler({
    authority, allowedHostSpiffeIds: new Set([identity.spiffeId]), extractIdentity: () => identity,
  });
  const grant = { schemaVersion: "grant-for-delegation-test" };
  const response = await handler(request("POST", "/v1/steam-depot-finalizer-host-activations/complete", {
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-completion.v1",
    grant,
    receipt,
  }));
  assert.deepEqual(response, { status: 200, body: {
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-completion-response.v1",
    data: receipt,
  } });
  assert.deepEqual(calls, [{ receivedIdentity: identity, grant, receivedReceipt: receipt }]);

  const extra = await handler(request("POST", "/v1/steam-depot-finalizer-host-activations/complete", {
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-completion.v1", grant, receipt, hostId: "forged",
  }));
  assert.deepEqual(extra, failure(400, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_REQUEST_INVALID"));
});

test("host activation ingress health is authenticated and fail-closed", async () => {
  let ready = true;
  const authority = {
    async authorize() { throw new Error("not called"); },
    async complete() { throw new Error("not called"); },
    async probe() { if (!ready) throw new Error("database unavailable"); },
  } satisfies Pick<PostgresSteamDepotFinalizerHostActivations, "authorize" | "complete" | "probe">;
  const handler = createSteamDepotFinalizerHostActivationHandler({
    authority, allowedHostSpiffeIds: new Set([identity.spiffeId]), extractIdentity: () => identity,
  });
  const healthy = await handler(request("GET", "/healthz"));
  assert.equal(healthy.status, 200);
  ready = false;
  assert.deepEqual(await handler(request("GET", "/healthz")),
    failure(503, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_NOT_READY"));

  const unauthenticated = createSteamDepotFinalizerHostActivationHandler({
    authority, allowedHostSpiffeIds: new Set([identity.spiffeId]), extractIdentity: () => { throw new Error("no cert"); },
  });
  assert.deepEqual(await unauthenticated(request("GET", "/healthz")),
    failure(401, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_MTLS_IDENTITY_REQUIRED"));
  const forbidden = createSteamDepotFinalizerHostActivationHandler({
    authority, allowedHostSpiffeIds: new Set(["spiffe://deviludo.internal/another-host"]),
    extractIdentity: () => identity,
  });
  assert.deepEqual(await forbidden(request("GET", "/healthz")),
    failure(403, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_HOST_FORBIDDEN"));
});

test("host activation HTTPS server requires complete TLS material and bounded bodies", () => {
  const handler = async () => ({ status: 200, body: {} });
  assert.throws(() => createSteamDepotFinalizerHostActivationHttpsServer({
    tls: { key: Buffer.alloc(0), cert: Buffer.alloc(32), ca: Buffer.alloc(32) }, handler,
  }), /configuration is invalid/);
  assert.throws(() => createSteamDepotFinalizerHostActivationHttpsServer({
    tls: { key: Buffer.alloc(32), cert: Buffer.alloc(32), ca: Buffer.alloc(32) }, handler, maxBodyBytes: 1,
  }), /configuration is invalid/);
});

function activationRequest() {
  return {
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-request.v1" as const,
    operationId: "00000000-0000-4000-8000-000000000099",
    hostId: "steam-finalizer-linux-01",
    hostSpiffeId: identity.spiffeId,
    hostCertificateFingerprint: identity.certificateFingerprint,
    planDigest: "1".repeat(64), transactionDigest: "2".repeat(64), stagingReceiptDigest: "3".repeat(64),
    releaseId: "00000000-0000-4000-8000-000000000001",
    serviceReleaseDigest: "4".repeat(64), nativeReleaseDigest: "5".repeat(64),
    platform: "linux" as const, architecture: "x86_64" as const, operationState: "INITIALIZING" as const,
    previousPlanDigest: null, previousDefinitionDigest: null, definitionDigest: "6".repeat(64),
    receiptPath: "/var/lib/deviludo/steam-depot-finalizer/activation-receipt.json",
  };
}

function request(
  method: string,
  path: string,
  body?: unknown,
  additionalHeaders: Readonly<Record<string, string>> = {},
): SteamDepotFinalizerHostActivationHttpRequest {
  return {
    method, path, socket: {},
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...additionalHeaders },
    rawBody: body === undefined ? "" : JSON.stringify(body),
  };
}
function failure(status: number, code: string) { return { status, body: { error: { code } } }; }
