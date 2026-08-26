import { readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, sep } from "node:path";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

if (!process.argv.includes("--confirm=RESET_DEVILUDO_SELF_HOSTED")) {
  throw new Error("Refusing destructive reset without --confirm=RESET_DEVILUDO_SELF_HOSTED");
}
for (const name of [
  "DEVILUDO_MIGRATION_DATABASE_URL_FILE", "DEVILUDO_ARTIFACT_BUCKET",
  "DEVILUDO_VAULT_ADDR", "DEVILUDO_VAULT_ADMIN_TOKEN_FILE",
  "DEVILUDO_PROJECTS_ROOT",
]) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
const databaseUrl = (await readFile(process.env.DEVILUDO_MIGRATION_DATABASE_URL_FILE, "utf8")).trim();
const vaultToken = (await readFile(process.env.DEVILUDO_VAULT_ADMIN_TOKEN_FILE, "utf8")).trim();
const vaultAddress = new URL(process.env.DEVILUDO_VAULT_ADDR);
const projectsRoot = resolve(process.env.DEVILUDO_PROJECTS_ROOT);
const execute = promisify(execFile);
if (!projectsRoot.startsWith(sep) || projectsRoot === sep || projectsRoot.split(sep).filter(Boolean).length < 3) {
  throw new Error("DEVILUDO_PROJECTS_ROOT is too broad for destructive reset");
}
if (process.env.NODE_ENV === "production" && vaultAddress.protocol !== "https:") throw new Error("Production Vault must use HTTPS");

// Runtime containers and their native session volumes are deliberately outside
// the project data volume. Remove only objects carrying DeviLudo's exact labels
// and volume prefix before resetting the durable context/source store.
const { stdout: runtimeContainers } = await execute("docker", [
  "ps", "-aq", "--filter", "label=deviludo.kind=project-runtime",
], { maxBuffer: 1024 * 1024 });
const containerIds = runtimeContainers.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
if (containerIds.length) await execute("docker", ["rm", "-f", ...containerIds], { maxBuffer: 4 * 1024 * 1024 });
const { stdout: runtimeVolumes } = await execute("docker", [
  "volume", "ls", "-q", "--filter", "name=deviludo-runtime-",
], { maxBuffer: 1024 * 1024 });
const volumeNames = runtimeVolumes.split(/\r?\n/)
  .map(value => value.trim())
  .filter(value => /^deviludo-runtime-[0-9a-f-]{36}$/i.test(value));
if (volumeNames.length) await execute("docker", ["volume", "rm", "-f", ...volumeNames], { maxBuffer: 4 * 1024 * 1024 });

const s3 = new S3Client({
  region: process.env.DEVILUDO_S3_REGION ?? "us-east-1",
  endpoint: process.env.DEVILUDO_S3_ENDPOINT,
  forcePathStyle: process.env.DEVILUDO_S3_PATH_STYLE === "1",
});
const bucket = process.env.DEVILUDO_ARTIFACT_BUCKET;
let continuationToken;
do {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
  const objects = (listed.Contents ?? []).flatMap(item => item.Key ? [{ Key: item.Key }] : []);
  if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
  continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
} while (continuationToken);

await deleteVaultTree("deviludo");
await rm(projectsRoot, { recursive: true, force: true });

const client = new pg.Client({ connectionString: databaseUrl, application_name: "deviludo-destructive-self-hosted-reset" });
await client.connect();
try {
  await client.query("DROP SCHEMA IF EXISTS deviludo CASCADE");
  await client.query(await readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8"));
} finally {
  await client.end();
}
process.stdout.write(JSON.stringify({ reset: true, projectsRoot, remoteResourcesDeleted: false }));

async function deleteVaultTree(path) {
  const response = await fetch(new URL(`/v1/secret/metadata/${path}?list=true`, vaultAddress), {
    method: "LIST",
    headers: { "x-vault-token": vaultToken },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`Vault list failed (${response.status})`);
  const body = await response.json();
  const keys = body.data?.keys;
  if (!Array.isArray(keys)) throw new Error("Vault list response is invalid");
  for (const key of keys) {
    if (typeof key !== "string" || !/^[A-Za-z0-9._/-]+$/.test(key)) throw new Error("Vault key is invalid");
    if (key.endsWith("/")) await deleteVaultTree(`${path}/${key.slice(0, -1)}`);
    else {
      const deleted = await fetch(new URL(`/v1/secret/metadata/${path}/${key}`, vaultAddress), {
        method: "DELETE", headers: { "x-vault-token": vaultToken }, signal: AbortSignal.timeout(10_000),
      });
      if (!deleted.ok && deleted.status !== 404) throw new Error(`Vault metadata delete failed (${deleted.status})`);
    }
  }
}
