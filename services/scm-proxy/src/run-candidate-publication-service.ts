import { createPublicKey, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Server as HttpsServer } from "node:https";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { AuthoritativeCandidatePublicationService } from "./candidate-publication-service";
import { createCandidatePublicationHandler, createCandidatePublicationHttpsServer } from "./candidate-publication-http";
import { MtlsGitHubAppJwtSigner } from "./github-app-signer-client";
import { GitHubAppScmProxy } from "./github-proxy";
import { GitHubAppInstallationTokenBroker, GitHubRestConnector } from "./github-rest";
import { PostgresCandidatePublicationStore } from "./postgres-candidate-publication";
import { PostgresScmOperationStore } from "./postgres-operation-store";

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+){0,5}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

export async function candidatePublicationServiceFromEnv(env: Readonly<Record<string, string | undefined>> = process.env) {
  const serviceEnv = Object.freeze({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "scm-candidate-broker" });
  const config = await configFromEnv(serviceEnv); const pool = postgresWorkflowPoolFromEnv(serviceEnv);
  try {
    const signer = new MtlsGitHubAppJwtSigner({ endpoint: config.signerUrl, keyId: config.signerKeyId,
      tls: config.signerTls, timeoutMs: config.githubTimeoutMs });
    const tokens = new GitHubAppInstallationTokenBroker({ appId: config.githubAppId, signer,
      timeoutMs: config.githubTimeoutMs, permissionMode: "scm-write" });
    const connector = new GitHubRestConnector({ tokens, timeoutMs: config.githubTimeoutMs });
    const operations = new PostgresScmOperationStore(pool);
    const authority = new PostgresCandidatePublicationStore(pool);
    const github = new GitHubAppScmProxy({ connector, store: operations,
      evidenceGate: { async verify() { return false; } },
      artifactAttestationKeys: new Map([[config.artifactKeyId, config.artifactKey]]),
      acceptanceKeys: new Map([[config.acceptanceKeyId, config.acceptanceKey]]) });
    const service = new AuthoritativeCandidatePublicationService(authority, github, authority, () => new Date(), [operations]);
    const handler = createCandidatePublicationHandler({ service, allowedSpiffeIds: config.allowedSpiffeIds,
      healthIdentity: { version: config.version, binaryDigest: config.binaryDigest } });
    const server = createCandidatePublicationHttpsServer({ tls: { key: config.serverKey, cert: config.serverCertificate,
      ca: config.clientCa }, handler, maxBodyBytes: config.maxBodyBytes, requestTimeoutMs: config.requestTimeoutMs });
    return Object.freeze({ ...config, pool, signer, tokens, connector, operations, authority, github, service, server });
  } catch (error) { await pool.close().catch(() => undefined); throw error; }
}

export async function runCandidatePublicationService(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const runtime = await candidatePublicationServiceFromEnv(env);
  try {
    await runtime.service.probe(); await runtime.operations.probe(); await listen(runtime.server, runtime.port, runtime.host); diagnostic("READY");
    const shutdown = new AbortController(); const stop = () => shutdown.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { await Promise.race([waitForAbort(shutdown.signal), waitForFailure(runtime.server)]); }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } finally { if (runtime.server.listening) await close(runtime.server); await runtime.pool.close(); diagnostic("STOPPED"); }
}

