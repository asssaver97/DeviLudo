import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InferenceGatewayProviderProbeClient } from "../../control-plane/src/provider-probe";
import { PostgresWorkflowActionCompletionStore } from "../../control-plane/src/workflow-action-completion-postgres";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { workflowAssignmentSourceFromEnv } from "../../temporal/src/tenant-assignments";
import { validSchedulerSubject } from "./contracts";
import { createProviderMonitorHandler, createProviderMonitorHttpsServer } from "./ingress-http";
import { PostgresProviderRecoveryStore } from "./postgres-store";
import { ProviderRecoveryService } from "./service";
import { ProviderRecoveryWorker } from "./worker";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function providerMonitorRuntimeFromEnv(env: Readonly<Record<string, string | undefined>> = process.env) {
  if (env.NODE_ENV !== "production") throw new Error("Provider monitor production service requires NODE_ENV=production");
  const [key, certificate, clientCa] = await Promise.all([
    secret(env, "DEVILUDO_PROVIDER_MONITOR_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_PROVIDER_MONITOR_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_PROVIDER_MONITOR_CLIENT_CA_FILE"),
  ]);
  const allowedSchedulerSpiffeIds = spiffeSet(required(env, "DEVILUDO_PROVIDER_MONITOR_SCHEDULER_SPIFFE_IDS_JSON"));
  const workerSubject = required(env, "DEVILUDO_PROVIDER_MONITOR_WORKER_SPIFFE_ID");
  if (!validSchedulerSubject(workerSubject) || !allowedSchedulerSpiffeIds.has(workerSubject)) {
    throw new Error("Provider monitor worker identity must be allow-listed");
  }
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "provider-monitor" });
  try {
    const store = new PostgresProviderRecoveryStore(pool);
    const providerProbe = new InferenceGatewayProviderProbeClient({
      NODE_ENV: "production",
      DEVILUDO_INFERENCE_PROBE_URL: required(env, "DEVILUDO_PROVIDER_MONITOR_INFERENCE_PROBE_URL"),
      DEVILUDO_INFERENCE_PROBE_TLS_KEY_FILE: required(env, "DEVILUDO_PROVIDER_MONITOR_INFERENCE_TLS_KEY_FILE"),
      DEVILUDO_INFERENCE_PROBE_TLS_CERT_FILE: required(env, "DEVILUDO_PROVIDER_MONITOR_INFERENCE_TLS_CERT_FILE"),
      DEVILUDO_INFERENCE_PROBE_CA_FILE: required(env, "DEVILUDO_PROVIDER_MONITOR_INFERENCE_CA_FILE"),
    });
    const service = new ProviderRecoveryService(store, providerProbe, new PostgresWorkflowActionCompletionStore(pool));
    const assignments = workflowAssignmentSourceFromEnv(env);
    const worker = new ProviderRecoveryWorker(store, service, assignments, workerSubject, {
      pollIntervalMs: integer(env.DEVILUDO_PROVIDER_MONITOR_POLL_INTERVAL_MS, 1_000, 100, 60_000),
      perTenantLimit: integer(env.DEVILUDO_PROVIDER_MONITOR_BATCH_SIZE, 20, 1, 100),
      onDiagnostic: (diagnostic) => process.stderr.write(`${JSON.stringify(diagnostic)}\n`),
    });
    const handler = createProviderMonitorHandler({ service, allowedSchedulerSpiffeIds });
    const server = createProviderMonitorHttpsServer({ tls: { key, cert: certificate, ca: clientCa }, handler });
    return Object.freeze({ host: host(env.DEVILUDO_PROVIDER_MONITOR_HOST), port: port(env.DEVILUDO_PROVIDER_MONITOR_PORT),
      pool, store, providerProbe, service, assignments, worker, server });
  } catch (error) { await pool.close().catch(() => undefined); throw error; }
}

export async function runProviderMonitor(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const runtime = await providerMonitorRuntimeFromEnv(env);
  const controller = new AbortController();
  let workerRun: Promise<void> | null = null;
  try {
    await runtime.pool.probe(); await runtime.service.probe();
    await runtime.assignments.listTenantIds("control-plane");
    await new Promise<void>((accept, reject) => {
      const fail = (error: Error) => reject(error); runtime.server.once("error", fail);
      runtime.server.listen(runtime.port, runtime.host, () => { runtime.server.off("error", fail); accept(); });
    });
    workerRun = runtime.worker.run(controller.signal);
    console.log(`[provider-monitor] READY ${runtime.host}:${runtime.port}`);
    const close = () => { controller.abort(); runtime.server.close(); };
    process.once("SIGINT", close); process.once("SIGTERM", close);
    await new Promise<void>((accept, reject) => { runtime.server.once("close", accept); runtime.server.once("error", reject); });
  } finally {
    controller.abort();
    await workerRun?.catch(() => undefined);
    await runtime.pool.close();
  }
}

async function secret(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const metadata = await file.stat(); if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_SECRET_BYTES) throw new Error(`${name} file is invalid`); return await file.readFile(); }
  finally { await file.close(); }
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function spiffeSet(value: string): ReadonlySet<string> {
  let parsed: unknown; try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("Provider monitor scheduler SPIFFE allow-list is invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16 || new Set(parsed).size !== parsed.length || parsed.some((item) => typeof item !== "string")) throw new Error("Provider monitor scheduler SPIFFE allow-list is invalid");
  const values = (parsed as string[]).map((item) => { const url = new URL(item); if (url.protocol !== "spiffe:" || !url.hostname || url.pathname === "/" || url.username || url.password || url.search || url.hash || url.toString() !== item) throw new Error("Provider monitor scheduler SPIFFE identity is invalid"); return item; }).sort();
  if (JSON.stringify(values) !== JSON.stringify(parsed)) throw new Error("Provider monitor scheduler SPIFFE allow-list must be sorted"); return new Set(values);
}
function host(value: string | undefined): string { const selected = value ?? "0.0.0.0"; if (selected !== "0.0.0.0" && selected !== "::") throw new Error("Provider monitor host is invalid"); return selected; }
function port(value: string | undefined): number { const selected = value === undefined ? 4551 : Number(value); if (!Number.isInteger(selected) || selected < 1_024 || selected > 65_535 || value !== undefined && String(selected) !== value) throw new Error("Provider monitor port is invalid"); return selected; }
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const selected = Number.parseInt(value, 10);
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum || String(selected) !== value) {
    throw new Error("Provider monitor numeric setting is invalid");
  }
  return selected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runProviderMonitor();
