import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preparedInputTenantAuthorizerFromFiles } from "../../evidence-archive/src/prepared-input-assignments";
import { S3ImmutableObjectStore } from "../../evidence-archive/src/s3-store";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { MtlsGitHubAppJwtSigner } from "./github-app-signer-client";
import { GitHubSourceMaterializer } from "./github-source-materializer";
import { PostgresSourceSnapshotAuthority } from "./postgres-source-snapshot-authority";
import { GitHubAppInstallationTokenBroker, GitHubRestConnector } from "./github-rest";
import { createSourceSnapshotHandler, createSourceSnapshotHttpsServer } from "./source-snapshot-http";
import { SourceSnapshotGrantService } from "./source-snapshot-service";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function sourceSnapshotServiceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const [
    serverKey, serverCertificate, clientCa,
    signerKey, signerCertificate, signerCa,
    assignmentPublicKey,
    accessKeyFile, secretKeyFile, s3Ca,
  ] = await Promise.all([
    readSecret(env, "DEVILUDO_SOURCE_SNAPSHOT_TLS_KEY_FILE", 32, MAX_SECRET_BYTES),
    readSecret(env, "DEVILUDO_SOURCE_SNAPSHOT_TLS_CERT_FILE", 32, MAX_SECRET_BYTES),
    readSecret(env, "DEVILUDO_SOURCE_SNAPSHOT_CLIENT_CA_FILE", 32, MAX_SECRET_BYTES),
    readSecret(env, "DEVILUDO_SOURCE_SNAPSHOT_SIGNER_TLS_KEY_FILE", 32, MAX_SECRET_BYTES),
    readSecret(env, "DEVILUDO_SOURCE_SNAPSHOT_SIGNER_TLS_CERT_FILE", 32, MAX_SECRET_BYTES),
    readSecret(env, "DEVILUDO_SOURCE_SNAPSHOT_SIGNER_CA_FILE", 32, MAX_SECRET_BYTES),
    readSecret(env, "DEVILUDO_SOURCE_SNAPSHOT_ASSIGNMENT_PUBLIC_KEY_FILE", 32, MAX_SECRET_BYTES),
    readSecret(env, "DEVILUDO_SOURCE_SNAPSHOT_S3_ACCESS_KEY_FILE", 8, 128),
    readSecret(env, "DEVILUDO_SOURCE_SNAPSHOT_S3_SECRET_KEY_FILE", 16, 256),
    readSecret(env, "DEVILUDO_SOURCE_SNAPSHOT_S3_CA_FILE", 32, MAX_SECRET_BYTES),
  ]);
  const accessKeyId = accessKeyFile.toString("utf8").trim();
  const secretAccessKey = Buffer.from(secretKeyFile.toString("utf8").trim(), "utf8");
  accessKeyFile.fill(0);
  secretKeyFile.fill(0);
  const endpoint = requiredEnv(env, "DEVILUDO_SOURCE_SNAPSHOT_S3_ENDPOINT");
  const pool = (() => {
    try { return postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "scm-proxy" }); }
    catch (error) {
      secretAccessKey.fill(0);
      throw error;
    }
  })();
  try {
    const s3 = new S3ImmutableObjectStore({
      endpoint,
      bucket: requiredEnv(env, "DEVILUDO_SOURCE_SNAPSHOT_S3_BUCKET"),
      region: requiredEnv(env, "DEVILUDO_SOURCE_SNAPSHOT_S3_REGION"),
      accessKeyId,
      secretAccessKey,
      ca: s3Ca,
      timeoutMs: seconds(env.DEVILUDO_SOURCE_SNAPSHOT_S3_TIMEOUT_SECONDS, 30, 1, 600) * 1_000,
    });
    secretAccessKey.fill(0);
    const spiffeId = requiredSpiffeId(env, "DEVILUDO_SOURCE_SNAPSHOT_ARTIFACT_PREPARER_SPIFFE_ID");
    const tenants = preparedInputTenantAuthorizerFromFiles({
      manifestPath: requiredAbsolutePath(env, "DEVILUDO_SOURCE_SNAPSHOT_ASSIGNMENT_MANIFEST_FILE"),
      keyId: requiredEnv(env, "DEVILUDO_SOURCE_SNAPSHOT_ASSIGNMENT_KEY_ID"),
      publicKeyPem: assignmentPublicKey,
      spiffeId,
    });
    const signer = new MtlsGitHubAppJwtSigner({
      endpoint: requiredEnv(env, "DEVILUDO_SOURCE_SNAPSHOT_SIGNER_URL"),
      keyId: requiredEnv(env, "DEVILUDO_SOURCE_SNAPSHOT_SIGNER_KEY_ID"),
      tls: { key: signerKey, certificate: signerCertificate, ca: signerCa },
      timeoutMs: seconds(env.DEVILUDO_SOURCE_SNAPSHOT_SIGNER_TIMEOUT_SECONDS, 30, 1, 60) * 1_000,
    });
    const tokens = new GitHubAppInstallationTokenBroker({
      appId: requiredEnv(env, "DEVILUDO_SOURCE_SNAPSHOT_GITHUB_APP_ID"),
      signer,
      permissionMode: "source-read",
      timeoutMs: seconds(env.DEVILUDO_SOURCE_SNAPSHOT_GITHUB_TIMEOUT_SECONDS, 30, 1, 60) * 1_000,
    });
    const connector = new GitHubRestConnector({
      tokens,
      timeoutMs: seconds(env.DEVILUDO_SOURCE_SNAPSHOT_GITHUB_TIMEOUT_SECONDS, 30, 1, 60) * 1_000,
    });
    const service = new SourceSnapshotGrantService({
      tenants,
      authority: new PostgresSourceSnapshotAuthority(pool),
      materializer: new GitHubSourceMaterializer(connector),
      transfer: s3,
      transferCa: s3Ca,
      allowedTransferOrigins: [strictOrigin(endpoint)],
      workRoot: requiredAbsolutePath(env, "DEVILUDO_SOURCE_SNAPSHOT_WORK_ROOT"),
      transferTimeoutMs: seconds(env.DEVILUDO_SOURCE_SNAPSHOT_TRANSFER_TIMEOUT_SECONDS, 7_200, 1, 86_400) * 1_000,
    });
    const handler = createSourceSnapshotHandler({
      sourceSnapshots: service,
      allowedSpiffeIds: new Set([spiffeId]),
    });
    const server = createSourceSnapshotHttpsServer({
      tls: { key: serverKey, cert: serverCertificate, ca: clientCa },
      handler,
    });
    return Object.freeze({
      host: host(env.DEVILUDO_SOURCE_SNAPSHOT_HOST),
      port: port(env.DEVILUDO_SOURCE_SNAPSHOT_PORT),
      pool,
      service,
      server,
    });
  } catch (error) {
    secretAccessKey.fill(0);
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runSourceSnapshotService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await sourceSnapshotServiceFromEnv(env);
  try {
    await runtime.service.probe();
    await new Promise<void>((resolveListen, reject) => {
      const fail = (error: Error) => reject(error);
      runtime.server.once("error", fail);
      runtime.server.listen(runtime.port, runtime.host, () => {
        runtime.server.off("error", fail);
        resolveListen();
      });
    });
    console.log(`[source-snapshot] READY ${runtime.host}:${runtime.port}`);
    const close = () => runtime.server.close();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    await new Promise<void>((resolveClose, reject) => {
      runtime.server.once("close", resolveClose);
      runtime.server.once("error", reject);
    });
  } finally { await runtime.pool.close(); }
}

