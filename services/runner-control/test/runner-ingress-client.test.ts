import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerEvent } from "../../../lib/domain/e2e";
import type {
  PlatformEvidenceManifest,
  RunnerCapabilities,
  RunnerNativeInstallAuthorizationRequest,
} from "../src/contracts";
import { createRunnerCapabilityDigest } from "../src/coordinator";
import {
  MtlsPhysicalRunnerIngressClient,
  type PhysicalRunnerIngressHttpRequest,
} from "../src/runner-ingress-client";

const now = "2030-01-01T00:00:00.000Z";
const tenantId = "11111111-1111-4111-8111-111111111111";
const sha = (value: string) => value.repeat(64);
const tls = {
  key: Buffer.alloc(64, 1),
  certificate: Buffer.alloc(64, 2),
  ca: Buffer.alloc(64, 3),
};

function capabilities(): RunnerCapabilities {
  const core = {
    runnerId: "runner-linux-1",
    platform: "linux" as const,
    architecture: "x86_64" as const,
    osVersion: "ubuntu-24.04",
    runnerImageDigest: sha("1"),
    godotVersion: "4.6.2-stable",
    godotBinaryDigest: sha("2"),
    exportTemplatesDigest: sha("3"),
    gpu: "virtual-vulkan",
    display: "virtual" as const,
    audio: "virtual" as const,
    installedAutonomousAgents: [] as readonly string[],
    steamClientConnector: null,
  };
  return { ...core, capabilityDigest: createRunnerCapabilityDigest(core) };
}

test("physical Runner client uses the fixed mTLS API paths and carries no identity headers", async () => {
  const calls: { path: string; input: PhysicalRunnerIngressHttpRequest }[] = [];
  const client = new MtlsPhysicalRunnerIngressClient({
    origin: "https://runner-control.internal",
    tls,
    now: () => new Date(now),
    http: async (url, input) => {
      calls.push({ path: url.pathname, input });
      if (url.pathname === "/v1/register") {
        return { statusCode: 200, payload: { data: {
          ...capabilities(),
          spiffeId: "spiffe://deviludo.test/e2e/runner-linux-1",
          certificateFingerprint: sha("a"),
          certificateSerial: "01",
          certificateNotAfter: "2031-01-01T00:00:00.000Z",
          state: "ONLINE",
          registeredAt: now,
          lastSeenAt: now,
        } } };
      }
      if (url.pathname === "/v1/lease") return { statusCode: 200, payload: { data: null } };
      const request = JSON.parse(input.body) as Record<string, unknown>;
      if (url.pathname === "/v1/evidence") return { statusCode: 200, payload: { data: request.manifest } };
      if (url.pathname === "/v1/native-install/authorize") {
        const authorization = request.request as RunnerNativeInstallAuthorizationRequest;
        return { statusCode: 200, payload: { data: {
          schemaVersion: "deviludo.runner-native-install-drain-receipt.v1",
          operationId: authorization.operationId,
          currentRunnerId: authorization.currentRunnerId,
          planDigest: authorization.planDigest,
          state: "DRAINING",
          activeLeaseCount: 1,
          observedAt: now,
          retryAfterSeconds: 5,
        } } };
      }
      return { statusCode: 200, payload: { data: request.event } };
    },
  });

  const registered = await client.register(capabilities());
  assert.equal(registered.state, "ONLINE");
  assert.equal(await client.leaseNext(capabilities().runnerId, tenantId), null);
  const manifest = { attemptId: "attempt-1" } as unknown as PlatformEvidenceManifest;
  assert.equal((await client.submitEvidence(tenantId, manifest)).attemptId, "attempt-1");
  const event = { attemptId: "attempt-1" } as unknown as RunnerEvent;
  assert.equal((await client.acceptEvent(tenantId, event) as unknown as { attemptId: string }).attemptId, "attempt-1");
  const nativeRequest: RunnerNativeInstallAuthorizationRequest = {
    schemaVersion: "deviludo.runner-native-install-authorization-request.v1",
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    currentRunnerId: "runner-linux-1",
    currentCapabilityDigest: capabilities().capabilityDigest,
    targetRunnerId: "runner-linux-2",
    targetSpiffeId: "spiffe://deviludo.test/e2e/runner-linux-2",
    targetCapabilityDigest: sha("b"),
    platform: "linux",
    architecture: "x86_64",
    planDigest: sha("c"),
    stagingReceiptDigest: sha("d"),
    releaseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    releaseDigest: `sha256:${sha("e")}`,
  };
  const draining = await client.authorizeNativeInstall(nativeRequest);
  assert.equal("state" in draining ? draining.state : null, "DRAINING");
  assert.deepEqual(calls.map((call) => call.path), [
    "/v1/register", "/v1/lease", "/v1/evidence", "/v1/events", "/v1/native-install/authorize",
  ]);
  assert.ok(calls.every((call) => call.input.method === "POST"
    && call.input.tls.key === tls.key && call.input.tls.certificate === tls.certificate && call.input.tls.ca === tls.ca));
  assert.ok(calls.every((call) => !Object.keys(call.input.headers).some((name) => /runner|spiffe|identity/i.test(name))));
});

test("physical Runner client rejects response envelope drift and unsafe origins", async () => {
  const client = new MtlsPhysicalRunnerIngressClient({
    origin: "https://runner-control.internal",
    tls,
    http: async () => ({ statusCode: 200, payload: { data: null, identity: "forged" } }),
  });
  await assert.rejects(client.leaseNext("runner-linux-1", tenantId), /response fields are invalid/);
  for (const origin of [
    "http://runner-control.internal",
    "https://user:secret@runner-control.internal",
    "https://runner-control.internal/v1/lease",
    "https://runner-control.internal/?token=secret",
  ]) {
    assert.throws(() => new MtlsPhysicalRunnerIngressClient({ origin, tls }), /origin is invalid/);
  }
});

test("physical Runner client readiness requires the exact authenticated ingress identity", async () => {
  const client = new MtlsPhysicalRunnerIngressClient({
    origin: "https://runner-control.internal",
    tls,
    http: async (url, input) => {
      assert.equal(url.pathname, "/health");
      assert.equal(input.method, "GET");
      return { statusCode: 200, payload: { status: "ok", service: "deviludo-runner-ingress" } };
    },
  });
  await client.probe();
});
