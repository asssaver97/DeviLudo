import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
  createDeliveryActivities,
  deliveryDispatchEndpointsFromEnv,
  HttpCommandDispatcher,
} from "./activities";
import { temporalWebpackConfigHook } from "./bundler";
import { DELIVERY_TASK_QUEUE } from "./contracts";
import { mtlsCommandDispatcherFromEnv } from "./mtls-dispatcher";
import { temporalTlsConfigFromEnv } from "./temporal-tls";
import {
  deliveryProjectionEndpointFromEnv,
  HttpDeliveryProjectionWriter,
  mtlsDeliveryProjectionWriterFromEnv,
} from "./projection-writer";

export async function runDeliveryWorker(): Promise<void> {
  const endpoints = deliveryDispatchEndpointsFromEnv();
  const allowLocalDispatch = process.env.DEVILUDO_ALLOW_INSECURE_LOCAL_DISPATCH === "1";
  if (process.env.NODE_ENV === "production" && allowLocalDispatch) {
    throw new Error("Production Temporal dispatch cannot disable mTLS");
  }
  const dispatcher = allowLocalDispatch
    ? new HttpCommandDispatcher(endpoints)
    : await mtlsCommandDispatcherFromEnv(endpoints);
  const projectionEndpoint = deliveryProjectionEndpointFromEnv();
  const projections = allowLocalDispatch
    ? new HttpDeliveryProjectionWriter(projectionEndpoint)
    : await mtlsDeliveryProjectionWriterFromEnv(projectionEndpoint);
  const tls = await temporalTlsConfigFromEnv();
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
    tls,
  });
  const sourceWorkflow = fileURLToPath(new URL("./workflows/game-delivery.workflow.ts", import.meta.url));
  const compiledWorkflow = fileURLToPath(new URL("./workflows/game-delivery.workflow.js", import.meta.url));
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: process.env.DEVILUDO_TEMPORAL_TASK_QUEUE ?? DELIVERY_TASK_QUEUE,
    workflowsPath: existsSync(compiledWorkflow) ? compiledWorkflow : sourceWorkflow,
    bundlerOptions: { webpackConfigHook: temporalWebpackConfigHook },
    activities: createDeliveryActivities(dispatcher, projections),
    maxConcurrentActivityTaskExecutions: parsePositiveInteger(
      process.env.DEVILUDO_MAX_CONCURRENT_ACTIVITIES,
      100,
    ),
    maxConcurrentWorkflowTaskExecutions: parsePositiveInteger(
      process.env.DEVILUDO_MAX_CONCURRENT_WORKFLOWS,
      100,
    ),
  });

  const shutdown = () => worker.shutdown();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await worker.run();
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    await connection.close();
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error("Temporal concurrency setting is invalid");
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDeliveryWorker();
}
