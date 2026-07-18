import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { RegisteredRunner, RunnerCapabilities, TlsRunnerIdentity } from "../src/contracts";
import { createRunnerCapabilityDigest } from "../src/coordinator";
import {
  SignedRunnerFleetPolicy,
  signRunnerFleetManifest,
  type RunnerFleetClaims,
  type RunnerFleetManifestLoader,
} from "../src/fleet-manifest";

const tenantId = "11111111-1111-4111-8111-111111111111";
const otherTenantId = "22222222-2222-4222-8222-222222222222";
const at = new Date("2030-01-01T00:05:00.000Z");
const sha = (value: string) => value.repeat(64);
const keys = generateKeyPairSync("ed25519");

function identity(): TlsRunnerIdentity {
  return {
    spiffeId: "spiffe://deviludo.test/e2e-runner/runner-linux-1",
    certificateFingerprint: sha("a"),
    certificateSerial: "01ab",
    certificateNotAfter: "2031-01-01T00:00:00.000Z",
  };
}

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

function claims(overrides: Partial<RunnerFleetClaims> = {}): RunnerFleetClaims {
  return {
    kind: "deviludo-runner-fleet",
    version: 1,
    revision: 7,
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:10:00.000Z",
    runners: [{
      runnerId: capabilities().runnerId,
      spiffeId: identity().spiffeId,
      certificateFingerprint: identity().certificateFingerprint,
      capabilityDigest: capabilities().capabilityDigest,
      platform: "linux",
      tenantIds: [tenantId, otherTenantId],
      steamClientConnectorIdentity: {
        spiffeId: "spiffe://deviludo.test/steam-connector/runner-linux-1",
        certificateFingerprint: sha("c"),
      },
    }],
    ...overrides,
  };
}

class MutableLoader implements RunnerFleetManifestLoader {
  constructor(public value: unknown) {}
  async load(): Promise<unknown> { return this.value; }
}

function registered(): RegisteredRunner {
  return {
    ...capabilities(),
    ...identity(),
    state: "ONLINE",
    registeredAt: "2030-01-01T00:00:00.000Z",
    lastSeenAt: "2030-01-01T00:04:00.000Z",
  };
}

test("signed fleet policy binds TLS identity, immutable capabilities and tenant assignment", async () => {
  const envelope = signRunnerFleetManifest("runner-fleet-key-01", keys.privateKey, claims());
  const policy = new SignedRunnerFleetPolicy(
    { async load() { return envelope; } },
    new Map([["runner-fleet-key-01", keys.publicKey]]),
    () => at,
  );

  assert.equal(await policy.authorize({ identity: identity(), capabilities: capabilities() }), true);
  assert.equal(await policy.authorize({ identity: identity(), runner: registered(), tenantId }), true);
  assert.equal(await policy.authorize({ identity: identity(), runner: registered(), tenantId: "33333333-3333-4333-8333-333333333333" }), false);
  assert.equal(await policy.authorize({
    identity: { ...identity(), certificateFingerprint: sha("b") },
    capabilities: capabilities(),
  }), false);
  await policy.probe();
});

test("fleet policy reloads each decision and rejects tampering, expiry and unknown signing keys", async () => {
  const valid = signRunnerFleetManifest("runner-fleet-key-01", keys.privateKey, claims());
  const loader = new MutableLoader(valid);
  const policy = new SignedRunnerFleetPolicy(loader, new Map([["runner-fleet-key-01", keys.publicKey]]), () => at);
  assert.equal(await policy.authorize({ identity: identity(), capabilities: capabilities() }), true);

  loader.value = { ...valid, claims: { ...valid.claims, revision: 8 } };
  await assert.rejects(policy.probe(), /signature is invalid/);

  loader.value = signRunnerFleetManifest("runner-fleet-key-01", keys.privateKey, claims({
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:04:59.999Z",
  }));
  await assert.rejects(policy.probe(), /manifest is invalid/);

  loader.value = valid;
  const unknown = new SignedRunnerFleetPolicy(loader, new Map([["other-runner-key", keys.publicKey]]), () => at);
  await assert.rejects(unknown.probe(), /signature is invalid/);
});

test("fleet policy authorizes an exact signed-job identity tuple for secondary Runner services", async () => {
  const manifest = signRunnerFleetManifest("fleet-key-1", keys.privateKey, claims());
  const policy = new SignedRunnerFleetPolicy({ load: async () => manifest }, new Map([["fleet-key-1", keys.publicKey]]), () => at);
  const runnerIdentity = identity();
  const runnerCapabilities = capabilities();
  assert.equal(await policy.authorizeJob({
    identity: runnerIdentity,
    runnerId: runnerCapabilities.runnerId,
    platform: runnerCapabilities.platform,
    capabilityDigest: runnerCapabilities.capabilityDigest,
    tenantId,
  }), true);
  assert.equal(await policy.authorizeJob({
    identity: {
      ...runnerIdentity,
      spiffeId: "spiffe://deviludo.test/steam-connector/runner-linux-1",
      certificateFingerprint: sha("c"),
    },
    runnerId: runnerCapabilities.runnerId,
    platform: runnerCapabilities.platform,
    capabilityDigest: runnerCapabilities.capabilityDigest,
    tenantId,
    workload: "steam-client-connector",
  }), true);
  assert.equal(await policy.authorizeJob({
    identity: runnerIdentity,
    runnerId: runnerCapabilities.runnerId,
    platform: runnerCapabilities.platform,
    capabilityDigest: runnerCapabilities.capabilityDigest,
    tenantId,
    workload: "steam-client-connector",
  }), false);
  assert.equal(await policy.authorizeJob({
    identity: runnerIdentity,
    runnerId: runnerCapabilities.runnerId,
    platform: "windows",
    capabilityDigest: runnerCapabilities.capabilityDigest,
    tenantId,
  }), false);
  assert.equal(await policy.authorizeJob({
    identity: { ...runnerIdentity, certificateFingerprint: sha("f") },
    runnerId: runnerCapabilities.runnerId,
    platform: runnerCapabilities.platform,
    capabilityDigest: runnerCapabilities.capabilityDigest,
    tenantId,
  }), false);
});

test("fleet claims are strict, ordered and use exact non-floating bindings", () => {
  assert.throws(() => signRunnerFleetManifest("runner-fleet-key-01", keys.privateKey, claims({
    runners: [...claims().runners, claims().runners[0]!],
  })), /manifest is invalid/);
  assert.throws(() => signRunnerFleetManifest("runner-fleet-key-01", keys.privateKey, claims({
    runners: [{ ...claims().runners[0]!, tenantIds: [otherTenantId, tenantId] }],
  })), /manifest is invalid/);
  assert.throws(() => signRunnerFleetManifest("runner-fleet-key-01", keys.privateKey, {
    ...claims(),
    extra: "not-allowed",
  } as RunnerFleetClaims), /manifest is invalid/);
  assert.throws(() => signRunnerFleetManifest("runner-fleet-key-01", keys.privateKey, claims({
    expiresAt: "2030-01-01T00:15:00.001Z",
  })), /manifest is invalid/);
  assert.throws(() => signRunnerFleetManifest("runner-fleet-key-01", keys.privateKey, claims({
    runners: [{
      ...claims().runners[0]!,
      steamClientConnectorIdentity: {
        spiffeId: identity().spiffeId,
        certificateFingerprint: identity().certificateFingerprint,
      },
    }],
  })), /manifest is invalid/);
});
