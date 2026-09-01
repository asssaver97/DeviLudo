const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Convert Core's private image envelope into native MCP image content. */
export function formatProjectToolResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return Object.freeze({ content: Object.freeze([{ type: "text", text: JSON.stringify(result) }]) });
  }
  const candidates = Array.isArray(result.evidenceImages) ? result.evidenceImages : [];
  const images = candidates.slice(0, MAX_IMAGES).map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || !IMAGE_MIME_TYPES.has(candidate.mimeType) || typeof candidate.data !== "string"
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(candidate.data)) {
      throw new Error(`Project evidence image ${index + 1} is invalid`);
    }
    const sizeBytes = Buffer.byteLength(candidate.data, "base64");
    if (sizeBytes < 1 || sizeBytes > MAX_IMAGE_BYTES || sizeBytes !== candidate.sizeBytes) {
      throw new Error(`Project evidence image ${index + 1} size is invalid`);
    }
    return Object.freeze({
      metadata: Object.freeze({
        runId: candidate.runId,
        targetPlatform: candidate.targetPlatform,
        checkpointId: candidate.checkpointId,
        checkpointRole: candidate.checkpointRole,
        mimeType: candidate.mimeType,
        sizeBytes,
        contentIndex: Number.isInteger(candidate.contentIndex) && candidate.contentIndex > 0
          ? candidate.contentIndex : index + 1,
      }),
      content: Object.freeze({ type: "image", data: candidate.data, mimeType: candidate.mimeType }),
    });
  });
  const structuredContent = Object.freeze({
    ...result,
    ...(Object.hasOwn(result, "evidenceImages")
      ? { evidenceImages: Object.freeze(images.map(image => image.metadata)) }
      : {}),
  });
  return Object.freeze({
    content: Object.freeze([
      Object.freeze({ type: "text", text: JSON.stringify(structuredContent) }),
      ...images.map(image => image.content),
    ]),
    structuredContent,
  });
}
