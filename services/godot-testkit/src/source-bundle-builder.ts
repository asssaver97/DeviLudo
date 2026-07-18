import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const TAR_BLOCK = 512;
const MAX_FILES = 100_000;
const MAX_DIRECTORIES = 100_000;
const MAX_DEPTH = 32;
const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;

interface SourceEntry {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface CreatedSourceBundle {
  readonly files: number;
  readonly totalBytes: number;
  readonly sizeBytes: number;
  readonly artifactDigest: string;
}

/** Creates the deterministic counterpart of extractSourceBundle from a trusted SCM snapshot. */
export async function createSourceBundle(
  sourceRootPath: string,
  destinationPath: string,
): Promise<CreatedSourceBundle> {
  const sourceRoot = await canonicalDirectory(sourceRootPath);
  const destination = absolute(destinationPath, "source bundle destination");
  if (destination.startsWith(`${sourceRoot}${sep}`)) invalid("source bundle destination boundary");
  const entries = await scanSource(sourceRoot);
  const project = entries.find((entry) => entry.name === "project.godot");
  if (!project || project.size < 16 || project.size > 4 * 1024 * 1024) invalid("Godot project marker");
  let created = false;
  try {
    const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
    created = true;
    await pipeline(
      Readable.from(tarChunks(entries)),
      createZstdCompress(),
      output,
    );
    const after = await scanSource(sourceRoot);
    if (snapshotIdentity(after) !== snapshotIdentity(entries)) invalid("source snapshot mutation");
    const artifact = await hashRegularFile(destination);
    if (process.platform !== "win32") await chmod(destination, 0o400);
    return Object.freeze({
      files: entries.length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      ...artifact,
    });
  } catch (error) {
    if (created) await unlink(destination).catch(() => undefined);
    throw error;
  }
}

async function scanSource(root: string): Promise<readonly SourceEntry[]> {
  const entries: SourceEntry[] = [];
  let directories = 0;
  let totalBytes = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) invalid("source tree depth");
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const path = join(directory, child.name);
      const metadata = await lstat(path);
      const name = relative(root, path).split(sep).join("/");
      validateSourceName(name);
      if (metadata.isSymbolicLink()) invalid("source symlink");
      if (metadata.isDirectory()) {
        directories += 1;
        if (directories > MAX_DIRECTORIES) invalid("source directory count");
        await visit(path, depth + 1);
        continue;
      }
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES || entries.length >= MAX_FILES) invalid("source file");
      totalBytes += metadata.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) invalid("source total size");
      entries.push(Object.freeze({
        name,
        path,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
      }));
    }
  };
  await visit(root, 0);
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (entries.length < 1) invalid("source contents");
  return Object.freeze(entries);
}

async function* tarChunks(entries: readonly SourceEntry[]): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    yield tarHeader(entry.name, entry.size);
    const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    const file = await open(entry.path, flags);
    try {
      const opened = await file.stat();
      assertIdentity(opened, entry);
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < entry.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, entry.size - position), position);
        if (bytesRead < 1) invalid("source file read");
        position += bytesRead;
        yield Buffer.from(buffer.subarray(0, bytesRead));
      }
      assertIdentity(await file.stat(), entry);
    } finally { await file.close(); }
    const padding = (TAR_BLOCK - (entry.size % TAR_BLOCK)) % TAR_BLOCK;
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(TAR_BLOCK * 2);
}

function tarHeader(path: string, size: number): Buffer {
  const { name, prefix } = splitTarPath(path);
  const header = Buffer.alloc(TAR_BLOCK);
  writeAscii(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = 48;
  writeAscii(header, 257, 6, "ustar");
  writeAscii(header, 263, 2, "00");
  writeAscii(header, 265, 32, "deviludo");
  writeAscii(header, 297, 32, "deviludo");
  if (prefix) writeAscii(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeAscii(header, 148, 6, checksum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 32;
  return header;
}

function splitTarPath(value: string): { name: string; prefix: string } {
  if (Buffer.byteLength(value, "ascii") <= 100) return { name: value, prefix: "" };
  for (let index = value.lastIndexOf("/"); index > 0; index = value.lastIndexOf("/", index - 1)) {
    const prefix = value.slice(0, index);
    const name = value.slice(index + 1);
    if (Buffer.byteLength(prefix, "ascii") <= 155 && Buffer.byteLength(name, "ascii") <= 100) return { name, prefix };
  }
  invalid("source tar path");
}

function validateSourceName(value: string): void {
  if (!value || value.length > 255 || value.startsWith("/") || value.includes("\\") || /[\0\r\n]/.test(value)
    || value.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || !/^[\x20-\x7e]+$/.test(part))) {
    invalid("source path");
  }
}

function assertIdentity(metadata: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>, entry: SourceEntry): void {
  if (!metadata.isFile() || metadata.size !== entry.size || metadata.mtimeMs !== entry.mtimeMs || metadata.ctimeMs !== entry.ctimeMs) {
    invalid("source snapshot mutation");
  }
}

function snapshotIdentity(entries: readonly SourceEntry[]): string {
  return JSON.stringify(entries.map(({ name, size, mtimeMs, ctimeMs }) => ({ name, size, mtimeMs, ctimeMs })));
}

async function hashRegularFile(path: string): Promise<Readonly<{ sizeBytes: number; artifactDigest: string }>> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 16) invalid("source bundle output");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return Object.freeze({ sizeBytes: metadata.size, artifactDigest: hash.digest("hex") });
}

async function canonicalDirectory(value: string): Promise<string> {
  const path = absolute(value, "source root");
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("source root");
  return canonical;
}

function absolute(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) invalid(label);
  return value;
}

function writeAscii(target: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, "ascii");
  if (encoded.byteLength > length) invalid("source tar field");
  encoded.copy(target, offset);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) invalid("source tar numeric field");
  writeAscii(target, offset, length - 1, encoded);
  target[offset + length - 1] = 0;
}

function invalid(label: string): never {
  throw new Error(`Godot TestKit ${label} is invalid`);
}
