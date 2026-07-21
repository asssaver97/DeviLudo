import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Server as HttpsServer } from "node:https";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { runnerFleetPolicyFromEnv } from "./fleet-manifest";
import {
  createRunnerToolchainPublicationHandler,
  createRunnerToolchainPublicationHttpsServer,
} from "./toolchain-publication-http";
import { PostgresRunnerToolchainPublisher } from "./toolchain-publication";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function runnerToolchainPublicationRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const serviceEnv = Object.freeze({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "runner-toolchain" });
  const config = await runnerToolchainPublicationConfigFromEnv(serviceEnv);
  const pool = postgresWorkflowPoolFromEnv(serviceEnv);
  try {
    const fleet = runnerFleetPolicyFromEnv(serviceEnv);
    const publisher = new PostgresRunnerToolchainPublisher(pool, fleet);
    const handler = createRunnerToolchainPublicationHandler({
      publisher,
      allowedSpiffeIds: config.allowedSpiffeIds,
      readiness: async () => {
        await Promise.all([pool.probe(), fleet.probe(), publisher.probe()]);
      },
    });
    const server = createRunnerToolchainPublicationHttpsServer({
      tls: { key: config.tlsKey, cert: config.tlsCertificate, ca: config.clientCa },
      handler,
      maxBodyBytes: config.maxBodyBytes,
    });
    return Object.freeze({ ...config, pool, fleet, publisher, handler, server });
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runnerToolchainPublicationConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (env.NODE_ENV !== "production") throw new Error("Runner toolchain publisher requires NODE_ENV=production");
  const [tlsKey, tlsCertificate, clientCa] = await Promise.all([
    secret(env, "DEVILUDO_RUNNER_TOOLCHAIN_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_RUNNER_TOOLCHAIN_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_RUNNER_TOOLCHAIN_CLIENT_CA_FILE"),
  ]);
  return Object.freeze({
    host: bindHost(env.DEVILUDO_RUNNER_TOOLCHAIN_HOST),
    port: integer(env.DEVILUDO_RUNNER_TOOLCHAIN_PORT, 4_865, 1_024, 65_535),
    maxBodyBytes: integer(env.DEVILUDO_RUNNER_TOOLCHAIN_MAX_BODY_BYTES, 64 * 1024, 4 * 1024, 64 * 1024),
    allowedSpiffeIds: spiffeIds(required(env, "DEVILUDO_RUNNER_TOOLCHAIN_ALLOWED_SPIFFE_IDS")),
    tlsKey,
    tlsCertificate,
    clientCa,
  });
}

export async function runRunnerToolchainPublicationService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await runnerToolchainPublicationRuntimeFromEnv(env);
  try {
    await Promise.all([runtime.pool.probe(), runtime.fleet.probe(), runtime.publisher.probe()]);
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
  try { parsed = JSON.parse(value) as unknown; }
  catch { throw new Error("Runner toolchain publisher SPIFFE allow-list is invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8 || new Set(parsed).size !== parsed.length) {
    throw new Error("Runner toolchain publisher SPIFFE allow-list is invalid");
  }
  const values = parsed.map((item) => {
    if (typeof item !== "string") throw new Error("Runner toolchain publisher SPIFFE allow-list is invalid");
    const url = new URL(item);
    if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash
      || url.pathname === "/" || url.toString() !== item) {
      throw new Error("Runner toolchain publisher SPIFFE allow-list is invalid");
    }
    return item;
  });
  if (JSON.stringify([...values].sort()) !== JSON.stringify(values)) {
    throw new Error("Runner toolchain publisher SPIFFE allow-list must be sorted");
  }
  return new Set(values);
}
function bindHost(value: string | undefined): string {
  const selected = value?.trim() || "0.0.0.0";
  if (selected !== "0.0.0.0" && selected !== "::") throw new Error("Runner toolchain publisher bind host is invalid");
  return selected;
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
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Runner toolchain publisher integer is invalid");
  }
  return parsed;
}
function listen(server: HttpsServer, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const failure = (error: Error) => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failure); resolvePromise(); };
    server.once("error", failure);
    server.once("listening", ready);
    server.listen(port, host);
  });
}
function close(server: HttpsServer): Promise<void> {
  return new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => signal.addEventListener("abort", () => resolvePromise(), { once: true }));
}
function waitForServerFailure(server: HttpsServer): Promise<never> {
  return new Promise((_, reject) => server.once("error", reject));
}
function diagnostic(event: "READY" | "STOPPED" | "FAILED"): void {
  process.stderr.write(`${JSON.stringify({ service: "deviludo-runner-toolchain-publisher", event })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runRunnerToolchainPublicationService().catch(() => { diagnostic("FAILED"); process.exitCode = 1; });
}
