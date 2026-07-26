import { createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Server as HttpsServer } from "node:https";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import {
  createSteamDepotFinalizerHostActivationHandler,
  createSteamDepotFinalizerHostActivationHttpsServer,
} from "./host-activation-ingress";
import {
  MtlsSteamDepotFinalizerHostActivationSigner,
  PostgresSteamDepotFinalizerHostActivations,
} from "./postgres-host-activations";

const MAX_SECRET_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;

export async function steamDepotFinalizerHostActivationAuthorityFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (env.NODE_ENV !== "production") {
    throw new Error("Steam depot Finalizer host activation authority requires NODE_ENV=production");
  }
  const [serverKey, serverCertificate, clientCa, signerKey, signerCertificate, signerCa, publicKeyPem] = await Promise.all([
    secret(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_CLIENT_CA_FILE"),
    secret(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_SIGNER_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_SIGNER_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_SIGNER_TLS_CA_FILE"),
    secret(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_SIGNING_PUBLIC_KEY_FILE"),
  ]);
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") invalidConfig();
  const serviceEnv = Object.freeze({
    ...env,
    DEVILUDO_WORKFLOW_DESTINATION: "steam-finalizer-host-authority",
  });
  const pool = postgresWorkflowPoolFromEnv(serviceEnv);
  try {
    const signer = new MtlsSteamDepotFinalizerHostActivationSigner({
      endpoint: required(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_SIGNER_ENDPOINT"),
      keyId: safeId(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_SIGNING_KEY_ID"),
      publicKey,
      tls: { key: signerKey, certificate: signerCertificate, ca: signerCa },
      timeoutMs: integer(env.DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_SIGNER_TIMEOUT_MS,
        30_000, 1_000, 60_000),
    });
    const authority = new PostgresSteamDepotFinalizerHostActivations(pool, signer,
      integer(env.DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_GRANT_DURATION_SECONDS, 600, 60, 900));
    const handler = createSteamDepotFinalizerHostActivationHandler({
      authority,
      allowedHostSpiffeIds: spiffeIds(required(env,
        "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_ALLOWED_SPIFFE_IDS")),
    });
    const server = createSteamDepotFinalizerHostActivationHttpsServer({
      tls: { key: serverKey, cert: serverCertificate, ca: clientCa },
      handler,
      maxBodyBytes: integer(env.DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_MAX_BODY_BYTES,
        256 * 1024, 4 * 1024, 256 * 1024),
    });
    return Object.freeze({
      host: bindHost(env.DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_HOST),
      port: integer(env.DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_AUTHORITY_PORT, 4_856, 1_024, 65_535),
      pool,
      signer,
      authority,
      server,
    });
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runSteamDepotFinalizerHostActivationAuthority(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await steamDepotFinalizerHostActivationAuthorityFromEnv(env);
  try {
    await Promise.all([runtime.pool.probe(), runtime.authority.probe(), runtime.signer.probe()]);
    await listen(runtime.server, runtime.port, runtime.host);
    diagnostic("READY");
    const shutdown = new AbortController();
    const requestShutdown = () => shutdown.abort();
    process.once("SIGINT", requestShutdown);
    process.once("SIGTERM", requestShutdown);
    try { await Promise.race([waitForAbort(shutdown.signal), waitForServerFailure(runtime.server)]); }
    finally {
      process.removeListener("SIGINT", requestShutdown);
      process.removeListener("SIGTERM", requestShutdown);
    }
  } finally {
    if (runtime.server.listening) await close(runtime.server);
    await runtime.pool.close();
    diagnostic("STOPPED");
  }
}

async function secret(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const file = await open(absolute(env, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_SECRET_BYTES) {
      throw new Error(`${name} file is invalid`);
    }
    return await file.readFile();
  } finally { await file.close(); }
}

function spiffeIds(value: string): ReadonlySet<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { throw new Error("Steam depot Finalizer host authority SPIFFE allow-list is invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 64
    || new Set(parsed).size !== parsed.length || parsed.some((item) => typeof item !== "string")) invalidConfig();
  const values = (parsed as string[]).map((item) => {
    const url = new URL(item);
    if (url.protocol !== "spiffe:" || !url.hostname || url.pathname === "/"
      || url.username || url.password || url.search || url.hash || url.toString() !== item) invalidConfig();
    return item;
  });
  if (JSON.stringify(values) !== JSON.stringify([...values].sort())) invalidConfig();
  return new Set(values);
}

function absolute(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /[\0\r\n]/.test(value)) invalidConfig();
  return value;
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function safeId(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!SAFE_ID.test(value)) invalidConfig();
  return value;
}
function bindHost(value: string | undefined): string {
  const selected = value?.trim() || "0.0.0.0";
  if (selected !== "0.0.0.0" && selected !== "::") invalidConfig();
  return selected;
}
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const selected = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum || String(selected) !== value) invalidConfig();
  return selected;
}
function listen(server: HttpsServer, port: number, host: string): Promise<void> {
  return new Promise((accept, reject) => {
    const failure = (error: Error) => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failure); accept(); };
    server.once("error", failure); server.once("listening", ready); server.listen(port, host);
  });
}
function close(server: HttpsServer): Promise<void> {
  return new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
}
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((accept) => signal.addEventListener("abort", () => accept(), { once: true }));
}
function waitForServerFailure(server: HttpsServer): Promise<never> {
  return new Promise((_, reject) => server.once("error", reject));
}
function diagnostic(event: "READY" | "STOPPED" | "FAILED"): void {
  process.stderr.write(`${JSON.stringify({ service: "deviludo-steam-depot-finalizer-host-activation", event })}\n`);
}
function invalidConfig(): never {
  throw new Error("Steam depot Finalizer host activation authority configuration is invalid");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runSteamDepotFinalizerHostActivationAuthority().catch(() => { diagnostic("FAILED"); process.exitCode = 1; });
}
