import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createAdminPrincipalSignature } from "../src/admin-principal";
import type { AdminRole } from "../src/contracts";
import { createControlPlaneApp } from "../src/bootstrap";

let app: NestFastifyApplication;
const adminSessionKey = Buffer.from("deviludo-control-plane-test-admin-session-key-2026", "utf8");

before(async () => {
  process.env.DEVILUDO_ADMIN_SESSION_HMAC_KEY = adminSessionKey.toString("base64");
  app = await createControlPlaneApp();
  await app.getHttpAdapter().getInstance().ready();
});

after(async () => {
  await app.close();
});

test("agent catalog is readable by an Auditor and defaults to Claude Code", async () => {
  const response = await inject({ method: "GET", url: "/admin/agents", role: "Auditor" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.data.catalog[0].id, "claude-code");
  assert.equal(body.data.catalog[0].platformDefault, true);
  assert.equal(body.data.catalog[1].id, "codex-cli");
  assert.equal(body.data.catalog[0].forbiddenOn.includes("e2e-runner"), true);
  assert.deepEqual(body.data.catalog.map((entry: { adapterId: string; adapterVersion: string; providerProtocol: string }) => ({
    adapterId: entry.adapterId,
    adapterVersion: entry.adapterVersion,
    providerProtocol: entry.providerProtocol,
  })), [
    { adapterId: "claude-code-v1", adapterVersion: "1.3.0", providerProtocol: "anthropic-messages" },
    { adapterId: "codex-cli-v1", adapterVersion: "1.2.2", providerProtocol: "openai-responses" },
  ]);
  assert.equal(body.data.catalog.every((entry: { registrySchemaVersion: string }) =>
    entry.registrySchemaVersion === "deviludo.agent-registry.v1"), true);
});

test("installation rejects an exact but unapproved Adapter before reserving a WorkerImage", async () => {
  const before = await inject({ method: "GET", url: "/admin/agents", role: "PlatformAgentAdmin" });
  const installationCount = before.json().data.catalog
    .flatMap((entry: { installations: unknown[] }) => entry.installations).length;
  const response = await inject({
    method: "POST",
    url: "/admin/agent-installations",
    role: "PlatformAgentAdmin",
    key: "reject-unregistered-adapter",
    payload: {
      agent: "codex-cli",
      version: "0.91.0",
      workerPool: "development-linux-unregistered-adapter",
      adapterVersion: "9.9.9",
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "ADAPTER_NOT_APPROVED");
  const after = await inject({ method: "GET", url: "/admin/agents", role: "PlatformAgentAdmin" });
  assert.equal(after.json().data.catalog.flatMap((entry: { installations: unknown[] }) => entry.installations).length, installationCount);
});

test("Agent console projection exposes usable public configuration without Vault references across scopes", async () => {
  const platform = await inject({ method: "GET", url: "/admin/agents", role: "SecurityAdmin" });
  assert.equal(platform.statusCode, 200);
  const data = platform.json().data;
  assert.equal(data.effectivePlatformDefaultAgent, "claude-code");
  assert.equal(data.profiles.some((profile: { state: string }) => profile.state === "ACTIVE"), true);
  assert.equal(data.credentials[0].maskedFingerprint.startsWith("sha256:"), true);
  assert.equal(platform.body.includes("secretRef"), false);
  assert.equal(platform.body.includes("vault://"), false);

  const tenant = await inject({ method: "GET", url: "/admin/agents", role: "TenantAdmin", tenantId: "tenant-scope-1" });
  assert.equal(tenant.statusCode, 200);
  assert.equal(tenant.json().data.profiles.every((profile: { scope: string; state: string }) => profile.scope !== "platform" || profile.state === "ACTIVE"), true);
  assert.deepEqual(tenant.json().data.credentials, []);
});

test("Agent defaults expose only the authenticated tenant and project even when scopes share a platform Profile", async () => {
  const catalog = await inject({ method: "GET", url: "/admin/agents", role: "SecurityAdmin" });
  const profileRevisionId = catalog.json().data.defaults.platform;
  const tenantId = "tenant-default-private-alpha";
  const projectId = "project-default-private-alpha";
  const tenantDefault = await inject({
    method: "PUT", url: `/admin/agent-defaults/tenant:${tenantId}`, role: "TenantAdmin", tenantId,
    key: "tenant-default-private-alpha", payload: { profileRevisionId },
  });
  assert.equal(tenantDefault.statusCode, 200);
  const projectDefault = await inject({
    method: "PUT", url: `/admin/agent-defaults/project:${projectId}`, role: "ProjectOwner", tenantId, projectId,
    key: "project-default-private-alpha", payload: { profileRevisionId },
  });
  assert.equal(projectDefault.statusCode, 200);

  const otherTenant = await inject({
    method: "GET", url: "/admin/agents", role: "TenantAdmin", tenantId: "tenant-default-private-bravo",
  });
  assert.deepEqual(Object.keys(otherTenant.json().data.defaults), ["platform"]);

  const owningTenant = await inject({ method: "GET", url: "/admin/agents", role: "TenantAdmin", tenantId });
  assert.deepEqual(owningTenant.json().data.defaults, {
    platform: profileRevisionId,
    [`tenant:${tenantId}`]: profileRevisionId,
  });

  const owningProject = await inject({ method: "GET", url: "/admin/agents", role: "ProjectOwner", tenantId, projectId });
  assert.deepEqual(owningProject.json().data.defaults, {
    platform: profileRevisionId,
    [`tenant:${tenantId}`]: profileRevisionId,
    [`project:${projectId}`]: profileRevisionId,
  });
});

test("mutations require RBAC and Idempotency-Key", async () => {
  const forbidden = await inject({
    method: "POST",
    url: "/admin/agent-versions/discover",
    role: "Auditor",
    payload: {},
  });
  assert.equal(forbidden.statusCode, 403);

  const missingKey = await inject({
    method: "POST",
    url: "/admin/agent-versions/discover",
    role: "PlatformAgentAdmin",
    payload: {},
  });
  assert.equal(missingKey.statusCode, 400);
  assert.equal(missingKey.json().error.code, "IDEMPOTENCY_KEY_REQUIRED");

  const first = await inject({
    method: "POST",
    url: "/admin/agent-versions/discover",
    role: "PlatformAgentAdmin",
    key: "idempotency-body-binding",
    payload: { agent: "claude-code", version: "2.1.16" },
  });
  assert.equal(first.statusCode, 201);
  const conflict = await inject({
    method: "POST",
    url: "/admin/agent-versions/discover",
    role: "PlatformAgentAdmin",
    key: "idempotency-body-binding",
    payload: { agent: "claude-code", version: "2.1.17" },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, "IDEMPOTENCY_KEY_REUSED");
});

test("admin mutation contracts reject unknown fields without persisting or echoing them", async () => {
  const secret = "unknown-field-secret-must-not-be-echoed";
  const credential = await inject({
    method: "POST",
    url: "/admin/credentials",
    role: "SecurityAdmin",
    key: "strict-credential-contract",
    payload: { label: "Strict contract", apiKey: "valid-secret-value", credentialId: secret },
  });
  assert.equal(credential.statusCode, 400);
  assert.equal(credential.json().error.code, "UNEXPECTED_FIELD");
  assert.equal(credential.body.includes(secret), false);

  const legacyProfile = await inject({
    method: "POST",
    url: "/admin/agent-profiles",
    role: "SecurityAdmin",
    key: "strict-profile-contract",
    payload: { credentialId: "legacy-id", budgetUsd: 10 },
  });
  assert.equal(legacyProfile.statusCode, 400);
  assert.equal(legacyProfile.json().error.code, "UNEXPECTED_FIELD");

  const rollout = await inject({
    method: "POST",
    url: "/admin/agent-rollouts/claude-code-installation-2-1-14/advance",
    role: "PlatformAgentAdmin",
    key: "strict-rollout-contract",
    payload: { toPercent: 100 },
  });
  assert.equal(rollout.statusCode, 400);
  assert.equal(rollout.json().error.code, "UNEXPECTED_FIELD");
});

test("admin API rejects unsigned, forged, expired and route-replayed principal assertions", async () => {
  const unsigned = await app.getHttpAdapter().getInstance().inject({
    method: "GET",
    url: "/admin/agents",
    headers: { "x-deviludo-role": "Auditor", "x-deviludo-actor": "test-admin" },
  });
  assert.equal(unsigned.statusCode, 401);
  assert.equal(unsigned.json().error.code, "ADMIN_SESSION_INVALID");

  const forgedHeaders = adminHeaders("GET", "/admin/agents", "SecurityAdmin");
  forgedHeaders["x-deviludo-admin-signature"] = "invalid-signature";
  const forged = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/admin/agents", headers: forgedHeaders });
  assert.equal(forged.statusCode, 401);

  const expiredHeaders = adminHeaders("GET", "/admin/agents", "Auditor", {
    issuedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  });
  const expired = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/admin/agents", headers: expiredHeaders });
  assert.equal(expired.statusCode, 401);

  const replayedPath = await app.getHttpAdapter().getInstance().inject({
    method: "GET",
    url: "/admin/agent-health",
    headers: adminHeaders("GET", "/admin/agents", "Auditor"),
  });
  assert.equal(replayedPath.statusCode, 401);
});

test("exact Agent supply-chain and canary routes are independently injectable", async () => {
  const discover = await inject({
    method: "POST",
    url: "/admin/agent-versions/discover",
    role: "PlatformAgentAdmin",
    key: "discover-codex-092",
    payload: { agent: "codex-cli", version: "0.92.0" },
  });
  assert.equal(discover.statusCode, 201);

  const approve = await inject({
    method: "POST",
    url: "/admin/agent-versions/approve",
    role: "PlatformAgentAdmin",
    key: "approve-codex-092",
    payload: { id: "codex-cli@0.92.0" },
  });
  assert.equal(approve.statusCode, 201);
  assert.equal(approve.json().data.version.state, "APPROVED");

  const installation = await inject({
    method: "POST",
    url: "/admin/agent-installations",
    role: "PlatformAgentAdmin",
    key: "install-codex-092",
    payload: {
      agent: "codex-cli",
      version: "0.92.0",
      workerPool: "development-linux-canary",
      adapterVersion: "1.2.2",
    },
  });
  assert.equal(installation.statusCode, 201);
  const installationId = installation.json().data.id as string;

  const deprecated = await inject({
    method: "POST",
    url: "/admin/agent-versions/deprecate",
    role: "PlatformAgentAdmin",
    key: "deprecate-codex-092",
    payload: { id: "codex-cli@0.92.0" },
  });
  assert.equal(deprecated.statusCode, 201);
  assert.equal(deprecated.json().data.version.state, "DEPRECATED");
  assert.equal(deprecated.json().data.existingInstallationsAffected, false);

  const deniedNewInstallation = await inject({
    method: "POST",
    url: "/admin/agent-installations",
    role: "PlatformAgentAdmin",
    key: "install-codex-092-after-deprecation",
    payload: {
      agent: "codex-cli",
      version: "0.92.0",
      workerPool: "development-linux-next",
      adapterVersion: "1.2.2",
    },
  });
  assert.equal(deniedNewInstallation.statusCode, 409);
  assert.equal(deniedNewInstallation.json().error.code, "VERSION_NOT_APPROVED");

  for (const [index, expected] of [5, 25, 100].entries()) {
    const rollout = await inject({
      method: "POST",
      url: `/admin/agent-rollouts/${installationId}/advance`,
      role: "PlatformAgentAdmin",
      key: `advance-codex-${index}`,
      payload: {},
    });
    assert.equal(rollout.statusCode, 201);
    assert.equal(rollout.json().data.installation.rolloutPercent, expected);
  }

  const replay = await inject({
    method: "POST",
    url: `/admin/agent-rollouts/${installationId}/advance`,
    role: "PlatformAgentAdmin",
    key: "advance-codex-2",
    payload: {},
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["idempotent-replayed"], "true");
  assert.equal(replay.json().meta.idempotentReplay, true);

});

test("an active Profile can reuse its approved Provider while rebinding to an upgraded Installation", async () => {
  for (const [url, key, payload] of [
    ["/admin/agent-versions/discover", "discover-claude-profile-rebind", { agent: "claude-code", version: "2.1.19" }],
    ["/admin/agent-versions/approve", "approve-claude-profile-rebind", { id: "claude-code@2.1.19" }],
  ] as const) {
    const response = await inject({ method: "POST", url, role: "PlatformAgentAdmin", key, payload });
    assert.equal(response.statusCode, 201, response.body);
  }
  const installation = await inject({
    method: "POST",
    url: "/admin/agent-installations",
    role: "PlatformAgentAdmin",
    key: "install-claude-profile-rebind",
    payload: {
      agent: "claude-code",
      version: "2.1.19",
      workerPool: "development-linux-profile-rebind",
      adapterVersion: "1.3.0",
    },
  });
  assert.equal(installation.statusCode, 201, installation.body);
  const installationId = installation.json().data.id as string;
  for (const [index, expected] of [5, 25, 100].entries()) {
    const rollout = await inject({
      method: "POST",
      url: `/admin/agent-rollouts/${installationId}/advance`,
      role: "PlatformAgentAdmin",
      key: `advance-claude-profile-rebind-${index}`,
      payload: {},
    });
    assert.equal(rollout.statusCode, 201, rollout.body);
    assert.equal(rollout.json().data.installation.rolloutPercent, expected);
  }

  const sourceProfileId = "profile-platform-claude-r1";
  const rebound = await inject({
    method: "POST",
    url: `/admin/agent-profiles/${sourceProfileId}/rebind-installation`,
    role: "PlatformAgentAdmin",
    key: "rebind-claude-profile-installation",
    payload: { installationId },
  });
  assert.equal(rebound.statusCode, 201, rebound.body);
  const reboundData = rebound.json().data;
  const reboundProfileId = reboundData.profile.id as string;
  assert.equal(reboundData.profile.state, "READY");
  assert.equal(reboundData.profile.installationId, installationId);
  assert.equal(reboundData.profile.providerRevisionId, "provider-platform-claude-r1");
  assert.equal(reboundData.provider.state, "ACTIVE");
  assert.equal(reboundData.sourceProfileRevisionId, sourceProfileId);
  assert.equal(reboundData.providerReused, true);
  assert.equal(reboundData.requiresSecurityActivation, true);
  assert.equal(reboundData.defaultsChanged, false);
  assert.equal(reboundData.affectsQueuedOrRunningTasks, false);

  const beforeActivation = await inject({ method: "GET", url: "/admin/agents", role: "SecurityAdmin" });
  assert.equal(beforeActivation.json().data.defaults.platform, sourceProfileId);
  assert.equal(beforeActivation.json().data.profiles.find((item: { id: string }) => item.id === sourceProfileId).state, "ACTIVE");

  const denied = await inject({
    method: "POST",
    url: `/admin/agent-profiles/${reboundProfileId}/activate`,
    role: "PlatformAgentAdmin",
    key: "activate-rebound-profile-denied",
    payload: {},
  });
  assert.equal(denied.statusCode, 403);
  const activated = await inject({
    method: "POST",
    url: `/admin/agent-profiles/${reboundProfileId}/activate`,
    role: "SecurityAdmin",
    key: "activate-rebound-profile",
    payload: {},
  });
  assert.equal(activated.statusCode, 201, activated.body);
  assert.equal(activated.json().data.profile.state, "ACTIVE");
  assert.equal(activated.json().data.provider.state, "ACTIVE");

  const selected = await inject({
    method: "PUT",
    url: "/admin/agent-defaults/platform",
    role: "PlatformAgentAdmin",
    key: "select-rebound-profile",
    payload: { profileRevisionId: reboundProfileId },
  });
  assert.equal(selected.statusCode, 200, selected.body);
  assert.equal(selected.json().data.newTasksOnly, true);
  const restored = await inject({
    method: "PUT",
    url: "/admin/agent-defaults/platform",
    role: "PlatformAgentAdmin",
    key: "restore-source-profile-after-rebind-test",
    payload: { profileRevisionId: sourceProfileId },
  });
  assert.equal(restored.statusCode, 200, restored.body);

  const disabled = await inject({
    method: "POST",
    url: `/admin/agent-profiles/${reboundProfileId}/disable`,
    role: "PlatformAgentAdmin",
    key: "disable-rebound-profile",
    payload: {},
  });
  assert.equal(disabled.statusCode, 201, disabled.body);
  assert.equal(disabled.json().data.profile.state, "DISABLED");
  assert.equal(disabled.json().data.provider.state, "ACTIVE", "shared Provider must remain active for the source Profile");
});

test("credentials never echo plaintext and Provider activation is a separate security gate", async () => {
  const plaintext = "fixture-secret-that-must-never-be-returned";
  const credential = await inject({
    method: "POST",
    url: "/admin/credentials",
    role: "SecurityAdmin",
    key: "credential-codex-create",
    payload: { label: "Codex production gateway", apiKey: plaintext },
  });
  assert.equal(credential.statusCode, 201);
  assert.equal(credential.body.includes(plaintext), false);
  assert.equal(credential.body.includes("secretRef"), false);
  assert.match(credential.json().data.maskedFingerprint, /^sha256:/);
  const credentialId = credential.json().data.id as string;

  const catalog = await inject({ method: "GET", url: "/admin/agents", role: "SecurityAdmin" });
  const codex = catalog.json().data.catalog.find((item: { id: string }) => item.id === "codex-cli");
  const installationId = codex.installations[0].id as string;

  const draft = await inject({
    method: "POST",
    url: "/admin/agent-profiles",
    role: "PlatformAgentAdmin",
    key: "profile-codex-create",
    payload: {
      scope: "platform",
      scopeId: "global",
      agent: "codex-cli",
      installationId,
      credentialVersionId: credentialId,
      baseUrl: "https://responses.example.com/v1",
      authentication: "bearer",
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 10,
      primaryModel: "gpt-5.3-codex-2026-06-12",
      maxBudgetUsd: 20,
      maxTurns: 80,
      timeoutSeconds: 3600,
      dataRegion: "us-east",
      retentionPolicy: "zero-day application retention",
      trainingPolicy: "no training",
    },
  });
  assert.equal(draft.statusCode, 201);
  assert.equal(draft.json().data.provider.protocol, "openai-responses");
  const profileId = draft.json().data.profile.id as string;

  const validate = await inject({
    method: "POST",
    url: `/admin/agent-profiles/${profileId}/validate`,
    role: "PlatformAgentAdmin",
    key: "profile-codex-validate",
    payload: {},
  });
  assert.equal(validate.statusCode, 201);
  assert.equal(validate.json().data.profile.state, "READY");

  const deniedActivation = await inject({
    method: "POST",
    url: `/admin/agent-profiles/${profileId}/activate`,
    role: "PlatformAgentAdmin",
    key: "profile-codex-activate-denied",
    payload: {},
  });
  assert.equal(deniedActivation.statusCode, 403);

  const activate = await inject({
    method: "POST",
    url: `/admin/agent-profiles/${profileId}/activate`,
    role: "SecurityAdmin",
    key: "profile-codex-activate",
    payload: {},
  });
  assert.equal(activate.statusCode, 201);
  assert.equal(activate.json().data.profile.state, "ACTIVE");

  const makeDefault = await inject({
    method: "PUT",
    url: "/admin/agent-defaults/platform",
    role: "PlatformAgentAdmin",
    key: "platform-default-codex",
    payload: { profileRevisionId: profileId },
  });
  assert.equal(makeDefault.statusCode, 200);
  assert.equal(makeDefault.json().data.newTasksOnly, true);

  const rotatedPlaintext = "fixture-rotated-secret-that-must-never-be-returned";
  const rotate = await inject({
    method: "POST",
    url: `/admin/credentials/${credentialId}/rotate`,
    role: "SecurityAdmin",
    key: "credential-codex-rotate",
    payload: { apiKey: rotatedPlaintext },
  });
  assert.equal(rotate.statusCode, 201);
  assert.equal(rotate.body.includes(rotatedPlaintext), false);
  assert.equal(rotate.body.includes("secretRef"), false);
  assert.equal(rotate.body.includes("operationKey"), false);
  assert.equal(rotate.body.includes("rotationBindings"), false);
  assert.equal(rotate.json().data.previous.state, "PREVIOUS");
  assert.equal(rotate.json().data.active.state, "ACTIVE");
  assert.ok(Number.isFinite(Date.parse(rotate.json().data.active.rotatedAt)));
  assert.equal(rotate.json().data.previous.rotatedAt, rotate.json().data.active.rotatedAt);
  assert.equal(rotate.json().data.oldVersionNoLongerIssued, true);
  assert.equal(rotate.json().data.successorProfileRevisionIds.length > 0, true);

  const rotatedCatalog = await inject({ method: "GET", url: "/admin/agents", role: "SecurityAdmin" });
  assert.equal(rotatedCatalog.body.includes("operationKey"), false);
  const successorProfileId = rotate.json().data.successorProfileRevisionIds[0] as string;
  assert.equal(rotatedCatalog.json().data.platformDefault, successorProfileId);
  assert.equal(rotatedCatalog.json().data.profiles.find((item: { id: string }) => item.id === profileId).state, "SUPERSEDED");
  const successor = rotatedCatalog.json().data.profiles.find((item: { id: string }) => item.id === successorProfileId);
  assert.equal(successor.state, "ACTIVE");
  assert.equal(successor.credentialVersionId, rotate.json().data.active.id);
  const catalogCredentials = rotatedCatalog.json().data.credentials as Array<{ id: string; rotatedAt: string | null }>;
  assert.equal(catalogCredentials.find((item) => item.id === credentialId)?.rotatedAt, rotate.json().data.active.rotatedAt);
  assert.equal(catalogCredentials.find((item) => item.id === rotate.json().data.active.id)?.rotatedAt, rotate.json().data.active.rotatedAt);

  const revokePrevious = await inject({
    method: "POST",
    url: `/admin/credentials/${credentialId}/revoke`,
    role: "SecurityAdmin",
    key: "credential-codex-revoke-previous",
    payload: {},
  });
  assert.equal(revokePrevious.statusCode, 201);
  assert.equal(revokePrevious.json().data.state, "REVOKED");
  const afterRevoke = await inject({ method: "GET", url: "/admin/agents", role: "SecurityAdmin" });
  assert.equal(afterRevoke.json().data.credentials.find((item: { id: string }) => item.id === credentialId).state, "REVOKED");
  assert.equal(afterRevoke.json().data.credentials.find((item: { id: string }) => item.id === rotate.json().data.active.id).state, "ACTIVE");

  const audit = await inject({ method: "GET", url: "/admin/audit", role: "Auditor" });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.body.includes(plaintext), false);
  assert.equal(audit.body.includes(rotatedPlaintext), false);
});

test("tenant and project administrators cannot cross signed scope or BYOK boundaries", async () => {
  const tenantCredential = await inject({
    method: "POST",
    url: "/admin/credentials",
    role: "TenantAdmin",
    tenantId: "tenant-alpha",
    key: "tenant-alpha-credential",
    payload: { label: "Tenant Alpha Claude BYOK", apiKey: "tenant-alpha-secret-material" },
  });
  assert.equal(tenantCredential.statusCode, 201);
  assert.equal(tenantCredential.json().data.scope, "tenant");
  assert.equal(tenantCredential.json().data.scopeId, "tenant-alpha");
  const credentialId = tenantCredential.json().data.id as string;

  const ownProfile = await inject({
    method: "POST",
    url: "/admin/agent-profiles",
    role: "TenantAdmin",
    tenantId: "tenant-alpha",
    key: "tenant-alpha-profile",
    payload: {
      scope: "tenant",
      scopeId: "tenant-alpha",
      agent: "claude-code",
      installationId: "claude-code-installation-2-1-14",
      credentialVersionId: credentialId,
      baseUrl: "https://tenant-alpha-gateway.example.com/v1",
      authentication: "x-api-key",
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
      primaryModel: "claude-sonnet-4-6-20250514",
      dataRegion: "eu-west",
      retentionPolicy: "zero retention",
      trainingPolicy: "no training",
    },
  });
  assert.equal(ownProfile.statusCode, 201);
  assert.equal(ownProfile.json().data.profile.scopeId, "tenant-alpha");

  const crossTenantProfile = await inject({
    method: "POST",
    url: "/admin/agent-profiles",
    role: "TenantAdmin",
    tenantId: "tenant-beta",
    key: "tenant-beta-cross-profile",
    payload: {
      scope: "tenant",
      scopeId: "tenant-alpha",
      agent: "claude-code",
      installationId: "claude-code-installation-2-1-14",
      credentialVersionId: credentialId,
      baseUrl: "https://tenant-beta-gateway.example.com/v1",
      primaryModel: "claude-sonnet-4-6-20250514",
      dataRegion: "us-west",
      retentionPolicy: "zero retention",
      trainingPolicy: "no training",
    },
  });
  assert.equal(crossTenantProfile.statusCode, 403);
  assert.equal(crossTenantProfile.json().error.code, "SCOPE_FORBIDDEN");

  const crossTenantRotation = await inject({
    method: "POST",
    url: `/admin/credentials/${credentialId}/rotate`,
    role: "TenantAdmin",
    tenantId: "tenant-beta",
    key: "tenant-beta-cross-rotation",
    payload: { apiKey: "tenant-beta-must-not-replace-alpha" },
  });
  assert.equal(crossTenantRotation.statusCode, 403);
  assert.equal(crossTenantRotation.json().error.code, "CREDENTIAL_SCOPE_FORBIDDEN");

  const crossProject = await inject({
    method: "PUT",
    url: "/admin/agent-defaults/project:project-alpha",
    role: "ProjectOwner",
    tenantId: "tenant-alpha",
    projectId: "project-beta",
    key: "project-beta-cross-default",
    payload: { profileRevisionId: ownProfile.json().data.profile.id },
  });
  assert.equal(crossProject.statusCode, 403);
  assert.equal(crossProject.json().error.code, "SCOPE_FORBIDDEN");

  const alphaAudit = await inject({
    method: "GET",
    url: "/admin/audit",
    role: "TenantAdmin",
    tenantId: "tenant-alpha",
  });
  assert.equal(alphaAudit.statusCode, 200);
  assert.equal(alphaAudit.json().data.length > 0, true);
  assert.equal(alphaAudit.json().data.every((record: { tenantId: string | null }) => record.tenantId === "tenant-alpha"), true);
  assert.equal(alphaAudit.body.includes("tenant-beta"), false);
});

test("project selection can pin an active inherited Profile without copying Provider credentials", async () => {
  const catalog = await inject({ method: "GET", url: "/admin/agents", role: "ProjectOwner", tenantId: "tenant-alpha", projectId: "project-alpha" });
  assert.equal(catalog.statusCode, 200);
  const inherited = catalog.json().data.profiles.find((profile: { scope: string; state: string }) => profile.scope === "platform" && profile.state === "ACTIVE");
  assert.ok(inherited);

  const selected = await inject({
    method: "PUT",
    url: "/admin/agent-defaults/project:project-alpha",
    role: "ProjectOwner",
    tenantId: "tenant-alpha",
    projectId: "project-alpha",
    key: "project-alpha-inherited-profile",
    payload: { profileRevisionId: inherited.id },
  });
  assert.equal(selected.statusCode, 200, selected.body);
  assert.equal(selected.json().data.profileRevisionId, inherited.id);

  const otherTenant = await inject({
    method: "PUT",
    url: "/admin/agent-defaults/project:project-alpha",
    role: "ProjectOwner",
    tenantId: "tenant-beta",
    projectId: "project-alpha",
    key: "project-alpha-other-tenant-profile",
    payload: { profileRevisionId: "profile-tenant-tenant-alpha-1-r1" },
  });
  assert.equal(otherTenant.statusCode, 409);
  assert.equal(otherTenant.json().error.code, "PROFILE_NOT_ACTIVE");
});

test("an active tenant Profile is selectable only by projects in that signed tenant", async () => {
  const tenantId = "tenant-inherited-alpha";
  const credential = await inject({ method: "POST", url: "/admin/credentials", role: "TenantAdmin", tenantId,
    key: "tenant-inherited-credential", payload: { label: "Inherited Claude", apiKey: "tenant-inherited-secret" } });
  assert.equal(credential.statusCode, 201);
  const draft = await inject({
    method: "POST", url: "/admin/agent-profiles", role: "TenantAdmin", tenantId,
    key: "tenant-inherited-profile", payload: {
      scope: "tenant", scopeId: tenantId, agent: "claude-code",
      installationId: "claude-code-installation-2-1-14", credentialVersionId: credential.json().data.id,
      baseUrl: "https://tenant-inherited.example.com/v1", authentication: "x-api-key",
      inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15,
      primaryModel: "claude-sonnet-4-6-20250514", dataRegion: "eu-west",
      retentionPolicy: "zero retention", trainingPolicy: "no training",
    },
  });
  assert.equal(draft.statusCode, 201);
  const profileId = draft.json().data.profile.id as string;
  const validated = await inject({ method: "POST", url: `/admin/agent-profiles/${profileId}/validate`,
    role: "TenantAdmin", tenantId, key: "tenant-inherited-validate", payload: {} });
  assert.equal(validated.statusCode, 201);
  const activated = await inject({ method: "POST", url: `/admin/agent-profiles/${profileId}/activate`,
    role: "SecurityAdmin", key: "tenant-inherited-activate", payload: {} });
  assert.equal(activated.statusCode, 201);

  const ownProject = await inject({ method: "PUT", url: "/admin/agent-defaults/project:project-inherited-alpha",
    role: "ProjectOwner", tenantId, projectId: "project-inherited-alpha", key: "project-inherited-own",
    payload: { profileRevisionId: profileId } });
  assert.equal(ownProject.statusCode, 200);

  const foreignProject = await inject({ method: "PUT", url: "/admin/agent-defaults/project:project-inherited-beta",
    role: "ProjectOwner", tenantId: "tenant-inherited-beta", projectId: "project-inherited-beta", key: "project-inherited-cross",
    payload: { profileRevisionId: profileId } });
  assert.equal(foreignProject.statusCode, 409);
  assert.equal(foreignProject.json().error.code, "PROFILE_SCOPE_MISMATCH");
});

test("idempotency results are isolated by the signed tenant and project scope", async () => {
  const shared = {
    method: "POST" as const,
    url: "/admin/credentials",
    role: "TenantAdmin",
    key: "same-user-same-idempotency-key",
    payload: { label: "Scoped BYOK", apiKey: "same-fixture-body-for-scope-test" },
  };
  const alpha = await inject({ ...shared, tenantId: "tenant-idempotency-alpha" });
  const beta = await inject({ ...shared, tenantId: "tenant-idempotency-beta" });
  assert.equal(alpha.statusCode, 201);
  assert.equal(beta.statusCode, 201);
  assert.equal(alpha.json().data.scopeId, "tenant-idempotency-alpha");
  assert.equal(beta.json().data.scopeId, "tenant-idempotency-beta");
  assert.notEqual(alpha.json().data.id, beta.json().data.id);

  const alphaReplay = await inject({ ...shared, tenantId: "tenant-idempotency-alpha" });
  assert.equal(alphaReplay.statusCode, 200);
  assert.equal(alphaReplay.headers["idempotent-replayed"], "true");
  assert.equal(alphaReplay.json().data.id, alpha.json().data.id);
});

test("local admin boundary allows only SecurityAdmin and fails closed without a reconciliation Gateway", async () => {
  const requestId = "44444444-4444-4444-8444-444444444444";
  const payload = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    runId: "33333333-3333-4333-8333-333333333333",
    action: "RECORD_USAGE",
    evidenceDigest: "b".repeat(64),
    inputTokens: 120,
    outputTokens: 30,
  };
  const denied = await inject({
    method: "POST",
    url: `/admin/inference-requests/${requestId}/reconcile`,
    role: "PlatformAgentAdmin",
    key: "inference-reconcile-denied",
    payload,
  });
  assert.equal(denied.statusCode, 403);

  const unavailable = await inject({
    method: "POST",
    url: `/admin/inference-requests/${requestId}/reconcile`,
    role: "SecurityAdmin",
    key: "inference-reconcile-recorded-usage",
    payload,
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().error.code, "INFERENCE_RECONCILIATION_UNAVAILABLE");

  const lookupPath = `/admin/inference-runs/${payload.tenantId}/${payload.runId}/reconciliation`;
  const lookupDenied = await inject({ method: "GET", url: lookupPath, role: "Auditor" });
  assert.equal(lookupDenied.statusCode, 403);
  const lookupUnavailable = await inject({ method: "GET", url: lookupPath, role: "SecurityAdmin" });
  assert.equal(lookupUnavailable.statusCode, 503);
  assert.equal(lookupUnavailable.json().error.code, "INFERENCE_RECONCILIATION_UNAVAILABLE");
});

test("specification model reconciliation is SecurityAdmin-only and fails closed without its Broker", async () => {
  const generationOperationKey = "a".repeat(64);
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const payload = {
    tenantId, action: "CONFIRM_NO_USAGE", evidenceDigest: "b".repeat(64),
  };
  const denied = await inject({
    method: "POST", url: `/admin/spec-model-generations/${generationOperationKey}/reconcile`,
    role: "PlatformAgentAdmin", key: "spec-model-reconcile-denied", payload,
  });
  assert.equal(denied.statusCode, 403);
  const unavailable = await inject({
    method: "POST", url: `/admin/spec-model-generations/${generationOperationKey}/reconcile`,
    role: "SecurityAdmin", key: "spec-model-reconcile-unavailable", payload,
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().error.code, "SPEC_MODEL_RECONCILIATION_UNAVAILABLE");

  const lookup = `/admin/spec-model-generations/${tenantId}/${generationOperationKey}/reconciliation`;
  assert.equal((await inject({ method: "GET", url: lookup, role: "Auditor" })).statusCode, 403);
  const lookupUnavailable = await inject({ method: "GET", url: lookup, role: "SecurityAdmin" });
  assert.equal(lookupUnavailable.statusCode, 503);
  assert.equal(lookupUnavailable.json().error.code, "SPEC_MODEL_RECONCILIATION_UNAVAILABLE");
});

test("unsafe Provider endpoints and floating models are rejected", async () => {
  const response = await inject({
    method: "POST",
    url: "/admin/agent-profiles",
    role: "PlatformAgentAdmin",
    key: "profile-unsafe-endpoint",
    payload: {
      scope: "platform",
      scopeId: "global",
      agent: "claude-code",
      installationId: "claude-code-installation-2-1-14",
      credentialVersionId: "credential-platform-claude-v1",
      baseUrl: "https://127.0.0.1/v1?api_key=secret",
      primaryModel: "latest",
      dataRegion: "local",
      retentionPolicy: "unknown",
      trainingPolicy: "unknown",
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "PROVIDER_ENDPOINT_REJECTED");
  assert.equal(response.body.includes("api_key=secret"), false);
});

test("Provider pricing and authentication must be explicit and protocol compatible", async () => {
  const incompatible = await inject({
    method: "POST",
    url: "/admin/agent-profiles",
    role: "PlatformAgentAdmin",
    key: "profile-incompatible-auth",
    payload: {
      scope: "platform", scopeId: "global", agent: "codex-cli",
      installationId: "codex-cli-installation-0-91-0",
      credentialVersionId: "credential-platform-claude-v1",
      baseUrl: "https://responses.example.com/v1",
      authentication: "x-api-key",
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 10,
      primaryModel: "gpt-5.3-codex-2026-06-12",
      dataRegion: "us-east", retentionPolicy: "zero retention", trainingPolicy: "no training",
    },
  });
  assert.equal(incompatible.statusCode, 400);
  assert.equal(incompatible.json().error.code, "PROVIDER_AUTHENTICATION_REJECTED");

  const missingPricing = await inject({
    method: "POST",
    url: "/admin/agent-profiles",
    role: "PlatformAgentAdmin",
    key: "profile-missing-pricing",
    payload: {
      scope: "platform", scopeId: "global", agent: "claude-code",
      installationId: "claude-code-installation-2-1-14",
      credentialVersionId: "credential-platform-claude-v1",
      baseUrl: "https://gateway.anthropic.example.com/v1",
      authentication: "x-api-key",
      primaryModel: "claude-sonnet-4-6-20250514",
      dataRegion: "us-east", retentionPolicy: "zero retention", trainingPolicy: "no training",
    },
  });
  assert.equal(missingPricing.statusCode, 400);
  assert.equal(missingPricing.json().error.code, "PROVIDER_PRICING_REJECTED");
});

test("Agent Installation drain and retirement preserve pinned runs while fencing new work", async () => {
  for (const [url, key, payload] of [
    ["/admin/agent-versions/discover", "discover-claude-lifecycle", { agent: "claude-code", version: "2.1.18" }],
    ["/admin/agent-versions/approve", "approve-claude-lifecycle", { id: "claude-code@2.1.18" }],
  ] as const) {
    const response = await inject({ method: "POST", url, role: "PlatformAgentAdmin", key, payload });
    assert.equal(response.statusCode, 201);
  }
  const created = await inject({
    method: "POST", url: "/admin/agent-installations", role: "PlatformAgentAdmin", key: "install-claude-lifecycle",
    payload: { agent: "claude-code", version: "2.1.18", workerPool: "development-linux-lifecycle", adapterVersion: "1.3.0" },
  });
  assert.equal(created.statusCode, 201);
  const installationId = created.json().data.id as string;
  for (const [index, expected] of [5, 25, 100].entries()) {
    const advanced = await inject({
      method: "POST", url: `/admin/agent-rollouts/${installationId}/advance`, role: "PlatformAgentAdmin",
      key: `advance-claude-lifecycle-${index}`, payload: {},
    });
    assert.equal(advanced.statusCode, 201);
    assert.equal(advanced.json().data.installation.rolloutPercent, expected);
  }
  const draining = await inject({
    method: "POST", url: `/admin/agent-installations/${installationId}/drain`, role: "PlatformAgentAdmin",
    key: "drain-claude-lifecycle", payload: {},
  });
  assert.equal(draining.statusCode, 201);
  assert.equal(draining.json().data.installation.state, "DRAINING");
  assert.equal(draining.json().data.installation.rolloutPercent, 0);
  assert.ok(draining.json().data.installation.drainingAt);
  const retired = await inject({
    method: "POST", url: `/admin/agent-installations/${installationId}/retire`, role: "PlatformAgentAdmin",
    key: "retire-claude-lifecycle", payload: {},
  });
  assert.equal(retired.statusCode, 201);
  assert.equal(retired.json().data.installation.state, "RETIRED");
  assert.ok(retired.json().data.installation.retiredAt);
});

interface InjectInput {
  method: "GET" | "POST" | "PUT";
  url: string;
  role: string;
  tenantId?: string;
  projectId?: string;
  key?: string;
  payload?: Record<string, unknown>;
}

async function inject(input: InjectInput) {
  return app.getHttpAdapter().getInstance().inject({
    method: input.method,
    url: input.url,
    headers: {
      ...adminHeaders(input.method, input.url, input.role as AdminRole, {
        tenantId: input.tenantId,
        projectId: input.projectId,
      }),
      ...(input.key ? { "idempotency-key": input.key } : {}),
    },
    payload: input.payload,
  });
}

function adminHeaders(
  method: string,
  path: string,
  role: AdminRole,
  options: { issuedAt?: string; tenantId?: string; projectId?: string } = {},
): Record<string, string> {
  const issuedAt = options.issuedAt ?? new Date().toISOString();
  const assertion = {
    method,
    path,
    actorId: "test-admin",
    role,
    tenantId: options.tenantId ?? null,
    projectId: options.projectId ?? null,
    sessionId: "test-admin-session",
    issuedAt,
  } as const;
  return {
    "x-deviludo-role": role,
    "x-deviludo-actor": assertion.actorId,
    "x-deviludo-admin-session": assertion.sessionId,
    "x-deviludo-admin-issued-at": assertion.issuedAt,
    "x-deviludo-admin-signature": createAdminPrincipalSignature(assertion, adminSessionKey),
    ...(options.tenantId ? { "x-deviludo-tenant-id": options.tenantId } : {}),
    ...(options.projectId ? { "x-deviludo-project-id": options.projectId } : {}),
  };
}
