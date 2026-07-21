import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient, QueryResult } from "pg";
import { PostgresAdminStore } from "../src/admin-store-postgres";
import { recordAdminAudit } from "../src/admin.store";

const emptyPayload = {
  versions: [],
  installations: [],
  providers: [],
  profiles: [],
  credentials: [],
  defaults: [],
};

test("Postgres admin catalog serializes mutations, advances one revision and appends audit", async () => {
  let revision = 0;
  let payload: unknown = structuredClone(emptyPayload);
  const statements: string[] = [];
  const audits: unknown[][] = [];
  let idempotencyPayload: unknown = null;
  let released = 0;
  const client = {
    async query(text: string, values?: unknown[]) {
      statements.push(text);
      if (text.includes("SELECT revision, payload")) return result([{ revision, payload }]);
      if (text.includes("UPDATE deviludo.admin_catalog_state")) {
        assert.equal(values?.[0], revision);
        payload = JSON.parse(String(values?.[1]));
        revision += 1;
        return result([{ revision }]);
      }
      if (text.includes("UPDATE deviludo.admin_idempotency_results")) {
        assert.equal(values?.[0], "a".repeat(64));
        assert.equal(values?.[1], "b".repeat(64));
        assert.equal(values?.[2], "11111111-1111-4111-8111-111111111111");
        idempotencyPayload = JSON.parse(String(values?.[3]));
        return result([{ identity_digest: values?.[0] }]);
      }
      if (text.includes("INSERT INTO deviludo.admin_audit_records")) {
        audits.push(values ?? []);
        return result([]);
      }
      if (text.includes("FROM deviludo.admin_audit_records")) {
        return result(audits.map((values) => ({
          id: values[0], action: values[1], resource: values[2], actor_role: values[3],
          actor_id: values[4], tenant_id: values[5], project_id: values[6],
          request_id: values[7], occurred_at: values[8], metadata: JSON.parse(String(values[9])),
        })));
      }
      return result([]);
    },
    release() { released += 1; },
  } as unknown as PoolClient;
  const pool = {
    async connect() { return client; },
    async end() {},
  } as unknown as Pool;
  const store = new PostgresAdminStore(pool);
  const created = await store.mutate((state) => {
    const version = {
      id: "codex-cli@1.2.3",
      agent: "codex-cli" as const,
      version: "1.2.3",
      state: "DISCOVERED" as const,
      source: "https://github.com/openai/codex",
      sourceDigest: "c".repeat(64),
      releaseNotesUrl: "https://github.com/openai/codex/releases",
      integrity: `sha256:${"a".repeat(64)}`,
      signatureVerified: false,
      sbomRef: "pending://codex-cli@1.2.3",
      scan: "PENDING" as const,
      catalogReceiptId: "catalog-codex-cli-1.2.3",
      catalogReceiptDigest: "d".repeat(64),
      validationReceiptId: null,
      validationReceiptDigest: null,
      supplyChainEvidenceDigest: null,
      validatedAdapterVersion: null,
      adapterCompatibility: null,
      validatedAt: null,
      discoveredAt: "2026-07-18T00:00:00.000Z",
    };
    state.versions.set(version.id, version);
    state.credentials.set("credential-platform-recovery-v2", {
      id: "credential-platform-recovery-v2",
      familyId: "credential-platform-recovery",
      version: 2,
      label: "recovery fixture",
      scope: "platform",
      scopeId: "global",
      secretRef: "vault://kv/deviludo/records/11111111-1111-4111-8111-111111111111",
      maskedFingerprint: "sha256:12345678…abcdef",
      state: "ACTIVE",
      createdAt: "2026-07-18T00:00:00.000Z",
      rotatedAt: null,
      lastUsedAt: null,
      rotation: {
        operationKey: "e".repeat(64),
        sourceVersionId: "credential-platform-recovery-v1",
        bindings: [],
      },
    });
    recordAdminAudit(state, {
      action: "AGENT_VERSION_DISCOVERED",
      resource: version.id,
      role: "TenantAdmin",
      actorId: "actor-1",
      tenantId: "tenant-1",
      projectId: null,
      requestId: "request-1",
    });
    return version.id;
  }, {
    identityDigest: "a".repeat(64),
    requestFingerprint: "b".repeat(64),
    claimToken: "11111111-1111-4111-8111-111111111111",
    payload: (versionId) => ({ versionId }),
  });
  assert.equal(created, "codex-cli@1.2.3");
  assert.equal(revision, 1);
  assert.equal((payload as { versions: unknown[] }).versions.length, 1);
  assert.equal((payload as { credentials: unknown[] }).credentials.length, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.[5], "tenant-1");
  assert.deepEqual(idempotencyPayload, { versionId: "codex-cli@1.2.3" });
  assert.equal(statements.some((text) => text.includes("FOR UPDATE")), true);
  assert.ok(statements.indexOf("COMMIT") > statements.findIndex((text) => text.includes("UPDATE deviludo.admin_idempotency_results")));

  const read = await store.read((state) => ({
    version: state.versions.get("codex-cli@1.2.3")?.version,
    audit: state.audit[0]?.action,
    rotationOperation: state.credentials.get("credential-platform-recovery-v2")?.rotation?.operationKey,
  }));
  assert.deepEqual(read, {
    version: "1.2.3",
    audit: "AGENT_VERSION_DISCOVERED",
    rotationOperation: "e".repeat(64),
  });
  assert.equal(released, 2);
});

