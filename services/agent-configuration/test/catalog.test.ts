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
  assert.equal(platform.agentVersionAttestation?.validatedAdapterVersion, "1.3.0");
  assert.deepEqual(platform.agentVersionAttestation?.adapterCompatibility, { min: "1.3.0", maxExclusive: "1.3.1" });

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

test("Agent catalog freezes fallback only when a project explicitly selects the Profile", () => {
  const inherited = catalogWithFallback();
  const platform = resolveCatalogConfiguration({ revision: 15, payload: inherited, tenantId, projectId });
  assert.equal(platform.fallback, null);

  inherited.defaults.push([`project:${projectId}`, "profile-platform-r1"]);
  const project = resolveCatalogConfiguration({ revision: 16, payload: inherited, tenantId, projectId });
  assert.equal(project.fallback?.profileRevisionId, "profile-fallback-r1");
  assert.equal(project.fallback?.providerRevisionId, "provider-claude-fallback-r1");
  assert.equal(project.fallback?.agent, project.agent);
  assert.notEqual(project.fallback?.providerRevisionId, project.providerRevisionId);
});

test("Agent catalog fails closed on self-referencing or unhealthy project fallback", () => {
  const self = catalog();
  Object.assign(self.profiles[0]!, { fallbackProfileRevisionId: "profile-platform-r1" });
  self.defaults.push([`project:${projectId}`, "profile-platform-r1"]);
  assert.throws(
    () => resolveCatalogConfiguration({ revision: 17, payload: self, tenantId, projectId }),
    /cannot reference itself/,
  );

  const unhealthy = catalogWithFallback();
  unhealthy.defaults.push([`project:${projectId}`, "profile-platform-r1"]);
  unhealthy.installations[1]!.health = "UNHEALTHY";
  assert.throws(
    () => resolveCatalogConfiguration({ revision: 18, payload: unhealthy, tenantId, projectId }),
    /not fully active/,
  );
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

test("Agent catalog keeps an attested deprecated version serving through its existing active installation", () => {
  const deprecated = catalog();
  deprecated.versions[0]!.state = "DEPRECATED";
  const resolved = resolveCatalogConfiguration({ revision: 19, payload: deprecated, tenantId, projectId });
  assert.equal(resolved.exactAgentVersion, "2.1.14");

  const blocked = catalog();
  blocked.versions[0]!.state = "BLOCKED";
  assert.throws(
    () => resolveCatalogConfiguration({ revision: 20, payload: blocked, tenantId, projectId }),
    /not serving-ready/,
  );
});

test("Agent catalog rejects missing, drifted or unregistered Adapter attestations before locking a Run", () => {
  const missing = catalog();
  delete (missing.versions[0] as Record<string, unknown>).adapterCompatibility;
  assert.throws(
    () => resolveCatalogConfiguration({ revision: 21, payload: missing, tenantId, projectId }),
    /Adapter compatibility/,
  );

  const drifted = catalog();
  drifted.versions[0]!.adapterCompatibility.maxExclusive = "1.3.2";
  assert.throws(
    () => resolveCatalogConfiguration({ revision: 22, payload: drifted, tenantId, projectId }),
    /does not attest/,
  );

  const unregistered = catalog();
  unregistered.installations[0]!.adapterVersion = "9.9.9";
  unregistered.versions[0]!.validatedAdapterVersion = "9.9.9";
  unregistered.versions[0]!.adapterCompatibility = { min: "9.9.9", maxExclusive: "9.9.10" };
  assert.throws(
    () => resolveCatalogConfiguration({ revision: 23, payload: unregistered, tenantId, projectId }),
    /not approved by the immutable registry/,
  );
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
      validationReceiptId: "validation-claude-code-2.1.14",
      validationReceiptDigest: "3".repeat(64),
      supplyChainEvidenceDigest: "4".repeat(64),
      validatedAdapterVersion: "1.3.0",
      adapterCompatibility: { min: "1.3.0", maxExclusive: "1.3.1" },
    }],
    installations: [{
      id: "installation-claude-r1",
      agent: "claude-code",
      agentVersionId: "claude-code@2.1.14",
      workerPool: "development-linux-primary",
      imageDigest: `sha256:${"5".repeat(64)}`,
      workerImageId: "worker-image-claude-r1",
      adapterVersion: "1.3.0",
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

function catalogWithFallback() {
  const payload = catalog();
  payload.versions.push({ ...payload.versions[0]!, id: "claude-code@2.1.15", version: "2.1.15",
    sourceDigest: "a".repeat(64) });
  payload.installations.push({ ...payload.installations[0]!, id: "installation-claude-fallback-r1",
    agentVersionId: "claude-code@2.1.15", imageDigest: `sha256:${"b".repeat(64)}`,
    workerImageId: "worker-image-claude-fallback-r1", buildReceiptId: "build-receipt-claude-fallback-r1",
    buildReceiptDigest: "c".repeat(64) });
  payload.providers.push({ ...structuredClone(payload.providers[0]!), id: "provider-claude-fallback-r1",
    baseUrl: "https://fallback.anthropic.example/v1", credentialVersionId: "credential-claude-fallback-v1" });
  payload.credentials.push({ id: "credential-claude-fallback-v1", scope: "platform", scopeId: "global", state: "ACTIVE" });
  const fallback = profile("profile-fallback-r1", "platform", "global");
  fallback.installationId = "installation-claude-fallback-r1";
  fallback.providerRevisionId = "provider-claude-fallback-r1";
  fallback.credentialVersionId = "credential-claude-fallback-v1";
  payload.profiles.push(fallback);
  Object.assign(payload.profiles[0]!, { fallbackProfileRevisionId: fallback.id });
  return payload;
}
