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
      adapterVersion: "1.1.0",
    },
  });
  assert.equal(installation.statusCode, 201);
  const installationId = installation.json().data.id as string;

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

  const audit = await inject({ method: "GET", url: "/admin/audit", role: "Auditor" });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.body.includes(plaintext), false);
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
