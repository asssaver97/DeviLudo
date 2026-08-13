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
  const objectStore = configuredObjectStore();
  const assetGeneration = objectStore ? assetGenerationDependencies(repository, objectStore) : null;
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
      const localGitCommit = await runLocalGitCommit(repository, config, signal);
      const objectCleanup = objectStore ? await runObjectCleanup(repository, objectStore) : null;
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
        ...(localGitCommit ? { localGitCommit } : {}),
        ...(objectCleanup ? { objectCleanup } : {}),
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

async function runLocalGitCommit(
  repository: CoreRepository,
  config: CoreConfig,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>> | null> {
  if (!config.localProjectBridgeUrl || !config.localProjectBridgeToken || signal.aborted) return null;
  const request = await repository.claimLocalGitCommit(180);
  if (!request) return null;

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${config.localProjectBridgeUrl}/internal/directory/git/commit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-deviludo-bridge-token": config.localProjectBridgeToken,
      },
      body: JSON.stringify({
        bindingId: request.bindingId,
        workflowId: request.workflowId,
        iterationNumber: request.iterationNumber,
        expectedDigest: request.expectedSourceDigest,
      }),
      redirect: "error",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`${typeof body.code === "string" ? `${body.code}: ` : ""}${
        typeof body.message === "string" ? body.message : `本地 Git bridge 返回 ${response.status}`
      }`);
    }
    const outcome = body.outcome;
    const commitHash = body.commitHash;
    const branch = body.branch;
    if (!isGitCommitOutcome(outcome)
      || !(commitHash === null || (typeof commitHash === "string" && /^[0-9a-f]{40,64}$/i.test(commitHash)))
      || !(branch === null || (typeof branch === "string" && branch.length >= 1 && branch.length <= 255))) {
      throw new Error("本地 Git bridge 返回了无效的提交结果");
    }
    const completed = await repository.completeLocalGitCommit({
      workflowId: request.workflowId,
      requestId: request.requestId,
      leaseToken: request.leaseToken,
      outcome,
      commitHash,
      branch,
    });
    if (!completed) throw new Error("Local Git commit completion lease was rejected");
    return Object.freeze({ workflowId: request.workflowId, outcome, commitHash, branch });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repository.failLocalGitCommit({
      workflowId: request.workflowId,
      requestId: request.requestId,
      leaseToken: request.leaseToken,
      error: message,
    }).catch(() => undefined);
    return Object.freeze({ workflowId: request.workflowId, outcome: "FAILED", error: message });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function isGitCommitOutcome(value: unknown): value is "COMMITTED" | "NO_CHANGES" | "NOT_GIT" {
  return value === "COMMITTED" || value === "NO_CHANGES" || value === "NOT_GIT";
}

/**
 * Wire the asset generator to the same object-store client used by durable
 * artifact cleanup.
 */
function assetGenerationDependencies(repository: CoreRepository, objectStore: CoreObjectStore): AssetGenerationDependencies {
  return Object.freeze({ repository, objectStore, secrets: createAgentSecretStore() });
}

function configuredObjectStore(): CoreObjectStore | null {
  try { return new CoreObjectStore(); }
  catch { return null; }
}

async function runObjectCleanup(repository: CoreRepository, objectStore: CoreObjectStore) {
  const request = await repository.claimObjectCleanup(120);
  if (!request) return null;
  try {
    await objectStore.deleteQueuedObject({ workspaceId: request.workspaceId, bucket: request.bucket, key: request.objectKey });
    if (!await repository.completeObjectCleanup(request)) throw new Error("Object cleanup completion lease was rejected");
    return Object.freeze({ objectKey: request.objectKey, outcome: "DELETED", attempt: request.attempt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repository.failObjectCleanup(request, message).catch(() => undefined);
    return Object.freeze({ objectKey: request.objectKey, outcome: "FAILED", attempt: request.attempt, error: message });
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
