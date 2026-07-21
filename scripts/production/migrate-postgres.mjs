#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;
const MIGRATION_FILE = /^(\d{3})_([a-z0-9_]+)\.sql$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LOCK_CLASS = 1_145_650_948;
const LOCK_KEY = 1_836_019_569;
const MAX_SECRET_BYTES = 1_048_576;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const CREATE_LEDGER_SQL = `CREATE TABLE IF NOT EXISTS public.deviludo_schema_migrations (
  version integer PRIMARY KEY CHECK (version BETWEEN 1 AND 999),
  filename text NOT NULL UNIQUE CHECK (
    filename ~ '^[0-9]{3}_[a-z0-9_]+\\.sql$'
    AND left(filename, 3) = lpad(version::text, 3, '0')
  ),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
REVOKE ALL ON TABLE public.deviludo_schema_migrations FROM PUBLIC;`;

export async function loadPostgresMigrations(directory = resolve(process.cwd(), "infra/postgres")) {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) throw new Error("No PostgreSQL migrations were found");
  const migrations = [];
  for (const [index, filename] of names.entries()) {
    const match = MIGRATION_FILE.exec(filename);
    const version = Number(match?.[1]);
    if (!match || version !== index + 1) {
      throw new Error(`PostgreSQL migrations must be a contiguous 001-based sequence: ${filename}`);
    }
    const source = await readFile(resolve(directory, filename), "utf8");
    validateMigrationSource(filename, source);
    migrations.push(Object.freeze({
      version,
      filename,
      digest: createHash("sha256").update(source).digest("hex"),
      source,
    }));
  }
  return Object.freeze(migrations);
}

export function validateMigrationSource(filename, source) {
  const transactionStatements = source.match(/^\s*(?:BEGIN|COMMIT);\s*$/gm) ?? [];
  if (!MIGRATION_FILE.test(filename) || Buffer.byteLength(source) > 16 * 1024 * 1024
    || !/^BEGIN;\s/.test(source) || !/\nCOMMIT;\s*$/.test(source)
    || transactionStatements.length !== 2
    || /^\s*\\/m.test(source) || source.includes("\u0000")) {
    throw new Error(`PostgreSQL migration has an unsafe transaction contract: ${filename}`);
  }
}

export function validateAppliedMigrations(migrations, rows) {
  if (!Array.isArray(rows)) throw new Error("PostgreSQL migration ledger is invalid");
  const applied = rows.map((row, index) => {
    const version = Number(row?.version);
    const filename = row?.filename;
    const digest = row?.digest;
    const expected = migrations[index];
    if (!Number.isSafeInteger(version) || version !== index + 1 || !expected
      || filename !== expected.filename || digest !== expected.digest) {
      throw new Error(`PostgreSQL migration ledger drift at version ${String(row?.version ?? index + 1)}`);
    }
    return expected;
  });
  return Object.freeze({
    applied: Object.freeze(applied),
    pending: Object.freeze(migrations.slice(applied.length)),
  });
}

export function migrationWithLedgerRecord(migration) {
  if (!Number.isSafeInteger(migration.version) || migration.version < 1 || migration.version > 999
    || !MIGRATION_FILE.test(migration.filename) || !SHA256.test(migration.digest)) {
    throw new Error("PostgreSQL migration identity is invalid");
  }
  const record = `INSERT INTO public.deviludo_schema_migrations (version, filename, digest)\n`
    + `VALUES (${migration.version}, '${migration.filename}', '${migration.digest}');\n\nCOMMIT;`;
  return migration.source.replace(/COMMIT;\s*$/, record);
}

export async function runPostgresMigrations({
  client,
  migrations,
  adoptExisting = false,
  onApplied = () => undefined,
}) {
  let locked = false;
  try {
    const lock = await client.query(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
      [LOCK_CLASS, LOCK_KEY],
    );
    if (lock.rows?.[0]?.acquired !== true) throw new Error("Another PostgreSQL migrator holds the deployment lock");
    locked = true;
    await client.query("SET search_path TO pg_catalog, public");
    const version = await client.query("SELECT current_setting('server_version_num')::integer AS version");
    if (!Number.isSafeInteger(version.rows?.[0]?.version) || version.rows[0].version < 140_000) {
      throw new Error("PostgreSQL 14 or newer is required");
    }
    await client.query(CREATE_LEDGER_SQL);
    let rows = await readLedger(client);
    const schema = await client.query("SELECT to_regnamespace('deviludo') IS NOT NULL AS present");
    if (rows.length === 0 && schema.rows?.[0]?.present === true) {
      if (!adoptExisting) {
        throw new Error("Existing schema has no migration ledger; use the explicit local adoption command after backup");
      }
      const baseline = migrations.find((migration) => migration.filename === "061_schema_migration_ledger.sql");
      if (!baseline) throw new Error("The schema migration baseline is missing");
      await executeMigration(client, baseline.source, baseline.filename);
      rows = await readLedger(client);
    }
    const plan = validateAppliedMigrations(migrations, rows);
    for (const migration of plan.pending) {
      await executeMigration(client, migrationWithLedgerRecord(migration), migration.filename);
      await onApplied(Object.freeze({ version: migration.version, filename: migration.filename, digest: migration.digest }));
    }
    const finalRows = await readLedger(client);
    const finalPlan = validateAppliedMigrations(migrations, finalRows);
    if (finalPlan.pending.length !== 0) throw new Error("PostgreSQL migration ledger did not reach the repository head");
    return Object.freeze({ applied: plan.pending.length, currentVersion: migrations.at(-1)?.version ?? 0 });
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [LOCK_CLASS, LOCK_KEY])
        .catch(() => undefined);
    }
  }
}

