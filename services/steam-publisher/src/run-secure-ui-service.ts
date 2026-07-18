import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import {
  MtlsSteamReleaseWebAuthnClient,
  MtlsSteamSecureUiAccessClient,
  MtlsSteamSecureUiIdentityClient,
} from "./steam-secure-ui-clients";
import { registerSteamSecureUiRoutes } from "./steam-secure-ui";
import { SteamAccessUiSessionSigner, SteamAccessUiSessionVerifier } from "./steam-access-ui-session";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function steamSecureUiServiceConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  distinctPrivateKeyMounts(env, [
    "DEVILUDO_STEAM_SECURE_UI_TLS_KEY_FILE",
    "DEVILUDO_STEAM_SECURE_UI_IDENTITY_TLS_KEY_FILE",
    "DEVILUDO_STEAM_SECURE_UI_ACCESS_TLS_KEY_FILE",
    "DEVILUDO_STEAM_SECURE_UI_MFA_TLS_KEY_FILE",
    "DEVILUDO_STEAM_UI_SESSION_PRIVATE_KEY_FILE",
  ]);
  const [serverKey, serverCertificate, identityKey, identityCertificate, identityCa,
    accessKey, accessCertificate, accessCa, mfaKey, mfaCertificate, mfaCa, sessionPrivateKey] = await Promise.all([
    secretFile(env, "DEVILUDO_STEAM_SECURE_UI_TLS_KEY_FILE"),
    secretFile(env, "DEVILUDO_STEAM_SECURE_UI_TLS_CERT_FILE"),
    secretFile(env, "DEVILUDO_STEAM_SECURE_UI_IDENTITY_TLS_KEY_FILE"),
    secretFile(env, "DEVILUDO_STEAM_SECURE_UI_IDENTITY_TLS_CERT_FILE"),
    secretFile(env, "DEVILUDO_STEAM_SECURE_UI_IDENTITY_CA_FILE"),
    secretFile(env, "DEVILUDO_STEAM_SECURE_UI_ACCESS_TLS_KEY_FILE"),
    secretFile(env, "DEVILUDO_STEAM_SECURE_UI_ACCESS_TLS_CERT_FILE"),
    secretFile(env, "DEVILUDO_STEAM_SECURE_UI_ACCESS_CA_FILE"),
    secretFile(env, "DEVILUDO_STEAM_SECURE_UI_MFA_TLS_KEY_FILE"),
    secretFile(env, "DEVILUDO_STEAM_SECURE_UI_MFA_TLS_CERT_FILE"),
    secretFile(env, "DEVILUDO_STEAM_SECURE_UI_MFA_CA_FILE"),
    privateKeyFile(env, "DEVILUDO_STEAM_UI_SESSION_PRIVATE_KEY_FILE"),
  ]);
  return Object.freeze({
    host: bindHost(env.DEVILUDO_STEAM_SECURE_UI_HOST),
    port: integer(env.DEVILUDO_STEAM_SECURE_UI_PORT, 4576, 1024, 65535),
    requestTimeoutMs: integer(env.DEVILUDO_STEAM_SECURE_UI_REQUEST_TIMEOUT_MS, 45_000, 1_000, 120_000),
    dependencyTimeoutMs: integer(env.DEVILUDO_STEAM_SECURE_UI_DEPENDENCY_TIMEOUT_MS, 30_000, 1_000, 120_000),
    publicOrigin: strictOrigin(required(env, "DEVILUDO_STEAM_SECURE_UI_PUBLIC_ORIGIN")),
    identityOrigin: strictOrigin(required(env, "DEVILUDO_STEAM_SECURE_UI_IDENTITY_URL")),
    accessOrigin: strictOrigin(required(env, "DEVILUDO_STEAM_SECURE_UI_ACCESS_URL")),
    mfaOrigin: strictOrigin(required(env, "DEVILUDO_STEAM_SECURE_UI_MFA_URL")),
    sessionKeyId: requiredId(env, "DEVILUDO_STEAM_UI_SESSION_KEY_ID"),
    serverTls: Object.freeze({ key: serverKey, certificate: serverCertificate }),
    identityTls: Object.freeze({ key: identityKey, certificate: identityCertificate, ca: identityCa }),
    accessTls: Object.freeze({ key: accessKey, certificate: accessCertificate, ca: accessCa }),
    mfaTls: Object.freeze({ key: mfaKey, certificate: mfaCertificate, ca: mfaCa }),
    sessionPrivateKey,
    sessionPublicKey: createPublicKey(sessionPrivateKey),
  });
}

