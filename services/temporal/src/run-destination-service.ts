import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WorkflowJobHandler } from "./job-processor";
import type { WorkflowJobProcessorPort } from "./job-worker-host";
import { connectDeliveryClient } from "./client";
import type { DeliveryCommandDestination } from "./contracts";
import { createWorkflowDestinationRuntime } from "./destination-runtime";
import { postgresWorkflowPoolFromEnv, type ClosablePostgresWorkflowPool } from "./node-postgres";
import { authorizeTemporalWorkerTls } from "./receiver-http";
import { TemporalWorkflowSignalPort } from "./temporal-signal";
import { workflowAssignmentSourceFromEnv } from "./tenant-assignments";

export async function runWorkflowDestinationService(options: {
  readonly destination: DeliveryCommandDestination;
  readonly createHandler: (
    pool: ClosablePostgresWorkflowPool,
    env: Readonly<Record<string, string | undefined>>,
  ) => WorkflowJobHandler | Promise<WorkflowJobHandler>;
  readonly createAuxiliaryProcessors?: (
    pool: ClosablePostgresWorkflowPool,
    signals: TemporalWorkflowSignalPort,
    workerId: string,
  ) => readonly WorkflowJobProcessorPort[] | Promise<readonly WorkflowJobProcessorPort[]>;
  readonly configureServer?: (
    server: FastifyInstance,
    pool: ClosablePostgresWorkflowPool,
    env: Readonly<Record<string, string | undefined>>,
  ) => void | Promise<void>;
  readonly createReadinessProbes?: (input: Readonly<{
    pool: ClosablePostgresWorkflowPool;
    env: Readonly<Record<string, string | undefined>>;
    handler: WorkflowJobHandler;
  }>) => readonly (() => Promise<void>)[] | Promise<readonly (() => Promise<void>)[]>;
  readonly probes?: readonly (() => Promise<void>)[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  const env: Readonly<Record<string, string | undefined>> = Object.freeze({
    ...(options.env ?? process.env),
    DEVILUDO_WORKFLOW_DESTINATION: options.destination,
  });
  const config = await serviceConfigFromEnv(env);
  const pool = postgresWorkflowPoolFromEnv(env);
  let temporal: Awaited<ReturnType<typeof connectDeliveryClient>> | null = null;
  try {
    temporal = await connectDeliveryClient({
      address: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE,
    });
    const server = Fastify({
      logger: false,
      bodyLimit: 2 * 1024 * 1024,
      https: {
        key: config.tlsKey,
        cert: config.tlsCertificate,
        ca: config.clientCa,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
      },
    });
    const handler = await options.createHandler(pool, env);
    if (options.configureServer) await options.configureServer(server, pool, env);
    const assignments = workflowAssignmentSourceFromEnv(env);
    const signals = new TemporalWorkflowSignalPort(temporal.client);
    const auxiliaryProcessors = options.createAuxiliaryProcessors
      ? await options.createAuxiliaryProcessors(pool, signals, config.workerId)
      : [];
    const serviceProbes = options.createReadinessProbes
      ? await options.createReadinessProbes(Object.freeze({ pool, env, handler }))
      : [];
    const authorize = (request: FastifyRequest) => authorizeTemporalWorkerTls(request, config.allowedDispatcherSpiffeIds);
    const runtime = createWorkflowDestinationRuntime({
      server,
      destination: options.destination,
      workerId: config.workerId,
      pool,
      handler,
      signals,
      tenants: assignments,
      auxiliaryProcessors,
      authorize,
      probes: [
        () => pool.probe(),
        () => assignments.listTenantIds(options.destination).then(() => undefined),
        ...serviceProbes,
        ...(options.probes ?? []),
      ],
      onDiagnostic: (diagnostic) => process.stderr.write(`${JSON.stringify(diagnostic)}\n`),
    });
    const shutdown = new AbortController();
    const requestShutdown = () => shutdown.abort();
    process.once("SIGINT", requestShutdown);
    process.once("SIGTERM", requestShutdown);
    try {
      await runtime.start(() => server.listen({ host: config.host, port: config.port }));
      await Promise.race([waitForAbort(shutdown.signal), runtime.wait()]);
    } finally {
      process.removeListener("SIGINT", requestShutdown);
      process.removeListener("SIGTERM", requestShutdown);
      await runtime.stop();
    }
  } finally {
    if (temporal) await temporal.close();
    await pool.close();
  }
}

async function serviceConfigFromEnv(env: Readonly<Record<string, string | undefined>>): Promise<{
  readonly host: string;
  readonly port: number;
  readonly workerId: string;
  readonly tlsKey: Buffer;
  readonly tlsCertificate: Buffer;
  readonly clientCa: Buffer;
  readonly allowedDispatcherSpiffeIds: ReadonlySet<string>;
}> {
  const host = env.DEVILUDO_WORKFLOW_SERVICE_HOST?.trim() || "0.0.0.0";
  const port = positiveInteger(env.DEVILUDO_WORKFLOW_SERVICE_PORT, 4200, 1, 65_535, "service port");
  const workerId = requiredEnv(env, "DEVILUDO_WORKLOAD_ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(workerId)) throw new Error("Workflow worker identity is invalid");
  const allowedDispatcherSpiffeIds = new Set(
    requiredEnv(env, "DEVILUDO_TEMPORAL_DISPATCHER_SPIFFE_IDS").split(",").map((value) => value.trim()),
  );
  if (allowedDispatcherSpiffeIds.size < 1 || allowedDispatcherSpiffeIds.size > 20
    || [...allowedDispatcherSpiffeIds].some((value) => !validSpiffeId(value))) {
    throw new Error("Temporal dispatcher SPIFFE allow-list is invalid");
  }
  const [tlsKey, tlsCertificate, clientCa] = await Promise.all([
    readRequiredFile(env, "DEVILUDO_WORKFLOW_TLS_KEY_FILE"),
    readRequiredFile(env, "DEVILUDO_WORKFLOW_TLS_CERT_FILE"),
    readRequiredFile(env, "DEVILUDO_WORKFLOW_CLIENT_CA_FILE"),
  ]);
  return Object.freeze({ host, port, workerId, tlsKey, tlsCertificate, clientCa, allowedDispatcherSpiffeIds });
}

async function readRequiredFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = requiredEnv(env, name);
  if (!path.startsWith("/") || path.length > 4_096 || /\0/.test(path)) throw new Error(`${name} path is invalid`);
  const value = await readFile(path);
  if (value.byteLength < 32 || value.byteLength > 1024 * 1024) throw new Error(`${name} file is invalid`);
  return value;
}

function validSpiffeId(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "spiffe:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error(`Workflow ${label} is invalid`);
  }
  return parsed;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error("A destination-specific service must provide its production workflow handler");
}
