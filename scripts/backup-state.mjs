import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { promisify } from "node:util";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const execute = promisify(execFile);
const outputArgument = process.argv.find(value => value.startsWith("--output="));
if (!outputArgument) throw new Error("Usage: npm run state:backup -- --output=/absolute/new/backup-directory");
const output = resolve(outputArgument.slice("--output=".length));
if (!output.startsWith(sep) || output === sep) throw new Error("Backup output must be a specific absolute directory");
await assertMissing(output, "Backup output already exists");

const databaseUrl = await databaseConnectionString();
const projectsRoot = requiredProjectsRoot();
const bucket = required("DEVILUDO_ARTIFACT_BUCKET");
const s3 = objectStoreClient();
const stage = join(dirname(output), `.${basename(output)}.stage-${randomUUID()}`);
const objectsDirectory = join(stage, "objects");
const projectDirectory = join(stage, "projects");
const dumpPath = join(stage, "database.dump");
const database = new pg.Client({ connectionString: databaseUrl, application_name: "deviludo-state-backup" });

await mkdir(objectsDirectory, { recursive: true, mode: 0o700 });
await database.connect();
let transactionOpen = false;
try {
  // A SHARE lock on every application table creates a write barrier while still
  // allowing pg_dump's ACCESS SHARE locks. Source revisions and artifact keys are
  // immutable after their referencing row commits, so all three stores now form
  // one recoverable point-in-time view.
  await database.query("BEGIN");
  transactionOpen = true;
  const tables = await database.query(`
    SELECT format('%I.%I', schemaname, tablename) AS name
      FROM pg_tables WHERE schemaname = 'deviludo' ORDER BY tablename
  `);
  if (!tables.rowCount) throw new Error("DeviLudo schema is unavailable");
  await database.query(`LOCK TABLE ${tables.rows.map(row => row.name).join(", ")} IN SHARE MODE`);
  const versions = await database.query(
    "SELECT version, checksum, applied_at FROM deviludo.schema_migrations ORDER BY version",
  );
  const referenced = await database.query(`
    SELECT bucket, object_key, sha256 FROM deviludo.artifacts
    UNION
    SELECT bucket, object_key, sha256
      FROM deviludo.asset_items WHERE object_key IS NOT NULL
  `);

  const dumpConnection = postgresCommandConnection(databaseUrl);
  await execute("pg_dump", [
    "--format=custom", "--no-owner", "--dbname", dumpConnection.database,
    "--file", dumpPath,
  ], {
    env: { ...process.env, ...dumpConnection.environment },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (await pathExists(projectsRoot)) await cp(projectsRoot, projectDirectory, { recursive: true, errorOnExist: true });
  else await mkdir(projectDirectory, { mode: 0o700 });

  const projectFiles = await inventoryFiles(projectDirectory);
  const objects = [];
  let continuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    for (const listed of page.Contents ?? []) {
      if (!listed.Key) continue;
      const filename = `${String(objects.length + 1).padStart(8, "0")}.bin`;
      const fetched = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: listed.Key }));
      if (!fetched.Body) throw new Error(`Object body is missing: ${listed.Key}`);
      const stored = await streamObject(fetched.Body, join(objectsDirectory, filename));
      if (listed.Size !== undefined && stored.sizeBytes !== listed.Size) throw new Error(`Object changed during backup: ${listed.Key}`);
      objects.push(Object.freeze({
        key: listed.Key,
        filename,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        contentType: fetched.ContentType ?? "application/octet-stream",
        metadata: fetched.Metadata ?? {},
      }));
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuationToken) throw new Error("Object-store pagination is invalid");
  } while (continuationToken);

  const objectByKey = new Map(objects.map(object => [object.key, object]));
  for (const row of referenced.rows) {
    if (row.bucket !== bucket) throw new Error(`Database references an unexpected artifact bucket: ${row.bucket}`);
    const object = objectByKey.get(row.object_key);
    if (!object || object.sha256 !== row.sha256) {
      throw new Error(`Referenced object is missing or inconsistent: ${row.object_key}`);
    }
  }
  const databaseDump = await hashFile(dumpPath);
  const manifest = Object.freeze({
    schemaVersion: "deviludo.state-backup.v1",
    createdAt: new Date().toISOString(),
    database: Object.freeze({ filename: "database.dump", ...databaseDump, migrations: versions.rows }),
    projects: Object.freeze({ directory: "projects", files: projectFiles }),
    objectStore: Object.freeze({ bucket, objects }),
  });
  await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await database.query("COMMIT");
  transactionOpen = false;
  await rename(stage, output);
  process.stdout.write(`${JSON.stringify({ backup: "complete", output, objects: objects.length, projectFiles: projectFiles.length })}\n`);
} catch (error) {
  if (transactionOpen) await database.query("ROLLBACK").catch(() => undefined);
  await rm(stage, { recursive: true, force: true });
  throw error;
} finally {
  await database.end();
}