async function readSecret(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): Promise<Buffer> {
  const path = requiredAbsolutePath(env, name);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < minimum || metadata.size > maximum) throw new Error(`${name} file is invalid`);
    const value = await file.readFile();
    if (value.byteLength < minimum || value.byteLength > maximum) throw new Error(`${name} file is invalid`);
    return value;
  } finally { await file.close(); }
}

function requiredAbsolutePath(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = requiredEnv(env, name);
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) {
    throw new Error(`${name} path is invalid`);
  }
  return value;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredSpiffeId(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = requiredEnv(env, name);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${name} is invalid`); }
  if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash
    || url.toString() !== value) throw new Error(`${name} is invalid`);
  return value;
}

function strictOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Source snapshot S3 endpoint is invalid"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Source snapshot S3 endpoint is invalid");
  return url.origin;
}

function host(value: string | undefined): string {
  const selected = value ?? "0.0.0.0";
  if (selected !== "0.0.0.0" && selected !== "::") throw new Error("Source snapshot host is invalid");
  return selected;
}

function port(value: string | undefined): number {
  const parsed = value === undefined ? 4543 : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1_024 || parsed > 65_535 || (value !== undefined && String(parsed) !== value)) {
    throw new Error("Source snapshot port is invalid");
  }
  return parsed;
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Source snapshot timeout is invalid");
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSourceSnapshotService();
}
