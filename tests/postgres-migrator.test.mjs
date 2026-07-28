import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadPostgresMigrations,
  migrationWithLedgerRecord,
  resolveMigrationClientConfig,
  runPostgresMigrations,
  safeMigrationFailure,
  validateAppliedMigrations,
  validateMigrationSource,
} from "../scripts/production/migrate-postgres.mjs";

test("PostgreSQL migrations are contiguous and migration 061 baselines exact repository digests", async () => {
  const migrations = await loadPostgresMigrations();
  assert.equal(migrations.length, 69);
  assert.equal(migrations.at(-1)?.filename, "069_fleet_capacity_control.sql");
  const baseline = migrations.find(({ filename }) => filename === "061_schema_migration_ledger.sql")?.source ?? "";
  for (const migration of migrations.slice(0, 60)) {
    assert.ok(
      baseline.includes(`(${migration.version}, '${migration.filename}', '${migration.digest}')`),
      `migration 061 is missing the exact digest for ${migration.filename}`,
    );
  }
  assert.doesNotMatch(baseline, /\(61, '061_schema_migration_ledger\.sql'/);
});

test("migration source and ledger injection require one explicit transaction and safe identity", () => {
  const migration = Object.freeze({
    version: 1,
    filename: "001_example.sql",
    digest: "a".repeat(64),
    source: "BEGIN;\nSELECT 1;\nCOMMIT;\n",
  });
  validateMigrationSource(migration.filename, migration.source);
  const bound = migrationWithLedgerRecord(migration);
  assert.match(bound, /SELECT 1;[\s\S]*INSERT INTO public\.deviludo_schema_migrations/);
  assert.match(bound, /VALUES \(1, '001_example\.sql', '[a]{64}'\);\n\nCOMMIT;$/);
  assert.equal((bound.match(/COMMIT;/g) ?? []).length, 1);

  assert.throws(() => validateMigrationSource("001_bad.sql", "SELECT 1;\n"), /unsafe transaction/);
  assert.throws(() => validateMigrationSource("001_bad.sql", "BEGIN;\n\\i other.sql\nCOMMIT;\n"), /unsafe transaction/);
  assert.throws(
    () => validateMigrationSource("001_bad.sql", "BEGIN;\nCOMMIT;\nBEGIN;\nSELECT 1;\nCOMMIT;\n"),
    /unsafe transaction/,
  );
  assert.throws(() => migrationWithLedgerRecord({ ...migration, filename: "001_bad';sql" }), /identity/);
});

test("applied migration validation fails closed on gaps, unknown versions and content drift", () => {
  const migrations = fixtures(3);
  const rows = migrations.slice(0, 2).map(({ version, filename, digest }) => ({ version, filename, digest }));
  const plan = validateAppliedMigrations(migrations, rows);
  assert.deepEqual(plan.applied.map(({ version }) => version), [1, 2]);
  assert.deepEqual(plan.pending.map(({ version }) => version), [3]);

  assert.throws(() => validateAppliedMigrations(migrations, [{ ...rows[0], digest: "f".repeat(64) }]), /drift at version 1/);
  assert.throws(() => validateAppliedMigrations(migrations, [rows[1]]), /drift at version 2/);
  assert.throws(() => validateAppliedMigrations(migrations, [...rows, {
    version: 4, filename: "004_future.sql", digest: "4".repeat(64),
  }]), /drift at version 4/);
});

test("migration runner holds one advisory lock and records each schema change atomically", async () => {
  const migrations = fixtures(3);
  const database = fakeMigrationDatabase({ schemaPresent: false });
  const applied = [];
  const result = await runPostgresMigrations({
    client: database.client,
    migrations,
    onApplied: (migration) => applied.push(migration.filename),
  });
  assert.deepEqual(result, { applied: 3, currentVersion: 3 });
  assert.deepEqual(applied, migrations.map(({ filename }) => filename));
  assert.deepEqual(database.rows, migrations.map(({ version, filename, digest }) => ({ version, filename, digest })));
  assert.equal(database.sql.filter((statement) => statement.includes("pg_try_advisory_lock")).length, 1);
  assert.ok(database.sql.includes("SET search_path TO pg_catalog, public"));
  assert.equal(database.sql.filter((statement) => statement.includes("pg_advisory_unlock")).length, 1);
  assert.equal(database.sql.filter((statement) => statement.includes("INSERT INTO public.deviludo_schema_migrations")).length, 3);
});

test("migration CLI exposes only allow-listed failures", () => {
  assert.equal(
    safeMigrationFailure(new Error("connect ECONNREFUSED db.internal password=database-secret")),
    "PostgreSQL migration unavailable",
  );
  assert.equal(
    safeMigrationFailure(new Error("PostgreSQL migration ledger drift at version 12")),
    "PostgreSQL migration ledger drift at version 12",
  );
  assert.doesNotMatch(safeMigrationFailure(new Error("/run/secrets/database-secret")), /secret|\/run/);
});

test("migration runner rejects concurrent, untracked and failed upgrades without leaking database errors", async () => {
  const migrations = fixtures(2);
  const busy = fakeMigrationDatabase({ schemaPresent: false, lockAcquired: false });
  await assert.rejects(runPostgresMigrations({ client: busy.client, migrations }), /holds the deployment lock/);
  assert.equal(busy.sql.some((statement) => statement.includes("CREATE TABLE")), false);

  const untracked = fakeMigrationDatabase({ schemaPresent: true });
  await assert.rejects(runPostgresMigrations({ client: untracked.client, migrations }), /no migration ledger/);
  assert.equal(untracked.sql.some((statement) => statement === migrations[0].source), false);

  const failed = fakeMigrationDatabase({ schemaPresent: false, failPattern: "SELECT 2" });
  await assert.rejects(runPostgresMigrations({ client: failed.client, migrations }), (error) => {
    assert.match(error.message, /migration failed: 002_fixture\.sql/);
    assert.doesNotMatch(error.message, /database-password|raw database failure/);
    return true;
  });
  assert.ok(failed.sql.includes("ROLLBACK"));
  assert.ok(failed.sql.some((statement) => statement.includes("pg_advisory_unlock")));
});

test("explicit local adoption verifies schema 060 before recording and then reaches repository head", async () => {
  const migrations = await loadPostgresMigrations();
  const database = fakeMigrationDatabase({ schemaPresent: true, baselineMigrations: migrations.slice(0, 60) });
  const result = await runPostgresMigrations({ client: database.client, migrations, adoptExisting: true });
  assert.deepEqual(result, { applied: 9, currentVersion: 69 });
  assert.equal(database.rows.length, 69);
  assert.equal(database.sql.filter((statement) => statement.includes("CREATE TEMP TABLE deviludo_expected_migration_baseline")).length, 2);
});

test("migration credentials are loopback-only in development and file-mounted with TLS in production", async () => {
  const local = await resolveMigrationClientConfig({
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://deviludo:local@127.0.0.1:5432/deviludo",
  });
  assert.equal(local.ssl, false);
  assert.equal(local.application_name, "deviludo-schema-migrator");
  await assert.rejects(resolveMigrationClientConfig({
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://deviludo:local@db.example.com/deviludo",
  }), /loopback/);
  await assert.rejects(resolveMigrationClientConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://migration:secret@db.example.com/deviludo",
  }), /file-mounted/);

  const directory = await mkdtemp(join(tmpdir(), "deviludo-migration-test-"));
  try {
    const urlFile = join(directory, "database-url");
    const caFile = join(directory, "ca.pem");
    await writeFile(urlFile, "postgresql://migration:secret@db.example.com/deviludo\n", { mode: 0o600 });
    await writeFile(caFile, "test-ca", { mode: 0o600 });
    const production = await resolveMigrationClientConfig({
      NODE_ENV: "production",
      DEVILUDO_MIGRATION_DATABASE_URL_FILE: urlFile,
      DEVILUDO_MIGRATION_POSTGRES_CA_FILE: caFile,
    });
    assert.deepEqual(production.ssl, { rejectUnauthorized: true, ca: "test-ca" });
    assert.doesNotMatch(JSON.stringify(production.ssl), /migration:secret/);
    await assert.rejects(resolveMigrationClientConfig({
      NODE_ENV: "production",
      DEVILUDO_MIGRATION_DATABASE_URL_FILE: urlFile,
      DEVILUDO_MIGRATION_POSTGRES_CERT_FILE: caFile,
    }), /certificate and key/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function fixtures(count) {
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const version = index + 1;
    return Object.freeze({
      version,
      filename: `${String(version).padStart(3, "0")}_fixture.sql`,
      digest: String(version).repeat(64),
      source: `BEGIN;\nSELECT ${version};\nCOMMIT;\n`,
    });
  }));
}

