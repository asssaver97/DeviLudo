import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { postgresWorkflowPoolFromEnv, type ClosablePostgresWorkflowPool } from "../../temporal/src/node-postgres";
import { AgentExecutionOperationWorker, type IsolatedAgentExecutionDispatcher } from "./operations";
import { PostgresAgentExecutionDispatch } from "./postgres-dispatch";
import { PostgresAgentExecutionOperations } from "./postgres-operations";
import { HmacEphemeralRunTokenBroker, type EphemeralRunTokenSecretStore } from "./token-broker";
import { AgentExecutionOperationProcessor, PollingAgentExecutionWorkerHost } from "./worker-host";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/**
 * Isolated Worker composition. Dependencies are injected deliberately: this
 * module cannot install a CLI, resolve an upstream key, or fall back to a
 * different Agent on its own.
 */
export async function agentExecutionWorkerFromEnv(
  executor: IsolatedAgentExecutionDispatcher,
  secrets: EphemeralRunTokenSecretStore,
  env: Readonly<Record<string, string | undefined>> = process.env,
  suppliedPool?: ClosablePostgresWorkflowPool,
) {
  const serviceEnv = Object.freeze({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "agent-execution-worker" });
  const pool = suppliedPool ?? postgresWorkflowPoolFromEnv(serviceEnv);
  let signingKey: Uint8Array | null = null;
  try {
    signingKey = await readSigningKey(env);
    const operations = new PostgresAgentExecutionOperations(pool);
    const dispatch = new PostgresAgentExecutionDispatch(pool);
    const tokens = new HmacEphemeralRunTokenBroker(signingKey, secrets);
    const worker = new AgentExecutionOperationWorker(operations, tokens, executor, {
      leaseMs: integer(env.DEVILUDO_AGENT_EXECUTION_WORKER_LEASE_MS, 5 * 60_000, 30_000, 15 * 60_000),
    });
    const processor = new AgentExecutionOperationProcessor(dispatch, worker);
    const host = new PollingAgentExecutionWorkerHost(processor,
      tenants(required(env, "DEVILUDO_AGENT_EXECUTION_WORKER_TENANT_IDS")), {
        pollIntervalMs: integer(env.DEVILUDO_AGENT_EXECUTION_WORKER_POLL_INTERVAL_MS, 1_000, 100, 60_000),
        retryIntervalMs: integer(env.DEVILUDO_AGENT_EXECUTION_WORKER_RETRY_INTERVAL_MS, 5_000, 100, 60_000),
        diagnostic,
      });
    let disposed = false;
    return Object.freeze({ pool, operations, dispatch, tokens, worker, processor, host,
      dispose: async () => { if (disposed) return; disposed = true; signingKey?.fill(0); await pool.close(); } });
  } catch (error) {
    signingKey?.fill(0); if (!suppliedPool) await pool.close().catch(() => undefined); throw error;
  }
}

export async function runAgentExecutionWorker(executor: IsolatedAgentExecutionDispatcher,
  secrets: EphemeralRunTokenSecretStore, env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const runtime = await agentExecutionWorkerFromEnv(executor, secrets, env);
  const shutdown = new AbortController(); const stop = () => shutdown.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await runtime.host.run(shutdown.signal); }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await runtime.dispose(); }
}

async function readSigningKey(env: Readonly<Record<string, string | undefined>>): Promise<Uint8Array> {
  const path = required(env, "DEVILUDO_INFERENCE_RUN_TOKEN_SIGNING_KEY_FILE");
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || path.includes("\0")) throw new Error("run-token key path is invalid");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size < 32 || stat.size > 4_096) throw new Error("run-token signing key is invalid");
    return new Uint8Array(await file.readFile()); }
  finally { await file.close(); }
}
function tenants(value: string): readonly string[] { let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error("tenant list is invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 1_000 || parsed.some((item) => typeof item !== "string" || !UUID.test(item))
    || new Set(parsed).size !== parsed.length || JSON.stringify([...parsed].sort()) !== JSON.stringify(parsed)) throw new Error("tenant list is invalid");
  return Object.freeze(parsed as string[]); }
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function integer(value: string | undefined, fallback: number, min: number, max: number): number { if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < min || parsed > max) throw new Error("integer is invalid"); return parsed; }
function diagnostic(event: "READY" | "CYCLE_FAILED" | "STOPPED"): void { process.stderr.write(`${JSON.stringify({ service: "deviludo-agent-execution-worker", event })}\n`); }
