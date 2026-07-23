import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getDemoStore,
  resetDemoStore,
} from "../lib/control-plane/demo-store.ts";
import {
  acquireLocalAdminState,
  parseLocalAdminState,
  serializeLocalAdminState,
} from "../lib/control-plane/local-admin-state.ts";

class FakeD1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.values = values;
  }

  bind(...values) { return new FakeD1Statement(this.database, this.sql, values); }

  async first() {
    if (!this.sql.startsWith("SELECT revision, state_json FROM local_admin_state_revisions")) {
      throw new Error(`Unexpected fake D1 first(): ${this.sql}`);
    }
    return this.database.latest();
  }

  async run() {
    if (this.sql.startsWith("CREATE ")) return result(0);
    if (this.sql.startsWith("INSERT OR IGNORE INTO local_admin_state_revisions")) {
      if (this.database.rows.length > 0) return result(0);
      const [schemaVersion, stateJson, createdAt] = this.values;
      this.database.rows.push({ revision: 0, schemaVersion, commandKey: null, state_json: stateJson, createdAt });
      return result(1);
    }
    if (this.sql.startsWith("INSERT INTO local_admin_state_revisions")) {
      const [revision, schemaVersion, commandKey, stateJson, createdAt, expectedRevision] = this.values;
      if (this.database.latest()?.revision !== expectedRevision
        || this.database.rows.some((row) => row.commandKey === commandKey)) return result(0);
      this.database.rows.push({ revision, schemaVersion, commandKey, state_json: stateJson, createdAt });
      return result(1);
    }
    throw new Error(`Unexpected fake D1 run(): ${this.sql}`);
  }
}

class FakeD1Database {
  rows = [];

  prepare(sql) { return new FakeD1Statement(this, sql); }

  async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }

  latest() { return this.rows.toSorted((left, right) => right.revision - left.revision)[0] ?? null; }

  appendExternal(stateJson) {
    const revision = (this.latest()?.revision ?? -1) + 1;
    this.rows.push({
      revision,
      schemaVersion: "deviludo.local-admin-state.v1",
      commandKey: `external:${revision}`,
      state_json: stateJson,
      createdAt: new Date().toISOString(),
    });
  }
}

function result(changes) { return { meta: { changes } }; }

test("local Agent administrator state survives a fresh process projection through immutable D1 revisions", async () => {
  resetDemoStore();
  const database = new FakeD1Database();
  const first = await acquireLocalAdminState({ database });
  assert.equal(first.persistent, true);
  assert.equal(first.revision, 0);
  getDemoStore().defaults["project:persistent-local"] = "profile-claude-platform-r5";
  getDemoStore().idempotency["admin:test:persist"] = { scope: "project:persistent-local" };
  await first.persist("admin:test:persist");
  first.release();
  assert.equal(database.rows.length, 2);

  resetDemoStore();
  assert.equal(getDemoStore().defaults["project:persistent-local"], undefined);
  const second = await acquireLocalAdminState({ database });
  try {
    assert.equal(second.revision, 1);
    assert.equal(getDemoStore().defaults["project:persistent-local"], "profile-claude-platform-r5");
    assert.deepEqual(getDemoStore().idempotency["admin:test:persist"], { scope: "project:persistent-local" });
  } finally {
    second.release();
  }
});

test("local Agent administrator state rejects stale compare-and-swap commits", async () => {
  resetDemoStore();
  const database = new FakeD1Database();
  const lease = await acquireLocalAdminState({ database });
  database.appendExternal(serializeLocalAdminState(getDemoStore()));
  await assert.rejects(lease.persist("admin:test:stale"), /并发更新/);
  lease.release();
  assert.equal(database.rows.length, 2);
});

test("local Agent administrator snapshots fail closed on corruption and plaintext credential fields", () => {
  resetDemoStore();
  const serialized = serializeLocalAdminState(getDemoStore());
  assert.equal(parseLocalAdminState(serialized).defaults.platform, "profile-claude-platform-r5");
  assert.throws(() => parseLocalAdminState("{}"), /版本无效/);
  getDemoStore().idempotency["unsafe"] = { apiKey: "must-never-enter-d1" };
  assert.throws(() => serializeLocalAdminState(getDemoStore()), /敏感字段/);
  resetDemoStore();
});

