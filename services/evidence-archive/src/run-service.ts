import { createPublicKey } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FileRunnerFleetManifestLoader, SignedRunnerFleetPolicy } from "../../runner-control/src/fleet-manifest";
import type { ImmutableObjectStore } from "./contracts";
import { EvidenceArchiveService } from "./archive";
import { FilesystemImmutableObjectStore } from "./filesystem-store";
import { createEvidenceArchiveHandler, createEvidenceArchiveHttpsServer } from "./ingress-http";
import { S3ImmutableObjectStore } from "./s3-store";
import { RunnerArtifactGrantService } from "./runner-artifacts";
import { preparedInputTenantAuthorizerFromFiles } from "./prepared-input-assignments";
import { PreparedInputGrantService } from "./prepared-inputs";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function evidenceArchiveServiceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Readonly<{
  host: string;
  port: number;
  store: ImmutableObjectStore;
  archive: EvidenceArchiveService;
  runnerArtifacts: RunnerArtifactGrantService | null;
  preparedInputs: PreparedInputGrantService | null;
  server: ReturnType<typeof createEvidenceArchiveHttpsServer>;
}>> {
  const mode = requiredEnv(env, "DEVILUDO_EVIDENCE_ARCHIVE_STORE");
  let store: ImmutableObjectStore;
  let runnerArtifacts: RunnerArtifactGrantService | null = null;
  let preparedInputs: PreparedInputGrantService | null = null;
  if (mode === "filesystem") {
    if (env.NODE_ENV === "production") {
      throw new Error("Evidence archive filesystem backend is forbidden in production");
    }
    store = new FilesystemImmutableObjectStore({ root: requiredAbsolutePath(env, "DEVILUDO_EVIDENCE_ARCHIVE_FILESYSTEM_ROOT") });
  } else if (mode === "s3") {
    const [accessKey, secretKey, ca] = await Promise.all([
      readSecret(env, "DEVILUDO_EVIDENCE_ARCHIVE_S3_ACCESS_KEY_FILE", 8, 128),
      readSecret(env, "DEVILUDO_EVIDENCE_ARCHIVE_S3_SECRET_KEY_FILE", 16, 256),
      readSecret(env, "DEVILUDO_EVIDENCE_ARCHIVE_S3_CA_FILE", 32, MAX_SECRET_BYTES),
    ]);
    const accessKeyId = accessKey.toString("utf8").trim();
    const secretAccessKey = Buffer.from(secretKey.toString("utf8").trim(), "utf8");
    accessKey.fill(0);
    secretKey.fill(0);
    const s3 = new S3ImmutableObjectStore({
      endpoint: requiredEnv(env, "DEVILUDO_EVIDENCE_ARCHIVE_S3_ENDPOINT"),
      bucket: requiredEnv(env, "DEVILUDO_EVIDENCE_ARCHIVE_S3_BUCKET"),
      region: requiredEnv(env, "DEVILUDO_EVIDENCE_ARCHIVE_S3_REGION"),
      accessKeyId,
      secretAccessKey,
      ca,
      timeoutMs: seconds(env.DEVILUDO_EVIDENCE_ARCHIVE_S3_TIMEOUT_SECONDS, 30, 1, 600) * 1_000,
    });
    secretAccessKey.fill(0);
    store = s3;
    const [jobPublicKeyPem, fleetPublicKeyPem] = await Promise.all([
      readSecret(env, "DEVILUDO_EVIDENCE_ARCHIVE_RUNNER_JOB_PUBLIC_KEY_FILE", 32, MAX_SECRET_BYTES),
      readSecret(env, "DEVILUDO_EVIDENCE_ARCHIVE_RUNNER_FLEET_PUBLIC_KEY_FILE", 32, MAX_SECRET_BYTES),
    ]);
    const jobPublicKey = createPublicKey(jobPublicKeyPem);
    const fleetPublicKey = createPublicKey(fleetPublicKeyPem);
    if (jobPublicKey.asymmetricKeyType !== "ed25519" || fleetPublicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Evidence archive Runner verification keys must be Ed25519");
    }
    const fleet = new SignedRunnerFleetPolicy(
      new FileRunnerFleetManifestLoader(requiredAbsolutePath(env, "DEVILUDO_EVIDENCE_ARCHIVE_RUNNER_FLEET_MANIFEST_FILE")),
      new Map([[requiredEnv(env, "DEVILUDO_EVIDENCE_ARCHIVE_RUNNER_FLEET_KEY_ID"), fleetPublicKey]]),
    );
    runnerArtifacts = new RunnerArtifactGrantService({
      jobKeyId: requiredEnv(env, "DEVILUDO_EVIDENCE_ARCHIVE_RUNNER_JOB_KEY_ID"),
      jobPublicKey,
      fleet,
      transfer: s3,
      reservations: s3,
    });
    const preparedInputPublicKeyPem = await readSecret(
      env,
      "DEVILUDO_EVIDENCE_ARCHIVE_PREPARED_INPUT_ASSIGNMENT_PUBLIC_KEY_FILE",
      32,
      MAX_SECRET_BYTES,
    );
    const preparedInputAuthorizer = preparedInputTenantAuthorizerFromFiles({
      manifestPath: requiredAbsolutePath(env, "DEVILUDO_EVIDENCE_ARCHIVE_PREPARED_INPUT_ASSIGNMENT_MANIFEST_FILE"),
      keyId: requiredEnv(env, "DEVILUDO_EVIDENCE_ARCHIVE_PREPARED_INPUT_ASSIGNMENT_KEY_ID"),
      publicKeyPem: preparedInputPublicKeyPem,
      spiffeId: requiredEnv(env, "DEVILUDO_EVIDENCE_ARCHIVE_PREPARED_INPUT_SPIFFE_ID"),
    });
    preparedInputs = new PreparedInputGrantService({
      authorizer: preparedInputAuthorizer,
      transfer: s3,
      reservations: s3,
    });
  } else {
    throw new Error("Evidence archive store mode is invalid");
  }

  const [key, cert, clientCa] = await Promise.all([
    readSecret(env, "DEVILUDO_EVIDENCE_ARCHIVE_TLS_KEY_FILE", 32, MAX_SECRET_BYTES),
    readSecret(env, "DEVILUDO_EVIDENCE_ARCHIVE_TLS_CERT_FILE", 32, MAX_SECRET_BYTES),
    readSecret(env, "DEVILUDO_EVIDENCE_ARCHIVE_CLIENT_CA_FILE", 32, MAX_SECRET_BYTES),
  ]);
  const allowedSpiffeIds = parseSpiffeIds(requiredEnv(env, "DEVILUDO_EVIDENCE_ARCHIVE_ALLOWED_SPIFFE_IDS_JSON"));
  const archive = new EvidenceArchiveService({ store, ...(runnerArtifacts ? { artifactVerifier: runnerArtifacts } : {}) });
  const handler = createEvidenceArchiveHandler({
    archive,
    allowedSpiffeIds,
    ...(runnerArtifacts ? { runnerArtifacts } : {}),
    ...(preparedInputs ? { preparedInputs } : {}),
  });
  const server = createEvidenceArchiveHttpsServer({ tls: { key, cert, ca: clientCa }, handler });
  return Object.freeze({
    host: host(env.DEVILUDO_EVIDENCE_ARCHIVE_HOST),
    port: port(env.DEVILUDO_EVIDENCE_ARCHIVE_PORT),
    store,
    archive,
    runnerArtifacts,
    preparedInputs,
    server,
  });
}

