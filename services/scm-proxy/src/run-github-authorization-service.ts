import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { workflowSpiffeIdFromAuthorizedTls } from "../../temporal/src/receiver-http";
import { GitHubInstallationAuthorizationBroker } from "./github-auth";
import { PostgresGitHubAuthorizationStore } from "./github-auth-postgres";
import { PostgresGitHubBrokerRequestLedger } from "./github-auth-ledger-postgres";
import { registerGitHubAuthorizationBrokerRoutes } from "./github-auth-http";
import { GitHubRestUserAuthorizationVerifier } from "./github-auth-rest";
import { MtlsGitHubAuthorizationSecretClient } from "./github-auth-secret-client";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function githubAuthorizationRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const [serverKey, serverCertificate, clientCa, secretKey, secretCertificate, secretCa] = await Promise.all([
    secretFile(env, "DEVILUDO_GITHUB_AUTH_TLS_KEY_FILE"),
    secretFile(env, "DEVILUDO_GITHUB_AUTH_TLS_CERT_FILE"),
    secretFile(env, "DEVILUDO_GITHUB_AUTH_CLIENT_CA_FILE"),
    secretFile(env, "DEVILUDO_GITHUB_AUTH_SECRET_TLS_KEY_FILE"),
    secretFile(env, "DEVILUDO_GITHUB_AUTH_SECRET_TLS_CERT_FILE"),
    secretFile(env, "DEVILUDO_GITHUB_AUTH_SECRET_CA_FILE"),
  ]);
  const redirectUri = strictRedirectUri(required(env, "DEVILUDO_GITHUB_APP_REDIRECT_URI"));
  const allowedSpiffeIds = spiffeSet(required(env, "DEVILUDO_GITHUB_AUTH_WEB_SPIFFE_IDS"));
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "github-auth" });
  try {
    const secrets = new MtlsGitHubAuthorizationSecretClient({
      endpoint: required(env, "DEVILUDO_GITHUB_AUTH_SECRET_BROKER_URL"),
      tls: { key: secretKey, certificate: secretCertificate, ca: secretCa },
      timeoutMs: milliseconds(env.DEVILUDO_GITHUB_AUTH_SECRET_TIMEOUT_MS, 10_000, 1_000, 60_000),
    });
    const store = new PostgresGitHubAuthorizationStore(pool);
    const ledger = new PostgresGitHubBrokerRequestLedger(
      pool,
      seconds(env.DEVILUDO_GITHUB_AUTH_CLAIM_SECONDS, 120, 30, 600),
    );
    const verifier = new GitHubRestUserAuthorizationVerifier({
      clientId: required(env, "DEVILUDO_GITHUB_APP_CLIENT_ID"),
      clientSecretRef: required(env, "DEVILUDO_GITHUB_APP_CLIENT_SECRET_REF"),
      appSlug: required(env, "DEVILUDO_GITHUB_APP_SLUG"),
      redirectUri,
      secrets,
      timeoutMs: milliseconds(env.DEVILUDO_GITHUB_API_TIMEOUT_MS, 15_000, 1_000, 60_000),
    });
    const broker = new GitHubInstallationAuthorizationBroker({
      appSlug: required(env, "DEVILUDO_GITHUB_APP_SLUG"),
      clientId: required(env, "DEVILUDO_GITHUB_APP_CLIENT_ID"),
      redirectUri,
      store,
      secrets,
      verifier,
    });
    const authorize = (request: FastifyRequest) => {
      if (!allowedSpiffeIds.has(workflowSpiffeIdFromAuthorizedTls(request))) {
        throw new Error("GitHub authorization workload identity is not allowed");
      }
    };
    const server = Fastify({
      logger: false,
      bodyLimit: 64 * 1024,
      requestTimeout: milliseconds(env.DEVILUDO_GITHUB_AUTH_REQUEST_TIMEOUT_MS, 30_000, 1_000, 60_000),
      https: {
        key: serverKey,
        cert: serverCertificate,
        ca: clientCa,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
      },
    });
    registerGitHubAuthorizationBrokerRoutes(server, { broker, ledger, authorize });
    registerGitHubAuthorizationHealthRoute(server, {
      authorize,
      dependencies: [store, ledger, secrets],
    });
    return Object.freeze({
      host: bindHost(env.DEVILUDO_GITHUB_AUTH_HOST),
      port: port(env.DEVILUDO_GITHUB_AUTH_PORT),
      pool,
      store,
      ledger,
      secrets,
      verifier,
      broker,
      server,
    });
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runGitHubAuthorizationService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await githubAuthorizationRuntimeFromEnv(env);
  try {
    await Promise.all([runtime.store.probe(), runtime.ledger.probe(), runtime.secrets.probe()]);
    await runtime.server.listen({ host: runtime.host, port: runtime.port });
    console.log(`[github-authorization] READY ${runtime.host}:${runtime.port}`);
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try { await new Promise<void>((resolveAbort) => shutdown.signal.addEventListener("abort", () => resolveAbort(), { once: true })); }
    finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    await runtime.server.close().catch(() => undefined);
    await runtime.pool.close();
    console.log("[github-authorization] STOPPED");
  }
}

export function registerGitHubAuthorizationHealthRoute(server: FastifyInstance, options: Readonly<{
  authorize(request: FastifyRequest): void | Promise<void>;
  dependencies: readonly Readonly<{ probe(): Promise<void> }>[];
}>): void {
  if (!options.dependencies.length) throw new Error("GitHub authorization readiness dependencies are required");
  server.get("/healthz", async (request, reply) => {
    reply.header("cache-control", "no-store"); reply.header("x-content-type-options", "nosniff");
    try { await options.authorize(request); }
    catch { return reply.status(401).send({ error: { code: "WORKLOAD_IDENTITY_REQUIRED" } }); }
    try {
      await Promise.all(options.dependencies.map(async (dependency) => dependency.probe()));
      return reply.send({ status: "ok", service: "deviludo-github-authorization-broker" });
    } catch {
      return reply.status(503).send({ status: "unavailable", service: "deviludo-github-authorization-broker" });
    }
  });
}

async function secretFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || path.includes("\0")) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_SECRET_BYTES) throw new Error(`${name} file is invalid`);
    return await file.readFile();
  } finally { await file.close(); }
}

function strictRedirectUri(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.port
    || url.search || url.hash || url.pathname !== "/api/connections/github/callback") {
    throw new Error("Production GitHub App redirect URI is invalid");
  }
  return url.href;
}

function spiffeSet(value: string): ReadonlySet<string> {
  const items = value.split(",").map((item) => item.trim());
  if (!items.length || items.some((item) => !item) || new Set(items).size !== items.length) throw new Error("GitHub authorization SPIFFE allow-list is invalid");
  for (const item of items) {
    const url = new URL(item);
    if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash || url.toString() !== item) {
      throw new Error("GitHub authorization SPIFFE identity is invalid");
    }
  }
  return new Set(items);
}

function bindHost(value: string | undefined): string { const result = value ?? "0.0.0.0"; if (result !== "0.0.0.0" && result !== "::") throw new Error("GitHub authorization bind host is invalid"); return result; }
function port(value: string | undefined): number { return milliseconds(value, 4558, 1024, 65535); }
function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number { return milliseconds(value, fallback, minimum, maximum); }
function milliseconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum || String(result) !== value) throw new Error("GitHub authorization numeric configuration is invalid");
  return result;
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runGitHubAuthorizationService();
