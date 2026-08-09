import { createAgentSecretStore } from "./agent-settings";
import { runAssetGenerationBatch, type AssetGenerationDependencies } from "./asset-generation";
import type { CoreConfig } from "./config";
import { CoreObjectStore } from "./object-store";
import type { CoreRepository } from "./repository";

export async function runScheduler(
  repository: CoreRepository,
  config: CoreConfig,
  signal: AbortSignal,
): Promise<void> {
  // Built once and shared across ticks, but only if this deployment configured an
  // object store. `ObjectStore` requires a bucket, and asset generation is the
  // scheduler's only use for one: a deployment without it should keep running the
  // rest of the tick rather than crash-loop on a bucket it does not need.
  const assetGeneration = assetGenerationDependencies(repository);
  if (!assetGeneration) {
    console.log(JSON.stringify({
      level: "info",
      event: "asset_generation_disabled",
      reason: "object store is not configured for the scheduler role",
    }));
  }
  // Swept on the first tick, then on its own slower cadence.
  let nextAssetSweepAt = 0;
  while (!signal.aborted) {
    const startedAt = Date.now();
    try {
      const recovered = await repository.recoverExpiredJobs();
      await repository.reconcileCapacity();
      const projectDocumentsScheduled = await repository.scheduleIdleProjectDocumentMaintenance(
        config.projectDocumentIdleSeconds,
      );
      const expiredAuthRecordsRemoved = await repository.cleanupExpiredAuthState();
      // Provider calls run less often than the sub-second recovery tick. The
      // durable asset gate is checked on every tick, however, so the last image or
      // a user's explicit "use placeholders" choice advances immediately.
      const assets = assetGeneration && Date.now() >= nextAssetSweepAt
        ? await runAssetGenerationBatch(assetGeneration, signal)
        : null;
      if (assets) nextAssetSweepAt = Date.now() + config.assetGenerationPollMilliseconds;
      const assetWorkflowsAdvanced = await repository.assets.advanceReadyWorkflows();
      console.log(JSON.stringify({
        level: "info",
        event: "scheduler_tick",
        recovered,
        projectDocumentsScheduled,
        expiredAuthRecordsRemoved,
        ...(assets ? {
          assetsClaimed: assets.claimed,
          assetsGenerated: assets.generated,
          assetsFailed: assets.failed,
        } : {}),
        assetWorkflowsAdvanced,
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

/**
 * Wire the asset generator, or return null when this deployment has no object
 * store. Nothing else on the tick needs one, so its absence disables generation
 * rather than failing the scheduler.
 */
function assetGenerationDependencies(repository: CoreRepository): AssetGenerationDependencies | null {
  try {
    return Object.freeze({
      repository,
      objectStore: new CoreObjectStore(),
      secrets: createAgentSecretStore(),
    });
  } catch {
    return null;
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