test("local Agent administrator upgrades legacy Provider/Profile, ownership, and monotonic IDs into v5 snapshots", () => {
  const envelope = JSON.parse(serializeLocalAdminState(resetDemoStore()));
  assert.equal(envelope.schemaVersion, "deviludo.local-admin-state.v5");
  envelope.schemaVersion = "deviludo.local-admin-state.v1";
  delete envelope.state.resourceSequences;
  const provider = envelope.state.providers[0];
  provider.primaryModel = provider.models.primaryModel;
  provider.inputUsdPerMillionTokens = provider.pricing.inputUsdPerMillionTokens;
  provider.outputUsdPerMillionTokens = provider.pricing.outputUsdPerMillionTokens;
  provider.credentialId = provider.credentialVersionId;
  delete provider.models; delete provider.pricing; delete provider.approvedPorts;
  delete provider.credentialVersionId; delete provider.governance;
  const profile = envelope.state.profiles[0];
  profile.providerId = profile.providerRevisionId;
  profile.budgetUsd = profile.budget.maxUsd;
  profile.fallbackProfileId = profile.fallbackProfileRevisionId;
  delete profile.providerRevisionId; delete profile.credentialVersionId;
  delete profile.budget; delete profile.fallbackProfileRevisionId; delete profile.createdAt;
  envelope.state.credentials.push({
    id: "credential-legacy-v1", label: "Legacy unscoped key",
    secretRef: "vault://kv/data/deviludo/credential-legacy-v1#1",
    fingerprint: `sha256:${"a".repeat(64)}`, masked: "sha256:aaaa…aaaa",
    version: 1, state: "ACTIVE", createdAt: "2026-07-17T00:00:00.000Z", rotatedAt: null,
  });
  const legacyTenantProfile = envelope.state.profiles.find((item) => item.id === "profile-claude-tenant-r2");
  legacyTenantProfile.scopeId = "north-dock";
  envelope.state.defaults["tenant:north-dock"] = "profile-claude-tenant-r2";
  delete envelope.state.defaults["tenant:tenant-local"];

  const migrated = parseLocalAdminState(JSON.stringify(envelope));
  assert.deepEqual(migrated.providers[0].models, {
    primaryModel: provider.primaryModel,
    planningModel: provider.primaryModel,
    smallFastModel: provider.primaryModel,
    subagentModel: provider.primaryModel,
  });
  assert.equal(migrated.providers[0].credentialVersionId, provider.credentialId);
  assert.deepEqual(migrated.profiles[0].budget, { maxUsd: profile.budgetUsd, maxTurns: 64, timeoutSeconds: 7200 });
  assert.equal(migrated.profiles[0].providerRevisionId, profile.providerId);
  assert.deepEqual({
    familyId: migrated.credentials[0].familyId,
    scope: migrated.credentials[0].scope,
    scopeId: migrated.credentials[0].scopeId,
  }, { familyId: "credential-legacy", scope: "platform", scopeId: "global" });
  assert.equal(migrated.profiles.find((item) => item.id === "profile-claude-tenant-r2").scopeId, "tenant-local");
  assert.equal(migrated.defaults["tenant:tenant-local"], "profile-claude-tenant-r2");
  assert.equal(migrated.defaults["tenant:north-dock"], undefined);
  assert.deepEqual(migrated.resourceSequences, { credential: 0, provider: 2, profile: 4, audit: 0 });

  const v2Envelope = JSON.parse(serializeLocalAdminState(migrated));
  v2Envelope.schemaVersion = "deviludo.local-admin-state.v2";
  assert.equal(parseLocalAdminState(JSON.stringify(v2Envelope)).credentials[0].scope, "platform");
});

test("v3 AgentVersion snapshots require trusted Adapter revalidation without inventing proof", () => {
  const envelope = JSON.parse(serializeLocalAdminState(resetDemoStore()));
  envelope.schemaVersion = "deviludo.local-admin-state.v3";
  const metadata = envelope.state.agentVersionMetadata["claude-code@2.1.14"];
  delete metadata.validatedAdapterVersion;
  delete metadata.adapterCompatibility;

  const migrated = parseLocalAdminState(JSON.stringify(envelope));
  assert.equal(migrated.agentVersions["claude-code@2.1.14"], "DISCOVERED");
  assert.equal(migrated.agentVersionMetadata["claude-code@2.1.14"].validatedAdapterVersion, null);
  assert.equal(migrated.agentVersionMetadata["claude-code@2.1.14"].adapterCompatibility, null);
  assert.equal(migrated.agentVersionMetadata["claude-code@2.1.14"].validationReceiptId, "local-validation-claude-code-2.1.14");

  const incomplete = JSON.parse(serializeLocalAdminState(resetDemoStore()));
  incomplete.state.agentVersionMetadata["codex-cli@0.91.0"].validationReceiptDigest = null;
  assert.equal(parseLocalAdminState(JSON.stringify(incomplete)).agentVersions["codex-cli@0.91.0"], "DISCOVERED");
});

test("local Agent administrator migration makes every persisted revision immutable", async () => {
  const migration = await readFile(new URL("../drizzle/0007_wakeful_freak.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE `local_admin_state_revisions`/);
  assert.match(migration, /command_key.*UNIQUE|CREATE UNIQUE INDEX `local_admin_state_revisions_command_key_unique`/s);
  assert.match(migration, /BEFORE UPDATE ON local_admin_state_revisions/);
  assert.match(migration, /BEFORE DELETE ON local_admin_state_revisions/);
});
