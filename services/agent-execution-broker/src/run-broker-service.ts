import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Server as HttpsServer } from "node:https";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { createAgentExecutionBrokerHandler, createAgentExecutionBrokerHttpsServer } from "./ingress-http";
import { DurableAgentExecutionService } from "./operations";
import { PostgresAgentExecutionDispatch } from "./postgres-dispatch";
import { PostgresAgentExecutionOperations } from "./postgres-operations";

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+){0,5}$/;

/** Credential-free public Broker; autonomous CLI execution remains in the isolated Worker service. */
export async function agentExecutionBrokerServiceFromEnv(env: Readonly<Record<string, string | undefined>> = process.env) {
  const serviceEnv = Object.freeze({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "agent-execution-broker" });
  const config = await configFromEnv(serviceEnv); const pool = postgresWorkflowPoolFromEnv(serviceEnv);
  try {
    const operations = new PostgresAgentExecutionOperations(pool); const dispatch = new PostgresAgentExecutionDispatch(pool);
    const service = new DurableAgentExecutionService(operations, dispatch);
    const handler = createAgentExecutionBrokerHandler({ service, allowedSpiffeIds: config.allowedSpiffeIds,
      healthIdentity: { version: config.version, binaryDigest: config.binaryDigest } });
    const server = createAgentExecutionBrokerHttpsServer({ tls: { key: config.tlsKey, cert: config.tlsCertificate, ca: config.clientCa },
      handler, maxBodyBytes: config.maxBodyBytes, requestTimeoutMs: config.requestTimeoutMs });
    return Object.freeze({ ...config, pool, operations, dispatch, service, server });
  } catch (error) { await pool.close().catch(() => undefined); throw error; }
}

export async function runAgentExecutionBrokerService(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const runtime = await agentExecutionBrokerServiceFromEnv(env);
  try {
    await runtime.service.probe(); await listen(runtime.server, runtime.port, runtime.host); diagnostic("READY");
    const shutdown = new AbortController(); const stop = () => shutdown.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { await Promise.race([waitForAbort(shutdown.signal), waitForFailure(runtime.server)]); }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } finally { if (runtime.server.listening) await close(runtime.server); await runtime.pool.close(); diagnostic("STOPPED"); }
}

async function configFromEnv(env: Readonly<Record<string, string | undefined>>) {
  const [tlsKey, tlsCertificate, clientCa] = await Promise.all([secret(env, "DEVILUDO_AGENT_EXECUTION_BROKER_SERVER_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_AGENT_EXECUTION_BROKER_SERVER_TLS_CERT_FILE"), secret(env, "DEVILUDO_AGENT_EXECUTION_BROKER_SERVER_CLIENT_CA_FILE")]);
  const version = required(env, "DEVILUDO_AGENT_EXECUTION_BROKER_SERVER_VERSION");
  const binaryDigest = required(env, "DEVILUDO_AGENT_EXECUTION_BROKER_SERVER_BINARY_DIGEST");
  if (!VERSION.test(version) || /latest|stable|default/i.test(version) || !SHA256.test(binaryDigest)) throw new Error("Agent execution Broker binary identity is invalid");
  return Object.freeze({ host: bindHost(env.DEVILUDO_AGENT_EXECUTION_BROKER_SERVER_HOST), port: integer(env.DEVILUDO_AGENT_EXECUTION_BROKER_SERVER_PORT, 4_746, 1_024, 65_535),
    maxBodyBytes: integer(env.DEVILUDO_AGENT_EXECUTION_BROKER_SERVER_MAX_BODY_BYTES, 512 * 1024, 32 * 1024, 512 * 1024),
    requestTimeoutMs: integer(env.DEVILUDO_AGENT_EXECUTION_BROKER_SERVER_REQUEST_TIMEOUT_MS, 30_000, 1_000, 600_000),
    version, binaryDigest, allowedSpiffeIds: spiffeIds(required(env, "DEVILUDO_AGENT_EXECUTION_BROKER_SERVER_ALLOWED_SPIFFE_IDS")),
    tlsKey, tlsCertificate, clientCa });
}

async function secret(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = required(env, name); if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size < 32 || stat.size > 1024 * 1024) throw new Error(`${name} is invalid`); return await file.readFile(); }
  finally { await file.close(); }
}
function spiffeIds(value: string): ReadonlySet<string> { let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error("SPIFFE allow-list is invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.some((item) => typeof item !== "string" || !item.startsWith("spiffe://"))
    || new Set(parsed).size !== parsed.length || JSON.stringify([...parsed].sort()) !== JSON.stringify(parsed)) throw new Error("SPIFFE allow-list is invalid");
  return new Set(parsed as string[]); }
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function bindHost(value: string | undefined): string { const selected = value?.trim() || "0.0.0.0"; if (selected !== "0.0.0.0" && selected !== "::") throw new Error("bind host is invalid"); return selected; }
function integer(value: string | undefined, fallback: number, min: number, max: number): number { if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < min || parsed > max) throw new Error("integer is invalid"); return parsed; }
function listen(server: HttpsServer, port: number, host: string): Promise<void> { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); }); }
function close(server: HttpsServer): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function waitForAbort(signal: AbortSignal): Promise<void> { return signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); }
function waitForFailure(server: HttpsServer): Promise<never> { return new Promise((_, reject) => server.once("error", reject)); }
function diagnostic(event: "READY" | "STOPPED" | "FAILED"): void { process.stderr.write(`${JSON.stringify({ service: "deviludo-agent-execution-broker", event })}\n`); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runAgentExecutionBrokerService().catch(() => { diagnostic("FAILED"); process.exitCode = 1; });
