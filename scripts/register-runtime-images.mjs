import { readFile } from "node:fs/promises";
import pg from "pg";

const databaseFile = process.env.DEVILUDO_BOOTSTRAP_DATABASE_URL_FILE ?? "";
const manifestFile = process.env.DEVILUDO_RELEASE_MANIFEST_FILE ?? "";
if (!databaseFile.startsWith("/") || !manifestFile.startsWith("/")) throw new Error("Database and release manifest files are required");
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
if (manifest.schemaVersion !== "deviludo.release.v1" || typeof manifest.version !== "string" || !Array.isArray(manifest.images)) throw new Error("Release manifest is invalid");
const findImage = suffix => manifest.images.find(image => typeof image === "string" && image.includes(suffix) && /@sha256:[0-9a-f]{64}$/.test(image));
const e2e = manifest.e2eRuntimeDigests ?? {};
const values = {
  AGENT_CLAUDE: findImage("agent-claude"),
  AGENT_CODEX: findImage("agent-codex"),
  GODOT_BUILDER: findImage("godot-builder"),
  STEAM_PUBLISHER: findImage("steam-publisher"),
  E2E_LINUX: e2e.linux,
  E2E_WINDOWS: e2e.windows,
  E2E_MACOS: e2e.macos,
};
if (Object.values(values).some(value => typeof value !== "string" || !/^(?:.+@)?sha256:[0-9a-f]{64}$/.test(value))) {
  throw new Error("Release manifest does not contain every immutable runtime digest");
}
const pool = new pg.Pool({ connectionString: (await readFile(databaseFile, "utf8")).trim(), max: 1 });
try {
  for (const [runtimeKey, imageReference] of Object.entries(values)) {
    await pool.query(
      `INSERT INTO deviludo.runtime_images(runtime_key, image_reference, release_version, verified_at)
       VALUES ($1, $2, $3, clock_timestamp())
       ON CONFLICT (runtime_key) DO UPDATE SET image_reference = EXCLUDED.image_reference,
         release_version = EXCLUDED.release_version, verified_at = EXCLUDED.verified_at,
         updated_at = clock_timestamp()`,
      [runtimeKey, imageReference, manifest.version],
    );
  }
} finally {
  await pool.end();
}
