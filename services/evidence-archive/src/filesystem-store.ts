import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ImmutableObjectPut, ImmutableObjectStore } from "./contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;

/** Local/integration backend. Production startup rejects it. */
export class FilesystemImmutableObjectStore implements ImmutableObjectStore {
  readonly #configuredRoot: string;
  #rootPromise: Promise<string> | null = null;

  constructor(options: { readonly root: string }) {
    if (!isAbsolute(options.root) || resolve(options.root) !== options.root
      || options.root.length > 4_096 || /\0/.test(options.root)) {
      throw new Error("Evidence archive filesystem root is invalid");
    }
    this.#configuredRoot = options.root;
  }

  async putImmutable(input: ImmutableObjectPut): Promise<Readonly<{ created: boolean }>> {
    validatePut(input);
    const root = await this.#root();
    const path = join(root, ...input.objectKey.split("/"));
    const parent = await prepareParent(dirname(path), root);
    const canonicalPath = join(parent, input.objectKey.split("/").at(-1)!);
    try {
      const current = await digestExisting(canonicalPath);
      if (current !== input.contentDigest) conflict();
      return Object.freeze({ created: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = join(parent, `.${input.contentDigest}.${randomUUID()}.tmp`);
    let exists = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      exists = true;
      try {
        await file.writeFile(input.body);
        await file.sync();
      } finally {
        await file.close();
      }
      if (await digestExisting(temporary) !== input.contentDigest) conflict();
      if (process.platform !== "win32") await chmod(temporary, 0o400);
      try {
        // Hard-link creation is the portable no-replace primitive here. A
        // normal POSIX rename could silently overwrite an immutable object.
        await link(temporary, canonicalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await digestExisting(canonicalPath) !== input.contentDigest) conflict();
        return Object.freeze({ created: false });
      }
      await unlink(temporary);
      exists = false;
      await syncDirectory(parent);
      return Object.freeze({ created: true });
    } finally {
      if (exists) await unlink(temporary).catch(() => undefined);
    }
  }

  async probe(): Promise<void> {
    const root = await this.#root();
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Evidence archive filesystem backend is unavailable");
    }
  }

  #root(): Promise<string> {
    this.#rootPromise ??= prepareRoot(this.#configuredRoot);
    return this.#rootPromise;
  }
}

async function prepareRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const configured = await lstat(root);
  if (!configured.isDirectory() || configured.isSymbolicLink()) {
    throw new Error("Evidence archive filesystem root is invalid");
  }
  const canonical = await realpath(root);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Evidence archive filesystem root is invalid");
  }
  if (process.platform !== "win32") await chmod(canonical, 0o700);
  return canonical;
}

async function prepareParent(path: string, root: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  const traversal = relative(root, canonical);
  if (!traversal || traversal.startsWith(`..${sep}`) || traversal === ".." || isAbsolute(traversal)) {
    throw new Error("Evidence archive object path escaped its root");
  }
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Evidence archive object directory is invalid");
  }
  if (process.platform !== "win32") await chmod(canonical, 0o700);
  return canonical;
}

async function digestExisting(path: string): Promise<string> {
  const pathMetadata = await lstat(path);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()
    || pathMetadata.size < 2 || pathMetadata.size > MAX_OBJECT_BYTES) conflict();
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== pathMetadata.size) conflict();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, metadata.size - position), position);
      if (bytesRead < 1) conflict();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) conflict();
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EINVAL" && code !== "EPERM" && code !== "EBADF")) throw error;
  } finally {
    await directory.close();
  }
}

function validatePut(input: ImmutableObjectPut): void {
  const parts = input.objectKey.split("/");
  if (input.contentType !== "application/json" || !SHA256.test(input.contentDigest)
    || input.body.byteLength < 2 || input.body.byteLength > MAX_OBJECT_BYTES
    || input.objectKey.length < 3 || input.objectKey.length > 1_024
    || parts.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._:-]+$/.test(part))) {
    throw new Error("Evidence archive immutable object is invalid");
  }
  const observed = createHash("sha256").update(input.body).digest("hex");
  if (observed !== input.contentDigest) conflict();
}

function conflict(): never {
  throw new Error("Evidence archive immutable object conflicts with stored content");
}
