import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyRequest } from "fastify";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { workflowSpiffeIdFromAuthorizedTls } from "../../temporal/src/receiver-http";
import { MtlsGitHubAuthorizationSecretClient } from "../../scm-proxy/src/github-auth-secret-client";
import { PlatformIdentityBroker } from "./broker";
import { GitHubRestIdentityVerifier } from "./github-oauth";
import { registerIdentityRoutes } from "./http";
import { PostgresIdentityStore } from "./postgres-store";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function identityRuntimeFromEnv(env: Readonly<Record<string, string | undefined>> = process.env) {
  const [serverKey, serverCertificate, clientCa, secretKey, secretCertificate, secretCa] = await Promise.all([
    secretFile(env, "DEVILUDO_IDENTITY_TLS_KEY_FILE"), secretFile(env, "DEVILUDO_IDENTITY_TLS_CERT_FILE"),
    secretFile(env, "DEVILUDO_IDENTITY_CLIENT_CA_FILE"), secretFile(env, "DEVILUDO_IDENTITY_SECRET_TLS_KEY_FILE"),
    secretFile(env, "DEVILUDO_IDENTITY_SECRET_TLS_CERT_FILE"), secretFile(env, "DEVILUDO_IDENTITY_SECRET_CA_FILE"),
  ]);
  const webSpiffeIds = spiffeSet(required(env, "DEVILUDO_IDENTITY_WEB_SPIFFE_IDS"));
  const adminSpiffeIds = spiffeSet(required(env, "DEVILUDO_IDENTITY_ADMIN_SPIFFE_IDS"));
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "identity" });
  try {
    const secrets = new MtlsGitHubAuthorizationSecretClient({ endpoint: required(env, "DEVILUDO_IDENTITY_SECRET_BROKER_URL"),
      tls: { key: secretKey, certificate: secretCertificate, ca: secretCa },
      timeoutMs: integer(env.DEVILUDO_IDENTITY_SECRET_TIMEOUT_MS, 10_000, 1_000, 60_000) });
    const store = new PostgresIdentityStore(pool);
    const clientId = required(env, "DEVILUDO_GITHUB_APP_CLIENT_ID");
    const redirectUri = strictRedirectUri(required(env, "DEVILUDO_IDENTITY_GITHUB_REDIRECT_URI"));
    const github = new GitHubRestIdentityVerifier({ clientId, redirectUri,
      clientSecretRef: required(env, "DEVILUDO_GITHUB_APP_CLIENT_SECRET_REF"), secrets,
      timeoutMs: integer(env.DEVILUDO_GITHUB_API_TIMEOUT_MS, 15_000, 1_000, 60_000) });
    const broker = new PlatformIdentityBroker({ clientId, redirectUri, store, secrets, github,
      sessionHmacKey: sessionHmacKey(env), sessionSeconds: integer(env.DEVILUDO_IDENTITY_SESSION_SECONDS, 28_800, 300, 86_400) });
    const authorize = (allowed: ReadonlySet<string>) => (request: FastifyRequest) => {
      if (!allowed.has(workflowSpiffeIdFromAuthorizedTls(request))) throw new Error("Identity workload is not allowed");
    };
    const server = Fastify({ logger: false, bodyLimit: 64 * 1024,
      requestTimeout: integer(env.DEVILUDO_IDENTITY_REQUEST_TIMEOUT_MS, 30_000, 1_000, 60_000),
      https: { key: serverKey, cert: serverCertificate, ca: clientCa, requestCert: true,
        rejectUnauthorized: true, minVersion: "TLSv1.3" } });
    registerIdentityRoutes(server, { broker, authorizeWeb: authorize(webSpiffeIds), authorizeAdmin: authorize(adminSpiffeIds) });
    server.get("/healthz", async (request, reply) => {
      reply.header("cache-control", "no-store"); reply.header("x-content-type-options", "nosniff");
      const identity = workflowSpiffeIdFromAuthorizedTls(request);
      if (!webSpiffeIds.has(identity) && !adminSpiffeIds.has(identity)) return reply.status(401).send({ error: { code: "WORKLOAD_IDENTITY_REQUIRED" } });
      return reply.send({ status: "ok", service: "deviludo-identity-broker" });
    });
    return Object.freeze({ host: bindHost(env.DEVILUDO_IDENTITY_HOST), port: integer(env.DEVILUDO_IDENTITY_PORT, 4560, 1024, 65535),
      pool, secrets, store, github, broker, server });
  } catch (error) { await pool.close().catch(() => undefined); throw error; }
}

export async function runIdentityService(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const runtime = await identityRuntimeFromEnv(env);
  try {
    await Promise.all([runtime.pool.probe(), runtime.secrets.probe()]);
    await runtime.server.listen({ host: runtime.host, port: runtime.port });
    console.log(`[identity] READY ${runtime.host}:${runtime.port}`);
    const shutdown = new AbortController(); const stop = () => shutdown.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { await new Promise<void>((done) => shutdown.signal.addEventListener("abort", () => done(), { once: true })); }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } finally {
    await runtime.server.close().catch(() => undefined); await runtime.pool.close(); console.log("[identity] STOPPED");
  }
}

async function secretFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = required(env, name); if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || path.includes("\0")) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const metadata = await file.stat(); if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_SECRET_BYTES) throw new Error(`${name} file is invalid`); return await file.readFile(); }
  finally { await file.close(); }
}
function sessionHmacKey(env: Readonly<Record<string, string | undefined>>): Buffer { const key = Buffer.from(required(env, "DEVILUDO_SESSION_HMAC_KEY"), "base64url"); if (key.byteLength < 32 || key.byteLength > 64) throw new Error("Platform session HMAC key is invalid"); return key; }
function strictRedirectUri(value: string): string { const url = new URL(value); if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/api/auth/github/callback") throw new Error("Production identity redirect URI is invalid"); return url.href; }
function spiffeSet(value: string): ReadonlySet<string> { const values = value.split(",").map((item) => item.trim()); if (!values.length || values.some((item) => !item) || new Set(values).size !== values.length) throw new Error("Identity SPIFFE allow-list is invalid"); for (const item of values) { const url = new URL(item); if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash || url.toString() !== item) throw new Error("Identity SPIFFE identity is invalid"); } return new Set(values); }
function bindHost(value: string | undefined): string { const result = value ?? "0.0.0.0"; if (result !== "0.0.0.0" && result !== "::") throw new Error("Identity bind host is invalid"); return result; }
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number { if (value === undefined) return fallback; const result = Number(value); if (!Number.isSafeInteger(result) || result < minimum || result > maximum || String(result) !== value) throw new Error("Identity numeric configuration is invalid"); return result; }
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runIdentityService();
