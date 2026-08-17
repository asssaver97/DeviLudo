// Asynchronous asset generation.
//
// The Agent plans assets and writes their prompts while generating the source
// that consumes them; this turns those prompts into images. It runs on the
// scheduler tick rather than consuming a serial delivery worker. The workflow's
// ASSET_GENERATING gate waits for every required image (or an explicit user
// placeholder choice), then freezes the settled objects into ARTIFACT_BUILD.

import type { AgentSecretStore } from "./agent-settings";
import type { AssetGenerationLease } from "./asset-manifest";
import {
  generateAssetImage,
  generatedImageExtension,
  type FetchLike,
  type ImageGenerationTarget,
} from "./image-generation";
import type { CoreObjectStore } from "./object-store";
import type { CoreRepository } from "./repository";

/**
 * The lease has to outlive the slowest provider call, or a still-running
 * generation gets re-claimed by the next tick. Provider calls are bounded at
 * 120s, so this leaves room for the object-store write on top.
 */
const LEASE_SECONDS = 300;

/**
 * Assets are generated a few at a time. The cap is per tick, not per project: a
 * provider rate limit hit by a 200-asset manifest would otherwise burn every
 * item's attempt budget in one sweep.
 */
const BATCH_SIZE = 4;

export type AssetGenerationDependencies = Readonly<{
  repository: CoreRepository;
  objectStore: CoreObjectStore;
  secrets: AgentSecretStore;
  fetchImpl?: FetchLike;
}>;

export type AssetGenerationOutcome = Readonly<{
  claimed: number;
  generated: number;
  failed: number;
}>;

const IDLE: AssetGenerationOutcome = Object.freeze({ claimed: 0, generated: 0, failed: 0 });

/**
 * Generate one batch of planned assets.
 *
 * Returns counts rather than throwing on individual failures: one asset whose
 * prompt the provider rejects must not stop the others, and the failure is
 * already recorded against that item for the user to see.
 */
export async function runAssetGenerationBatch(
  dependencies: AssetGenerationDependencies,
  signal?: AbortSignal,
): Promise<AssetGenerationOutcome> {
  const { repository, secrets } = dependencies;
  // Resolve the credential once per batch rather than per asset: it is one
  // instance-wide setting, and Vault reads are not free.
  const settings = await repository.readAgentSettings();
  if (!settings || settings.agentRuntime !== "CLAUDE_CODE" || !settings.imageModel) return IDLE;
  const apiKey = await secrets.readApiKey(settings.credentialSecretRef);
  if (!apiKey) return IDLE;
  const target: ImageGenerationTarget = Object.freeze({
    baseUrl: settings.baseUrl,
    model: settings.imageModel,
    apiKey,
  });

  const leases = await repository.assets.claimGeneration(LEASE_SECONDS, BATCH_SIZE);
  if (leases.length === 0) return IDLE;

  let generated = 0;
  let failed = 0;
  for (const lease of leases) {
    // An abort between items leaves the rest leased; their leases expire and the
    // next process picks them up, which is why the lease exists.
    if (signal?.aborted) break;
    const settled = await generateOne(dependencies, target, lease);
    if (settled) generated += 1;
    else failed += 1;
  }
  return Object.freeze({ claimed: leases.length, generated, failed });
}

async function generateOne(
  dependencies: AssetGenerationDependencies,
  target: ImageGenerationTarget,
  lease: AssetGenerationLease,
): Promise<boolean> {
  const { repository, objectStore, fetchImpl } = dependencies;
  try {
    const image = await generateAssetImage(target, {
      assetKey: lease.assetKey,
      assetType: lease.assetType,
      description: lease.description,
      generationPrompt: lease.generationPrompt,
      dimensions: lease.dimensions,
      frameCount: lease.frameCount,
    }, fetchImpl);
    const extension = generatedImageExtension(image.contentType);
    if (!extension) throw new Error("生成的图片格式不受支持");
    // Store first, then record: an orphaned object is swept with the project,
    // whereas a row pointing at a missing object breaks the build that reads it.
    const stored = await objectStore.putProjectAsset({
      workspaceId: lease.workspaceId,
      projectId: lease.projectId,
      assetKey: lease.assetKey,
      extension,
      contentType: image.contentType,
      content: image.content,
    });
    return await repository.assets.completeGeneration({
      workspaceId: lease.workspaceId,
      itemId: lease.itemId,
      bucket: stored.bucket,
      objectKey: stored.key,
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "图片生成失败";
    // Releasing the lease is what allows a retry, so a failure here would strand
    // the item until the lease expires. Log it and let expiry recover.
    await repository.assets.failGeneration(lease.workspaceId, lease.itemId, message)
      .catch(reason => console.error(JSON.stringify({
        level: "error",
        event: "asset_generation_release_failed",
        itemId: lease.itemId,
        message: reason instanceof Error ? reason.message : String(reason),
      })));
    console.error(JSON.stringify({
      level: "warn",
      event: "asset_generation_failed",
      itemId: lease.itemId,
      assetKey: lease.assetKey,
      attempt: lease.attempt,
      message,
    }));
    return false;
  }
}
