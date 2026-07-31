import { readFile } from "node:fs/promises";
import pg from "pg";

const databaseUrl = process.env.DEVILUDO_BOOTSTRAP_DATABASE_URL ?? "postgresql://deviludo:deviludo-local@postgres:5432/deviludo";
const images = JSON.parse(process.env.DEVILUDO_RUNTIME_IMAGES_JSON ?? "{}");
const runtimeKeys = [
  "AGENT_CLAUDE", "AGENT_CODEX", "GODOT_BUILDER", "STEAM_PUBLISHER",
  "E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS",
];
if (!images || typeof images !== "object" || Array.isArray(images)
  || runtimeKeys.some(key => !/^sha256:[0-9a-f]{64}$/.test(images[key] ?? ""))) {
  throw new Error("DEVILUDO_RUNTIME_IMAGES_JSON must contain every immutable local runtime image digest");
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
try {
  for (const [runtimeKey, digest] of Object.entries(images)) {
    await pool.query(
      `INSERT INTO deviludo.runtime_images(runtime_key, image_reference, release_version, verified_at)
       VALUES ($1, $2, 'local', clock_timestamp())
       ON CONFLICT (runtime_key) DO UPDATE SET image_reference = EXCLUDED.image_reference,
         release_version = EXCLUDED.release_version, verified_at = EXCLUDED.verified_at,
         updated_at = clock_timestamp()`,
      [runtimeKey, digest],
    );
  }
  for (const definition of [
    ["WEB", "linux", ["CUSTOMER_WEB", "STREAMING_BFF"]],
    ["CORE", "linux", [
      "BUSINESS_API", "WORKFLOW_SCHEDULER", "AGENT_GENERATION", "ARTIFACT_BUILD", "STEAM_PUBLISH",
      "RESTRICTED_CONTAINER", "NETWORK_POLICY",
    ]],
    ["E2E_MACOS", "macos", ["E2E_TEST", "ARTIFACT_SIGN", "STEAM_CLEAN_INSTALL"]],
  ]) {
    await pool.query(
      `INSERT INTO deviludo.server_nodes(pool_kind, operating_system, state, capabilities)
       SELECT $1::deviludo.server_pool_kind, $2::deviludo.server_os, 'ACTIVE', $3::text[]
        WHERE NOT EXISTS (SELECT 1 FROM deviludo.server_nodes WHERE pool_kind = $1::deviludo.server_pool_kind)`,
      definition,
    );
  }
  const mac = await pool.query("SELECT id::text FROM deviludo.server_nodes WHERE pool_kind = 'E2E_MACOS' ORDER BY created_at LIMIT 1");
  const publicKey = await readFile(process.env.DEVILUDO_EXECUTOR_PUBLIC_KEY_FILE ?? "/run/deviludo-local/executor-ed25519.pub", "utf8");
  const e2ePublicKey = await readFile(process.env.DEVILUDO_E2E_PUBLIC_KEY_FILE ?? "/run/deviludo-local/e2e-macos-ed25519.pub", "utf8");
  await pool.query(
    `INSERT INTO deviludo.executor_identities(executor_id, identity_kind, public_key_pem)
     VALUES ('local-core-executor', 'CORE', $1)
     ON CONFLICT (executor_id) DO UPDATE SET public_key_pem = EXCLUDED.public_key_pem,
       enabled = true, updated_at = clock_timestamp()`,
    [publicKey],
  );
  await pool.query(
    `INSERT INTO deviludo.executor_identities(executor_id, identity_kind, node_id, public_key_pem)
     VALUES ($1, 'E2E', $2::uuid, $3)
     ON CONFLICT (executor_id) DO UPDATE SET public_key_pem = EXCLUDED.public_key_pem,
       node_id = EXCLUDED.node_id, enabled = true, updated_at = clock_timestamp()`,
    [mac.rows[0]?.id, mac.rows[0]?.id, e2ePublicKey],
  );
  process.stdout.write(JSON.stringify({ initialized: true, macNodeId: mac.rows[0]?.id ?? null }));
} finally {
  await pool.end();
}
