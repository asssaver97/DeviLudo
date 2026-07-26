import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectLocalProviderBindings,
  isLocalDevelopmentWorkerReady,
  reconcileLocalAgentHealth,
  summarizeLocalAgentProfileExecutions,
  summarizeLocalProviderBindings,
} from "../lib/admin/local-agent-health.ts";
import { resetDemoStore } from "../lib/control-plane/demo-store.ts";

const runtimeProbe = Object.freeze({
  status: "degraded",
  service: "deviludo-local-agent-runtime",
  executionEnabled: true,
  inferenceGateway: "CONFIGURED",
  providerBindingProbe: "CONFIGURED",
  workerImageIdentity: null,
  expectedWorkerImageIdentity: null,
  workerImageVerified: true,
  workerIdentityMode: "LOCAL_DETERMINISTIC",
  agents: Object.freeze([
    Object.freeze({
      agent: "claude-code",
      executable: "claude",
      expectedVersion: "2.1.14",
      observedVersion: "2.1.201",
      state: "VERSION_MISMATCH",
    }),
    Object.freeze({
      agent: "codex-cli",
      executable: "codex",
      expectedVersion: "0.91.0",
      observedVersion: "0.146.0-alpha.3.1",
      state: "VERSION_MISMATCH",
    }),
  ]),
});

test("local health trusts persisted serving Profiles rather than the sidecar startup baseline", () => {
  const store = resetDemoStore();
  const before = reconcileLocalAgentHealth(runtimeProbe, store);
  assert.equal(before.catalogVerified, true);
  assert.equal(before.probeVerified, true);
  assert.deepEqual(before.agents.map((item) => item.expectedVersions), [["2.1.14"], ["0.91.0"]]);
  assert.deepEqual(before.agents.map((item) => item.state), ["VERSION_MISMATCH", "VERSION_MISMATCH"]);
  assert.equal(isLocalDevelopmentWorkerReady(runtimeProbe, before, providerHealth(before)), false);

  const sourceVersion = store.agentVersionMetadata["claude-code@2.1.14"];
  const sourceInstallation = store.installations.find((item) => item.id === "claude-installation-214");
  const sourceProfile = store.profiles.find((item) => item.id === "profile-claude-platform-r5");
  assert.ok(sourceVersion);
  assert.ok(sourceInstallation);
  assert.ok(sourceProfile);
  const version = "2.1.201";
  store.agentVersions[`claude-code@${version}`] = "APPROVED";
  store.agentVersionMetadata[`claude-code@${version}`] = {
    ...sourceVersion,
    source: `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${version}.tgz`,
    discoveredAt: "2026-07-26T04:30:00.000Z",
  };
  const installationId = "claude-installation-21201";
  store.installations.push({
    ...sourceInstallation,
    id: installationId,
    version,
    imageDigest: `sha256:${"c".repeat(64)}`,
    buildReceiptId: "build-claude-21201",
    buildReceiptDigest: `sha256:${"d".repeat(64)}`,
    createdAt: "2026-07-26T04:31:00.000Z",
    activatedAt: "2026-07-26T04:32:00.000Z",
  });
  const profileId = "profile-claude-platform-r6";
  store.profiles.push({ ...sourceProfile, id: profileId, revision: 6, installationId, createdAt: "2026-07-26T04:33:00.000Z" });
  store.defaults.platform = profileId;

  const after = reconcileLocalAgentHealth(runtimeProbe, store);
  assert.equal(after.catalogVerified, true);
  assert.deepEqual(after.agents[0].expectedVersions, ["2.1.14", version]);
  assert.equal(after.agents[0].state, "READY");
  assert.equal(isLocalDevelopmentWorkerReady(runtimeProbe, after, providerHealth(after, "BLOCKED")), false);
  assert.equal(isLocalDevelopmentWorkerReady(runtimeProbe, after, providerHealth(after)), true);
});

test("local health fails closed on incomplete supply-chain evidence or a forged probe catalog", () => {
  const store = resetDemoStore();
  store.agentVersionMetadata["claude-code@2.1.14"].scan = "PENDING";
  const incomplete = reconcileLocalAgentHealth(runtimeProbe, store);
  assert.equal(incomplete.catalogVerified, false);
  assert.equal(isLocalDevelopmentWorkerReady(runtimeProbe, incomplete, providerHealth(incomplete)), false);

  const duplicateProbe = {
    ...runtimeProbe,
    agents: [runtimeProbe.agents[0], runtimeProbe.agents[0]],
  };
  const forged = reconcileLocalAgentHealth(duplicateProbe, resetDemoStore());
  assert.equal(forged.probeVerified, false);
  assert.equal(isLocalDevelopmentWorkerReady(duplicateProbe, forged, providerHealth(forged)), false);
});

