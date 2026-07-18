import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../../runner-control/src/canonical";
import { AdminService } from "../src/admin.service";
import { InMemoryAdminStore } from "../src/admin.store";
import {
  AgentSupplyChain,
  AgentSupplyChainPolicyFailure,
  DevelopmentAgentSupplyChain,
  type AgentSupplyChainTerminalFailureReceipt,
} from "../src/agent-supply-chain";
import type { RequestActor } from "../src/contracts";
import { InferenceGatewayProviderProbe } from "../src/provider-probe";
import { InferenceGatewayReconciliationClient } from "../src/inference-reconciliation";
import { ProcessIsolatedSecretVault } from "../src/secret-vault";

type FailureOperation = "VALIDATE" | "BUILD" | "ROLLOUT";

class FailingAgentSupplyChain extends AgentSupplyChain {
  readonly delegate = new DevelopmentAgentSupplyChain(() => new Date("2026-07-18T08:00:00.000Z"));
  failureOperation: FailureOperation | null = null;

  async discover(input: Parameters<AgentSupplyChain["discover"]>[0]) { return this.delegate.discover(input); }
  async validateVersion(input: Parameters<AgentSupplyChain["validateVersion"]>[0]) {
    if (this.failureOperation === "VALIDATE") throw policyFailure(input, "VALIDATE", "SIGNATURE_INVALID");
    return this.delegate.validateVersion(input);
  }
  async buildInstallation(input: Parameters<AgentSupplyChain["buildInstallation"]>[0]) {
    if (this.failureOperation === "BUILD") throw policyFailure(input, "BUILD", "MALWARE_DETECTED");
    return this.delegate.buildInstallation(input);
  }
  async rollout(input: Parameters<AgentSupplyChain["rollout"]>[0]) {
    if (this.failureOperation === "ROLLOUT") throw policyFailure(input, "ROLLOUT", "CANARY_HEALTH_FAILED");
    return this.delegate.rollout(input);
  }
  async probe() { return this.delegate.probe(); }
}

test("trusted validation failure rejects the exact version while transient errors remain retryable", async () => {
  const store = new InMemoryAdminStore();
  const chain = new FailingAgentSupplyChain();
  const service = adminService(store, chain);
  await service.discoverVersions({ agent: "codex-cli", version: "0.92.1" }, actor("discover-version"));
  chain.failureOperation = "VALIDATE";
  await assert.rejects(
    service.setVersionState("approve", { id: "codex-cli@0.92.1" }, actor("approve-version")),
    AgentSupplyChainPolicyFailure,
  );
  const rejected = await store.read((state) => ({
    version: structuredClone(state.versions.get("codex-cli@0.92.1")),
    audit: state.audit.find((entry) => entry.action === "AGENT_VERSION_REJECTED"),
  }));
  assert.equal(rejected.version?.state, "REJECTED");
  assert.equal(rejected.version?.scan, "FAIL");
  assert.equal(rejected.audit?.metadata.failureCode, "SIGNATURE_INVALID");

  const transientStore = new InMemoryAdminStore();
  const transient = new FailingAgentSupplyChain();
  const transientService = adminService(transientStore, transient);
  await transientService.discoverVersions({ agent: "codex-cli", version: "0.92.2" }, actor("discover-transient"));
  transient.validateVersion = async () => { throw new Error("temporary scanner outage"); };
  await assert.rejects(
    transientService.setVersionState("approve", { id: "codex-cli@0.92.2" }, actor("approve-transient")),
    /temporary scanner outage/,
  );
  assert.equal(await transientStore.read((state) => state.versions.get("codex-cli@0.92.2")?.state), "DISCOVERED");
});

test("Profile activation rejects an incomplete Provider probe even when every stored result is PASS", async () => {
  const store = new InMemoryAdminStore();
  const service = adminService(store, new FailingAgentSupplyChain());
  await store.mutate((state) => {
    const profile = state.profiles.get("profile-platform-claude-r1");
    const provider = state.providers.get("provider-platform-claude-r1");
    assert.ok(profile); assert.ok(provider);
    profile.state = "READY";
    provider.state = "READY";
    const incomplete = { ...provider.probe };
    delete incomplete.redirectRevalidation;
    provider.probe = incomplete;
  });
  await assert.rejects(
    service.transitionProfile("profile-platform-claude-r1", "activate", actor("activate-incomplete-probe", "SecurityAdmin")),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "PROVIDER_PROBE_REQUIRED",
  );
  const state = await store.read((catalog) => ({
    profile: catalog.profiles.get("profile-platform-claude-r1")?.state,
    provider: catalog.providers.get("provider-platform-claude-r1")?.state,
  }));
  assert.deepEqual(state, { profile: "READY", provider: "READY" });
});