async function readLedger(client) {
  const result = await client.query(
    "SELECT version, filename, digest FROM public.deviludo_schema_migrations ORDER BY version",
  );
  return result.rows ?? [];
}

async function executeMigration(client, source, filename) {
  try {
    await client.query(source);
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error(`PostgreSQL migration failed: ${filename}`);
  }
}

export async function resolveMigrationClientConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  let connectionString;
  if (production) {
    if (env.DATABASE_URL || env.DEVILUDO_MIGRATION_DATABASE_URL) {
      throw new Error("Production migration credentials must be file-mounted and isolated from application credentials");
    }
    connectionString = await boundedSecretFile(env.DEVILUDO_MIGRATION_DATABASE_URL_FILE, 8_192);
  } else {
    connectionString = env.DEVILUDO_MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
  }
  if (typeof connectionString !== "string" || connectionString.length < 1 || connectionString.length > 8_192) {
    throw new Error("PostgreSQL migration database URL is required");
  }
  if (/[\u0000-\u001f\u007f]/.test(connectionString)) {
    throw new Error("PostgreSQL migration database URL is invalid");
  }
  let url;
  try { url = new URL(connectionString); } catch { throw new Error("PostgreSQL migration database URL is invalid"); }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || !url.username || url.pathname.length < 2
    || url.search || url.hash) {
    throw new Error("PostgreSQL migration database URL is invalid");
  }
  if (!production && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("Non-production migrations are restricted to a loopback PostgreSQL server");
  }
  const ssl = production ? {
    rejectUnauthorized: true,
    ...await optionalTlsFiles(env),
  } : false;
  return Object.freeze({
    connectionString,
    connectionTimeoutMillis: 5_000,
    application_name: "deviludo-schema-migrator",
    ssl,
  });
}

async function optionalTlsFiles(env) {
  const ca = await optionalSecretFile(env.DEVILUDO_MIGRATION_POSTGRES_CA_FILE);
  const certificate = await optionalSecretFile(env.DEVILUDO_MIGRATION_POSTGRES_CERT_FILE);
  const key = await optionalSecretFile(env.DEVILUDO_MIGRATION_POSTGRES_KEY_FILE);
  if ((certificate === undefined) !== (key === undefined)) {
    throw new Error("PostgreSQL migration client certificate and key must be configured together");
  }
  return Object.freeze({
    ...(ca === undefined ? {} : { ca }),
    ...(certificate === undefined ? {} : { cert: certificate, key }),
  });
}

async function optionalSecretFile(path) {
  if (path === undefined || path === "") return undefined;
  return boundedSecretFile(path, MAX_SECRET_BYTES, false);
}

async function boundedSecretFile(path, limit, trim = true) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Migration secret paths must be absolute files");
  let value;
  try { value = await readFile(path); } catch { throw new Error("Migration secret file is unavailable"); }
  if (value.length < 1 || value.length > limit || value.includes(0)) throw new Error("Migration secret file is invalid");
  return trim ? value.toString("utf8").trim() : value.toString("utf8");
}

export function safeMigrationFailure(error) {
  const message = error instanceof Error ? error.message : "";
  if (/^(?:No PostgreSQL migrations were found|PostgreSQL migrations must be a contiguous 001-based sequence: [0-9a-z_.-]+|PostgreSQL migration has an unsafe transaction contract: [0-9a-z_.-]+|PostgreSQL migration ledger (?:is invalid|drift at version [0-9]+)|PostgreSQL migration identity is invalid|Another PostgreSQL migrator holds the deployment lock|PostgreSQL 14 or newer is required|Existing schema has no migration ledger; use the explicit local adoption command after backup|The schema migration baseline is missing|PostgreSQL migration failed: [0-9]{3}_[a-z0-9_]+\.sql|PostgreSQL migration ledger did not reach the repository head|Production migration credentials must be file-mounted and isolated from application credentials|PostgreSQL migration database URL is (?:required|invalid)|Non-production migrations are restricted to a loopback PostgreSQL server|PostgreSQL migration client certificate and key must be configured together|Migration secret paths must be absolute files|Migration secret file is (?:unavailable|invalid)|Unsupported PostgreSQL migration argument|Production databases cannot adopt an untracked migration baseline)$/.test(message)) {
    return message;
  }
  return "PostgreSQL migration unavailable";
}

function loadLocalDotEnv() {
  if (process.env.NODE_ENV === "production") return;
  const path = resolve(process.cwd(), ".env");
  if (existsSync(path)) loadEnvFile(path);
}

async function main() {
  loadLocalDotEnv();
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--adopt-existing")
    || arguments_.filter((argument) => argument === "--adopt-existing").length > 1) {
    throw new Error("Unsupported PostgreSQL migration argument");
  }
  const adoptExisting = arguments_.includes("--adopt-existing");
  if (adoptExisting && process.env.NODE_ENV === "production") {
    throw new Error("Production databases cannot adopt an untracked migration baseline");
  }
  const client = new Client(await resolveMigrationClientConfig());
  try {
    await client.connect();
    const result = await runPostgresMigrations({
      client,
      migrations: await loadPostgresMigrations(),
      adoptExisting,
      onApplied: ({ filename }) => process.stdout.write(`[db:migrate] applied ${filename}\n`),
    });
    process.stdout.write(`[db:migrate] schema ${String(result.currentVersion).padStart(3, "0")} ready (${result.applied} applied)\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[db:migrate] ${safeMigrationFailure(error)}\n`);
    process.exitCode = 1;
  });
}
