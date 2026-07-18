import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, readFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { isAbsolute, join, resolve, sep } from "node:path";

const TAR_BLOCK = 512;
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export interface ExtractedNpmPackage {
  readonly root: string;
  readonly files: number;
  readonly directories: number;
  readonly totalBytes: number;
  readonly packageName: string;
  readonly version: string;
}

/** Extracts the regular-file/directory USTAR subset used by official npm packages. */
export async function extractOfficialNpmPackage(
  archivePath: string,
  destinationRoot: string,
  expected: Readonly<{ packageName: string; version: string; maximumBytes: number }>,
): Promise<ExtractedNpmPackage> {
  const archive = absolute(archivePath);
  const destination = absolute(destinationRoot);
  const archiveMetadata = await lstat(archive);
  if (!archiveMetadata.isFile() || archiveMetadata.isSymbolicLink() || archiveMetadata.size < 32) invalid();
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const destinationMetadata = await lstat(destination);
  if (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink()) invalid();
  const root = await realpath(destination);
  if (process.platform !== "win32") await chmod(root, 0o700);

  const decompressed = createReadStream(archive).pipe(createGunzip());
  const reader = new ExactReader(decompressed);
  const seen = new Set<string>();
  let files = 0;
  let directories = 0;
  let totalBytes = 0;
  let terminated = false;
  try {
    while (true) {
      const header = await reader.read(TAR_BLOCK);
      if (allZero(header)) {
        if (!allZero(await reader.read(TAR_BLOCK))) invalid();
        await reader.assertRemainingZero();
        terminated = true;
        break;
      }
      verifyChecksum(header);
      const archiveName = tarPath(header);
      if (archiveName !== "package" && !archiveName.startsWith("package/")) invalid();
      const relative = archiveName === "package" ? "" : archiveName.slice("package/".length);
      const size = tarOctal(header.subarray(124, 136));
      const type = header[156] ?? 0;
      if (!relative) {
        if (type !== 53 || size !== 0 || seen.has(".")) invalid();
        seen.add(".");
        continue;
      }
      if (seen.has(relative) || seen.size >= MAX_FILES || relative === ".git" || relative.startsWith(".git/")) invalid();
      seen.add(relative);
      const target = targetPath(root, relative);
      if (type === 53) {
        if (size !== 0) invalid();
        await mkdir(target, { recursive: true, mode: 0o700 });
        await assertDirectory(target);
        directories += 1;
        continue;
      }
      if (type !== 0 && type !== 48 || size > MAX_FILE_BYTES || totalBytes + size > expected.maximumBytes) invalid();
      await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
      await assertParents(root, target);
      const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        let remaining = size;
        while (remaining > 0) {
          const chunk = await reader.read(Math.min(remaining, 1024 * 1024));
          await writeAll(output, chunk);
          remaining -= chunk.byteLength;
        }
        await output.sync();
      } finally { await output.close(); }
      const padding = (TAR_BLOCK - size % TAR_BLOCK) % TAR_BLOCK;
      if (padding && !allZero(await reader.read(padding))) invalid();
      files += 1;
      totalBytes += size;
    }
  } finally { decompressed.destroy(); }
  if (!terminated || files < 1) invalid();
  const marker = join(root, "package.json");
  const markerMetadata = await lstat(marker);
  if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink() || markerMetadata.size < 2
    || markerMetadata.size > MAX_PACKAGE_JSON_BYTES) invalid();
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(marker, "utf8")) as unknown; } catch { invalid(); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || (manifest as Record<string, unknown>).name !== expected.packageName
    || (manifest as Record<string, unknown>).version !== expected.version) invalid();
  return Object.freeze({ root, files, directories, totalBytes, packageName: expected.packageName, version: expected.version });
}

class ExactReader {
  readonly #iterator: AsyncIterator<Buffer | string>;
  #buffer = Buffer.alloc(0);
  #ended = false;
  constructor(stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>) { this.#iterator = stream[Symbol.asyncIterator](); }
  async read(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024) invalid();
    while (this.#buffer.byteLength < length && !this.#ended) {
      const next = await this.#iterator.next();
      if (next.done) { this.#ended = true; break; }
      const value = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (value.byteLength) this.#buffer = this.#buffer.byteLength ? Buffer.concat([this.#buffer, value]) : Buffer.from(value);
    }
    if (this.#buffer.byteLength < length) invalid();
    const value = Buffer.from(this.#buffer.subarray(0, length));
    this.#buffer = Buffer.from(this.#buffer.subarray(length));
    return value;
  }
  async assertRemainingZero(): Promise<void> {
    if (!allZero(this.#buffer)) invalid();
    this.#buffer = Buffer.alloc(0);
    while (!this.#ended) {
      const next = await this.#iterator.next();
      if (next.done) { this.#ended = true; break; }
      if (!allZero(Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value))) invalid();
    }
  }
}

async function assertParents(root: string, target: string): Promise<void> {
  const parts = target.slice(root.length + 1).split(sep).slice(0, -1);
  let current = root;
  for (const part of parts) { current = join(current, part); await assertDirectory(current); }
}
async function assertDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid();
  if (process.platform !== "win32") await chmod(path, 0o700);
}
function tarPath(header: Buffer): string {
  const name = tarString(header.subarray(0, 100));
  const prefix = tarString(header.subarray(345, 500));
  const combined = prefix ? `${prefix}/${name}` : name;
  const normalized = combined.endsWith("/") ? combined.slice(0, -1) : combined;
  const parts = normalized.split("/");
  if (!normalized || normalized.length > 512 || normalized.startsWith("/") || normalized.includes("\\")
    || /[\0\r\n]/.test(normalized) || parts.some((part) => !part || part === "." || part === ".." || !/^[\x20-\x7e]+$/.test(part))) invalid();
  return normalized;
}
function verifyChecksum(header: Buffer): void {
  const expected = tarOctal(header.subarray(148, 156));
  let observed = 0;
  for (let index = 0; index < header.length; index += 1) observed += index >= 148 && index < 156 ? 32 : header[index]!;
  const magic = tarString(header.subarray(257, 263));
  if (observed !== expected || magic !== "ustar") invalid();
}
function tarOctal(value: Buffer): number {
  const text = value.toString("ascii").replace(/\0[\s\S]*$/, "").trim();
  if (!/^[0-7]+$/.test(text)) invalid();
  const result = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(result) || result < 0) invalid();
  return result;
}
function tarString(value: Buffer): string { return value.toString("utf8").replace(/\0[\s\S]*$/, ""); }
function targetPath(root: string, relative: string): string {
  const target = resolve(root, ...relative.split("/"));
  if (!target.startsWith(`${root}${sep}`)) invalid();
  return target;
}
function allZero(value: Buffer): boolean { return value.every((byte) => byte === 0); }
async function writeAll(file: Awaited<ReturnType<typeof open>>, value: Buffer): Promise<void> {
  let offset = 0;
  while (offset < value.length) { const result = await file.write(value, offset, value.length - offset); if (result.bytesWritten < 1) invalid(); offset += result.bytesWritten; }
}
function absolute(value: string): string { if (!isAbsolute(value) || resolve(value) !== value || value.length > 4096 || /\0/.test(value)) invalid(); return value; }
function invalid(): never { throw new Error("Official npm package archive is invalid"); }
