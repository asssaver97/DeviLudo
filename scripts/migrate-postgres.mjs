import { readFile } from "node:fs/promises";
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

const source = await readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8");
const client = new Client({ connectionString, application_name: "deviludo-source-baseline" });
await client.connect();
try {
  const existing = await client.query("SELECT to_regclass('deviludo.schema_metadata') IS NOT NULL AS present");
  if (!existing.rows[0]?.present) {
    await client.query(source);
  } else {
    const metadata = await client.query("SELECT baseline, compatibility FROM deviludo.schema_metadata WHERE singleton = true");
    if (metadata.rows[0]?.baseline !== "001" || metadata.rows[0]?.compatibility !== "deviludo-core-source-v1") {
      throw Object.assign(new Error(
        "INCOMPATIBLE_BASELINE_RESET_REQUIRED: persistent source v1 requires an empty Core database, artifact space, project source root, and Core Vault namespace",
      ), { code: "INCOMPATIBLE_BASELINE_RESET_REQUIRED" });
    }
  }
} finally {
  await client.end();
}
