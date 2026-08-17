// Image generation through the selected Agent Provider connection.
//
// Asset generation deliberately runs outside the delivery chain and outside the
// sandbox executor: it is a plain HTTP call to a configured provider, the same
// shape as the design Agent's conversation calls in `product-conversation.ts`.
// Giving it a job kind would put it back on the serial chain it was taken off.

export type FetchLike = typeof globalThis.fetch;

/** What the generator needs about an asset to render a prompt. */
export type AssetGenerationRequest = Readonly<{
  assetKey: string;
  assetType: string;
  description: string;
  generationPrompt: string;
  dimensions: string | null;
  frameCount: number | null;
}>;

export type ImageGenerationTarget = Readonly<{
  baseUrl: string;
  model: string;
  apiKey: string;
}>;

export type GeneratedImage = Readonly<{
  content: Buffer;
  contentType: string;
}>;

/** Bounds the decoded image so one oversized response cannot exhaust memory. */
export const MAX_GENERATED_IMAGE_BYTES = 8 * 1024 * 1024;

const PROVIDER_TIMEOUT_MS = 120_000;

/**
 * Only these image types are accepted, matching what the upload route allows and
 * what Godot imports without extra configuration.
 */
const ACCEPTED_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
});

export function generatedImageExtension(contentType: string): string | null {
  return ACCEPTED_CONTENT_TYPES[contentType] ?? null;
}

/**
 * Compose the text sent to the model. The Agent already wrote a technical prompt
 * while generating the source that consumes the asset, so this only appends the
 * constraints the Agent expressed as separate fields — restating them in prose is
 * what makes the model honour them.
 */
export function composeImagePrompt(request: AssetGenerationRequest): string {
  const parts = [request.generationPrompt];
  if (request.frameCount && request.frameCount > 1) {
    parts.push(`Exactly ${request.frameCount} animation frames laid out left to right in a single horizontal strip, evenly spaced, identical frame size.`);
  }
  if (request.dimensions) {
    parts.push(`Target size per frame: ${request.dimensions} pixels.`);
  }
  if (request.assetType === "sprite" || request.assetType === "animation" || request.assetType === "icon" || request.assetType === "ui") {
    parts.push("Fully transparent background, no drop shadow, no backdrop, no framing border.");
  }
  parts.push("No text, no watermark, no signature, no UI chrome that is not part of the asset itself.");
  return parts.join(" ");
}

/**
 * The selected connection uses the OpenAI-compatible image endpoint. Request a
 * standard generation aspect and let the game's importer handle final sizing.
 */
function imageSize(dimensions: string | null): "1024x1024" | "1792x1024" | "1024x1792" {
  const match = dimensions?.match(/^(\d{1,5})x(\d{1,5})$/);
  if (!match) return "1024x1024";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return "1024x1024";
  const ratio = width / height;
  if (ratio >= 1.5) return "1792x1024";
  if (ratio <= 1 / 1.5) return "1024x1792";
  return "1024x1024";
}

function imageEndpoint(target: ImageGenerationTarget): string {
  const url = new URL(target.baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/images/generations`.replace(/\/{2,}/g, "/");
  return url.href;
}

function providerSignal(): AbortSignal {
  return AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
}

/**
 * Generate one asset image.
 *
 * Errors carry the provider status but never the response body: a provider that
 * echoes the request could put the prompt — and in a misconfiguration, the
 * credential — into an error string that lands in `asset_items.error_message` and
 * is rendered in the browser.
 */
export async function generateAssetImage(
  target: ImageGenerationTarget,
  request: AssetGenerationRequest,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<GeneratedImage> {
  const prompt = composeImagePrompt(request);
  return generateWithSelectedConnection(target, request, prompt, fetchImpl);
}

async function generateWithSelectedConnection(
  target: ImageGenerationTarget,
  request: AssetGenerationRequest,
  prompt: string,
  fetchImpl: FetchLike,
): Promise<GeneratedImage> {
  const response = await fetchImpl(imageEndpoint(target), {
    method: "POST",
    headers: {
      authorization: `Bearer ${target.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: target.model,
      prompt,
      n: 1,
      size: imageSize(request.dimensions),
      response_format: "b64_json",
    }),
    signal: providerSignal(),
  });
  if (!response.ok) throw new Error(`图片生成失败（Provider ${response.status}）`);
  const body = await response.json() as { data?: readonly { b64_json?: unknown }[] };
  const encoded = body.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || !encoded) throw new Error("图片生成未返回图像数据");
  return decodeBase64Image(encoded);
}

/**
 * Decode a base64 image from a provider response.
 *
 * The type comes from the bytes, not from what the provider said it sent: a
 * provider returning an HTML error page in the image field would otherwise be
 * stored as a PNG and reach the game as a corrupt texture.
 */
function decodeBase64Image(encoded: string): GeneratedImage {
  const content = Buffer.from(encoded, "base64");
  if (content.length < 1) throw new Error("图片生成返回的图像为空");
  if (content.length > MAX_GENERATED_IMAGE_BYTES) throw new Error("生成的图片超出大小上限");
  const contentType = sniffContentType(content);
  if (!contentType) throw new Error("生成的图片格式不受支持");
  return Object.freeze({ content, contentType });
}

/**
 * Identify the image from its magic number. This is what decides the stored
 * content type and extension, so a provider cannot get an arbitrary file into the
 * asset bucket by lying in a header.
 */
export function sniffContentType(content: Buffer): string | null {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return "image/jpeg";
  }
  if (content.length >= 12
    && content.subarray(0, 4).toString("latin1") === "RIFF"
    && content.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}
