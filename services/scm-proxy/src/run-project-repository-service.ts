import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyRequest } from "fastify";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { workflowSpiffeIdFromAuthorizedTls } from "../../temporal/src/receiver-http";
import { MtlsGitHubAppJwtSigner } from "./github-app-signer-client";
import { GitHubAppRepositoryCatalog } from "./github-repository-catalog";
import { registerProjectRepositoryRoutes } from "./project-repository-http";
import { PostgresProjectRepositoryOnboardingStore } from "./project-repository-postgres";
import { ProjectRepositoryOnboardingService } from "./project-repository-service";

export async function projectRepositoryRuntimeFromEnv(env: Readonly<Record<string, string | undefined>> = process.env) {
  const [serverKey, serverCertificate, clientCa, signerKey, signerCertificate, signerCa] = await Promise.all([
    secret(env, "DEVILUDO_PROJECT_REPOSITORY_TLS_KEY_FILE"), secret(env, "DEVILUDO_PROJECT_REPOSITORY_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_PROJECT_REPOSITORY_CLIENT_CA_FILE"), secret(env, "DEVILUDO_GITHUB_APP_SIGNER_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_GITHUB_APP_SIGNER_TLS_CERT_FILE"), secret(env, "DEVILUDO_GITHUB_APP_SIGNER_CA_FILE"),
  ]);
  const allowedSpiffeIds = spiffeSet(required(env, "DEVILUDO_PROJECT_REPOSITORY_WEB_SPIFFE_IDS"));
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "project-repository" });
  try {
    const signer = new MtlsGitHubAppJwtSigner({
      endpoint: required(env, "DEVILUDO_GITHUB_APP_SIGNER_URL"),
      keyId: required(env, "DEVILUDO_GITHUB_APP_SIGNER_KEY_ID"),
      tls: { key: signerKey, certificate: signerCertificate, ca: signerCa },
      timeoutMs: milliseconds(env.DEVILUDO_GITHUB_API_TIMEOUT_MS, 15_000, 1_000, 60_000),
    });
    const github = new GitHubAppRepositoryCatalog({
      appId: required(env, "DEVILUDO_GITHUB_APP_ID"), signer,
      timeoutMs: milliseconds(env.DEVILUDO_GITHUB_API_TIMEOUT_MS, 15_000, 1_000, 60_000),
    });
    const store = new PostgresProjectRepositoryOnboardingStore(pool);
    const service = new ProjectRepositoryOnboardingService(store, github);
    const authorize = (request: FastifyRequest) => {
      if (!allowedSpiffeIds.has(workflowSpiffeIdFromAuthorizedTls(request))) throw new Error("Project repository workload is not allowed");
    };
    const server = Fastify({
      logger: false, bodyLimit: 32 * 1024,
      requestTimeout: milliseconds(env.DEVILUDO_PROJECT_REPOSITORY_REQUEST_TIMEOUT_MS, 30_000, 1_000, 60_000),
      https: { key: serverKey, cert: serverCertificate, ca: clientCa, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" },
    });
    registerProjectRepositoryRoutes(server, { service, authorize });
    server.get("/healthz", async (request, reply) => {
      reply.header("cache-control", "no-store");
      try { authorize(request); } catch { return reply.status(401).send({ error: { code: "WORKLOAD_IDENTITY_REQUIRED" } }); }
      return reply.send({ status: "ok", service: "deviludo-project-repository-broker" });
    });
    return Object.freeze({ host: host(env.DEVILUDO_PROJECT_REPOSITORY_HOST), port: port(env.DEVILUDO_PROJECT_REPOSITORY_PORT), pool, store, service, server });
  } catch (error) { await pool.close().catch(() => undefined); throw error; }
}

export async function runProjectRepositoryService(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const runtime = await projectRepositoryRuntimeFromEnv(env);
  try {
    await Promise.all([runtime.pool.probe(), runtime.store.probe()]);
    await runtime.server.listen({ host: runtime.host, port: runtime.port });
    console.log(`[project-repository] READY ${runtime.host}:${runtime.port}`);
    const shutdown = new AbortController(); const stop = () => shutdown.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { await new Promise<void>((done) => shutdown.signal.addEventListener("abort", () => done(), { once: true })); }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } finally { await runtime.server.close().catch(() => undefined); await runtime.pool.close(); console.log("[project-repository] STOPPED"); }
}

async function secret(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || path.includes("\0")) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const metadata = await file.stat(); if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) throw new Error(`${name} file is invalid`); return await file.readFile(); }
  finally { await file.close(); }
}
function spiffeSet(value: string): ReadonlySet<string> { const items = value.split(",").map((item) => item.trim()); if (!items.length || items.some((item) => !item) || new Set(items).size !== items.length) throw new Error("Project repository SPIFFE allow-list is invalid"); for (const item of items) { const url = new URL(item); if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash || url.toString() !== item) throw new Error("Project repository SPIFFE identity is invalid"); } return new Set(items); }
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function host(value: string | undefined): string { const result = value ?? "0.0.0.0"; if (result !== "0.0.0.0" && result !== "::") throw new Error("Project repository host is invalid"); return result; }
function port(value: string | undefined): number { return milliseconds(value, 4559, 1024, 65535); }
function milliseconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number { if (value === undefined) return fallback; const result = Number(value); if (!Number.isSafeInteger(result) || String(result) !== value || result < minimum || result > maximum) throw new Error("Project repository numeric configuration is invalid"); return result; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runProjectRepositoryService();