test("local health verifies every selected Provider binding without one Agent masking another", async () => {
  const models = Object.freeze({
    primaryModel: "model-primary-20260726",
    planningModel: "model-planning-20260726",
    smallFastModel: "model-fast-20260726",
    subagentModel: "model-subagent-20260726",
  });
  const candidates = Object.freeze([
    Object.freeze({
      agent: "claude-code", version: "2.1.201", providerRevisionId: "provider-claude-r1",
      profileRevisionId: "profile-claude-r1", credentialVersionId: "credential-claude-v1",
      selectionRole: "PRIMARY", runtimeState: "READY", modelRoles: models,
    }),
    Object.freeze({
      agent: "claude-code", version: "2.1.201", providerRevisionId: "provider-claude-r2",
      profileRevisionId: "profile-claude-r2", credentialVersionId: "credential-claude-v2",
      selectionRole: "FALLBACK", runtimeState: "VERSION_MISMATCH", modelRoles: models,
    }),
    Object.freeze({
      agent: "codex-cli", version: "0.146.0-alpha.3.1", providerRevisionId: "provider-codex-r1",
      profileRevisionId: "profile-codex-r1", credentialVersionId: "credential-codex-v1",
      selectionRole: "PRIMARY_AND_FALLBACK", runtimeState: "UNAVAILABLE", modelRoles: models,
    }),
  ]);
  const checked = [];
  const health = await inspectLocalProviderBindings(candidates, async (candidate) => {
    checked.push(candidate.profileRevisionId);
    if (candidate.profileRevisionId === "profile-claude-r2") throw new Error("connector unavailable");
    return candidate.agent === "claude-code";
  });

  assert.deepEqual(checked, candidates.map((candidate) => candidate.profileRevisionId));
  assert.deepEqual(health.map((binding) => binding.state), ["VERIFIED", "BLOCKED", "BLOCKED"]);
  assert.equal(summarizeLocalProviderBindings(health), "PARTIAL");
  assert.equal(JSON.stringify(health).includes("credential-"), false);
  assert.equal(summarizeLocalProviderBindings(health.filter((binding) => binding.state === "VERIFIED")), "VERIFIED");
  assert.equal(summarizeLocalProviderBindings(health.filter((binding) => binding.state === "BLOCKED")), "BLOCKED");
  assert.equal(summarizeLocalProviderBindings([]), "BLOCKED");
  assert.equal(summarizeLocalAgentProfileExecutions(health), "PARTIAL");
  assert.equal(summarizeLocalAgentProfileExecutions(health.filter((binding) => binding.runtimeState !== "READY")), "BLOCKED");
  assert.equal(summarizeLocalAgentProfileExecutions([]), "BLOCKED");
});

