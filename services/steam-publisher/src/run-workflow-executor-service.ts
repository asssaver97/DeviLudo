import { createPublicKey, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { S3ImmutableObjectStore } from "../../evidence-archive/src/s3-store";
import { postgresWorkflowPoolFromEnv, type ClosablePostgresWorkflowPool } from "../../temporal/src/node-postgres";
import type { SteamInstallEvidenceGate } from "./contracts";
import { SteamReleaseCoordinator } from "./coordinator";
import { MtlsSteamDepotFinalizer } from "./depot-finalization";
import { LockedNativeSteamPublisherConnector } from "./locked-native-publisher";
import { PostgresSteamCleanInstallDispatcher } from "./postgres-clean-install-dispatch";
import { PostgresSteamPublishOperationStore } from "./postgres-publish-operations";
import { PostgresSteamRcArtifactArchive, PostgresSteamRcIssuanceAuthority } from "./postgres-rc-issuance";
import { PostgresSteamReleaseEvidenceGate } from "./postgres-release-evidence";
import { PostgresSteamPrivateBetaReleasePreparer } from "./postgres-release-lifecycle";
import {
  PostgresSteamBuildReceiptArchive,
  PostgresSteamDefaultBranchReceiptArchive,
  PostgresSteamWorkflowExecutionAuthority,
} from "./postgres-workflow-execution";
import { SteamRcIssuer } from "./rc-issuance";
import { MtlsSteamRcArtifactSigner, S3SteamRcObjectInspector } from "./rc-production-dependencies";
import { AuthoritativeSteamWorkflowExecutor } from "./workflow-broker-executor";
import { steamWorkflowWorkerFromEnv } from "./run-workflow-worker";

const MAX_SECRET_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

export interface SteamWorkflowExecutorConfig {
  readonly nativePublisher: Readonly<{
    executable: string;
    executableDigest: string;
    configFile: string;
    configDigest: string;
    workRoot: string;
    timeoutMs: number;
  }>;
  readonly rcSigner: Readonly<{
    endpoint: string;
    keyId: string;
    publicKey: KeyObject;
    tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
    timeoutMs: number;
  }>;
  readonly depotFinalizer: Readonly<{
    endpoint: string;
    tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
    timeoutMs: number;
  }>;
  readonly authorization: Readonly<{ keyId: string; publicKey: KeyObject }>;
  readonly s3: Readonly<{
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: Buffer;
    ca: Buffer;
    timeoutMs: number;
  }>;
}

/** Loads only fixed identities and file-mounted secret material for the isolated executor image. */
export async function steamWorkflowExecutorConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SteamWorkflowExecutorConfig> {
  const [
    rcPublicKeyPem, authorizationPublicKeyPem, signerKey, signerCertificate, signerCa,
    finalizerKey, finalizerCertificate, finalizerCa, s3SecretFile, s3Ca,
  ] = await Promise.all([
    secret(env, "DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_PUBLIC_KEY_FILE", 32, MAX_SECRET_BYTES),
    secret(env, "DEVILUDO_STEAM_EXECUTOR_AUTHORIZATION_PUBLIC_KEY_FILE", 32, MAX_SECRET_BYTES),
    secret(env, "DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_TLS_KEY_FILE", 32, MAX_SECRET_BYTES),
    secret(env, "DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_TLS_CERT_FILE", 32, MAX_SECRET_BYTES),
    secret(env, "DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_CA_FILE", 32, MAX_SECRET_BYTES),
    secret(env, "DEVILUDO_STEAM_EXECUTOR_DEPOT_FINALIZER_TLS_KEY_FILE", 32, MAX_SECRET_BYTES),
    secret(env, "DEVILUDO_STEAM_EXECUTOR_DEPOT_FINALIZER_TLS_CERT_FILE", 32, MAX_SECRET_BYTES),
    secret(env, "DEVILUDO_STEAM_EXECUTOR_DEPOT_FINALIZER_CA_FILE", 32, MAX_SECRET_BYTES),
    secret(env, "DEVILUDO_STEAM_EXECUTOR_S3_SECRET_KEY_FILE", 16, 256),
    secret(env, "DEVILUDO_STEAM_EXECUTOR_S3_CA_FILE", 32, MAX_SECRET_BYTES),
  ]);
  const rcPublicKey = ed25519PublicKey(rcPublicKeyPem, "RC signer");
  const authorizationPublicKey = ed25519PublicKey(authorizationPublicKeyPem, "authorization");
  if (signerKey.equals(finalizerKey) || signerCertificate.equals(finalizerCertificate)) {
    throw new Error("Steam RC signer and depot finalizer must use distinct mTLS identities");
  }
  const secretAccessKey = Buffer.from(s3SecretFile.toString("utf8").trim(), "utf8");
  s3SecretFile.fill(0);
  if (secretAccessKey.byteLength < 16 || secretAccessKey.byteLength > 256) {
    secretAccessKey.fill(0);
    throw new Error("DEVILUDO_STEAM_EXECUTOR_S3_SECRET_KEY_FILE value is invalid");
  }
  return Object.freeze({
    nativePublisher: Object.freeze({
      executable: absolute(env, "DEVILUDO_STEAM_EXECUTOR_NATIVE_EXECUTABLE"),
      executableDigest: digest(env, "DEVILUDO_STEAM_EXECUTOR_NATIVE_EXECUTABLE_DIGEST"),
      configFile: absolute(env, "DEVILUDO_STEAM_EXECUTOR_NATIVE_CONFIG_FILE"),
      configDigest: digest(env, "DEVILUDO_STEAM_EXECUTOR_NATIVE_CONFIG_DIGEST"),
      workRoot: absolute(env, "DEVILUDO_STEAM_EXECUTOR_WORK_ROOT"),
      timeoutMs: seconds(env.DEVILUDO_STEAM_EXECUTOR_NATIVE_TIMEOUT_SECONDS, 3_300, 30, 3_600) * 1_000,
    }),
    rcSigner: Object.freeze({
      endpoint: required(env, "DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_URL"),
      keyId: safeId(env, "DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_KEY_ID"),
      publicKey: rcPublicKey,
      tls: Object.freeze({ key: signerKey, certificate: signerCertificate, ca: signerCa }),
      timeoutMs: seconds(env.DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_TIMEOUT_SECONDS, 30, 1, 60) * 1_000,
    }),
    depotFinalizer: Object.freeze({
      endpoint: required(env, "DEVILUDO_STEAM_EXECUTOR_DEPOT_FINALIZER_URL"),
      tls: Object.freeze({ key: finalizerKey, certificate: finalizerCertificate, ca: finalizerCa }),
      timeoutMs: seconds(env.DEVILUDO_STEAM_EXECUTOR_DEPOT_FINALIZER_TIMEOUT_SECONDS, 1_800, 1, 3_600) * 1_000,
    }),
    authorization: Object.freeze({
      keyId: safeId(env, "DEVILUDO_STEAM_EXECUTOR_AUTHORIZATION_KEY_ID"),
      publicKey: authorizationPublicKey,
    }),
    s3: Object.freeze({
      endpoint: required(env, "DEVILUDO_STEAM_EXECUTOR_S3_ENDPOINT"),
      bucket: required(env, "DEVILUDO_STEAM_EXECUTOR_S3_BUCKET"),
      region: required(env, "DEVILUDO_STEAM_EXECUTOR_S3_REGION"),
      accessKeyId: required(env, "DEVILUDO_STEAM_EXECUTOR_S3_ACCESS_KEY_ID"),
      secretAccessKey,
      ca: s3Ca,
      timeoutMs: seconds(env.DEVILUDO_STEAM_EXECUTOR_S3_TIMEOUT_SECONDS, 30, 1, 600) * 1_000,
    }),
  });
}

/** Wires the authoritative PostgreSQL, S3, KMS and native-publisher boundaries. */
export function composeSteamWorkflowExecutor(
  config: SteamWorkflowExecutorConfig,
  pool: ClosablePostgresWorkflowPool,
) {
  const objects = new S3ImmutableObjectStore(config.s3);
  config.s3.secretAccessKey.fill(0);
  const objectInspector = new S3SteamRcObjectInspector(objects, config.s3.bucket);
  const depotFinalizer = new MtlsSteamDepotFinalizer(config.depotFinalizer);
  const signer = new MtlsSteamRcArtifactSigner(config.rcSigner);
  const connector = new LockedNativeSteamPublisherConnector(config.nativePublisher);
  const releaseEvidence = new PostgresSteamReleaseEvidenceGate(pool);
  const cleanInstalls = new PostgresSteamCleanInstallDispatcher(pool);
  const publishOperations = new PostgresSteamPublishOperationStore(pool);
  const coordinator = new SteamReleaseCoordinator({
    rcKeys: new Map([[config.rcSigner.keyId, config.rcSigner.publicKey]]),
    authorizationKeys: new Map([[config.authorization.keyId, config.authorization.publicKey]]),
    releaseEvidence,
    connector,
    installs: cleanInstalls,
    installEvidence: projectedInstallEvidenceOnly,
    operations: publishOperations,
  });
  const privateBeta = Object.freeze({
    uploadPrivateBeta: coordinator.uploadPrivateBeta.bind(coordinator),
    async probe(): Promise<void> {
      await Promise.all([
        releaseEvidence.probe(), connector.probe(), cleanInstalls.probe(), publishOperations.probe(),
      ]);
    },
  });
  const rcIssuer = new SteamRcIssuer(
    new PostgresSteamRcIssuanceAuthority(pool),
    depotFinalizer,
    objectInspector,
    signer,
    new PostgresSteamRcArtifactArchive(pool),
  );
  const executor = new AuthoritativeSteamWorkflowExecutor(
    new PostgresSteamPrivateBetaReleasePreparer(pool),
    rcIssuer,
    new PostgresSteamWorkflowExecutionAuthority(pool),
    privateBeta,
    new PostgresSteamBuildReceiptArchive(pool),
    connector,
    new PostgresSteamDefaultBranchReceiptArchive(pool),
  );
  return Object.freeze({ executor, connector, coordinator, rcIssuer, depotFinalizer, objects });
}

export async function steamWorkflowExecutorServiceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const config = await steamWorkflowExecutorConfigFromEnv(env);
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "steam-executor" });
  try {
    const composition = composeSteamWorkflowExecutor(config, pool);
    const worker = steamWorkflowWorkerFromEnv(composition.executor, env, pool);
    return Object.freeze({ config, ...composition, ...worker });
  } catch (error) {
    config.s3.secretAccessKey.fill(0);
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runSteamWorkflowExecutorService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await steamWorkflowExecutorServiceFromEnv(env);
  const shutdown = new AbortController();
  const requestShutdown = () => shutdown.abort();
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  try {
    await runtime.host.run(shutdown.signal);
  } finally {
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
    await runtime.pool.close();
  }
}

// Runner Control owns the authoritative INSTALL_TESTING projection. This
// executor never exposes the coordinator's legacy in-process completion path.
const projectedInstallEvidenceOnly: SteamInstallEvidenceGate = Object.freeze({
  async assertPassed(): Promise<never> {
    throw new Error("Steam clean-install evidence is projected by Runner Control");
  },
});

function ed25519PublicKey(value: Buffer, label: string): KeyObject {
  const key = createPublicKey(value);
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error(`Steam executor ${label} public key must be Ed25519`);
  }
  return key;
}

async function secret(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): Promise<Buffer> {
  const file = await open(absolute(env, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < minimum || metadata.size > maximum) {
      throw new Error(`${name} file is invalid`);
    }
    return await file.readFile();
  } finally { await file.close(); }
}

function absolute(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) {
    throw new Error(`${name} path is invalid`);
  }
  return value;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeId(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!SAFE_ID.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function digest(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!SHA256.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Steam executor timeout is invalid");
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSteamWorkflowExecutorService();
}
