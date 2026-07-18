import assert from "node:assert/strict";
import test from "node:test";
import { resolveCatalogConfiguration } from "../src/catalog";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

test("Agent catalog resolves project, tenant and platform defaults in strict precedence order", () => {
  const platform = resolveCatalogConfiguration({ revision: "7", payload: catalog(), tenantId, projectId });
  assert.equal(platform.profileRevisionId, "profile-platform-r1");
  assert.equal(platform.profileSource, "platform");
  assert.equal(platform.agent, "claude-code");
  assert.equal(platform.providerProtocol, "anthropic-messages");

  const tenantPayload = catalog();
  tenantPayload.profiles.push(profile("profile-tenant-r1", "tenant", tenantId));
  tenantPayload.defaults.push([`tenant:${tenantId}`, "profile-tenant-r1"]);
  tenantPayload.credentials[0]!.scope = "tenant";
  tenantPayload.credentials[0]!.scopeId = tenantId;
  const tenant = resolveCatalogConfiguration({ revision: 8, payload: tenantPayload, tenantId, projectId });
  assert.equal(tenant.profileRevisionId, "profile-tenant-r1");
  assert.equal(tenant.profileSource, `tenant:${tenantId}`);

  const projectPayload = structuredClone(tenantPayload);
  projectPayload.profiles.push(profile("profile-project-r1", "project", projectId));
  projectPayload.defaults.push([`project:${projectId}`, "profile-project-r1"]);
  const project = resolveCatalogConfiguration({ revision: "9", payload: projectPayload, tenantId, projectId });
  assert.equal(project.profileRevisionId, "profile-project-r1");
  assert.equal(project.profileSource, `project:${projectId}`);
});

test("Agent catalog fails closed on a broken higher-precedence override", () => {
  const payload = catalog();
  payload.defaults.push([`project:${projectId}`, "profile-missing-r1"]);
  assert.throws(() => resolveCatalogConfiguration({ revision: 1, payload, tenantId, projectId }), /missing/);
});

test("Agent catalog lets tenant and project defaults select an active inherited Profile", () => {
  const tenantPlatformPayload = catalog();
  tenantPlatformPayload.defaults.push([`tenant:${tenantId}`, "profile-platform-r1"]);
  const tenantPlatform = resolveCatalogConfiguration({
    revision: 10, payload: tenantPlatformPayload, tenantId, projectId,
  });
  assert.equal(tenantPlatform.profileRevisionId, "profile-platform-r1");
  assert.equal(tenantPlatform.profileSource, `tenant:${tenantId}`);

  const projectPlatformPayload = catalog();
  projectPlatformPayload.defaults.push([`project:${projectId}`, "profile-platform-r1"]);
  const projectPlatform = resolveCatalogConfiguration({
    revision: 11, payload: projectPlatformPayload, tenantId, projectId,
  });
  assert.equal(projectPlatform.profileRevisionId, "profile-platform-r1");
  assert.equal(projectPlatform.profileSource, `project:${projectId}`);

  const projectTenantPayload = catalog();
  projectTenantPayload.profiles.push(profile("profile-tenant-r1", "tenant", tenantId));
  projectTenantPayload.credentials[0]!.scope = "tenant";
  projectTenantPayload.credentials[0]!.scopeId = tenantId;
  projectTenantPayload.defaults.push([`project:${projectId}`, "profile-tenant-r1"]);
  const projectTenant = resolveCatalogConfiguration({
    revision: 12, payload: projectTenantPayload, tenantId, projectId,
  });
  assert.equal(projectTenant.profileRevisionId, "profile-tenant-r1");
  assert.equal(projectTenant.profileSource, `project:${projectId}`);
});

test("Agent catalog rejects inherited Profiles from another tenant or project", () => {
  const otherTenant = "33333333-3333-4333-8333-333333333333";
  const otherProject = "44444444-4444-4444-8444-444444444444";

  const crossTenant = catalog();
  crossTenant.profiles.push(profile("profile-other-tenant-r1", "tenant", otherTenant));
  crossTenant.defaults.push([`project:${projectId}`, "profile-other-tenant-r1"]);
  assert.throws(
    () => resolveCatalogConfiguration({ revision: 13, payload: crossTenant, tenantId, projectId }),
    /belongs to another scope/,
  );

  const crossProject = catalog();
  crossProject.profiles.push(profile("profile-other-project-r1", "project", otherProject));
  crossProject.defaults.push([`project:${projectId}`, "profile-other-project-r1"]);
  assert.throws(
    () => resolveCatalogConfiguration({ revision: 14, payload: crossProject, tenantId, projectId }),
    /belongs to another scope/,
  );
});