export async function runEvidenceArchiveService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const service = await evidenceArchiveServiceFromEnv(env);
  await service.archive.probe();
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    service.server.once("error", fail);
    service.server.listen(service.port, service.host, () => {
      service.server.off("error", fail);
      resolve();
    });
  });
  console.log(`[evidence-archive] READY ${service.host}:${service.port}`);
  const close = () => service.server.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await new Promise<void>((resolve, reject) => {
    service.server.once("close", resolve);
    service.server.once("error", reject);
  });
}

function parseSpiffeIds(value: string): ReadonlySet<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { throw new Error("Evidence archive SPIFFE allow-list is invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32 || new Set(parsed).size !== parsed.length) {
    throw new Error("Evidence archive SPIFFE allow-list is invalid");
  }
  const values = parsed.map((item) => {
    if (typeof item !== "string") throw new Error("Evidence archive SPIFFE allow-list is invalid");
    const url = new URL(item);
    if (url.protocol !== "spiffe:" || url.username || url.password || url.search || url.hash
      || url.toString() !== item) throw new Error("Evidence archive SPIFFE allow-list is invalid");
    return item;
  }).sort();
  if (JSON.stringify(values) !== JSON.stringify(parsed)) {
    throw new Error("Evidence archive SPIFFE allow-list must be sorted");
  }
  return new Set(values);
}

async function readSecret(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): Promise<Buffer> {
  const path = requiredAbsolutePath(env, name);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < minimum || metadata.size > maximum) {
    throw new Error(`${name} file is invalid`);
  }
  const value = await readFile(path);
  if (value.byteLength < minimum || value.byteLength > maximum) throw new Error(`${name} file is invalid`);
  return value;
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

function host(value: string | undefined): string {
  const selected = value ?? "0.0.0.0";
  if (selected !== "0.0.0.0" && selected !== "::") throw new Error("Evidence archive host is invalid");
  return selected;
}

function port(value: string | undefined): number {
  const parsed = value === undefined ? 4443 : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1_024 || parsed > 65_535 || (value !== undefined && String(parsed) !== value)) {
    throw new Error("Evidence archive port is invalid");
  }
  return parsed;
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Evidence archive timeout is invalid");
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runEvidenceArchiveService();
}
