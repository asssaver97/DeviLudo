import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PostgresWorkflowActionCompletionStore } from "../../control-plane/src/workflow-action-completion-postgres";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { createSteamApprovalMonitorHandler, createSteamApprovalMonitorHttpsServer } from "./ingress-http";
import { PostgresSteamExternalApprovalStore } from "./postgres-store";
import { SteamExternalApprovalService } from "./service";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function steamApprovalMonitorRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const [key, certificate, clientCa] = await Promise.all([
    secret(env, "DEVILUDO_STEAM_APPROVAL_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_STEAM_APPROVAL_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_STEAM_APPROVAL_CLIENT_CA_FILE"),
  ]);
  const allowedVerifierSpiffeIds = spiffeSet(required(env, "DEVILUDO_STEAM_APPROVAL_VERIFIER_SPIFFE_IDS_JSON"));
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "steam-approval-monitor" });
  try {
    const store = new PostgresSteamExternalApprovalStore(pool, {
      maxObservationAgeMs: seconds(env.DEVILUDO_STEAM_APPROVAL_MAX_AGE_SECONDS, 900, 60, 3600) * 1_000,
      maxFutureSkewMs: seconds(env.DEVILUDO_STEAM_APPROVAL_FUTURE_SKEW_SECONDS, 60, 0, 300) * 1_000,
    });
    const service = new SteamExternalApprovalService(store, new PostgresWorkflowActionCompletionStore(pool));
    const handler = createSteamApprovalMonitorHandler({ service, allowedVerifierSpiffeIds });
    const server = createSteamApprovalMonitorHttpsServer({ tls: { key, cert: certificate, ca: clientCa }, handler });
    return Object.freeze({
      host: host(env.DEVILUDO_STEAM_APPROVAL_HOST),
      port: port(env.DEVILUDO_STEAM_APPROVAL_PORT),
      pool, store, service, server,
    });
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runSteamApprovalMonitor(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await steamApprovalMonitorRuntimeFromEnv(env);
  try {
    await runtime.pool.probe();
    await runtime.service.probe();
    await new Promise<void>((resolveListen, reject) => {
      const fail = (error: Error) => reject(error);
      runtime.server.once("error", fail);
      runtime.server.listen(runtime.port, runtime.host, () => {
        runtime.server.off("error", fail);
        resolveListen();
      });
    });
    console.log(`[steam-approval-monitor] READY ${runtime.host}:${runtime.port}`);
    const close = () => runtime.server.close();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    await new Promise<void>((resolveClose, reject) => {
      runtime.server.once("close", resolveClose);
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
function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function spiffeSet(value: string): ReadonlySet<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("Steam approval verifier SPIFFE allow-list is invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16
    || new Set(parsed).size !== parsed.length || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Steam approval verifier SPIFFE allow-list is invalid");
  }
  const values = (parsed as string[]).map((item) => {
    const url = new URL(item);
    if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash
      || url.toString() !== item) throw new Error("Steam approval verifier SPIFFE identity is invalid");
    return item;
  }).sort();
  if (JSON.stringify(values) !== JSON.stringify(parsed)) throw new Error("Steam approval verifier SPIFFE allow-list must be sorted");
  return new Set(values);
}
function host(value: string | undefined): string {
  const selected = value ?? "0.0.0.0";
  if (selected !== "0.0.0.0" && selected !== "::") throw new Error("Steam approval monitor host is invalid");
  return selected;
}
function port(value: string | undefined): number {
  const selected = value === undefined ? 4550 : Number(value);
  if (!Number.isInteger(selected) || selected < 1_024 || selected > 65_535
    || (value !== undefined && String(selected) !== value)) throw new Error("Steam approval monitor port is invalid");
  return selected;
}
function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const selected = Number(value);
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum || String(selected) !== value) {
    throw new Error("Steam approval monitor duration is invalid");
  }
  return selected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSteamApprovalMonitor();
}
