import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const BASELINE = "003";
const COMPATIBILITY = "deviludo-persistent-multi-agent-v3";
const VERSION = "001_persistent_multi_agent";
// Development checkouts can move the implementation of an existing function
// without changing the persistent data shape. Keep these refreshes exact and
// finite: both full-file digests and every replaceable function are reviewed.
// Unknown snapshots, production databases, and all structural changes still
// require the explicit destructive reset.
const DEVELOPMENT_FUNCTION_REFRESHES = Object.freeze({
  "sha256:8f231ec989e4bf3d38ce2242cdcda52e4e562091bff3a581506ade9ba85c9e79": Object.freeze({
    targetDigest: "sha256:c917b31e2773207375ba88cbb5c21dac430e21a2158c660f0824739250cb54a1",
    functions: Object.freeze(["complete_agent_turn_job"]),
  }),
  "sha256:938d91a606e0698d260da5f903a8eeedb928a54abb0ac446984b0616efa7ddd4": Object.freeze({
    targetDigest: "sha256:8f231ec989e4bf3d38ce2242cdcda52e4e562091bff3a581506ade9ba85c9e79",
    functions: Object.freeze(["claim_agent_container_lifecycle"]),
  }),
  "sha256:0743ff5b1cd235cec7268fd3533a819f6f1657d8a46aa72492471f7542054a38": Object.freeze({
    targetDigest: "sha256:938d91a606e0698d260da5f903a8eeedb928a54abb0ac446984b0616efa7ddd4",
    functions: Object.freeze(["complete_agent_turn_job", "complete_job"]),
  }),
  "sha256:96384b5f8ea0e01bbdbb482aa9578e2eac6ceec52b3abb33a65ddafc6e121c74": Object.freeze({
    targetDigest: "sha256:0743ff5b1cd235cec7268fd3533a819f6f1657d8a46aa72492471f7542054a38",
    functions: Object.freeze([
      "complete_agent_turn_job",
      "advance_asset_workflows",
      "complete_job",
      "publish_development_agent_message",
      "enqueue_job",
      "claim_job",
      "fail_job",
      "accept_workflow_signal",
    ]),
  }),
  "sha256:6d13a7454178ac15c3bce4b2d8f11a0d42a120a5cedd7aecab90b6b92dd4500d": Object.freeze({
    targetDigest: "sha256:0743ff5b1cd235cec7268fd3533a819f6f1657d8a46aa72492471f7542054a38",
    functions: Object.freeze([
      "publish_development_agent_message", "enqueue_job", "claim_job", "fail_job", "accept_workflow_signal",
    ]),
  }),
  "sha256:cfa7b7fefde20e24a4f8a026ef23053429d28945f780c174dfb20b3de503e65c": Object.freeze({
    targetDigest: "sha256:0743ff5b1cd235cec7268fd3533a819f6f1657d8a46aa72492471f7542054a38",
    functions: Object.freeze(["enqueue_job", "claim_job", "fail_job", "accept_workflow_signal"]),
  }),
  "sha256:f0c5d77abd07e73807b6f4c7065d7bb9d46a9b1f552127218765cc8487acd4d5": Object.freeze({
    targetDigest: "sha256:0743ff5b1cd235cec7268fd3533a819f6f1657d8a46aa72492471f7542054a38",
    functions: Object.freeze(["accept_workflow_signal"]),
  }),
  "sha256:2b5c321c4828065ca6044d3a63fe3c8dad1e8b179a1d26e025af05c8ade2dd6f": Object.freeze({
    targetDigest: "sha256:0743ff5b1cd235cec7268fd3533a819f6f1657d8a46aa72492471f7542054a38",
    functions: Object.freeze(["accept_workflow_signal"]),
  }),
});
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
    const refresh = compatibleDevelopmentFunctionRefresh(current, ledger.rows, baselineDigest);
    if (!refresh) {
      throw resetRequired("the database schema differs from this release's immutable baseline");
    }
    await client.query("BEGIN");
    try {
      for (const functionName of refresh.functions) {
        await client.query(functionDefinition(baselineSource, functionName));
      }
      const metadata = await client.query(
        `UPDATE deviludo.schema_metadata
            SET source_digest = $1
          WHERE singleton = true AND source_digest = $2
          RETURNING singleton`,
        [baselineDigest, current.source_digest],
      );
      const migration = await client.query(
        `UPDATE deviludo.schema_migrations
            SET checksum = $1, applied_at = clock_timestamp()
          WHERE version = $2 AND checksum = $3
          RETURNING version`,
        [baselineDigest, VERSION, current.source_digest],
      );
      if (metadata.rowCount !== 1 || migration.rowCount !== 1) {
        throw new Error("Compatible development baseline refresh lost its database fence");
      }
      await client.query("COMMIT");
      console.log(`Refreshed ${refresh.functions.length} compatible development database functions without deleting data`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
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

function compatibleDevelopmentFunctionRefresh(current, ledger, targetDigest) {
  if (process.env.NODE_ENV !== "development"
    || ledger.length !== 1
    || ledger[0]?.version !== VERSION
    || ledger[0]?.checksum !== current.source_digest) return null;
  const refresh = DEVELOPMENT_FUNCTION_REFRESHES[current.source_digest];
  return refresh?.targetDigest === targetDigest ? refresh : null;
}

function functionDefinition(source, functionName) {
  if (!/^[a-z][a-z0-9_]*$/.test(functionName)) throw new Error("Compatible function name is invalid");
  const marker = `CREATE OR REPLACE FUNCTION deviludo.${functionName}(`;
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) {
    throw new Error(`Compatible function ${functionName} is not unique in the baseline`);
  }
  const body = source.indexOf("\nAS $$", start);
  const end = body < 0 ? -1 : source.indexOf("\n$$;", body);
  if (body < 0 || end < 0) throw new Error(`Compatible function ${functionName} is incomplete`);
  return source.slice(start, end + "\n$$;".length);
}

function digest(source) {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}
