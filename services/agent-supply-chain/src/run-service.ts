import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Server as HttpsServer } from "node:https";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { DurableAgentSupplyChainBrokerService } from "./broker-service";
import { createAgentSupplyChainHandler, createAgentSupplyChainHttpsServer } from "./ingress-http";
import { LockedNativeAgentSupplyChainExecutor } from "./locked-native-executor";
import { PostgresAgentSupplyChainOperations } from "./postgres-operations";

const MAX_SECRET_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export async function agentSupplyChainServiceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const serviceEnv = Object.freeze({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "agent-supply-chain" });
  const config = await agentSupplyChainServiceConfigFromEnv(serviceEnv);
  const pool = postgresWorkflowPoolFromEnv(serviceEnv);
  try {
    const operations = new PostgresAgentSupplyChainOperations(pool);
    const executor = new LockedNativeAgentSupplyChainExecutor({
      executable: config.nativeExecutable,
      executableDigest: config.nativeExecutableDigest,
      configFile: config.nativeConfigFile,
      configDigest: config.nativeConfigDigest,
      workRoot: config.workRoot,
      timeoutMs: config.nativeTimeoutMs,
    });
    const service = new DurableAgentSupplyChainBrokerService(operations, executor, { leaseMs: config.leaseMs });
    const handler = createAgentSupplyChainHandler({
      service,
      allowedSpiffeIds: config.allowedSpiffeIds,
      healthIdentity: { version: config.version, binaryDigest: config.binaryDigest },
    });
    const server = createAgentSupplyChainHttpsServer({
      tls: { key: config.tlsKey, cert: config.tlsCertificate, ca: config.clientCa },
      handler,
      maxBodyBytes: config.maxBodyBytes,
      requestTimeoutMs: config.requestTimeoutMs,
    });
    return Object.freeze({ ...config, pool, operations, executor, service, server });
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function agentSupplyChainServiceConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (env.NODE_ENV !== "production") throw new Error("Agent supply-chain service requires NODE_ENV=production");
  const [tlsKey, tlsCertificate, clientCa] = await Promise.all([
    secret(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_CLIENT_CA_FILE"),
  ]);
  const version = exactVersion(required(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_VERSION"), "server version");
  const binaryDigest = digest(required(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_BINARY_DIGEST"), "server binary digest");
  const nativeTimeoutMs = integer(env.DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_TIMEOUT_MS, 8 * 60_000, 30_000, 9 * 60_000);
  const leaseMs = integer(env.DEVILUDO_AGENT_SUPPLY_CHAIN_LEASE_MS, 10 * 60_000, nativeTimeoutMs + 1_000, 10 * 60_000);
  return Object.freeze({
    host: bindHost(env.DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_HOST),
    port: integer(env.DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_PORT, 4_755, 1_024, 65_535),
    maxBodyBytes: integer(env.DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_MAX_BODY_BYTES, 256 * 1024, 32 * 1024, 256 * 1024),
    requestTimeoutMs: integer(env.DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_REQUEST_TIMEOUT_MS, 10 * 60_000, nativeTimeoutMs, 10 * 60_000),
    version,
    binaryDigest,
    allowedSpiffeIds: spiffeIds(required(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_ALLOWED_SPIFFE_IDS")),
    tlsKey,
    tlsCertificate,
    clientCa,
    nativeExecutable: absolute(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_EXECUTABLE"),
    nativeExecutableDigest: digest(required(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_EXECUTABLE_DIGEST"), "native executable digest"),
    nativeConfigFile: absolute(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_CONFIG_FILE"),
    nativeConfigDigest: digest(required(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_CONFIG_DIGEST"), "native config digest"),
    workRoot: absolute(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_WORK_ROOT"),
    nativeTimeoutMs,
    leaseMs,
  });
}

export async function runAgentSupplyChainService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await agentSupplyChainServiceFromEnv(env);
  try {
    await runtime.service.probe();
    await listen(runtime.server, runtime.port, runtime.host);
    diagnostic("READY");
    const shutdown = new AbortController();
    const requestShutdown = () => shutdown.abort();
    process.once("SIGINT", requestShutdown);
    process.once("SIGTERM", requestShutdown);
    try {
      await Promise.race([waitForAbort(shutdown.signal), waitForServerFailure(runtime.server)]);
    } finally {
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
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_SECRET_BYTES) throw new Error(`${name} file is invalid`);
    return await file.readFile();
  } finally { await file.close(); }
}

function spiffeIds(value: string): ReadonlySet<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("Agent supply-chain SPIFFE allow-list is invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16 || new Set(parsed).size !== parsed.length) {
    throw new Error("Agent supply-chain SPIFFE allow-list is invalid");
  }
  const values = parsed.map((item) => {
    if (typeof item !== "string") throw new Error("Agent supply-chain SPIFFE allow-list is invalid");
    const url = new URL(item);
    if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash
      || url.pathname === "/" || url.toString() !== item) throw new Error("Agent supply-chain SPIFFE allow-list is invalid");
    return item;
  });
  if (JSON.stringify([...values].sort()) !== JSON.stringify(values)) throw new Error("Agent supply-chain SPIFFE allow-list must be sorted");
  return new Set(values);
}

function absolute(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4096 || /\0/.test(value)) throw new Error(`${name} path is invalid`);
  return value;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function exactVersion(value: string, label: string): string {
  if (!VERSION.test(value) || /(?:latest|stable|default)/i.test(value)) throw new Error(`Agent supply-chain ${label} is invalid`);
  return value;
}

function digest(value: string, label: string): string {
  if (!SHA256.test(value)) throw new Error(`Agent supply-chain ${label} is invalid`);
  return value;
}

function bindHost(value: string | undefined): string {
  const selected = value?.trim() || "0.0.0.0";
  if (selected !== "0.0.0.0" && selected !== "::") throw new Error("Agent supply-chain bind host is invalid");
  return selected;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) throw new Error("Agent supply-chain integer is invalid");
  return parsed;
}

function listen(server: HttpsServer, port: number, host: string): Promise<void> {
  return new Promise((accept, reject) => {
    const failure = (error: Error) => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failure); accept(); };
    server.once("error", failure);
    server.once("listening", ready);
    server.listen(port, host);
  });
}

function close(server: HttpsServer): Promise<void> { return new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())); }
function waitForAbort(signal: AbortSignal): Promise<void> { if (signal.aborted) return Promise.resolve(); return new Promise((accept) => signal.addEventListener("abort", () => accept(), { once: true })); }
function waitForServerFailure(server: HttpsServer): Promise<never> { return new Promise((_, reject) => server.once("error", reject)); }
function diagnostic(event: "READY" | "STOPPED" | "FAILED"): void { process.stderr.write(`${JSON.stringify({ service: "deviludo-agent-supply-chain", event })}\n`); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runAgentSupplyChainService().catch(() => { diagnostic("FAILED"); process.exitCode = 1; });
}