test("Postgres admin catalog rolls back a failed mutation without writing state or audit", async () => {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text);
      if (text.includes("SELECT revision, payload")) return result([{ revision: 4, payload: emptyPayload }]);
      return result([]);
    },
    release() {},
  } as unknown as PoolClient;
  const store = new PostgresAdminStore({ async connect() { return client; }, async end() {} } as unknown as Pool);
  await assert.rejects(store.mutate(() => { throw new Error("mutation failed"); }), /mutation failed/);
  assert.equal(statements.includes("ROLLBACK"), true);
  assert.equal(statements.some((text) => text.includes("UPDATE deviludo.admin_catalog_state")), false);
});

test("Postgres admin retirement guard counts every non-terminal run with RLS fail-closed", async () => {
  const statements: string[] = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      statements.push(text);
      if (text.includes("FROM deviludo.agent_runs")) {
        assert.deepEqual(values, ["claude-code-installation-test"]);
        return result([{ active_count: "2" }]);
      }
      return result([]);
    },
    release() {},
  } as unknown as PoolClient;
  const store = new PostgresAdminStore({ async connect() { return client; }, async end() {} } as unknown as Pool);
  assert.equal(await store.countNonTerminalRuns("claude-code-installation-test"), 2);
  assert.equal(statements.includes("SET LOCAL row_security = off"), true);
  assert.match(statements.find((text) => text.includes("FROM deviludo.agent_runs")) ?? "", /state NOT IN \('SUCCEEDED', 'FAILED', 'CANCELLED'\)/);
});

