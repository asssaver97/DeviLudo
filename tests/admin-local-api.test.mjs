import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST, PUT } from "../app/api/admin/[...segments]/route.ts";
import { getDemoStore, resetDemoStore } from "../lib/control-plane/demo-store.ts";

function context(path) {
  return { params: Promise.resolve({ segments: path.split("/") }) };
}

function request(path, method, role, body = {}) {
  return new Request(`http://127.0.0.1:3000/api/admin/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": `test-${path}-${crypto.randomUUID()}`,
      "x-deviludo-role": role,
    },
    body: JSON.stringify(body),
  });
}

test("local Agent admin mutations persist behind RBAC and emit audit records", async () => {
  resetDemoStore();
  const initial = await GET(new Request("http://127.0.0.1:3000/api/admin/agents"), context("agents"));
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).meta.defaultAgent, "claude-code");

  const changed = await PUT(
    request("agent-defaults/platform", "PUT", "PlatformAgentAdmin", { profileRevisionId: "profile-codex-platform-r2" }),
    context("agent-defaults/platform"),
  );
  assert.equal(changed.status, 200);

  const refreshed = await GET(new Request("http://127.0.0.1:3000/api/admin/agents"), context("agents"));
  assert.equal((await refreshed.json()).meta.defaultAgent, "codex-cli");

  const blocked = await POST(
    request("agent-versions/block", "POST", "PlatformAgentAdmin", { id: "claude-code@2.1.15" }),
    context("agent-versions/block"),
  );
  assert.equal(blocked.status, 201);
  assert.equal(getDemoStore().agentVersions["claude-code@2.1.15"], "BLOCKED");
  assert.equal(getDemoStore().audit.some((entry) => entry.action === "AGENT_VERSION_BLOCKED"), true);

  const existingInstallation = getDemoStore().installations.find((item) => item.agent === "claude-code" && item.version === "2.1.14");
  const deprecated = await POST(
    request("agent-versions/deprecate", "POST", "PlatformAgentAdmin", { id: "claude-code@2.1.14" }),
    context("agent-versions/deprecate"),
  );
  assert.equal(deprecated.status, 201);
  assert.equal(getDemoStore().agentVersions["claude-code@2.1.14"], "DEPRECATED");
  assert.equal(existingInstallation?.state, "ACTIVE");
  assert.equal(getDemoStore().audit.some((entry) => entry.action === "AGENT_VERSION_DEPRECATED"), true);

  const deniedInstallation = await POST(
    request("agent-installations", "POST", "PlatformAgentAdmin", {
      agent: "claude-code", version: "2.1.14", workerPool: "development-local-deprecated", adapterVersion: "1.3.0",
    }),
    context("agent-installations"),
  );
  assert.equal(deniedInstallation.status, 409);
});

test("local Agent health exposes usage, configuration differences and derived alerts with the production shape", async () => {
  resetDemoStore();
  const changed = await PUT(
    request("agent-defaults/platform", "PUT", "PlatformAgentAdmin", { profileRevisionId: "profile-codex-platform-r2" }),
    context("agent-defaults/platform"),
  );
  assert.equal(changed.status, 200);
  const response = await GET(new Request("http://127.0.0.1:3000/api/admin/agent-health"), context("agent-health"));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.status, "HEALTHY");
  assert.equal(data.supplyChain.status, "READY");
  assert.deepEqual(data.isolation, {
    developmentWorkers: true, e2eRunnersContainAgent: false, steamPublishersContainAgent: false,
  });
  assert.equal(data.usage.available, true);
  assert.equal(data.usage.totals.requests, 2);
  assert.equal(data.usage.records.every((record) => record.credentialVersionId && record.runId), true);
  assert.equal(data.usage.credentialLastUsedAt["cred-claude-platform-v4"], data.usage.records[0].recordedAt);
  const diff = data.configurationDiffs.find((item) => item.action === "AGENT_DEFAULT_UPDATED");
  assert.deepEqual(diff.changes, [{
    field: "profileRevisionId",
    before: "profile-claude-platform-r5",
    after: "profile-codex-platform-r2",
  }]);
  assert.deepEqual(data.alerts, []);
});

test("local Agent discovery selects Claude Code and Codex CLI explicitly without activating candidates", async () => {
  resetDemoStore();
  const codex = await POST(
    request("agent-versions/discover", "POST", "PlatformAgentAdmin", { agent: "codex-cli" }),
    context("agent-versions/discover"),
  );
  assert.equal(codex.status, 201);
  const payload = await codex.json();
  const codexCandidate = payload.data.candidates[0];
  assert.equal(codexCandidate.agent, "codex-cli");
  assert.equal(codexCandidate.version, "0.92.0");
  assert.equal(codexCandidate.state, "DISCOVERED");
  assert.equal(codexCandidate.activated, false);
  assert.equal(codexCandidate.source, "https://registry.npmjs.org/@openai/codex/-/codex-0.92.0.tgz");
  assert.equal(codexCandidate.releaseNotesUrl, "https://github.com/openai/codex/releases");
  assert.match(codexCandidate.sourceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(codexCandidate.signatureVerified, false);
  assert.equal(codexCandidate.scan, "PENDING");
  assert.equal(getDemoStore().agentVersions["codex-cli@0.92.0"], "DISCOVERED");
  assert.equal(getDemoStore().agentVersions["claude-code@2.1.15"], "DISCOVERED");
  assert.equal(getDemoStore().audit[0]?.resource, "codex-cli@0.92.0");

  const exact = await POST(
    request("agent-versions/discover", "POST", "PlatformAgentAdmin", { agent: "codex-cli", version: "0.145.0-alpha.18" }),
    context("agent-versions/discover"),
  );
  assert.equal(exact.status, 201);
  const exactCandidate = (await exact.json()).data.candidates[0];
  assert.equal(exactCandidate.agent, "codex-cli");
  assert.equal(exactCandidate.version, "0.145.0-alpha.18");
  assert.equal(exactCandidate.state, "DISCOVERED");
  assert.equal(exactCandidate.activated, false);
  assert.equal(exactCandidate.source, "https://registry.npmjs.org/@openai/codex/-/codex-0.145.0-alpha.18.tgz");
  assert.equal(getDemoStore().agentVersions["codex-cli@0.145.0-alpha.18"], "DISCOVERED");

  const floating = await POST(
    request("agent-versions/discover", "POST", "PlatformAgentAdmin", { agent: "claude-code", version: "latest" }),
    context("agent-versions/discover"),
  );
  assert.equal(floating.status, 400);
  assert.equal((await floating.json()).error.code, "INVALID_AGENT_VERSION");

  const invalid = await POST(
    request("agent-versions/discover", "POST", "PlatformAgentAdmin", { agent: "third-party" }),
    context("agent-versions/discover"),
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_AGENT");
});

test("local Agent defaults expose only complete platform, tenant and project Profile bindings", async () => {
  const store = resetDemoStore();
  const response = await GET(new Request("http://127.0.0.1:3000/api/admin/agents"), context("agents"));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.meta.defaults, {
    platform: "profile-claude-platform-r5",
    "tenant:north-dock": "profile-claude-tenant-r2",
    "project:ember-archipelago": "profile-codex-project-r1",
  });
  const profiles = new Map(store.profiles.map((profile) => [profile.id, profile]));
  for (const [scope, profileId] of Object.entries(payload.meta.defaults)) {
    const profile = profiles.get(profileId);
    assert.ok(profile, `${scope} default must reference an existing Profile`);
    assert.equal(profile.state, "ACTIVE");
    assert.equal(scope === "platform" ? profile.scope : scope.split(":", 1)[0], profile.scope);
    assert.equal(scope === "platform" ? profile.scopeId : scope.slice(scope.indexOf(":") + 1), profile.scopeId);
  }
});

test("local credential writes return only public metadata and never a SecretRef or plaintext", async () => {
  resetDemoStore();
  const plaintext = "local-test-credential-material";
  const response = await POST(
    request("credentials", "POST", "TenantAdmin", { label: "Tenant Claude", apiKey: plaintext }),
    context("credentials"),
  );
  assert.equal(response.status, 201);
  const text = await response.text();
  assert.equal(text.includes(plaintext), false);
  assert.equal(text.includes("secretRef"), false);
  assert.match(JSON.parse(text).data.maskedFingerprint, /^sha256:/);
  const audit = await GET(new Request("http://127.0.0.1:3000/api/admin/audit"), context("audit"));
  assert.equal((await audit.text()).includes("secretRef"), false);
});

test("local credential lifecycle creates a new version and can revoke the exact previous version", async () => {
  const store = resetDemoStore();
  const created = await POST(
    request("credentials", "POST", "TenantAdmin", { label: "Tenant lifecycle", apiKey: "tenant-initial-secret" }),
    context("credentials"),
  );
  const credentialId = (await created.json()).data.id;
  const replacementSecret = "tenant-replacement-secret";
  const rotatePath = `credentials/${credentialId}/rotate`;
  const rotated = await POST(
    request(rotatePath, "POST", "TenantAdmin", { apiKey: replacementSecret }),
    context(rotatePath),
  );
  assert.equal(rotated.status, 201);
  const rotationText = await rotated.text();
  assert.equal(rotationText.includes(replacementSecret), false);
  assert.equal(rotationText.includes("secretRef"), false);
  const rotation = JSON.parse(rotationText).data;
  assert.equal(rotation.previousId, credentialId);
  assert.equal(rotation.state, "ACTIVE");
  assert.notEqual(rotation.id, credentialId);
  assert.ok(Number.isFinite(Date.parse(rotation.rotatedAt)));
  const previousVersion = store.credentials.find((item) => item.id === credentialId);
  const activeVersion = store.credentials.find((item) => item.id === rotation.id);
  assert.equal(previousVersion?.state, "PREVIOUS");
  assert.equal(activeVersion?.state, "ACTIVE");
  assert.equal(previousVersion?.rotatedAt, rotation.rotatedAt);
  assert.equal(activeVersion?.rotatedAt, rotation.rotatedAt);

  const catalogResponse = await GET(new Request("http://127.0.0.1:3000/api/admin/agents"), context("agents"));
  const catalog = await catalogResponse.json();
  assert.equal(catalog.meta.credentials.find((item) => item.id === credentialId)?.rotatedAt, rotation.rotatedAt);
  assert.equal(catalog.meta.credentials.find((item) => item.id === rotation.id)?.rotatedAt, rotation.rotatedAt);

  const repeatedRotation = await POST(
    request(rotatePath, "POST", "TenantAdmin", { apiKey: "another-replacement-secret" }),
    context(rotatePath),
  );
  assert.equal(repeatedRotation.status, 409);
  assert.equal((await repeatedRotation.json()).error.code, "CREDENTIAL_NOT_ACTIVE");
  assert.equal(store.credentials.length, 2);

  const revokePath = `credentials/${credentialId}/revoke`;
  const revoked = await POST(request(revokePath, "POST", "TenantAdmin", {}), context(revokePath));
  assert.equal(revoked.status, 201);
  assert.equal((await revoked.json()).data.state, "REVOKED");
  assert.equal(store.credentials.find((item) => item.id === credentialId)?.state, "REVOKED");
  assert.equal(store.credentials.find((item) => item.id === rotation.id)?.state, "ACTIVE");
});

test("local Agent mutations reject unknown and legacy fields before changing state", async () => {
  const store = resetDemoStore();
  const secret = "must-not-appear-in-an-error";
  const credentialsBefore = store.credentials.length;
  const credential = await POST(
    request("credentials", "POST", "SecurityAdmin", {
      label: "Legacy payload", apiKey: "valid-local-secret", credentialId: secret,
    }),
    context("credentials"),
  );
  assert.equal(credential.status, 400);
  const credentialText = await credential.text();
  assert.equal(JSON.parse(credentialText).error.code, "UNEXPECTED_FIELD");
  assert.equal(credentialText.includes(secret), false);
  assert.equal(store.credentials.length, credentialsBefore);

  const profilesBefore = store.profiles.length;
  const profile = await POST(
    request("agent-profiles", "POST", "SecurityAdmin", { credentialId: "legacy", budgetUsd: 10 }),
    context("agent-profiles"),
  );
  assert.equal(profile.status, 400);
  assert.equal((await profile.json()).error.code, "UNEXPECTED_FIELD");
  assert.equal(store.profiles.length, profilesBefore);

  const rolloutBefore = store.rollouts["claude-installation-214"].percent;
  const rolloutPath = "agent-rollouts/claude-installation-214/advance";
  const rollout = await POST(
    request(rolloutPath, "POST", "PlatformAgentAdmin", { toPercent: 100 }),
    context(rolloutPath),
  );
  assert.equal(rollout.status, 400);
  assert.equal((await rollout.json()).error.code, "UNEXPECTED_FIELD");
  assert.equal(store.rollouts["claude-installation-214"].percent, rolloutBefore);
});

test("version approval and installation accept only local Broker receipts, never caller attestations", async () => {
  resetDemoStore();
  const forged = await POST(
    request("agent-versions/approve", "POST", "PlatformAgentAdmin", {
      id: "claude-code@2.1.15",
      integrity: `sha256:${"a".repeat(64)}`,
      signatureVerified: true,
      scan: "PASS",
      sbomRef: "oci://registry.deviludo.invalid/sbom/claude-code@sha256:aaaa",
    }),
    context("agent-versions/approve"),
  );
  assert.equal(forged.status, 400);
  assert.equal((await forged.json()).error.code, "CALLER_ATTESTATION_FORBIDDEN");
  assert.equal(getDemoStore().agentVersions["claude-code@2.1.15"], "DISCOVERED");

  const approved = await POST(
    request("agent-versions/approve", "POST", "PlatformAgentAdmin", { id: "claude-code@2.1.15" }),
    context("agent-versions/approve"),
  );
  assert.equal(approved.status, 201);
  assert.match((await approved.clone().json()).data.validationReceiptDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(getDemoStore().agentVersions["claude-code@2.1.15"], "APPROVED");
  const approvedMetadata = getDemoStore().agentVersionMetadata["claude-code@2.1.15"];
  assert.equal(approvedMetadata.signatureVerified, true);
  assert.equal(approvedMetadata.scan, "PASS");
  assert.match(approvedMetadata.integrity, /^sha256:[a-f0-9]{64}$/);
  assert.match(approvedMetadata.validationReceiptDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(approvedMetadata.sbomRef, /^urn:deviludo:local-sbom:/);

  const forgedImage = await POST(
    request("agent-installations", "POST", "PlatformAgentAdmin", {
      agent: "claude-code",
      version: "2.1.15",
      workerPool: "dev-linux-a",
      adapterVersion: "1.3.0",
      imageDigest: `sha256:${"b".repeat(64)}`,
    }),
    context("agent-installations"),
  );
  assert.equal(forgedImage.status, 400);
  assert.equal((await forgedImage.json()).error.code, "CALLER_ATTESTATION_FORBIDDEN");

  const installation = await POST(
    request("agent-installations", "POST", "PlatformAgentAdmin", {
      agent: "claude-code",
      version: "2.1.15",
      workerPool: "dev-linux-a",
      adapterVersion: "1.3.0",
    }),
    context("agent-installations"),
  );
  assert.equal(installation.status, 201);
  const installed = (await installation.json()).data;
  assert.match(installed.imageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(installed.rolloutPercent, 0);
  assert.equal(getDemoStore().installations.some((item) => item.id === installed.id), true);
});

test("local rollout rollback moves the default to an immutable Profile on the previous active installation", async () => {
  const store = resetDemoStore();
  const installationResponse = await POST(
    request("agent-installations", "POST", "PlatformAgentAdmin", {
      agent: "codex-cli",
      version: "0.91.0",
      workerPool: "dev-linux-b",
      adapterVersion: "1.2.3",
    }),
    context("agent-installations"),
  );
  assert.equal(installationResponse.status, 201);
  const installation = (await installationResponse.json()).data;
  assert.equal(installation.rollbackInstallationId, "codex-installation-091");
  for (const expected of [5, 25, 100]) {
    const path = `agent-rollouts/${installation.id}/advance`;
    const advanced = await POST(request(path, "POST", "PlatformAgentAdmin"), context(path));
    assert.equal(advanced.status, 201);
    assert.equal((await advanced.json()).data.percent, expected);
  }
  const baseProfile = store.profiles.find((profile) => profile.id === "profile-codex-platform-r2");
  assert.ok(baseProfile);
  const source = {
    ...baseProfile,
    id: "profile-codex-platform-new-r3",
    revision: 3,
    installationId: installation.id,
    state: "ACTIVE",
  };
  store.profiles.push(source);
  store.defaults.platform = source.id;

  const path = `agent-rollouts/${installation.id}/rollback`;
  const response = await POST(request(path, "POST", "PlatformAgentAdmin"), context(path));
  assert.equal(response.status, 201);
  const payload = (await response.json()).data;
  assert.equal(payload.percent, 0);
  assert.equal(payload.rollbackProfileRevisionIds.length, 1);
  const successor = store.profiles.find((profile) => profile.id === payload.rollbackProfileRevisionIds[0]);
  assert.equal(source.state, "SUPERSEDED");
  assert.equal(successor?.state, "ACTIVE");
  assert.equal(successor?.installationId, "codex-installation-091");
  assert.equal(successor?.providerRevisionId, source.providerRevisionId);
  assert.equal(store.defaults.platform, successor?.id);
});

test("local installation lineage selects the most recently activated healthy generation", async () => {
  resetDemoStore();
  const firstResponse = await POST(
    request("agent-installations", "POST", "PlatformAgentAdmin", {
      agent: "codex-cli",
      version: "0.91.0",
      workerPool: "dev-linux-b",
      adapterVersion: "1.3.0",
    }),
    context("agent-installations"),
  );
  assert.equal(firstResponse.status, 201);
  const first = (await firstResponse.json()).data;
  assert.equal(first.rollbackInstallationId, "codex-installation-091");
  for (const expected of [5, 25, 100]) {
    const path = `agent-rollouts/${first.id}/advance`;
    const advanced = await POST(request(path, "POST", "PlatformAgentAdmin"), context(path));
    assert.equal(advanced.status, 201);
    assert.equal((await advanced.json()).data.percent, expected);
  }
  getDemoStore().installations.reverse();

  const secondResponse = await POST(
    request("agent-installations", "POST", "PlatformAgentAdmin", {
      agent: "codex-cli",
      version: "0.91.0",
      workerPool: "dev-linux-b",
      adapterVersion: "1.4.0",
    }),
    context("agent-installations"),
  );
  assert.equal(secondResponse.status, 201);
  const second = (await secondResponse.json()).data;
  assert.equal(second.rollbackInstallationId, first.id);
});

test("local Installation drains new work and retires only after defaults move away", async () => {
  const store = resetDemoStore();
  const drainPath = "agent-installations/codex-installation-091/drain";
  const draining = await POST(request(drainPath, "POST", "PlatformAgentAdmin"), context(drainPath));
  assert.equal(draining.status, 201);
  assert.equal(store.installations.find((item) => item.id === "codex-installation-091")?.state, "DRAINING");
  assert.equal(store.rollouts["codex-installation-091"]?.percent, 0);
  assert.ok(store.installations.find((item) => item.id === "codex-installation-091")?.drainingAt);

  const moveDefaultPath = "agent-defaults/project:ember-archipelago";
  const moved = await PUT(
    request(moveDefaultPath, "PUT", "PlatformAgentAdmin", { profileRevisionId: "profile-claude-platform-r5" }),
    context(moveDefaultPath),
  );
  assert.equal(moved.status, 200);

  const retirePath = "agent-installations/codex-installation-091/retire";
  const retired = await POST(request(retirePath, "POST", "PlatformAgentAdmin"), context(retirePath));
  assert.equal(retired.status, 201);
  assert.equal(store.installations.find((item) => item.id === "codex-installation-091")?.state, "RETIRED");
  assert.ok(store.installations.find((item) => item.id === "codex-installation-091")?.retiredAt);

  resetDemoStore();
  const defaultDrainPath = "agent-installations/claude-installation-214/drain";
  assert.equal((await POST(request(defaultDrainPath, "POST", "PlatformAgentAdmin"), context(defaultDrainPath))).status, 201);
  const blocked = await POST(
    request("agent-installations/claude-installation-214/retire", "POST", "PlatformAgentAdmin"),
    context("agent-installations/claude-installation-214/retire"),
  );
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, "INSTALLATION_DEFAULT_STILL_REFERENCED");
});

test("local default selection rejects an active Profile whose Installation has not reached 100%", async () => {
  const store = resetDemoStore();
  const profile = store.profiles.find((item) => item.id === "profile-claude-platform-r5");
  const installation = store.installations.find((item) => item.id === "claude-installation-214");
  assert.ok(profile);
  assert.ok(installation);
  installation.state = "CANARY";
  installation.rolloutPercent = 25;
  installation.activatedAt = null;
  store.defaults.platform = "profile-codex-platform-r2";

  const response = await PUT(
    request("agent-defaults/platform", "PUT", "PlatformAgentAdmin", { profileRevisionId: profile.id }),
    context("agent-defaults/platform"),
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "PROFILE_NOT_SERVING_READY");
  assert.equal(store.defaults.platform, "profile-codex-platform-r2");
});

test("local rollout without a target degrades Profiles whose fallback chain would be broken", async () => {
  const store = resetDemoStore();
  const source = store.profiles.find((profile) => profile.id === "profile-claude-platform-r5");
  const dependentTemplate = store.profiles.find((profile) => profile.id === "profile-codex-platform-r2");
  assert.ok(source);
  assert.ok(dependentTemplate);
  const dependent = {
    ...dependentTemplate,
    id: "profile-local-fallback-dependent-r1",
    fallbackProfileRevisionId: source.id,
  };
  store.profiles.push(dependent);
  store.defaults["project:local-fallback"] = dependent.id;

  const path = "agent-rollouts/claude-installation-214/rollback";
  const response = await POST(request(path, "POST", "PlatformAgentAdmin"), context(path));
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).data.rollbackProfileRevisionIds, []);
  assert.equal(source.state, "DEGRADED");
  assert.equal(dependent.state, "DEGRADED");
  assert.equal(store.defaults.platform, source.id);
  assert.equal(store.defaults["project:local-fallback"], dependent.id);
});

test("Provider activation fails closed without its external trust gate", async () => {
  resetDemoStore();

  const draft = await POST(
    request("agent-profiles", "POST", "SecurityAdmin", {
      agent: "claude-code",
      baseUrl: "https://provider.example.com/v1",
      authentication: "x-api-key",
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
      primaryModel: "claude-sonnet-4-6-20250514",
      planningModel: "claude-opus-4-6-20250514",
      smallFastModel: "claude-haiku-4-5-20251001",
      subagentModel: "claude-sonnet-4-6-20250514",
      installationId: "claude-installation-214",
      credentialVersionId: "cred-claude-platform-v4",
      scope: "platform",
      scopeId: "global",
      dataRegion: "us-east",
      retentionPolicy: "zero application retention",
      trainingPolicy: "no training",
      maxBudgetUsd: 25,
      maxTurns: 100,
      timeoutSeconds: 7200,
    }),
    context("agent-profiles"),
  );
  assert.equal(draft.status, 201);
  const draftData = (await draft.json()).data;
  const profileId = draftData.profile.id;
  assert.deepEqual(draftData.provider.models, {
    primaryModel: "claude-sonnet-4-6-20250514",
    planningModel: "claude-opus-4-6-20250514",
    smallFastModel: "claude-haiku-4-5-20251001",
    subagentModel: "claude-sonnet-4-6-20250514",
  });
  assert.deepEqual(draftData.profile.budget, { maxUsd: 25, maxTurns: 100, timeoutSeconds: 7200 });
  assert.equal(draftData.provider.governance.dataRegion, "us-east");
  assert.equal(draftData.provider.governance.retentionPolicy, "zero application retention");
  assert.equal(draftData.provider.governance.trainingPolicy, "no training");
  assert.equal(draftData.provider.governance.confirmedBy, "SecurityAdmin");
  assert.ok(Number.isFinite(Date.parse(draftData.provider.governance.confirmedAt)));

  const validation = await POST(
    request(`agent-profiles/${profileId}/validate`, "POST", "SecurityAdmin"),
    context(`agent-profiles/${profileId}/validate`),
  );
  assert.equal(validation.status, 503);
  assert.equal((await validation.json()).error.code, "PROVIDER_PROBE_NOT_CONFIGURED");
  assert.equal(getDemoStore().profiles.find((item) => item.id === profileId)?.state, "DRAFT");
  assert.equal(getDemoStore().providers.find((item) => item.id === "provider-claude-platform-r3")?.state, "ACTIVE");
});

test("active Provider credential rotation fails closed and preserves the current default", async () => {
  const store = resetDemoStore();
  const activeCredentialId = "cred-claude-platform-v4";
  store.credentials.push({
    id: activeCredentialId,
    label: "Platform Claude",
    secretRef: `vault://kv/data/deviludo/${activeCredentialId}#4`,
    fingerprint: `sha256:${"a".repeat(64)}`,
    masked: `sha256:${"a".repeat(8)}…${"a".repeat(8)}`,
    version: 4,
    state: "ACTIVE",
    createdAt: "2026-07-18T08:42:00.000Z",
  });
  const defaultBefore = store.defaults.platform;

  const response = await POST(
    request(`credentials/${activeCredentialId}/rotate`, "POST", "SecurityAdmin", { apiKey: "replacement-local-key" }),
    context(`credentials/${activeCredentialId}/rotate`),
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "PROVIDER_PROBE_NOT_CONFIGURED");
  assert.equal(store.defaults.platform, defaultBefore);
  assert.equal(store.credentials.length, 1);
  assert.equal(store.credentials[0]?.state, "ACTIVE");
  assert.equal(store.providers.find((item) => item.id === "provider-claude-platform-r3")?.state, "ACTIVE");
  assert.equal(store.profiles.find((item) => item.id === defaultBefore)?.state, "ACTIVE");
});