test("local health includes a project-authorized fallback and joins CLI plus Provider on the same Profile", async () => {
  const store = resetDemoStore();
  const primary = store.profiles.find((profile) => profile.id === "profile-codex-project-r1");
  const installation = store.installations.find((item) => item.id === "codex-installation-091");
  const metadata = store.agentVersionMetadata["codex-cli@0.91.0"];
  assert.ok(primary);
  assert.ok(installation);
  assert.ok(metadata);

  const fallbackVersion = "0.92.0";
  store.agentVersions[`codex-cli@${fallbackVersion}`] = "APPROVED";
  store.agentVersionMetadata[`codex-cli@${fallbackVersion}`] = {
    ...metadata,
    source: `https://registry.npmjs.org/@openai/codex/-/codex-${fallbackVersion}.tgz`,
    discoveredAt: "2026-07-26T06:00:00.000Z",
  };
  const fallbackInstallationId = "codex-installation-092";
  store.installations.push({
    ...installation,
    id: fallbackInstallationId,
    version: fallbackVersion,
    imageDigest: `sha256:${"e".repeat(64)}`,
    buildReceiptId: "build-codex-092",
    buildReceiptDigest: `sha256:${"f".repeat(64)}`,
    createdAt: "2026-07-26T06:01:00.000Z",
    activatedAt: "2026-07-26T06:02:00.000Z",
  });
  const fallbackId = "profile-codex-project-fallback-r2";
  store.profiles.push({
    ...primary,
    id: fallbackId,
    revision: 2,
    installationId: fallbackInstallationId,
    fallbackProfileRevisionId: null,
    createdAt: "2026-07-26T06:03:00.000Z",
  });
  primary.fallbackProfileRevisionId = fallbackId;

  const exactProbe = {
    ...runtimeProbe,
    agents: runtimeProbe.agents.map((agent) => ({
      ...agent,
      observedVersion: agent.agent === "claude-code" ? "2.1.14" : "0.91.0",
      state: "READY",
    })),
  };
  const reconciled = reconcileLocalAgentHealth(exactProbe, store);
  const projectBindings = reconciled.bindingCandidates.filter((binding) =>
    binding.profileRevisionId === primary.id || binding.profileRevisionId === fallbackId);
  assert.equal(reconciled.catalogVerified, true);
  assert.deepEqual(reconciled.agents.find((agent) => agent.agent === "codex-cli")?.expectedVersions,
    ["0.91.0", fallbackVersion]);
  assert.deepEqual(projectBindings.map((binding) => [binding.profileRevisionId, binding.selectionRole, binding.runtimeState]), [
    [primary.id, "PRIMARY", "READY"],
    [fallbackId, "FALLBACK", "VERSION_MISMATCH"],
  ]);

  const allProviders = await inspectLocalProviderBindings(reconciled.bindingCandidates, async () => true);
  assert.equal(summarizeLocalProviderBindings(allProviders), "VERIFIED");
  assert.equal(summarizeLocalAgentProfileExecutions(allProviders), "PARTIAL");
  assert.equal(isLocalDevelopmentWorkerReady(exactProbe, reconciled, allProviders), true);

  const crossed = await inspectLocalProviderBindings(reconciled.bindingCandidates, async (candidate) =>
    candidate.profileRevisionId === fallbackId);
  assert.equal(summarizeLocalAgentProfileExecutions(crossed), "BLOCKED");
  assert.equal(isLocalDevelopmentWorkerReady(exactProbe, reconciled, crossed), false);

  const crossAgent = structuredClone(store);
  crossAgent.profiles.find((profile) => profile.id === fallbackId).agent = "claude-code";
  assert.equal(reconcileLocalAgentHealth(exactProbe, crossAgent).catalogVerified, false);

  const selfFallback = structuredClone(store);
  selfFallback.profiles.find((profile) => profile.id === primary.id).fallbackProfileRevisionId = primary.id;
  assert.equal(reconcileLocalAgentHealth(exactProbe, selfFallback).catalogVerified, false);
});

test("local health does not implicitly authorize a platform fallback until a project selects it", () => {
  const store = resetDemoStore();
  const primary = store.profiles.find((profile) => profile.id === "profile-claude-platform-r5");
  assert.ok(primary);
  const fallbackId = "profile-claude-platform-fallback-r6";
  store.profiles.push({
    ...primary,
    id: fallbackId,
    revision: 6,
    fallbackProfileRevisionId: null,
    createdAt: "2026-07-26T06:10:00.000Z",
  });
  primary.fallbackProfileRevisionId = fallbackId;
  delete store.defaults["project:ember-archipelago"];

  const inheritedOnly = reconcileLocalAgentHealth(runtimeProbe, store);
  assert.equal(inheritedOnly.catalogVerified, true);
  assert.equal(inheritedOnly.bindingCandidates.some((binding) => binding.profileRevisionId === fallbackId), false);

  store.defaults["project:explicit-fallback"] = primary.id;
  const projectAuthorized = reconcileLocalAgentHealth(runtimeProbe, store);
  const fallback = projectAuthorized.bindingCandidates.find((binding) => binding.profileRevisionId === fallbackId);
  assert.equal(projectAuthorized.catalogVerified, true);
  assert.equal(fallback?.selectionRole, "FALLBACK");
});

function providerHealth(reconciliation, state = "VERIFIED") {
  return reconciliation.bindingCandidates.map((binding) => ({
    agent: binding.agent,
    version: binding.version,
    providerRevisionId: binding.providerRevisionId,
    profileRevisionId: binding.profileRevisionId,
    selectionRole: binding.selectionRole,
    runtimeState: binding.runtimeState,
    state,
  }));
}
