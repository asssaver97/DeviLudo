import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { deflateSync, inflateSync } from "node:zlib";

const execute = promisify(execFile);
export const E2E_EVIDENCE_PROTOCOL = "deviludo.e2e-evidence.v1";
export const GUEST_REPORT_PROTOCOL = "deviludo.godot-guest-report.v2";
export const E2E_CLIENT_WIDTH = 1280;
export const E2E_CLIENT_HEIGHT = 720;
export const DEFAULT_VISUAL_THRESHOLD = 0.01;
export const MAX_SOLID_PIXEL_RATIO = 0.995;
export const MIN_OPAQUE_PIXEL_RATIO = 0.995;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const GODOT_ERROR = /(?:SCRIPT ERROR|Parse Error|Parser Error|Compile Error|Failed to load script|Cannot load script|runtime error|Invalid call\.|GDScript::reload)/i;

export function godotErrorLines(...logs) {
  return logs.flatMap(log => String(log ?? "").split(/\r?\n/))
    .map(line => line.trim())
    .filter(line => GODOT_ERROR.test(line))
    .slice(0, 100);
}

export async function inspectScreenshot(path, expectedWidth = E2E_CLIENT_WIDTH, expectedHeight = E2E_CLIENT_HEIGHT) {
  const decoded = decodePng(await readFile(path));
  if (decoded.width !== expectedWidth || decoded.height !== expectedHeight) {
    throw new Error(`Screenshot dimensions are ${decoded.width}x${decoded.height}; expected ${expectedWidth}x${expectedHeight}`);
  }
  const counts = new Map();
  let opaquePixels = 0;
  for (let offset = 0; offset < decoded.rgba.length; offset += 4) {
    const alpha = decoded.rgba[offset + 3];
    if (alpha === 255) opaquePixels += 1;
    const color = decoded.rgba.readUInt32BE(offset);
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  const totalPixels = decoded.width * decoded.height;
  const opaquePixelRatio = opaquePixels / totalPixels;
  if (opaquePixelRatio < MIN_OPAQUE_PIXEL_RATIO) {
    throw new Error(`Screenshot contains too many transparent or translucent pixels (${((1 - opaquePixelRatio) * 100).toFixed(3)}%)`);
  }
  let dominantPixels = 0;
  for (const count of counts.values()) dominantPixels = Math.max(dominantPixels, count);
  const dominantPixelRatio = dominantPixels / totalPixels;
  if (dominantPixelRatio > MAX_SOLID_PIXEL_RATIO) {
    throw new Error(`Screenshot is blank or nearly solid (${(dominantPixelRatio * 100).toFixed(3)}%)`);
  }
  return Object.freeze({
    width: decoded.width,
    height: decoded.height,
    opaquePixels,
    opaquePixelRatio,
    dominantPixelRatio,
    sha256: sha256(await readFile(path)),
  });
}

export async function compareScreenshots(actualPath, referencePath, diffPath, threshold = DEFAULT_VISUAL_THRESHOLD) {
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("Visual difference threshold is invalid");
  }
  const [actual, reference] = await Promise.all([readFile(actualPath), readFile(referencePath)]).then(values => values.map(decodePng));
  if (actual.width !== reference.width || actual.height !== reference.height) {
    throw new Error("Visual baseline dimensions do not match the captured screenshot");
  }
  const diff = Buffer.alloc(actual.rgba.length);
  let differentPixels = 0;
  for (let offset = 0; offset < actual.rgba.length; offset += 4) {
    let different = false;
    for (let channel = 0; channel < 4; channel += 1) {
      if (actual.rgba[offset + channel] !== reference.rgba[offset + channel]) different = true;
    }
    if (different) differentPixels += 1;
    diff[offset] = different ? 255 : Math.floor(actual.rgba[offset] * 0.25);
    diff[offset + 1] = different ? 0 : Math.floor(actual.rgba[offset + 1] * 0.25);
    diff[offset + 2] = different ? 255 : Math.floor(actual.rgba[offset + 2] * 0.25);
    diff[offset + 3] = 255;
  }
  const totalPixels = actual.width * actual.height;
  const differenceRatio = differentPixels / totalPixels;
  if (differenceRatio > threshold && diffPath) {
    await mkdir(dirname(diffPath), { recursive: true });
    await writeFile(diffPath, encodeRgbaPng(actual.width, actual.height, diff), { mode: 0o600 });
  }
  return Object.freeze({ passed: differenceRatio <= threshold, differentPixels, totalPixels, differenceRatio, threshold });
}

