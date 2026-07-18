import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PostgresWorkflowActionCompletionStore } from "../../control-plane/src/workflow-action-completion-postgres";
import { connectDeliveryClient } from "../../temporal/src/client";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { workflowAssignmentSourceFromEnv } from "../../temporal/src/tenant-assignments";
import { temporalTlsConfigFromEnv } from "../../temporal/src/temporal-tls";
import { createSpecWorkflowHandler, createSpecWorkflowHttpsServer } from "./ingress-http";
import { PostgresSpecWorkflowBridgeStore } from "./postgres-store";
import { SpecWorkflowBridgeService, TemporalSpecWorkflowPort } from "./service";
import { SpecWorkflowBridgeWorker } from "./worker";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function specWorkflowBridgeRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const [serverKey, serverCertificate, clientCa] = await Promise.all([
    secret(env, "DEVILUDO_SPEC_WORKFLOW_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_SPEC_WORKFLOW_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_SPEC_WORKFLOW_CLIENT_CA_FILE"),
  ]);
  const allowedSpiffeIds = spiffeSet(required(env, "DEVILUDO_SPEC_WORKFLOW_SPEC_SPIFFE_IDS"));
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "spec-workflow-bridge" });
  let temporal: Awaited<ReturnType<typeof connectDeliveryClient>> | null = null;
  try {
    temporal = await connectDeliveryClient({
      address: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE,
      tls: await temporalTlsConfigFromEnv(env),
    });
    const store = new PostgresSpecWorkflowBridgeStore(pool);
    const service = new SpecWorkflowBridgeService(
      store,
      new TemporalSpecWorkflowPort(temporal.client),
      new PostgresWorkflowActionCompletionStore(pool),
    );
    const assignments = workflowAssignmentSourceFromEnv(env);
    const worker = new SpecWorkflowBridgeWorker(
      service,
      assignments,
      integer(env.DEVILUDO_SPEC_WORKFLOW_POLL_INTERVAL_MS, 1_000, 100, 60_000),
      (diagnostic) => process.stderr.write(`${JSON.stringify(diagnostic)}\n`),
    );
    const handler = createSpecWorkflowHandler({ service, allowedSpiffeIds });
    const server = createSpecWorkflowHttpsServer({
      tls: { key: serverKey, cert: serverCertificate, ca: clientCa }, handler,
    });
    return Object.freeze({
      host: host(env.DEVILUDO_SPEC_WORKFLOW_HOST),
      port: port(env.DEVILUDO_SPEC_WORKFLOW_PORT),
      pool, temporal, service, assignments, worker, server,
    });
  } catch (error) {
    if (temporal) await temporal.close().catch(() => undefined);
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runSpecWorkflowBridge(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await specWorkflowBridgeRuntimeFromEnv(env);
  try {
    await Promise.all([
      runtime.pool.probe(),
      runtime.service.probe(),
      runtime.assignments.listTenantIds("control-plane").then(() => undefined),
    ]);
    await new Promise<void>((resolveListen, reject) => {
      const fail = (error: Error) => reject(error);
      runtime.server.once("error", fail);
      runtime.server.listen(runtime.port, runtime.host, () => {
        runtime.server.off("error", fail);
        resolveListen();
      });
    });
    runtime.worker.start();
    console.log(`[spec-workflow-bridge] READY ${runtime.host}:${runtime.port}`);
    const close = () => runtime.server.close();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    await new Promise<void>((resolveClose, reject) => {
      runtime.server.once("close", resolveClose);
      runtime.server.once("error", reject);
    });
  } finally {
    await runtime.worker.stop().catch(() => undefined);
    await runtime.temporal.close().catch(() => undefined);
    await runtime.pool.close().catch(() => undefined);
  }
}

async function secret(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) {
    throw new Error(`${name} path is invalid`);
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_SECRET_BYTES) {
      throw new Error(`${name} file is invalid`);
    }
    return await file.readFile();
  } finally { await file.close(); }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function spiffeSet(value: string): ReadonlySet<string> {
  const result = new Set(value.split(",").map((item) => item.trim()));
  if (!result.size) throw new Error("Specification workflow SPIFFE allow-list is empty");
  for (const item of result) {
    const url = new URL(item);
    if (url.protocol !== "spiffe:" || !url.hostname || url.toString() !== item) {
      throw new Error("Specification workflow SPIFFE identity is invalid");
    }
  }
  return result;
}
function host(value: string | undefined): string {
  const result = value ?? "0.0.0.0";
  if (result !== "0.0.0.0" && result !== "::") throw new Error("Specification workflow host is invalid");
  return result;
}
function port(value: string | undefined): number {
  return integer(value, 4555, 1_024, 65_535);
}
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum || String(result) !== value) {
    throw new Error("Specification workflow numeric configuration is invalid");
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSpecWorkflowBridge();
}
