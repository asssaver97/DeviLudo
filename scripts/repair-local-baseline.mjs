/**
 * Brings a local database whose schema predates infra/postgres/001_core.sql up to
 * that baseline, without dropping the projects already in it.
 *
 * This is needed because migrate-postgres.mjs applied the baseline only when it
 * was absent, then verified a compatibility string that does not change on every
 * edit -- so each change to the baseline after the volume was created was skipped
 * silently. A stale function does not announce itself: accept_workflow_signal
 * without a STAGE_RERUN_REQUESTED branch accepted the signal, returned success,
 * and routed nothing, which reached the user as a rerun button that did nothing.
 *
 * The DDL lives in infra/postgres/repair/001_asset_baseline_catchup.sql. The
 * function bodies are not copied there: they are extracted from the baseline and
 * replayed here, so they cannot drift from the file they are meant to match.
 *
 * Idempotent. Safe against an already-current database. Only for existing local
 * databases -- a fresh one gets the baseline directly and never needs this.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const connectionFile = process.env.DEVILUDO_MIGRATION_DATABASE_URL_FILE;
if (connectionFile && process.env.DEVILUDO_MIGRATION_DATABASE_URL) {
  throw new Error("Set only one migration credential source");
}
const connectionString = connectionFile
  ? (await readFile(connectionFile, "utf8")).trim()
  : process.env.DEVILUDO_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (!connectionString) throw new Error("DEVILUDO_MIGRATION_DATABASE_URL is required");
// A repair rewrites function bodies in place. That is a local recovery step, not
// something to point at a shared database, where the reviewed path is the
// baseline itself.
if (process.env.NODE_ENV === "production") {
  throw new Error("Refusing to repair a production database; apply the reviewed baseline instead");
}

const baseline = await readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8");
const repair = await readFile(
  new URL("../infra/postgres/repair/001_asset_baseline_catchup.sql", import.meta.url),
  "utf8",
);
const sourceDigest = `sha256:${createHash("sha256").update(baseline, "utf8").digest("hex")}`;

/**
 * Extracts complete `CREATE OR REPLACE FUNCTION` statements from the baseline,
 * along with the `ALTER FUNCTION ... OWNER TO` that follows them. Bodies are
 * dollar-quoted, so the terminator is the closing tag of whichever tag opened the
 * body -- scanning for the next semicolon would cut the statement in half.
 */
function extractFunctions(sql) {
  const statements = [];
  const opening = /CREATE OR REPLACE FUNCTION\s+deviludo\.([a-z0-9_]+)\s*\(/g;
  let match;
  while ((match = opening.exec(sql)) !== null) {
    const tag = sql.slice(match.index).match(/AS (\$[A-Za-z_]*\$)/);
    if (!tag) throw new Error(`Function ${match[1]} has no dollar-quoted body`);
    const bodyStart = match.index + (tag.index ?? 0) + tag[0].length;
    const bodyEnd = sql.indexOf(tag[1], bodyStart);
    if (bodyEnd < 0) throw new Error(`Function ${match[1]} body is unterminated`);
    const semicolon = sql.indexOf(";", bodyEnd + tag[1].length);
    if (semicolon < 0) throw new Error(`Function ${match[1]} statement is unterminated`);
    let end = semicolon + 1;
    // An owner change is part of defining the function: replacing the body without
    // it would leave a SECURITY DEFINER function owned by whoever ran the repair.
    const owner = sql.slice(end).match(
      new RegExp(`^\\s*ALTER FUNCTION deviludo\\.${match[1]}\\([^;]*\\)\\s*\\n?\\s*OWNER TO [a-z_]+;`),
    );
    if (owner) end += owner[0].length;
    statements.push({ name: match[1], sql: sql.slice(match.index, end) });
    opening.lastIndex = end;
  }
  return statements;
}

const functions = extractFunctions(baseline);
// Compared against the declarations in the file rather than a fixed number, so a
// body the scanner cannot parse is caught here instead of being quietly skipped
// and leaving that one function stale -- the failure mode this whole script exists
// to correct.
const declared = baseline.match(/CREATE OR REPLACE FUNCTION\s+deviludo\./g)?.length ?? 0;
if (functions.length !== declared) {
  throw new Error(`Baseline declares ${declared} functions but only ${functions.length} could be extracted`);
}

const client = new pg.Client({ connectionString, application_name: "deviludo-local-baseline-repair" });
await client.connect();
const applied = { tables: [], functions: [], grants: 0 };
try {
  const present = await client.query(
    "SELECT to_regclass('deviludo.schema_metadata') IS NOT NULL AS present",
  );
  if (!present.rows[0]?.present) {
    throw new Error("No deviludo schema to repair; run the migration to apply the baseline first");
  }
  const before = await client.query(
    `SELECT to_regclass('deviludo.asset_items') IS NOT NULL AS assets,
            (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'deviludo') AS functions`,
  );

  // The DDL file manages its own transaction, so it is sent as one script.
  await client.query(repair);
  applied.tables = ["instance_image_generation_settings", "asset_manifests", "asset_items"];

  // Each function is replaced in its own transaction: one that fails to compile
  // should not roll back the ones that already applied, and the failure names the
  // function so it can be fixed in the baseline rather than guessed at.
  for (const definition of functions) {
    try {
      await client.query(definition.sql);
      applied.functions.push(definition.name);
    } catch (error) {
      throw new Error(`Replacing deviludo.${definition.name} failed: ${error.message}`);
    }
  }

  // Recorded last: the digest asserts that everything above landed, so a failure
  // partway leaves it unrecorded and the migration still reports drift.
  await client.query(
    "UPDATE deviludo.schema_metadata SET source_digest = $1, applied_at = clock_timestamp() WHERE singleton = true",
    [sourceDigest],
  );
  process.stdout.write(`${JSON.stringify({
    repaired: true,
    hadAssetTables: before.rows[0]?.assets === true,
    functionsBefore: Number(before.rows[0]?.functions ?? 0),
    functionsReplaced: applied.functions.length,
    sourceDigest,
  }, null, 2)}\n`);
} finally {
  await client.end();
}
