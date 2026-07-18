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

test("canary failure stops rollout and atomically restores the default to the previous healthy Profile", async () => {
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
    primaryModel: "claude-sonnet-4-6-20250514",
    dataRegion: "vendor-managed",
    retentionPolicy: "platform-approved",
    trainingPolicy: "no-training",
  }, actor("draft-profile"));
  const profileId = (drafted.profile as { id: string }).id;
  await service.transitionProfile(profileId, "validate", actor("validate-profile"));
  await service.transitionProfile(profileId, "activate", actor("activate-profile", "SecurityAdmin"));
  await service.updateDefault("platform", { profileRevisionId: profileId }, actor("select-profile"));

  chain.failureOperation = "ROLLOUT";
  await assert.rejects(service.rollout(installation.id, "advance", actor("fail-canary")), AgentSupplyChainPolicyFailure);
  const result = await store.read((state) => {
    const selected = state.defaults.get("platform");
    return {
      installation: structuredClone(state.installations.get(installation.id)),
      failedProfile: structuredClone(state.profiles.get(profileId)),
      selected,
      replacement: selected ? structuredClone(state.profiles.get(selected)) : undefined,
      audit: state.audit.find((entry) => entry.action === "AGENT_INSTALLATION_QUARANTINED"),
    };
  });
  assert.equal(result.installation?.state, "QUARANTINED");
  assert.equal(result.installation?.previousRolloutPercent, 0);
  assert.equal(result.failedProfile?.state, "SUPERSEDED");
  assert.notEqual(result.selected, profileId);
  assert.equal(result.replacement?.installationId, installation.rollbackInstallationId);
  assert.equal(result.replacement?.state, "ACTIVE");
  assert.equal(result.audit?.metadata.failureCode, "CANARY_HEALTH_FAILED");
});

function adminService(store: InMemoryAdminStore, chain: AgentSupplyChain): AdminService {
  return new AdminService(store, new ProcessIsolatedSecretVault(), new InferenceGatewayProviderProbe(), chain);
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