async function configFromEnv(env: Readonly<Record<string, string | undefined>>) {
  const [serverKey, serverCertificate, clientCa, signerKey, signerCertificate, signerCa,
    artifactKey, acceptanceKey] = await Promise.all([
      bytes(env, "DEVILUDO_SCM_CANDIDATE_SERVER_TLS_KEY_FILE"), bytes(env, "DEVILUDO_SCM_CANDIDATE_SERVER_TLS_CERT_FILE"),
      bytes(env, "DEVILUDO_SCM_CANDIDATE_SERVER_CLIENT_CA_FILE"), bytes(env, "DEVILUDO_GITHUB_APP_SIGNER_TLS_KEY_FILE"),
      bytes(env, "DEVILUDO_GITHUB_APP_SIGNER_TLS_CERT_FILE"), bytes(env, "DEVILUDO_GITHUB_APP_SIGNER_CA_FILE"),
      publicKey(env, "DEVILUDO_GITHUB_CANDIDATE_ATTESTATION_PUBLIC_KEY_FILE"),
      publicKey(env, "DEVILUDO_GITHUB_ACCEPTANCE_PUBLIC_KEY_FILE"),
    ]);
  const version = required(env, "DEVILUDO_SCM_CANDIDATE_SERVER_VERSION");
  const binaryDigest = required(env, "DEVILUDO_SCM_CANDIDATE_SERVER_BINARY_DIGEST");
  const artifactKeyId = safeId(required(env, "DEVILUDO_GITHUB_CANDIDATE_ATTESTATION_KEY_ID"));
  const acceptanceKeyId = safeId(required(env, "DEVILUDO_GITHUB_ACCEPTANCE_KEY_ID"));
  if (!VERSION.test(version) || /latest|stable|default/i.test(version) || !SHA256.test(binaryDigest)) throw new Error("SCM candidate binary identity is invalid");
  return Object.freeze({ host: bindHost(env.DEVILUDO_SCM_CANDIDATE_SERVER_HOST),
    port: integer(env.DEVILUDO_SCM_CANDIDATE_SERVER_PORT, 4_545, 1_024, 65_535),
    maxBodyBytes: integer(env.DEVILUDO_SCM_CANDIDATE_SERVER_MAX_BODY_BYTES, 140 * 1024 * 1024, 1024 * 1024, 140 * 1024 * 1024),
    requestTimeoutMs: integer(env.DEVILUDO_SCM_CANDIDATE_SERVER_REQUEST_TIMEOUT_MS, 10 * 60_000, 1_000, 15 * 60_000),
    githubTimeoutMs: integer(env.DEVILUDO_GITHUB_API_TIMEOUT_MS, 30_000, 1_000, 60_000),
    githubAppId: numericId(required(env, "DEVILUDO_GITHUB_APP_ID")),
    signerUrl: strictOrigin(required(env, "DEVILUDO_GITHUB_APP_SIGNER_URL")),
    signerKeyId: safeId(required(env, "DEVILUDO_GITHUB_APP_SIGNER_KEY_ID")),
    signerTls: Object.freeze({ key: signerKey, certificate: signerCertificate, ca: signerCa }),
    artifactKeyId, artifactKey, acceptanceKeyId, acceptanceKey, version, binaryDigest,
    allowedSpiffeIds: spiffeIds(required(env, "DEVILUDO_SCM_CANDIDATE_SERVER_ALLOWED_SPIFFE_IDS")),
    serverKey, serverCertificate, clientCa });
}

async function bytes(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const file = await openPath(env, name); try { const stat = await file.stat(); if (!stat.isFile() || stat.size < 32 || stat.size > 1024 * 1024) throw new Error(`${name} is invalid`); return await file.readFile(); }
  finally { await file.close(); }
}
async function publicKey(env: Readonly<Record<string, string | undefined>>, name: string): Promise<KeyObject> {
  const key = createPublicKey(await bytes(env, name)); if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error(`${name} is invalid`); return key;
}
async function openPath(env: Readonly<Record<string, string | undefined>>, name: string) { const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0") || path.length > 4_096) throw new Error(`${name} path is invalid`);
  return open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
function strictOrigin(value: string): string { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
  || url.pathname !== "/") throw new Error("GitHub App signer origin is invalid"); return url.toString(); }
function numericId(value: string): string { if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new Error("GitHub App ID is invalid"); return value; }
function safeId(value: string): string { if (!SAFE_ID.test(value)) throw new Error("key ID is invalid"); return value; }
function spiffeIds(value: string): ReadonlySet<string> { let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error("SPIFFE list is invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32 || parsed.some((item) => typeof item !== "string" || !item.startsWith("spiffe://"))
    || new Set(parsed).size !== parsed.length || JSON.stringify([...parsed].sort()) !== JSON.stringify(parsed)) throw new Error("SPIFFE list is invalid"); return new Set(parsed as string[]); }
function bindHost(value: string | undefined): string { const selected = value?.trim() || "0.0.0.0"; if (selected !== "0.0.0.0" && selected !== "::") throw new Error("bind host is invalid"); return selected; }
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function integer(value: string | undefined, fallback: number, min: number, max: number): number { if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < min || parsed > max) throw new Error("integer is invalid"); return parsed; }
function listen(server: HttpsServer, port: number, host: string): Promise<void> { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); }); }
function close(server: HttpsServer): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function waitForAbort(signal: AbortSignal): Promise<void> { return signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); }
function waitForFailure(server: HttpsServer): Promise<never> { return new Promise((_, reject) => server.once("error", reject)); }
function diagnostic(event: "READY" | "STOPPED" | "FAILED"): void { process.stderr.write(`${JSON.stringify({ service: "deviludo-scm-candidate-broker", event })}\n`); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runCandidatePublicationService().catch(() => { diagnostic("FAILED"); process.exitCode = 1; });
