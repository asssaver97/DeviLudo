import { constants } from "node:fs";
import { mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { RuntimeFile } from "../../../lib/agent/types";
import type { RuntimeFileMaterializer } from "./contracts";

export class SecureRuntimeFileMaterializer implements RuntimeFileMaterializer {
  async materialize(workerRunRoot: string, files: readonly RuntimeFile[]): Promise<void> {
    const normalizedRoot = requireAbsoluteNormalized(workerRunRoot, "Worker run root");
    const resolvedRoot = await realpath(normalizedRoot);
    if (resolvedRoot !== normalizedRoot) throw new Error("Worker run root must not be a symbolic link");

    const created: string[] = [];
    try {
      for (const file of files) {
        validateRuntimeFile(file);
        const destination = path.resolve(normalizedRoot, file.relativePath);
        requireWithin(normalizedRoot, destination, "Runtime file");
        const parent = path.dirname(destination);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const resolvedParent = await realpath(parent);
        if (resolvedParent !== parent) throw new Error("Runtime file parent must not contain symbolic links");
        requireWithin(resolvedRoot, resolvedParent, "Runtime file parent");

        const descriptor = await open(
          destination,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          file.mode,
        );
        created.push(destination);
        try {
          await descriptor.writeFile(file.contents, { encoding: "utf8" });
          await descriptor.chmod(file.mode);
          await descriptor.sync();
        } finally {
          await descriptor.close();
        }
      }
    } catch (error) {
      await Promise.all(created.map((file) => unlink(file).catch(() => undefined)));
      throw new Error(`Runtime files could not be materialized: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}

function validateRuntimeFile(file: RuntimeFile): void {
  if (
    !file.relativePath ||
    file.relativePath.includes("\0") ||
    file.relativePath.includes("\\") ||
    path.posix.isAbsolute(file.relativePath) ||
    path.posix.normalize(file.relativePath) !== file.relativePath ||
    file.relativePath.split("/").includes("..")
  ) {
    throw new Error("Runtime file path is unsafe");
  }
  if (file.mode !== 0o400 && file.mode !== 0o600) throw new Error("Runtime file mode is not permitted");
  if (Buffer.byteLength(file.contents, "utf8") > 1024 * 1024) throw new Error("Runtime file exceeds the 1 MiB limit");
}

function requireAbsoluteNormalized(value: string, label: string): string {
  if (!path.isAbsolute(value) || value.includes("\0") || path.resolve(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return value;
}

function requireWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the permitted run root`);
  }
}
