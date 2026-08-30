// Asynchronous asset generation.
//
// The Agent plans assets and writes their prompts while generating the source
// that consumes them; this turns those prompts into images. It runs on the
// scheduler tick rather than consuming a serial delivery worker. The workflow's
// DEVELOPING gate waits for every required image (or an explicit user
// placeholder choice), then freezes the settled objects into BUILD.

import type { AgentSecretStore } from "./agent-settings";
import sharp from "sharp";
import type { AssetGenerationLease } from "./asset-manifest";
import { runCodexImage, type CodexImageRunner } from "./codex-cli";
import {
  composeImagePrompt,
  generateAssetImage,
  generatedImageExtension,
  validateGeneratedImage,
  type FetchLike,
  type GeneratedImage,
  type ImageGenerationTarget,
} from "./image-generation";
import type { CoreObjectStore } from "./object-store";
import type { CoreRepository } from "./repository";

/**
 * The lease has to outlive the slowest runtime backend, or a still-running
 * generation gets re-claimed by the next tick. It covers the five-minute Codex
 * turn plus validation and the object-store write.
 */
const LEASE_SECONDS = 600;

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
  codexImageRunner?: CodexImageRunner;
}>;

export type AssetGenerationOutcome = Readonly<{
  claimed: number;
  generated: number;
  failed: number;
}>;

const IDLE: AssetGenerationOutcome = Object.freeze({ claimed: 0, generated: 0, failed: 0 });

type ResolvedImageBackend = Readonly<{
  kind: "HTTP_IMAGES";
  target: ImageGenerationTarget;
}> | Readonly<{
  kind: "CODEX_IMAGEGEN";
  baseUrl: string;
  credential: string;
  model: string;
  runner: CodexImageRunner;
}>;

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
  // Resolve the selected runtime's credential once per batch. It remains in
  // the protected store until the selected backend is invoked.
  const settings = await repository.readAgentSettings();
  if (!settings) return IDLE;
  // Claude has no image backend until an explicit image model is selected. Do
  // not read Vault on an idle scheduler tick when no generation can start.
  if (settings.agentRuntime === "CLAUDE_CODE" && !settings.imageModel) return IDLE;
  const credential = await secrets.readApiKey(settings.credentialSecretRef);
  if (!credential) return IDLE;
  const backend = resolveImageBackend(settings, credential, dependencies.codexImageRunner ?? runCodexImage);
  if (!backend) return IDLE;

  // A Codex ImageGen turn includes model orchestration as well as rendering, so
  // claim one item at a time. HTTP image endpoints can safely retain the wider
  // batch without letting unstarted Codex leases expire in the queue.
  const leases = await repository.assets.claimGeneration(
    LEASE_SECONDS,
    backend.kind === "CODEX_IMAGEGEN" ? 1 : BATCH_SIZE,
  );
  if (leases.length === 0) return IDLE;

  let generated = 0;
  let failed = 0;
  for (const lease of leases) {
    // An abort between items leaves the rest leased; their leases expire and the
    // next process picks them up, which is why the lease exists.
    if (signal?.aborted) break;
    const settled = await generateOne(dependencies, backend, lease);
    if (settled) generated += 1;
    else failed += 1;
  }
  return Object.freeze({ claimed: leases.length, generated, failed });
}

function resolveImageBackend(
  settings: Awaited<ReturnType<CoreRepository["readAgentSettings"]>>,
  credential: string,
  codexImageRunner: CodexImageRunner,
): ResolvedImageBackend | null {
  if (!settings) return null;
  if (settings.agentRuntime === "CODEX_CLI") {
    return Object.freeze({
      kind: "CODEX_IMAGEGEN",
      baseUrl: settings.baseUrl,
      credential,
      model: settings.primaryModel,
      runner: codexImageRunner,
    });
  }
  if (!settings.imageModel) return null;
  return Object.freeze({
    kind: "HTTP_IMAGES",
    target: Object.freeze({
      baseUrl: settings.baseUrl,
      model: settings.imageModel,
      apiKey: credential,
    }),
  });
}

async function generateOne(
  dependencies: AssetGenerationDependencies,
  backend: ResolvedImageBackend,
  lease: AssetGenerationLease,
): Promise<boolean> {
  const { repository, objectStore, fetchImpl } = dependencies;
  try {
    const request = {
      assetKey: lease.assetKey,
      assetType: lease.assetType,
      description: lease.description,
      generationPrompt: lease.generationPrompt,
      dimensions: lease.dimensions,
      frameCount: lease.frameCount,
    } as const;
    const image = backend.kind === "HTTP_IMAGES"
      ? await generateAssetImage(backend.target, request, fetchImpl)
      : await generateWithCodex(backend, request);
    const normalized = image.contentType === "image/png" ? image.content : await sharp(image.content)
      .png({ compressionLevel: 9 })
      .toBuffer();
    const extension = generatedImageExtension("image/png");
    if (!extension) throw new Error("生成的图片格式不受支持");
    // Store first, then record: an orphaned object is swept with the project,
    // whereas a row pointing at a missing object breaks the build that reads it.
    const stored = await objectStore.putProjectAsset({
      workspaceId: lease.workspaceId,
      projectId: lease.projectId,
      assetKey: lease.assetKey,
      extension,
      contentType: "image/png",
      content: normalized,
    });
    return await repository.assets.completeGeneration({
      workspaceId: lease.workspaceId,
      itemId: lease.itemId,
      leaseToken: lease.leaseToken,
      bucket: stored.bucket,
      objectKey: stored.key,
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "图片生成失败";
    // Releasing the lease is what allows a retry, so a failure here would strand
    // the item until the lease expires. Log it and let expiry recover.
    await repository.assets.failGeneration(lease.workspaceId, lease.itemId, lease.leaseToken, message)
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

async function generateWithCodex(
  backend: Extract<ResolvedImageBackend, { kind: "CODEX_IMAGEGEN" }>,
  request: Parameters<typeof composeImagePrompt>[0],
): Promise<GeneratedImage> {
  const content = await backend.runner({
    baseUrl: backend.baseUrl,
    credential: backend.credential,
    model: backend.model,
    prompt: composeImagePrompt(request),
    timeoutMs: 300_000,
  });
  return validateGeneratedImage(content);
}
