import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const BASELINE = "003";
const COMPATIBILITY = "deviludo-persistent-multi-agent-v3";
const VERSION = "001_persistent_multi_agent";
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

const baselineSource = await readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8");
const baselineDigest = digest(baselineSource);
const client = new Client({ connectionString, application_name: "deviludo-schema-baseline" });
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('deviludo-persistent-multi-agent-v3'))");
  const existing = await client.query("SELECT to_regclass('deviludo.schema_metadata') IS NOT NULL AS present");
  if (!existing.rows[0]?.present) await client.query(baselineSource);

  const metadata = await client.query(
    "SELECT baseline, compatibility, current_version, source_digest FROM deviludo.schema_metadata WHERE singleton = true",
  );
  const current = metadata.rows[0];
  if (!current
    || current.baseline !== BASELINE
    || current.compatibility !== COMPATIBILITY
    || current.current_version !== VERSION) {
    throw resetRequired("the database does not use the persistent multi-Agent v3 baseline");
  }

  const ledger = await client.query("SELECT version, checksum FROM deviludo.schema_migrations ORDER BY version");
  const initializedByPostgres = current.source_digest === null && ledger.rows.length === 0;
  if (initializedByPostgres) {
    // Docker's init directory may load the complete baseline before this process
    // starts. Stamp that exact snapshot; never replay historical ALTER scripts.
    await client.query("BEGIN");
    try {
      await client.query(
        "UPDATE deviludo.schema_metadata SET source_digest = $1 WHERE singleton = true",
        [baselineDigest],
      );
      await client.query(
        "INSERT INTO deviludo.schema_migrations(version, checksum) VALUES ($1, $2)",
        [VERSION, baselineDigest],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } else if (current.source_digest !== baselineDigest
    || ledger.rows.length !== 1
    || ledger.rows[0]?.version !== VERSION
    || ledger.rows[0]?.checksum !== baselineDigest) {
    throw resetRequired("the database schema differs from this release's immutable baseline");
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('deviludo-persistent-multi-agent-v3'))").catch(() => undefined);
  await client.end();
}

function resetRequired(reason) {
  return Object.assign(new Error(
    `INCOMPATIBLE_BASELINE_RESET_REQUIRED: ${reason}; in-place migration is intentionally unsupported`,
  ), { code: "INCOMPATIBLE_BASELINE_RESET_REQUIRED" });
}

function digest(source) {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}
