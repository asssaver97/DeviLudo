import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Server as HttpsServer } from "node:https";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { PostgresSteamWorkflowOperationDispatch } from "./postgres-workflow-dispatch";
import { PostgresSteamWorkflowOperationPersistence } from "./postgres-workflow-operations";
import {
  createSteamWorkflowBrokerHandler,
  createSteamWorkflowBrokerHttpsServer,
} from "./workflow-broker-http";
import { DurableSteamWorkflowOperationService } from "./workflow-broker-operations";

const MAX_SECRET_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/;

/** Credential-free mTLS Broker composition. Steam execution runs elsewhere. */
export async function steamWorkflowBrokerServiceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const serviceEnv = Object.freeze({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "steam-workflow-broker" });
  const config = await steamWorkflowBrokerServiceConfigFromEnv(serviceEnv);
  const pool = postgresWorkflowPoolFromEnv(serviceEnv);
  try {
    const operations = new PostgresSteamWorkflowOperationPersistence(pool);
    const dispatch = new PostgresSteamWorkflowOperationDispatch(pool);
    const service = new DurableSteamWorkflowOperationService(operations, dispatch);
    const handler = createSteamWorkflowBrokerHandler({
      service,
      allowedSpiffeIds: config.allowedSpiffeIds,
      healthIdentity: { version: config.version, binaryDigest: config.binaryDigest },
    });
    const server = createSteamWorkflowBrokerHttpsServer({
      tls: { key: config.tlsKey, cert: config.tlsCertificate, ca: config.clientCa },
      handler,
      maxBodyBytes: config.maxBodyBytes,
      requestTimeoutMs: config.requestTimeoutMs,
    });
    return Object.freeze({ ...config, pool, operations, dispatch, service, server });
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function steamWorkflowBrokerServiceConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const [tlsKey, tlsCertificate, clientCa] = await Promise.all([
    secret(env, "DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_CLIENT_CA_FILE"),
  ]);
  const selectedVersion = required(env, "DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_VERSION");
  const binaryDigest = required(env, "DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_BINARY_DIGEST");
  if (!VERSION.test(selectedVersion) || /(?:latest|stable|default)/i.test(selectedVersion)) {
    throw new Error("Steam workflow Broker server version is invalid");
  }
  if (!SHA256.test(binaryDigest)) throw new Error("Steam workflow Broker server binary digest is invalid");
  return Object.freeze({
    host: bindHost(env.DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_HOST),
    port: integer(env.DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_PORT, 4_745, 1_024, 65_535),
    maxBodyBytes: integer(env.DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_MAX_BODY_BYTES, 512 * 1024, 32 * 1024, 512 * 1024),
    requestTimeoutMs: integer(env.DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_REQUEST_TIMEOUT_MS, 30_000, 1_000, 10 * 60_000),
    version: selectedVersion,
    binaryDigest,
    allowedSpiffeIds: spiffeIds(required(env, "DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_ALLOWED_SPIFFE_IDS")),
    tlsKey,
    tlsCertificate,
    clientCa,
  });
}

export async function runSteamWorkflowBrokerService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await steamWorkflowBrokerServiceFromEnv(env);
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
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_SECRET_BYTES) {
      throw new Error(`${name} file is invalid`);
    }
    return await file.readFile();
  } finally { await file.close(); }
}

function spiffeIds(value: string): ReadonlySet<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("Steam workflow Broker SPIFFE allow-list is invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32 || new Set(parsed).size !== parsed.length) {
    throw new Error("Steam workflow Broker SPIFFE allow-list is invalid");
  }
  const values = parsed.map((item) => {
    if (typeof item !== "string") throw new Error("Steam workflow Broker SPIFFE allow-list is invalid");
    const url = new URL(item);
    if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash
      || url.pathname === "/" || url.toString() !== item) {
      throw new Error("Steam workflow Broker SPIFFE allow-list is invalid");
    }
    return item;
  });
  if (JSON.stringify([...values].sort()) !== JSON.stringify(values)) {
    throw new Error("Steam workflow Broker SPIFFE allow-list must be sorted");
  }
  return new Set(values);
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

function bindHost(value: string | undefined): string {
  const selected = value?.trim() || "0.0.0.0";
  if (selected !== "0.0.0.0" && selected !== "::") throw new Error("Steam workflow Broker host is invalid");
  return selected;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Steam workflow Broker integer is invalid");
  }
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
  process.stderr.write(`${JSON.stringify({ service: "deviludo-steam-workflow-broker", event })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runSteamWorkflowBrokerService().catch(() => {
    diagnostic("FAILED");
    process.exitCode = 1;
  });
}