test("simulated role headers cannot cross local admin RBAC boundaries", async () => {
  resetDemoStore();
  const forbidden = await POST(
    request("agent-rollouts/claude-installation-214/advance", "POST", "Auditor"),
    context("agent-rollouts/claude-installation-214/advance"),
  );
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, "FORBIDDEN");
  assert.equal(getDemoStore().rollouts["claude-installation-214"].percent, 100);
});

test("local admin never simulates an upstream inference billing reconciliation", async () => {
  const path = "inference-requests/44444444-4444-4444-8444-444444444444/reconcile";
  const payload = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    runId: "33333333-3333-4333-8333-333333333333",
    action: "CONFIRM_NO_USAGE",
    evidenceDigest: "b".repeat(64),
  };
  const forbidden = await POST(request(path, "POST", "PlatformAgentAdmin", payload), context(path));
  assert.equal(forbidden.status, 403);

  const gated = await POST(request(path, "POST", "SecurityAdmin", payload), context(path));
  assert.equal(gated.status, 503);
  assert.equal((await gated.json()).error.code, "INFERENCE_RECONCILIATION_GATEWAY_REQUIRED");

  const lookupPath = `inference-runs/${payload.tenantId}/${payload.runId}/reconciliation`;
  const lookupDenied = await GET(
    new Request(`http://127.0.0.1:3000/api/admin/${lookupPath}`, { headers: { "x-deviludo-role": "Auditor" } }),
    context(lookupPath),
  );
  assert.equal(lookupDenied.status, 403);
  const lookupGated = await GET(
    new Request(`http://127.0.0.1:3000/api/admin/${lookupPath}`, { headers: { "x-deviludo-role": "SecurityAdmin" } }),
    context(lookupPath),
  );
  assert.equal(lookupGated.status, 503);
  assert.equal((await lookupGated.json()).error.code, "INFERENCE_RECONCILIATION_GATEWAY_REQUIRED");
});

