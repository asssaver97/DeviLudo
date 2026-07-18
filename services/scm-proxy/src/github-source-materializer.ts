import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { GitHubRepositoryBinding, GitHubSourceTreeConnector } from "./github-contracts";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FILES = 100_000;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;

export interface GitHubSourceMaterializationInput {
  readonly binding: GitHubRepositoryBinding;
  readonly commitSha: string;
  readonly expectedSourceDigest: string;
  readonly destinationPath: string;
}

/** Materializes one verified Git tree without invoking Git or accepting links/submodules. */
export class GitHubSourceMaterializer {
  constructor(private readonly connector: GitHubSourceTreeConnector) {}

  async materialize(input: GitHubSourceMaterializationInput): Promise<Readonly<{ sourceDigest: string }>> {
    if (!SHA1.test(input.commitSha) || !SHA256.test(input.expectedSourceDigest)) invalid("binding");
    const destination = absolute(input.destinationPath);
    await requireAbsent(destination);
    const parent = dirname(destination);
    if (await realpath(parent) !== parent) invalid("destination parent");
    const tree = await this.connector.getSourceTree(input.binding, input.commitSha);
    if (tree.commitSha !== input.commitSha || tree.sourceDigest !== input.expectedSourceDigest
      || !SHA1.test(tree.treeSha) || tree.entries.length < 1 || tree.entries.length > MAX_FILES) invalid("tree receipt");
    await mkdir(destination, { recursive: false, mode: 0o700 });
    if (process.platform !== "win32") await chmod(destination, 0o700);
    const canonicalRoot = await realpath(destination);
    if (canonicalRoot !== destination) invalid("destination");
    let totalBytes = 0;
    for (const entry of tree.entries) {
      validateEntry(entry.path, entry.mode, entry.type, entry.sha);
      const content = await this.connector.getBlob(input.binding, entry.sha);
      if (!Buffer.isBuffer(content)) invalid("blob receipt");
      totalBytes += content.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) invalid("total size");
      const target = resolve(canonicalRoot, ...entry.path.split("/"));
      if (!target.startsWith(`${canonicalRoot}${sep}`)) invalid("path boundary");
      const targetParent = dirname(target);
      await mkdir(targetParent, { recursive: true, mode: 0o700 });
      await verifyParents(canonicalRoot, targetParent);
      const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
        if (process.platform !== "win32") await file.chmod(entry.mode === "100755" ? 0o700 : 0o600);
      } finally { await file.close(); }
    }
    return Object.freeze({ sourceDigest: input.expectedSourceDigest });
  }
}

async function verifyParents(root: string, parent: string): Promise<void> {
  const relative = parent.slice(root.length + (parent === root ? 0 : 1));
  let current = root;
  for (const part of relative ? relative.split(sep) : []) {
    current = resolve(current, part);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("parent directory");
  }
}

function validateEntry(path: string, mode: string, type: string, sha: string): void {
  if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !SHA1.test(sha)
    || !path || path.length > 255 || path.startsWith("/") || path.includes("\\") || /[\0\r\n]/.test(path)
    || path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git"
      || !/^[\x20-\x7e]+$/.test(part))) invalid("tree entry");
}

async function requireAbsent(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  invalid("destination collision");
}

function absolute(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) invalid("destination");
  return value;
}

function invalid(label: string): never {
  throw new Error(`GitHub source materialization ${label} is invalid`);
}
