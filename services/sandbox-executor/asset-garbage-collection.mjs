import { lstat, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";

const SOURCE_IMAGE = /\.(?:png|jpe?g|webp|svg)$/i;

export function retiredSourceImagePaths(previousManifest, currentManifest) {
  const previous = sourceItems(previousManifest);
  if (previous.length === 0 || !manifestItems(currentManifest)) return [];

  const currentItems = manifestItems(currentManifest);
  const currentKeys = new Set(currentItems.map(item => item?.assetKey).filter(value => typeof value === "string"));
  const retainedPaths = new Set(
    currentItems.map(item => safeSourcePath(item?.sourcePath)).filter(Boolean),
  );
  for (const item of previous) {
    if (currentKeys.has(item.assetKey)) retainedPaths.add(item.sourcePath);
  }

  return [...new Set(previous.map(item => item.sourcePath))]
    .filter(sourcePath => !retainedPaths.has(sourcePath))
    .sort();
}

export async function removeRetiredSourceImages(root, previousManifest, currentManifest) {
  const normalizedRoot = resolve(root);
  const removed = [];
  for (const sourcePath of retiredSourceImagePaths(previousManifest, currentManifest)) {
    const target = resolve(normalizedRoot, sourcePath);
    if (!target.startsWith(`${normalizedRoot}${sep}`)) continue;
    try {
      const info = await lstat(target);
      if (!info.isFile()) continue;
      await rm(target);
      removed.push(sourcePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return removed;
}

function sourceItems(manifest) {
  const items = manifestItems(manifest);
  if (!items) return [];
  return items.flatMap(item => {
    const sourcePath = item?.status === "existing" ? safeSourcePath(item.sourcePath) : null;
    return sourcePath && typeof item.assetKey === "string"
      ? [{ assetKey: item.assetKey, sourcePath }]
      : [];
  });
}

function manifestItems(manifest) {
  return manifest?.assetManifest?.schemaVersion === "deviludo.asset-manifest.v1"
    && Array.isArray(manifest.assetManifest.items)
    ? manifest.assetManifest.items
    : null;
}

function safeSourcePath(value) {
  return typeof value === "string"
    && value.length <= 500
    && !value.startsWith("/")
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value)
    && SOURCE_IMAGE.test(value)
    ? value
    : null;
}
