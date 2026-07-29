import { readFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const connectionString = process.env.DEVILUDO_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (!connectionString) throw new Error("DEVILUDO_MIGRATION_DATABASE_URL is required");
const url = new URL(connectionString);
if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || url.pathname.length < 2) {
  throw new Error("Migration database URL is invalid");
}
if (process.env.NODE_ENV === "production" && process.env.DEVILUDO_MIGRATION_DATABASE_URL) {
  throw new Error("Production migration credentials must be supplied by the deployment secret injector");
}

const source = await readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8");
const client = new Client({ connectionString, application_name: "deviludo-fresh-baseline" });
await client.connect();
try {
  const existing = await client.query("SELECT to_regnamespace('deviludo') IS NOT NULL AS present");
  if (existing.rows[0]?.present) {
    throw new Error("The fresh 001 baseline refuses an existing database; provision a new empty PostgreSQL database");
  }
  await client.query(source);
  console.log(JSON.stringify({ applied: "001_core.sql", mode: "fresh-baseline" }));
} finally {
  await client.end();
}