test("Postgres admin catalog backfills legacy Installation and credential lifecycle timestamps deterministically", async () => {
  const createdAt = "2026-07-17T08:00:00.000Z";
  const legacyPayload = {
    ...emptyPayload,
    versions: [{
      id: "claude-code@2.1.14",
      agent: "claude-code",
      version: "2.1.14",
      state: "APPROVED",
      source: "https://code.claude.com/docs/en/installation",
      sourceDigest: "1".repeat(64),
      releaseNotesUrl: "https://github.com/anthropics/claude-code/releases",
      integrity: `sha256:${"1".repeat(64)}`,
      signatureVerified: true,
      sbomRef: "oci://registry.internal/sbom/claude-code-2.1.14.spdx.json",
      scan: "PASS",
      catalogReceiptId: "catalog-claude-code-2.1.14",
      catalogReceiptDigest: "2".repeat(64),
      validationReceiptId: "validation-claude-code-2.1.14",
      validationReceiptDigest: "3".repeat(64),
      supplyChainEvidenceDigest: "4".repeat(64),
      validatedAt: createdAt,
      discoveredAt: createdAt,
    }],
    installations: [{
      id: "claude-code-installation-legacy",
      agent: "claude-code",
      agentVersionId: "claude-code@2.1.14",
      workerPool: "development-linux-primary",
      imageDigest: `sha256:${"a".repeat(64)}`,
      workerImageId: "worker-image-legacy",
      adapterVersion: "1.2.0",
      buildReceiptId: "build-legacy",
      buildReceiptDigest: "b".repeat(64),
      rollbackInstallationId: null,
      health: "HEALTHY",
      state: "ACTIVE",
      rolloutPercent: 100,
      previousRolloutPercent: 25,
      selfUpdateDisabled: true,
      createdAt,
    }],
    credentials: [{
      id: "credential-platform-legacy-v1",
      familyId: "credential-platform-legacy",
      version: 1,
      label: "legacy credential",
      scope: "platform",
      scopeId: "global",
      secretRef: "vault://kv/data/deviludo/platform/legacy?version=1",
      maskedFingerprint: "sha256:legacy00…000001",
      state: "ACTIVE",
      createdAt,
      lastUsedAt: null,
    }],
  };
  const client = {
    async query(text: string) {
      if (text.includes("SELECT revision, payload")) return result([{ revision: 7, payload: legacyPayload }]);
      if (text.includes("FROM deviludo.admin_audit_records")) return result([]);
      return result([]);
    },
    release() {},
  } as unknown as PoolClient;
  const store = new PostgresAdminStore({ async connect() { return client; }, async end() {} } as unknown as Pool);
  const lifecycle = await store.read((state) => ({
    activatedAt: state.installations.get("claude-code-installation-legacy")?.activatedAt,
    rotatedAt: state.credentials.get("credential-platform-legacy-v1")?.rotatedAt,
    validatedAdapterVersion: state.versions.get("claude-code@2.1.14")?.validatedAdapterVersion,
    adapterCompatibility: state.versions.get("claude-code@2.1.14")?.adapterCompatibility,
  }));
  assert.equal(lifecycle.activatedAt, createdAt);
  assert.equal(lifecycle.rotatedAt, null);
  assert.equal(lifecycle.validatedAdapterVersion, null);
  assert.equal(lifecycle.adapterCompatibility, null);

  const malformedClient = {
    async query(text: string) {
      if (text.includes("SELECT revision, payload")) {
        return result([{ revision: 8, payload: {
          ...legacyPayload,
          installations: [{ ...legacyPayload.installations[0], activatedAt: "not-a-timestamp" }],
        } }]);
      }
      if (text.includes("FROM deviludo.admin_audit_records")) return result([]);
      return result([]);
    },
    release() {},
  } as unknown as PoolClient;
  const malformed = new PostgresAdminStore({ async connect() { return malformedClient; }, async end() {} } as unknown as Pool);
  await assert.rejects(malformed.read(() => undefined), /activation timestamp is invalid/);
});

test("Postgres admin audit accepts materialized System failovers without exposing authorization nonces", async () => {
  const activatedAt = "2026-07-21T04:00:00.000Z";
  const client = {
    async query(text: string) {
      if (text.includes("SELECT revision, payload")) return result([{ revision: 9, payload: emptyPayload }]);
      if (text.includes("FROM deviludo.admin_audit_records")) return result([{
        id: "audit-77777777-7777-4777-8777-777777777777",
        action: "AGENT_RUN_PROVIDER_FAILOVER_ACTIVATED",
        resource: "agent-run:33333333-3333-4333-8333-333333333333",
        actor_role: "System",
        actor_id: "agent-execution-broker",
        tenant_id: "11111111-1111-4111-8111-111111111111",
        project_id: "22222222-2222-4222-8222-222222222222",
        request_id: "provider-failover:33333333-3333-4333-8333-333333333333",
        occurred_at: activatedAt,
        metadata: {
          reason: "PRIMARY_PROVIDER_UNAVAILABLE",
          fromProfileRevisionId: "profile-primary-r4",
          fromProviderRevisionId: "provider-primary-r4",
          toProfileRevisionId: "profile-fallback-r2",
          toProviderRevisionId: "provider-fallback-r2",
          toCredentialVersionId: "credential-fallback-v3",
          toModels: ["gateway/claude-sonnet-4-6-20250601"],
          toBudget: { maxCostUsd: 10 },
          authorizationExpiresAt: "2026-07-21T05:00:00.000Z",
        },
      }]);
      return result([]);
    },
    release() {},
  } as unknown as PoolClient;
  const store = new PostgresAdminStore({ async connect() { return client; }, async end() {} } as unknown as Pool);
  const audit = await store.read((state) => state.audit);
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], {
    id: "audit-77777777-7777-4777-8777-777777777777",
    action: "AGENT_RUN_PROVIDER_FAILOVER_ACTIVATED",
    resource: "agent-run:33333333-3333-4333-8333-333333333333",
    actorRole: "System",
    actorId: "agent-execution-broker",
    tenantId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    requestId: "provider-failover:33333333-3333-4333-8333-333333333333",
    at: activatedAt,
    metadata: {
      reason: "PRIMARY_PROVIDER_UNAVAILABLE",
      fromProfileRevisionId: "profile-primary-r4",
      fromProviderRevisionId: "provider-primary-r4",
      toProfileRevisionId: "profile-fallback-r2",
      toProviderRevisionId: "provider-fallback-r2",
      toCredentialVersionId: "credential-fallback-v3",
      toModels: ["gateway/claude-sonnet-4-6-20250601"],
      toBudget: { maxCostUsd: 10 },
      authorizationExpiresAt: "2026-07-21T05:00:00.000Z",
    },
  });
  assert.equal(JSON.stringify(audit).includes("authorizationNonce"), false);
});

