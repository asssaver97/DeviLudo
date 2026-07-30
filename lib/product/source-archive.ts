export type ProjectArchiveEntry = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;

const IGNORED_SEGMENTS = new Set([
  ".git", ".godot", ".idea", ".vscode", "node_modules", "dist", "build", "target",
  "coverage", "Library", "Temp", "Logs", "obj", "bin",
]);

export function normalizeProjectPath(value: string): string {
  const normalized = value.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")
    || segments.some(segment => !segment || segment === "." || segment === "..")
    || normalized.length > 1_024) {
    throw new Error("项目文件路径无效");
  }
  return normalized;
}

export function shouldIncludeProjectPath(value: string): boolean {
  const path = normalizeProjectPath(value);
  const segments = path.split("/");
  if (segments.some(segment => IGNORED_SEGMENTS.has(segment))) return false;
  return !isSensitiveProjectPath(path);
}

export function isSensitiveProjectPath(value: string): boolean {
  const path = normalizeProjectPath(value);
  const basename = path.split("/").pop()?.toLowerCase() ?? "";
  return basename === ".env"
    || basename.startsWith(".env.")
    || ["id_rsa", "id_ed25519", "credentials", "credentials.json"].includes(basename)
    || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(basename);
}

export function createStoredZip(entries: readonly ProjectArchiveEntry[]): Uint8Array {
  if (entries.length < 1 || entries.length > 10_000) throw new Error("项目文件数量无效");
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  const paths = new Set<string>();
  let localOffset = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const path = normalizeProjectPath(entry.path);
    if (paths.has(path)) throw new Error(`项目包含重复文件：${path}`);
    paths.add(path);
    const name = encoder.encode(path);
    if (name.length > 65_535) throw new Error("项目文件路径过长");
    const bytes = entry.bytes;
    totalBytes += bytes.length;
    if (totalBytes > 64 * 1024 * 1024) throw new Error("本地项目超过 64 MiB 导入上限");
    const checksum = crc32(bytes);
    const local = new Uint8Array(30 + name.length + bytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 33, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, bytes.length, true);
    localView.setUint32(22, bytes.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(bytes, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 33, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, bytes.length, true);
    centralView.setUint32(24, bytes.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centrals.push(central);
    localOffset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  return concatenate([...locals, ...centrals, end]);
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const CRC_TABLE = new Uint32Array(256);
for (let value = 0; value < CRC_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  CRC_TABLE[value] = crc >>> 0;
}