test("terminal image build failure leaves an auditable quarantined reservation without a fake image", async () => {
  const store = new InMemoryAdminStore();
  const chain = new FailingAgentSupplyChain();
  chain.failureOperation = "BUILD";
  const service = adminService(store, chain);
  const requestActor = actor("quarantine-build");
  const request = {
    agent: "claude-code",
    version: "2.1.14",
    workerPool: "development-linux-primary",
    adapterVersion: "1.2.0",
  };
  await assert.rejects(service.createInstallation(request, requestActor), AgentSupplyChainPolicyFailure);
  await assert.rejects(service.createInstallation(request, requestActor), AgentSupplyChainPolicyFailure);
  const id = `claude-code-installation-${requestActor.mutation!.identityDigest.slice(0, 24)}`;
  const result = await store.read((state) => ({
    installation: structuredClone(state.installations.get(id)),
    audits: state.audit.filter((entry) => entry.action === "AGENT_INSTALLATION_QUARANTINED"),
  }));
  assert.equal(result.installation?.state, "QUARANTINED");
  assert.equal(result.installation?.rolloutPercent, 0);
  assert.equal(result.installation?.imageDigest, null);
  assert.equal(result.installation?.buildReceiptId, null);
  assert.equal(result.installation?.failure?.failureCode, "MALWARE_DETECTED");
  assert.equal(result.audits.length, 1);
  assert.equal(result.audits[0]?.metadata.runningTasksUnaffected, true);
});

test("canary failure stops rollout and restores the active candidate Profile without moving the healthy default", async () => {
  const store = new InMemoryAdminStore();
  const chain = new FailingAgentSupplyChain();
  const service = adminService(store, chain);
  const installation = await service.createInstallation({
    agent: "claude-code",
    version: "2.1.14",
    workerPool: "development-linux-primary",
    adapterVersion: "1.2.0",
  }, actor("build-canary"));
  const drafted = await service.createProfile({
    scope: "platform",
    scopeId: "global",
    agent: "claude-code",
    installationId: installation.id,
    credentialVersionId: "credential-platform-claude-v1",
    baseUrl: "https://gateway.anthropic.com/",
    authentication: "x-api-key",
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    primaryModel: "claude-sonnet-4-6-20250514",
    dataRegion: "vendor-managed",
    retentionPolicy: "platform-approved",
    trainingPolicy: "no-training",
  }, actor("draft-profile"));
  const profileId = (drafted.profile as { id: string }).id;
  await service.transitionProfile(profileId, "validate", actor("validate-profile"));
  await service.transitionProfile(profileId, "activate", actor("activate-profile", "SecurityAdmin"));
  await assert.rejects(
    service.updateDefault("platform", { profileRevisionId: profileId }, actor("select-profile")),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "PROFILE_NOT_SERVING_READY",
  );

  chain.failureOperation = "ROLLOUT";
  await assert.rejects(service.rollout(installation.id, "advance", actor("fail-canary")), AgentSupplyChainPolicyFailure);
  const result = await store.read((state) => {
    const selected = state.defaults.get("platform");
    const audit = state.audit.find((entry) => entry.action === "AGENT_INSTALLATION_QUARANTINED");
    const replacementId = (audit?.metadata.rollbackProfileRevisionIds as readonly string[] | undefined)?.[0];
    return {
      installation: structuredClone(state.installations.get(installation.id)),
      failedProfile: structuredClone(state.profiles.get(profileId)),
      selected,
      replacement: replacementId ? structuredClone(state.profiles.get(replacementId)) : undefined,
      audit,
    };
  });
  assert.equal(result.installation?.state, "QUARANTINED");
  assert.equal(result.installation?.previousRolloutPercent, 0);
  assert.equal(result.failedProfile?.state, "SUPERSEDED");
  assert.equal(result.selected, "profile-platform-claude-r1");
  assert.equal(result.replacement?.installationId, installation.rollbackInstallationId);
  assert.equal(result.replacement?.state, "ACTIVE");
  assert.equal(result.audit?.metadata.failureCode, "CANARY_HEALTH_FAILED");
});

