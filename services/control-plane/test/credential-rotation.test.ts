import assert from "node:assert/strict";
import test from "node:test";
import { AdminService } from "../src/admin.service";
import { InMemoryAdminStore } from "../src/admin.store";
import { DevelopmentAgentSupplyChain } from "../src/agent-supply-chain";
import { ServiceProblem, type RequestActor } from "../src/contracts";
import { InferenceGatewayReconciliationClient } from "../src/inference-reconciliation";
import { ProviderProbe } from "../src/provider-probe";
import { ProcessIsolatedSecretVault } from "../src/secret-vault";

class FailingRotationProbe extends ProviderProbe {
  async run(): Promise<Readonly<Record<string, "PASS" | "FAIL">>> {
    throw new ServiceProblem(409, "PROVIDER_PROBE_FAILED", "replacement key was rejected");
  }
}

class PassingRotationProbe extends ProviderProbe {
  async run(): Promise<Readonly<Record<string, "PASS">>> {
    return Object.freeze({
      authentication: "PASS",
      modelExistence: "PASS",
      streaming: "PASS",
      toolCalling: "PASS",
      cancellation: "PASS",
      usage: "PASS",
      timeout: "PASS",
      minimalReasoning: "PASS",
      dnsPinning: "PASS",
      redirectRevalidation: "PASS",
    });
  }
}

const actor: RequestActor = Object.freeze({
  role: "SecurityAdmin",
  requestId: "request-credential-rotation-failure",
  actorId: "security-admin",
  tenantId: null,
  projectId: null,
});

test("failed key rotation preserves the active default and makes staged successors unusable", async () => {
  const store = new InMemoryAdminStore();
  const service = new AdminService(
    store,
    new ProcessIsolatedSecretVault(),
    new FailingRotationProbe(),
    new DevelopmentAgentSupplyChain(),
    new InferenceGatewayReconciliationClient(),
  );
  await assert.rejects(
    service.rotateCredential("credential-platform-claude-v1", { apiKey: "replacement-key-rejected-by-probe" }, actor),
    (error: unknown) => error instanceof ServiceProblem && error.code === "PROVIDER_PROBE_FAILED",
  );

  const result = await store.read((state) => ({
    defaultProfileId: state.defaults.get("platform"),
    oldCredential: structuredClone(state.credentials.get("credential-platform-claude-v1")),
    oldProfile: structuredClone(state.profiles.get("profile-platform-claude-r1")),
    oldProvider: structuredClone(state.providers.get("provider-platform-claude-r1")),
    replacement: [...state.credentials.values()].find((credential) => credential.familyId === "credential-platform-claude"
      && credential.id !== "credential-platform-claude-v1"),
    successorProfiles: [...state.profiles.values()].filter((profile) => profile.id.startsWith("profile-credential-rotation-")),
    successorProviders: [...state.providers.values()].filter((provider) => provider.id.startsWith("provider-credential-rotation-")),
    failureAudit: state.audit.find((record) => record.action === "CREDENTIAL_ROTATION_FAILED"),
  }));
  assert.equal(result.defaultProfileId, "profile-platform-claude-r1");
  assert.equal(result.oldCredential?.state, "ACTIVE");
  assert.equal(result.oldProfile?.state, "ACTIVE");
  assert.equal(result.oldProvider?.state, "ACTIVE");
  assert.equal(result.replacement?.state, "REVOKED");
  assert.deepEqual(result.successorProfiles.map((profile) => profile.state), ["DEGRADED"]);
  assert.deepEqual(result.successorProviders.map((provider) => provider.state), ["DEGRADED"]);
  assert.equal(result.failureAudit?.metadata.priorActiveConfigurationPreserved, true);
});

test("successful key rotation atomically rebinds every default sharing the active Provider", async () => {
  const store = new InMemoryAdminStore();
  await store.mutate((state) => {
    const platform = state.profiles.get("profile-platform-claude-r1");
    assert.ok(platform);
    state.profiles.set("profile-tenant-claude-r1", {
      ...platform,
      id: "profile-tenant-claude-r1",
      scope: "tenant",
      scopeId: "tenant-north-dock",
      fallbackProfileRevisionId: platform.id,
    });
    state.defaults.set("tenant:tenant-north-dock", "profile-tenant-claude-r1");
  });
  const service = new AdminService(
    store,
    new ProcessIsolatedSecretVault(),
    new PassingRotationProbe(),
    new DevelopmentAgentSupplyChain(),
    new InferenceGatewayReconciliationClient(),
  );

  const result = await service.rotateCredential(
    "credential-platform-claude-v1",
    { apiKey: "replacement-key-accepted-by-probe" },
    actor,
  );
  const successorIds = result.successorProfileRevisionIds as readonly string[];
  assert.equal(successorIds.length, 2);

  const catalog = await store.read((state) => ({
    platformDefault: state.defaults.get("platform"),
    tenantDefault: state.defaults.get("tenant:tenant-north-dock"),
    oldCredential: structuredClone(state.credentials.get("credential-platform-claude-v1")),
    oldProfiles: ["profile-platform-claude-r1", "profile-tenant-claude-r1"]
      .map((id) => structuredClone(state.profiles.get(id))),
    successors: successorIds.map((id) => structuredClone(state.profiles.get(id))),
    oldProvider: structuredClone(state.providers.get("provider-platform-claude-r1")),
    successorProviders: [...state.providers.values()].filter((provider) => provider.id.startsWith("provider-credential-rotation-")),
  }));
  const platformSuccessor = catalog.successors.find((profile) => profile?.scope === "platform");
  const tenantSuccessor = catalog.successors.find((profile) => profile?.scope === "tenant");
  assert.equal(catalog.platformDefault, platformSuccessor?.id);
  assert.equal(catalog.tenantDefault, tenantSuccessor?.id);
  assert.equal(tenantSuccessor?.fallbackProfileRevisionId, platformSuccessor?.id);
  assert.equal(catalog.oldCredential?.state, "PREVIOUS");
  assert.deepEqual(catalog.oldProfiles.map((profile) => profile?.state), ["SUPERSEDED", "SUPERSEDED"]);
  assert.deepEqual(catalog.successors.map((profile) => profile?.state), ["ACTIVE", "ACTIVE"]);
  assert.equal(catalog.oldProvider?.state, "SUPERSEDED");
  assert.equal(catalog.successorProviders.length, 1);
  assert.equal(catalog.successorProviders[0]?.state, "ACTIVE");
});
