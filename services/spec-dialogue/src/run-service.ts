import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { createSpecDialogueHandler, createSpecDialogueHttpsServer } from "./ingress-http";
import { MtlsSpecDialogueModel } from "./model-broker";
import { PostgresSpecDialogueStore } from "./postgres-store";
import { SpecDialogueService } from "./service";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function specDialogueRuntimeFromEnv(env: Readonly<Record<string, string | undefined>> = process.env) {
  const [serverKey, serverCertificate, clientCa, brokerKey, brokerCertificate, brokerCa] = await Promise.all([
    secret(env, "DEVILUDO_SPEC_DIALOGUE_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_SPEC_DIALOGUE_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_SPEC_DIALOGUE_CLIENT_CA_FILE"),
    secret(env, "DEVILUDO_SPEC_MODEL_BROKER_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_SPEC_MODEL_BROKER_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_SPEC_MODEL_BROKER_CA_FILE"),
  ]);
  const allowedSpiffeIds = spiffeSet(required(env, "DEVILUDO_SPEC_DIALOGUE_WEB_SPIFFE_IDS"));
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "spec-dialogue" });
  try {
    const store = new PostgresSpecDialogueStore(pool);
    const model = new MtlsSpecDialogueModel({
      endpoint: required(env, "DEVILUDO_SPEC_MODEL_BROKER_URL"),
      tls: { key: brokerKey, certificate: brokerCertificate, ca: brokerCa },
      timeoutMs: seconds(env.DEVILUDO_SPEC_MODEL_BROKER_TIMEOUT_SECONDS, 30, 1, 120) * 1_000,
    });
    const service = new SpecDialogueService(store, model);
    const handler = createSpecDialogueHandler({ service, allowedSpiffeIds });
    const server = createSpecDialogueHttpsServer({ tls: { key: serverKey, cert: serverCertificate, ca: clientCa }, handler });
    return Object.freeze({ host: host(env.DEVILUDO_SPEC_DIALOGUE_HOST), port: port(env.DEVILUDO_SPEC_DIALOGUE_PORT), pool, service, server });
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runSpecDialogueService(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const runtime = await specDialogueRuntimeFromEnv(env);
  try {
    await runtime.pool.probe();
    await runtime.service.probe();
    await new Promise<void>((resolveListen, reject) => {
      const fail = (error: Error) => reject(error);
      runtime.server.once("error", fail);
      runtime.server.listen(runtime.port, runtime.host, () => { runtime.server.off("error", fail); resolveListen(); });
    });
    console.log(`[spec-dialogue] READY ${runtime.host}:${runtime.port}`);
    const close = () => runtime.server.close();
    process.once("SIGINT", close); process.once("SIGTERM", close);
    await new Promise<void>((resolveClose, reject) => { runtime.server.once("close", resolveClose); runtime.server.once("error", reject); });
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
  if (!result.size) throw new Error("Specification dialogue SPIFFE allow-list is empty");
  for (const item of result) { const url = new URL(item); if (url.protocol !== "spiffe:" || !url.hostname || url.toString() !== item) throw new Error("Specification dialogue SPIFFE identity is invalid"); }
  return result;
}
function host(value: string | undefined): string { const result = value ?? "0.0.0.0"; if (result !== "0.0.0.0" && result !== "::") throw new Error("Specification dialogue host is invalid"); return result; }
function port(value: string | undefined): number { const result = value === undefined ? 4544 : Number(value); if (!Number.isInteger(result) || result < 1_024 || result > 65_535 || (value !== undefined && String(result) !== value)) throw new Error("Specification dialogue port is invalid"); return result; }
function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number { if (value === undefined) return fallback; const result = Number(value); if (!Number.isInteger(result) || result < minimum || result > maximum || String(result) !== value) throw new Error("Specification dialogue timeout is invalid"); return result; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runSpecDialogueService();
