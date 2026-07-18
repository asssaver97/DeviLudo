import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { PostgresInferenceCredentialAuthority } from "./authority";
import { createSecretBrokerHandler, createSecretBrokerHttpsServer } from "./http";
import { SecretBrokerService } from "./service";
import { PostgresSecretBrokerStore } from "./store";
import { VaultKvV2SecretBackend } from "./vault-backend";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function secretBrokerRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (env.NODE_ENV !== "production") throw new Error("Secret Broker production service requires NODE_ENV=production");
  const [serverKey, serverCertificate, clientCa, vaultCa, vaultToken] = await Promise.all([
    secretFile(env, "DEVILUDO_SECRET_BROKER_TLS_KEY_FILE", 32, MAX_SECRET_BYTES),
    secretFile(env, "DEVILUDO_SECRET_BROKER_TLS_CERT_FILE", 32, MAX_SECRET_BYTES),
    secretFile(env, "DEVILUDO_SECRET_BROKER_CLIENT_CA_FILE", 32, MAX_SECRET_BYTES),
    secretFile(env, "DEVILUDO_SECRET_BROKER_VAULT_CA_FILE", 32, MAX_SECRET_BYTES),
    secretFile(env, "DEVILUDO_SECRET_BROKER_VAULT_TOKEN_FILE", 8, 4_096),
  ]);
  const vaultClientKeyFile = env.DEVILUDO_SECRET_BROKER_VAULT_TLS_KEY_FILE?.trim();
  const vaultClientCertificateFile = env.DEVILUDO_SECRET_BROKER_VAULT_TLS_CERT_FILE?.trim();
  if (Boolean(vaultClientKeyFile) !== Boolean(vaultClientCertificateFile)) {
    vaultToken.fill(0); throw new Error("Vault client TLS key and certificate must be configured together");
  }
  const [vaultKey, vaultCertificate] = vaultClientKeyFile && vaultClientCertificateFile
    ? await Promise.all([
      secretFile(env, "DEVILUDO_SECRET_BROKER_VAULT_TLS_KEY_FILE", 32, MAX_SECRET_BYTES),
      secretFile(env, "DEVILUDO_SECRET_BROKER_VAULT_TLS_CERT_FILE", 32, MAX_SECRET_BYTES),
    ])
    : [undefined, undefined];
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "secret-broker" });
  try {
    const store = new PostgresSecretBrokerStore(pool);
    const authority = new PostgresInferenceCredentialAuthority(pool);
    const backend = new VaultKvV2SecretBackend({
      endpoint: required(env, "DEVILUDO_SECRET_BROKER_VAULT_URL"),
      mount: required(env, "DEVILUDO_SECRET_BROKER_VAULT_KV_MOUNT"),
      token: vaultToken,
      tls: { ca: vaultCa, ...(vaultKey && vaultCertificate ? { key: vaultKey, certificate: vaultCertificate } : {}) },
      timeoutMs: integer(env.DEVILUDO_SECRET_BROKER_VAULT_TIMEOUT_MS, 10_000, 1_000, 60_000),
    });
    vaultToken.fill(0);
    const service = new SecretBrokerService({ store, backend, authority,
      staticGitHubSecretRefs: staticSecretRefs(required(env, "DEVILUDO_SECRET_BROKER_GITHUB_STATIC_SECRET_REFS")) });
    const handler = createSecretBrokerHandler({
      service,
      controlPlaneSpiffeIds: spiffeSet(required(env, "DEVILUDO_SECRET_BROKER_CONTROL_PLANE_SPIFFE_IDS")),
      githubSpiffeIds: spiffeSet(required(env, "DEVILUDO_SECRET_BROKER_GITHUB_SPIFFE_IDS")),
      inferenceGatewaySpiffeIds: spiffeSet(required(env, "DEVILUDO_SECRET_BROKER_INFERENCE_SPIFFE_IDS")),
    });
    const server = createSecretBrokerHttpsServer({
      tls: { key: serverKey, cert: serverCertificate, ca: clientCa }, handler,
      requestTimeoutMs: integer(env.DEVILUDO_SECRET_BROKER_REQUEST_TIMEOUT_MS, 30_000, 1_000, 60_000),
    });
    return Object.freeze({
      host: bindHost(env.DEVILUDO_SECRET_BROKER_HOST),
      port: integer(env.DEVILUDO_SECRET_BROKER_PORT, 4_762, 1_024, 65_535),
      pool, store, authority, backend, service, server,
    });
  } catch (error) {
    vaultToken.fill(0);
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runSecretBrokerService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await secretBrokerRuntimeFromEnv(env);
  let cleanupRunning = false;
  const cleanup = async () => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try { await runtime.service.purgeExpiredPkce(); }
    catch { diagnostic("CLEANUP_FAILED"); }
    finally { cleanupRunning = false; }
  };
  let cleanupTimer: NodeJS.Timeout | undefined;
  try {
    await runtime.service.probe();
    await cleanup();
    await new Promise<void>((ready, reject) => {
      const fail = (error: Error) => reject(error);
      runtime.server.once("error", fail);
      runtime.server.listen(runtime.port, runtime.host, () => { runtime.server.off("error", fail); ready(); });
    });
    diagnostic("READY");
    cleanupTimer = setInterval(() => { void cleanup(); },
      integer(env.DEVILUDO_SECRET_BROKER_EXPIRY_SWEEP_MS, 60_000, 10_000, 3_600_000));
    cleanupTimer.unref();
    const close = () => runtime.server.close();
    process.once("SIGINT", close); process.once("SIGTERM", close);
    await new Promise<void>((closed, reject) => {
      runtime.server.once("close", closed); runtime.server.once("error", reject);
    });
  } finally { if (cleanupTimer) clearInterval(cleanupTimer); await runtime.pool.close(); diagnostic("STOPPED"); }
}

