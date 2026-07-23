import assert from "node:assert/strict";
import test from "node:test";
import { assertAdminCatalogReferences } from "../src/admin-catalog-integrity";
import { InMemoryAdminStore } from "../src/admin.store";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";

test("Agent catalog readiness accepts the seeded Claude default and rejects secret-smuggling fields", async () => {
  const store = new InMemoryAdminStore();
  await store.probe();
  await store.mutate((state) => {
    const provider = state.providers.get("provider-platform-claude-r1") as unknown as Record<string, unknown>;
    provider.apiKey = "must-never-be-projected";
  });
  await assert.rejects(store.probe(), /Provider revision schema is invalid/);
  await assert.rejects(store.read(() => undefined), /Provider revision schema is invalid/);

  const nested = new InMemoryAdminStore();
  await nested.mutate((state) => {
    const version = state.versions.get("claude-code@2.1.14")!;
    version.adapterCompatibility = {
      ...version.adapterCompatibility!,
      apiKey: "nested-secret",
    } as unknown as typeof version.adapterCompatibility;
  });
  await assert.rejects(nested.probe(), /Agent Adapter compatibility schema is invalid/);
});

test("Agent catalog readiness rejects a missing authority edge and fallback cycles", async () => {
  const missing = new InMemoryAdminStore();
  await missing.mutate((state) => { state.providers.delete("provider-platform-claude-r1"); });
  await assert.rejects(missing.probe(), /Profile authority binding is invalid/);

  const cyclic = new InMemoryAdminStore();
  await cyclic.mutate((state) => {
    const source = state.profiles.get("profile-platform-claude-r1")!;
    state.profiles.set("profile-platform-cycle-a-r2", {
      ...source, id: "profile-platform-cycle-a-r2", revision: 2,
      fallbackProfileRevisionId: "profile-platform-cycle-b-r2",
    });
    state.profiles.set("profile-platform-cycle-b-r2", {
      ...source, id: "profile-platform-cycle-b-r2", revision: 2,
      fallbackProfileRevisionId: "profile-platform-cycle-a-r2",
    });
  });
  await assert.rejects(cyclic.probe(), /fallback graph contains a cycle/);
});

test("Agent catalog readiness binds a project Profile to its authoritative tenant credential", async () => {
  const store = new InMemoryAdminStore();
  await store.mutate((state) => {
    const sourceProvider = state.providers.get("provider-platform-claude-r1")!;
    const sourceProfile = state.profiles.get("profile-platform-claude-r1")!;
    state.credentials.set("credential-tenant-a-v1", {
      id: "credential-tenant-a-v1",
      familyId: "credential-tenant-a",
      version: 1,
      label: "Tenant A key",
      scope: "tenant",
      scopeId: tenantA,
      secretRef: "vault://kv/deviludo/records/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      maskedFingerprint: "sha256:12345678…abcdef",
      state: "ACTIVE",
      createdAt: "2026-07-23T00:00:00.000Z",
      rotatedAt: null,
      lastUsedAt: null,
    });
    state.providers.set("provider-project-cross-tenant-r1", {
      ...sourceProvider,
      id: "provider-project-cross-tenant-r1",
      revision: 1,
      credentialVersionId: "credential-tenant-a-v1",
      state: "DRAFT",
      probe: Object.freeze({}),
    });
    state.profiles.set("profile-project-cross-tenant-r1", {
      ...sourceProfile,
      id: "profile-project-cross-tenant-r1",
      revision: 1,
      scope: "project",
      scopeId: projectId,
      providerRevisionId: "provider-project-cross-tenant-r1",
      credentialVersionId: "credential-tenant-a-v1",
      fallbackProfileRevisionId: null,
      state: "DRAFT",
      createdAt: "2026-07-23T00:00:00.000Z",
    });
  });
  const state = await store.read((value) => value);
  assert.throws(
    () => assertAdminCatalogReferences(state, new Map([[projectId, tenantB]]), true),
    /Project Profile credential scope is invalid/,
  );
  assert.doesNotThrow(() => assertAdminCatalogReferences(state, new Map([[projectId, tenantA]]), true));
});

test("Agent catalog readiness rejects a credential rotation receipt that splices valid records", async () => {
  const store = new InMemoryAdminStore();
  await store.mutate((state) => {
    const sourceCredential = state.credentials.get("credential-platform-claude-v1")!;
    const sourceProvider = state.providers.get("provider-platform-claude-r1")!;
    const sourceProfile = state.profiles.get("profile-platform-claude-r1")!;
    sourceCredential.state = "PREVIOUS";
    sourceProvider.state = "SUPERSEDED";
    sourceProfile.state = "SUPERSEDED";
    state.credentials.set("credential-platform-claude-v2", {
      ...sourceCredential,
      id: "credential-platform-claude-v2",
      version: 2,
      secretRef: "vault://kv/deviludo/records/55555555-5555-4555-8555-555555555555",
      maskedFingerprint: "sha256:87654321…fedcba",
      state: "ACTIVE",
      rotation: {
        operationKey: "a".repeat(64),
        sourceVersionId: sourceCredential.id,
        bindings: [{
          sourceProfileId: sourceProfile.id,
          successorProfileId: "profile-platform-claude-r2",
          sourceProviderId: sourceProvider.id,
          successorProviderId: "provider-platform-claude-r2",
          usesReplacement: true,
        }],
      },
    });
    state.providers.set("provider-platform-claude-r2", {
      ...sourceProvider,
      id: "provider-platform-claude-r2",
      revision: 2,
      credentialVersionId: "credential-platform-claude-v2",
      state: "ACTIVE",
    });
    state.profiles.set("profile-platform-claude-r2", {
      ...sourceProfile,
      id: "profile-platform-claude-r2",
      revision: 2,
      providerRevisionId: "provider-platform-claude-r2",
      credentialVersionId: "credential-platform-claude-v2",
      state: "ACTIVE",
    });
    state.defaults.set("platform", "profile-platform-claude-r2");
  });
  await store.probe();
  await store.mutate((state) => {
    const rotation = state.credentials.get("credential-platform-claude-v2")!.rotation!;
    (rotation.bindings[0] as { successorProviderId: string }).successorProviderId = "provider-platform-claude-r1";
  });
  await assert.rejects(store.probe(), /Credential rotation Profile binding is invalid/);
});
