import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerEvent } from "../../../lib/domain/e2e";
import type {
  PlatformEvidenceManifest,
  RegisteredRunner,
  RunnerCapabilities,
  RunnerNativeInstallAuthorizationRequest,
  SignedRunnerNativeInstallActivationGrant,
  TlsRunnerIdentity,
} from "../src/contracts";
import { createRunnerIngressHandler, createRunnerIngressHttpsServer, type RunnerIngressOperations } from "../src/ingress-http";

const identity: TlsRunnerIdentity = {
  spiffeId: "spiffe://deviludo.test/e2e-runner/runner-linux-1",
  certificateFingerprint: "a".repeat(64),
  certificateSerial: "serial-1",
  certificateNotAfter: "2031-01-01T00:00:00.000Z",
};
const capabilities = {
  runnerId: "runner-linux-1",
  platform: "linux",
} as unknown as RunnerCapabilities;
const event = {
  attemptId: "44444444-4444-4444-8444-444444444444",
  runnerId: "runner-linux-1",
  platform: "linux",
  fencingToken: 1,
  seqNo: 1,
} as unknown as RunnerEvent;
const manifest = {
  attemptId: event.attemptId,
  runnerId: event.runnerId,
  platform: event.platform,
  fencingToken: 1,
} as unknown as PlatformEvidenceManifest;
const nativeInstallRequest = {
  schemaVersion: "deviludo.runner-native-install-authorization-request.v1",
  operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  currentRunnerId: "runner-linux-1",
  currentCapabilityDigest: "1".repeat(64),
  targetRunnerId: "runner-linux-2",
  targetSpiffeId: "spiffe://deviludo.test/e2e-runner/runner-linux-2",
  targetCapabilityDigest: "2".repeat(64),
  platform: "linux",
  architecture: "x86_64",
  planDigest: "3".repeat(64),
  stagingReceiptDigest: "4".repeat(64),
  releaseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  releaseDigest: `sha256:${"5".repeat(64)}`,
} as const satisfies RunnerNativeInstallAuthorizationRequest;
const nativeInstallGrant = {
  payload: {
    schemaVersion: "deviludo.runner-native-install-activation-grant.v1",
    operationId: nativeInstallRequest.operationId,
    grantSequence: 1,
    currentRunnerId: nativeInstallRequest.currentRunnerId,
    currentSpiffeId: identity.spiffeId,
    currentCapabilityDigest: nativeInstallRequest.currentCapabilityDigest,
    targetRunnerId: nativeInstallRequest.targetRunnerId,
    targetSpiffeId: nativeInstallRequest.targetSpiffeId,
    targetCapabilityDigest: nativeInstallRequest.targetCapabilityDigest,
    platform: nativeInstallRequest.platform,
    architecture: nativeInstallRequest.architecture,
    planDigest: nativeInstallRequest.planDigest,
    stagingReceiptDigest: nativeInstallRequest.stagingReceiptDigest,
    releaseId: nativeInstallRequest.releaseId,
    releaseDigest: nativeInstallRequest.releaseDigest,
    requiredRunnerState: "DRAINING",
    activeLeaseCount: 0,
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:10:00.000Z",
  },
  signature: { algorithm: "Ed25519", keyId: "runner-jobs-01", value: "a".repeat(86) },
} as const satisfies SignedRunnerNativeInstallActivationGrant;

function operations(calls: string[]): RunnerIngressOperations {
  return {
    async register(authoritativeIdentity, runner, at) {
      calls.push(`register:${authoritativeIdentity.spiffeId}:${runner.runnerId}:${at}`);
      return { ...runner, ...authoritativeIdentity, state: "ONLINE", registeredAt: at, lastSeenAt: at } as RegisteredRunner;
    },
    async leaseNext(authoritativeIdentity, runnerId, tenantId, at) {
      calls.push(`lease:${authoritativeIdentity.spiffeId}:${runnerId}:${tenantId}:${at}`);
      return null;
    },
    async submitEvidence(authoritativeIdentity, tenantId, submitted, at) {
      calls.push(`evidence:${authoritativeIdentity.spiffeId}:${tenantId}:${at}`);
      return submitted;
    },
    async acceptEvent(authoritativeIdentity, tenantId, submitted, at) {
      calls.push(`event:${authoritativeIdentity.spiffeId}:${tenantId}:${at}`);
      return {
        accepted: true,
        attemptState: "RUNNING",
        cursor: { lastAcceptedSeqNo: submitted.seqNo, completedPlatforms: {}, terminal: false },
        event: submitted,
        evidenceBundle: null,
      };
    },
    async authorizeNativeInstall(authoritativeIdentity, request, at) {
      calls.push(`native-install:${authoritativeIdentity.spiffeId}:${request.operationId}:${at}`);
      return {
        schemaVersion: "deviludo.runner-native-install-drain-receipt.v1",
        operationId: request.operationId,
        currentRunnerId: request.currentRunnerId,
        planDigest: request.planDigest,
        state: "DRAINING",
        activeLeaseCount: 1,
        observedAt: at,
        retryAfterSeconds: 5,
      };
    },
    async completeNativeInstall(authoritativeIdentity, grant, at) {
      calls.push(`native-complete:${authoritativeIdentity.spiffeId}:${grant.payload.operationId}:${at}`);
      return {
        schemaVersion: "deviludo.runner-native-install-completion-receipt.v1",
        operationId: grant.payload.operationId,
        state: "ACTIVATED",
        currentRunnerId: grant.payload.currentRunnerId,
        targetRunnerId: grant.payload.targetRunnerId,
        targetCapabilityDigest: grant.payload.targetCapabilityDigest,
        planDigest: grant.payload.planDigest,
        releaseId: grant.payload.releaseId,
        releaseDigest: grant.payload.releaseDigest,
        completedAt: at,
      };
    },
    async rollbackNativeInstall(authoritativeIdentity, grant, failureEvidenceDigest, at) {
      calls.push(`native-rollback:${authoritativeIdentity.spiffeId}:${grant.payload.operationId}:${at}`);
      return {
        schemaVersion: "deviludo.runner-native-install-rollback-receipt.v1",
        operationId: grant.payload.operationId,
        state: "ROLLED_BACK",
        currentRunnerId: grant.payload.currentRunnerId,
        rejectedTargetRunnerId: grant.payload.targetRunnerId,
        planDigest: grant.payload.planDigest,
        releaseId: grant.payload.releaseId,
        failureEvidenceDigest,
        rolledBackAt: at,
      };
    },
  };
}