test("Agent catalog rejects unhealthy installations, inactive Providers, floating models and cross-tenant credentials", () => {
  const unhealthy = catalog();
  unhealthy.installations[0]!.health = "UNHEALTHY";
  assert.throws(() => resolveCatalogConfiguration({ revision: 1, payload: unhealthy, tenantId, projectId }), /not fully active/);

  const provider = catalog();
  provider.providers[0]!.state = "DEGRADED";
  assert.throws(() => resolveCatalogConfiguration({ revision: 1, payload: provider, tenantId, projectId }), /inactive/);

  const floating = catalog();
  floating.providers[0]!.models.primaryModel = "sonnet";
  assert.throws(() => resolveCatalogConfiguration({ revision: 1, payload: floating, tenantId, projectId }), /Floating|version/);

  const scoped = catalog();
  scoped.profiles.push(profile("profile-tenant-r1", "tenant", tenantId));
  scoped.defaults.push([`tenant:${tenantId}`, "profile-tenant-r1"]);
  assert.throws(() => resolveCatalogConfiguration({ revision: 1, payload: scoped, tenantId, projectId }), /another tenant scope/);
});

test("Agent catalog rejects unprobed authentication, pricing and governance drift", () => {
  const authentication = catalog();
  authentication.providers[0]!.authentication = "bearer";
  assert.throws(() => resolveCatalogConfiguration({ revision: 1, payload: authentication, tenantId, projectId }), /authentication is incompatible/);

  const pricing = catalog();
  pricing.providers[0]!.pricing.outputUsdPerMillionTokens = Number.NaN;
  assert.throws(() => resolveCatalogConfiguration({ revision: 1, payload: pricing, tenantId, projectId }), /Decimal value/);

  const probe = catalog();
  delete (probe.providers[0]!.probe as Record<string, string>).dnsPinning;
  assert.throws(() => resolveCatalogConfiguration({ revision: 1, payload: probe, tenantId, projectId }), /probe is incomplete/);

  const governance = catalog();
  governance.providers[0]!.governance.confirmedAt = "not-a-date";
  assert.throws(() => resolveCatalogConfiguration({ revision: 1, payload: governance, tenantId, projectId }), /governance confirmation/);
});

function catalog() {
  return {
    versions: [{
      id: "claude-code@2.1.14",
      agent: "claude-code",
      version: "2.1.14",
      state: "APPROVED",
      signatureVerified: true,
      scan: "PASS",
      sourceDigest: "1".repeat(64),
      catalogReceiptDigest: "2".repeat(64),
      validationReceiptDigest: "3".repeat(64),
      supplyChainEvidenceDigest: "4".repeat(64),
    }],
    installations: [{
      id: "installation-claude-r1",
      agent: "claude-code",
      agentVersionId: "claude-code@2.1.14",
      workerPool: "development-linux-primary",
      imageDigest: `sha256:${"5".repeat(64)}`,
      workerImageId: "worker-image-claude-r1",
      adapterVersion: "1.0.0",
      buildReceiptId: "build-receipt-claude-r1",
      buildReceiptDigest: "6".repeat(64),
      state: "ACTIVE",
      health: "HEALTHY",
      rolloutPercent: 100,
      selfUpdateDisabled: true,
    }],
    providers: [{
      id: "provider-claude-r1",
      agent: "claude-code",
      state: "ACTIVE",
      protocol: "anthropic-messages",
      baseUrl: "https://gateway.anthropic.example/v1",
      approvedPorts: [443],
      authentication: "x-api-key",
      credentialVersionId: "credential-claude-v1",
      models: {
        primaryModel: "claude-sonnet-4-6-20250514",
        planningModel: "claude-sonnet-4-6-20250514",
        smallFastModel: "claude-sonnet-4-6-20250514",
        subagentModel: "claude-sonnet-4-6-20250514",
      },
      pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
      governance: {
        dataRegion: "vendor-managed", retentionPolicy: "zero-retention",
        trainingPolicy: "no-training", confirmedBy: "security-admin",
        confirmedAt: "2030-01-01T00:00:00.000Z",
      },
      probe: {
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
      },
    }],
    profiles: [profile("profile-platform-r1", "platform", "global")],
    credentials: [{
      id: "credential-claude-v1",
      scope: "platform",
      scopeId: "global",
      state: "ACTIVE",
    }],
    defaults: [["platform", "profile-platform-r1"]],
  };
}

function profile(id: string, scope: "platform" | "tenant" | "project", scopeId: string) {
  return {
    id,
    scope,
    scopeId,
    state: "ACTIVE",
    agent: "claude-code",
    installationId: "installation-claude-r1",
    providerRevisionId: "provider-claude-r1",
    credentialVersionId: "credential-claude-v1",
    budget: { maxUsd: 25, maxTurns: 100, timeoutSeconds: 7200 },
  };
}