export async function createEvidenceBundle({
  outputRoot,
  jobId,
  platform,
  report,
  stdout = "",
  stderr = "",
  screenshots = [],
  diffs = [],
  baselines = [],
}) {
  if (!isAbsolute(outputRoot) || !/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("Evidence output contract is invalid");
  const bundleRoot = join(outputRoot, `evidence-${jobId}-${randomUUID()}`);
  await mkdir(join(bundleRoot, "logs"), { recursive: true, mode: 0o700 });
  await mkdir(join(bundleRoot, "screenshots"), { recursive: true, mode: 0o700 });
  await writeFile(join(bundleRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(bundleRoot, "logs/stdout.log"), String(stdout), { mode: 0o600 });
  await writeFile(join(bundleRoot, "logs/stderr.log"), String(stderr), { mode: 0o600 });
  for (const item of screenshots) await copyEvidenceFile(item, bundleRoot, "screenshots");
  for (const item of diffs) await copyEvidenceFile(item, bundleRoot, "diff");
  for (const item of baselines) await copyEvidenceFile(item, bundleRoot, "baselines");

  const html = await evidenceHtml(
    report,
    [
      ...screenshots.map(item => ({ ...item, label: `checkpoint · ${item.id}` })),
      ...diffs.map(item => ({ ...item, label: `diff · ${item.id}` })),
      ...baselines.map(item => ({ ...item, label: `baseline · ${item.id}` })),
    ],
    stdout,
    stderr,
  );
  await writeFile(join(bundleRoot, "index.html"), html, { mode: 0o600 });
  const payloadFiles = await regularFiles(bundleRoot);
  const entries = [];
  for (const path of payloadFiles) {
    const bytes = await readFile(join(bundleRoot, path));
    entries.push({ path, sha256: sha256(bytes), sizeBytes: bytes.length, mediaType: mediaType(path) });
  }
  const manifest = {
    schemaVersion: "deviludo.e2e-evidence-manifest.v1",
    evidenceProtocol: E2E_EVIDENCE_PROTOCOL,
    jobId,
    platform,
    files: entries,
  };
  await writeFile(join(bundleRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const outputPath = join(outputRoot, `e2e-evidence-${platform}-${jobId}.zip`);
  await execute("zip", ["-q", "-X", "-r", outputPath, "."], { cwd: bundleRoot, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  const bytes = await readFile(outputPath);
  await rm(bundleRoot, { recursive: true, force: true });
  return Object.freeze({ outputPath, outputSha256: sha256(bytes), outputSizeBytes: bytes.length, manifest });
}

export async function extractAndValidateEvidenceBundle(zipPath, destination, maximumBytes = 1024 * 1024 * 1024) {
  if (!isAbsolute(zipPath) || !isAbsolute(destination)) throw new Error("Evidence paths must be absolute");
  const archive = await readFile(zipPath);
  if (archive.length < 22 || archive.length > maximumBytes) throw new Error("E2E evidence ZIP size is invalid");
  inspectZipDirectory(archive, maximumBytes);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await execute("unzip", ["-q", zipPath, "-d", destination], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  const files = await regularFiles(destination, maximumBytes);
  if (files.some(path => !safeArchivePath(path))) throw new Error("E2E evidence extraction escaped its root");
  const manifestPath = join(destination, "manifest.json");
  const reportPath = join(destination, "report.json");
  const indexPath = join(destination, "index.html");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (manifest?.schemaVersion !== "deviludo.e2e-evidence-manifest.v1"
    || manifest.evidenceProtocol !== E2E_EVIDENCE_PROTOCOL || !Array.isArray(manifest.files)) throw new Error("E2E evidence manifest is invalid");
  if (report?.schemaVersion !== E2E_EVIDENCE_PROTOCOL || !["PASSED", "FAILED"].includes(report.outcome)) throw new Error("E2E evidence report is invalid");
  if (!files.includes("index.html")) throw new Error("E2E evidence HTML report is missing");
  const declared = new Set();
  for (const item of manifest.files) {
    if (!item || typeof item !== "object" || !safeArchivePath(item.path) || declared.has(item.path)
      || !/^sha256:[0-9a-f]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) {
      throw new Error("E2E evidence file manifest is invalid");
    }
    const bytes = await readFile(join(destination, item.path));
    if (bytes.length !== item.sizeBytes || sha256(bytes) !== item.sha256) throw new Error(`E2E evidence file failed integrity validation: ${item.path}`);
    declared.add(item.path);
  }
  const payloadFiles = files.filter(path => path !== "manifest.json");
  if (payloadFiles.some(path => !declared.has(path)) || declared.size !== payloadFiles.length) throw new Error("E2E evidence ZIP contains undeclared files");
  return Object.freeze({ manifest, report, indexPath });
}

function inspectZipDirectory(archive, maximumBytes) {
  const minimumEocd = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= minimumEocd; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("E2E evidence ZIP directory is missing");
  const entryCount = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  const directoryOffset = archive.readUInt32LE(eocd + 16);
  let offset = directoryOffset;
  if (entryCount < 1 || entryCount === 0xffff || offset + directorySize > eocd) throw new Error("E2E evidence ZIP directory is invalid");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names = new Set();
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("E2E evidence ZIP entry is invalid");
    const madeBy = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const uncompressedBytes = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > archive.length || nameLength < 1 || (flags & 1) !== 0 || ![0, 8].includes(method) || uncompressedBytes === 0xffffffff) {
      throw new Error("E2E evidence ZIP entry contract is invalid");
    }
    let name;
    try { name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength)); }
    catch { throw new Error("E2E evidence ZIP path encoding is invalid"); }
    const normalized = name.replace(/^\.\//, "").replace(/\/$/, "");
    if (!safeArchivePath(name) || names.has(normalized)) throw new Error("E2E evidence ZIP contains an unsafe or duplicate path");
    names.add(normalized);
    if ((madeBy >> 8) === 3 && (((externalAttributes >>> 16) & 0o170000) === 0o120000)) {
      throw new Error("E2E evidence ZIP cannot contain symbolic links");
    }
    totalBytes += uncompressedBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) throw new Error("E2E evidence extracted size exceeds the limit");
    offset = end;
  }
  if (offset !== directoryOffset + directorySize) throw new Error("E2E evidence ZIP directory size is invalid");
}

export async function readEvidenceRepairContext(zipPath, maximumBytes = 256 * 1024 * 1024) {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-e2e-repair-"));
  try {
    const validated = await extractAndValidateEvidenceBundle(zipPath, directory, maximumBytes);
    const screenshots = [];
    for (const checkpoint of Array.isArray(validated.report.checkpoints) ? validated.report.checkpoints : []) {
      if (checkpoint?.status !== "FAILED" || typeof checkpoint.screenshot !== "string" || !safeArchivePath(checkpoint.screenshot)) continue;
      const bytes = await readFile(join(directory, checkpoint.screenshot));
      screenshots.push({ checkpointId: checkpoint.checkpointId, sha256: sha256(bytes), sizeBytes: bytes.length });
    }
    return Object.freeze({ report: validated.report, screenshots });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function copyEvidenceFile(item, root, folder) {
  if (!item || typeof item.path !== "string" || !isAbsolute(item.path) || typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,239}$/.test(item.id)) {
    throw new Error("Evidence file contract is invalid");
  }
  const targetDirectory = join(root, folder);
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await copyFile(item.path, join(targetDirectory, `${item.id}.png`));
}

async function evidenceHtml(report, imagesInput, stdout, stderr) {
  const images = [];
  for (const item of imagesInput) {
    const bytes = await readFile(item.path);
    images.push(`<figure><img alt="${escapeHtml(item.label)}" src="data:image/png;base64,${bytes.toString("base64")}"><figcaption>${escapeHtml(item.label)}</figcaption></figure>`);
  }
  const title = report.outcome === "PASSED" ? "E2E PASSED" : "E2E FAILED";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{margin:0;background:#07111e;color:#e8f1ff;font:16px ui-monospace,monospace}main{max-width:1200px;margin:auto;padding:32px}header{border:1px solid #32506f;padding:24px}h1{color:${report.outcome === "PASSED" ? "#57e3b2" : "#ff718d"}}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;margin-top:24px}figure{margin:0;border:1px solid #32506f;padding:12px;background:#0b1928}img{width:100%;height:auto;display:block}figcaption{padding-top:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#050b13;padding:16px}</style></head><body><main><header><h1>${title}</h1><p>${escapeHtml(report.summary ?? "")}</p><p>${escapeHtml(report.platform ?? "")}</p></header><section>${images.join("")}</section><h2>结构化结果</h2><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre><h2>stdout</h2><pre>${escapeHtml(stdout)}</pre><h2>stderr</h2><pre>${escapeHtml(stderr)}</pre></main></body></html>`;
}

async function regularFiles(root, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const pending = [root];
  const files = [];
  let total = 0;
  while (pending.length) {
    const directory = pending.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("E2E evidence cannot contain symbolic links");
      if (info.isDirectory()) pending.push(path);
      else if (info.isFile()) {
        total += info.size;
        if (total > maximumBytes) throw new Error("E2E evidence extracted size exceeds the limit");
        files.push(relative(root, path).split("\\").join("/"));
      } else throw new Error("E2E evidence contains an unsupported file type");
    }
  }
  return files.sort();
}

function safeArchivePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
  return normalized.length > 0 && normalized.split("/").every(part => part && part !== "." && part !== "..");
}

function mediaType(path) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".png")) return "image/png";
  return "text/plain; charset=utf-8";
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Screenshot is not a decodable PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  const compressed = [];
  let ended = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error("PNG chunk is truncated");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (buffer.readUInt32BE(offset + 8 + length) !== crc32(Buffer.concat([Buffer.from(type, "ascii"), data]))) {
      throw new Error("PNG chunk checksum is invalid");
    }
    if (type === "IHDR") {
      if (length !== 13) throw new Error("PNG header is invalid");
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") compressed.push(data);
    else if (type === "IEND") { ended = true; break; }
    offset = end;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (!Number.isSafeInteger(width) || width < 1 || width > 16_384 || !Number.isSafeInteger(height) || height < 1 || height > 16_384
    || bitDepth !== 8 || channels === 0 || interlace !== 0 || compressed.length === 0 || !ended) throw new Error("PNG format is unsupported or invalid");
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
  if (inflated.length !== (stride + 1) * height) throw new Error("PNG pixel payload size is invalid");
  const raw = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[row * (stride + 1)];
    if (filter > 4) throw new Error("PNG filter is invalid");
    for (let column = 0; column < stride; column += 1) {
      const source = inflated[row * (stride + 1) + column + 1];
      const left = column >= channels ? raw[row * stride + column - channels] : 0;
      const up = row > 0 ? raw[(row - 1) * stride + column] : 0;
      const upperLeft = row > 0 && column >= channels ? raw[(row - 1) * stride + column - channels] : 0;
      const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      raw[row * stride + column] = (source + prediction) & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const input = pixel * channels;
    const output = pixel * 4;
    if (colorType === 6) raw.copy(rgba, output, input, input + 4);
    else if (colorType === 2) { rgba[output] = raw[input]; rgba[output + 1] = raw[input + 1]; rgba[output + 2] = raw[input + 2]; rgba[output + 3] = 255; }
    else if (colorType === 4) { rgba[output] = raw[input]; rgba[output + 1] = raw[input]; rgba[output + 2] = raw[input]; rgba[output + 3] = raw[input + 1]; }
    else { rgba[output] = raw[input]; rgba[output + 1] = raw[input]; rgba[output + 2] = raw[input]; rgba[output + 3] = 255; }
  }
  return { width, height, rgba };
}

export function encodeRgbaPng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) rgba.copy(raw, row * (width * 4 + 1) + 1, row * width * 4, (row + 1) * width * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0); typeBytes.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
}
