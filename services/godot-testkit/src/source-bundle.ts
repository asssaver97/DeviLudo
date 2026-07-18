import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { createZstdDecompress } from "node:zlib";
import { isAbsolute, join, resolve, sep } from "node:path";

const TAR_BLOCK = 512;
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;

export interface ExtractedSourceBundle {
  readonly files: number;
  readonly directories: number;
  readonly totalBytes: number;
}

/** Extracts the platform-defined Zstandard-compressed USTAR subset. */
export async function extractSourceBundle(
  archivePath: string,
  destinationRoot: string,
): Promise<ExtractedSourceBundle> {
  const archive = absolute(archivePath, "source archive");
  const destination = absolute(destinationRoot, "source destination");
  const archiveMetadata = await lstat(archive);
  if (!archiveMetadata.isFile() || archiveMetadata.isSymbolicLink() || archiveMetadata.size < 16) invalid("source archive");
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const destinationMetadata = await lstat(destination);
  if (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink()) invalid("source destination");
  const canonicalRoot = await realpath(destination);
  if (!isAbsolute(canonicalRoot)) invalid("source destination");
  if (process.platform !== "win32") await chmod(canonicalRoot, 0o700);

  const decompressed = createReadStream(archive).pipe(createZstdDecompress());
  const reader = new ExactStreamReader(decompressed);
  const seen = new Set<string>();
  let files = 0;
  let directories = 0;
  let totalBytes = 0;
  let terminated = false;
  try {
    while (true) {
      const header = await reader.read(TAR_BLOCK);
      if (allZero(header)) {
        const second = await reader.read(TAR_BLOCK);
        if (!allZero(second)) invalid("tar terminator");
        terminated = true;
        await reader.assertRemainingZero();
        break;
      }
      verifyTarChecksum(header);
      const relative = tarPath(header);
      if (seen.has(relative) || seen.size >= MAX_FILES || relative === ".git" || relative.startsWith(".git/")) {
        invalid("tar path set");
      }
      seen.add(relative);
      const size = tarOctal(header.subarray(124, 136), "tar file size");
      const type = header[156] ?? 0;
      const target = boundedTarget(canonicalRoot, relative);
      if (type === 53) {
        if (size !== 0) invalid("tar directory size");
        await mkdir(target, { recursive: true, mode: 0o700 });
        const metadata = await lstat(target);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("tar directory");
        if (process.platform !== "win32") await chmod(target, 0o700);
        directories += 1;
        continue;
      }
      if (type !== 0 && type !== 48) invalid("tar entry type");
      if (size < 0 || size > MAX_FILE_BYTES || totalBytes + size > MAX_TOTAL_BYTES) invalid("tar content size");
      await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
      await assertParents(canonicalRoot, target);
      const output = await open(target, "wx", 0o600);
      try {
        let remaining = size;
        while (remaining > 0) {
          const chunk = await reader.read(Math.min(remaining, 1024 * 1024));
          await writeAll(output, chunk);
          remaining -= chunk.byteLength;
        }
        await output.sync();
      } finally { await output.close(); }
      const padding = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
      if (padding && !allZero(await reader.read(padding))) invalid("tar padding");
      files += 1;
      totalBytes += size;
    }
  } finally {
    decompressed.destroy();
  }
  if (!terminated || files < 1) invalid("source archive contents");
  const project = await lstat(join(canonicalRoot, "project.godot"));
  if (!project.isFile() || project.isSymbolicLink() || project.size < 16 || project.size > 4 * 1024 * 1024) {
    invalid("Godot project marker");
  }
  return Object.freeze({ files, directories, totalBytes });
}

class ExactStreamReader {
  readonly #iterator: AsyncIterator<Buffer | string>;
  #buffer: Buffer = Buffer.alloc(0);
  #ended = false;

  constructor(stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>) {
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  async read(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024) invalid("stream read length");
    while (this.#buffer.byteLength < length && !this.#ended) {
      const next = await this.#iterator.next();
      if (next.done) { this.#ended = true; break; }
      const value = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (value.byteLength) this.#buffer = this.#buffer.byteLength ? Buffer.concat([this.#buffer, value]) : value;
    }
    if (this.#buffer.byteLength < length) invalid("truncated source archive");
    const result = Buffer.from(this.#buffer.subarray(0, length));
    this.#buffer = this.#buffer.subarray(length);
    return result;
  }

  async assertRemainingZero(): Promise<void> {
    if (!allZero(this.#buffer)) invalid("tar trailing bytes");
    this.#buffer = Buffer.alloc(0);
    while (!this.#ended) {
      const next = await this.#iterator.next();
      if (next.done) { this.#ended = true; break; }
      const value = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (!allZero(value)) invalid("tar trailing bytes");
    }
  }
}

async function assertParents(root: string, target: string): Promise<void> {
  const relative = target.slice(root.length + 1);
  const parts = relative.split(sep).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("tar parent directory");
  }
}

function tarPath(header: Buffer): string {
  const name = tarString(header.subarray(0, 100));
  const prefix = tarString(header.subarray(345, 500));
  const combined = prefix ? `${prefix}/${name}` : name;
  if (!combined || combined.length > 512 || combined.startsWith("/") || combined.includes("\\") || /[\0\r\n]/.test(combined)) invalid("tar path");
  const normalized = combined.endsWith("/") ? combined.slice(0, -1) : combined;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || !/^[\x20-\x7e]+$/.test(part))) invalid("tar path");
  return normalized;
}

function verifyTarChecksum(header: Buffer): void {
  const expected = tarOctal(header.subarray(148, 156), "tar checksum");
  let observed = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    observed += index >= 148 && index < 156 ? 32 : header[index]!;
  }
  if (observed !== expected || tarString(header.subarray(257, 263)) !== "ustar") invalid("tar checksum or format");
}

function tarOctal(value: Buffer, label: string): number {
  const text = value.toString("ascii").replace(/\0[\s\S]*$/, "").trim();
  if (!/^[0-7]+$/.test(text)) invalid(label);
  const parsed = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(parsed)) invalid(label);
  return parsed;
}

function tarString(value: Buffer): string {
  return value.toString("utf8").replace(/\0[\s\S]*$/, "");
}

function boundedTarget(root: string, relative: string): string {
  const target = resolve(root, ...relative.split("/"));
  if (!target.startsWith(`${root}${sep}`)) invalid("tar destination");
  return target;
}

function allZero(value: Buffer): boolean {
  return value.every((byte) => byte === 0);
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, value: Buffer): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
    if (bytesWritten < 1) invalid("source extraction write");
    offset += bytesWritten;
  }
}

function absolute(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) invalid(label);
  return value;
}

function invalid(label: string): never {
  throw new Error(`Godot TestKit ${label} is invalid`);
}