async function databaseConnectionString() {
  const file = process.env.DEVILUDO_MIGRATION_DATABASE_URL_FILE;
  if (file && process.env.DEVILUDO_MIGRATION_DATABASE_URL) throw new Error("Set only one migration credential source");
  if (process.env.NODE_ENV === "production" && !file) throw new Error("Production database credentials must use DEVILUDO_MIGRATION_DATABASE_URL_FILE");
  const value = file ? (await readFile(file, "utf8")).trim() : process.env.DEVILUDO_MIGRATION_DATABASE_URL ?? "";
  if (!value) throw new Error("A migration database credential is required");
  return value;
}

function requiredProjectsRoot() {
  const value = resolve(required("DEVILUDO_PROJECTS_ROOT"));
  if (!value.startsWith(sep) || value === sep || value.split(sep).filter(Boolean).length < 3) {
    throw new Error("DEVILUDO_PROJECTS_ROOT must be a specific absolute directory");
  }
  return value;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function objectStoreClient() {
  return new S3Client({
    region: process.env.DEVILUDO_S3_REGION ?? "us-east-1",
    endpoint: process.env.DEVILUDO_S3_ENDPOINT,
    forcePathStyle: process.env.DEVILUDO_S3_PATH_STYLE === "1",
    credentials: process.env.DEVILUDO_S3_ACCESS_KEY_ID && process.env.DEVILUDO_S3_SECRET_ACCESS_KEY
      ? { accessKeyId: process.env.DEVILUDO_S3_ACCESS_KEY_ID, secretAccessKey: process.env.DEVILUDO_S3_SECRET_ACCESS_KEY }
      : undefined,
  });
}

async function inventoryFiles(root) {
  const inventory = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Project source backup rejects symbolic links: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) inventory.push(Object.freeze({ path: relative(root, path), ...await hashFile(path) }));
      else throw new Error(`Project source contains an unsupported filesystem entry: ${path}`);
    }
  }
  await visit(root);
  return inventory.sort((left, right) => left.path.localeCompare(right.path));
}

async function streamObject(body, destination) {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    hash.update(chunk); sizeBytes += chunk.length; callback(null, chunk);
  } });
  await pipeline(body, meter, createWriteStream(destination, { mode: 0o600 }));
  return Object.freeze({ sizeBytes, sha256: `sha256:${hash.digest("hex")}` });
}

async function hashFile(path) {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error(`Backup entry is not a regular file: ${path}`);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    sizeBytes += chunk.length;
  }
  return Object.freeze({ sizeBytes, sha256: `sha256:${hash.digest("hex")}` });
}

async function pathExists(path) {
  try { await stat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function assertMissing(path, message) {
  try { await access(path); throw new Error(message); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function postgresCommandConnection(connectionString) {
  const parsed = new URL(connectionString);
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) throw new Error("Migration database URL is invalid");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database || database.includes("/")) throw new Error("Migration database name is invalid");
  const environment = {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: database,
  };
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode) environment.PGSSLMODE = sslmode;
  return Object.freeze({ database, environment: Object.freeze(environment) });
}
