import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectLocalProviderBindings,
  isLocalDevelopmentWorkerReady,
  reconcileLocalAgentHealth,
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
  assert.equal(isLocalDevelopmentWorkerReady(runtimeProbe, before, true), false);

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
  assert.equal(isLocalDevelopmentWorkerReady(runtimeProbe, after, false), false);
  assert.equal(isLocalDevelopmentWorkerReady(runtimeProbe, after, true), true);
});

test("local health fails closed on incomplete supply-chain evidence or a forged probe catalog", () => {
  const store = resetDemoStore();
  store.agentVersionMetadata["claude-code@2.1.14"].scan = "PENDING";
  const incomplete = reconcileLocalAgentHealth(runtimeProbe, store);
  assert.equal(incomplete.catalogVerified, false);
  assert.equal(isLocalDevelopmentWorkerReady(runtimeProbe, incomplete, true), false);

  const duplicateProbe = {
    ...runtimeProbe,
    agents: [runtimeProbe.agents[0], runtimeProbe.agents[0]],
  };
  const forged = reconcileLocalAgentHealth(duplicateProbe, resetDemoStore());
  assert.equal(forged.probeVerified, false);
  assert.equal(isLocalDevelopmentWorkerReady(duplicateProbe, forged, true), false);
});

test("local health verifies every runnable Provider binding without one Agent masking another", async () => {
  const models = Object.freeze({
    primaryModel: "model-primary-20260726",
    planningModel: "model-planning-20260726",
    smallFastModel: "model-fast-20260726",
    subagentModel: "model-subagent-20260726",
  });
  const candidates = Object.freeze([
    Object.freeze({
      agent: "claude-code", version: "2.1.201", providerRevisionId: "provider-claude-r1",
      profileRevisionId: "profile-claude-r1", credentialVersionId: "credential-claude-v1", modelRoles: models,
    }),
    Object.freeze({
      agent: "claude-code", version: "2.1.201", providerRevisionId: "provider-claude-r2",
      profileRevisionId: "profile-claude-r2", credentialVersionId: "credential-claude-v2", modelRoles: models,
    }),
    Object.freeze({
      agent: "codex-cli", version: "0.146.0-alpha.3.1", providerRevisionId: "provider-codex-r1",
      profileRevisionId: "profile-codex-r1", credentialVersionId: "credential-codex-v1", modelRoles: models,
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
});
