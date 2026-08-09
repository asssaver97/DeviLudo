import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const execute = promisify(execFile);
const inputArgument = process.argv.find(value => value.startsWith("--input="));
if (!inputArgument || !process.argv.includes("--confirm=RESTORE_DEVILUDO_BACKUP")) {
  throw new Error("Usage: npm run state:restore -- --input=/absolute/backup-directory --confirm=RESTORE_DEVILUDO_BACKUP");
}
const input = resolve(inputArgument.slice("--input=".length));
if (!input.startsWith(sep) || input === sep) throw new Error("Backup input must be a specific absolute directory");
const manifest = JSON.parse(await readFile(join(input, "manifest.json"), "utf8"));
if (manifest?.schemaVersion !== "deviludo.state-backup.v1"
  || !Array.isArray(manifest?.projects?.files)
  || !Array.isArray(manifest?.objectStore?.objects)
  || !Array.isArray(manifest?.database?.migrations)) {
  throw new Error("Backup manifest is invalid or unsupported");
}

const dumpPath = boundedBackupPath(manifest.database.filename, "database.dump");
await assertHash(dumpPath, manifest.database);
const projectsBackup = boundedBackupPath(manifest.projects.directory, "projects");
const projectFiles = await inventoryFiles(projectsBackup);
if (JSON.stringify(projectFiles) !== JSON.stringify(manifest.projects.files)) throw new Error("Project source inventory does not match the backup manifest");
for (const object of manifest.objectStore.objects) {
  if (!object || typeof object.key !== "string" || object.key.length < 1 || object.key.length > 1024
    || !/^\d{8}\.bin$/.test(object.filename)
    || typeof object.contentType !== "string" || !object.metadata || typeof object.metadata !== "object") {
    throw new Error("Object-store backup entry is invalid");
  }
  await assertHash(boundedBackupPath(`objects/${object.filename}`, `objects/${object.filename}`), object);
}

const databaseUrl = await databaseConnectionString();
const projectsRoot = requiredProjectsRoot();
const bucket = required("DEVILUDO_ARTIFACT_BUCKET");
if (bucket !== manifest.objectStore.bucket) throw new Error("Restore bucket does not match the backup manifest");
const s3 = objectStoreClient();
const database = new pg.Client({ connectionString: databaseUrl, application_name: "deviludo-state-restore" });
await database.connect();
let projectCreated = false;
const uploadedKeys = [];
try {
  const userRelations = await database.query(`
    SELECT namespace.nspname AS schema_name, relation.relname AS relation_name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
       AND namespace.nspname !~ '^pg_toast'
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
     ORDER BY namespace.nspname, relation.relname
     LIMIT 1
  `);
  if (userRelations.rowCount > 0) {
    const relation = userRelations.rows[0];
    throw new Error(`Restore target database is not empty: ${relation.schema_name}.${relation.relation_name}`);
  }
  const schema = await database.query("SELECT to_regnamespace('deviludo') IS NOT NULL AS present");
  if (schema.rows[0]?.present) throw new Error("Restore target database already contains the deviludo schema");
  if (await pathExists(projectsRoot)) throw new Error("Restore target DEVILUDO_PROJECTS_ROOT already exists");
  const existingObject = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
  if ((existingObject.Contents?.length ?? 0) > 0) throw new Error("Restore target artifact bucket is not empty");

  await mkdir(dirname(projectsRoot), { recursive: true, mode: 0o700 });
  await cp(projectsBackup, projectsRoot, { recursive: true, errorOnExist: true });
  projectCreated = true;
  for (const object of manifest.objectStore.objects) {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: object.key,
      Body: createReadStream(boundedBackupPath(`objects/${object.filename}`, `objects/${object.filename}`)),
      ContentLength: object.sizeBytes,
      ContentType: object.contentType,
      Metadata: object.metadata,
    }));
    uploadedKeys.push(object.key);
  }

  // pg_dump does not include cluster roles. Create the four non-login service
  // principals before replaying ACLs; pg_restore then restores the exact schema,
  // RLS policies, grants, migration ledger, and application data atomically.
  await database.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deviludo_api') THEN CREATE ROLE deviludo_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deviludo_scheduler') THEN CREATE ROLE deviludo_scheduler NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deviludo_sandbox') THEN CREATE ROLE deviludo_sandbox NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deviludo_claim_executor') THEN CREATE ROLE deviludo_claim_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS; END IF;
    END $$
  `);
  await database.query("ALTER ROLE deviludo_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS");
  await database.query("ALTER ROLE deviludo_scheduler NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS");
  await database.query("ALTER ROLE deviludo_sandbox NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS");
  await database.query("ALTER ROLE deviludo_claim_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS");
  await database.query(`DO $$ BEGIN EXECUTE format(
    'GRANT deviludo_api, deviludo_scheduler, deviludo_sandbox TO %I', current_user
  ); END $$`);
  const restoreConnection = postgresCommandConnection(databaseUrl);
  await execute("pg_restore", [
    "--exit-on-error", "--single-transaction", "--no-owner",
    "--dbname", restoreConnection.database,
    dumpPath,
  ], {
    env: { ...process.env, ...restoreConnection.environment },
    maxBuffer: 4 * 1024 * 1024,
  });
  await database.query(`
    DO $$ DECLARE function_signature text; BEGIN
      FOR function_signature IN
        SELECT function.oid::regprocedure::text
          FROM pg_proc function
          JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
         WHERE namespace.nspname = 'deviludo' AND function.prosecdef
      LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO deviludo_claim_executor', function_signature);
      END LOOP;
    END $$
  `);
  const restored = await database.query("SELECT version, checksum FROM deviludo.schema_migrations ORDER BY version");
  const expected = manifest.database.migrations.map(row => ({ version: row.version, checksum: row.checksum }));
  if (JSON.stringify(restored.rows) !== JSON.stringify(expected)) throw new Error("Restored migration ledger does not match the backup");
  process.stdout.write(`${JSON.stringify({ restore: "complete", input, objects: uploadedKeys.length, projectFiles: projectFiles.length })}\n`);
} catch (error) {
  // These are only resources created by this invocation after strict empty-target
  // checks. Cleaning them makes a failed restore safely retryable.
  for (let index = 0; index < uploadedKeys.length; index += 1000) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: uploadedKeys.slice(index, index + 1000).map(Key => ({ Key })), Quiet: true },
    })).catch(() => undefined);
  }
  if (projectCreated) await rm(projectsRoot, { recursive: true, force: true });
  throw error;
} finally {
  await database.end();
}

function boundedBackupPath(relativePath, expected) {
  if (relativePath !== expected) throw new Error("Backup path is not canonical");
  const path = resolve(input, relativePath);
  if (!path.startsWith(`${input}${sep}`)) throw new Error("Backup path escapes the input directory");
  return path;
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
      if (entry.isSymbolicLink()) throw new Error(`Backup contains a symbolic link: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) inventory.push(Object.freeze({ path: relative(root, path), ...await hashFile(path) }));
      else throw new Error(`Backup contains an unsupported filesystem entry: ${path}`);
    }
  }
  await visit(root);
  return inventory.sort((left, right) => left.path.localeCompare(right.path));
}

async function assertHash(path, expected) {
  const actual = await hashFile(path);
  if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) throw new Error(`Backup checksum mismatch: ${path}`);
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

async function pathExists(path) {
  try { await lstat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
