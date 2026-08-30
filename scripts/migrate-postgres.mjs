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
  "sha256:569dff1f7cd504d55a92df68d55e66c1b051f087a5257e5b81e0c84843e2a82e": Object.freeze({
    targetDigest: "sha256:a00ccad5f349a9f580fba87b4932611a27630613e201dede3487acffec0f7005",
    functions: Object.freeze(["complete_job"]),
  }),
  "sha256:1b9e6ffa40a5c90c341775d4da28a2118700b938221fa3b50c6d04312d0b30cc": Object.freeze({
    targetDigest: "sha256:569dff1f7cd504d55a92df68d55e66c1b051f087a5257e5b81e0c84843e2a82e",
    functions: Object.freeze(["complete_agent_turn_job"]),
  }),
  "sha256:250908699fd180b98c6b15ad6442c64b59df98a07f6caa88453dee88999d69b9": Object.freeze({
    targetDigest: "sha256:1b9e6ffa40a5c90c341775d4da28a2118700b938221fa3b50c6d04312d0b30cc",
    functions: Object.freeze(["complete_agent_turn_job"]),
  }),
  "sha256:4c51210e34a01b477f112ee82c9373d49cf949389894b9bc9a4ef084b1d11427": Object.freeze({
    targetDigest: "sha256:250908699fd180b98c6b15ad6442c64b59df98a07f6caa88453dee88999d69b9",
    functions: Object.freeze(["complete_agent_turn_job"]),
  }),
  "sha256:5c47efde535b0775f73ca65a50bb30db24ad53e07ecb5af2c46bab6f652285e6": Object.freeze({
    targetDigest: "sha256:914ad147269c91486c8bc6eca5c238fad7053d65e53adf76bda97ea65a88dc4d",
    functions: Object.freeze(["accept_workflow_signal"]),
  }),
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
const DEVELOPMENT_SCHEMA_REFRESHES = Object.freeze({
  "sha256:914ad147269c91486c8bc6eca5c238fad7053d65e53adf76bda97ea65a88dc4d": Object.freeze({
    targetDigest: "sha256:4c51210e34a01b477f112ee82c9373d49cf949389894b9bc9a4ef084b1d11427",
    schema: "UPLOAD_ONLY_MUSIC_ASSETS",
    functions: Object.freeze([
      "snapshot_artifact_build_assets",
      "complete_agent_turn_job",
      "claim_asset_generation",
      "request_asset_rerun",
      "advance_asset_workflows",
    ]),
  }),
  "sha256:c917b31e2773207375ba88cbb5c21dac430e21a2158c660f0824739250cb54a1": Object.freeze({
    targetDigest: "sha256:914ad147269c91486c8bc6eca5c238fad7053d65e53adf76bda97ea65a88dc4d",
    schema: "UI_DESIGN_ROLE",
    functions: Object.freeze([
      "complete_agent_turn_job",
      "publish_development_agent_message",
      "accept_workflow_signal",
    ]),
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
    const refresh = compatibleDevelopmentFunctionRefresh(current, ledger.rows, baselineDigest)
      ?? compatibleDevelopmentSchemaRefresh(current, ledger.rows, baselineDigest);
    if (!refresh) {
      throw resetRequired("the database schema differs from this release's immutable baseline");
    }
    if ("schema" in refresh) await prepareDevelopmentSchemaRefresh(client, refresh.schema);
    await client.query("BEGIN");
    try {
      if ("schema" in refresh) await applyDevelopmentSchemaRefresh(client, refresh.schema);
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
      console.log(`Refreshed the compatible development database snapshot without deleting data (${refresh.functions.length} functions)`);
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

function compatibleDevelopmentSchemaRefresh(current, ledger, targetDigest) {
  if (process.env.NODE_ENV !== "development"
    || ledger.length !== 1
    || ledger[0]?.version !== VERSION
    || ledger[0]?.checksum !== current.source_digest) return null;
  const refresh = DEVELOPMENT_SCHEMA_REFRESHES[current.source_digest];
  return refresh?.targetDigest === targetDigest ? refresh : null;
}

async function prepareDevelopmentSchemaRefresh(database, schema) {
  if (schema === "UPLOAD_ONLY_MUSIC_ASSETS") return;
  if (schema !== "UI_DESIGN_ROLE") throw new Error("Compatible development schema refresh is invalid");
  await database.query("BEGIN");
  try {
    await database.query("ALTER TYPE deviludo.workflow_state ADD VALUE IF NOT EXISTS 'UI_DESIGNING' BEFORE 'DEVELOPING'");
    await database.query("ALTER TYPE deviludo.agent_role ADD VALUE IF NOT EXISTS 'UI_DESIGN' BEFORE 'DEVELOPMENT'");
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  }
}

async function applyDevelopmentSchemaRefresh(database, schema) {
  if (schema === "UPLOAD_ONLY_MUSIC_ASSETS") {
    await database.query("ALTER TABLE deviludo.asset_items DROP CONSTRAINT asset_items_asset_type_check");
    await database.query(`ALTER TABLE deviludo.asset_items
      ADD CONSTRAINT asset_items_asset_type_check CHECK (
        asset_type IN ('sprite', 'animation', 'background', 'ui', 'icon', 'tileset', 'music')
      ),
      ADD CONSTRAINT asset_items_music_upload_only CHECK (
        asset_type <> 'music'
        OR (generation_prompt IS NULL AND frame_count IS NULL AND dimensions IS NULL AND source_path IS NULL)
      )`);
    return;
  }
  if (schema !== "UI_DESIGN_ROLE") throw new Error("Compatible development schema refresh is invalid");
  await database.query("ALTER TABLE deviludo.instance_agent_settings DROP CONSTRAINT instance_agent_settings_model_overrides_check");
  await database.query(`UPDATE deviludo.instance_agent_settings
    SET model_overrides = jsonb_set(model_overrides, '{uiDesign}', 'null'::jsonb, true)
    WHERE NOT model_overrides ? 'uiDesign'`);
  await database.query(`ALTER TABLE deviludo.instance_agent_settings
    ADD CONSTRAINT instance_agent_settings_model_overrides_check CHECK (
      jsonb_typeof(model_overrides) = 'object'
      AND model_overrides ?& ARRAY['intent', 'analysis', 'design', 'uiDesign', 'development', 'test']
      AND model_overrides - ARRAY['intent', 'analysis', 'design', 'uiDesign', 'development', 'test']::text[] = '{}'::jsonb
      AND (model_overrides->'intent' = 'null'::jsonb OR (model_overrides->>'intent') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
      AND (model_overrides->'analysis' = 'null'::jsonb OR (model_overrides->>'analysis') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
      AND (model_overrides->'design' = 'null'::jsonb OR (model_overrides->>'design') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
      AND (model_overrides->'uiDesign' = 'null'::jsonb OR (model_overrides->>'uiDesign') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
      AND (model_overrides->'development' = 'null'::jsonb OR (model_overrides->>'development') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
      AND (model_overrides->'test' = 'null'::jsonb OR (model_overrides->>'test') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
    )`);
  await database.query("ALTER TABLE deviludo.project_documents DROP CONSTRAINT project_documents_content_check");
  for (const table of ["project_documents", "project_document_revisions"]) {
    await database.query(`UPDATE deviludo.${table}
      SET content = jsonb_set(content, '{uiDesign}', to_jsonb('Pending UI Design Agent specification.'::text), true)
      WHERE jsonb_typeof(content->'uiDesign') IS DISTINCT FROM 'string'`);
  }
  await database.query(`ALTER TABLE deviludo.project_documents
    ADD CONSTRAINT project_documents_content_check CHECK (
      jsonb_typeof(content) = 'object'
      AND jsonb_typeof(content->'introduction') = 'string'
      AND jsonb_typeof(content->'gameplay') = 'string'
      AND jsonb_typeof(content->'uiDesign') = 'string'
      AND jsonb_typeof(content->'categories') = 'array'
      AND jsonb_array_length(content->'categories') BETWEEN 1 AND 32
      AND jsonb_typeof(content->'features') = 'array'
      AND jsonb_array_length(content->'features') BETWEEN 1 AND 32
    )`);
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
