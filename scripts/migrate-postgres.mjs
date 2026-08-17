import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const connectionFile = process.env.DEVILUDO_MIGRATION_DATABASE_URL_FILE;
if (connectionFile && process.env.DEVILUDO_MIGRATION_DATABASE_URL) throw new Error("Set only one migration credential source");
const connectionString = connectionFile
  ? (await readFile(connectionFile, "utf8")).trim()
  : process.env.DEVILUDO_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (!connectionString) throw new Error("DEVILUDO_MIGRATION_DATABASE_URL is required");
const url = new URL(connectionString);
if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || url.pathname.length < 2) {
  throw new Error("Migration database URL is invalid");
}
if (process.env.NODE_ENV === "production" && !connectionFile) {
  throw new Error("Production migration credentials must be supplied by a file-mounted secret");
}

const baselineUrl = new URL("../infra/postgres/001_core.sql", import.meta.url);
const migrationsUrl = new URL("../infra/postgres/migrations/", import.meta.url);
const baselineSource = await readFile(baselineUrl, "utf8");
const baselineDigest = digest(baselineSource);
const migrationNames = (await readdir(migrationsUrl))
  .filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
if (!migrationNames.length) throw new Error("No versioned database migrations were found");
const migrations = await Promise.all(migrationNames.map(async name => {
  const source = await readFile(new URL(name, migrationsUrl), "utf8");
  return Object.freeze({ version: name.slice(0, -4), source, checksum: digest(source) });
}));

const client = new Client({ connectionString, application_name: "deviludo-schema-migrations" });
await client.connect();
try {
  // A session advisory lock prevents two replicas from applying the same change
  // concurrently. It is released even if a migration fails and this process exits.
  await client.query("SELECT pg_advisory_lock(hashtext('deviludo-schema-migrations-v1'))");
  const existing = await client.query("SELECT to_regclass('deviludo.schema_metadata') IS NOT NULL AS present");
  if (!existing.rows[0]?.present) {
    await client.query(baselineSource);
    // The full baseline is always the latest snapshot, so a fresh database records
    // every migration it already incorporates instead of executing the same DDL a
    // second time.
    await client.query("BEGIN");
    try {
      await client.query(
        "UPDATE deviludo.schema_metadata SET source_digest = $1, current_version = $2 WHERE singleton = true",
        [baselineDigest, migrations.at(-1).version],
      );
      for (const migration of migrations) {
        await client.query(
          "INSERT INTO deviludo.schema_migrations(version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } else {
    const metadata = await client.query(
      "SELECT baseline, compatibility, current_version, source_digest FROM deviludo.schema_metadata WHERE singleton = true",
    );
    if (metadata.rows[0]?.baseline !== "001" || metadata.rows[0]?.compatibility !== "deviludo-self-hosted-v1") {
      throw Object.assign(new Error(
        "INCOMPATIBLE_BASELINE_RESET_REQUIRED: this database predates the self-hosted-only schema",
      ), { code: "INCOMPATIBLE_BASELINE_RESET_REQUIRED" });
    }

    // Databases created by the former single-baseline runner do not have the
    // migration ledger. Bootstrap only that ledger, then apply immutable changes.
    await client.query("BEGIN");
    try {
      await client.query("ALTER TABLE deviludo.schema_metadata ADD COLUMN IF NOT EXISTS current_version text NOT NULL DEFAULT '001'");
      await client.query(`
        CREATE TABLE IF NOT EXISTS deviludo.schema_migrations (
          version text PRIMARY KEY CHECK (version ~ '^[0-9]{3}_[a-z0-9_]+$'),
          checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
          applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    let applied = await client.query("SELECT version, checksum FROM deviludo.schema_migrations ORDER BY version");
    const baselineHasAllMigrations = applied.rows.length === 0
      && metadata.rows[0]?.source_digest === null
      && metadata.rows[0]?.current_version === migrations.at(-1)?.version;
    if (baselineHasAllMigrations) {
      // postgres' init directory applies the full baseline before this runner is
      // invoked. The version embedded in that snapshot proves its DDL already
      // includes every migration in this release, so only stamp the immutable
      // ledger instead of replaying ALTER statements over the same schema.
      await client.query("BEGIN");
      try {
        await client.query(
          "UPDATE deviludo.schema_metadata SET source_digest = $1 WHERE singleton = true",
          [baselineDigest],
        );
        for (const migration of migrations) {
          await client.query(
            "INSERT INTO deviludo.schema_migrations(version, checksum) VALUES ($1, $2)",
            [migration.version, migration.checksum],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied = await client.query("SELECT version, checksum FROM deviludo.schema_migrations ORDER BY version");
    }
    const appliedByVersion = new Map(applied.rows.map(row => [row.version, row.checksum]));
    const knownVersions = new Set(migrations.map(migration => migration.version));
    const unknownVersions = applied.rows
      .map(row => row.version)
      .filter(version => !knownVersions.has(version));
    if (unknownVersions.length > 0) {
      throw Object.assign(new Error(
        `DATABASE_SCHEMA_AHEAD: database contains migrations unknown to this release: ${unknownVersions.join(", ")}`,
      ), { code: "DATABASE_SCHEMA_AHEAD" });
    }
    for (const migration of migrations) {
      const previousChecksum = appliedByVersion.get(migration.version);
      if (previousChecksum) {
        if (previousChecksum !== migration.checksum) {
          throw Object.assign(new Error(
            `MIGRATION_CHECKSUM_MISMATCH: ${migration.version} was modified after it was applied`,
          ), { code: "MIGRATION_CHECKSUM_MISMATCH" });
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(migration.source);
        await client.query(
          "INSERT INTO deviludo.schema_migrations(version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum],
        );
        await client.query(
          "UPDATE deviludo.schema_metadata SET current_version = $1 WHERE singleton = true",
          [migration.version],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          migrationVersion: migration.version,
        });
      }
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('deviludo-schema-migrations-v1'))").catch(() => undefined);
  await client.end();
}

function digest(source) {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}