test("local admin never simulates specification model billing reconciliation", async () => {
  const generationOperationKey = "a".repeat(64);
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const path = `spec-model-generations/${generationOperationKey}/reconcile`;
  const payload = { tenantId, action: "CONFIRM_NO_USAGE", evidenceDigest: "b".repeat(64) };
  assert.equal((await POST(request(path, "POST", "PlatformAgentAdmin", payload), context(path))).status, 403);
  const gated = await POST(request(path, "POST", "SecurityAdmin", payload), context(path));
  assert.equal(gated.status, 503);
  assert.equal((await gated.json()).error.code, "SPEC_MODEL_RECONCILIATION_BROKER_REQUIRED");

  const lookupPath = `spec-model-generations/${tenantId}/${generationOperationKey}/reconciliation`;
  const lookupDenied = await GET(
    new Request(`http://127.0.0.1:3000/api/admin/${lookupPath}`, { headers: { "x-deviludo-role": "Auditor" } }),
    context(lookupPath),
  );
  assert.equal(lookupDenied.status, 403);
  const lookupGated = await GET(
    new Request(`http://127.0.0.1:3000/api/admin/${lookupPath}`, { headers: { "x-deviludo-role": "SecurityAdmin" } }),
    context(lookupPath),
  );
  assert.equal(lookupGated.status, 503);
  assert.equal((await lookupGated.json()).error.code, "SPEC_MODEL_RECONCILIATION_BROKER_REQUIRED");
});
