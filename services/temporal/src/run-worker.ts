import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createDeliveryActivities, HttpCommandDispatcher } from "./activities";
import { temporalWebpackConfigHook } from "./bundler";
import { DELIVERY_TASK_QUEUE } from "./contracts";

export async function runDeliveryWorker(): Promise<void> {
  const endpoint = process.env.DEVILUDO_ACTIVITY_DISPATCH_URL;
  if (!endpoint) throw new Error("DEVILUDO_ACTIVITY_DISPATCH_URL is required");
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  const sourceWorkflow = fileURLToPath(new URL("./workflows/game-delivery.workflow.ts", import.meta.url));
  const compiledWorkflow = fileURLToPath(new URL("./workflows/game-delivery.workflow.js", import.meta.url));
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: process.env.DEVILUDO_TEMPORAL_TASK_QUEUE ?? DELIVERY_TASK_QUEUE,
    workflowsPath: existsSync(compiledWorkflow) ? compiledWorkflow : sourceWorkflow,
    bundlerOptions: { webpackConfigHook: temporalWebpackConfigHook },
    activities: createDeliveryActivities(new HttpCommandDispatcher(endpoint)),
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
