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

test("local Agent administrator upgrades v1 Provider/Profile projections and writes v2 snapshots", () => {
  const envelope = JSON.parse(serializeLocalAdminState(resetDemoStore()));
  assert.equal(envelope.schemaVersion, "deviludo.local-admin-state.v2");
  envelope.schemaVersion = "deviludo.local-admin-state.v1";
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
});

test("local Agent administrator migration makes every persisted revision immutable", async () => {
  const migration = await readFile(new URL("../drizzle/0007_wakeful_freak.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE `local_admin_state_revisions`/);
  assert.match(migration, /command_key.*UNIQUE|CREATE UNIQUE INDEX `local_admin_state_revisions_command_key_unique`/s);
  assert.match(migration, /BEFORE UPDATE ON local_admin_state_revisions/);
  assert.match(migration, /BEFORE DELETE ON local_admin_state_revisions/);
});
