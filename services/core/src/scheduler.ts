import type { CoreConfig } from "./config";
import type { CoreRepository } from "./repository";

export async function runScheduler(
  repository: CoreRepository,
  config: CoreConfig,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const startedAt = Date.now();
    try {
      const recovered = await repository.recoverExpiredJobs();
      await repository.reconcileCapacity();
      console.log(JSON.stringify({
        level: "info",
        event: "scheduler_tick",
        recovered,
        elapsedMilliseconds: Date.now() - startedAt,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "scheduler_tick_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    await delay(config.pollMilliseconds, signal);
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
