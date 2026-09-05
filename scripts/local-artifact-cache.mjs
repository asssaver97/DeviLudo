import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGING_DIRECTORY = /^\.staging-[0-9a-f-]{36}-[0-9a-f-]{36}$/i;

export async function synchronizeLocalArtifactCache(root, projectId, artifactIds) {
  const keep = new Set(artifactIds);
  const entries = await readdir(root, { withFileTypes: true }).catch(error => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  let removed = 0;
  let retained = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue;
    const removable = UUID.test(entry.name) || STAGING_DIRECTORY.test(entry.name);
    if (!removable) continue;
    const directory = join(root, entry.name);
    if (STAGING_DIRECTORY.test(entry.name)) {
      await rm(directory, { recursive: true, force: true });
      removed += 1;
      continue;
    }
    const metadataPath = join(directory, "artifact.json");
    const metadata = await readMetadata(metadataPath);
    if (keep.has(entry.name) && metadata
      && (!metadata.projectId || metadata.projectId === projectId)) {
      if (metadata.projectId !== projectId) {
        await writeFile(metadataPath, `${JSON.stringify({ ...metadata, projectId })}\n`, { mode: 0o600 });
      }
      retained += 1;
      continue;
    }
    if (!metadata?.projectId || metadata.projectId === projectId) {
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    }
  }
  return Object.freeze({ removed, retained });
}

async function readMetadata(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
