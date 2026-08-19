import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
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
export const E2E_EVIDENCE_SCHEMA = "deviludo.e2e-evidence";
export const GUEST_REPORT_SCHEMA = "deviludo.godot-guest-report";
export const E2E_EVIDENCE_MANIFEST_SCHEMA = "deviludo.e2e-evidence-manifest";
export const E2E_CLIENT_WIDTH = 1280;
export const E2E_CLIENT_HEIGHT = 720;
export const DEFAULT_VISUAL_THRESHOLD = 0.01;
export const MAX_SOLID_PIXEL_RATIO = 0.995;
export const MIN_OPAQUE_PIXEL_RATIO = 0.995;
export const MAX_E2E_EVIDENCE_BYTES = 1024 * 1024 * 1024;
export const MAX_E2E_VIDEO_BYTES = 768 * 1024 * 1024;

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

export async function captureAndInspectScreenshot(path, capture, options = {}) {
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 250;
  if (typeof capture !== "function" || !Number.isInteger(attempts) || attempts < 1 || attempts > 40
    || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 2_000) {
    throw new Error("Screenshot readiness options are invalid");
  }
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await capture(path);
    try { return await inspectScreenshot(path); }
    catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !/blank or nearly solid/i.test(error.message) || attempt === attempts - 1) throw error;
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError ?? new Error("Screenshot did not become ready");
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