test("a new Installation selects the most recently activated healthy rollback target instead of Map order", async () => {
  const store = new InMemoryAdminStore();
  const chain = new FailingAgentSupplyChain();
  const service = adminService(store, chain);
  await store.mutate((state) => {
    const seeded = state.installations.get("claude-code-installation-2-1-14");
    assert.ok(seeded);
    seeded.activatedAt = "2026-07-17T08:00:00.000Z";
  });
  const first = await service.createInstallation({
    agent: "claude-code",
    version: "2.1.14",
    workerPool: "development-linux-primary",
    adapterVersion: "1.3.0",
  }, actor("build-recent-rollback-target"));
  await service.rollout(first.id, "advance", actor("recent-target-5"));
  await service.rollout(first.id, "advance", actor("recent-target-25"));
  await service.rollout(first.id, "advance", actor("recent-target-100"));

  const second = await service.createInstallation({
    agent: "claude-code",
    version: "2.1.14",
    workerPool: "development-linux-primary",
    adapterVersion: "1.4.0",
  }, actor("build-after-recent-target"));
  assert.equal(first.activatedAt, "2026-07-18T08:00:00.000Z");
  assert.equal(second.rollbackInstallationId, first.id);
});

test("manual rollout rollback atomically rebinds defaults and fallback dependents to immutable Profile successors", async () => {
  const store = new InMemoryAdminStore();
  const chain = new FailingAgentSupplyChain();
  const service = adminService(store, chain);
  const installation = await service.createInstallation({
    agent: "claude-code",
    version: "2.1.14",
    workerPool: "development-linux-primary",
    adapterVersion: "1.2.1",
  }, actor("build-manual-rollback"));
  await service.rollout(installation.id, "advance", actor("rollout-manual-5"));
  await service.rollout(installation.id, "advance", actor("rollout-manual-25"));
  await service.rollout(installation.id, "advance", actor("rollout-manual-100"));
  const drafted = await service.createProfile({
    scope: "platform",
    scopeId: "global",
    agent: "claude-code",
    installationId: installation.id,
    credentialVersionId: "credential-platform-claude-v1",
    baseUrl: "https://rollback-gateway.anthropic.example/v1",
    authentication: "x-api-key",
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    primaryModel: "claude-sonnet-4-6-20250514",
    dataRegion: "vendor-managed",
    retentionPolicy: "platform-approved",
    trainingPolicy: "no-training",
  }, actor("draft-manual-rollback"));
  const sourceProfileId = (drafted.profile as { id: string }).id;
  const sourceProviderId = (drafted.provider as { id: string }).id;
  await service.transitionProfile(sourceProfileId, "validate", actor("validate-manual-rollback"));
  await service.transitionProfile(sourceProfileId, "activate", actor("activate-manual-rollback", "SecurityAdmin"));
  await service.updateDefault("platform", { profileRevisionId: sourceProfileId }, actor("select-manual-rollback"));

  const dependentProfileId = "profile-platform-rollback-dependent-r1";
  const dependentDefault = "project:22222222-2222-4222-8222-222222222222";
  await store.mutate((state) => {
    const source = state.profiles.get(sourceProfileId);
    const previousInstallation = installation.rollbackInstallationId;
    assert.ok(source); assert.ok(previousInstallation);
    state.profiles.set(dependentProfileId, {
      ...source,
      id: dependentProfileId,
      installationId: previousInstallation,
      fallbackProfileRevisionId: source.id,
    });
    state.defaults.set(dependentDefault, dependentProfileId);
  });

  const rollback = await service.rollout(installation.id, "rollback", actor("rollout-manual-rollback"));
  const successorIds = rollback.rollbackProfileRevisionIds as readonly string[];
  assert.equal(successorIds.length, 2);
  const result = await store.read((state) => {
    const platformDefault = state.defaults.get("platform");
    const projectDefault = state.defaults.get(dependentDefault);
    return {
      installation: structuredClone(state.installations.get(installation.id)),
      source: structuredClone(state.profiles.get(sourceProfileId)),
      dependent: structuredClone(state.profiles.get(dependentProfileId)),
      platformDefault,
      projectDefault,
      platformSuccessor: platformDefault ? structuredClone(state.profiles.get(platformDefault)) : undefined,
      dependentSuccessor: projectDefault ? structuredClone(state.profiles.get(projectDefault)) : undefined,
      audit: state.audit.find((entry) => entry.action === "AGENT_ROLLOUT_ROLLBACK"),
    };
  });
  assert.equal(result.installation?.state, "READY");
  assert.equal(result.installation?.rolloutPercent, 0);
  assert.equal(result.source?.state, "SUPERSEDED");
  assert.equal(result.dependent?.state, "SUPERSEDED");
  assert.equal(result.platformSuccessor?.state, "ACTIVE");
  assert.equal(result.platformSuccessor?.installationId, installation.rollbackInstallationId);
  assert.equal(result.platformSuccessor?.providerRevisionId, sourceProviderId);
  assert.equal(result.platformSuccessor?.credentialVersionId, "credential-platform-claude-v1");
  assert.equal(result.dependentSuccessor?.state, "ACTIVE");
  assert.equal(result.dependentSuccessor?.installationId, installation.rollbackInstallationId);
  assert.equal(result.dependentSuccessor?.fallbackProfileRevisionId, result.platformSuccessor?.id);
  assert.deepEqual(result.audit?.metadata.rollbackProfileRevisionIds, successorIds);
});

