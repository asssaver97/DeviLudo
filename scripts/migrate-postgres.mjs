import { createHash } from "node:crypto";
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
// The baseline is a full snapshot rather than a sequence of increments, so the
// compatibility string alone cannot tell an up-to-date database from one whose
// functions predate this file: it only changes when the shape changes
// incompatibly, and every edit in between is invisible to it. Recording a digest
// of the applied bytes makes drift detectable, which matters because a stale
// function does not fail -- accept_workflow_signal simply routes nothing, and the
// user sees a control that does nothing at all.
const sourceDigest = `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
const client = new Client({ connectionString, application_name: "deviludo-source-baseline" });
await client.connect();
try {
  const existing = await client.query("SELECT to_regclass('deviludo.schema_metadata') IS NOT NULL AS present");
  if (!existing.rows[0]?.present) {
    await client.query(source);
    // The baseline cannot hash itself, so the digest is stamped here. Both
    // statements run on the same connection and the baseline commits before this
    // point; a failure now leaves the digest unrecorded, which the check below
    // treats as drift and reports rather than passing over.
    await client.query(
      "UPDATE deviludo.schema_metadata SET source_digest = $1 WHERE singleton = true",
      [sourceDigest],
    );
  } else {
    const metadata = await client.query("SELECT baseline, compatibility, source_digest FROM deviludo.schema_metadata WHERE singleton = true");
    if (metadata.rows[0]?.baseline !== "001" || metadata.rows[0]?.compatibility !== "deviludo-core-source-v1") {
      throw Object.assign(new Error(
        "INCOMPATIBLE_BASELINE_RESET_REQUIRED: persistent source v1 requires an empty Core database, artifact space, project source root, and Core Vault namespace",
      ), { code: "INCOMPATIBLE_BASELINE_RESET_REQUIRED" });
    }
    // Re-applying is not an option: the baseline creates its tables unconditionally
    // and this project deliberately does not carry in-place migrations. So report
    // the drift and name the reset, rather than skipping and leaving a database
    // that silently disagrees with the code talking to it.
    if (metadata.rows[0]?.source_digest !== sourceDigest) {
      throw Object.assign(new Error([
        "STALE_BASELINE_RESET_REQUIRED: the applied schema predates infra/postgres/001_core.sql",
        `  applied: ${metadata.rows[0]?.source_digest ?? "unrecorded"}`,
        `  current: ${sourceDigest}`,
        "Persistent source v1 does not support in-place migration; recreate the local baseline with:",
        "  npm run local:reset:source-v1",
      ].join("\n")), { code: "STALE_BASELINE_RESET_REQUIRED" });
    }
  }
} finally {
  await client.end();
}