function fakeMigrationDatabase({
  schemaPresent,
  lockAcquired = true,
  failPattern = null,
  baselineMigrations = [],
}) {
  const sql = [];
  const rows = [];
  const client = {
    async query(statement) {
      const text = String(statement);
      sql.push(text);
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: lockAcquired }] };
      if (text.includes("server_version_num")) return { rows: [{ version: 160_000 }] };
      if (text.startsWith("SELECT version, filename, digest")) return { rows: structuredClone(rows) };
      if (text.startsWith("SELECT to_regnamespace('deviludo')")) return { rows: [{ present: schemaPresent }] };
      if (text.includes("pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: true }] };
      if (failPattern && text.includes(failPattern)) throw new Error("raw database failure database-password");
      if (text.includes("CREATE TEMP TABLE deviludo_expected_migration_baseline")
        && !text.includes("VALUES (61,")) {
        for (const migration of baselineMigrations) {
          if (!rows.some((row) => row.version === migration.version)) {
            rows.push({ version: migration.version, filename: migration.filename, digest: migration.digest });
          }
        }
      }
      const recordOffset = text.lastIndexOf(
        "INSERT INTO public.deviludo_schema_migrations (version, filename, digest)\nVALUES ",
      );
      const record = recordOffset < 0 ? null : /VALUES \((\d+), '([0-9]{3}_[a-z0-9_]+\.sql)', '([a-f0-9]{64})'\);\s*\n\nCOMMIT;\s*$/
        .exec(text.slice(recordOffset));
      if (record) rows.push({ version: Number(record[1]), filename: record[2], digest: record[3] });
      return { rows: [] };
    },
  };
  return { client, rows, sql };
}
