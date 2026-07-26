import {
  postgresWorkflowPoolFromEnv,
  type ClosablePostgresWorkflowPool,
} from "../../temporal/src/node-postgres";
import { PostgresSteamWorkflowOperationDispatch } from "./postgres-workflow-dispatch";
import { PostgresSteamWorkflowOperationPersistence } from "./postgres-workflow-operations";
import {
  SteamWorkflowOperationWorker,
  type SteamWorkflowOperationExecutor,
} from "./workflow-broker-operations";
import { PollingSteamWorkflowWorkerHost, SteamWorkflowOperationProcessor } from "./workflow-worker-host";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/**
 * Isolated Worker composition boundary. The caller supplies the native Steam
 * executor, so this module cannot silently install or select an executable.
 */
export function steamWorkflowWorkerFromEnv(
  executor: SteamWorkflowOperationExecutor,
  env: Readonly<Record<string, string | undefined>> = process.env,
  suppliedPool?: ClosablePostgresWorkflowPool,
  options: Readonly<{ diagnostic?: (event: "READY" | "CYCLE_FAILED" | "STOPPED") => void }> = {},
) {
  const serviceEnv = Object.freeze({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "steam-executor" });
  const pool = suppliedPool ?? postgresWorkflowPoolFromEnv(serviceEnv);
  const operations = new PostgresSteamWorkflowOperationPersistence(pool);
  const dispatch = new PostgresSteamWorkflowOperationDispatch(pool);
  const worker = new SteamWorkflowOperationWorker(operations, executor, {
    leaseMs: integer(env.DEVILUDO_STEAM_WORKER_LEASE_MS, 5 * 60_000, 30_000, 15 * 60_000),
  });
  const processor = new SteamWorkflowOperationProcessor(dispatch, worker);
  const tenantIds = tenants(required(env, "DEVILUDO_STEAM_WORKER_TENANT_IDS"));
  const host = new PollingSteamWorkflowWorkerHost(processor, tenantIds, {
    pollIntervalMs: integer(env.DEVILUDO_STEAM_WORKER_POLL_INTERVAL_MS, 1_000, 100, 60_000),
    retryIntervalMs: integer(env.DEVILUDO_STEAM_WORKER_RETRY_INTERVAL_MS, 5_000, 100, 60_000),
    diagnostic: options.diagnostic ?? diagnostic,
  });
  return Object.freeze({ pool, operations, dispatch, worker, processor, host, tenantIds });
}

export async function runSteamWorkflowWorker(
  executor: SteamWorkflowOperationExecutor,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = steamWorkflowWorkerFromEnv(executor, env);
  const shutdown = new AbortController();
  const requestShutdown = () => shutdown.abort();
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  try {
    await runtime.host.run(shutdown.signal);
  } finally {
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
    await runtime.pool.close();
  }
}

function tenants(value: string): readonly string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("Steam workflow Worker tenant list is invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 1_000
    || parsed.some((item) => typeof item !== "string" || !UUID.test(item))
    || new Set(parsed).size !== parsed.length
    || JSON.stringify([...parsed].sort()) !== JSON.stringify(parsed)) {
    throw new Error("Steam workflow Worker tenant list is invalid");
  }
  return Object.freeze([...parsed] as string[]);
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Steam workflow Worker integer is invalid");
  }
  return parsed;
}

function diagnostic(event: "READY" | "CYCLE_FAILED" | "STOPPED"): void {
  process.stderr.write(`${JSON.stringify({ service: "deviludo-steam-workflow-worker", event })}\n`);
}
