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
    return passingChecks();
  }
}

class DeferredRotationProbe extends ProviderProbe {
  readonly started: Promise<void>;
  readonly #result: Promise<Readonly<Record<string, "PASS">>>;
  #announce!: () => void;
  #complete!: (value: Readonly<Record<string, "PASS">>) => void;

  constructor() {
    super();
    this.started = new Promise((resolve) => { this.#announce = resolve; });
    this.#result = new Promise((resolve) => { this.#complete = resolve; });
  }

  async run(): Promise<Readonly<Record<string, "PASS">>> {
    this.#announce();
    return this.#result;
  }

  pass(): void { this.#complete(passingChecks()); }
}

function passingChecks(): Readonly<Record<string, "PASS">> {
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

const actor: RequestActor = Object.freeze({
  role: "SecurityAdmin",
  requestId: "request-credential-rotation-failure",
  actorId: "security-admin",
  tenantId: null,
  projectId: null,
});

test("failed key rotation preserves the active default and makes staged successors unusable", async () => {
  const store = new InMemoryAdminStore();
  await store.mutate((state) => {
    const currentCredential = state.credentials.get("credential-platform-claude-v1");
    const currentProvider = state.providers.get("provider-platform-claude-r1");
    const currentProfile = state.profiles.get("profile-platform-claude-r1");
    assert.ok(currentCredential); assert.ok(currentProvider); assert.ok(currentProfile);
    state.credentials.set("credential-platform-fallback-v1", {
      ...currentCredential,
      id: "credential-platform-fallback-v1",
      familyId: "credential-platform-fallback",
      secretRef: "vault://kv/data/deviludo/platform/fallback?version=1",
      maskedFingerprint: "sha256:fallback…000001",
    });
    state.providers.set("provider-platform-fallback-r1", {
      ...currentProvider,
      id: "provider-platform-fallback-r1",
      credentialVersionId: "credential-platform-fallback-v1",
    });
    state.profiles.set("profile-project-fallback-r1", {
      ...currentProfile,
      id: "profile-project-fallback-r1",
      scope: "project",
      scopeId: "project-fallback",
      providerRevisionId: "provider-platform-fallback-r1",
      credentialVersionId: "credential-platform-fallback-v1",
      fallbackProfileRevisionId: currentProfile.id,
    });
    state.defaults.set("project:project-fallback", "profile-project-fallback-r1");
  });
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
    dependentProfile: structuredClone(state.profiles.get("profile-project-fallback-r1")),
    dependentDefault: state.defaults.get("project:project-fallback"),
    dependentProvider: structuredClone(state.providers.get("provider-platform-fallback-r1")),
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
  assert.equal(result.dependentProfile?.state, "ACTIVE");
  assert.equal(result.dependentDefault, "profile-project-fallback-r1");
  assert.equal(result.dependentProvider?.state, "ACTIVE");
  assert.equal(result.replacement?.state, "REVOKED");
  assert.deepEqual(result.successorProfiles.map((profile) => profile.state), ["DEGRADED", "DEGRADED"]);
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
  assert.ok(Number.isFinite(Date.parse(catalog.oldCredential?.rotatedAt ?? "")));
  const activeCredential = result.active as { rotatedAt: string | null };
  assert.equal(catalog.oldCredential?.rotatedAt, activeCredential.rotatedAt);
  assert.deepEqual(catalog.oldProfiles.map((profile) => profile?.state), ["SUPERSEDED", "SUPERSEDED"]);
  assert.deepEqual(catalog.successors.map((profile) => profile?.state), ["ACTIVE", "ACTIVE"]);
  assert.equal(catalog.oldProvider?.state, "SUPERSEDED");
  assert.equal(catalog.successorProviders.length, 1);
  assert.equal(catalog.successorProviders[0]?.state, "ACTIVE");
});

test("an interrupted rotation resumes the same Vault version and immutable successors", async () => {
  const store = new InMemoryAdminStore();
  const vault = new ProcessIsolatedSecretVault();
  const deferredProbe = new DeferredRotationProbe();
  const recoveryActor: RequestActor = Object.freeze({
    ...actor,
    requestId: "request-credential-rotation-recovery",
    mutation: Object.freeze({
      identityDigest: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      claimToken: "11111111-1111-4111-8111-111111111111",
    }),
  });
  const interruptedService = new AdminService(
    store,
    vault,
    deferredProbe,
    new DevelopmentAgentSupplyChain(),
    new InferenceGatewayReconciliationClient(),
  );
  const interrupted = interruptedService.rotateCredential(
    "credential-platform-claude-v1",
    { apiKey: "replacement-key-survives-process-restart" },
    recoveryActor,
  );
  await deferredProbe.started;

  const staged = await store.read((state) => ({
    credentialIds: [...state.credentials.keys()],
    successorProfileIds: [...state.profiles.values()]
      .filter((profile) => profile.id.startsWith("profile-credential-rotation-"))
      .map((profile) => profile.id),
    successorProviderIds: [...state.providers.values()]
      .filter((provider) => provider.id.startsWith("provider-credential-rotation-"))
      .map((provider) => provider.id),
  }));
  assert.equal(staged.credentialIds.length, 2);
  assert.equal(staged.successorProfileIds.length, 1);
  assert.equal(staged.successorProviderIds.length, 1);

  const recoveringService = new AdminService(
    store,
    vault,
    new PassingRotationProbe(),
    new DevelopmentAgentSupplyChain(),
    new InferenceGatewayReconciliationClient(),
  );
  await assert.rejects(
    recoveringService.rotateCredential(
      "credential-platform-claude-v1",
      { apiKey: "a-different-concurrent-operation" },
      Object.freeze({
        ...recoveryActor,
        mutation: Object.freeze({
          ...recoveryActor.mutation!,
          identityDigest: "c".repeat(64),
          requestFingerprint: "d".repeat(64),
        }),
      }),
    ),
    (error: unknown) => error instanceof ServiceProblem && error.code === "CREDENTIAL_ROTATION_RECOVERY_REQUIRED",
  );
  const recovered = await recoveringService.rotateCredential(
    "credential-platform-claude-v1",
    { apiKey: "replacement-key-survives-process-restart" },
    recoveryActor,
  );
  deferredProbe.pass();
  const lateOriginal = await interrupted;

  assert.deepEqual(lateOriginal.successorProfileRevisionIds, recovered.successorProfileRevisionIds);
  const final = await store.read((state) => ({
    credentials: [...state.credentials.values()],
    successorProfiles: [...state.profiles.values()].filter((profile) => profile.id.startsWith("profile-credential-rotation-")),
    successorProviders: [...state.providers.values()].filter((provider) => provider.id.startsWith("provider-credential-rotation-")),
    resumed: state.audit.some((record) => record.action === "CREDENTIAL_ROTATION_VALIDATION_RESUMED"),
  }));
  assert.equal(final.credentials.length, 2);
  assert.equal(final.credentials.filter((credential) => credential.state === "ACTIVE").length, 1);
  assert.ok(final.credentials.every((credential) => credential.rotatedAt !== null));
  assert.equal(new Set(final.credentials.map((credential) => credential.rotatedAt)).size, 1);
  assert.equal(final.successorProfiles.length, 1);
  assert.equal(final.successorProfiles[0]?.state, "ACTIVE");
  assert.equal(final.successorProviders.length, 1);
  assert.equal(final.successorProviders[0]?.state, "ACTIVE");
  assert.equal(final.resumed, true);
});
