import { readFile } from "node:fs/promises";
import pg from "pg";

const databaseFile = process.env.DEVILUDO_BOOTSTRAP_DATABASE_URL_FILE ?? "";
const publicKeyFile = process.env.DEVILUDO_EXECUTOR_PUBLIC_KEY_FILE ?? "";
const executorId = process.env.DEVILUDO_EXECUTOR_ID ?? "";
if (![databaseFile, publicKeyFile].every(value => value.startsWith("/"))
  || !/^[A-Za-z0-9][A-Za-z0-9:._-]{2,199}$/.test(executorId)) {
  throw new Error("Executor identity bootstrap configuration is invalid");
}
const [connectionString, publicKey] = await Promise.all([
  readFile(databaseFile, "utf8").then(value => value.trim()),
  readFile(publicKeyFile, "utf8"),
]);
const pool = new pg.Pool({ connectionString, max: 1 });
try {
  await pool.query(
    `INSERT INTO deviludo.executor_identities(executor_id, identity_kind, public_key_pem)
     VALUES ($1, 'CORE', $2)
     ON CONFLICT (executor_id) DO UPDATE SET public_key_pem = EXCLUDED.public_key_pem,
       enabled = true, updated_at = clock_timestamp()`,
    [executorId, publicKey],
  );
  console.log(JSON.stringify({ registered: true, executorId }));
} finally {
  await pool.end();
}
