import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preparedInputTenantAuthorizerFromFiles } from "../../evidence-archive/src/prepared-input-assignments";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { createArtifactPreparationHandler, createArtifactPreparationHttpsServer } from "./ingress-http";
import { PostgresRunnerExecutionLockPort } from "./postgres-lock-store";
import { PostgresSourceExecutionPreparationAuthority } from "./postgres-preparation-authority";
import { PostgresFrozenTestPlanPort } from "./postgres-test-plan";
import { preparedInputObjectClientFromEnv } from "./prepared-input-client";
import { SourceExecutionPreparer } from "./preparer";
import { ArtifactPreparationService } from "./service";
import { sourceSnapshotClientFromEnv } from "./source-snapshot-client";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function artifactPreparationServiceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const [serverKey, serverCertificate, clientCa, assignmentPublicKey] = await Promise.all([
    readSecret(env, "DEVILUDO_ARTIFACT_PREPARER_TLS_KEY_FILE", 32, MAX_SECRET_BYTES),
    readSecret(env, "DEVILUDO_ARTIFACT_PREPARER_TLS_CERT_FILE", 32, MAX_SECRET_BYTES),
    readSecret(env, "DEVILUDO_ARTIFACT_PREPARER_CLIENT_CA_FILE", 32, MAX_SECRET_BYTES),
    readSecret(env, "DEVILUDO_ARTIFACT_PREPARER_ASSIGNMENT_PUBLIC_KEY_FILE", 32, MAX_SECRET_BYTES),
  ]);
  const runnerControlSpiffeId = requiredSpiffeId(env, "DEVILUDO_ARTIFACT_PREPARER_RUNNER_CONTROL_SPIFFE_ID");
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "artifact-preparer" });
  try {
    const tenants = preparedInputTenantAuthorizerFromFiles({
      manifestPath: requiredAbsolutePath(env, "DEVILUDO_ARTIFACT_PREPARER_ASSIGNMENT_MANIFEST_FILE"),
      keyId: requiredEnv(env, "DEVILUDO_ARTIFACT_PREPARER_ASSIGNMENT_KEY_ID"),
      publicKeyPem: assignmentPublicKey,
      spiffeId: runnerControlSpiffeId,
    });
    const authority = new PostgresSourceExecutionPreparationAuthority(pool);
    const preparer = new SourceExecutionPreparer({
      sources: await sourceSnapshotClientFromEnv(env),
      plans: new PostgresFrozenTestPlanPort(pool),
      objects: await preparedInputObjectClientFromEnv(env),
      locks: new PostgresRunnerExecutionLockPort(pool),
      workRoot: requiredAbsolutePath(env, "DEVILUDO_ARTIFACT_PREPARER_WORK_ROOT"),
    });
    const service = new ArtifactPreparationService({ tenants, authority, preparer });
    const handler = createArtifactPreparationHandler({
      service,
      allowedSpiffeIds: new Set([runnerControlSpiffeId]),
    });
    const server = createArtifactPreparationHttpsServer({
      tls: { key: serverKey, cert: serverCertificate, ca: clientCa },
      handler,
      requestTimeoutMs: seconds(env.DEVILUDO_ARTIFACT_PREPARER_REQUEST_TIMEOUT_SECONDS, 86_400, 30, 86_400) * 1_000,
    });
    return Object.freeze({
      host: host(env.DEVILUDO_ARTIFACT_PREPARER_HOST),
      port: port(env.DEVILUDO_ARTIFACT_PREPARER_PORT),
      pool,
      service,
      server,
    });
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runArtifactPreparationService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await artifactPreparationServiceFromEnv(env);
  try {
    await runtime.pool.probe();
    await runtime.service.probe();
    await new Promise<void>((resolveListen, reject) => {
      const fail = (error: Error) => reject(error);
      runtime.server.once("error", fail);
      runtime.server.listen(runtime.port, runtime.host, () => {
        runtime.server.off("error", fail);
        resolveListen();
      });
    });
    console.log(`[artifact-preparer] READY ${runtime.host}:${runtime.port}`);
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

function host(value: string | undefined): string {
  const selected = value ?? "0.0.0.0";
  if (selected !== "0.0.0.0" && selected !== "::") throw new Error("Artifact Preparer host is invalid");
  return selected;
}

function port(value: string | undefined): number {
  const parsed = value === undefined ? 4643 : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1_024 || parsed > 65_535 || (value !== undefined && String(parsed) !== value)) {
    throw new Error("Artifact Preparer port is invalid");
  }
  return parsed;
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Artifact Preparer timeout is invalid");
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runArtifactPreparationService();
}
