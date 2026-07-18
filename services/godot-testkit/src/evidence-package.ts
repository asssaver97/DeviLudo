import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const TAR_BLOCK = 512;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024 * 1024;

export type EvidencePackageEntry = Readonly<{
  name: string;
  body?: Buffer;
  sourcePath?: string;
  expectedDigest?: string;
}>;

export async function createEvidencePackage(
  destinationPath: string,
  entries: readonly EvidencePackageEntry[],
): Promise<Readonly<{ sizeBytes: number; artifactDigest: string }>> {
  const destination = absolute(destinationPath, "evidence package destination");
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 100_000) invalid("evidence package entries");
  const names = entries.map((entry) => entry.name);
  if (new Set(names).size !== names.length || JSON.stringify([...names].sort()) !== JSON.stringify(names)) {
    invalid("evidence package ordering");
  }
  const output = await open(destination, "wx", 0o600);
  const packageHash = createHash("sha256");
  let packageSize = 0;
  try {
    for (const entry of entries) {
      validateName(entry.name);
      const hasBody = Buffer.isBuffer(entry.body);
      const hasSource = typeof entry.sourcePath === "string";
      if (hasBody === hasSource) invalid("evidence package entry source");
      let size: number;
      if (hasBody) {
        size = entry.body!.byteLength;
      } else {
        const source = absolute(entry.sourcePath!, "evidence package source");
        const metadata = await lstat(source);
        if (!metadata.isFile() || metadata.isSymbolicLink()) invalid("evidence package source");
        size = metadata.size;
      }
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ENTRY_BYTES) invalid("evidence package entry size");
      const header = tarHeader(entry.name, size);
      await append(output, packageHash, header);
      const contentHash = createHash("sha256");
      let observed = 0;
      if (hasBody) {
        const body = entry.body!;
        contentHash.update(body);
        observed = body.byteLength;
        await append(output, packageHash, body);
      } else {
        for await (const chunk of createReadStream(entry.sourcePath!)) {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          observed += value.byteLength;
          if (observed > size) invalid("evidence package source changed");
          contentHash.update(value);
          await append(output, packageHash, value);
        }
      }
      if (observed !== size) invalid("evidence package source changed");
      const observedDigest = contentHash.digest("hex");
      if (entry.expectedDigest !== undefined && entry.expectedDigest !== observedDigest) invalid("evidence package entry digest");
      const padding = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
      if (padding) await append(output, packageHash, Buffer.alloc(padding));
      packageSize += TAR_BLOCK + size + padding;
    }
    const terminator = Buffer.alloc(TAR_BLOCK * 2);
    await append(output, packageHash, terminator);
    packageSize += terminator.byteLength;
    await output.sync();
  } finally { await output.close(); }
  return Object.freeze({ sizeBytes: packageSize, artifactDigest: packageHash.digest("hex") });
}

function tarHeader(name: string, size: number): Buffer {
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
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encoded = checksum.toString(8).padStart(6, "0");
  writeAscii(header, 148, 6, encoded);
  header[154] = 0;
  header[155] = 32;
  return header;
}

function writeAscii(target: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, "ascii");
  if (encoded.byteLength > length) invalid("evidence tar field");
  encoded.copy(target, offset);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) invalid("evidence tar numeric field");
  writeAscii(target, offset, length - 1, encoded);
  target[offset + length - 1] = 0;
}

async function append(file: Awaited<ReturnType<typeof open>>, hash: ReturnType<typeof createHash>, value: Buffer): Promise<void> {
  hash.update(value);
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
    if (bytesWritten < 1) invalid("evidence package write");
    offset += bytesWritten;
  }
}

function validateName(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 100 || value.startsWith("/") || value.includes("\\")
    || value.split("/").some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) {
    invalid("evidence package entry name");
  }
}

function absolute(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) invalid(label);
  return value;
}

function invalid(label: string): never {
  throw new Error(`Godot TestKit ${label} is invalid`);
}