test("Postgres Agent usage projection applies tenant and project scope before returning immutable records", async () => {
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const projectId = "22222222-2222-4222-8222-222222222222";
  const client = {
    async query(text: string, values?: unknown[]) {
      statements.push({ text, values });
      if (text.includes("count(*)::text AS requests")) {
        return result([{ requests: "1", input_tokens: "120", output_tokens: "30", cost_usd: "0.00048" }]);
      }
      if (text.includes("SELECT request_id::text")) {
        return result([{
          request_id: "44444444-4444-4444-8444-444444444444",
          tenant_id: tenantId,
          project_id: projectId,
          run_id: "33333333-3333-4333-8333-333333333333",
          provider_revision_id: "provider-platform-claude-r1",
          credential_version_id: "credential-platform-claude-v1",
          model: "claude-sonnet-4-6-20250514",
          input_tokens: "120",
          output_tokens: "30",
          cost_usd: "0.00048",
          recorded_at: "2026-07-22T01:00:00.000Z",
        }]);
      }
      if (text.includes("max(recorded_at) AS last_used_at")) {
        return result([{
          credential_version_id: "credential-platform-claude-v1",
          last_used_at: "2026-07-22T01:00:00.000Z",
        }]);
      }
      return result([]);
    },
    release() {},
  } as unknown as PoolClient;
  const store = new PostgresAdminStore({ async connect() { return client; }, async end() {} } as unknown as Pool);
  const usage = await store.readUsage({
    role: "Auditor", actorId: "project-auditor", tenantId, projectId,
    requestId: "usage-read", mutation: undefined,
  });
  assert.equal(usage.available, true);
  assert.deepEqual(usage.totals, { requests: 1, inputTokens: 120, outputTokens: 30, costUsd: 0.00048 });
  assert.equal(usage.records[0]?.credentialVersionId, "credential-platform-claude-v1");
  assert.deepEqual(usage.credentialLastUsedAt, {
    "credential-platform-claude-v1": "2026-07-22T01:00:00.000Z",
  });
  assert.equal(statements.some(({ text }) => text === "SET LOCAL row_security = off"), false);
  const setTenant = statements.find(({ text }) => text.includes("set_config('app.tenant_id'"));
  assert.deepEqual(setTenant?.values, [tenantId]);
  const aggregate = statements.find(({ text }) => text.includes("count(*)::text AS requests"));
  assert.match(aggregate?.text ?? "", /tenant_id = \$2::uuid/);
  assert.match(aggregate?.text ?? "", /project_id = \$3::uuid/);
  assert.equal(aggregate?.values?.[1], tenantId);
  assert.equal(aggregate?.values?.[2], projectId);
  const credentialProjection = statements.find(({ text }) => text.includes("max(recorded_at) AS last_used_at"));
  assert.match(credentialProjection?.text ?? "", /tenant_id = \$1::uuid/);
  assert.match(credentialProjection?.text ?? "", /project_id = \$2::uuid/);
  assert.deepEqual(credentialProjection?.values, [tenantId, projectId]);

  await store.readUsage({
    role: "SecurityAdmin", actorId: "security-admin", tenantId: null, projectId: null,
    requestId: "global-usage-read", mutation: undefined,
  });
  assert.equal(statements.some(({ text }) => text === "SET LOCAL row_security = off"), true);
});

function result<Row extends Record<string, unknown>>(rows: Row[]): QueryResult<Row> {
  return { command: "", rowCount: rows.length, oid: 0, fields: [], rows };
}
