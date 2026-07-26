import assert from "node:assert/strict";
import test from "node:test";
import {
  commitLocalCredentialRotation,
  planLocalCredentialRotation,
} from "../lib/admin/local-credential-rotation.ts";
import { resetDemoStore } from "../lib/control-plane/demo-store.ts";
import { PROVIDER_PROBE_CHECKS } from "../services/inference-gateway/src/provider-probe.ts";

test("local credential rotation closes over fallback Profiles and commits only complete probes", async () => {
  const store = resetDemoStore();
  const credential = {
    id: "cred-claude-platform-v4",
    familyId: "cred-claude-platform",
    label: "Claude platform",
    scope: "platform",
    scopeId: "global",
    secretRef: "secret://local-agent-runtime/cred-claude-platform-v4",
    fingerprint: `sha256:${"4".repeat(64)}`,
    masked: "sha256:444444…444444",
    version: 4,
    state: "ACTIVE",
    createdAt: "2026-07-20T00:00:00.000Z",
    rotatedAt: null,
  };
  store.credentials.push(credential);
  const source = store.profiles.find((profile) => profile.id === "profile-claude-platform-r5");
  const sourceProvider = store.providers.find((provider) => provider.id === source.providerRevisionId);
  const backupProvider = {
    ...sourceProvider,
    id: "provider-claude-backup-r1",
    revision: 1,
    credentialVersionId: "cred-claude-backup-v1",
    models: { ...sourceProvider.models },
    pricing: { ...sourceProvider.pricing },
    governance: { ...sourceProvider.governance },
    probe: { ...sourceProvider.probe },
  };
  store.providers.push(backupProvider);
  const dependent = {
    ...source,
    id: "profile-claude-dependent-r1",
    revision: 1,
    providerRevisionId: backupProvider.id,
    credentialVersionId: backupProvider.credentialVersionId,
    fallbackProfileRevisionId: source.id,
  };
  store.profiles.push(dependent);
  store.defaults["project:fallback-test"] = dependent.id;

  const stage = await planLocalCredentialRotation(store, credential, "cred-claude-platform-v5");
  const dependentBinding = stage.bindings.find((binding) => binding.sourceProfile.id === dependent.id);
  assert.ok(dependentBinding);
  assert.equal(dependentBinding.rotatesCredential, false);
  assert.equal(dependentBinding.successorProvider, null);
  assert.equal(dependentBinding.successorProfile.providerRevisionId, backupProvider.id);
  assert.notEqual(dependentBinding.successorProfile.fallbackProfileRevisionId, source.id);
  assert.equal(stage.providers.length, 1);

  const replacement = {
    ...credential,
    id: "cred-claude-platform-v5",
    secretRef: "secret://local-agent-runtime/cred-claude-platform-v5",
    fingerprint: `sha256:${"5".repeat(64)}`,
    masked: "sha256:555555…555555",
    version: 5,
    createdAt: "2026-07-26T00:00:00.000Z",
    rotatedAt: "2026-07-26T00:00:00.000Z",
  };
  assert.throws(
    () => commitLocalCredentialRotation(store, stage, credential, replacement, new Map()),
    (error) => error?.code === "CREDENTIAL_ROTATION_RACE",
  );
  assert.equal(credential.state, "ACTIVE");
  assert.equal(store.credentials.includes(replacement), false);
  assert.equal(source.state, "ACTIVE");
  assert.equal(dependent.state, "ACTIVE");

  const passed = Object.freeze(Object.fromEntries(PROVIDER_PROBE_CHECKS.map((check) => [check, "PASS"])));
  const probes = new Map(stage.providers.map(({ successor }) => [successor.id, passed]));
  const result = commitLocalCredentialRotation(store, stage, credential, replacement, probes);
  assert.equal(result.successorProfileRevisionIds.length, 3);
  assert.equal(result.successorProviderRevisionIds.length, 1);
  assert.equal(result.reboundDefaultCount, 3);
  assert.equal(credential.state, "PREVIOUS");
  assert.equal(source.state, "SUPERSEDED");
  assert.equal(dependent.state, "SUPERSEDED");
  const dependentSuccessor = store.profiles.find((profile) => profile.id === dependentBinding.successorProfile.id);
  assert.equal(dependentSuccessor.state, "ACTIVE");
  assert.equal(dependentSuccessor.providerRevisionId, backupProvider.id);
  assert.equal(dependentSuccessor.credentialVersionId, backupProvider.credentialVersionId);
  assert.equal(dependentSuccessor.fallbackProfileRevisionId, stage.bindings
    .find((binding) => binding.sourceProfile.id === source.id).successorProfile.id);
  assert.equal(store.defaults["project:fallback-test"], dependentSuccessor.id);
});
