import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { isManagedSmokeProjectId } from "../../../lib/local-smoke-project";

type Removal = Readonly<{ root: string; target: string }>;

/**
 * Deletes only exact, platform-generated smoke project directories. Every
 * candidate is validated before the first removal so a symlink or unexpected
 * file makes the whole request fail closed without partially deleting state.
 */
export async function cleanupLocalSmokeStorage(
  storageRoots: readonly string[],
  projectIds: readonly string[],
): Promise<Readonly<{ removedPaths: number; projectIds: readonly string[] }>> {
  if (!storageRoots.length || projectIds.some((projectId) => !isManagedSmokeProjectId(projectId))) invalid();
  if (new Set(projectIds).size !== projectIds.length) invalid();

  const removals: Removal[] = [];
  for (const configuredRoot of storageRoots) {
    const root = path.resolve(configuredRoot);
    const rootMetadata = await metadata(root);
    if (!rootMetadata) continue;
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) invalid();
    const rootReal = await realpath(root);
    for (const projectId of projectIds) {
      for (const relative of [projectId, path.join(".scm", projectId), path.join(".executions", projectId)]) {
        const target = path.join(rootReal, relative);
        requireWithin(rootReal, target);
        const parent = path.dirname(target);
        const parentMetadata = await metadata(parent);
        if (!parentMetadata) continue;
        if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) invalid();
        const targetMetadata = await metadata(target);
        if (!targetMetadata) continue;
        if (!targetMetadata.isDirectory() || targetMetadata.isSymbolicLink()) invalid();
        const targetReal = await realpath(target);
        requireWithin(rootReal, targetReal);
        if (targetReal !== target) invalid();
        removals.push(Object.freeze({ root: rootReal, target }));
      }
    }
  }

  for (const removal of removals) {
    requireWithin(removal.root, removal.target);
    await rm(removal.target, { recursive: true, force: false, maxRetries: 2 });
  }
  return Object.freeze({ removedPaths: removals.length, projectIds: Object.freeze([...projectIds]) });
}

async function metadata(target: string) {
  try { return await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function requireWithin(root: string, target: string): void {
  if (target === root || !target.startsWith(`${root}${path.sep}`)) invalid();
}

function invalid(): never {
  throw new Error("Local smoke storage cleanup target is invalid");
}