export async function steamSecureUiRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const config = await steamSecureUiServiceConfigFromEnv(env);
  const identity = new MtlsSteamSecureUiIdentityClient({ endpoint: config.identityOrigin, tls: config.identityTls,
    timeoutMs: config.dependencyTimeoutMs });
  const access = new MtlsSteamSecureUiAccessClient({ endpoint: config.accessOrigin, tls: config.accessTls,
    timeoutMs: config.dependencyTimeoutMs });
  const webauthn = new MtlsSteamReleaseWebAuthnClient({ endpoint: config.mfaOrigin, tls: config.mfaTls,
    timeoutMs: config.dependencyTimeoutMs });
  const sessions = new SteamAccessUiSessionSigner(config.sessionKeyId, config.sessionPrivateKey);
  const sessionVerifier = new SteamAccessUiSessionVerifier(config.sessionKeyId, config.sessionPublicKey);
  const server = Fastify({ logger: false, bodyLimit: 128 * 1024, requestTimeout: config.requestTimeoutMs,
    https: { key: config.serverTls.key, cert: config.serverTls.certificate, minVersion: "TLSv1.3" } });
  registerSteamSecureUiRoutes(server, { publicOrigin: config.publicOrigin, identity, access, webauthn, sessions, sessionVerifier });
  server.get("/healthz", async (_request, reply) => {
    reply.header("cache-control", "no-store"); reply.header("x-content-type-options", "nosniff");
    try {
      await Promise.all([identity.probe(), access.probe(), webauthn.probe()]);
      return reply.send({ schemaVersion: "deviludo.steam-secure-ui-health.v1", status: "ok" });
    } catch { return reply.status(503).send({ schemaVersion: "deviludo.steam-secure-ui-health.v1", status: "unavailable" }); }
  });
  return Object.freeze({ ...config, identity, access, webauthn, sessions, sessionVerifier, server });
}

export async function runSteamSecureUiService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await steamSecureUiRuntimeFromEnv(env);
  try {
    await Promise.all([runtime.identity.probe(), runtime.access.probe(), runtime.webauthn.probe()]);
    await runtime.server.listen({ host: runtime.host, port: runtime.port });
    console.log(`[steam-secure-ui] READY ${runtime.host}:${runtime.port}`);
    const shutdown = new AbortController(); const stop = () => shutdown.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { await new Promise<void>((done) => shutdown.signal.addEventListener("abort", () => done(), { once: true })); }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } finally {
    await runtime.server.close().catch(() => undefined);
    console.log("[steam-secure-ui] STOPPED");
  }
}

async function secretFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || path.includes("\0")) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_SECRET_BYTES) throw new Error(`${name} file is invalid`);
    return await file.readFile();
  } finally { await file.close(); }
}

async function privateKeyFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<KeyObject> {
  const key = createPrivateKey(await secretFile(env, name));
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new Error(`${name} is invalid`);
  return key;
}
function strictOrigin(value: string): string { const url = new URL(value); if (url.protocol !== "https:" || !url.hostname || url.username || url.password
  || url.pathname !== "/" || url.search || url.hash) throw new Error("Steam Secure UI origin is invalid"); return url.href; }
function bindHost(value: string | undefined): string { const result = value ?? "0.0.0.0"; if (result !== "0.0.0.0" && result !== "::") throw new Error("Steam Secure UI bind host is invalid"); return result; }
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number { if (value === undefined) return fallback;
  const result = Number(value); if (!Number.isSafeInteger(result) || result < minimum || result > maximum || String(result) !== value) throw new Error("Steam Secure UI numeric configuration is invalid"); return result; }
function requiredId(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = required(env, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`${name} is invalid`); return value; }
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function distinctPrivateKeyMounts(env: Readonly<Record<string, string | undefined>>, names: readonly string[]): void {
  const paths = names.map((name) => required(env, name));
  if (new Set(paths).size !== paths.length) throw new Error("Steam Secure UI private key mounts must be distinct");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runSteamSecureUiService();