test("rollback without a fully active target degrades the entire active fallback dependency closure", async () => {
  const store = new InMemoryAdminStore();
  const chain = new FailingAgentSupplyChain();
  const service = adminService(store, chain);
  const installation = await service.createInstallation({
    agent: "codex-cli",
    version: "0.91.0",
    workerPool: "development-linux-first-codex",
    adapterVersion: "1.2.2",
  }, actor("build-first-codex"));
  assert.equal(installation.rollbackInstallationId, null);
  await service.rollout(installation.id, "advance", actor("first-codex-5"));
  await service.rollout(installation.id, "advance", actor("first-codex-25"));
  await service.rollout(installation.id, "advance", actor("first-codex-100"));

  const sourceProfileId = "profile-first-codex-r1";
  const dependentProfileId = "profile-first-codex-dependent-r1";
  await store.mutate((state) => {
    const template = state.profiles.get("profile-platform-claude-r1");
    const current = state.installations.get(installation.id);
    assert.ok(template); assert.ok(current);
    const carrierInstallationId = "codex-code-installation-fallback-carrier";
    state.installations.set(carrierInstallationId, {
      ...current,
      id: carrierInstallationId,
      rollbackInstallationId: null,
    });
    state.profiles.set(sourceProfileId, {
      ...template,
      id: sourceProfileId,
      agent: "codex-cli",
      installationId: installation.id,
      fallbackProfileRevisionId: null,
    });
    state.profiles.set(dependentProfileId, {
      ...template,
      id: dependentProfileId,
      agent: "codex-cli",
      installationId: carrierInstallationId,
      fallbackProfileRevisionId: sourceProfileId,
    });
    state.defaults.set("platform", sourceProfileId);
    state.defaults.set("project:first-codex", dependentProfileId);
  });

  const rollback = await service.rollout(installation.id, "rollback", actor("rollback-first-codex"));
  assert.deepEqual(rollback.rollbackProfileRevisionIds, []);
  const result = await store.read((state) => ({
    source: structuredClone(state.profiles.get(sourceProfileId)),
    dependent: structuredClone(state.profiles.get(dependentProfileId)),
    platformDefault: state.defaults.get("platform"),
    projectDefault: state.defaults.get("project:first-codex"),
  }));
  assert.equal(result.source?.state, "DEGRADED");
  assert.equal(result.dependent?.state, "DEGRADED");
  assert.equal(result.platformDefault, sourceProfileId);
  assert.equal(result.projectDefault, dependentProfileId);
});

function adminService(store: InMemoryAdminStore, chain: AgentSupplyChain): AdminService {
  return new AdminService(
    store,
    new ProcessIsolatedSecretVault(),
    new InferenceGatewayProviderProbe(),
    chain,
    new InferenceGatewayReconciliationClient(),
  );
}

function actor(label: string, role: RequestActor["role"] = "PlatformAgentAdmin"): RequestActor {
  return Object.freeze({
    role,
    requestId: `request-${label}`,
    actorId: `actor-${label}`,
    tenantId: null,
    projectId: null,
    mutation: Object.freeze({
      identityDigest: sha256Canonical({ label, binding: "identity" }),
      requestFingerprint: sha256Canonical({ label, binding: "request" }),
      claimToken: "11111111-1111-4111-8111-111111111111",
    }),
  });
}

function policyFailure(
  input: Readonly<{ operationKey: string; requestDigest: string }>,
  operationKind: FailureOperation,
  failureCode: AgentSupplyChainTerminalFailureReceipt["failureCode"],
): AgentSupplyChainPolicyFailure {
  const core = Object.freeze({
    schemaVersion: "deviludo.agent-supply-chain-terminal-failure.v1" as const,
    operationKey: input.operationKey,
    requestDigest: input.requestDigest,
    operationKind,
    disposition: operationKind === "VALIDATE" ? "REJECTED" as const : "QUARANTINED" as const,
    failureCode,
    evidenceDigest: sha256Canonical({ operationKind, failureCode, input }),
    failureReceiptId: `failure-${operationKind.toLowerCase()}-${input.operationKey.slice(0, 16)}`,
    failedAt: "2026-07-18T08:00:00.000Z",
  });
  return new AgentSupplyChainPolicyFailure(Object.freeze({
    ...core,
    failureReceiptDigest: sha256Canonical(core),
  }));
}
