import type { JobProtocolV3 } from "@/services/core/src/contracts";
import type { E2eNodeConfig } from "./config";
import { CoreE2eClient } from "./core-client";
import { executeE2eJob } from "./executor";
import { TrustedIsolationController, type IsolationController } from "./isolation";

export async function runE2eNode(
  config: E2eNodeConfig,
  signal: AbortSignal,
  dependencies: Readonly<{
    client?: CoreE2eClient;
    isolation?: IsolationController;
  }> = {},
): Promise<void> {
  const client = dependencies.client ?? await CoreE2eClient.create(config);
  const isolation = dependencies.isolation ?? new TrustedIsolationController();
  await isolation.assertAgentAbsent();

  while (!signal.aborted) {
    let job: JobProtocolV3 | null = null;
    try {
      job = await client.claim();
      if (!job) {
        await delay(config.pollMilliseconds, signal);
        continue;
      }
      const heartbeat = setInterval(() => void client.heartbeat(job as JobProtocolV3).catch(() => undefined), 20_000);
      try {
        const completion = await executeE2eJob(job, config, client, isolation, signal);
        if (!await client.complete(job, completion)) throw new Error("E2E completion was rejected by fencing");
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "e2e_job_failed",
        jobId: job?.jobId,
        tenantId: job?.tenantId,
        poolKind: config.poolKind,
        message: error instanceof Error ? error.message : String(error),
      }));
      if (job) await client.fail(job, error instanceof Error ? error.message : String(error)).catch(() => undefined);
      await delay(config.pollMilliseconds, signal);
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