export async function compareScreenshotRegion(actualPath, referencePath, rect, diffPath = null) {
  const [actual, reference] = await Promise.all([readFile(actualPath), readFile(referencePath)]).then(values => values.map(decodePng));
  if (actual.width !== reference.width || actual.height !== reference.height) {
    throw new Error("Visual comparison dimensions do not match");
  }
  const region = normalizePixelRect(rect, actual.width, actual.height);
  const diff = diffPath ? Buffer.from(actual.rgba) : null;
  let differentPixels = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const offset = (y * actual.width + x) * 4;
      let different = false;
      for (let channel = 0; channel < 4; channel += 1) {
        if (actual.rgba[offset + channel] !== reference.rgba[offset + channel]) different = true;
      }
      if (different) differentPixels += 1;
      if (diff) {
        diff[offset] = different ? 255 : Math.floor(actual.rgba[offset] * 0.25);
        diff[offset + 1] = different ? 0 : Math.floor(actual.rgba[offset + 1] * 0.25);
        diff[offset + 2] = different ? 255 : Math.floor(actual.rgba[offset + 2] * 0.25);
        diff[offset + 3] = 255;
      }
    }
  }
  if (diff && diffPath) {
    await mkdir(dirname(diffPath), { recursive: true });
    await writeFile(diffPath, encodeRgbaPng(actual.width, actual.height, diff), { mode: 0o600 });
  }
  const totalPixels = region.width * region.height;
  return Object.freeze({ differentPixels, totalPixels, differenceRatio: differentPixels / totalPixels, region });
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
  videos = [],
  trajectories = [],
  regressions = [],
}) {
  if (!isAbsolute(outputRoot) || !/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("Evidence output contract is invalid");
  const bundleRoot = join(outputRoot, `evidence-${jobId}-${randomUUID()}`);
  await mkdir(join(bundleRoot, "logs"), { recursive: true, mode: 0o700 });
  await mkdir(join(bundleRoot, "screenshots"), { recursive: true, mode: 0o700 });
  await writeFile(join(bundleRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(bundleRoot, "logs/stdout.log"), String(stdout), { mode: 0o600 });
  await writeFile(join(bundleRoot, "logs/stderr.log"), String(stderr), { mode: 0o600 });
  let totalVideoBytes = 0;
  for (const item of videos) {
    if (!item || typeof item.path !== "string" || !isAbsolute(item.path)) throw new Error("Evidence video contract is invalid");
    totalVideoBytes += (await lstat(item.path)).size;
    if (!Number.isSafeInteger(totalVideoBytes) || totalVideoBytes > MAX_E2E_VIDEO_BYTES) {
      throw new Error("E2E videos exceed the 768 MiB aggregate target limit");
    }
  }
  for (const item of screenshots) await copyEvidenceFile(item, bundleRoot, "screenshots", ".png");
  for (const item of diffs) await copyEvidenceFile(item, bundleRoot, "diff", ".png");
  for (const item of baselines) await copyEvidenceFile(item, bundleRoot, "baselines", ".png");
  for (const item of videos) await copyEvidenceFile(item, bundleRoot, "videos", ".mp4");
  for (const item of trajectories) await copyEvidenceFile(item, bundleRoot, "trajectories", ".jsonl");
  for (const item of regressions) await copyEvidenceFile(item, bundleRoot, "regression", ".json");

  const html = await evidenceHtml(
    report,
    [
      ...screenshots.map(item => ({ ...item, label: `checkpoint · ${item.id}` })),
      ...diffs.map(item => ({ ...item, label: `diff · ${item.id}` })),
      ...baselines.map(item => ({ ...item, label: `baseline · ${item.id}` })),
    ],
    stdout, stderr, videos,
  );
  await writeFile(join(bundleRoot, "index.html"), html, { mode: 0o600 });
  const payloadFiles = await regularFiles(bundleRoot, MAX_E2E_EVIDENCE_BYTES);
  const entries = [];
  for (const path of payloadFiles) {
    const bytes = await readFile(join(bundleRoot, path));
    entries.push({ path, sha256: sha256(bytes), sizeBytes: bytes.length, mediaType: mediaType(path) });
  }
  const manifest = {
    schema: E2E_EVIDENCE_MANIFEST_SCHEMA,
    evidenceSchema: E2E_EVIDENCE_SCHEMA,
    jobId,
    platform,
    files: entries,
  };
  await writeFile(join(bundleRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const outputPath = join(outputRoot, `e2e-evidence-${platform}-${jobId}.zip`);
  await execute("zip", ["-q", "-X", "-r", outputPath, "."], { cwd: bundleRoot, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  const outputSizeBytes = (await lstat(outputPath)).size;
  if (outputSizeBytes < 1 || outputSizeBytes > MAX_E2E_EVIDENCE_BYTES) throw new Error("E2E evidence ZIP exceeds the 1 GiB limit");
  const outputSha256 = await sha256File(outputPath);
  await rm(bundleRoot, { recursive: true, force: true });
  return Object.freeze({ outputPath, outputSha256, outputSizeBytes, manifest });
}

export async function extractAndValidateEvidenceBundle(zipPath, destination, maximumBytes = 1024 * 1024 * 1024) {
  if (!isAbsolute(zipPath) || !isAbsolute(destination)) throw new Error("Evidence paths must be absolute");
  const archiveSize = (await lstat(zipPath)).size;
  if (archiveSize < 22 || archiveSize > maximumBytes) throw new Error("E2E evidence ZIP size is invalid");
  await inspectZipFile(zipPath, archiveSize, maximumBytes);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await execute("unzip", ["-q", zipPath, "-d", destination], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  const files = await regularFiles(destination, maximumBytes);
  if (files.some(path => !safeArchivePath(path))) throw new Error("E2E evidence extraction escaped its root");
  const manifestPath = join(destination, "manifest.json");
  const reportPath = join(destination, "report.json");
  const indexPath = join(destination, "index.html");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (manifest?.schema !== E2E_EVIDENCE_MANIFEST_SCHEMA || Object.hasOwn(manifest, "schemaVersion")
    || manifest.evidenceSchema !== E2E_EVIDENCE_SCHEMA || !Array.isArray(manifest.files)) throw new Error("E2E evidence manifest is invalid");
  if (report?.schema !== manifest.evidenceSchema || Object.hasOwn(report, "schemaVersion")
    || !["PASSED", "FAILED"].includes(report.outcome)) throw new Error("E2E evidence report is invalid");
  if (!files.includes("index.html")) throw new Error("E2E evidence HTML report is missing");
  const declared = new Set();
  for (const item of manifest.files) {
    if (!item || typeof item !== "object" || !safeArchivePath(item.path) || declared.has(item.path)
      || !/^sha256:[0-9a-f]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) {
      throw new Error("E2E evidence file manifest is invalid");
    }
    const path = join(destination, item.path);
    const size = (await lstat(path)).size;
    if (size !== item.sizeBytes || await sha256File(path) !== item.sha256) throw new Error(`E2E evidence file failed integrity validation: ${item.path}`);
    declared.add(item.path);
  }
  const payloadFiles = files.filter(path => path !== "manifest.json");
  if (payloadFiles.some(path => !declared.has(path)) || declared.size !== payloadFiles.length) throw new Error("E2E evidence ZIP contains undeclared files");
  return Object.freeze({ manifest, report, indexPath });
}

async function inspectZipFile(path, archiveSize, maximumBytes) {
  const handle = await open(path, "r");
  try {
    const tailSize = Math.min(65_557, archiveSize);
    const tail = Buffer.alloc(tailSize);
    const { bytesRead } = await handle.read(tail, 0, tail.length, archiveSize - tailSize);
    if (bytesRead !== tail.length) throw new Error("E2E evidence ZIP directory is truncated");
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50
        && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) { eocd = offset; break; }
    }
    if (eocd < 0) throw new Error("E2E evidence ZIP directory is missing");
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0
      || tail.readUInt16LE(eocd + 8) !== tail.readUInt16LE(eocd + 10)) {
      throw new Error("E2E evidence ZIP cannot span disks");
    }
    const entryCount = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    const absoluteEocd = archiveSize - tailSize + eocd;
    if (entryCount < 1 || entryCount === 0xffff || directorySize < 46
      || directoryOffset + directorySize !== absoluteEocd || directorySize > maximumBytes) {
      throw new Error("E2E evidence ZIP directory is invalid");
    }
    const directory = Buffer.alloc(directorySize);
    const read = await handle.read(directory, 0, directory.length, directoryOffset);
    if (read.bytesRead !== directory.length) throw new Error("E2E evidence ZIP directory is truncated");
    inspectZipDirectory(directory, entryCount, maximumBytes);
  } finally {
    await handle.close();
  }
}

function inspectZipDirectory(directory, entryCount, maximumBytes) {
  let offset = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names = new Set();
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new Error("E2E evidence ZIP entry is invalid");
    const madeBy = directory.readUInt16LE(offset + 4);
    const flags = directory.readUInt16LE(offset + 8);
    const method = directory.readUInt16LE(offset + 10);
    const uncompressedBytes = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const externalAttributes = directory.readUInt32LE(offset + 38);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > directory.length || nameLength < 1 || (flags & 1) !== 0 || ![0, 8].includes(method) || uncompressedBytes === 0xffffffff) {
      throw new Error("E2E evidence ZIP entry contract is invalid");
    }
    let name;
    try { name = decoder.decode(directory.subarray(offset + 46, offset + 46 + nameLength)); }
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
  if (offset !== directory.length) throw new Error("E2E evidence ZIP directory size is invalid");
}

export async function readEvidenceRepairContext(zipPath, maximumBytes = MAX_E2E_EVIDENCE_BYTES) {
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

async function copyEvidenceFile(item, root, folder, extension) {
  if (!item || typeof item.path !== "string" || !isAbsolute(item.path) || typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,239}$/.test(item.id)) {
    throw new Error("Evidence file contract is invalid");
  }
  const targetDirectory = join(root, folder);
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  if (folder === "videos" && (await lstat(item.path)).size > MAX_E2E_VIDEO_BYTES) {
    throw new Error("E2E video exceeds the 768 MiB target limit");
  }
  await copyFile(item.path, join(targetDirectory, `${item.id}${extension}`));
}

async function evidenceHtml(report, imagesInput, stdout, stderr, videosInput) {
  const copy = {
    zh: {
      pagePassed: "E2E 测试通过 · DeviLudo",
      pageFailed: "E2E 测试失败 · DeviLudo",
      passed: "E2E 测试通过",
      failed: "E2E 测试失败",
      headlessChecks: "Headless 检查",
      realPlayerJourneys: "真实玩家旅程",
      systemRealInputs: "系统级真实输入",
      requirementCoverage: "玩家需求覆盖",
      screenshots: "截图",
      stableBaselines: "稳定视觉基线",
      adaptivePlay: "自适应游玩",
      gamepadInputs: "手柄输入",
      videos: "视频",
      requirement: "需求",
      status: "状态",
      realInputEvidence: "真实操作证据",
      noCoveredRequirements: "无已覆盖玩家需求",
      deterministicJourneys: "确定性真实操作",
      journey: "旅程",
      step: "步骤",
      input: "输入",
      semanticTarget: "语义目标",
      probeSequence: "Probe 序号",
      noRealInputSteps: "无真实输入步骤",
      testAgentPlay: "Test Agent 自适应游玩与 Oracle",
      rollout: "Rollout",
      seed: "种子",
      result: "结果",
      decisions: "决策数",
      recoveries: "卡死恢复",
      noAdaptivePlay: "未执行自适应游玩",
      currentRegression: "当前回归轨迹",
      existingReplay: "既有轨迹回放",
      successfulTrace: "成功轨迹固化",
      noCurrentTrace: "无当前轨迹",
      replacementStored: "已通过两次干净回放并替换",
      noReplacementTrace: "未生成替换轨迹",
      completeVideos: "完整游戏视频",
      noVideos: "无视频",
      screenshotsAndDiffs: "截图与差异",
      structuredResult: "完整结构化结果",
      keyboard: "键盘",
      oraclePassed: "核心循环 Oracle 通过",
      oracleFailed: "未通过",
    },
    en: {
      pagePassed: "E2E Test Passed · DeviLudo",
      pageFailed: "E2E Test Failed · DeviLudo",
      passed: "E2E TEST PASSED",
      failed: "E2E TEST FAILED",
      headlessChecks: "Headless Checks",
      realPlayerJourneys: "Real Player Journeys",
      systemRealInputs: "System-level Real Inputs",
      requirementCoverage: "Player Requirement Coverage",
      screenshots: "Screenshots",
      stableBaselines: "Stable Visual Baselines",
      adaptivePlay: "Adaptive Play",
      gamepadInputs: "Gamepad Inputs",
      videos: "Videos",
      requirement: "Requirement",
      status: "Status",
      realInputEvidence: "Real-input Evidence",
      noCoveredRequirements: "No covered player requirements",
      deterministicJourneys: "Deterministic Real-input Journeys",
      journey: "Journey",
      step: "Step",
      input: "Input",
      semanticTarget: "Semantic Target",
      probeSequence: "Probe Sequence",
      noRealInputSteps: "No real-input steps",
      testAgentPlay: "Test Agent Adaptive Play & Oracles",
      rollout: "Rollout",
      seed: "Seed",
      result: "Result",
      decisions: "Decisions",
      recoveries: "Stall Recoveries",
      noAdaptivePlay: "No adaptive play executed",
      currentRegression: "Current Regression Trace",
      existingReplay: "Existing Trace Replay",
      successfulTrace: "Successful Trace Capture",
      noCurrentTrace: "No current trace",
      replacementStored: "Replaced after two clean replays",
      noReplacementTrace: "No replacement trace generated",
      completeVideos: "Complete Gameplay Videos",
      noVideos: "No videos",
      screenshotsAndDiffs: "Screenshots & Visual Diffs",
      structuredResult: "Full Structured Result",
      keyboard: "Keyboard",
      oraclePassed: "Core-loop oracle passed",
      oracleFailed: "Failed",
    },
  };
  const t = key => `<span data-i18n="${key}">${escapeHtml(copy.zh[key])}</span>`;
  const images = [];
  for (const item of imagesInput) {
    const bytes = await readFile(item.path);
    images.push(`<figure><img alt="${escapeHtml(item.label)}" src="data:image/png;base64,${bytes.toString("base64")}"><figcaption>${escapeHtml(item.label)}</figcaption></figure>`);
  }
  const titleKey = report.outcome === "PASSED" ? "passed" : "failed";
  const primaryVideo = videosInput.find(item => item.id.includes("primary")) ?? videosInput[0];
  const orderedVideos = primaryVideo
    ? [primaryVideo, ...videosInput.filter(item => item !== primaryVideo)]
    : videosInput;
  const videos = orderedVideos.map(item => `<figure${item === primaryVideo ? " class=\"is-primary\"" : ""}><video controls preload="metadata" src="videos/${escapeHtml(item.id)}.mp4"></video><figcaption>gameplay · ${escapeHtml(item.id)}</figcaption></figure>`).join("");
  const coverage = report.coverage ?? {};
  const stats = [
    ["headlessChecks", coverage.headlessCheckCount ?? 0],
    ["realPlayerJourneys", coverage.interactiveJourneyCount ?? 0],
    ["systemRealInputs", coverage.realInputCount ?? 0],
    ["requirementCoverage", `${coverage.coveredPlayerRequirementCount ?? 0}/${coverage.playerRequirementCount ?? 0}`],
    ["screenshots", report.screenshotCount ?? imagesInput.filter(item => item.label.startsWith("checkpoint")).length],
    ["stableBaselines", coverage.visualBaselineCount ?? 0],
    ["adaptivePlay", `${coverage.adaptiveSuccessCount ?? 0}/${coverage.adaptiveRolloutCount ?? 0}`],
    ["gamepadInputs", coverage.gamepadInputCount ?? 0],
    ["videos", videosInput.length],
  ].map(([label, value]) => `<article><strong>${t(label)}</strong><span>${escapeHtml(value)}</span></article>`).join("");
  const requirementRows = (report.requirementCoverage ?? []).map(requirement => `<tr><td>${escapeHtml(requirement.requirementId)}</td><td>${escapeHtml(requirement.status)}</td><td>${escapeHtml((requirement.evidenceSteps ?? []).join(", ") || requirement.exemptionReason || "-")}</td></tr>`).join("");
  const stepRows = (report.steps ?? []).map(step => `<tr><td>${escapeHtml(step.journeyId)}</td><td>${escapeHtml(step.stepId)}</td><td>${escapeHtml(step.type)}</td><td>${step.target?.controls?.length ? escapeHtml(step.target.controls.map(control => control.id).join(", ")) : t("keyboard")}</td><td>${escapeHtml(`${step.before?.sequence ?? "-"} → ${step.after?.sequence ?? "-"}`)}</td></tr>`).join("");
  const rolloutRows = (report.adaptiveRollouts ?? []).map(rollout => {
    const recoveries = (rollout.decisions ?? []).filter(decision => decision.recovery === true).length;
    const oracle = rollout.outcome === "PASSED" ? t("oraclePassed") : escapeHtml(rollout.failureCode ?? copy.zh.oracleFailed);
    return `<tr><td>${escapeHtml(Number(rollout.rolloutIndex) + 1)}</td><td>${escapeHtml(rollout.seed)}</td><td>${escapeHtml(rollout.outcome)}</td><td>${escapeHtml(rollout.decisionCount)}</td><td>${escapeHtml(recoveries)}</td><td>${oracle}</td></tr>`;
  }).join("");
  const regression = report.regression ?? {};
  const currentRegression = regression.currentReplay?.status ? escapeHtml(regression.currentReplay.status) : t("noCurrentTrace");
  const replacementRegression = regression.replacement?.stored ? t("replacementStored") : t("noReplacementTrace");
  const pageTitleKey = report.outcome === "PASSED" ? "pagePassed" : "pageFailed";
  const serializedCopy = JSON.stringify(copy).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="zh-CN" data-locale="zh" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(copy.zh[pageTitleKey])}</title><script>(()=>{const p=new URLSearchParams(location.search),l=p.get("locale")==="en"?"en":p.get("locale")==="zh"?"zh":navigator.language.toLowerCase().startsWith("en")?"en":"zh",t=p.get("theme")==="light"?"light":"dark",e=document.documentElement;e.lang=l==="en"?"en":"zh-CN";e.dataset.locale=l;e.dataset.theme=t;e.style.colorScheme=t})()</script><style>:root{--bg:#07111e;--surface:#0b1928;--surface-strong:#050b13;--ink:#e8f1ff;--line:#32506f;--line-soft:#253f5c;--accent:#57e3b2;--danger:#ff718d;--muted:#9eb1c7}html[data-theme="light"]{--bg:#f2f6fb;--surface:#fff;--surface-strong:#e8eef6;--ink:#15243a;--line:#a8bfd8;--line-soft:#cfdae7;--accent:#087c65;--danger:#c33857;--muted:#52657a}body{margin:0;background:var(--bg);color:var(--ink);font:16px ui-monospace,monospace}main{max-width:1200px;margin:auto;padding:32px}header,article,figure,table{border:1px solid var(--line)}header{padding:24px;background:var(--surface)}h1{color:${report.outcome === "PASSED" ? "var(--accent)" : "var(--danger)"}}h2{margin-top:40px}.stats,section{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;margin-top:24px}.video-grid figure.is-primary{grid-column:1/-1}.image-grid{grid-template-columns:repeat(auto-fit,minmax(360px,1fr))}.stats article{padding:16px;background:var(--surface)}.stats strong,.stats span{display:block}.stats article>span{font-size:28px;color:var(--accent);margin-top:8px}figure{margin:0;padding:12px;background:var(--surface)}img,video{width:100%;height:auto;display:block}figcaption{padding-top:10px;color:var(--muted)}table{width:100%;border-collapse:collapse;background:var(--surface)}th,td{padding:10px;border:1px solid var(--line-soft);text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface-strong);padding:16px}</style></head><body><main><header><h1>${t(titleKey)}</h1><p>${escapeHtml(report.summary ?? "")}</p><p>${escapeHtml(report.platform ?? "")}</p></header><div class="stats">${stats}</div><h2>${t("requirementCoverage")}</h2><table><thead><tr><th>${t("requirement")}</th><th>${t("status")}</th><th>${t("realInputEvidence")}</th></tr></thead><tbody>${requirementRows || `<tr><td colspan="3">${t("noCoveredRequirements")}</td></tr>`}</tbody></table><h2>${t("deterministicJourneys")}</h2><table><thead><tr><th>${t("journey")}</th><th>${t("step")}</th><th>${t("input")}</th><th>${t("semanticTarget")}</th><th>${t("probeSequence")}</th></tr></thead><tbody>${stepRows || `<tr><td colspan="5">${t("noRealInputSteps")}</td></tr>`}</tbody></table><h2>${t("testAgentPlay")}</h2><table><thead><tr><th>${t("rollout")}</th><th>${t("seed")}</th><th>${t("result")}</th><th>${t("decisions")}</th><th>${t("recoveries")}</th><th>Oracle</th></tr></thead><tbody>${rolloutRows || `<tr><td colspan="6">${t("noAdaptivePlay")}</td></tr>`}</tbody></table><h2>${t("currentRegression")}</h2><table><tbody><tr><th>${t("existingReplay")}</th><td>${currentRegression}</td></tr><tr><th>${t("successfulTrace")}</th><td>${replacementRegression}</td></tr></tbody></table><h2>${t("completeVideos")}</h2><section class="video-grid">${videos || `<p>${t("noVideos")}</p>`}</section><h2>${t("screenshotsAndDiffs")}</h2><section class="image-grid">${images.join("")}</section><h2>${t("structuredResult")}</h2><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre><h2>stdout</h2><pre>${escapeHtml(stdout)}</pre><h2>stderr</h2><pre>${escapeHtml(stderr)}</pre></main><script>(()=>{const copy=${serializedCopy},l=document.documentElement.dataset.locale||"zh",t=copy[l];document.title=t.${pageTitleKey};for(const node of document.querySelectorAll("[data-i18n]")){const value=t[node.dataset.i18n];if(value)node.textContent=value}})()</script></body></html>`;
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

function normalizePixelRect(value, width, height) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![value.x, value.y, value.width, value.height].every(Number.isInteger)
    || value.x < 0 || value.y < 0 || value.width < 1 || value.height < 1
    || value.x + value.width > width || value.y + value.height > height) {
    throw new Error("Visual comparison region is invalid");
  }
  return Object.freeze({ x: value.x, y: value.y, width: value.width, height: value.height });
}

function mediaType(path) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".jsonl")) return "application/x-ndjson";
  return "text/plain; charset=utf-8";
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
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