function request(path: string, body: unknown, socket: unknown = { peer: true }) {
  return {
    method: "POST",
    path,
    headers: { "content-type": "application/json", "x-runner-id": "forged-runner" },
    socket,
    rawBody: JSON.stringify(body),
  };
}

test("dedicated Runner handler derives identity from the TLS socket for every operation", async () => {
  const calls: string[] = [];
  const handler = createRunnerIngressHandler({
    operations: operations(calls),
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    extractIdentity(socket) {
      assert.deepEqual(socket, { peer: true });
      return identity;
    },
  });
  assert.equal((await handler(request("/v1/register", { capabilities }))).status, 200);
  assert.equal((await handler(request("/v1/lease", { tenantId: "tenant-1", runnerId: capabilities.runnerId }))).status, 200);
  assert.equal((await handler(request("/v1/evidence", { tenantId: "tenant-1", manifest }))).status, 200);
  assert.equal((await handler(request("/v1/events", { tenantId: "tenant-1", event }))).status, 200);
  assert.equal((await handler(request("/v1/native-install/authorize", { request: nativeInstallRequest }))).status, 200);
  assert.equal((await handler(request("/v1/native-install/complete", { grant: nativeInstallGrant }))).status, 200);
  assert.equal((await handler(request("/v1/native-install/rollback", {
    grant: nativeInstallGrant, failureEvidenceDigest: "f".repeat(64),
  }))).status, 200);
  assert.equal(calls.length, 7);
  assert.ok(calls.every((call) => call.includes(identity.spiffeId)));
  assert.equal(calls.some((call) => call.includes("forged-runner")), false);
});

test("Runner handler requires mTLS and rejects malformed envelopes before storage", async () => {
  const calls: string[] = [];
  const handler = createRunnerIngressHandler({
    operations: operations(calls),
    extractIdentity() { throw new Error("unauthorized"); },
  });
  const unauthorized = await handler(request("/v1/lease", { tenantId: "tenant-1", runnerId: "runner-linux-1" }));
  assert.equal(unauthorized.status, 401);
  assert.equal((unauthorized.body as { error: { code: string } }).error.code, "RUNNER_MTLS_IDENTITY_REQUIRED");
  assert.equal(calls.length, 0);

  const authorized = createRunnerIngressHandler({ operations: operations(calls), extractIdentity: () => identity });
  const extra = await authorized(request("/v1/lease", { tenantId: "tenant-1", runnerId: "runner-linux-1", identity: "forged" }));
  assert.equal(extra.status, 409);
  const invalidJson = await authorized({ ...request("/v1/lease", {}), rawBody: "{" });
  assert.equal(invalidJson.status, 400);
  const wrongType = await authorized({ ...request("/v1/lease", {}), headers: { "content-type": "text/plain" } });
  assert.equal(wrongType.status, 415);
  assert.equal(calls.length, 0);
});

test("Runner handler redacts internal failures and health is also certificate-authenticated", async () => {
  const failing = operations([]);
  failing.leaseNext = async () => { throw new Error("database password and SQL must not escape"); };
  const handler = createRunnerIngressHandler({ operations: failing, extractIdentity: () => identity });
  const response = await handler(request("/v1/lease", { tenantId: "tenant-1", runnerId: "runner-linux-1" }));
  assert.deepEqual(response, { status: 409, body: { error: { code: "RUNNER_REQUEST_REJECTED" } } });
  assert.equal(JSON.stringify(response).includes("password"), false);
  const health = await handler({ method: "GET", path: "/health", headers: {}, socket: {}, rawBody: "" });
  assert.equal(health.status, 200);
});

test("Runner health fails closed when a production dependency is unavailable", async () => {
  const handler = createRunnerIngressHandler({
    operations: operations([]),
    extractIdentity: () => identity,
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    readiness: async () => { throw new Error("DATABASE_URL=secret"); },
  });
  const health = await handler({ method: "GET", path: "/health", headers: {}, socket: {}, rawBody: "" });
  assert.equal(health.status, 503);
  assert.equal((health.body as { error: { code: string } }).error.code, "RUNNER_INGRESS_NOT_READY");
  assert.doesNotMatch(JSON.stringify(health.body), /DATABASE_URL|secret/);
});

test("Runner HTTPS server refuses incomplete TLS material and unsafe body limits", () => {
  const handler = createRunnerIngressHandler({ operations: operations([]), extractIdentity: () => identity });
  assert.throws(() => createRunnerIngressHttpsServer({ tls: {}, handler }), /TLS material is incomplete/);
  assert.throws(() => createRunnerIngressHttpsServer({
    tls: { key: "key", cert: "cert", ca: "ca" }, handler, maxBodyBytes: 32,
  }), /body limit/);
});