async function secretFile(env: Readonly<Record<string, string | undefined>>, name: string, minimum: number, maximum: number): Promise<Buffer> {
  const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const metadata = await file.stat(); if (!metadata.isFile() || metadata.size < minimum || metadata.size > maximum) throw new Error(`${name} file is invalid`); return await file.readFile(); }
  finally { await file.close(); }
}
function spiffeSet(value: string): ReadonlySet<string> {
  const values = value.split(",").map((item) => item.trim());
  if (!values.length || values.some((item) => !item) || new Set(values).size !== values.length) throw new Error("Secret Broker SPIFFE allow-list is invalid");
  for (const item of values) { const url = new URL(item); if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash || url.toString() !== item) throw new Error("Secret Broker SPIFFE identity is invalid"); }
  return new Set(values);
}
function staticSecretRefs(value: string): ReadonlySet<string> {
  const values = value.split(",").map((item) => item.trim());
  const pattern = /^vault:\/\/kv\/deviludo\/static\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
  if (!values.length || values.some((item) => !pattern.test(item)) || new Set(values).size !== values.length) {
    throw new Error("Secret Broker GitHub static SecretRef allow-list is invalid");
  }
  return new Set(values);
}
function bindHost(value: string | undefined): string { const result = value?.trim() || "0.0.0.0"; if (result !== "0.0.0.0" && result !== "::") throw new Error("Secret Broker host is invalid"); return result; }
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number { if (value === undefined) return fallback; const result = Number(value); if (!Number.isInteger(result) || result < minimum || result > maximum || String(result) !== value) throw new Error("Secret Broker numeric configuration is invalid"); return result; }
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function diagnostic(event: "READY" | "STOPPED" | "FAILED" | "CLEANUP_FAILED"): void { process.stderr.write(`${JSON.stringify({ service: "deviludo-secret-broker", event })}\n`); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runSecretBrokerService().catch(() => { diagnostic("FAILED"); process.exitCode = 1; });
}
