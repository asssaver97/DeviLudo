import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { AwsSqsFifoCapacityPublisher } from "./aws-sqs-capacity";
import { AwsSqsFifoCapacityEventSource } from "./aws-sqs-capacity-events";
import { RunnerCapacityController } from "./capacity-controller";
import { PostgresFleetCapacityStore } from "./postgres-capacity";
import { PostgresMacCapacityEventStore } from "./postgres-capacity-events";

export async function runCapacityController(options: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}> = {}): Promise<void> {
  const env = options.env ?? process.env;
  const intervalMs = exactInteger(env.DEVILUDO_CAPACITY_RECONCILE_INTERVAL_MS, 30_000, 5_000, 300_000);
  const queueUrl = required(env, "DEVILUDO_AWS_MAC_CAPACITY_QUEUE_URL");
  const eventQueueUrl = required(env, "DEVILUDO_AWS_MAC_CAPACITY_EVENT_QUEUE_URL");
  const credentialsFile = required(env, "DEVILUDO_AWS_ROLES_ANYWHERE_CREDENTIALS_FILE");
  const pool = postgresWorkflowPoolFromEnv(env);
  const store = new PostgresFleetCapacityStore(pool);
  const publisher = new AwsSqsFifoCapacityPublisher({ queueUrl, region: "ap-southeast-1", credentialsFile });
  const eventSource = new AwsSqsFifoCapacityEventSource({ queueUrl: eventQueueUrl, region: "ap-southeast-1", credentialsFile });
  const eventStore = new PostgresMacCapacityEventStore(pool);
  const controller = new RunnerCapacityController({ store, macPublisher: publisher });
  const port = exactInteger(env.PORT, 8080, 1, 65_535);
  let lastSuccessfulCycle = 0;
  const healthServer = createServer((request, response) => {
    if (request.method !== "GET" || (request.url !== "/healthz" && request.url !== "/healthz/migrations")) {
      response.writeHead(404).end(); return;
    }
    const at = new Date();
    void store.loadP0Health(at).then((health) => {
      const controllerReady = at.valueOf() - lastSuccessfulCycle <= intervalMs * 2;
      if (request.url === "/healthz/migrations") {
        const ready = health.migrationCount === 69 && health.migrationHead === 69;
        respond(response, ready, { schemaVersion: "deviludo.migration-readiness.v1", status: ready ? "ready" : "blocked",
          pending: ready ? 0 : Math.max(0, 69 - health.migrationCount) }); return;
      }
      const ready = controllerReady && health.linuxOnline >= 1 && health.windowsOnline >= 1;
      respond(response, ready, { schemaVersion: "deviludo.runner-fleet-readiness.v1", status: ready ? "ready" : "blocked",
        linux: health.linuxOnline >= 1 ? "ONLINE" : "OFFLINE", windows: health.windowsOnline >= 1 ? "ONLINE" : "OFFLINE",
        macCapacity: controllerReady ? "ON_DEMAND_READY" : "BLOCKED" });
    }).catch(() => respond(response, false, { schemaVersion: "deviludo.runner-fleet-readiness.v1", status: "blocked" }));
  });
  let healthListening = false;
  const shutdown = new AbortController();
  const requestShutdown = () => shutdown.abort();
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  options.signal?.addEventListener("abort", requestShutdown, { once: true });
  try {
    await store.probe();
    await new Promise<void>((accept, reject) => { healthServer.once("error", reject); healthServer.listen(port, "0.0.0.0", accept); });
    healthListening = true;
    lastSuccessfulCycle = Date.now();
    diagnostic("READY");
    while (!shutdown.signal.aborted) {
      try {
        const envelope = await eventSource.receiveOne();
        if (envelope) {
          await eventStore.apply(envelope.event);
          await envelope.ack();
        }
        const result = await controller.reconcile();
        lastSuccessfulCycle = Date.now();
        if (result.created.length > 0 || result.unschedulableCapabilities.length > 0) {
          process.stderr.write(`${JSON.stringify({
            service: "deviludo-runner-capacity-controller",
            event: "RECONCILED",
            created: result.created.map(({ id, fleet, desiredHosts }) => ({ id, fleet, desiredHosts })),
            unschedulableCapabilities: result.unschedulableCapabilities,
          })}\n`);
        }
      } catch {
        diagnostic("CYCLE_FAILED");
      }
      await wait(intervalMs, shutdown.signal);
    }
  } finally {
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
    if (healthListening) await new Promise<void>((accept) => healthServer.close(() => accept()));
    await pool.close();
    diagnostic("STOPPED");
  }
}

function respond(response: import("node:http").ServerResponse, ready: boolean, body: Readonly<Record<string, unknown>>): void {
  response.writeHead(ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`${name} is required`);
  return value;
}

function exactInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Capacity reconcile interval is invalid");
  }
  return parsed;
}

function diagnostic(event: "READY" | "CYCLE_FAILED" | "STOPPED" | "FAILED"): void {
  process.stderr.write(`${JSON.stringify({ service: "deviludo-runner-capacity-controller", event })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCapacityController().catch(() => { diagnostic("FAILED"); process.exitCode = 1; });
}
