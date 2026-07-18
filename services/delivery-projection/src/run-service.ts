import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { createDeliveryProjectionHandler, createDeliveryProjectionHttpsServer } from "./http";
import { PostgresDeliveryProjectionStore } from "./store";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function deliveryProjectionRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const [key, certificate, clientCa] = await Promise.all([
    secret(env, "DEVILUDO_DELIVERY_PROJECTION_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_DELIVERY_PROJECTION_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_DELIVERY_PROJECTION_CLIENT_CA_FILE"),
  ]);
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "delivery-projection" });
  try {
    const store = new PostgresDeliveryProjectionStore(pool);
    const handler = createDeliveryProjectionHandler({
      store,
      writerSpiffeIds: spiffeSet(required(env, "DEVILUDO_DELIVERY_PROJECTION_TEMPORAL_SPIFFE_IDS")),
      readerSpiffeIds: spiffeSet(required(env, "DEVILUDO_DELIVERY_PROJECTION_WEB_SPIFFE_IDS")),
    });
    const server = createDeliveryProjectionHttpsServer({ tls: { key, cert: certificate, ca: clientCa }, handler });
    return Object.freeze({ host: host(env.DEVILUDO_DELIVERY_PROJECTION_HOST), port: port(env.DEVILUDO_DELIVERY_PROJECTION_PORT), pool, store, server });
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runDeliveryProjectionService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await deliveryProjectionRuntimeFromEnv(env);
  try {
    await Promise.all([runtime.pool.probe(), runtime.store.probe()]);
    await new Promise<void>((ready, reject) => {
      const fail = (error: Error) => reject(error);
      runtime.server.once("error", fail);
      runtime.server.listen(runtime.port, runtime.host, () => { runtime.server.off("error", fail); ready(); });
    });
    console.log(`[delivery-projection] READY ${runtime.host}:${runtime.port}`);
    const close = () => runtime.server.close();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    await new Promise<void>((closed, reject) => {
      runtime.server.once("close", closed);
      runtime.server.once("error", reject);
    });
  } finally { await runtime.pool.close(); }
}

async function secret(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_SECRET_BYTES) throw new Error(`${name} file is invalid`);
    return await file.readFile();
  } finally { await file.close(); }
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function spiffeSet(value: string): ReadonlySet<string> {
  const result = new Set(value.split(",").map((item) => item.trim()));
  if (!result.size) throw new Error("Delivery projection SPIFFE allow-list is empty");
  for (const item of result) {
    const url = new URL(item);
    if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash || url.toString() !== item) {
      throw new Error("Delivery projection SPIFFE identity is invalid");
    }
  }
  return result;
}
function host(value: string | undefined): string { const result = value ?? "0.0.0.0"; if (result !== "0.0.0.0" && result !== "::") throw new Error("Delivery projection host is invalid"); return result; }
function port(value: string | undefined): number { const result = value === undefined ? 4557 : Number(value); if (!Number.isInteger(result) || result < 1024 || result > 65535 || (value !== undefined && String(result) !== value)) throw new Error("Delivery projection port is invalid"); return result; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runDeliveryProjectionService();
